import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { farmDateRange } from '../src/utils/farm-date.js'

const __filename = fileURLToPath(import.meta.url)
const serverRoot = path.resolve(path.dirname(__filename), '..')
const sourcePath = process.env.REPLAY_VALIDATION_DATABASE
const farmDay = String(process.env.REPLAY_VALIDATION_DAY || '2026-07-23')
const dayRange = farmDateRange(farmDay)

if (!sourcePath || !fs.existsSync(sourcePath)) {
  console.warn('Late-packet replay validation skipped: set REPLAY_VALIDATION_DATABASE to a replayed SQLite snapshot')
  process.exit(0)
}
assert.ok(dayRange, `Invalid farm day: ${farmDay}`)

const dayStartMs = dayRange.start.getTime()
const dayEndExclusiveMs = dayRange.end.getTime() + 1

function overlappingBatchIds(db) {
  return db.prepare(`
    SELECT id FROM Batch
    WHERE startTime < ? AND (endTime IS NULL OR endTime >= ?)
    ORDER BY startTime, id
  `).all(dayEndExclusiveMs, dayStartMs).map((row) => row.id)
}

function outsideSnapshot(db) {
  const ids = overlappingBatchIds(db)
  const placeholders = ids.map(() => '?').join(',')
  return {
    batches: ids.length
      ? db.prepare(`SELECT * FROM Batch WHERE id NOT IN (${placeholders}) ORDER BY id`).all(...ids)
      : db.prepare('SELECT * FROM Batch ORDER BY id').all(),
    ingredients: ids.length
      ? db.prepare(`SELECT * FROM BatchIngredient WHERE batchId NOT IN (${placeholders}) ORDER BY id`).all(...ids)
      : db.prepare('SELECT * FROM BatchIngredient ORDER BY id').all(),
    violations: ids.length
      ? db.prepare(`SELECT * FROM Violation WHERE batchId IS NULL OR batchId NOT IN (${placeholders}) ORDER BY id`).all(...ids)
      : db.prepare('SELECT * FROM Violation ORDER BY id').all()
  }
}

function normalizedDaySnapshot(db) {
  return overlappingBatchIds(db).map((batchId) => {
    const { id, ...batch } = db.prepare('SELECT * FROM Batch WHERE id = ?').get(batchId)
    const ingredients = db.prepare(`
      SELECT * FROM BatchIngredient WHERE batchId = ?
      ORDER BY startedAt, addedAt, ingredientName, id
    `).all(batchId).map(({ id: rowId, batchId: ownerId, ...row }) => row)
    const violations = db.prepare(`
      SELECT * FROM Violation WHERE batchId = ?
      ORDER BY detectedAt, code, componentKey, id
    `).all(batchId).map(({
      id: rowId,
      batchId: ownerId,
      createdAt,
      updatedAt,
      detectedAt,
      resolvedAt,
      ...row
    }) => row)
    return { ...batch, ingredients, violations }
  })
}

function rawSnapshot(db) {
  return {
    telemetry: db.prepare('SELECT COUNT(*) count, MIN(timestamp) min, MAX(timestamp) max FROM Telemetry').get(),
    rtk: db.prepare('SELECT COUNT(*) count, MIN(timestamp) min, MAX(timestamp) max FROM RtkTelemetry').get()
  }
}

function injectLatePacket(databasePath) {
  const db = new Database(databasePath)
  try {
    const source = db.prepare(`
      SELECT t.*
      FROM Telemetry t
      JOIN Batch b ON b.deviceId = t.deviceId
        AND t.timestamp >= b.startTime
        AND (b.endTime IS NULL OR t.timestamp <= b.endTime)
      WHERE t.timestamp >= ? AND t.timestamp < ?
      ORDER BY t.timestamp
      LIMIT 1 OFFSET 100
    `).get(dayStartMs, dayEndExclusiveMs) || db.prepare(`
      SELECT * FROM Telemetry
      WHERE timestamp >= ? AND timestamp < ?
      ORDER BY timestamp
      LIMIT 1
    `).get(dayStartMs, dayEndExclusiveMs)
    assert.ok(source, `No HOST telemetry available to seed on ${farmDay}`)

    const timestamp = Number(source.timestamp) + 500
    const sourcePacketId = Number(db.prepare(`
      SELECT COALESCE(MAX(sourcePacketId), 0) + 1000000 value FROM Telemetry
    `).get().value)
    db.prepare(`
      INSERT INTO Telemetry (
        sourceStreamId, sourcePacketId, deviceId, timestamp, receivedAt,
        lat, lon, gpsValid, gpsSatellites, gpsAgeS, speedKmh,
        weight, rawWeight, rawPayload, weightValid, gpsQuality, wifiClients,
        cpuTempC, lteRssiDbm, lteAccessTech, eventsReaderOk
      ) VALUES (
        @sourceStreamId, @sourcePacketId, @deviceId, @timestamp, @receivedAt,
        @lat, @lon, @gpsValid, @gpsSatellites, @gpsAgeS, @speedKmh,
        @weight, @rawWeight, @rawPayload, @weightValid, @gpsQuality, @wifiClients,
        @cpuTempC, @lteRssiDbm, @lteAccessTech, @eventsReaderOk
      )
    `).run({
      ...source,
      sourceStreamId: 'late-packet-day-replay-validation',
      sourcePacketId,
      timestamp,
      receivedAt: Date.now(),
      weight: Number(source.weight) + 75,
      rawWeight: Number(source.rawWeight ?? source.weight) + 75,
      rawPayload: JSON.stringify({ validation: 'late-packet', originalTelemetryId: source.id })
    })
    return { timestamp, deviceId: source.deviceId }
  } finally {
    db.close()
  }
}

function runReplay(databasePath, replayDay = null) {
  const result = spawnSync(process.execPath, ['scripts/replay-batches-from-telemetry.mjs'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATABASE_URL: `file:${databasePath.replaceAll('\\', '/')}`,
      ...(replayDay ? { REPLAY_DAY: replayDay } : {}),
      REPLAY_TRANSACTION_TIMEOUT_MS: '600000'
    },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000
  })
  if (result.status !== 0) {
    throw new Error(`${replayDay ? 'Day' : 'Global'} replay failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`)
  }
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-packet-replay-'))
const dayDatabasePath = path.join(tempDir, 'day.sqlite3')
const globalDatabasePath = path.join(tempDir, 'global.sqlite3')
let source = null
let database = null

try {
  source = new Database(sourcePath, { readonly: true })
  await source.backup(dayDatabasePath)
  await source.backup(globalDatabasePath)
  source.close()
  source = null

  const daySeed = injectLatePacket(dayDatabasePath)
  const globalSeed = injectLatePacket(globalDatabasePath)
  assert.deepEqual(globalSeed, daySeed)

  database = new Database(dayDatabasePath, { readonly: true })
  const beforeOutside = outsideSnapshot(database)
  const beforeRaw = rawSnapshot(database)
  database.close()
  database = null

  runReplay(dayDatabasePath, farmDay)
  runReplay(globalDatabasePath)

  const dayDatabase = new Database(dayDatabasePath, { readonly: true })
  const globalDatabase = new Database(globalDatabasePath, { readonly: true })
  try {
    assert.deepEqual(rawSnapshot(dayDatabase), beforeRaw, 'day replay must preserve the injected raw packet')
    assert.deepEqual(outsideSnapshot(dayDatabase), beforeOutside, 'late-packet day replay must not alter other days')
    assert.deepEqual(
      normalizedDaySnapshot(dayDatabase),
      normalizedDaySnapshot(globalDatabase),
      'day replay with a late packet must equal a global replay for the affected farm day'
    )
    assert.equal(dayDatabase.pragma('integrity_check', { simple: true }), 'ok')
    assert.equal(globalDatabase.pragma('integrity_check', { simple: true }), 'ok')
  } finally {
    dayDatabase.close()
    globalDatabase.close()
  }
  console.log(`Late-packet day replay validation passed for ${farmDay} at ${new Date(daySeed.timestamp).toISOString()}`)
} finally {
  try { source?.close() } catch {}
  try { database?.close() } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true })
}

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

if (!sourcePath || !fs.existsSync(sourcePath)) {
  console.warn('Day replay validation skipped: set REPLAY_VALIDATION_DATABASE to a replayed SQLite snapshot')
  process.exit(0)
}

const dayRange = farmDateRange(farmDay)
assert.ok(dayRange, `Invalid farm day: ${farmDay}`)
const dayStartMs = dayRange.start.getTime()
const dayEndExclusiveMs = dayRange.end.getTime() + 1

function overlappingBatchIds(db) {
  return db.prepare(`
    SELECT id
    FROM Batch
    WHERE startTime < ? AND (endTime IS NULL OR endTime >= ?)
    ORDER BY startTime, id
  `).all(dayEndExclusiveMs, dayStartMs).map((row) => row.id)
}

function exactOutsideSnapshot(db) {
  const ids = overlappingBatchIds(db)
  if (!ids.length) {
    return {
      batches: db.prepare('SELECT * FROM Batch ORDER BY id').all(),
      ingredients: db.prepare('SELECT * FROM BatchIngredient ORDER BY id').all(),
      violations: db.prepare('SELECT * FROM Violation ORDER BY id').all()
    }
  }
  const placeholders = ids.map(() => '?').join(',')
  return {
    batches: db.prepare(`SELECT * FROM Batch WHERE id NOT IN (${placeholders}) ORDER BY id`).all(...ids),
    ingredients: db.prepare(`SELECT * FROM BatchIngredient WHERE batchId NOT IN (${placeholders}) ORDER BY id`).all(...ids),
    violations: db.prepare(`SELECT * FROM Violation WHERE batchId IS NULL OR batchId NOT IN (${placeholders}) ORDER BY id`).all(...ids)
  }
}

function normalizedDaySnapshot(db) {
  const ids = overlappingBatchIds(db)
  return ids.map((batchId) => {
    const batch = db.prepare('SELECT * FROM Batch WHERE id = ?').get(batchId)
    const ingredients = db.prepare(`
      SELECT * FROM BatchIngredient
      WHERE batchId = ?
      ORDER BY startedAt, addedAt, ingredientName, id
    `).all(batchId)
    const violations = db.prepare(`
      SELECT * FROM Violation
      WHERE batchId = ?
      ORDER BY detectedAt, code, componentKey, id
    `).all(batchId)
    const { id, ...batchWithoutId } = batch
    return {
      ...batchWithoutId,
      ingredients: ingredients.map(({ id: ingredientId, batchId: ingredientBatchId, ...row }) => row),
      violations: violations.map(({
        id: violationId,
        batchId: violationBatchId,
        createdAt,
        updatedAt,
        detectedAt,
        resolvedAt,
        ...row
      }) => row)
    }
  })
}

function rawSnapshot(db) {
  return {
    telemetry: db.prepare('SELECT COUNT(*) count, MIN(timestamp) min, MAX(timestamp) max FROM Telemetry').get(),
    rtk: db.prepare('SELECT COUNT(*) count, MIN(timestamp) min, MAX(timestamp) max FROM RtkTelemetry').get()
  }
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-day-replay-'))
const databasePath = path.join(tempDir, 'day-replay.sqlite3')
let source = null
let database = null

try {
  source = new Database(sourcePath, { readonly: true })
  await source.backup(databasePath)
  source.close()
  source = null

  if (String(process.env.REPLAY_VALIDATION_SEED_WORKFLOW || '1') !== '0') {
    database = new Database(databasePath)
    const workflowViolation = database.prepare(`
      SELECT v.id
      FROM Violation v
      JOIN Batch b ON b.id = v.batchId
      WHERE b.startTime < ? AND (b.endTime IS NULL OR b.endTime >= ?)
      ORDER BY v.id
      LIMIT 1
    `).get(dayEndExclusiveMs, dayStartMs)
    if (workflowViolation) {
      database.prepare(`
        UPDATE Violation
        SET status = 'CLOSED', comment = 'day-replay-workflow-test', resolvedAt = ?
        WHERE id = ?
      `).run(dayStartMs, workflowViolation.id)
    }
    database.close()
    database = null
  }

  database = new Database(databasePath, { readonly: true })
  const before = {
    outside: exactOutsideSnapshot(database),
    day: normalizedDaySnapshot(database),
    raw: rawSnapshot(database)
  }
  assert.ok(before.day.length > 0, `Fixture has no batches for farm day ${farmDay}`)
  database.close()
  database = null

  const replay = spawnSync(process.execPath, ['scripts/replay-batches-from-telemetry.mjs'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATABASE_URL: `file:${databasePath.replaceAll('\\', '/')}`,
      REPLAY_DAY: farmDay,
      REPLAY_TRANSACTION_TIMEOUT_MS: '600000'
    },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000
  })
  if (replay.status !== 0) {
    throw new Error(`Day replay failed\nSTDOUT:\n${replay.stdout}\nSTDERR:\n${replay.stderr}`)
  }

  database = new Database(databasePath, { readonly: true })
  const after = {
    outside: exactOutsideSnapshot(database),
    day: normalizedDaySnapshot(database),
    raw: rawSnapshot(database),
    integrity: database.pragma('integrity_check', { simple: true })
  }
  database.close()
  database = null

  assert.deepEqual(after.raw, before.raw, 'day replay must not alter raw HOST/RTK telemetry')
  assert.deepEqual(after.outside, before.outside, 'day replay must not alter calculated rows outside the farm day')
  assert.deepEqual(after.day, before.day, 'day replay result must match the full-replay baseline for the farm day')
  assert.equal(after.integrity, 'ok')
  console.log(`Day replay validation passed for ${farmDay}: ${after.day.length} batches`)
} finally {
  try { source?.close() } catch {}
  try { database?.close() } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true })
}

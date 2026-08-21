import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const scriptPath = path.join(path.dirname(__filename), 'repair-host-naive-utc-timestamps.mjs')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-timestamp-repair-'))
const databasePath = path.join(tempDir, 'telemetry.sqlite3')
const backupPath = path.join(tempDir, 'telemetry-before-repair.sqlite3')
const correctedMs = new Date('2026-08-21T17:48:10Z').getTime()

function run(...args) {
  return execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
}

try {
  const db = new Database(databasePath)
  db.exec(`
    CREATE TABLE Telemetry (
      id INTEGER PRIMARY KEY,
      deviceId TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      receivedAt INTEGER NOT NULL,
      rawPayload TEXT
    )
  `)
  const insert = db.prepare('INSERT INTO Telemetry VALUES (?, ?, ?, ?, ?)')
  insert.run(1, 'host', correctedMs, correctedMs + 1000, JSON.stringify({ timestamp: '2026-08-21T17:48:10' }))
  insert.run(2, 'host', correctedMs - 3 * 60 * 60 * 1000, correctedMs + 1000, JSON.stringify({ timestamp: '2026-08-21T17:48:10' }))
  insert.run(3, 'host', correctedMs - 3 * 60 * 60 * 1000, correctedMs + 1000, JSON.stringify({ timestamp: '2026-08-21T17:48:10Z' }))
  db.close()

  const dryRun = run(`--database=${databasePath}`)
  assert.match(dryRun, /"candidates": 1/)
  assert.match(dryRun, /"farmDays": \[\s*"2026-08-22"/)

  const applied = run(`--database=${databasePath}`, '--apply', `--backup=${backupPath}`)
  assert.match(applied, /"changed": 1/)
  assert.ok(fs.existsSync(backupPath))

  const repaired = new Database(databasePath, { readonly: true })
  assert.equal(repaired.prepare('SELECT timestamp FROM Telemetry WHERE id = 2').get().timestamp, correctedMs)
  assert.equal(repaired.prepare('PRAGMA integrity_check').pluck().get(), 'ok')
  repaired.close()

  const backup = new Database(backupPath, { readonly: true })
  assert.equal(backup.prepare('SELECT timestamp FROM Telemetry WHERE id = 2').get().timestamp, correctedMs - 3 * 60 * 60 * 1000)
  backup.close()

  assert.match(run(`--database=${databasePath}`), /"candidates": 0/)
  console.log('Host timestamp repair tests passed')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

import { getFarmDateString } from '../src/utils/farm-date.js'
import { ISO_DATE_TIME_WITHOUT_ZONE, parseHostTimestamp } from '../src/modules/telemetry/host-timestamp.js'

function argument(name) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null
}

function rawTimestamp(rawPayload) {
  try {
    const value = JSON.parse(rawPayload || '{}')?.timestamp
    return typeof value === 'string' ? value.trim() : null
  } catch {
    return null
  }
}

const databasePath = path.resolve(argument('database') || 'prisma/dev.db')
const backupPath = argument('backup') ? path.resolve(argument('backup')) : null
const apply = process.argv.includes('--apply')
const EXPECTED_SHIFT_MS = 3 * 60 * 60 * 1000

if (!fs.existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`)
if (apply && !backupPath) throw new Error('--apply requires --backup=<path>')
if (backupPath && backupPath === databasePath) throw new Error('Backup path must differ from database path')
if (apply && fs.existsSync(backupPath)) throw new Error(`Backup already exists: ${backupPath}`)

const db = new Database(databasePath, { readonly: !apply })
db.pragma('busy_timeout = 10000')
const rows = db.prepare(`
  SELECT id, deviceId, timestamp, receivedAt, rawPayload
  FROM Telemetry
  WHERE rawPayload IS NOT NULL
  ORDER BY id ASC
`).all()

const candidates = rows.flatMap((row) => {
  const raw = rawTimestamp(row.rawPayload)
  if (!raw || !ISO_DATE_TIME_WITHOUT_ZONE.test(raw)) return []
  const correctedTimestamp = parseHostTimestamp(raw)
  const correctedMs = correctedTimestamp.getTime()
  if (!Number.isFinite(correctedMs) || correctedMs - Number(row.timestamp) !== EXPECTED_SHIFT_MS) return []
  return [{ ...row, rawTimestamp: raw, correctedTimestamp, correctedMs }]
})

const farmDays = [...new Set(candidates.map((row) => getFarmDateString(row.correctedTimestamp)))].sort()
let changed = 0

if (apply) {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true })
  await db.backup(backupPath)
  const backup = new Database(backupPath, { readonly: true })
  const backupIntegrity = backup.pragma('integrity_check', { simple: true })
  backup.close()
  if (backupIntegrity !== 'ok') throw new Error(`Backup integrity_check failed: ${backupIntegrity}`)

  const update = db.prepare('UPDATE Telemetry SET timestamp = ? WHERE id = ? AND timestamp = ?')
  db.transaction(() => {
    for (const row of candidates) {
      changed += update.run(row.correctedMs, row.id, row.timestamp).changes
    }
  }).immediate()
}

const result = {
  mode: apply ? 'apply' : 'dry-run',
  databasePath,
  backupPath,
  candidates: candidates.length,
  changed,
  farmDays,
  first: candidates[0] ? {
    id: candidates[0].id,
    oldTimestamp: new Date(Number(candidates[0].timestamp)).toISOString(),
    correctedTimestamp: candidates[0].correctedTimestamp.toISOString(),
    receivedAt: new Date(Number(candidates[0].receivedAt)).toISOString()
  } : null,
  last: candidates.at(-1) ? {
    id: candidates.at(-1).id,
    oldTimestamp: new Date(Number(candidates.at(-1).timestamp)).toISOString(),
    correctedTimestamp: candidates.at(-1).correctedTimestamp.toISOString(),
    receivedAt: new Date(Number(candidates.at(-1).receivedAt)).toISOString()
  } : null
}

console.log(JSON.stringify(result, null, 2))
db.close()

if (!apply) console.log('Dry-run only. Add --apply and --backup=<path> to repair the selected rows.')

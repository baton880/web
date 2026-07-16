import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

function argument(name) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null
}

const databasePath = path.resolve(argument('database') || 'prisma/dev.db')
const backupPath = argument('backup') ? path.resolve(argument('backup')) : null
const apply = process.argv.includes('--apply')
const DAY_MS = 24 * 60 * 60 * 1000
const MIN_BROKEN_LAG_MS = 20 * 60 * 60 * 1000
const MAX_BROKEN_LAG_MS = 28 * 60 * 60 * 1000
const MAX_CORRECTED_LAG_MS = 6 * 60 * 60 * 1000

if (!fs.existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`)
if (apply && !backupPath) throw new Error('--apply requires --backup=<path>')
if (apply) {
  if (path.resolve(backupPath) === databasePath) throw new Error('Backup path must differ from database path')
  fs.copyFileSync(databasePath, backupPath, fs.constants.COPYFILE_EXCL)
}

const db = new Database(databasePath, { readonly: !apply })
const rows = db.prepare(`
  SELECT id, deviceId, timestamp, createdAt, rawPayload
  FROM RtkTelemetry
  WHERE createdAt - timestamp BETWEEN ? AND ?
  ORDER BY createdAt ASC, id ASC
`).all(MIN_BROKEN_LAG_MS, MAX_BROKEN_LAG_MS)

const candidates = rows.filter((row) => {
  const corrected = Number(row.timestamp) + DAY_MS
  const correctedLag = Number(row.createdAt) - corrected
  return correctedLag >= -60 * 1000 && correctedLag <= MAX_CORRECTED_LAG_MS
})

let changed = 0
if (apply) {
  const update = db.prepare(`
    UPDATE RtkTelemetry SET timestamp = ?, rawPayload = ? WHERE id = ?
  `)
  const applyAll = db.transaction(() => {
    for (const row of candidates) {
      const corrected = Number(row.timestamp) + DAY_MS
      let rawPayload = row.rawPayload
      try {
        const raw = JSON.parse(row.rawPayload)
        if (typeof raw.timestamp === 'string') raw.timestamp = new Date(corrected).toISOString()
        if (typeof raw.time === 'string') raw.time = new Date(corrected).toISOString()
        rawPayload = JSON.stringify(raw)
      } catch (error) {
        // Preserve unreadable raw payload while fixing the indexed timestamp.
      }
      changed += update.run(corrected, rawPayload, row.id).changes
    }
  })
  applyAll()
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  databasePath,
  backupPath,
  candidates: candidates.length,
  changed,
  examples: candidates.slice(0, 10).map((row) => ({
    id: row.id,
    deviceId: row.deviceId,
    oldTimestamp: new Date(Number(row.timestamp)).toISOString(),
    correctedTimestamp: new Date(Number(row.timestamp) + DAY_MS).toISOString(),
    receivedAt: new Date(Number(row.createdAt)).toISOString()
  }))
}, null, 2))

db.close()
if (!apply) console.log('Dry-run only. Add --apply and --backup=<path> to modify the selected database.')

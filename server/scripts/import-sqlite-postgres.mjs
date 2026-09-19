// Explicit, offline import into an empty PostgreSQL database. Source files are
// read-only; every copied scalar is compared again before a single commit.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import Database from 'better-sqlite3'
import pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import clientModule from '../generated/postgresql-client/index.js'

const { Prisma } = clientModule
const url = process.env.DATABASE_URL || ''
const name = new URL(url).pathname.slice(1)
if (!/^postgres(?:ql)?:/.test(url) || process.env.IMPORT_POSTGRES_CONFIRM !== name || !name || name === 'postgres')
  throw Error('Set IMPORT_POSTGRES_CONFIRM to the explicit destination database name')
if (!process.env.IMPORT_SQLITE_MAIN || !process.env.IMPORT_SQLITE_LOADER) throw Error('Both SQLite source paths are required')
const sources = [process.env.IMPORT_SQLITE_MAIN, process.env.IMPORT_SQLITE_LOADER].map(p => new Database(p, { readonly: true, fileMustExist: true }))
const target = new pg.Client({ connectionString: url })
const quote = value => '"' + value.replaceAll('"', '""') + '"'
// Ingress is imported separately with its own consistent snapshot and lease conversion.
const models = Prisma.dmmf.datamodel.models.filter(m => !['host_ingress','rtk_ingress','host_ingress_meta','calculated_replay_dirty'].includes(m.dbName || m.name))
const tableModels = new Map(models.map(m => [m.dbName || m.name, m]))
const tableSources = new Map()
for (const source of sources) {
  for (const { name: table } of source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    if (table === '_prisma_migrations') continue
    if (!tableModels.has(table)) throw Error(`Unmapped source table: ${table}`)
    if (tableSources.has(table)) throw Error(`Duplicate source table: ${table}`)
    tableSources.set(table, source)
  }
}
const ordered = [], pending = [...models]
while (pending.length) {
  const i = pending.findIndex(m => m.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length).every(f => ordered.some(o => o.name === f.type)))
  if (i < 0) throw Error('Cyclic model dependencies need an explicit import strategy')
  ordered.push(pending.splice(i, 1)[0])
}

function scalar(value, field) {
  if (value == null) {
    if (field.isRequired) throw Error(`NULL in required field ${field.name}`)
    return null
  }
  if (field.type === 'DateTime') {
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) throw Error(`Invalid timestamp in ${field.name}`)
    return date.toISOString()
  }
  if (field.type === 'Boolean') {
    if (![0, 1, true, false].includes(value)) throw Error(`Invalid boolean in ${field.name}`)
    return Boolean(value)
  }
  if (field.type === 'BigInt') return String(value)
  return value
}
const csv = value => value === null ? '\\N' : '"' + String(value).replaceAll('"', '""') + '"'
const report = { database: name, startedAt: new Date().toISOString(), tables: [] }
try {
  await target.connect()
  await target.query('BEGIN')
  await target.query("SELECT pg_advisory_xact_lock(hashtextextended('farm-offline-import',0))")
  await target.query("SET LOCAL TIME ZONE 'UTC'")
  // Check every destination before inserting any data, including extra models.
  for (const model of models) {
    const table = model.dbName || model.name
    const count = await target.query(`SELECT count(*) AS n FROM ${quote(table)}`)
    if (count.rows[0].n !== '0') throw Error(`Destination is not empty: ${table}`)
  }
  for (const model of ordered) {
    const table = model.dbName || model.name, source = tableSources.get(table)
    if (!source) throw Error(`Missing source table: ${table}`)
    const fields = model.fields.filter(f => f.kind !== 'object')
    const columns = fields.map(f => f.dbName || f.name)
    const sourceColumns = source.prepare(`PRAGMA table_info(${quote(table)})`).all().map(c => c.name)
    if (sourceColumns.some(c => !columns.includes(c)) || columns.some(c => !sourceColumns.includes(c))) throw Error(`Column mismatch: ${table}`)
    const keys = model.primaryKey?.fields || model.fields.filter(f => f.isId).map(f => f.name)
    if (!keys.length) throw Error(`Missing ordering key: ${table}`)
    const order = keys.map(quote).join(',')
    const select = `SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${order}`
    const expected = crypto.createHash('sha256')
    let count = 0
    function* rows() {
      for (const row of source.prepare(select).iterate()) {
        const values = fields.map((f, i) => scalar(row[columns[i]], f))
        expected.update(JSON.stringify(values) + '\n'); count++
        yield values.map(csv).join(',') + '\n'
      }
    }
    await pipeline(Readable.from(rows()), target.query(copyFrom(`COPY ${quote(table)} (${columns.map(quote).join(',')}) FROM STDIN WITH (FORMAT csv, NULL '\\N')`)))
    const expectedHash = expected.digest('hex'), actual = crypto.createHash('sha256')
    let actualCount = 0
    await target.query(`DECLARE import_verify NO SCROLL CURSOR FOR ${select}`)
    while (true) {
      const chunk = await target.query('FETCH 1000 FROM import_verify')
      if (!chunk.rows.length) break
      for (const row of chunk.rows) { actual.update(JSON.stringify(fields.map((f, i) => scalar(row[columns[i]], f))) + '\n'); actualCount++ }
    }
    await target.query('CLOSE import_verify')
    const actualHash = actual.digest('hex')
    if (actualCount !== count || actualHash !== expectedHash) throw Error(`Verification mismatch: ${table}`)
    for (const field of fields.filter(f => f.isId && f.default?.name === 'autoincrement')) {
      const sequence = await target.query('SELECT pg_get_serial_sequence($1,$2) AS name', [quote(table), field.name])
      if (!sequence.rows[0].name) throw Error(`Missing sequence: ${table}`)
      const max = await target.query(`SELECT max(${quote(field.name)}) AS value FROM ${quote(table)}`)
      const hasSequence = source.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()
      const sourceSequence = hasSequence ? source.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq : 0
      const highWater = Math.max(Number(max.rows[0].value || 0), Number(sourceSequence || 0))
      await target.query('SELECT setval($1::regclass,$2,$3)', [sequence.rows[0].name, highWater || 1, highWater > 0])
    }
    const summary = { table, count, sha256: actualHash }
    report.tables.push(summary)
    console.log(JSON.stringify(summary))
  }
  await target.query('COMMIT')
  report.completedAt = new Date().toISOString()
  if (process.env.IMPORT_REPORT_PATH) fs.writeFileSync(process.env.IMPORT_REPORT_PATH, JSON.stringify(report, null, 2))
  console.log('IMPORT VERIFIED AND COMMITTED')
} catch (error) {
  await target.query('ROLLBACK').catch(() => {})
  console.error('IMPORT FAILED:', error.message)
  process.exitCode = 1
} finally {
  for (const source of sources) source.close()
  await target.end()
}

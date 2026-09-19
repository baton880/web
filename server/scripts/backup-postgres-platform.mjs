import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import pg from 'pg'
import Database from 'better-sqlite3'

// Run with the private administrator EnvironmentFile; never pass it to PM2.
const app = process.env.BACKUP_PM2_APP
const release = process.env.BACKUP_RELEASE
const root = process.env.BACKUP_ROOT
const url = process.env.DATABASE_URL
if (!app || !release || !root || !url || !path.isAbsolute(release) || !path.isAbsolute(root)) throw Error('Explicit backup paths, application name and DATABASE_URL required')
const database = decodeURIComponent(new URL(url).pathname.slice(1))
const postgresIngress = process.env.BACKUP_INGRESS_BACKEND === 'postgres'
const inboxFiles = postgresIngress ? [] : ['host-ingress.sqlite3', 'rtk-ingress.sqlite3']
if (!/^farm_[a-z0-9_]+$/.test(database)) throw Error('Unexpected database')
const childEnv = { ...process.env }
delete childEnv.DATABASE_URL
const run = (cmd, args) => execFileSync(cmd, args, { env: childEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const destination = path.join(root, stamp)
fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
const space = fs.statfsSync(root)
if (space.bavail * space.bsize < 3 * 1024 ** 3) throw Error('Less than 3 GiB free; backup aborted before pausing application')
const connection = new pg.Client({ connectionString: url })
let stopped = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopped) { run('pm2', ['restart', app]); stopped = false }
  process.exit(1)
})
let pauseStarted
const report = { database, app, release, startedAt: new Date().toISOString(), files: [] }
try {
  const state = JSON.parse(run('pm2', ['jlist'])).find(p => p.name === app)
  if (state?.pm2_env?.status !== 'online') throw Error('Application must be online before backup')
  const configuredBackend = state.pm2_env.INGRESS_BACKEND || fs.readFileSync(path.join(release, 'server/.env'), 'utf8')
    .split(/\r?\n/).find(line => line.trim().startsWith('INGRESS_BACKEND='))?.split('=')[1]?.trim().replace(/^['"]|['"]$/g, '')
  if (postgresIngress && configuredBackend !== 'postgres') throw Error('Online-only backup requires the application to use PostgreSQL inboxes')
  await connection.connect()
  pauseStarted = Date.now()
  if (!postgresIngress) { run('pm2', ['stop', app]); stopped = true }
  await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const { rows } = await connection.query('SELECT pg_export_snapshot() AS snapshot')
  const snapshot = rows[0].snapshot
  for (const filename of inboxFiles) {
    const source = new Database(path.join(release, 'server/runtime', filename), { readonly: true, fileMustExist: true })
    try { await source.backup(path.join(destination, filename)) } finally { source.close() }
  }
  // The exported PG snapshot and both inbox files now describe the same stopped app.
  if (stopped) { run('pm2', ['restart', app]); stopped = false }
  report.pauseMs = postgresIngress ? 0 : Date.now() - pauseStarted
  report.ingressBackend = postgresIngress ? 'postgres' : 'sqlite'
  report.tableCounts = {}
  const tables = await connection.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  for (const { tablename } of tables.rows) {
    const quoted = '"' + tablename.replaceAll('"', '""') + '"'
    const count = await connection.query(`SELECT count(*)::text AS n FROM ${quoted}`)
    report.tableCounts[tablename] = count.rows[0].n
  }
  await new Promise((resolve, reject) => {
    const output = fs.openSync(path.join(destination, 'farm.dump'), 'wx', 0o600)
    const child = spawn('docker', ['exec', process.env.BACKUP_PG_CONTAINER || 'farm-postgres', 'pg_dump', '-U', 'postgres', '-d', database, '-Fc', '--snapshot', snapshot], { env: childEnv, stdio: ['ignore', output, 'pipe'] })
    fs.closeSync(output)
    let error = ''
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(Error(`pg_dump exited ${code}: ${error}`)))
  })
  await connection.query('COMMIT')
  for (const filename of inboxFiles) {
    const copy = new Database(path.join(destination, filename), { readonly: true })
    try {
      if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw Error(`Corrupt snapshot: ${filename}`)
      if (copy.pragma('foreign_key_check').length) throw Error(`Foreign key failure: ${filename}`)
    } finally { copy.close() }
  }
  // Include exact deployed source, private settings, nginx and PM2 state.
  run('tar', ['--exclude=node_modules', '--exclude=generated', '--exclude=runtime', '--exclude=.git', '-czf', path.join(destination, 'application-config.tar.gz'), '-C', '/', release.slice(1), 'opt/farm-platform/secrets', 'etc/nginx', 'root/.pm2/dump.pm2'])
  for (const filename of ['farm.dump', ...inboxFiles, 'application-config.tar.gz']) {
    const hash = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(path.join(destination, filename))) hash.update(chunk)
    report.files.push({ filename, bytes: fs.statSync(path.join(destination, filename)).size, sha256: hash.digest('hex') })
  }
  report.completedAt = new Date().toISOString()
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  fs.writeFileSync(path.join(destination, 'SHA256SUMS'), report.files.map(f => `${f.sha256}  ${f.filename}`).join('\n') + '\n', { mode: 0o600 })
  // Prune only completed daily backups produced by this script; migration archives live elsewhere.
  const completed = fs.readdirSync(root).filter(name => /^\d{4}-\d{2}-\d{2}T/.test(name))
    .map(name => path.join(root, name)).filter(dir => fs.existsSync(path.join(dir, 'manifest.json'))).sort().reverse()
  for (const dir of completed.slice(7)) {
    if (path.dirname(path.resolve(dir)) !== path.resolve(root)) throw Error('Unsafe retention path')
    fs.rmSync(dir, { recursive: true })
  }
  console.log(JSON.stringify({ destination, pauseMs: report.pauseMs, completedAt: report.completedAt }))
} finally {
  await connection.query('ROLLBACK').catch(() => {})
  await connection.end().catch(() => {})
  if (stopped) run('pm2', ['restart', app])
}

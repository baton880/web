import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import pg from 'pg'
const directory = process.env.BACKUP_DIRECTORY
const name = process.env.RESTORE_DATABASE
if (!directory || !path.isAbsolute(directory) || !/^farm_restore_[a-z0-9_]+$/.test(name || '')) throw Error('Explicit backup directory and isolated farm_restore_* database required')
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
const url = new URL(process.env.DATABASE_URL)
url.pathname = '/' + name
const container = process.env.BACKUP_PG_CONTAINER || 'farm-postgres'
for (const entry of manifest.files) {
  if (path.basename(entry.filename) !== entry.filename) throw Error('Unsafe manifest path')
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(path.join(directory, entry.filename))) hash.update(chunk)
  if (hash.digest('hex') !== entry.sha256) throw Error(`Checksum mismatch: ${entry.filename}`)
}
execFileSync('docker', ['exec', container, 'createdb', '-U', 'postgres', name])
const input = fs.openSync(path.join(directory, 'farm.dump'), 'r')
await new Promise((resolve, reject) => {
  const child = spawn('docker', ['exec', '-i', container, 'pg_restore', '-U', 'postgres', '-d', name, '--exit-on-error'], { stdio: [input, 'inherit', 'pipe'] })
  fs.closeSync(input)
  let error = ''
  child.stderr.on('data', chunk => { error += chunk })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(Error(`Restore exited ${code}: ${error}`)))
})
const client = new pg.Client({ connectionString: url.toString() })
try {
  await client.connect()
  const counts = {}
  for (const [table, expected] of Object.entries(manifest.tableCounts)) {
    const quoted = '"' + table.replaceAll('"', '""') + '"'
    counts[table] = (await client.query(`SELECT count(*)::text AS n FROM ${quoted}`)).rows[0].n
    if (counts[table] !== expected) throw Error(`Restored count mismatch: ${table}`)
  }
  const invalid = await client.query('SELECT count(*)::int AS n FROM pg_constraint WHERE NOT convalidated')
  if (invalid.rows[0].n !== 0) throw Error('Unvalidated restored constraints')
  fs.writeFileSync(path.join(directory, 'restore-verification.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), database: name, checksums: 'passed', tableCounts: counts, constraints: 'validated' }, null, 2), { mode: 0o600 })
} finally { await client.end() }
execFileSync('docker', ['exec', container, 'dropdb', '-U', 'postgres', name])
console.log('RESTORE VERIFIED: checksums, every table count, all constraints; temporary database removed')

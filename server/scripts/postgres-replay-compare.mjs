import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import clientModule from '../generated/postgresql-client/index.js'
import sqliteModule from '@prisma/client'
const pgUrl = process.env.TEST_POSTGRES_DATABASE_URL
const sqliteUrl = process.env.TEST_SQLITE_DATABASE_URL
if (!pgUrl || !new URL(pgUrl).pathname.startsWith('/farm_test') || !sqliteUrl?.startsWith('file:')) throw Error('Isolated test databases required')
const pg = new clientModule.PrismaClient({ datasources: { db: { url: pgUrl } } })
const sqlite = new sqliteModule.PrismaClient({ datasources: { db: { url: sqliteUrl } } })
const day = process.env.REPLAY_VALIDATION_DAY || '2026-08-24'
async function run(url, label, fail = false) {
  const log = fs.openSync(`/opt/farm-platform/${label}.log`, 'w')
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/replay-batches-from-telemetry.mjs'], { env: { ...process.env,
      DATABASE_URL: url, INGRESS_BACKEND: /^postgres/.test(url) ? 'postgres' : 'sqlite', REPLAY_DAY: day, REPLAY_FAIL_AFTER_RESET: fail ? '1' : '0', RTK_BUFFER_REPLAY_ENABLED: '0',
      DATA_RETENTION_ENABLED: 'false' }, stdio: ['ignore', log, log] })
    child.on('exit', resolve)
  })
  fs.closeSync(log)
  assert.equal(code === 0, !fail, label)
}
async function rawSummary(db) {
  return Promise.all([db.telemetry.count(), db.rtkTelemetry.count(), db.telemetry.aggregate({ _min: { timestamp: true }, _max: { timestamp: true } }), db.rtkTelemetry.aggregate({ _min: { timestamp: true }, _max: { timestamp: true } })])
}
async function calculated(db) {
  return Promise.all([db.batch.findMany({ orderBy: { id: 'asc' } }), db.batchIngredient.findMany({ orderBy: { id: 'asc' } }), db.violation.findMany({ orderBy: { id: 'asc' } })])
}
async function semantic(db) {
  const rows = await db.batch.findMany({ orderBy: [{ deviceId: 'asc' }, { startTime: 'asc' }], include: { actualIngredients: true, violations: true } })
  return rows.map(({ id, actualIngredients, violations, ...batch }) => ({ ...batch,
    ingredients: actualIngredients.map(({ id, batchId, ...v }) => v).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    violations: violations.map(({ id, batchId, createdAt, updatedAt, detectedAt, ...v }) => v).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
}
try {
  const rawBefore = await rawSummary(pg), before = await calculated(pg)
  await run(pgUrl, 'pg-replay-rollback', true)
  assert.deepEqual(await calculated(pg), before, 'Forced failure must restore all calculated rows')
  await run(sqliteUrl, 'sqlite-replay-baseline')
  await run(pgUrl, 'pg-replay-success')
  assert.ok(await pg.appState.findUnique({where:{key:'processor-checkpoint:v1'}}), 'Replay checkpoint persisted')
  assert.deepEqual(await rawSummary(pg), rawBefore, 'PostgreSQL raw counts/time ranges unchanged')
  assert.deepEqual(await rawSummary(sqlite), rawBefore, 'SQLite raw counts/time ranges unchanged')
  const expected = await semantic(sqlite), actual = await semantic(pg)
  fs.writeFileSync('/opt/farm-platform/replay-semantic-sqlite.json', JSON.stringify(expected))
  fs.writeFileSync('/opt/farm-platform/replay-semantic-postgres.json', JSON.stringify(actual))
  assert.deepEqual(actual, expected, 'Same day replay must calculate the same facts on both databases')
  console.log('PASS PostgreSQL replay: full transaction rollback, day replay equivalence, raw counts and time ranges preserved')
} finally { await pg.$disconnect(); await sqlite.$disconnect() }

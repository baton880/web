import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { PostgresRtkIngressStore, IngressLeaseLostError } from '../src/modules/telemetry/rtk-postgres-ingress-store.js'
const url = process.env.TEST_POSTGRES_DATABASE_URL
if (!url || !/^\/farm_test_[a-z0-9_]+$/.test(new URL(url).pathname)) throw Error('An isolated farm_test_* PostgreSQL database is required')
const pool = new pg.Pool({ connectionString: url, max: 6 })
const otherPool = new pg.Pool({ connectionString: url, max: 6 })
const a = new PostgresRtkIngressStore(pool), b = new PostgresRtkIngressStore(otherPool)
if (process.argv[2] === '--crash-after-enqueue') {
  await a.enqueue('{"crash":"commit-before-ack"}')
  process.exit(17) // Abrupt process loss after durable commit, no result returned to sender.
}
if (process.argv[2] === '--crash-after-claim') {
  assert.ok(await a.claimNext())
  process.exit(23) // Lease must survive loss of this process/connection.
}
try {
  assert.equal((await pool.query("SELECT to_regclass('public.rtk_ingress') AS t")).rows[0].t, null, 'Use a new empty test database')
  await pool.query(fs.readFileSync(new URL('../ops/stage2-rtk-ingress.sql', import.meta.url), 'utf8'))
  const inserted = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).enqueue(JSON.stringify({ packet: Math.floor(i / 2) }))))
  assert.equal(inserted.filter(r => r.inserted).length, 20)
  assert.equal((await a.stats()).pending, 20)
  assert.equal((await a.recentAccepted()).length, 20)
  const claims = (await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).claimNext().then(row => ({ store: i % 2 ? a : b, row }))))).filter(x => x.row)
  assert.equal(claims.length, 20)
  assert.equal(new Set(claims.map(x => x.row.id)).size, 20)
  await Promise.all(claims.map(({ store, row }) => store.markProcessed(row.id, row.lease_token)))
  await assert.rejects(claims[0].store.markProcessed(claims[0].row.id, claims[0].row.lease_token), IngressLeaseLostError)
  console.log('PASS concurrent deduplication, exclusive claims, completion fencing')

  const crash = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--crash-after-enqueue'], { env: process.env })
  assert.equal(crash.status, 17, crash.stderr?.toString())
  const duplicate = await b.enqueue('{"crash":"commit-before-ack"}')
  assert.equal(duplicate.inserted, false)
  assert.equal(duplicate.row.status, 'pending')
  const crashedClaim = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--crash-after-claim'], { env: process.env })
  assert.equal(crashedClaim.status, 23, crashedClaim.stderr?.toString())
  const before = (await pool.query('SELECT * FROM rtk_ingress WHERE id=$1', [duplicate.row.id])).rows[0]
  const replacement = new PostgresRtkIngressStore(otherPool)
  assert.equal(await replacement.claimNext(), null, 'New process must not reset a valid lease')
  await pool.query("UPDATE rtk_ingress SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [duplicate.row.id])
  const reclaimed = await replacement.claimNext()
  assert.equal(reclaimed.id, duplicate.row.id)
  assert.equal(reclaimed.attempts, 2)
  assert.notEqual(reclaimed.lease_token, before.lease_token)
  const stale = new PostgresRtkIngressStore(pool, { owner: before.lease_owner })
  await assert.rejects(stale.markProcessed(reclaimed.id, before.lease_token), IngressLeaseLostError)
  await assert.rejects(a.markProcessed(reclaimed.id, reclaimed.lease_token), IngressLeaseLostError)
  await replacement.renewLease(reclaimed.id, reclaimed.lease_token)
  await replacement.markRetry(reclaimed.id, 'temporary failure', 1000, reclaimed.lease_token)
  assert.equal(await a.claimNext(), null, 'Respect retry delay')
  await pool.query("UPDATE rtk_ingress SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1", [reclaimed.id])
  const retry = await a.claimNext()
  assert.equal(retry.attempts, 3)
  await a.markProcessed(retry.id, retry.lease_token)
  console.log('PASS crash after commit, process loss after claim, expired lease recovery, stale owner rejection, retry')

  await a.enqueue('{malformed')
  assert.equal(await a.latestAccepted(), null)
  const malformed = await b.claimNext()
  await b.markPermanent(malformed.id, 'malformed JSON', malformed.lease_token)
  assert.equal((await a.stats()).permanent, 1)
  assert.equal((await a.recentAccepted()).length, 21)
  const lockedRow = (await a.enqueue('{"lock":1}')).row
  const nextRow = (await a.enqueue('{"lock":2}')).row
  const holder = await pool.connect()
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM rtk_ingress WHERE id=$1 FOR UPDATE', [lockedRow.id])
    const next = await b.claimNext()
    assert.equal(next.id, nextRow.id, 'Skip another transaction lock')
    await b.markProcessed(next.id, next.lease_token)
    await holder.query('ROLLBACK')
  } finally { holder.release() }
  const unlocked = await a.claimNext()
  assert.equal(unlocked.id, lockedRow.id)
  await a.markProcessed(unlocked.id, unlocked.lease_token)
  await pool.query("UPDATE rtk_ingress SET processed_at=clock_timestamp()-interval '8 days' WHERE status='processed'")
  assert.equal(await a.cleanup(), 23)
  assert.equal((await a.stats()).permanent, 1, 'Never clean permanent failures')
  console.log('PASS malformed retention, locked-row concurrency, cleanup')
} finally { await pool.end(); await otherPool.end() }

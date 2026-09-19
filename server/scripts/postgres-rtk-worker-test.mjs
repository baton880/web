import assert from 'node:assert/strict'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { PostgresRtkIngressStore } from '../src/modules/telemetry/rtk-postgres-ingress-store.js'
import { startRtkIngressWorker } from '../src/modules/telemetry/rtk-ingress-worker.js'
import { TelemetryWriteCoordinator } from '../src/modules/telemetry/telemetry-write-coordinator.js'
const url = process.env.TEST_POSTGRES_DATABASE_URL
if (!url || !/^\/farm_test_[a-z0-9_]+$/.test(new URL(url).pathname)) throw Error('Isolated test database required')
const pool = new pg.Pool({ connectionString: url, max: 4 })
const store = new PostgresRtkIngressStore(pool, { leaseMs: 1000 })
const competitor = new PostgresRtkIngressStore(pool)
const coordinator = new TelemetryWriteCoordinator()
const options = { store, writeCoordinator: coordinator, recordResult: async () => {}, recordMalformed: async () => {}, pollMs: 25 }
const success = { received: 1, accepted: 1, dropped: 0 }
const workers = []
async function until(predicate) {
  const deadline = Date.now() + 8000
  while (!await predicate()) { if (Date.now() >= deadline) throw Error('Worker condition timed out'); await delay(25) }
}
try {
  assert.equal((await pool.query("SELECT to_regclass('public.rtk_ingress') AS t")).rows[0].t, null)
  await pool.query(fs.readFileSync(new URL('../ops/stage2-rtk-ingress.sql', import.meta.url), 'utf8'))
  await store.enqueue('{"slow":1}')
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const slow = startRtkIngressWorker(async () => { entered(); await blocked; return success }, options)
  workers.push(slow)
  await started
  await delay(1500) // Work exceeds the initial 1-second lease.
  assert.equal(await competitor.claimNext(), null, 'Heartbeat keeps ownership during long work')
  release()
  await until(async () => (await store.stats()).processed === 1)
  slow.stop()
  console.log('PASS worker awaits asynchronous store and renews lease during long processing')

  let calls = 0
  await store.enqueue('{"retry":1}')
  const retry = startRtkIngressWorker(async () => { if (++calls === 1) throw Error('intentional transient failure'); return success }, options)
  workers.push(retry)
  await until(async () => (await store.stats()).retry === 1)
  assert.equal(calls, 1)
  await until(async () => (await store.stats()).processed === 2)
  assert.equal(calls, 2)
  retry.stop()
  console.log('PASS worker records retry durably and recovers')

  const lostRow = (await store.enqueue('{"lostLease":1}')).row
  let enteredLost, releaseLost
  const startedLost = new Promise(resolve => { enteredLost = resolve })
  const blockedLost = new Promise(resolve => { releaseLost = resolve })
  const lost = startRtkIngressWorker(async () => { enteredLost(); await blockedLost; return success }, options)
  workers.push(lost)
  await startedLost
  lost.stop()
  await pool.query("UPDATE rtk_ingress SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [lostRow.id])
  const newClaim = await competitor.claimNext()
  assert.equal(newClaim.id, lostRow.id)
  releaseLost()
  await until(async () => coordinator.activeWriters === 0)
  const fenced = (await pool.query('SELECT status,lease_token FROM rtk_ingress WHERE id=$1', [lostRow.id])).rows[0]
  assert.equal(fenced.status, 'processing', 'Old worker cannot complete or retry the new claim')
  assert.equal(fenced.lease_token, newClaim.lease_token)
  await competitor.markProcessed(newClaim.id, newClaim.lease_token)
  console.log('PASS stale worker cannot change a reassigned lease')

  const bad = await store.enqueue('{invalid')
  const invalid = startRtkIngressWorker(async () => { throw Error('Malformed JSON must not reach processor') }, options)
  workers.push(invalid)
  await until(async () => (await store.stats()).permanent === 1)
  invalid.stop()
  assert.equal((await pool.query('SELECT status FROM rtk_ingress WHERE id=$1', [bad.row.id])).rows[0].status, 'permanent')
  assert.equal(coordinator.activeWriters, 0)
  console.log('PASS malformed packet marked permanent and process-local writer released')
} finally { for (const worker of workers) worker.stop(); await pool.end() }

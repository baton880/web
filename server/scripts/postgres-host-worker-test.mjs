import assert from 'node:assert/strict'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { PostgresHostIngressStore } from '../src/modules/telemetry/host-postgres-ingress-store.js'
import { startHostIngressWorker } from '../src/modules/telemetry/host-ingress-worker.js'
import { TelemetryWriteCoordinator } from '../src/modules/telemetry/telemetry-write-coordinator.js'
const url = process.env.TEST_POSTGRES_DATABASE_URL
if (!url || !/^\/farm_test_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw Error('Isolated test database required')
const pool = new pg.Pool({ connectionString: url, max: 6 })
const store = new PostgresHostIngressStore(pool, { leaseMs: 1000 }),
  competitor = new PostgresHostIngressStore(pool)
const coordinator = new TelemetryWriteCoordinator(),
  scheduled = [],
  workers = []
const options = {
  store,
  writeCoordinator: coordinator,
  scheduleReplay: async (reason, meta) => scheduled.push({ reason, meta }),
  pollMs: 25,
}
const timestamp = '2026-07-17T10:00:00.000Z'
async function until(predicate) {
  const end = Date.now() + 8000
  while (!(await predicate())) {
    if (Date.now() > end) throw Error('Worker condition timed out')
    await delay(25)
  }
}
try {
  assert.equal((await pool.query("SELECT to_regclass('public.host_ingress') AS t")).rows[0].t, null)
  await pool.query(
    fs.readFileSync(new URL('../ops/stage2-host-ingress.sql', import.meta.url), 'utf8'),
  )
  await store.enqueueLegacy({ device_id: 'HOST_TEST', slow: 1, timestamp })
  let entered, release
  const started = new Promise((r) => (entered = r)),
    blocked = new Promise((r) => (release = r))
  const slow = startHostIngressWorker(async (body, receivedAt, identity) => {
    assert.equal(identity.packetId, 0)
    assert.equal(identity.isLive, true)
    entered()
    await blocked
    return { timestamp, outOfOrder: true }
  }, options)
  workers.push(slow)
  await started
  await delay(1500)
  assert.equal(await competitor.claimNext(), null)
  release()
  await until(async () => scheduled.length === 1 && (await store.stats()).processed === 1)
  slow.stop()
  assert.equal(await store.replayDrainThroughId(), null)
  assert.equal((await store.nextReplayDirty()).version, 1)
  assert.equal(await store.processedHighWaterTimestamp(), timestamp)
  assert.equal(scheduled[0].meta.farmDay, '2026-07-17')
  console.log(
    'PASS async HOST worker renews lease, completes metadata atomically, schedules replay after drain',
  )
  await store.clearHistoryDirty()
  await store.enqueueLegacy({ device_id: 'HOST_TEST', retry: 1, timestamp })
  let calls = 0
  const retry = startHostIngressWorker(async () => {
    if (++calls === 1) throw Error('intentional transient failure')
    return { timestamp }
  }, options)
  workers.push(retry)
  await until(async () => (await store.stats()).retry === 1)
  await until(async () => (await store.stats()).processed === 2)
  retry.stop()
  assert.equal(calls, 2)
  console.log('PASS HOST durable retry')
  await store.enqueueLegacy({ device_id: 'HOST_TEST', lost: 1, timestamp })
  let enterLost, releaseLost
  const startLost = new Promise((r) => (enterLost = r)),
    blockLost = new Promise((r) => (releaseLost = r))
  const lost = startHostIngressWorker(async () => {
    enterLost()
    await blockLost
    return { timestamp: '2099-01-01T00:00:00Z', outOfOrder: true }
  }, options)
  workers.push(lost)
  await startLost
  lost.stop()
  const old = (await pool.query("SELECT id FROM host_ingress WHERE status='processing'")).rows[0]
  await pool.query(
    "UPDATE host_ingress SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [old.id],
  )
  const claimed = await competitor.claimNext()
  assert.equal(String(claimed.id), old.id)
  releaseLost()
  await until(async () => coordinator.activeWriters === 0)
  assert.equal(
    await store.processedHighWaterTimestamp(),
    timestamp,
    'Stale completion must not advance metadata',
  )
  assert.equal(
    await store.nextReplayDirty(),
    null,
    'Stale completion must not create dirty generations',
  )
  assert.equal(
    (await pool.query('SELECT status FROM host_ingress WHERE id=$1', [old.id])).rows[0].status,
    'processing',
  )
  await competitor.completeProcessed(claimed, { timestamp })
  console.log('PASS lost lease fences HOST queue completion and replay metadata')
} finally {
  for (const w of workers) w.stop()
  await pool.end()
}

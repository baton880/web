import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { HostIngressStore } from '../src/modules/telemetry/host-ingress-store.js'
import { PostgresHostIngressStore } from '../src/modules/telemetry/host-postgres-ingress-store.js'
import { IngressLeaseLostError } from '../src/modules/telemetry/rtk-postgres-ingress-store.js'
const url = process.env.TEST_POSTGRES_DATABASE_URL
if (!url || !/^\/farm_test_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw Error('Isolated farm_test_* database required')
const pool = new pg.Pool({ connectionString: url, max: 8 }),
  otherPool = new pg.Pool({ connectionString: url, max: 4 })
const a = new PostgresHostIngressStore(pool),
  b = new PostgresHostIngressStore(otherPool)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-pg-parity-'))
const sqlite = new HostIngressStore(path.join(temp, 'reference.sqlite3'))
const envelope = (first, last, deviceId = 'HOST_A', streamId = 'stream-a') => ({
  deviceId,
  streamId,
  livePacketId: last,
  packets: Array.from({ length: last - first + 1 }, (_, i) => ({
    packetId: first + i,
    payload: {
      timestamp: new Date(Date.UTC(2026, 6, 17, 10, 0, first + i)).toISOString(),
      weight: first + i,
    },
  })),
})
const at = new Date('2026-07-17T10:30:00Z')
const stripDirty = (rows) => rows.map(({ updatedAt, ...row }) => row)
async function parity(store) {
  const result = {}
  result.receipt = await store.enqueueBatch(envelope(1, 3), at)
  await store.enqueueBatch(envelope(1, 3), at)
  await store.enqueueBatch(envelope(4, 6), at)
  result.live = (await store.latestAccepted('HOST_A')).packetId
  await store.beginReplayDrain()
  await store.enqueueBatch(envelope(7, 9), at)
  result.beforeReplay = []
  for (let i = 0; i < 6; i++) {
    const r = await store.claimNext()
    assert.ok(r)
    result.beforeReplay.push(r.packet_id)
    await store.markProcessed(r.id, r.lease_token)
  }
  assert.equal(await store.claimNext(), null, 'Yield at finite pre-replay fence')
  result.afterFence = []
  for (let i = 0; i < 3; i++) {
    const r = await store.claimNext()
    result.afterFence.push(r.packet_id)
    await store.markProcessed(r.id, r.lease_token)
  }
  assert.deepEqual(result.afterFence, [9, 7, 8])
  await store.markHistoryDirty('2026-07-16T17:00:02Z')
  result.midnight = stripDirty(await store.listReplayDirty())
  await store.clearHistoryDirty()
  const generation = (await store.markHistoryDirty('2026-07-17T10:00:00Z'))[0]
  await store.beginCalculatedReplay(generation)
  await store.markReplayDirtyRange('2026-07-17T10:00:05Z', '2026-07-17T10:00:10Z', 'rtk')
  await store.finishCalculatedReplay({
    clearHistoryDirty: true,
    farmDay: generation.farmDay,
    throughVersion: generation.version,
  })
  result.dirtySurvived = stripDirty(await store.listReplayDirty())
  assert.equal(result.dirtySurvived[0].version, 2)
  result.windowBefore = await store.isReplayWindowReady(await store.nextReplayDirty())
  await store.noteProcessedTimestamp('2026-07-17T11:00:00Z')
  await store.noteProcessedTimestamp('2026-07-17T09:00:00Z')
  result.highWater = await store.processedHighWaterTimestamp()
  result.windowAfter = await store.isReplayWindowReady(await store.nextReplayDirty())
  await store.clearHistoryDirty()
  await store.enqueueBatch(envelope(10, 12), at)
  await store.beginCalculatedReplay()
  await store.finishCalculatedReplay()
  await store.enqueueBatch(envelope(13, 15), at)
  result.afterReplay = []
  for (let i = 0; i < 3; i++) {
    const r = await store.claimNext()
    result.afterReplay.push(r.packet_id)
    await store.markProcessed(r.id, r.lease_token)
  }
  assert.equal(await store.claimNext(), null, 'Yield while expanding post-replay fence')
  for (let i = 0; i < 3; i++) {
    const r = await store.claimNext()
    result.afterReplay.push(r.packet_id)
    await store.markProcessed(r.id, r.lease_token)
  }
  assert.equal(await store.claimNext(), null)
  assert.equal(await store.replayDrainThroughId(), null)
  result.legacy = await store.enqueueLegacy(
    { device_id: 'HOST_A', timestamp: '2026-07-17T10:31:00Z' },
    at,
  )
  result.legacyDuplicate = await store.enqueueLegacy(
    { timestamp: '2026-07-17T10:31:00Z', device_id: 'HOST_A' },
    at,
  )
  result.current = (await store.recentLiveAccepted(20, 'HOST_A')).map(({ inboxId, ...r }) => r)
  const legacy = await store.claimNext()
  await store.markProcessed(legacy.id, legacy.lease_token)
  const stats = await store.stats()
  result.stats = {
    pending: stats.pending,
    processed: stats.processed,
    pendingLive: stats.pendingLive,
    replayDirtyDayCount: stats.replayDirtyDayCount,
    catchupThroughId: stats.catchupThroughId,
  }
  return result
}
try {
  assert.equal((await pool.query("SELECT to_regclass('public.host_ingress') AS t")).rows[0].t, null)
  await pool.query(
    fs.readFileSync(new URL('../ops/stage2-host-ingress.sql', import.meta.url), 'utf8'),
  )
  assert.deepEqual(await parity(a), await parity(sqlite))
  console.log(
    'PASS SQLite parity: dedupe/current, pre/post replay fences, midnight, dirty generation, high water, legacy',
  )
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      (i % 2 ? a : b).enqueueBatch(envelope(100 + i, 100 + i, 'HOST_B', 'stream-b'), at),
    ),
  )
  assert.equal((await a.latestAccepted('HOST_B')).packetId, 129)
  const counts = (
    await pool.query(
      "SELECT count(*)::int AS n FROM host_ingress WHERE device_id='HOST_B' AND is_live=1 AND status IN ('pending','retry')",
    )
  ).rows[0]
  assert.equal(counts.n, 1, 'Concurrent live demotion is atomic')
  const claims = (
    await Promise.all(
      Array.from({ length: 35 }, (_, i) =>
        (i % 2 ? a : b).claimNext().then((row) => ({ store: i % 2 ? a : b, row })),
      ),
    )
  ).filter((x) => x.row)
  assert.equal(claims.length, 30)
  assert.equal(new Set(claims.map((x) => x.row.id)).size, 30)
  await Promise.all(claims.map(({ store, row }) => store.markProcessed(row.id, row.lease_token)))
  console.log('PASS concurrent devices, atomic live demotion and unique claims')
  await a.enqueueBatch(envelope(1, 1, 'HOST_C', 'stream-c'), at)
  const first = await a.claimNext()
  assert.equal(await b.claimNext(), null)
  await pool.query(
    "UPDATE host_ingress SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [first.id],
  )
  const reclaimed = await b.claimNext()
  assert.equal(reclaimed.id, first.id)
  assert.equal(reclaimed.attempts, 2)
  await assert.rejects(a.markProcessed(first.id, first.lease_token), IngressLeaseLostError)
  await b.markProcessed(reclaimed.id, reclaimed.lease_token)
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).markHistoryDirty('2026-07-17T10:00:00Z')),
  )
  assert.equal(
    (await a.nextReplayDirty()).version,
    20,
    'Concurrent dirty updates must not lose versions',
  )
  assert.equal(await a.clearReplayDirty('2026-07-17', 19), 0)
  assert.equal(await a.clearReplayDirty('2026-07-17', 20), 1)
  console.log('PASS expired lease fencing and concurrent dirty version preservation')
  const before = (await pool.query('SELECT count(*)::int AS n FROM host_ingress')).rows[0].n
  const broken = envelope(130, 131, 'HOST_B', 'stream-b')
  broken.packets[1].payload = undefined
  await assert.rejects(a.enqueueBatch(broken, at))
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM host_ingress')).rows[0].n, before)
  assert.equal((await a.latestAccepted('HOST_B')).packetId, 129)
  console.log('PASS failed batch insert rolls back every packet and current change')
  await a.beginCalculatedReplay()
  await a.enqueueBatch(envelope(1, 3, 'HOST_D', 'stream-d'), at)
  assert.equal(await b.recoverInterruptedReplay(), true)
  assert.equal(await b.recoverInterruptedReplay(), false)
  assert.equal(await b.replayCatchupMode(), 'post-replay')
  const recovered = []
  for (let i = 0; i < 3; i++) {
    const row = await b.claimNext()
    recovered.push(row.packet_id)
    await b.markProcessed(row.id, row.lease_token)
  }
  assert.deepEqual(recovered, [1, 2, 3])
  assert.equal(await b.claimNext(), null)
  assert.equal(await b.replayDrainThroughId(), null)
  console.log('PASS explicit interrupted replay recovery preserves chronological catch-up')
  await a.enqueueBatch(envelope(1, 1, 'HOST_E', 'stream-e'), at)
  const atomicRow = await a.claimNext()
  const beforeHighWater = await a.processedHighWaterTimestamp()
  await pool.query(`CREATE FUNCTION host_test_reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.device_id='HOST_E' AND NEW.status='processed' THEN RAISE EXCEPTION 'intentional completion failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER host_test_reject_completion BEFORE UPDATE ON host_ingress FOR EACH ROW EXECUTE FUNCTION host_test_reject_completion();`)
  await assert.rejects(
    a.completeProcessed(atomicRow, { timestamp: '2026-07-18T11:00:00Z', outOfOrder: true }),
    /intentional completion failure/,
  )
  await assert.rejects(a.completeProcessed(atomicRow, { timestamp: '2026-07-18T12:00:00Z' }), /intentional completion failure/)
  assert.equal(await a.processedHighWaterTimestamp(), beforeHighWater)
  assert.equal(await a.nextReplayDirty(), null)
  assert.equal(await a.replayDrainThroughId(), null)
  assert.equal((await a.getByDedupeKey('v1:HOST_E:stream-e:1')).status, 'processing')
  await pool.query(
    'DROP TRIGGER host_test_reject_completion ON host_ingress; DROP FUNCTION host_test_reject_completion();',
  )
  await a.completeProcessed(atomicRow, { timestamp: '2026-07-18T11:00:00Z', outOfOrder: true })
  assert.equal((await a.getByDedupeKey('v1:HOST_E:stream-e:1')).status, 'processed')
  assert.equal((await a.nextReplayDirty()).version, 1)
  const committedHigh = await a.processedHighWaterTimestamp()
  await assert.rejects(a.completeProcessed(atomicRow, { timestamp: '2026-07-19T12:00:00Z' }), IngressLeaseLostError)
  assert.equal(await a.processedHighWaterTimestamp(), committedHigh)
  console.log(
    'PASS injected completion failure rolls back high-water, dirty generation, fence and queue together',
  )
} finally {
  sqlite.close()
  fs.rmSync(temp, { recursive: true, force: true })
  await pool.end()
  await otherPool.end()
}

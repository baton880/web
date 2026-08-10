import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { CalculatedReplayScheduler } from '../src/modules/telemetry/replay-scheduler.js'
import { HostIngressStore } from '../src/modules/telemetry/host-ingress-store.js'
import { startHostIngressWorker } from '../src/modules/telemetry/host-ingress-worker.js'
import { startRtkIngressWorker } from '../src/modules/telemetry/rtk-ingress-worker.js'
import { TelemetryWriteCoordinator } from '../src/modules/telemetry/telemetry-write-coordinator.js'
import { findHistoricalRtkRange } from '../src/modules/telemetry/rtk-replay-window.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SERVER_ROOT = path.resolve(__dirname, '..')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(5)
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`)
}

function createFakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

async function testReplayWaitsForActiveWritersAndCoalescesRequests() {
  const coordinator = new TelemetryWriteCoordinator()
  const children = []
  let replaySuccesses = 0
  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 10,
    bufferQuietDebounceMs: 10,
    drainTimeoutMs: 500,
    failureBackoffMs: 1000,
    onReplaySuccess: () => { replaySuccesses += 1 },
    spawnProcess: () => {
      const child = createFakeChild()
      children.push(child)
      return child
    }
  })

  const hostLease = coordinator.tryAcquire('host')
  const rtkLease = coordinator.tryAcquire('rtk')
  assert.equal(rtkLease, null, 'SQLite coordinator must allow only one writer')
  for (let index = 0; index < 100; index += 1) {
    scheduler.schedule('host-buffer-out-of-order', { farmDay: '2026-07-23', index }, 10)
  }

  await waitFor(() => scheduler.getStatus().state === 'draining')
  assert.equal(children.length, 0)
  assert.equal(coordinator.tryAcquire('host'), null)

  hostLease.release()
  await waitFor(() => children.length === 1)
  assert.equal(scheduler.getStatus().state, 'running')
  children[0].emit('close', 0, null)
  await waitFor(() => scheduler.getStatus().state === 'idle')
  assert.equal(replaySuccesses, 1)
  assert.equal(coordinator.snapshot().accepting, true)
  assert.equal(children.length, 1)

  scheduler.schedule('another-buffer-burst', { farmDay: '2026-07-24' }, 10)
  await waitFor(() => children.length === 2)
  children[1].emit('close', 1, null)
  await waitFor(() => scheduler.getStatus().state === 'backoff')
  assert.equal(replaySuccesses, 1, 'failed replay must not clear the dirty marker')
  assert.equal(scheduler.getStatus().queued, true)
  assert.equal(coordinator.snapshot().accepting, true)
  scheduler.stop()
}

async function testFarmDayReplayEnvironmentIsBounded() {
  const coordinator = new TelemetryWriteCoordinator()
  let spawnCall = null
  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 10,
    maxQueueWaitMs: 50,
    drainTimeoutMs: 500,
    spawnProcess: (command, args, options) => {
      spawnCall = { command, args, options }
      return createFakeChild()
    }
  })

  scheduler.schedule('host-ingress-history', {
    farmDay: '2026-07-23',
    dirtyFrom: '2026-07-23T05:50:00.000Z',
    dirtyTo: '2026-07-23T06:10:00.000Z',
    version: 4
  }, 10)
  await waitFor(() => spawnCall)
  assert.equal(spawnCall.options.env.REPLAY_DAY, '2026-07-23')
  assert.equal(spawnCall.options.env.REPLAY_DIRTY_FROM, '2026-07-23T05:50:00.000Z')
  assert.equal(spawnCall.options.env.REPLAY_DIRTY_TO, '2026-07-23T06:10:00.000Z')
  scheduler.stop()
}

async function testAutomaticReplayRejectsUnboundedScope() {
  const coordinator = new TelemetryWriteCoordinator()
  let spawnCount = 0
  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 5,
    spawnProcess: () => {
      spawnCount += 1
      return createFakeChild()
    }
  })

  const missing = scheduler.schedule('host-ingress-history', {}, 5)
  const invalid = scheduler.schedule('rtk-history', { farmDay: 'not-a-date' }, 5)
  await delay(25)
  assert.equal(missing.scheduled, false)
  assert.equal(missing.invalidScope, true)
  assert.equal(invalid.scheduled, false)
  assert.equal(invalid.invalidScope, true)
  assert.equal(spawnCount, 0, 'background scheduler must never fall back to a global replay')
  scheduler.stop()
}

async function testReplayReadinessFailureKeepsWorkQueued() {
  const coordinator = new TelemetryWriteCoordinator()
  let spawnCount = 0
  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 5,
    bufferDrainedDebounceMs: 20,
    replayReady: () => { throw new Error('ingress metadata unavailable') },
    spawnProcess: () => {
      spawnCount += 1
      return createFakeChild()
    }
  })

  scheduler.schedule('host-ingress-history', { farmDay: '2026-07-23' }, 5)
  await waitFor(() => scheduler.getStatus().lastError?.includes('ingress metadata unavailable'))
  assert.equal(scheduler.getStatus().queued, true)
  assert.equal(scheduler.getStatus().state, 'idle')
  assert.equal(spawnCount, 0, 'readiness failure must not start an unsafe replay')
  assert.equal(coordinator.snapshot().accepting, true)
  scheduler.stop()
}

async function testReplayCleanupFailureKeepsDirtyWorkQueued() {
  const coordinator = new TelemetryWriteCoordinator()
  let child = null
  let failureCleanupCount = 0
  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 5,
    failureBackoffMs: 1000,
    onReplaySuccess: () => { throw new Error('ingress cleanup unavailable') },
    onReplayFailure: () => { failureCleanupCount += 1 },
    spawnProcess: () => {
      child = createFakeChild()
      return child
    }
  })

  scheduler.schedule('host-ingress-history', { farmDay: '2026-07-23' }, 5)
  await waitFor(() => child)
  child.emit('close', 0, null)
  await waitFor(() => scheduler.getStatus().state === 'backoff')
  assert.equal(failureCleanupCount, 1)
  assert.equal(scheduler.getStatus().queued, true)
  assert.equal(coordinator.snapshot().accepting, true)
  scheduler.stop()
}

async function testReplaySynchronizesProcessorStateBeforeResumingWriters() {
  const coordinator = new TelemetryWriteCoordinator()
  const imported = []
  let child = null
  let spawnEnvironment = null
  const expectedSnapshot = {
    version: 1,
    devices: [{ deviceId: 'Hozain_01', state: { isMixing: true, peakWeight: 1234 } }]
  }
  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 5,
    failureBackoffMs: 1000,
    onReplayState: (snapshot) => imported.push(snapshot),
    spawnProcess: (command, args, options) => {
      spawnEnvironment = options.env
      child = createFakeChild()
      return child
    }
  })

  scheduler.schedule('host-ingress-history', { farmDay: '2026-07-23' }, 5)
  await waitFor(() => child)
  assert.ok(spawnEnvironment.REPLAY_STATE_OUTPUT)
  fs.writeFileSync(spawnEnvironment.REPLAY_STATE_OUTPUT, JSON.stringify(expectedSnapshot))
  child.emit('close', 0, null)
  await waitFor(() => scheduler.getStatus().state === 'idle')

  assert.deepEqual(imported, [expectedSnapshot])
  assert.equal(coordinator.snapshot().accepting, true)
  assert.equal(fs.existsSync(spawnEnvironment.REPLAY_STATE_OUTPUT), false)
  scheduler.stop()
}

async function testReplayAbsorbsSameDayDirtyGenerationPublishedWhileDraining() {
  const coordinator = new TelemetryWriteCoordinator()
  const lease = coordinator.tryAcquire('host-ingress')
  const children = []
  const startedMeta = []
  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 5,
    drainTimeoutMs: 500,
    onReplayStart: ({ meta }) => startedMeta.push(meta),
    spawnProcess: () => {
      const child = createFakeChild()
      children.push(child)
      return child
    }
  })

  scheduler.schedule('host-ingress-history', { farmDay: '2026-07-23', version: 1 }, 5)
  await waitFor(() => scheduler.getStatus().state === 'draining')
  scheduler.schedule('host-ingress-history', { farmDay: '2026-07-23', version: 2 }, 5)
  lease.release()
  await waitFor(() => children.length === 1)
  assert.equal(startedMeta[0].version, 2)
  children[0].emit('close', 0, null)
  await waitFor(() => scheduler.getStatus().state === 'idle')
  await delay(25)
  assert.equal(children.length, 1, 'same-day work committed before writer drain must be covered by the current replay')
  assert.equal(scheduler.getStatus().queued, false)
  scheduler.stop()
}

async function testBufferedHistoryDrainsToFiniteFenceBeforeSingleReplay() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-pre-replay-drain-'))
  const store = new HostIngressStore(path.join(tempDir, 'host-ingress.sqlite3'))
  const coordinator = new TelemetryWriteCoordinator()
  const children = []
  const processedPacketIds = []
  let latestStoredTimestampMs = new Date('2026-07-26T01:00:00Z').getTime()

  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 5,
    bufferQuietDebounceMs: 5,
    drainTimeoutMs: 500,
    failureBackoffMs: 1000,
    replayReady: () => !store.replayDrainThroughId() && store.isReplayWindowReady(),
    onReplayStart: ({ meta }) => store.beginCalculatedReplay(meta),
    onReplaySuccess: ({ meta }) => store.finishCalculatedReplay({
      clearHistoryDirty: true,
      farmDay: meta.farmDay,
      throughVersion: meta.version
    }),
    onReplayFailure: () => store.finishCalculatedReplay({ clearHistoryDirty: false }),
    spawnProcess: () => {
      const child = createFakeChild()
      children.push(child)
      return child
    }
  })

  const worker = startHostIngressWorker(async (body) => {
    const timestampMs = new Date(body.timestamp).getTime()
    const outOfOrder = timestampMs < latestStoredTimestampMs
    latestStoredTimestampMs = Math.max(latestStoredTimestampMs, timestampMs)
    processedPacketIds.push(body.packetId)
    if (body.packetId === 1) {
      store.enqueueBatch({
        deviceId: 'Hozain_01',
        streamId: 'buffered-stream',
        livePacketId: 8,
        packets: [
          { packetId: 5, payload: { packetId: 5, timestamp: '2026-07-26T00:59:54Z' } },
          { packetId: 6, payload: { packetId: 6, timestamp: '2026-07-26T00:59:56Z' } },
          { packetId: 7, payload: { packetId: 7, timestamp: '2026-07-26T00:59:58Z' } },
          { packetId: 8, payload: { packetId: 8, timestamp: '2026-07-26T01:00:00Z' } }
        ]
      })
    }
    return { outOfOrder, timestamp: body.timestamp }
  }, {
    store,
    pollMs: 5,
    writeCoordinator: coordinator,
    scheduleReplay: (reason, meta, options = {}) => scheduler.schedule(
      reason,
      meta,
      options.bufferDrained ? scheduler.bufferDrainedDebounceMs : scheduler.bufferQuietDebounceMs
    )
  })

  try {
    store.enqueueBatch({
      deviceId: 'Hozain_01',
      streamId: 'buffered-stream',
      livePacketId: 4,
      packets: [
        { packetId: 1, payload: { packetId: 1, timestamp: '2026-07-26T01:00:02Z' } },
        { packetId: 2, payload: { packetId: 2, timestamp: '2026-07-26T01:00:04Z' } },
        { packetId: 3, payload: { packetId: 3, timestamp: '2026-07-26T01:00:06Z' } },
        { packetId: 4, payload: { packetId: 4, timestamp: '2026-07-26T01:00:08Z' } }
      ]
    })

    await waitFor(() => processedPacketIds.length === 8)
    assert.deepEqual(
      processedPacketIds,
      [4, 1, 2, 3, 5, 6, 7, 8],
      'finite pre-replay fence must expand across a multi-request buffered generation'
    )
    assert.equal(store.stats().pending, 0)
    assert.equal(children.length, 0, 'replay must wait for ten minutes of future source context')

    store.enqueueBatch({
      deviceId: 'Hozain_01',
      streamId: 'buffered-stream',
      livePacketId: 9,
      packets: [
        { packetId: 9, payload: { packetId: 9, timestamp: '2026-07-26T01:20:06Z' } }
      ]
    })
    await waitFor(() => children.length === 1)

    store.enqueueBatch({
      deviceId: 'Hozain_01',
      streamId: 'buffered-stream',
      livePacketId: 13,
      packets: [
        { packetId: 10, payload: { packetId: 10, timestamp: '2026-07-26T01:20:08Z' } },
        { packetId: 11, payload: { packetId: 11, timestamp: '2026-07-26T01:20:10Z' } },
        { packetId: 12, payload: { packetId: 12, timestamp: '2026-07-26T01:20:12Z' } },
        { packetId: 13, payload: { packetId: 13, timestamp: '2026-07-26T01:20:14Z' } }
      ]
    })
    children[0].emit('close', 0, null)
    await waitFor(() => processedPacketIds.length === 13)
    await delay(50)

    assert.deepEqual(processedPacketIds.slice(8), [9, 10, 11, 12, 13])
    assert.equal(store.stats().historyDirtyFrom, null)
    assert.equal(children.length, 1, 'post-replay catch-up must not create a second replay')
  } finally {
    worker.stop()
    scheduler.stop()
    store.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function testRtkReplayRequiresActuallyHistoricalPackets() {
  const latest = new Date('2026-07-23T10:00:00Z')
  assert.equal(findHistoricalRtkRange([
    { timestamp: '2026-07-23T10:00:01Z' },
    { timestamp: '2026-07-23T10:00:02Z' }
  ], latest), null, 'sequential RTK catch-up must not request replay')
  assert.deepEqual(findHistoricalRtkRange([
    { timestamp: '2026-07-23T09:59:55Z' },
    { timestamp: '2026-07-23T10:00:01Z' },
    { timestamp: '2026-07-23T09:59:50Z' }
  ], latest), {
    from: new Date('2026-07-23T09:59:50Z'),
    to: new Date('2026-07-23T09:59:55Z')
  })
  const perDevice = new Map([
    ['loader-a', new Date('2026-07-23T10:00:00Z')],
    ['loader-b', new Date('2026-07-23T09:00:00Z')]
  ])
  assert.equal(findHistoricalRtkRange([
    { deviceId: 'loader-b', timestamp: '2026-07-23T09:30:00Z' }
  ], perDevice), null, 'another device high-water mark must not cause a false replay')
  assert.deepEqual(findHistoricalRtkRange([
    { deviceId: 'loader-a', timestamp: '2026-07-23T09:59:59Z' }
  ], perDevice), {
    from: new Date('2026-07-23T09:59:59Z'),
    to: new Date('2026-07-23T09:59:59Z')
  }, 'a single genuinely historical RTK packet must dirty its farm day')
}

async function testRtkWorkerHonorsCoordinatorPauseAndResumes() {
  const coordinator = new TelemetryWriteCoordinator()
  const rows = [
    { id: 1, raw_body: '{"id":1}', received_at: new Date().toISOString(), attempts: 1 },
    { id: 2, raw_body: '{"id":2}', received_at: new Date().toISOString(), attempts: 1 }
  ]
  const processed = []
  let claims = 0
  let releaseFirst
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve })
  const store = {
    cleanup() {},
    claimNext() {
      claims += 1
      return rows.shift() || null
    },
    markProcessed(id) { processed.push(id) },
    markPermanent() {},
    markRetry(id, error) { throw new Error(`Unexpected retry for ${id}: ${error}`) }
  }

  const worker = startRtkIngressWorker(async (body) => {
    if (body.id === 1) await firstBlocked
    return { received: 1, accepted: 1, dropped: 0 }
  }, {
    store,
    pollMs: 5,
    writeCoordinator: coordinator,
    recordResult: async () => {},
    recordMalformed: async () => {}
  })

  await waitFor(() => claims === 1)
  coordinator.pause('test-replay')
  const drainPromise = coordinator.waitForIdle(500)
  await delay(25)
  assert.equal(claims, 1)
  assert.deepEqual(processed, [])

  releaseFirst()
  assert.equal(await drainPromise, true)
  coordinator.resume()
  await waitFor(() => processed.length === 2)
  worker.stop()
  assert.deepEqual(processed, [1, 2])
}

async function testHostPacketsAcceptedDuringReplayDoNotScheduleAnotherReplay() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-replay-catchup-'))
  const store = new HostIngressStore(path.join(tempDir, 'host-ingress.sqlite3'))
  const coordinator = new TelemetryWriteCoordinator()
  const children = []
  const processedPacketIds = []
  let latestStoredTimestampMs = new Date('2026-07-26T01:00:00Z').getTime()
  let currentPacketId = null

  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 10,
    bufferQuietDebounceMs: 10,
    bufferDrainedDebounceMs: 10,
    drainTimeoutMs: 500,
    failureBackoffMs: 1000,
    onReplayStart: () => store.beginCalculatedReplay(),
    onReplaySuccess: ({ meta }) => store.finishCalculatedReplay({
      clearHistoryDirty: true,
      farmDay: meta.farmDay,
      throughVersion: meta.version
    }),
    onReplayFailure: () => store.finishCalculatedReplay({ clearHistoryDirty: false }),
    spawnProcess: () => {
      const child = createFakeChild()
      children.push(child)
      return child
    }
  })

  const worker = startHostIngressWorker(async (body, receivedAt, identity) => {
    const timestampMs = new Date(body.timestamp).getTime()
    const outOfOrder = timestampMs < latestStoredTimestampMs
    latestStoredTimestampMs = Math.max(latestStoredTimestampMs, timestampMs)
    processedPacketIds.push(identity.packetId)
    if (identity.isLive) currentPacketId = identity.packetId
    await delay(20)
    return { outOfOrder, timestamp: body.timestamp }
  }, {
    store,
    pollMs: 25,
    writeCoordinator: coordinator,
    scheduleReplay: (reason, meta, options = {}) => scheduler.schedule(
      reason,
      meta,
      options.bufferDrained ? scheduler.bufferDrainedDebounceMs : scheduler.bufferQuietDebounceMs
    )
  })

  try {
    scheduler.schedule('host-ingress-history', {
      farmDay: '2026-07-26',
      dirtyFrom: '2026-07-26T00:50:00.000Z',
      dirtyTo: '2026-07-26T01:10:00.000Z',
      version: 1
    }, 10)
    await waitFor(() => children.length === 1)
    assert.equal(scheduler.getStatus().state, 'running')

    store.enqueueBatch({
      deviceId: 'Hozain_01',
      streamId: 'stream-replay-catchup',
      livePacketId: 4,
      packets: [
        { packetId: 1, payload: { timestamp: '2026-07-26T01:00:02Z' } },
        { packetId: 2, payload: { timestamp: '2026-07-26T01:00:04Z' } },
        { packetId: 3, payload: { timestamp: '2026-07-26T01:00:06Z' } },
        { packetId: 4, payload: { timestamp: '2026-07-26T01:00:08Z' } }
      ]
    })
    assert.equal(store.stats().pending, 4)

    children[0].emit('close', 0, null)
    await waitFor(() => processedPacketIds.length === 1)
    store.enqueueBatch({
      deviceId: 'Hozain_01',
      streamId: 'stream-replay-catchup',
      livePacketId: 5,
      packets: [
        { packetId: 5, payload: { timestamp: '2026-07-26T01:00:10Z' } }
      ]
    })
    store.enqueueBatch({
      deviceId: 'Hozain_01',
      streamId: 'stream-replay-catchup',
      livePacketId: 6,
      packets: [
        { packetId: 6, payload: { timestamp: '2026-07-26T01:00:12Z' } }
      ]
    })

    await waitFor(() => processedPacketIds.length === 6)
    await delay(100)

    assert.deepEqual(
      processedPacketIds,
      [1, 2, 3, 4, 5, 6],
      'post-replay fence must expand to the live edge without letting newest-live jump over history'
    )
    assert.equal(currentPacketId, 6, 'the newest accepted live packet must remain current')
    assert.equal(store.stats().historyDirtyFrom, null)
    assert.equal(children.length, 1, 'synthetic replay catch-up must not schedule a second replay')
  } finally {
    worker.stop()
    scheduler.stop()
    store.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function prismaFileUrl(databasePath) {
  return `file:${databasePath.replace(/\\/g, '/')}`
}

function testReplayRollbackAfterForcedFailure() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-atomicity-'))
  const databasePath = path.join(tempDir, 'atomicity.sqlite3')
  const databaseUrl = prismaFileUrl(databasePath)
  const sourceDatabasePath = path.join(SERVER_ROOT, 'prisma', 'dev.db')

  try {
    if (!fs.existsSync(sourceDatabasePath)) {
      console.warn('Replay rollback integration test skipped: prisma/dev.db fixture is unavailable')
      return
    }
    fs.copyFileSync(sourceDatabasePath, databasePath)

    let database = new Database(databasePath)
    database.prepare(`
      INSERT INTO Batch (deviceId, startTime, startWeight, hasViolations)
      VALUES ('rollback-sentinel', ?, 0, 0)
    `).run(Date.now())
    database.close()

    const replay = spawnSync(process.execPath, ['scripts/replay-batches-from-telemetry.mjs'], {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REPLAY_FAIL_AFTER_RESET: '1',
        REPLAY_TRANSACTION_TIMEOUT_MS: '60000'
      },
      encoding: 'utf8'
    })
    assert.notEqual(replay.status, 0, 'Forced replay failure unexpectedly succeeded')
    assert.match(replay.stderr, /Forced replay failure after calculated-table reset/)

    database = new Database(databasePath, { readonly: true })
    const sentinel = database.prepare("SELECT deviceId FROM Batch WHERE deviceId = 'rollback-sentinel'").get()
    const integrity = database.pragma('integrity_check', { simple: true })
    database.close()
    assert.equal(sentinel?.deviceId, 'rollback-sentinel')
    assert.equal(integrity, 'ok')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

await testReplayWaitsForActiveWritersAndCoalescesRequests()
await testFarmDayReplayEnvironmentIsBounded()
await testAutomaticReplayRejectsUnboundedScope()
await testReplayReadinessFailureKeepsWorkQueued()
await testReplayCleanupFailureKeepsDirtyWorkQueued()
await testReplaySynchronizesProcessorStateBeforeResumingWriters()
await testReplayAbsorbsSameDayDirtyGenerationPublishedWhileDraining()
await testBufferedHistoryDrainsToFiniteFenceBeforeSingleReplay()
testRtkReplayRequiresActuallyHistoricalPackets()
await testRtkWorkerHonorsCoordinatorPauseAndResumes()
await testHostPacketsAcceptedDuringReplayDoNotScheduleAnotherReplay()
testReplayRollbackAfterForcedFailure()
console.log('Replay safety tests passed')

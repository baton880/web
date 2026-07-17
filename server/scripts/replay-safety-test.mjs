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
import { startRtkIngressWorker } from '../src/modules/telemetry/rtk-ingress-worker.js'
import { TelemetryWriteCoordinator } from '../src/modules/telemetry/telemetry-write-coordinator.js'

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
  const scheduler = new CalculatedReplayScheduler({
    coordinator,
    replayDebounceMs: 10,
    bufferQuietDebounceMs: 10,
    drainTimeoutMs: 500,
    failureBackoffMs: 1000,
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
    scheduler.schedule('host-buffer-out-of-order', { index }, 10)
  }

  await waitFor(() => scheduler.getStatus().state === 'draining')
  assert.equal(children.length, 0)
  assert.equal(coordinator.tryAcquire('host'), null)

  hostLease.release()
  await waitFor(() => children.length === 1)
  assert.equal(scheduler.getStatus().state, 'running')
  children[0].emit('close', 0, null)
  await waitFor(() => scheduler.getStatus().state === 'idle')
  assert.equal(coordinator.snapshot().accepting, true)
  assert.equal(children.length, 1)

  scheduler.schedule('another-buffer-burst', {}, 10)
  await waitFor(() => children.length === 2)
  children[1].emit('close', 1, null)
  await waitFor(() => scheduler.getStatus().state === 'backoff')
  assert.equal(scheduler.getStatus().queued, true)
  assert.equal(coordinator.snapshot().accepting, true)
  scheduler.stop()
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
await testRtkWorkerHonorsCoordinatorPauseAndResumes()
testReplayRollbackAfterForcedFailure()
console.log('Replay safety tests passed')

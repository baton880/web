import assert from 'node:assert/strict'
import { CalculatedReplayScheduler } from '../src/modules/telemetry/replay-scheduler.js'
import { TelemetryWriteCoordinator } from '../src/modules/telemetry/telemetry-write-coordinator.js'
let releaseReady, releaseCleanup
const ready = new Promise(resolve => { releaseReady = resolve })
const cleanup = new Promise(resolve => { releaseCleanup = resolve })
const events = [], coordinator = new TelemetryWriteCoordinator()
const scheduler = new CalculatedReplayScheduler({ coordinator, setTimer: () => ({ unref() {} }), clearTimer: () => {},
  replayReady: async () => { events.push('ready'); return ready },
  onReplayStart: async () => { events.push('start'); return { meta: { farmDay: '2026-09-18', version: 2 } } },
  onReplaySuccess: async ({ meta }) => { assert.equal(meta.version, 2); events.push('cleanup'); await cleanup; events.push('cleaned') } })
scheduler.runReplayProcess = async () => { events.push('process'); return { ok: true, code: 0 } }
scheduler.schedule('async-test', { farmDay: '2026-09-18', version: 1 }, 1000)
const first = scheduler.startQueuedReplay()
await scheduler.startQueuedReplay()
assert.deepEqual(events, ['ready'], 'Only one asynchronous readiness check may start')
releaseReady(true)
while (!events.includes('cleanup')) await new Promise(resolve => setImmediate(resolve))
assert.equal(coordinator.accepting, false, 'Writers must stay paused until asynchronous cleanup commits')
releaseCleanup(); await first
assert.equal(coordinator.accepting, true)
assert.deepEqual(events, ['ready','start','process','cleanup','cleaned'])
scheduler.stop()
const rejected = new CalculatedReplayScheduler({ coordinator, setTimer: () => ({ unref() {} }), clearTimer: () => {}, replayReady: async () => { throw Error('intentional async readiness failure') } })
rejected.schedule('failure',{farmDay:'2026-09-18'},1000); await rejected.startQueuedReplay()
assert.equal(rejected.queued,true); assert.equal(coordinator.accepting,true); rejected.stop()
console.log('PASS asynchronous replay readiness, exclusive start, hooks and writer pause until commit')

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { LoaderTaskStore } from '../src/modules/loader/loader-task-store.js'

const store = new LoaderTaskStore(':memory:')
const actor = { id: 1, role: 'DIRECTOR' }
const plan = { groupId: 1, planRevision: 'test', steps: [{ name: 'A', targetKg: 100 }, { name: 'B', targetKg: 50 }] }
let task = store.create({ id: randomUUID(), deviceId: 'host', groupId: 1, planRevision: 'test' }, plan, actor)
let at = Date.now() - 10000
const event = (type, kg, extra = {}) => ({ id: randomUUID(), type, revision: task.revision, stepIndex: task.currentIndex,
  explicitStepStart: true, at: ++at, reading: { valid: true, deviceId: 'host', timestampMs: at, weightKg: kg, calibrationId: 'cal' }, ...extra })
const apply = e => { task = store.apply(task.id, e, actor).task }
apply(event('begin', 500))
assert.throws(() => apply(event('begin', 550)), /уже начат/)
apply(event('confirm', 600))
assert.equal(task.steps[1].baseline, undefined)
assert.throws(() => apply(event('confirm', 900)), /Начать загрузку/)
apply(event('undo', 600))
assert.equal(task.steps[0].baseline.weightKg, 500)
apply(event('confirm', 600))
const waiting = store.get(task.id, actor)
assert.equal(waiting.explicitStepStart, true)
assert.equal(waiting.steps[1].baseline, undefined)
assert.throws(() => apply(event('begin', 900, { stepIndex: 0 })), /изменился/)
const begin = event('begin', 900)
apply(begin); apply(begin) // ACK replay must not reset baseline or duplicate the event.
assert.equal(task.steps[1].baseline.weightKg, 900)
apply(event('confirm', 950))
assert.equal(task.status, 'completed')
assert.deepEqual(task.steps.map(s => s.actualKg), [100, 50])
store.close()
console.log('PASS: explicit component start, waiting, undo, persistence, duplicate replay, uncounted inter-component weight')

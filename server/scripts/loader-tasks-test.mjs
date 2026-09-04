import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { LoaderTaskStore } from '../src/modules/loader/loader-task-store.js'
import { buildLoaderPlan } from '../src/modules/loader/loader-plan.js'
import { createLoaderRouter } from '../src/modules/loader/loader.routes.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-tasks-test-'))
const filename = path.join(dir, 'tasks.sqlite3')
let store = new LoaderTaskStore(filename)
const actor = { id: 1, role: 'DIRECTOR' }
const group = { id: 1, name: 'Group', headcount: 10, ration: { id: 2, name: 'Ration', feedingsPerDay: 2,
  ingredients: [{ id: 1, name: 'Silage', sortOrder: 1, plannedWeight: 20 },
    { id: 2, name: 'Mix', sortOrder: 2, plannedWeight: 10, isCompound: true, componentsJson: '[{"name":"A","plannedWeight":2},{"name":"B","plannedWeight":3}]' }] } }
const plan = buildLoaderPlan(group)
assert.deepEqual(plan.steps.map(s => s.targetKg), [100, 20, 30])
assert.equal(plan.totalKg, 150)
const body = { id: randomUUID(), deviceId: 'host', groupId: 1, planRevision: plan.planRevision }
let task = store.create(body, plan, actor)
assert.deepEqual(store.create(body, plan, actor), task)
assert.throws(() => store.create({ ...body, id: randomUUID() }, plan, actor), /незавершённое/)
const now = Date.now() - 10000
let n = 0
function event(type, weight = 0, extra = {}) {
  const at = now + ++n * 100
  return { id: randomUUID(), type, revision: task.revision, stepIndex: task.currentIndex, at,
    reading: { weightKg: weight, timestampMs: at, deviceId: 'host', valid: true, packetId: String(n) }, ...extra }
}
const begin = event('begin', 500)
task = store.apply(task.id, begin, actor).task
assert.equal(task.steps[0].baseline.weightKg, 500)
const confirm = event('confirm', 600)
task = store.apply(task.id, confirm, actor).task
assert.equal(task.currentIndex, 1)
assert.deepEqual(store.apply(task.id, confirm, actor).task, task)
assert.throws(() => store.apply(task.id, { ...confirm, reading: { ...confirm.reading, weightKg: 605 } }, actor), /другим содержимым/)
assert.throws(() => store.apply(task.id, event('undo', 650), actor), /уже загружается/)
task = store.apply(task.id, event('undo', 600), actor).task
assert.equal(task.currentIndex, 0)
task = store.apply(task.id, event('confirm', 605), actor).task
task = store.apply(task.id, event('confirm', 625), actor).task
task = store.apply(task.id, event('confirm', 655), actor).task
assert.equal(task.status, 'completed')
assert.equal(task.steps.reduce((s, step) => s + step.actualKg, 0), 155)
assert.throws(() => store.get(task.id, { id: 2, role: 'DIRECTOR' }), /другого оператора/)
const before = store.events(task.id, actor)
store.close(); store = new LoaderTaskStore(filename)
assert.deepEqual(store.get(task.id, actor), task)
assert.deepEqual(store.events(task.id, actor), before)

const app = express().use(express.json()).use((req, res, next) => { req.user = req.headers['x-guest'] ? { id: 3, role: 'GUEST' } : actor; next() })
const prisma = { livestockGroup: { findMany: async () => [group], findUnique: async () => group } }
app.use('/api/loader', createLoaderRouter({ prisma, store }))
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/loader`
async function post(url, value, headers = {}) { return fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) }) }
try {
  assert.equal((await (await fetch(base + '/groups')).json()).groups[0].plan.totalKg, 150)
  const newBody = { ...body, id: randomUUID() }
  assert.equal((await post('/tasks', newBody, { 'x-guest': '1' })).status, 403)
  assert.equal((await post('/tasks', { ...newBody, planRevision: 'changed' })).status, 409)
  const created = await (await post('/tasks', newBody)).json()
  group.ration.ingredients[0].plannedWeight = 999
  assert.deepEqual((await (await post('/tasks', newBody)).json()).task, created.task, 'Retry preserves original plan after ration edit')
  assert.equal(created.task.steps[0].targetKg, 100)
  const badEvent = { id: randomUUID(), revision: 0, type: 'begin', at: Date.now(), reading: { weightKg: 0, valid: false, timestampMs: Date.now(), deviceId: 'host' } }
  assert.equal((await post(`/tasks/${newBody.id}/events`, badEvent)).status, 400)
  assert.equal(store.get(newBody.id, actor).revision, 0, 'Rejected event does not mutate task')
  assert.equal(store.events(newBody.id, actor).length, 0)
  console.log('PASS: plan/compound rounding, task isolation, idempotency, immutable plan, events, undo, authorization, atomic rejection, reopen, HTTP API')
  console.log('Test journal:', filename)
} finally { server.close(); store.close() }

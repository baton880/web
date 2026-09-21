import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { LoaderTaskStore } from '../src/modules/loader/loader-task-store.js'
import { createLoaderRouter } from '../src/modules/loader/loader.routes.js'
import { scaleMeasurement } from '../src/modules/loader/scale-measurement.js'

const actor = { id: 1, role: 'DIRECTOR', terminalId: randomUUID(), terminalDeviceId: 'host' }
let group = { id: 1, name: 'Group', headcount: 10, ration: { id: 2, name: 'Ration', isActive: true, feedingsPerDay: 1,
  ingredients: [{ id: 1, name: 'Feed', sortOrder: 1, plannedWeight: 10 }] } }
const prisma = { livestockGroup: { findMany: async () => group ? [group] : [], findUnique: async () => group } }
const store = new LoaderTaskStore(':memory:')
const app = express().use(express.json()).use((req, res, next) => { req.user = { ...actor,
  ...(req.headers['x-other-terminal'] ? { terminalId: randomUUID() } : {}) }; next() })
app.use(createLoaderRouter({ prisma, store, offlineKey: 'isolated-test-signing-key' }))
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const url = `http://127.0.0.1:${server.address().port}`
const post = (path, body, headers={}) => fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
try {
  const plan = (await (await fetch(url+'/groups')).json()).groups[0].plan
  assert.ok(plan.offlineToken)
  group = null // Ration was deleted while tablet was offline.
  for (let index=0;index<2;index++) {
    const body = { id: randomUUID(), deviceId:'host', groupId:1, planRevision:plan.planRevision, offlineToken:plan.offlineToken }
    assert.equal((await post('/tasks',body,{'x-other-terminal':'1'})).status,403)
    assert.equal((await post('/tasks',{...body,offlineToken:plan.offlineToken+'x'})).status,403)
    assert.equal((await post('/tasks',{...body,groupId:2})).status,400)
    const response=await post('/tasks',body)
    assert.equal(response.status,201)
    const task=(await response.json()).task
    assert.equal(task.totalKg,100)
    assert.equal((await post('/tasks',body)).status,200)
    const at=Date.now()-10000
    const reading=(kg,revision,calibrationId='cal1')=>({weightKg:kg,timestampMs:at+revision*500,packetId:'boot:'+revision,deviceId:'host',valid:true,calibrationId})
    const begin={id:randomUUID(),type:'begin',revision:0,stepIndex:0,at,reading:reading(500,0)}
    assert.equal((await post(`/tasks/${task.id}/events`,begin)).status,200)
    const confirm={id:randomUUID(),type:'confirm',revision:1,stepIndex:0,at:at+500,reading:reading(600,1,'cal2')}
    assert.equal((await post(`/tasks/${task.id}/events`,confirm)).status,409)
    confirm.reading=reading(600,1)
    const done=await (await post(`/tasks/${task.id}/events`,confirm)).json()
    assert.equal(done.task.status,'completed')
    assert.equal(done.task.steps[0].actualKg,100)
    assert.equal((await post(`/tasks/${task.id}/events`,confirm)).status,200)
  }
  const packet={version:1,deviceId:'host',packetId:'boot:2',calibrationId:'cal1',timestampMs:Date.now()-100000,weightKg:123.5,valid:true}
  const result=scaleMeasurement({deviceId:'host',rawPayload:JSON.stringify({scale_measurement:packet})})
  assert.deepEqual(result,packet,'No retimestamp, rounding, tare or server filter')
  assert.equal(scaleMeasurement({deviceId:'other',rawPayload:JSON.stringify({scale_measurement:packet})}),null)
  assert.equal(scaleMeasurement({deviceId:'host',rawPayload:'broken'}),null)
  assert.equal(scaleMeasurement({deviceId:'host',rawPayload:{scale_measurement:{...packet,valid:false}}}).valid,false)
  console.log('PASS: two offline jobs after ration deletion, signatures, terminal isolation, retry, calibration mismatch, canonical scale weight')
} finally { server.close(); store.close() }

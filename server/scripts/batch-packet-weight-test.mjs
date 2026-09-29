import assert from 'node:assert/strict'
import { buildFilteredWeightPoints, detectWeightStepMarkup } from '../src/modules/batches/weight-step-postprocess.js'
import { buildTabletMarkers } from '../src/modules/batches/tablet-markers.js'
import { TelemetryProcessor } from '../../module-3/telemetryProcessor.js'

const start = Date.parse('2026-09-29T03:00:00Z')
const rows = Array.from({length: 240}, (_,i) => ({ id:i, timestamp:new Date(start+i*1000),
  weight:i<90?0:500, rawWeight:i<20?100:-9000, weightValid:true, speedKmh:0 }))
const points = buildFilteredWeightPoints(rows,{weightScale:1.048})
assert.equal(points.length,rows.length,'raw plunge cannot truncate ordinary weight')
assert.equal(points.at(-1).filtered,500,'no repeated calibration')
assert.equal(buildFilteredWeightPoints([{timestamp:new Date(),weight:null,rawWeight:100}]).length,0)
const result = detectWeightStepMarkup({startTime:rows[0].timestamp,endTime:rows.at(-1).timestamp},rows,{boundaryMinExtendMs:0})
assert.equal(result.status,'complete')
assert.ok(result.includedEvents.some(e=>e.delta===500),'loading must survive a raw plunge')
assert.deepEqual(TelemetryProcessor.prototype._resolveProcessingWeight.call({_parsePacketBoolean:v=>v},{weight:500,rawWeight:-9000,weightValid:true}),{usable:true,value:500,source:'normal'})
assert.equal(TelemetryProcessor.prototype._resolveProcessingWeight.call({_parsePacketBoolean:v=>v},{weight:500,rawWeight:600,weightValid:false}).usable,false)

const tasks=[{id:'task',state:JSON.stringify({steps:[{name:'Солома'},{name:'Силос'}]})}]
const event=(id,type,at,stepIndex)=>({taskId:'task',payload:JSON.stringify({id,type,at,stepIndex,receivedAt:at+99999})})
const markers=buildTabletMarkers(tasks,[event('a','begin',start,0),event('b','confirm',start+1000,0),event('c','begin',start+2000,1)],start,start+5000)
assert.equal(markers.length,3)
assert.equal(markers[0].timestamp,new Date(start).toISOString())
assert.equal(markers[2].label,'Начало: Силос')
assert.equal(buildTabletMarkers(tasks,[event('a','begin',start,0)],start+1,start+5000).length,0)
console.log('PASS batch packet-weight regression, FSM source, null handling, tablet button timestamps')

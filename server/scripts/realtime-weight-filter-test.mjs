import assert from 'node:assert/strict'
import {filterRealtimeWeightSeries} from '../src/modules/telemetry/realtime-weight-filter.js'
const result = filterRealtimeWeightSeries([100,105,550,null,0].map((weight,index)=>({timestamp:new Date(1000*(index+1)),weight,rawWeight:-9000,weightValid:true})))
assert.deepEqual(result.points.map(p=>p.realtimeWeight),[100,105,550,null,0])
assert.equal(result.latest.source,'weight')
assert.equal(filterRealtimeWeightSeries([{timestamp:new Date(),weight:100,weightValid:false}]).latest.realtimeWeight,null)
console.log('PASS packet weight: no raw fallback, no lag, null/zero/invalid handling')

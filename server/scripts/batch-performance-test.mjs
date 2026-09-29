import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { nearestTimestampIndex } from '../src/utils/nearest-timestamp.js'
import { singleFlight } from '../src/utils/single-flight.js'

const rows = [30,10,20,20,50,0,40].map((time,id)=>({timestamp:new Date(time),id}))
rows.push({timestamp:'invalid',id:99})
const nearest=nearestTimestampIndex(rows)
for(let t=-5;t<=60;t++) {
  const expected=rows.filter(r=>Number.isFinite(new Date(r.timestamp).getTime()))
    .reduce((best,r)=>!best || Math.abs(new Date(r.timestamp)-t)<Math.abs(new Date(best.timestamp)-t)?r:best,null)
  assert.equal(nearest(t),expected,'same nearest result including duplicates, unsorted rows and ties')
}
assert.equal(nearestTimestampIndex([])(0),null)
assert.equal(nearest(NaN),null)
const shared=singleFlight();let calls=0;let release
const work=()=>{calls++;return new Promise(resolve=>release=resolve)}
const a=shared('x',work),b=shared('x',work)
await Promise.resolve();assert.equal(calls,1);release(42)
assert.deepEqual(await Promise.all([a,b]),[42,42])
assert.equal(await shared('x',()=>43),43,'finished result is not a stale cache')
await assert.rejects(shared('error',()=>{throw Error('test')}))
assert.equal(await shared('error',()=>1),1,'failure does not poison later requests')
const context={};vm.runInNewContext(fs.readFileSync(new URL('../../frontend/js/chart-sampling.js',import.meta.url),'utf8'),context)
const series=Array.from({length:10000},(_,i)=>({timestamp:i,weight:i===4567?9999:i===7890?-500:100}))
series[5000].weight=null
const sampled=context.BatchChartSampling.sample(series,r=>r.weight)
assert.ok(sampled.length<=1200)
assert.equal(sampled[0],series[0]);assert.equal(sampled.at(-1),series.at(-1))
assert.ok(sampled.includes(series[4567])&&sampled.includes(series[7890])&&sampled.includes(series[5000]))
assert.ok(sampled.every((r,i)=>!i || r.timestamp>sampled[i-1].timestamp))
assert.equal(series.length,10000,'source is unchanged')
console.log('PASS nearest lookup parity, concurrent sharing/retry, chart extrema/gaps/order/budget')

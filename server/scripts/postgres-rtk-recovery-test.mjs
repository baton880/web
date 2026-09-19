import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const url=process.env.TEST_POSTGRES_DATABASE_URL
if(!url || !/^\/farm_test_[a-z0-9_]+$/.test(new URL(url).pathname))throw Error('Isolated test database required')
process.env.DATABASE_URL=url;process.env.INGRESS_BACKEND='postgres';process.env.RTK_BUFFER_REPLAY_ENABLED='0'
const {default:prisma}=await import('../src/database.js')
const {processRtkTelemetryBody}=await import('../src/modules/telemetry/rtk.routes.js')
const {getHostIngressStore}=await import('../src/modules/telemetry/host-ingress-store.js')
const store=getHostIngressStore(),original=store.markReplayDirtyRange.bind(store)
const deviceId='recovery-'+randomUUID(),now=Date.now()
const body=at=>({device_id:deviceId,timestamp:new Date(at).toISOString(),lat:52.42,lon:85.70,speed:0,quality:4,fix_type:'RTK_FIXED',sd_ok:1})
try{
 await store.clearHistoryDirty()
 await processRtkTelemetryBody(body(now),new Date(now))
 store.markReplayDirtyRange=async()=>{throw Error('intentional failure after raw commit')}
 await assert.rejects(processRtkTelemetryBody(body(now-60000),new Date(now)),/intentional failure/)
 assert.equal(await prisma.rtkTelemetry.count({where:{deviceId}}),2)
 assert.equal(await store.nextReplayDirty(),null)
 store.markReplayDirtyRange=original
 const retried=await processRtkTelemetryBody(body(now-60000),new Date(now))
 assert.equal(retried.count,0)
 assert.equal(await prisma.rtkTelemetry.count({where:{deviceId}}),2)
 assert.ok((await store.nextReplayDirty()).sources.includes('rtk'))
 console.log('PASS RTK retry repairs dirty metadata after raw commit without duplicating telemetry')
}finally{store.markReplayDirtyRange=original;await prisma.$disconnect();await(await import('../src/modules/telemetry/ingress-postgres-pool.js')).closeIngressPool()}

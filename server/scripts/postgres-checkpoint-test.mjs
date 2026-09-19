import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deserialize } from 'node:v8'
import { inflateRawSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const url=process.env.TEST_POSTGRES_DATABASE_URL
if(!url || !/^\/farm_test_[a-z0-9_]+$/.test(new URL(url).pathname))throw Error('Isolated PostgreSQL test database required')
process.env.DATABASE_URL=url;process.env.INGRESS_BACKEND='postgres';process.env.RTK_BUFFER_REPLAY_ENABLED='0'
const {default:prisma}=await import('../src/database.js')
const {processHostTelemetryPacket}=await import('../src/modules/telemetry/telemetry.routes.js')
const {captureProcessorState,ensureProcessorCheckpointLoaded}=await import('../src/modules/telemetry/processor-checkpoint.js')
const decode=value=>deserialize(value.startsWith('z1:') ? inflateRawSync(Buffer.from(value.slice(3),'base64')) : Buffer.from(value,'base64'))
try {
 await ensureProcessorCheckpointLoaded(prisma)
 if(process.argv[2]==='--restore') {
  console.log('STATE:'+captureProcessorState())
 } else {
  const deviceId='checkpoint-'+randomUUID(),now=Date.now()
  const body=(offset,weight)=>({device_id:deviceId,timestamp:new Date(now+offset).toISOString(),lat:55.1,lon:82.8,gps_valid:true,gps_satellites:12,gps_age_s:0.1,speed_kmh:0,weight,raw:weight,weight_valid:true})
  await processHostTelemetryPacket(body(0,100),new Date(),{streamId:deviceId,packetId:1,isLive:true})
  const before=captureProcessorState()
  assert.deepEqual(decode((await prisma.appState.findUnique({where:{key:'processor-checkpoint:v1'}})).value),decode(before))
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--restore'],{env:process.env,encoding:'utf8'})
  assert.equal(child.status,0,child.stderr)
  const restored=child.stdout.split(/\r?\n/).find(line=>line.startsWith('STATE:'))?.slice(6)
  assert.ok(restored);assert.deepEqual(decode(restored),decode(before))
  console.log('PASS fresh process restores exact processor and auxiliary state')
  await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_checkpoint_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional checkpoint failure'; END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_checkpoint_test BEFORE UPDATE ON "AppState" FOR EACH ROW WHEN(NEW.key='processor-checkpoint:v1') EXECUTE FUNCTION fail_checkpoint_test()`)
  try {
   await assert.rejects(processHostTelemetryPacket(body(1000,150),new Date(),{streamId:deviceId,packetId:2,isLive:true}),/intentional checkpoint failure/)
   assert.equal(await prisma.telemetry.count({where:{deviceId}}),1)
   assert.deepEqual(decode(captureProcessorState()),decode(before))
  } finally {
   await prisma.$executeRawUnsafe('DROP TRIGGER fail_checkpoint_test ON "AppState"')
   await prisma.$executeRawUnsafe('DROP FUNCTION fail_checkpoint_test()')
  }
  await processHostTelemetryPacket(body(1000,150),new Date(),{streamId:deviceId,packetId:2,isLive:true})
  assert.equal(await prisma.telemetry.count({where:{deviceId}}),2)
  assert.deepEqual(decode((await prisma.appState.findUnique({where:{key:'processor-checkpoint:v1'}})).value),decode(captureProcessorState()))
  console.log('PASS checkpoint failure rolls back raw/business transaction and memory; retry succeeds')
  const { default: router } = await import('../src/modules/telemetry/telemetry.routes.js')
  const { getTelemetryWriteCoordinator } = await import('../src/modules/telemetry/telemetry-write-coordinator.js')
  const handler = router.stack.find(layer=>layer.route?.path==='/manual-stop').route.stack.at(-1).handle
  const batch = await prisma.batch.create({data:{deviceId, startWeight:150}})
  const call = async()=>{const res={statusCode:200,status(n){this.statusCode=n;return this},json(v){this.body=v;return this}};await handler({body:{batchId:batch.id}},res);return res}
  const held = getTelemetryWriteCoordinator().tryAcquire('test')
  assert.equal((await call()).statusCode,503);held.release()
  await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_checkpoint_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional checkpoint failure'; END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_checkpoint_test BEFORE UPDATE ON "AppState" FOR EACH ROW WHEN(NEW.key='processor-checkpoint:v1') EXECUTE FUNCTION fail_checkpoint_test()`)
  try { assert.equal((await call()).statusCode,500);assert.equal((await prisma.batch.findUnique({where:{id:batch.id}})).endTime,null) }
  finally { await prisma.$executeRawUnsafe('DROP TRIGGER fail_checkpoint_test ON "AppState"');await prisma.$executeRawUnsafe('DROP FUNCTION fail_checkpoint_test()') }
  assert.equal((await call()).statusCode,200)
  assert.ok((await prisma.batch.findUnique({where:{id:batch.id}})).endTime)
  console.log('PASS manual stop excludes concurrent calculation and rolls back batch on checkpoint failure')

 }
}finally{await prisma.$disconnect();await(await import('../src/modules/telemetry/ingress-postgres-pool.js')).closeIngressPool()}

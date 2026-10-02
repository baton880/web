// PostgreSQL contract test: only a unique synthetic device in an explicitly
// confirmed local experiment DB; every synthetic row is removed in finally.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
const url = new URL(process.env.DATABASE_URL || '')
if (!['127.0.0.1','localhost'].includes(url.hostname) || !/^\/farm_realtime_[a-z0-9_]+$/.test(url.pathname) ||
  process.env.REALTIME_SIMULATION_CONFIRM !== url.pathname.slice(1)) throw Error('Explicit local experiment DB confirmation required')
process.env.BATCH_PROCESSING_MODE = 'realtime'; process.env.REALTIME_RTK_MODE = 'disabled'
process.env.RTK_BUFFER_REPLAY_ENABLED = '0'
const {default: prisma} = await import('../src/database.js')
const {processHostTelemetryPacket} = await import('../src/modules/telemetry/telemetry.routes.js')
const {PostgresLoaderTaskStore} = await import('../src/modules/loader/loader-postgres-store.js')
const {postprocessCompletedBatch} = await import('../src/modules/batches/batch-postprocess-service.js')
const {closeIngressPool} = await import('../src/modules/telemetry/ingress-postgres-pool.js')
const deviceId = 'realtime-contract-' + crypto.randomUUID()
const taskId = crypto.randomUUID(); const streamId = crypto.randomUUID()
const taskIds = [taskId]
const store = new PostgresLoaderTaskStore(prisma)
const base = Date.now() - 200000
const rawBefore = await prisma.telemetry.count()
const rtkBefore = await prisma.rtkTelemetry.count()
try {
  const user = await prisma.user.findUnique({where:{username:'local-review'}})
  const actor = {id:user.id,role:'ADMIN'}
  const group = await prisma.livestockGroup.findFirst({where:{rationId:{not:null}}})
  const zone = await prisma.storageZone.findFirst({where:{active:true,ingredient:'Зерносенаж'}})
  const plan = {planRevision:'contract-v1',groupId:group.id,rationId:group.rationId,steps:[{name:'Силос',targetKg:540}]}
  await store.create({id:taskId,deviceId,groupId:group.id,planRevision:plan.planRevision},plan,actor)
  const reading = (i,weightKg)=>({deviceId,valid:true,weightKg,timestampMs:base+i*1000,packetId:String(i),calibrationId:'contract'})
  const begin = {id:crypto.randomUUID(),revision:0,type:'begin',stepIndex:0,explicitStepStart:true,at:base,reading:reading(0,-40)}
  await store.apply(taskId,begin,actor)
  const factsBefore=[]; let batchId
  const timings=[]
  for(let i=0;i<90;i++) {
    const weight=i<10?-40:i<65?500:0
    const packet={deviceId,timestamp:new Date(base+i*1000).toISOString(),lat:zone.lat,lon:zone.lon,
      gpsValid:true,gpsAgeS:0,speedKmh:0,weight,weight_valid:true,raw:-9000}
    const t=performance.now(); await processHostTelemetryPacket(packet,new Date(),{streamId,packetId:i});timings.push(performance.now()-t)
    if(i===5) assert.equal(await prisma.batch.count({where:{deviceId,endTime:null}}),1,'negative tare at begin cannot close an empty planned batch')
    if(i===35) {
      const confirm={id:crypto.randomUUID(),revision:1,type:'confirm',stepIndex:0,at:base+i*1000,reading:reading(i,500)}
      await store.apply(taskId,confirm,actor); await store.apply(taskId,confirm,actor)
      const batch=await prisma.batch.findFirst({where:{deviceId},include:{actualIngredients:true}});batchId=batch.id
      assert.equal(batch.actualIngredients.length,1,'duplicate confirmation creates one fact')
      assert.equal(batch.actualIngredients[0].actualWeight,540)
      assert.equal(batch.actualIngredients[0].plannedWeight,540,'tablet plan is available before unload')
      factsBefore.push(...batch.actualIngredients.map(r=>({id:r.id,name:r.ingredientName,kg:r.actualWeight,start:r.startedAt,end:r.addedAt})))
    }
  }
  const batch=await prisma.batch.findUnique({where:{id:batchId},include:{actualIngredients:true}})
  assert.ok(batch.endTime,'existing FSM closes after unload')
  assert.equal(batch.actualIngredients[0].algorithmWeight,540,'independent HOST verifies the tablet quantity')
  assert.equal(batch.actualIngredients[0].algorithmIngredientName,zone.ingredient,'GPS decides before comparing with the tablet')
  assert.equal(batch.actualIngredients[0].verificationStatus,'unconfirmed')
  const yellow = await prisma.violation.findMany({where:{batchId,source:'algorithm',status:{in:['OPEN','IN_PROGRESS']}}})
  assert.ok(yellow.some(row=>row.code==='ALGORITHM_INGREDIENT_MISMATCH'),'GPS disagreement is a persisted yellow warning')
  assert.equal(await prisma.violation.count({where:{batchId,source:'tablet',status:{in:['OPEN','IN_PROGRESS']}}}),0)
  await postprocessCompletedBatch(prisma,batchId,{}, {persist:true})
  await postprocessCompletedBatch(prisma,batchId,{}, {persist:false})
  const factsAfter=(await prisma.batchIngredient.findMany({where:{batchId}})).map(r=>({id:r.id,name:r.ingredientName,kg:r.actualWeight,start:r.startedAt,end:r.addedAt}))
  assert.deepEqual(factsAfter,factsBefore,'finish, reads and postprocess compatibility cannot replace facts')
  const duplicate=await processHostTelemetryPacket({deviceId,timestamp:new Date(base+35000).toISOString(),lat:zone.lat,lon:zone.lon,weight:500,weight_valid:true},new Date(),{streamId,packetId:35})
  assert.equal(duplicate.status,'duplicate')
  const redTaskId = crypto.randomUUID();taskIds.push(redTaskId)
  const redPlan = {...plan,steps:[{name:zone.ingredient,targetKg:540}]}
  await store.create({id:redTaskId,deviceId,groupId:group.id,planRevision:plan.planRevision},redPlan,actor)
  await store.apply(redTaskId,{id:crypto.randomUUID(),revision:0,type:'begin',stepIndex:0,explicitStepStart:true,at:base+90000,reading:reading(90,0)},actor)
  for(let i=90;i<=120;i++){
    const weight=i<94?0:i<115?700:0
    await processHostTelemetryPacket({deviceId,timestamp:new Date(base+i*1000).toISOString(),lat:zone.lat,lon:zone.lon,gpsValid:true,gpsAgeS:0,speedKmh:0,weight,weight_valid:true},new Date(),{streamId,packetId:i})
    if(i===108) await store.apply(redTaskId,{id:crypto.randomUUID(),revision:1,type:'confirm',stepIndex:0,at:base+i*1000,reading:reading(i,700)},actor)
  }
  const redBatch=await prisma.batch.findFirst({where:{deviceId,actualIngredients:{some:{tabletTaskId:redTaskId}}},include:{actualIngredients:true,violations:true}})
  assert.equal(redBatch.actualIngredients[0].actualWeight,700)
  assert.equal(redBatch.actualIngredients[0].algorithmWeight,700)
  assert.equal(redBatch.actualIngredients[0].isViolation,true)
  assert.ok(redBatch.violations.some(row=>row.code==='TABLET_DEVIATION'&&row.source==='tablet'),'tablet-confirmed >10% is persisted red')
  const resetTaskId=crypto.randomUUID();taskIds.push(resetTaskId)
  const resetPlan={...plan,steps:[{name:zone.ingredient,targetKg:100},{name:zone.ingredient,targetKg:200}]}
  await store.create({id:resetTaskId,deviceId,groupId:group.id,planRevision:plan.planRevision},resetPlan,actor)
  await store.apply(resetTaskId,{id:crypto.randomUUID(),revision:0,type:'begin',stepIndex:0,explicitStepStart:true,at:base+122000,reading:reading(122,0)},actor)
  const resetPacket=async(i,weight,calibrationId='contract')=>processHostTelemetryPacket({deviceId,timestamp:new Date(base+i*1000).toISOString(),
    lat:zone.lat,lon:zone.lon,gpsValid:true,gpsAgeS:0,speedKmh:0,weight,weight_valid:true,
    scale_measurement:{version:1,deviceId,packetId:String(i),calibrationId,timestampMs:base+i*1000,weightKg:weight,valid:true}},new Date(),{streamId,packetId:i})
  for(let i=122;i<=130;i++){
    await resetPacket(i,i<125?0:100)
    if(i===129)await store.apply(resetTaskId,{id:crypto.randomUUID(),revision:1,type:'confirm',stepIndex:0,at:base+i*1000,reading:reading(i,100)},actor)
  }
  await resetPacket(131,0,'after-reset')
  const checkpointKey=`realtime-batch:v1:${deviceId}`
  assert.equal(JSON.parse((await prisma.appState.findUnique({where:{key:checkpointKey}})).value).active.calibrationChanged,true)
  await store.apply(resetTaskId,{id:crypto.randomUUID(),revision:2,type:'begin',stepIndex:1,explicitStepStart:true,at:base+132000,reading:{...reading(132,0),calibrationId:'after-reset'}},actor)
  assert.equal(JSON.parse((await prisma.appState.findUnique({where:{key:checkpointKey}})).value).active.calibrationChanged,false,'explicit new baseline resumes online processing')
  for(let i=132;i<=150;i++){
    await resetPacket(i,i<136?0:i<146?200:0,'after-reset')
    if(i===142)await store.apply(resetTaskId,{id:crypto.randomUUID(),revision:3,type:'confirm',stepIndex:1,at:base+i*1000,reading:{...reading(i,200),calibrationId:'after-reset'}},actor)
  }
  const resetFacts=await prisma.batchIngredient.findMany({where:{tabletTaskId:resetTaskId},orderBy:{id:'asc'}})
  assert.deepEqual(resetFacts.map(f=>[f.actualWeight,f.algorithmWeight,f.verificationStatus]),[[100,100,'confirmed'],[200,200,'confirmed']])
  timings.sort((a,b)=>a-b)
  const report={packets:150,tabletFacts:4,weightKg:540,closed:true,unchangedFacts:true,independentVerification:true,redYellowContract:true,calibrationResume:true,p95Ms:timings[Math.floor(timings.length*.95)]}
  if(process.env.REALTIME_CONTRACT_REPORT) fs.writeFileSync(process.env.REALTIME_CONTRACT_REPORT,JSON.stringify(report,null,2))
  console.log('PASS PostgreSQL live contract '+JSON.stringify(report))
} finally {
  await prisma.$transaction(async tx=>{
    const batches=await tx.batch.findMany({where:{deviceId},select:{id:true}})
    await tx.violation.deleteMany({where:{batchId:{in:batches.map(b=>b.id)}}})
    await tx.batch.deleteMany({where:{deviceId}})
    await tx.loaderTask.deleteMany({where:{id:{in:taskIds}}})
    await tx.deviceCurrentTelemetry.deleteMany({where:{deviceId}})
    await tx.telemetry.deleteMany({where:{deviceId,sourceStreamId:streamId}})
    await tx.appState.deleteMany({where:{key:{in:[`realtime-batch:v1:${deviceId}`,`realtime-task:v1:${taskId}`]}}})
  })
  assert.equal(await prisma.telemetry.count(),rawBefore)
  assert.equal(await prisma.rtkTelemetry.count(),rtkBefore)
  await prisma.$disconnect();await closeIngressPool()
}

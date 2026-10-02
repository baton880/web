// Reproduce a recorded stream through the same causal reducer used by live ingest.
// Never writes raw telemetry; restricted to an explicitly named local experiment DB.
import fs from 'node:fs'
import pg from 'pg'
import { PrismaClient } from '../src/prisma-client.js'
import { getTelemetrySettings } from '../src/modules/telemetry/telemetry-settings.js'
import { recalculateBatchViolations } from '../src/modules/batches/batch-violations.js'
import { reduceTask } from '../src/modules/loader/loader-task-store.js'
import { newRealtimeState, reduceRealtimePacket } from '../src/modules/batches/realtime-processor-adapter.js'
import { realtimeContext, persistRealtimeActions, readRealtimeState, saveRealtimeState,
  applyRealtimeTabletEvent } from '../src/modules/batches/realtime-batch-service.js'

const url = new URL(process.env.DATABASE_URL || '')
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^\/farm_realtime_[a-z0-9_]+$/.test(url.pathname) ||
    process.env.REALTIME_SIMULATION_CONFIRM !== url.pathname.slice(1)) throw Error('Explicit local farm_realtime_ database confirmation required')
process.env.BATCH_PROCESSING_MODE = 'realtime'
process.env.REALTIME_RTK_MODE ||= 'auto'
const from = new Date(process.env.SIMULATION_FROM || '2026-09-27T17:00:00Z')
const to = new Date(process.env.SIMULATION_TO || '2026-10-01T04:48:35Z')
const prisma = new PrismaClient()
const sql = new pg.Client({ connectionString: url.toString() })
await sql.connect()
const rawSignature = async () => (await sql.query(`SELECT 'host' AS source,count(*)::text n,min(timestamp)::text first,max(timestamp)::text last,
  sum(id)::text ids FROM "Telemetry" UNION ALL SELECT 'rtk',count(*)::text,min(timestamp)::text,max(timestamp)::text,sum(id)::text FROM "RtkTelemetry"`)).rows
const report = { from, to, beforeRaw: await rawSignature(), packets: 0, events: 0, actions: {}, issues: [] }
try {
  const zones = await prisma.storageZone.findMany({ where: { active: true } })
  const groups = await prisma.livestockGroup.findMany()
  const settings = await getTelemetrySettings(prisma)
  const rtkPackets = process.env.REALTIME_RTK_MODE === 'disabled' ? [] : await prisma.rtkTelemetry.findMany({
    where: { timestamp: { gte: new Date(from.getTime() - 3000), lt: to } }, orderBy: [{ timestamp: 'asc' }, { id: 'asc' }] })
  let rtkIndex = 0, lastRtk = null
  const old = await prisma.batch.findMany({ where: { startTime: { gte: from, lt: to } }, include: { actualIngredients: true } })
  const reference = new pg.Client({ connectionString: new URL('/farm_snapshot_20261001', url).toString() })
  await reference.connect()
  try {
    report.beforeBatches = (await reference.query(`SELECT b.id,b."startTime",b."endTime",b."groupId",
      coalesce(sum(i."actualWeight"),0) AS weight FROM "Batch" b LEFT JOIN "BatchIngredient" i ON i."batchId"=b.id
      WHERE b."startTime">=$1 AND b."startTime"<$2 GROUP BY b.id ORDER BY b."startTime"`, [from,to])).rows
  } finally { await reference.end() }
  await prisma.$transaction(async tx => {
    await tx.violation.deleteMany({ where: { batchId: { in: old.map(row => row.id) } } })
    await tx.batch.deleteMany({ where: { id: { in: old.map(row => row.id) } } })
    await tx.appState.deleteMany({ where: { OR: [{ key: { startsWith: 'realtime-batch:' } }, { key: { startsWith: 'realtime-task:' } }] } })
  })
  const taskRows = await prisma.loaderTask.findMany()
  const tasks = new Map(taskRows.map(row => {
    const final = JSON.parse(row.state)
    const initial = { ...final, status: 'ready', revision: 0, currentIndex: 0, lastEventAt: null, lastEventType: null,
      steps: final.steps.map(({ baseline, end, actualKg, confirmedAt, ...step }) => step) }
    return [row.id, initial]
  }))
  const events = (await prisma.loaderTaskEvent.findMany()).map(row => ({ taskId: row.taskId, ...JSON.parse(row.payload) }))
    .filter(event => event.at >= from.getTime() && event.at < to.getTime()).sort((a, b) => a.at - b.at || a.revision - b.revision)
  const states = new Map(); let eventIndex = 0
  async function eventUntil(tx, at) {
    while (events[eventIndex]?.at <= at) {
      const event = events[eventIndex++]
      const previous = tasks.get(event.taskId)
      if (!previous) continue
      const { taskId, ...payload } = event
      let next
      try { next = reduceTask(previous, payload) }
      catch (error) { report.issues.push({ taskId, eventId: event.id, reason: error.message }); continue }
      tasks.set(taskId, next)
      const state = states.get(next.deviceId)
      if (state) await saveRealtimeState(tx, next.deviceId, state)
      await applyRealtimeTabletEvent(tx, next, payload)
      states.set(next.deviceId, await readRealtimeState(tx, next.deviceId))
      report.events++
    }
  }
  let cursorTime = from, cursorId = 0
  while (true) {
    const { rows } = await sql.query(`WITH page AS MATERIALIZED (SELECT * FROM "Telemetry"
      WHERE timestamp >= $1 AND timestamp < $2 AND (timestamp,id)>($3,$4) ORDER BY timestamp,id LIMIT 4000)
      SELECT id,"deviceId",timestamp,"sourceStreamId","sourcePacketId",weight,"weightValid",
      lat,lon,"gpsValid","gpsAgeS","speedKmh", "rawPayload"::jsonb #>> '{scale_measurement,calibrationId}' AS "calibrationId"
      FROM page ORDER BY timestamp,id`, [from, to, cursorTime, cursorId])
    if (!rows.length) break
    await prisma.$transaction(async tx => {
      for (const packet of rows) {
        const at = new Date(packet.timestamp).getTime()
        await eventUntil(tx, at)
        const previous = states.get(packet.deviceId) || newRealtimeState()
        while (rtkPackets[rtkIndex] && new Date(rtkPackets[rtkIndex].timestamp).getTime() <= at) lastRtk = rtkPackets[rtkIndex++]
        const reduced = reduceRealtimePacket(previous, packet, realtimeContext(packet, zones, groups, settings, lastRtk), settings)
        const affected = await persistRealtimeActions(tx, packet.deviceId, reduced.state, reduced.actions, previous.active?.batchId)
        for (const id of affected) await recalculateBatchViolations(tx, id, settings)
        for (const action of reduced.actions) report.actions[action.type] = (report.actions[action.type] || 0) + 1
        states.set(packet.deviceId, reduced.state)
        report.packets++
      }
      for (const [deviceId, state] of states) await saveRealtimeState(tx, deviceId, state)
    }, { timeout: 120000 })
    cursorTime = rows.at(-1).timestamp; cursorId = rows.at(-1).id
    if (report.packets % 20000 === 0) console.log(JSON.stringify({ packets: report.packets, timestamp: cursorTime, actions: report.actions }))
  }
  await prisma.$transaction(tx => eventUntil(tx, to.getTime()), { timeout: 120000 })
  for (const batch of await prisma.batch.findMany({ where: { processingMode: 'realtime-v1', endTime: { not: null } }, select: { id: true } }))
    await recalculateBatchViolations(prisma, batch.id, settings)
  report.afterRaw = await rawSignature()
  if (JSON.stringify(report.beforeRaw) !== JSON.stringify(report.afterRaw)) throw Error('Raw telemetry changed')
  report.afterBatches = (await prisma.batch.findMany({ where: { processingMode: 'realtime-v1' }, include: { actualIngredients: true }, orderBy: { startTime: 'asc' } }))
    .map(batch => ({ id: batch.id, startTime: batch.startTime, endTime: batch.endTime, groupId: batch.groupId,
      weight: batch.actualIngredients.reduce((sum, row) => sum + row.actualWeight, 0), ingredients: batch.actualIngredients }))
  fs.writeFileSync(process.env.SIMULATION_REPORT, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ packets: report.packets, events: report.events, actions: report.actions,
    issues: report.issues.length, batches: report.afterBatches.length, report: process.env.SIMULATION_REPORT }))
} finally { await sql.end(); await prisma.$disconnect() }

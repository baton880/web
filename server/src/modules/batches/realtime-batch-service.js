import { detectZoneObject, detectZoneWithinRadius, distanceToZoneMeters } from '../../../../module-1/geo.js'
import { normalizeIngredientName } from '../../../../module-2/rationManager.js'
import { roundWeight } from '../../../../module-2/weightRounding.js'
import { recordLeftoverViolation } from '../violations/violation-service.js'
import { getTelemetrySettings } from '../telemetry/telemetry-settings.js'
import { newRealtimeState, reduceRealtimePacket, REALTIME_REVISION } from './realtime-processor-adapter.js'
import { ingredientEvidence, beginIngredientEvidence, confirmIngredientEvidence } from './realtime-ingredient-verification.js'

export const realtimeEnabled = () => process.env.BATCH_PROCESSING_MODE === 'realtime'
const stateKey = deviceId => `realtime-batch:v1:${deviceId}`

export function realtimeContext(packet, zones, groups, settings = {}, rtk = null) {
  const validGps = packet.gpsValid !== false && Number.isFinite(packet.lat) && Number.isFinite(packet.lon) &&
    !(packet.lat === 0 && packet.lon === 0) && (packet.gpsAgeS == null || packet.gpsAgeS <= 3)
  const barns = new Set(groups.map(group => group.storageZoneId).filter(Boolean))
  const loading = zones.filter(zone => !barns.has(zone.id) && ['STORAGE', 'FEED', 'LOADING'].includes(zone.zoneType || 'STORAGE'))
  const hostZone = validGps ? detectZoneWithinRadius(packet.lat, packet.lon, loading, 20) : null
  const barnZone = validGps ? detectZoneWithinRadius(packet.lat, packet.lon, zones.filter(zone => barns.has(zone.id) || zone.zoneType === 'BARN'), 5) : null
  const group = groups.find(row => row.storageZoneId === barnZone?.id)
  let ingredientName = hostZone?.ingredient || hostZone?.name || 'Неопределено'
  let confidence = hostZone ? 'confirmed' : 'low_confidence'
  let reason = hostZone ? 'host_zone' : 'host_position_missing'
  // RTK is optional evidence for the component, never permission to start a batch.
  const rtkFresh = process.env.REALTIME_RTK_MODE !== 'disabled' && rtk &&
    new Date(packet.timestamp) - new Date(rtk.timestamp) >= 0 && new Date(packet.timestamp) - new Date(rtk.timestamp) <= 3000 &&
    validGps && distanceToZoneMeters(packet.lat, packet.lon, { lat: rtk.lat, lon: rtk.lon, radius: 0 }) <= (settings.loaderMaxDistanceMeters || 30)
  const loaderZones = rtkFresh ? loading.filter(zone => distanceToZoneMeters(rtk.lat, rtk.lon, zone) <= 0) : []
  const loaderZone = loaderZones.length === 1 ? loaderZones[0] : null
  if (loaderZone) { ingredientName = loaderZone.ingredient || loaderZone.name; reason = 'rtk_zone' }
  const key = normalizeIngredientName(ingredientName)
  if (['солома', 'люцерна'].includes(key) && !loaderZone) {
    ingredientName = 'Солома/люцерна (не определено)'; confidence = 'low_confidence'; reason = 'rtk_unavailable'
  }
  return { hostLoading: Boolean(hostZone), barn: Boolean(barnZone), groupId: group?.id,
    rationId: group?.rationId, ingredientName, confidence, reason, loaderZone,
    loaderPoint: rtkFresh ? rtk : null,
    evidenceIngredientName: loaderZone?.ingredient || loaderZone?.name || hostZone?.ingredient || hostZone?.name || null,
    evidenceSource: loaderZone ? 'rtk' : 'host',
    pairAmbiguous: !loaderZone && (['солома', 'люцерна'].includes(normalizeIngredientName(hostZone?.ingredient || hostZone?.name)) ||
      loaderZones.some(zone => ['солома', 'люцерна'].includes(normalizeIngredientName(zone.ingredient || zone.name)))),
    loadingZones: loading, hostForceIngredientName: validGps ? detectZoneObject(packet.lat, packet.lon, loading)?.ingredient : null }
}
export async function lockRealtimeDevice(tx, deviceId) {
  if (/^postgres/.test(process.env.DATABASE_URL || '')) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`realtime:${deviceId}`}, 0))::text`
  }
}
export async function readRealtimeState(tx, deviceId) {
  const row = await tx.appState.findUnique({ where: { key: stateKey(deviceId) } })
  return row ? JSON.parse(row.value) : newRealtimeState()
}
export async function saveRealtimeState(tx, deviceId, state) {
  const data = { value: JSON.stringify(state), updatedAt: new Date().toISOString() }
  await tx.appState.upsert({ where: { key: stateKey(deviceId) }, create: { key: stateKey(deviceId), ...data }, update: data })
}

export async function clearRealtimeBatchState(tx, deviceId, batchId) {
  await lockRealtimeDevice(tx, deviceId)
  const state = await readRealtimeState(tx, deviceId)
  if (state.active?.batchId !== batchId) return
  state.active = null; state.tablet = null; state.processor = null
  ingredientEvidence(state).current = null
  state.emptyStreak = 0; state.negativeStreak = 0
  await saveRealtimeState(tx, deviceId, state)
}

export async function persistRealtimeActions(tx, deviceId, state, actions, initialBatchId = state.active?.batchId) {
  const affected = new Set()
  let batchId = initialBatchId || null
  for (const action of actions) {
    if (action.type === 'start') {
      const existing = await tx.batch.findFirst({ where: { deviceId, endTime: null }, orderBy: { startTime: 'desc' } })
      if (existing && existing.processingMode !== REALTIME_REVISION) throw Error('Close the legacy batch before enabling realtime calculation')
      const batch = existing || await tx.batch.create({ data: { deviceId, processingMode: REALTIME_REVISION,
        startTime: new Date(action.at), startWeight: roundWeight(action.weight),
        groupId: action.groupId || null, rationId: action.rationId || null } })
      batchId = batch.id
      if (state.active) state.active.batchId = batchId
    } else if (action.type === 'verify') {
      await tx.batchIngredient.updateMany({ where: { id: action.factId, batchId: action.batchId }, data: {
        algorithmIngredientName: action.algorithmIngredientName, algorithmWeight: action.algorithmWeight,
        verificationStatus: action.verificationStatus, verificationReason: action.verificationReason } })
      affected.add(action.batchId)
    } else if (batchId && action.type === 'quality') {
      await tx.batchIngredient.updateMany({ where: { batchId, tabletTaskId: null },
        data: { verificationStatus: 'low_confidence', verificationReason: action.reason } })
    } else if (batchId && action.type === 'load') {
      await tx.batchIngredient.create({ data: { batchId, ingredientName: action.ingredientName,
        actualWeight: roundWeight(action.weight), startedAt: new Date(action.startAt), addedAt: new Date(action.at),
        startLat: action.startLat ?? null, startLon: action.startLon ?? null,
        endLat: action.endLat ?? null, endLon: action.endLon ?? null,
        verificationStatus: action.confidence, verificationReason: action.reason,
        algorithmIngredientName: action.ingredientName, algorithmWeight: roundWeight(action.weight) } })
      affected.add(batchId)
    } else if (batchId && action.type === 'group') {
      const batch = await tx.batch.findUnique({ where: { id: batchId } })
      // An explicit operator plan is authoritative; GPS cannot silently replace it.
      if (!batch.groupId) await tx.batch.update({ where: { id: batchId }, data: { groupId: action.groupId, rationId: action.rationId || null } })
    } else if (batchId && action.type === 'end') {
      await tx.batch.update({ where: { id: batchId }, data: { endTime: new Date(action.at), endWeight: roundWeight(action.weight) } })
      if (action.leftover) {
        await recordLeftoverViolation(tx, { batchId, deviceId, leftoverWeight: roundWeight(action.weight), detectedAt: new Date(action.at) })
        await tx.batch.update({ where: { id: batchId }, data: { hasViolations: true } })
      }
      affected.add(batchId)
      batchId = null
    }
  }
  return affected
}

export async function processRealtimePacket(tx, packet, { zones, groups, settings, rtk = null, expectedIngredients = [] }) {
  await lockRealtimeDevice(tx, packet.deviceId)
  const previous = await readRealtimeState(tx, packet.deviceId)
  const context = { ...realtimeContext(packet, zones, groups, settings, rtk), expectedIngredients }
  const reduced = reduceRealtimePacket(previous, packet, context, settings)
  const affected = await persistRealtimeActions(tx, packet.deviceId, reduced.state, reduced.actions, previous.active?.batchId)
  await saveRealtimeState(tx, packet.deviceId, reduced.state)
  return { ...reduced, affected }
}

export async function applyRealtimeTabletEvent(tx, task, event) {
  if (!realtimeEnabled()) return
  const telemetrySettings = await getTelemetrySettings(tx)
  await lockRealtimeDevice(tx, task.deviceId)
  const state = await readRealtimeState(tx, task.deviceId)
  const key = `realtime-task:v1:${task.id}`
  const row = await tx.appState.findUnique({ where: { key } })
  const binding = row ? JSON.parse(row.value) : { batchId: null, steps: {} }
  const affected = new Set()
  if (binding.batchId && !await tx.batch.findUnique({ where: { id: binding.batchId }, select: { id: true } })) {
    if (event.type !== 'cancel') throw Object.assign(new Error('Замес удалён вручную. Отмените задание и создайте новое.'), { status: 409 })
    binding.batchId = null; binding.steps = {}
  }
  if (event.type === 'begin' && !binding.batchId) {
    if ((state.active?.unloading || state.active?.calibrationChanged) && state.tablet?.id !== task.id) {
      const ended = await persistRealtimeActions(tx, task.deviceId, state, [{ type: 'end', at: event.at, weight: event.reading.weightKg }])
      for (const id of ended) affected.add(id)
      state.active = null; state.tablet = null; state.processor = null
    }
    if (!state.active) {
      state.processor = null
      state.emptyStreak = 0; state.negativeStreak = 0
      if (event.reading.calibrationId) state.calibrationId = event.reading.calibrationId
      state.lastAt = Math.max(state.lastAt || 0, event.reading.timestampMs)
      state.active = { startAt: event.at, startWeight: event.reading.weightKg,
        peak: event.reading.weightKg, unloading: false, batchId: null }
    }
    await persistRealtimeActions(tx, task.deviceId, state, [{ type: 'start', at: event.at,
      weight: event.reading.weightKg, groupId: task.groupId, rationId: task.rationId }])
    binding.batchId = state.active.batchId
    const batch = await tx.batch.findUnique({ where: { id: binding.batchId } })
    if (state.tablet && state.tablet.id !== task.id && batch.groupId && batch.groupId !== task.groupId) {
      throw Error(`Tablet group conflicts with active task: ${state.tablet.id} (${batch.groupId}) / ${task.id} (${task.groupId}) at ${event.at}`)
    }
    await tx.batch.update({ where: { id: binding.batchId }, data: { groupId: task.groupId, rationId: task.rationId } })
  }
  if (binding.batchId && event.type === 'begin') {
    if (state.active?.calibrationChanged || (event.reading.calibrationId && state.calibrationId && state.calibrationId !== event.reading.calibrationId)) {
      // A new explicit step baseline safely resumes the same batch after a
      // reset. The interrupted step stays unverified; its weight is not mixed
      // with the new calibration, and completed facts are never replaced.
      if (state.calibrationId !== event.reading.calibrationId) ingredientEvidence(state).recent = []
      if (state.active) state.active.calibrationChanged = false
      state.processor = null; state.suspended = null
      state.emptyStreak = 0; state.negativeStreak = 0
      state.calibrationId = event.reading.calibrationId
      state.lastAt = Math.max(state.lastAt || 0, event.reading.timestampMs)
    }
    beginIngredientEvidence(state, task, event.stepIndex)
  }
  if (binding.batchId && event.type === 'confirm' && !binding.steps[event.stepIndex]) {
    const step = task.steps[event.stepIndex]
    const batch = await tx.batch.findUnique({ where: { id: binding.batchId } })
    if (batch.endTime && new Date(batch.endTime).getTime() < step.end.timestampMs)
      throw Object.assign(new Error('Замес уже закрыт. Поздняя загрузка требует ручного исправления.'), { status: 409 })
    const fact = await tx.batchIngredient.create({ data: { batchId: binding.batchId, tabletTaskId: task.id,
      ingredientName: step.name, plannedWeight: roundWeight(step.targetKg || 0), actualWeight: roundWeight(step.actualKg),
      startedAt: new Date(step.baseline.timestampMs), addedAt: new Date(step.end.timestampMs),
      verificationStatus: 'pending', verificationReason: 'waiting_for_host' } })
    binding.steps[event.stepIndex] = fact.id
    const verification = confirmIngredientEvidence(state, task, event.stepIndex, fact.id, binding.batchId, event.at, telemetrySettings)
    await tx.batchIngredient.update({ where: { id: fact.id }, data: verification })
    affected.add(binding.batchId)
    if (task.steps[task.currentIndex]?.baseline) beginIngredientEvidence(state, task, task.currentIndex)
  }
  if (binding.batchId && event.type === 'undo') {
    const batch = await tx.batch.findUnique({ where: { id: binding.batchId } })
    if (batch.endTime) throw Object.assign(new Error('Завершённый замес требует ручного исправления.'), { status: 409 })
    const index = task.currentIndex
    if (binding.steps[index]) await tx.batchIngredient.deleteMany({ where: { id: binding.steps[index] } })
    delete binding.steps[index]
    const evidence = ingredientEvidence(state)
    const slot = evidence.steps[`${task.id}:${index}`]
    if (slot) { slot.finalized = false; slot.factId = null; slot.endAt = null; evidence.current = slot.key }
    affected.add(binding.batchId)
  }
  if (event.type === 'cancel') {
    state.tablet = null
    ingredientEvidence(state).current = null
    if (binding.batchId) {
      const attempt = await tx.batchIngredient.aggregate({ where: { batchId: binding.batchId, tabletTaskId: task.id }, _sum: { actualWeight: true } })
      if (!(attempt._sum.actualWeight > 0)) {
        // A cancelled zero-weight setup attempt is not a missing feed. Keep
        // its task/event journal for debug, remove only its empty fact rows.
        await tx.batchIngredient.deleteMany({ where: { batchId: binding.batchId, tabletTaskId: task.id } })
        binding.steps = {}
        affected.add(binding.batchId)
      }
    }
    if (binding.batchId && state.active?.batchId === binding.batchId) {
      const facts = await tx.batchIngredient.aggregate({ where: { batchId: binding.batchId }, _sum: { actualWeight: true } })
      if (!(facts._sum.actualWeight > 0) && state.active.peak - state.active.startWeight < 20) {
        await tx.violation.deleteMany({ where: { batchId: binding.batchId } })
        await tx.batch.delete({ where: { id: binding.batchId } })
        state.active = null; state.processor = null; binding.batchId = null
        binding.steps = {}
      }
    }
  }
  else if (binding.batchId && state.active?.batchId === binding.batchId)
    state.tablet = { id: task.id, groupId: task.groupId, rationId: task.rationId, status: task.status }
  const data = { value: JSON.stringify(binding), updatedAt: new Date().toISOString() }
  await tx.appState.upsert({ where: { key }, create: { key, ...data }, update: data })
  await saveRealtimeState(tx, task.deviceId, state)
  if (affected.size) {
    const { recalculateBatchViolations } = await import('./batch-violations.js')
    for (const id of affected) await recalculateBatchViolations(tx, id, telemetrySettings)
  }
}

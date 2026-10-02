import { serialize, deserialize } from 'node:v8'
import { TelemetryProcessor } from '../../../../module-3/telemetryProcessor.js'
import { normalizeIngredientName } from '../../../../module-2/rationManager.js'
import { ingredientEvidence, observeIngredientEvidence } from './realtime-ingredient-verification.js'

export const REALTIME_REVISION = 'realtime-v1'
export function newRealtimeState() {
  return { version: 2, lastAt: null, lastIdentity: null, calibrationId: null,
    processor: null, active: null, tablet: null, suspended: null, emptyStreak: 0, negativeStreak: 0 }
}

// The established TelemetryProcessor owns every loading/unloading transition,
// including overlap, movement, debounce and residual recovery. This adapter
// only restores its durable state and translates its actions into saved facts.
export function reduceRealtimePacket(previous, packet, context = {}, settings = {}) {
  const state = structuredClone(previous || newRealtimeState())
  if (state.version !== 2) throw Error('Unsupported realtime checkpoint: use a fresh experimental copy')
  const at = new Date(packet.timestamp).getTime()
  const identity = packet.sourceStreamId && packet.sourcePacketId != null
    ? `${packet.sourceStreamId}:${packet.sourcePacketId}` : packet.packetIdentity || `${at}:${packet.id ?? ''}`
  if (!Number.isFinite(at) || (state.lastAt != null && at < state.lastAt) || identity === state.lastIdentity)
    return { state, actions: [], ignored: 'duplicate_or_late' }
  const processor = new TelemetryProcessor()
  let calibrationChangedNow = false
  if (state.processor) processor.replaceStates(deserialize(Buffer.from(state.processor, 'base64')))
  const deviceId = packet.deviceId || 'host_01'
  if (context.loaderPoint) {
    // Reuse the established dwell/entry/heading scoreboard in a separate
    // processor. Loader evidence must never authorize a HOST-first batch start.
    const loader = new TelemetryProcessor()
    if (state.loaderProcessor) loader.replaceStates(deserialize(Buffer.from(state.loaderProcessor, 'base64')))
    if (new Date(context.loaderPoint.timestamp).getTime() > (state.lastLoaderAt || 0)) {
      loader.processLoaderPacket(context.loaderPoint, context.loadingZones || [], settings, { deviceId })
      state.lastLoaderAt = new Date(context.loaderPoint.timestamp).getTime()
    }
    const candidates = loader.getZoneScoreboard(deviceId).filter(row =>
      at - new Date(row.lastSeenAt).getTime() <= 180000 && row.samples >= 2).sort((a, b) => b.score - a.score)
    const winner = candidates[0]
    if (context.evidenceSource !== 'rtk' && winner && winner.score >= 2 &&
        (!candidates[1] || winner.score > candidates[1].score * 1.5)) {
      context = { ...context, evidenceIngredientName: winner.ingredient || winner.name,
        evidenceSource: 'rtk', pairAmbiguous: false }
    }
    state.loaderProcessor = serialize(loader.exportStates()).toString('base64')
  }
  if (state.calibrationId && packet.calibrationId && state.calibrationId !== packet.calibrationId) {
    // A scale reset is not a measured ingredient. Keep the batch and explicitly
    // suspend the pending segment; the tablet protocol also rejects that step.
    processor.clearDeviceState(deviceId)
    state.suspended = 'calibration_changed'
    const evidence = ingredientEvidence(state)
    evidence.recent = []
    for (const slot of Object.values(evidence.steps)) if (!slot.finalized) slot.calibrationChanged = true
    if (state.active) { calibrationChangedNow = !state.active.calibrationChanged; state.active.calibrationChanged = true }
  } else if (packet.weightValid !== false && packet.weight != null && Number.isFinite(Number(packet.weight))) {
    state.suspended = null
  }
  if (packet.calibrationId) state.calibrationId = packet.calibrationId
  state.lastAt = at; state.lastIdentity = identity
  const verificationActions = observeIngredientEvidence(state, packet, context, settings)
  if (state.active?.calibrationChanged) {
    state.suspended = 'calibration_changed'
    return { state, actions: [...verificationActions, ...(calibrationChangedNow ? [{ type: 'quality', reason: 'calibration_changed', confirmedAt: at }] : [])], ignored: 'calibration_changed' }
  }
  if (packet.weightValid === false || packet.weight == null) state.suspended = 'invalid_weight'
  const previousDecision = state.automaticDecision
  const result = processor.processPacket({ ...packet, deviceId }, context.loadingZones || [], settings, {
    suppressLoading: Boolean(context.barn), skipZoneVisit: true,
    allowVisitedZoneIngredient: false, preferCurrentZoneIngredient: false,
    hostLat: packet.lat, hostLon: packet.lon,
    hostForceIngredientName: context.hostForceIngredientName || null,
    expectedIngredients: context.expectedIngredients || []
  })
  if (!result.isValid) return { state, actions: verificationActions, ignored: result.error }
  const actions = [...verificationActions]
  const segment = processor.getDeviceState(deviceId)
  if (segment.loadingStartTimeMs != null && segment.loadingStartTimeMs !== state.automaticDecision?.at) {
    state.automaticDecision = { at: segment.loadingStartTimeMs, name: context.evidenceIngredientName,
      source: context.evidenceSource, pairAmbiguous: context.pairAmbiguous }
  }
  for (const action of result.dbActions || []) {
    if (action.type === 'START_BATCH' || (action.type === 'ADD_INGREDIENT' && !state.active)) {
      const startAt = action.startTime ? new Date(action.startTime).getTime() : at
      if (!state.active) state.active = { startAt, startWeight: action.startWeight != null ? Number(action.startWeight) :
        action.actualWeight != null ? Number(packet.weight) - action.actualWeight : Number(packet.weight),
        peak: Number(packet.weight), unloading: false, batchId: null }
      actions.push({ type: 'start', at: startAt, weight: state.active.startWeight })
    }
    if (action.type === 'ADD_INGREDIENT' && !state.tablet) {
      const decision = previousDecision?.at === new Date(action.startTime).getTime() ? previousDecision : state.automaticDecision
      const name = decision?.source === 'rtk' ? decision.name : action.ingredientName
      const ambiguous = ['солома', 'люцерна'].includes(normalizeIngredientName(name)) && decision?.source !== 'rtk'
      const unknown = ['unknown', 'неопределено'].includes(normalizeIngredientName(name))
      actions.push({ type: 'load', at: action.endTime ? new Date(action.endTime).getTime() : at,
        startAt: action.startTime ? new Date(action.startTime).getTime() : at,
        weight: action.actualWeight,
        ingredientName: ambiguous ? 'Солома/люцерна (не определено)' : name,
        confidence: ambiguous || unknown ? 'low_confidence' : 'confirmed',
        reason: ambiguous ? 'rtk_unavailable' : unknown ? 'ingredient_unknown' : 'telemetry_processor',
        startLat: action.startLat, startLon: action.startLon, endLat: action.endLat, endLon: action.endLon })
    }
    if (['START_UNLOAD', 'UPDATE_UNLOAD'].includes(action.type) && state.active) {
      state.active.unloading = true
      state.active.endWeight = action.endWeight ?? action.startUnloadWeight ?? packet.weight
      if (!state.active.groupId && context.groupId) {
        state.active.groupId = context.groupId
        actions.push({ type: 'group', groupId: context.groupId, rationId: context.rationId })
      }
    }
    if (['COMPLETE_BATCH', 'FORCE_CLOSE_BATCH'].includes(action.type)) {
      actions.push({ type: 'end', at: action.endTime ? new Date(action.endTime).getTime() : at,
        weight: action.endWeight ?? action.closeWeight ?? packet.weight,
        leftover: action.type === 'FORCE_CLOSE_BATCH' && Number(action.closeWeight) > (settings.leftoverThresholdKg || 50) })
      state.active = null; state.tablet = null
    }
  }
  // Preserve the existing route's fallback for a series of empty/negative
  // valid readings. Invalid/null samples must never act as zero.
  const valid = packet.weightValid !== false && packet.weight != null && Number.isFinite(Number(packet.weight))
  state.emptyStreak = valid && Number(packet.weight) <= (settings.autoCloseZeroWeightKg || 10) ? state.emptyStreak + 1 : 0
  state.negativeStreak = valid && Number(packet.weight) < 0 ? state.negativeStreak + 1 : 0
  if (state.active && state.active.peak - Math.max(0, state.active.startWeight) > (settings.batchStartThresholdKg || 30) &&
      !(result.dbActions || []).some(a => a.type === 'ADD_INGREDIENT') &&
      (state.emptyStreak >= (settings.autoCloseEmptyStreak || 5) || state.negativeStreak >= (settings.autoCloseNegativeStreak || 3))) {
    actions.push({ type: 'end', at, weight: packet.weight })
    state.active = null; state.tablet = null; processor.clearDeviceState(deviceId)
  }
  if (state.active) {
    state.active.peak = Math.max(state.active.peak, Number(packet.weight) || 0, result.state?.peakWeight || 0)
    state.active.unloading = state.active.unloading || Boolean(result.state?.isUnloading)
  }
  state.processor = serialize(processor.exportStates()).toString('base64')
  return { state, actions: actions.map(action => ({ ...action, confirmedAt: at })),
    processorActions: result.dbActions || [], machineState: result.state, banner: result.banner }
}

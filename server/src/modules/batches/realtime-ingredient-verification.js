import { normalizeIngredientName } from '../../../../module-2/rationManager.js'
import { roundWeight } from '../../../../module-2/weightRounding.js'
import { buildOrderViolations } from './ingredient-order.js'

const pair = name => ['солома', 'люцерна'].includes(normalizeIngredientName(name))
export const REALTIME_WEIGHT_TOLERANCE_PERCENT = 5
export const REALTIME_WEIGHT_TOLERANCE_MIN_KG = 5
export function realtimeWeightTolerance(settings = {}) {
  const percent = Number(settings.tabletAlgorithmWeightTolerancePercent)
  const minKg = Number(settings.tabletAlgorithmWeightToleranceMinKg)
  return {
    percent: Number.isFinite(percent) && percent > 0 ? percent : REALTIME_WEIGHT_TOLERANCE_PERCENT,
    minKg: Number.isFinite(minKg) && minKg > 0 ? minKg : REALTIME_WEIGHT_TOLERANCE_MIN_KG
  }
}
export function realtimeWeightMatches(tabletWeight, algorithmWeight, settings = {}) {
  const tablet = Number(tabletWeight)
  const algorithm = Number(algorithmWeight)
  if (!Number.isFinite(tablet) || !Number.isFinite(algorithm)) return false
  if (tablet === 0) return algorithm === 0
  const delta = Math.abs(algorithm - tablet)
  const tolerance = realtimeWeightTolerance(settings)
  return delta <= tolerance.minKg || delta * 100 < Math.abs(tablet) * tolerance.percent
}
export function effectiveRealtimeWeight(row, settings = {}) {
  const tabletWeight = Number(row?.actualWeight || 0)
  if (!row?.tabletTaskId || !realtimeWeightMatches(tabletWeight, row?.algorithmWeight, settings)) return roundWeight(tabletWeight)
  return roundWeight(row.algorithmWeight)
}
export function selectRealtimeFactRows(rows) {
  const source = Array.isArray(rows) ? rows : []
  const tabletKeys = new Set(source
    .filter(row => row?.tabletTaskId)
    .map(row => normalizeIngredientName(row?.ingredientName)))
  return source.filter(row => row?.tabletTaskId || !tabletKeys.has(normalizeIngredientName(row?.ingredientName)))
}
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}
const ms = value => new Date(value).getTime()
export const exceedsRealtimePlan = (weight, plan) => plan > 0
  ? Math.abs(weight - plan) > plan * 0.1 + 1e-7 : weight > 0

export function ingredientEvidence(state) {
  return state.evidence ||= { recent: [], steps: {}, current: null }
}

function levelAt(recent, at) {
  const samples = recent.filter(sample => sample.at <= at && sample.at >= at - 3000)
  const latest = samples.at(-1)
  if (!latest || at - latest.at > 3000) return null
  // Only already received HOST samples, never tablet reading.weightKg. A short
  // causal plateau suppresses bucket jolts without changing the recorded graph.
  return median(samples.slice(-5).map(sample => sample.weight))
}

export function beginIngredientEvidence(state, task, index) {
  const evidence = ingredientEvidence(state)
  const key = `${task.id}:${index}`
  const step = task.steps[index]
  const previous = evidence.steps[key]
  for (const [oldKey, slot] of Object.entries(evidence.steps)) {
    if (slot.taskId !== task.id && slot.finalized) delete evidence.steps[oldKey]
  }
  evidence.steps[key] = previous && !previous.finalized ? previous : {
    key, taskId: task.id, index, startAt: step.baseline.timestampMs,
    baseline: levelAt(evidence.recent, step.baseline.timestampMs),
    samples: 0, votes: {}, peak: null, lastAt: null,
    gap: false, calibrationChanged: false
  }
  evidence.current = key
}

export function observeIngredientEvidence(state, packet, context, settings = {}) {
  const evidence = ingredientEvidence(state)
  const at = ms(packet.timestamp)
  const valid = packet.weightValid !== false && packet.weight != null && Number.isFinite(Number(packet.weight))
  if (!valid) return []
  const sample = { at, weight: Number(packet.weight) }
  evidence.recent.push(sample)
  evidence.recent = evidence.recent.filter(row => row.at >= at - 10000).slice(-32)
  const slot = evidence.steps[evidence.current]
  if (slot && !slot.finalized && at >= slot.startAt && (slot.endAt == null || at <= slot.endAt)) {
    if (slot.baseline == null && at - slot.startAt <= 3000) slot.baseline = sample.weight
    if (slot.lastAt != null && at - slot.lastAt > 3000) slot.gap = true
    slot.lastAt = at; slot.samples++
    const gain = Math.max(0, sample.weight - (slot.peak ?? slot.baseline ?? sample.weight))
    slot.peak = Math.max(slot.peak ?? sample.weight, sample.weight)
    const name = context.evidenceIngredientName
    if (name) {
      const key = normalizeIngredientName(name)
      const vote = slot.votes[key] ||= { name, gain: 0, samples: 0, reliableLoader: false, pairAmbiguous: false }
      vote.gain += gain; vote.samples++
      vote.reliableLoader ||= context.evidenceSource === 'rtk'
      vote.pairAmbiguous ||= context.pairAmbiguous === true
    }
  }
  const ready = []
  for (const pending of Object.values(evidence.steps)) {
    if (!pending.factId || pending.finalized || pending.endAt == null) continue
    if (at >= pending.endAt || at >= pending.confirmedAt + 3000) {
      ready.push({ type: 'verify', factId: pending.factId, batchId: pending.batchId,
        ...finalizeIngredientEvidence(state, pending, settings) })
    }
  }
  return ready
}

export function finalizeIngredientEvidence(state, slot, settings = {}) {
  const evidence = ingredientEvidence(state)
  const endpoint = levelAt(evidence.recent, slot.endAt)
  const algorithmWeight = endpoint != null && slot.baseline != null && slot.samples >= 2 && !slot.calibrationChanged
    ? roundWeight(Math.max(0, endpoint - slot.baseline)) : null
  const votes = Object.values(slot.votes).sort((a, b) => (b.gain - a.gain) || (b.samples - a.samples))
  let dominant = votes[0] || null
  const tabletName = normalizeIngredientName(slot.tabletName)
  const pairHint = pair(slot.tabletName) && dominant && dominant.pairAmbiguous && !dominant.reliableLoader
  if (pairHint) dominant = { ...dominant, name: slot.tabletName }
  const algorithmIngredientName = dominant?.name || null
  const nameMatches = normalizeIngredientName(algorithmIngredientName) === tabletName
  // Agreement with the tablet is a measurement cross-check, independent of
  // the business rule that permits a plan deviation of up to ten percent.
  const weightMatches = realtimeWeightMatches(slot.tabletWeight, algorithmWeight, settings)
  const verificationStatus = slot.calibrationChanged || algorithmWeight == null || !dominant
    ? 'low_confidence' : !nameMatches || !weightMatches ? 'unconfirmed' : pairHint ? 'low_confidence' : 'confirmed'
  const verificationReason = slot.calibrationChanged ? 'calibration_changed'
    : algorithmWeight == null ? 'insufficient_telemetry'
    : !dominant ? 'host_position_missing'
    : !nameMatches ? 'ingredient_disagreement'
    : !weightMatches ? 'weight_mismatch'
    : pairHint ? 'pair_tablet_hint'
    : dominant.reliableLoader ? 'rtk_algorithm_match' : 'host_algorithm_match'
  slot.finalized = true
  if (evidence.current === slot.key) evidence.current = null
  return { algorithmWeight, algorithmIngredientName, verificationStatus, verificationReason }
}

export function confirmIngredientEvidence(state, task, index, factId, batchId, confirmedAt, settings = {}) {
  const evidence = ingredientEvidence(state)
  const key = `${task.id}:${index}`
  if (!evidence.steps[key]) beginIngredientEvidence(state, task, index)
  const slot = evidence.steps[key]
  Object.assign(slot, { factId, batchId, endAt: task.steps[index].end.timestampMs,
    tabletName: task.steps[index].name, tabletWeight: roundWeight(task.steps[index].actualKg), confirmedAt })
  if (evidence.recent.at(-1)?.at >= slot.endAt || confirmedAt - slot.endAt > 3000)
    return finalizeIngredientEvidence(state, slot, settings)
  return { algorithmWeight: null, algorithmIngredientName: null,
    verificationStatus: 'pending', verificationReason: 'waiting_for_host' }
}

export function buildRealtimeAssessment(batch, planIngredients, settings = {}) {
  const weightTolerance = realtimeWeightTolerance(settings)
  const rows = selectRealtimeFactRows(batch.actualIngredients || [])
  const keys = new Set([...planIngredients.map(row => normalizeIngredientName(row.name)), ...rows.map(row => normalizeIngredientName(row.ingredientName))])
  const summary = []; const violations = []
  for (const key of keys) {
    const facts = rows.filter(row => normalizeIngredientName(row.ingredientName) === key)
    const tablet = facts.filter(row => row.tabletTaskId)
    const planItem = planIngredients.find(row => normalizeIngredientName(row.name) === key)
    const plan = planItem
      ? (tablet.length ? tablet.reduce((sum, row) => sum + Number(row.plannedWeight ?? planItem.targetWeight ?? 0), 0) : Number(planItem.targetWeight || 0))
      : 0
    const rawName = facts[0]?.ingredientName || planItem?.name || key
    const name = rawName && normalizeIngredientName(rawName) !== 'unknown' ? rawName : 'Неизвестный компонент'
    const tabletWeight = tablet.length
      ? roundWeight(tablet.reduce((sum, row) => sum + Number(row.actualWeight || 0), 0))
      : null
    const fact = roundWeight(facts.reduce((sum, row) => sum + effectiveRealtimeWeight(row, settings), 0))
    const algorithmRows = rows.filter(row => normalizeIngredientName(row.algorithmIngredientName || (!row.tabletTaskId ? row.ingredientName : '')) === key &&
      !['calibration_changed', 'rtk_unavailable', 'ingredient_unknown', 'host_position_missing'].includes(row.verificationReason))
    const measuredRows = tablet.length ? tablet : algorithmRows
    const algorithmKnown = tablet.length ? tablet.every(row => row.algorithmWeight != null && row.verificationReason !== 'calibration_changed')
      : algorithmRows.some(row => row.algorithmWeight != null || !row.tabletTaskId)
    const algorithmWeight = algorithmKnown ? roundWeight(measuredRows.reduce((sum, row) => sum + Number(row.algorithmWeight ?? (!row.tabletTaskId ? row.actualWeight : 0) ?? 0), 0)) : null
    const missing = Boolean(batch.endTime && planItem && plan > 0 && fact <= 0)
    const extra = Boolean(!planItem && fact > 0)
    const red = Boolean(planItem && tablet.length > 0 && exceedsRealtimePlan(fact, plan))
    const algorithmOff = Boolean(planItem && algorithmKnown && exceedsRealtimePlan(algorithmWeight, plan))
    const disagreement = tablet.some(row => row.verificationReason === 'ingredient_disagreement')
    const yellow = !missing && !extra && !red && (algorithmOff || disagreement)
    const statuses = facts.map(row => row.verificationStatus)
    const verificationStatus = statuses.includes('unconfirmed') ? 'unconfirmed' : statuses.includes('low_confidence') ? 'low_confidence' : statuses.includes('pending') ? 'pending' : statuses.includes('confirmed') ? 'confirmed' : null
    const chosen = facts.find(row => row.verificationStatus === verificationStatus) || facts[0]
    const rowViolations = []
    if (missing) rowViolations.push({
      code: 'MISSING_COMPONENT', source: 'system', severity: 'critical', title: 'Пропуск компонента',
      ingredient: name, plan, fact: 0, message: `Не загружен плановый компонент «${name}».`
    })
    if (extra) rowViolations.push({
      code: 'EXTRA_COMPONENT', source: tablet.length ? 'tablet' : 'system', severity: 'critical', title: 'Лишний компонент',
      ingredient: name, plan: 0, fact, message: `Загружен компонент вне плана: «${name}», ${fact} кг.`
    })
    if (red) rowViolations.push({
      code: 'TABLET_DEVIATION', source: 'tablet', severity: 'critical', title: 'Отклонение подтверждено планшетом',
      ingredient: name, plan, fact,
      message: tabletWeight !== null && fact !== tabletWeight
        ? `План ${roundWeight(plan)} кг, рабочий вес алгоритма ${fact} кг (планшет ${tabletWeight} кг): отклонение больше 10%.`
        : `План ${roundWeight(plan)} кг, планшет ${fact} кг: отклонение больше 10%.`
    })
    if (yellow) rowViolations.push({
      code: disagreement ? 'ALGORITHM_INGREDIENT_MISMATCH' : 'ALGORITHM_DEVIATION',
      source: 'algorithm', severity: 'warning', title: 'Алгоритм не согласен', ingredient: name, plan,
      fact: algorithmWeight ?? fact,
      message: disagreement
        ? `Планшет: ${name}; GPS алгоритма: ${chosen?.algorithmIngredientName || 'другой компонент'}.`
        : `План ${roundWeight(plan)} кг, алгоритм ${algorithmWeight} кг; планшет ${tablet.length ? fact + ' кг' : 'не подтвердил нарушение'}.`
    })
    violations.push(...rowViolations)
    const critical = rowViolations.some(row => row.severity === 'critical')
    const warning = rowViolations.some(row => row.severity === 'warning')
    summary.push({ name, plan: roundWeight(plan), fact, tabletWeight, algorithmWeight,
      weightTolerancePercent: weightTolerance.percent, weightToleranceMinKg: weightTolerance.minKg,
      algorithmIngredientName: chosen?.algorithmIngredientName || null,
      tabletTaskId: tablet[0]?.tabletTaskId || null,
      verificationStatus, verificationReason: chosen?.verificationReason || null,
      deviation_percent: plan > 0 ? Math.round((fact - plan) / plan * 1000) / 10 : fact > 0 ? 100 : 0,
      is_violation: critical, isViolation: critical, violationStatus: critical ? 'critical' : warning ? 'warning' : 'none',
      violationCodes: rowViolations.map(row => row.code), violationMessages: rowViolations.map(row => row.message),
      isCompound: Boolean(planItem?.isCompound), components: [], planItem })
  }

  for (const order of buildOrderViolations(planIngredients, rows)) {
    const violation = { ...order, source: 'system', severity: 'critical', title: 'Нарушен порядок загрузки' }
    violations.push(violation)
    const item = summary.find(row => normalizeIngredientName(row.name) === normalizeIngredientName(order.ingredient))
    if (item) {
      item.is_violation = true; item.isViolation = true; item.violationStatus = 'critical'
      item.violationCodes = [...new Set([...(item.violationCodes || []), 'ORDER_MISMATCH'])]
      item.violationMessages = [...(item.violationMessages || []), order.message]
    }
  }

  return {
    summary, violations,
    hasCritical: violations.some(row => row.severity === 'critical'),
    hasWarning: violations.some(row => row.severity === 'warning')
  }
}

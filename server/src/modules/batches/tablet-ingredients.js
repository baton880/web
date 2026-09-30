import { normalizeIngredientName } from '../../../../module-2/rationManager.js'
import { roundWeight } from '../../../../module-2/weightRounding.js'

const ASSOCIATION_TOLERANCE_MS = 3 * 60 * 1000
const STRAW = normalizeIngredientName('Солома')
const ALFALFA = normalizeIngredientName('Люцерна')

const ms = value => {
  const result = value instanceof Date ? value.getTime() : Number(value)
  return Number.isFinite(result) ? result : null
}

export function selectTabletTask(batch, tasks) {
  const start = new Date(batch.startTime).getTime()
  const end = new Date(batch.endTime).getTime()
  const candidates = tasks.flatMap(row => {
    let state
    try { state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state } catch { return [] }
    const first = ms(state?.steps?.[0]?.baseline?.timestampMs)
    const last = ms(state?.lastEventAt)
    if (state?.status !== 'completed' || !first || !last ||
        first < start - ASSOCIATION_TOLERANCE_MS || first > end + ASSOCIATION_TOLERANCE_MS ||
        last > end + ASSOCIATION_TOLERANCE_MS || last < start) return []
    if (Number(state.groupId) !== Number(batch.groupId) || Number(state.rationId) !== Number(batch.rationId)) return []
    if (!state.steps?.length || state.steps.some(step => !step.end || !Number.isFinite(Number(step.actualKg)))) return []
    return [{ ...state, associationDistanceMs: Math.abs(first - start) }]
  }).sort((a, b) => a.associationDistanceMs - b.associationDistanceMs)
  // Two completed tasks in one batch cannot be attributed safely by time alone.
  return candidates.length === 1 ? candidates[0] : null
}

export async function findTabletTaskForBatch(prisma, batch) {
  if (!prisma.loaderTask || !batch?.endTime) return null
  const start = new Date(batch.startTime).getTime()
  const end = new Date(batch.endTime).getTime()
  const tasks = await prisma.loaderTask.findMany({
    where: {
      deviceId: batch.deviceId,
      status: 'completed',
      // Offline plans may have been created long before the first button press.
      createdAt: { gte: BigInt(start - 7 * 86400000), lte: BigInt(end + ASSOCIATION_TOLERANCE_MS) }
    },
    select: { id: true, state: true },
    orderBy: { createdAt: 'desc' }
  })
  const task = selectTabletTask(batch, tasks)
  if (!task) return null
  const first = ms(task.steps[0].baseline.timestampMs)
  const adjacentBatches = await prisma.batch.findMany({
    where: {
      deviceId: batch.deviceId, groupId: batch.groupId, rationId: batch.rationId,
      startTime: { lte: new Date(first + ASSOCIATION_TOLERANCE_MS) },
      endTime: { gte: new Date(first - ASSOCIATION_TOLERANCE_MS) }
    },
    select: { id: true, startTime: true }
  })
  adjacentBatches.sort((a, b) =>
    Math.abs(new Date(a.startTime).getTime() - first) - Math.abs(new Date(b.startTime).getTime() - first) || a.id - b.id)
  return adjacentBatches[0]?.id === batch.id ? task : null
}

export function verifyTabletSteps(task, detectedIngredients = []) {
  return task.steps.map(step => {
    const start = ms(step.baseline?.timestampMs)
    const end = ms(step.end?.timestampMs)
    const tabletName = normalizeIngredientName(step.name)
    const candidates = detectedIngredients.flatMap(detected => {
      const detectedStart = new Date(detected.startedAt).getTime()
      const detectedEnd = new Date(detected.addedAt).getTime()
      if (!Number.isFinite(detectedStart) || !Number.isFinite(detectedEnd) ||
          detectedEnd < start || detectedStart > end) return []
      const duration = Math.max(1, detectedEnd - detectedStart)
      const overlap = Math.max(0, Math.min(end, detectedEnd) - Math.max(start, detectedStart))
      const fraction = detectedEnd === detectedStart ? 1 : overlap / duration
      return [{ ...detected, contributionKg: Number(detected.actualWeight || 0) * fraction }]
    })
    const guesses = new Map()
    for (const row of candidates) {
      const key = normalizeIngredientName(row.ingredientName)
      if (!key || key === 'unknown') continue
      const guess = guesses.get(key) || { name: row.ingredientName, weight: 0 }
      guess.weight += row.contributionKg
      guesses.set(key, guess)
    }
    const dominant = [...guesses.values()].sort((a, b) => b.weight - a.weight)[0] || null
    const matching = guesses.get(tabletName)
    const detectedWeight = matching?.weight || 0
    const actualWeight = Number(step.actualKg)
    const weightMatches = Math.abs(detectedWeight - actualWeight) <= Math.max(30, actualWeight * 0.1)
    const isStrawOrAlfalfa = tabletName === STRAW || tabletName === ALFALFA
    const loaderPositionReliable = candidates.some(row => row.determination?.positionDebug?.loaderEligible === true)
    let verificationStatus = 'unconfirmed'
    let verificationReason = matching ? 'weight_mismatch' : 'ingredient_not_detected'
    if (isStrawOrAlfalfa && !loaderPositionReliable) {
      verificationStatus = 'low_confidence'
      verificationReason = 'loader_position_uncertain'
    } else if (matching && dominant && normalizeIngredientName(dominant.name) === tabletName && weightMatches) {
      verificationStatus = 'confirmed'
      verificationReason = 'algorithm_match'
    } else if (dominant && normalizeIngredientName(dominant.name) !== tabletName) {
      verificationReason = 'ingredient_disagreement'
    }
    return {
      ingredientName: step.name,
      actualWeight,
      startedAt: new Date(start),
      addedAt: new Date(end),
      tabletTaskId: task.id,
      verificationStatus,
      verificationReason,
      algorithmIngredientName: dominant?.name || null,
      algorithmWeight: dominant ? roundWeight(dominant.weight) : null,
      startLat: null, startLon: null, endLat: null, endLon: null
    }
  })
}

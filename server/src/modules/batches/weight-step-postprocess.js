const WEIGHT_FILTER = {
  source: 'rawWeight',
  hampelRadius: 10,
  hampelSigma: 1,
  rollingMedianRadius: 8,
  roundToKg: 5
}
const HOST_SPEED_FILTER = {
  source: 'speedKmh',
  hampelRadius: 32,
  hampelSigma: 10,
  rollingMedianRadius: 6
}
const BUFFER_OVERLAP_WINDOW_MS = 10 * 1000
const BUFFER_OVERLAP_MAX_DISTANCE_M = 50

export const DEFAULT_WEIGHT_STEP_POSTPROCESS_OPTIONS = {
  minLoadStepKg: 20,
  minUnloadStepKg: 70,
  stableRadius: 10,
  stableRangeKg: 50,
  restPlateauEnabled: true,
  restPlateauRadius: 10,
  restPlateauRangeKg: 55,
  restPlateauMinPoints: 4,
  restPlateauMaxSec: 0,
  restPlateauMergeGapSec: 45,
  restPlateauSameKg: 5,
  restPlateauMinDurationSec: 300,
  restPlateauLookbackMinutes: 15,
  restPlateauReturnToleranceKg: 30,
  restPlateauPreBatchMinLeadSec: 180,
  maxLoadTransitionSec: 100000,
  maxUnloadTransitionSec: 545000,
  anchorSec: 15,
  weightScale: 1.048,
  loadDriftMaxKg: 70,
  loadForceKg: 120,
  loadMovingSpeedKmh: 0,
  loadMovingMaxPct: 60,
  loadBoundaryStopWindowSec: 20,
  loadBoundaryStopSpeedKmh: 0.5,
  loadBoundaryStopMinPoints: 2,
  maxPlateauSec: 60,
  loadMergeGapSec: 10,
  boundaryMinExtendMs: 3 * 60 * 1000,
  boundarySpeedKmh: 0,
  stableMinPoints: 4,
  plateauMergeGapSec: 0,
  samePlateauKg: 5,
  bounceWindowSec: 0,
  bounceReturnKg: 70,
  movementDipKg: 80,
  movementDipSpeedKmh: 3,
  edgePlateauMinSec: 40,
  edgePlateauMaxSec: 60,
  edgePlateauRangeKg: 25,
  startSoftWindowMs: 4 * 60 * 1000,
  startSoftMinLoadKg: 30,
  startSoftPlateauMinSec: 20,
  startSoftPlateauRangeKg: 30,
  rawCutoffKg: -1000,
  rawCutoffDropKg: 500,
  excludeBounceDips: true,
  speedOffsetSec: 0
}

export function resolveWeightStepOptions(overrides = {}) {
  const source = overrides && typeof overrides === 'object' ? overrides : {}
  const options = { ...DEFAULT_WEIGHT_STEP_POSTPROCESS_OPTIONS }

  for (const key of Object.keys(options)) {
    if (source[key] === undefined || source[key] === null || source[key] === '') {
      continue
    }

    if (typeof options[key] === 'boolean') {
      options[key] = Boolean(source[key])
      continue
    }

    const parsed = Number(source[key])
    if (Number.isFinite(parsed)) {
      options[key] = parsed
    }
  }

  if (!(Number(options.weightScale) > 0)) {
    options.weightScale = DEFAULT_WEIGHT_STEP_POSTPROCESS_OPTIONS.weightScale
  }
  if (!(Number(options.stableMinPoints) >= 2)) {
    options.stableMinPoints = DEFAULT_WEIGHT_STEP_POSTPROCESS_OPTIONS.stableMinPoints
  }
  if (!(Number(options.stableRadius) >= 1)) {
    options.stableRadius = DEFAULT_WEIGHT_STEP_POSTPROCESS_OPTIONS.stableRadius
  }
  if (!(Number(options.restPlateauRadius) >= 1)) {
    options.restPlateauRadius = DEFAULT_WEIGHT_STEP_POSTPROCESS_OPTIONS.restPlateauRadius
  }
  if (!(Number(options.restPlateauMinPoints) >= 2)) {
    options.restPlateauMinPoints = DEFAULT_WEIGHT_STEP_POSTPROCESS_OPTIONS.restPlateauMinPoints
  }

  const analysisStartMs = timestampMs(source.analysisStartTime ?? source.analysisStartMs)
  if (Number.isFinite(analysisStartMs)) {
    options.analysisStartMs = analysisStartMs
  }

  return options
}

function timestampMs(value) {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function isExplicitlyInvalidWeight(point) {
  return point?.weightValid === false || point?.weightValid === 0
}

function hasTrackCoordinates(point) {
  const lat = Number(point?.lat)
  const lon = Number(point?.lon)
  return Number.isFinite(lat)
    && Number.isFinite(lon)
    && Math.abs(lat) <= 90
    && Math.abs(lon) <= 180
    && !(lat === 0 && lon === 0)
}

function trackDistanceMeters(left, right) {
  if (!hasTrackCoordinates(left) || !hasTrackCoordinates(right)) return Number.POSITIVE_INFINITY

  const toRadians = (degrees) => degrees * Math.PI / 180
  const earthRadiusMeters = 6371000
  const lat1 = toRadians(Number(left.lat))
  const lat2 = toRadians(Number(right.lat))
  const deltaLat = toRadians(Number(right.lat) - Number(left.lat))
  const deltaLon = toRadians(Number(right.lon) - Number(left.lon))
  const sinLat = Math.sin(deltaLat / 2)
  const sinLon = Math.sin(deltaLon / 2)
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function compareTrackPoints(left, right) {
  const leftMs = timestampMs(left?.timestamp)
  const rightMs = timestampMs(right?.timestamp)
  if (leftMs !== rightMs) return (leftMs ?? 0) - (rightMs ?? 0)

  if (isExplicitlyInvalidWeight(left) !== isExplicitlyInvalidWeight(right)) {
    return isExplicitlyInvalidWeight(left) ? 1 : -1
  }

  const leftReceivedMs = timestampMs(left?.receivedAt)
  const rightReceivedMs = timestampMs(right?.receivedAt)
  if (leftReceivedMs !== rightReceivedMs) return (leftReceivedMs ?? 0) - (rightReceivedMs ?? 0)

  return Number(left?.id || 0) - Number(right?.id || 0)
}

function removeOverlappingBufferedTrackPoints(points = []) {
  const ordered = (Array.isArray(points) ? points : []).slice().sort(compareTrackPoints)
  const reliablePoints = ordered.filter((point) => !isExplicitlyInvalidWeight(point) && hasTrackCoordinates(point))

  return ordered.filter((point) => {
    if (!isExplicitlyInvalidWeight(point) || !hasTrackCoordinates(point)) return true

    const pointMs = timestampMs(point.timestamp)
    if (!Number.isFinite(pointMs)) return true

    const overlappingReliablePoint = reliablePoints.find((candidate) => {
      const candidateMs = timestampMs(candidate.timestamp)
      return Number.isFinite(candidateMs)
        && Math.abs(candidateMs - pointMs) <= BUFFER_OVERLAP_WINDOW_MS
        && trackDistanceMeters(candidate, point) > BUFFER_OVERLAP_MAX_DISTANCE_M
    })

    return !overlappingReliablePoint
  })
}

function finiteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base + 1] === undefined ? sorted[base] : sorted[base] + rest * (sorted[base + 1] - sorted[base])
}

function rollingMedian(values, radius) {
  if (!(radius > 0)) return values.slice()
  return values.map((value, index) => {
    const slice = values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1))
    return median(slice) ?? value
  })
}

function hampel(values, radius, sigma) {
  return values.map((value, index) => {
    if (!Number.isFinite(value)) return value
    const slice = values
      .slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1))
      .filter(Number.isFinite)
    const med = median(slice)
    if (!Number.isFinite(med)) return value
    const mad = median(slice.map((item) => Math.abs(item - med)))
    const threshold = sigma * 1.4826 * (mad || 1)
    return Math.abs(value - med) > threshold ? med : value
  })
}

function roundStep(value, step = WEIGHT_FILTER.roundToKg) {
  if (!Number.isFinite(Number(value))) return value
  const rounded = Math.round(Number(value) / step) * step
  return Object.is(rounded, -0) ? 0 : rounded
}

function eventLevel(value) {
  return roundStep(Number(value), WEIGHT_FILTER.roundToKg)
}

function eventDelta(beforeLevel, afterLevel) {
  if (!Number.isFinite(beforeLevel) || !Number.isFinite(afterLevel)) return null
  return eventLevel(afterLevel) - eventLevel(beforeLevel)
}

function scaleWeight(value, scale) {
  return Number.isFinite(value) ? value * scale : value
}

function summarizePoints(points, anchorMs = null, preferEnd = false) {
  let selected = points
  if (Number.isFinite(anchorMs)) {
    selected = preferEnd
      ? points.filter((point) => point.x >= points[points.length - 1].x - anchorMs)
      : points.filter((point) => point.x <= points[0].x + anchorMs)
    if (selected.length < 2) selected = points
  }
  const weights = selected.map((point) => point.filtered).filter(Number.isFinite)
  const speeds = selected.map((point) => point.speed).filter(Number.isFinite)
  return {
    level: median(weights),
    q10: quantile(weights, 0.1),
    q90: quantile(weights, 0.9),
    points: selected.length,
    avgSpeed: speeds.length ? speeds.reduce((sum, item) => sum + Math.abs(item), 0) / speeds.length : null
  }
}

function plateauLevel(plateau, side, opts) {
  if (Number.isFinite(plateau?.level)) return plateau.level
  const anchor = side === 'right' ? plateau?.beforeAnchor : plateau?.afterAnchor
  if (anchor && Number.isFinite(anchor.level)) return anchor.level
  const source = Array.isArray(plateau?.source) ? plateau.source : []
  return summarizePoints(source, opts.anchorSec * 1000, side === 'right').level
}

function splitStableRun(run, opts) {
  const maxMs = Number(opts.maxPlateauSec) > 0 ? Number(opts.maxPlateauSec) * 1000 : 0
  if (!maxMs || run.length < 2 || run[run.length - 1].x - run[0].x <= maxMs) {
    return [{ points: run, capped: false }]
  }

  const startEndMs = run[0].x + maxMs
  const endStartMs = run[run.length - 1].x - maxMs
  const startPart = run.filter((point) => point.x <= startEndMs)
  const endPart = run.filter((point) => point.x >= endStartMs)
  const parts = []
  if (startPart.length >= opts.stableMinPoints) parts.push({ points: startPart, capped: true })
  if (
    endPart.length >= opts.stableMinPoints &&
    (!startPart.length || endPart[0].x > startPart[startPart.length - 1].x)
  ) {
    parts.push({ points: endPart, capped: true })
  }
  return parts.length ? parts : [{ points: run, capped: false }]
}

function decoratePlateaus(plateaus, opts) {
  const anchorMs = opts.anchorSec * 1000
  return plateaus.map((plateau, index) => ({
    ...plateau,
    index,
    beforeAnchor: summarizePoints(plateau.source, anchorMs, true),
    afterAnchor: summarizePoints(plateau.source, anchorMs, false)
  }))
}

function normalizeTelemetryRows(rows = [], opts) {
  const scale = Number.isFinite(opts.weightScale) && opts.weightScale > 0 ? opts.weightScale : 1
  const speedOffsetMs = Number.isFinite(Number(opts.speedOffsetSec)) ? Number(opts.speedOffsetSec) * 1000 : 0
  const points = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: row.id ?? null,
      x: timestampMs(row.timestamp ?? row.t),
      receivedAt: row.receivedAt ?? row.received_at ?? null,
      raw: scaleWeight(finiteNumber(row.rawWeight ?? row.raw_weight ?? row.r), scale),
      weight: scaleWeight(finiteNumber(row.weight ?? row.w), scale),
      weightValid: row.weightValid ?? row.weight_valid ?? null,
      rawSpeed: finiteNumber(row.speedKmh ?? row.speed_kmh ?? row.s),
      lat: finiteNumber(row.lat),
      lon: finiteNumber(row.lon),
      original: row
    }))
    .filter((point) => Number.isFinite(point.x))
    .sort((left, right) => left.x - right.x || Number(left.id || 0) - Number(right.id || 0))

  const filteredSpeeds = rollingMedian(
    hampel(points.map((point) => point.rawSpeed), HOST_SPEED_FILTER.hampelRadius, HOST_SPEED_FILTER.hampelSigma),
    HOST_SPEED_FILTER.rollingMedianRadius
  )
  return points.map((point, index) => ({
      ...point,
      speed: filteredSpeeds[index],
      speedX: point.x + speedOffsetMs
    }))
}

export function hasUsableRawWeight(rows = []) {
  const points = Array.isArray(rows) ? rows : []
  const rawCount = points.reduce((sum, row) => (
    sum + (Number.isFinite(Number(row?.rawWeight ?? row?.raw_weight ?? row?.r)) ? 1 : 0)
  ), 0)
  return rawCount >= Math.max(10, Math.ceil(points.length * 0.2))
}

export function buildFilteredWeightPoints(rows = [], rawOptions = {}) {
  const opts = resolveWeightStepOptions(rawOptions)
  const points = normalizeTelemetryRows(rows, opts)
    .filter((point) => !isExplicitlyInvalidWeight(point))
    .filter((point) => Number.isFinite(point.raw) || Number.isFinite(point.weight))

  const cutoffKg = Number(opts.rawCutoffKg)
  const cutoffDropKg = Number(opts.rawCutoffDropKg)
  let usablePoints = points
  let terminalCutoff = false
  if (Number.isFinite(cutoffKg) && Number.isFinite(cutoffDropKg) && cutoffDropKg >= 0) {
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]
      const current = points[index]
      if (
        Number.isFinite(previous.raw) &&
        Number.isFinite(current.raw) &&
        previous.raw > cutoffKg &&
        current.raw < cutoffKg &&
        previous.raw - current.raw >= cutoffDropKg
      ) {
        usablePoints = points.slice(0, index)
        terminalCutoff = true
        break
      }
    }
  }

  const rawValues = usablePoints.map((point) => Number.isFinite(point.raw) ? point.raw : point.weight)
  const filtered = rollingMedian(
    hampel(rawValues, WEIGHT_FILTER.hampelRadius, WEIGHT_FILTER.hampelSigma),
    WEIGHT_FILTER.rollingMedianRadius
  ).map((value) => roundStep(value, WEIGHT_FILTER.roundToKg))

  if (terminalCutoff && filtered.length) {
    filtered[filtered.length - 1] = roundStep(rawValues[rawValues.length - 1], WEIGHT_FILTER.roundToKg)
  }

  return usablePoints
    .map((point, index) => ({
      ...point,
      filtered: filtered[index],
      timestamp: new Date(point.x)
    }))
    .filter((point) => Number.isFinite(point.filtered))
}

function buildPlateaus(points, opts) {
  const marked = points.map((point, index) => {
    const window = points.slice(Math.max(0, index - opts.stableRadius), Math.min(points.length, index + opts.stableRadius + 1))
    const weights = window.map((item) => item.filtered).filter(Number.isFinite)
    const q10 = quantile(weights, 0.1)
    const q90 = quantile(weights, 0.9)
    const range = Number.isFinite(q10) && Number.isFinite(q90) ? q90 - q10 : Number.POSITIVE_INFINITY
    return {
      ...point,
      stable: weights.length >= opts.stableMinPoints && range <= opts.stableRangeKg,
      localRangeKg: range
    }
  })

  const runs = []
  let current = []
  for (const point of marked) {
    if (point.stable) {
      current.push(point)
      continue
    }
    if (current.length >= opts.stableMinPoints) runs.push(current)
    current = []
  }
  if (current.length >= opts.stableMinPoints) runs.push(current)

  const plateaus = runs.flatMap((run) => splitStableRun(run, opts)).map((item, index) => {
    const run = item.points
    const summary = summarizePoints(run)
    return {
      index,
      capped: item.capped,
      startMs: run[0].x,
      endMs: run[run.length - 1].x,
      startTime: new Date(run[0].x),
      endTime: new Date(run[run.length - 1].x),
      level: summary.level,
      q10: summary.q10,
      q90: summary.q90,
      points: run.length,
      source: run
    }
  })

  const merged = []
  for (const plateau of plateaus) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      !previous.capped &&
      !plateau.capped &&
      plateau.startMs - previous.endMs <= opts.plateauMergeGapSec * 1000 &&
      Math.abs(Number(plateau.level) - Number(previous.level)) <= opts.samePlateauKg
    ) {
      const source = previous.source.concat(plateau.source)
      const summary = summarizePoints(source)
      previous.endMs = plateau.endMs
      previous.endTime = plateau.endTime
      previous.level = summary.level
      previous.q10 = summary.q10
      previous.q90 = summary.q90
      previous.points = source.length
      previous.source = source
      continue
    }
    merged.push({ ...plateau })
  }

  return decoratePlateaus(merged, opts)
}

export function buildRestPlateaus(points, opts) {
  if (!opts.restPlateauEnabled) return []

  const restOptions = {
    ...opts,
    stableRadius: opts.restPlateauRadius,
    stableRangeKg: opts.restPlateauRangeKg,
    stableMinPoints: opts.restPlateauMinPoints,
    maxPlateauSec: opts.restPlateauMaxSec,
    plateauMergeGapSec: opts.restPlateauMergeGapSec,
    samePlateauKg: opts.restPlateauSameKg
  }
  const minDurationMs = Math.max(0, Number(opts.restPlateauMinDurationSec) || 0) * 1000

  return buildPlateaus(points, restOptions)
    .filter((plateau) => plateau.endMs - plateau.startMs >= minDurationMs)
    .map((plateau, index) => ({ ...plateau, index, kind: 'rest' }))
}

function buildTransitionPlateaus(points, from, to, opts, batchStartMs = null) {
  const transitionPoints = points.filter((point) => point.x > from.endMs && point.x < to.startMs)
  if (transitionPoints.length < opts.stableMinPoints) return []

  const minMs = Math.max(0, Number(opts.edgePlateauMinSec) || 0) * 1000
  const fromLevel = eventLevel(plateauLevel(from, 'right', opts))
  const toLevel = eventLevel(plateauLevel(to, 'left', opts))
  const softStartEndMs = Number.isFinite(batchStartMs)
    ? batchStartMs + Math.max(0, Number(opts.startSoftWindowMs) || 0)
    : null

  const marked = transitionPoints.map((point, index) => {
    const window = transitionPoints.slice(Math.max(0, index - opts.stableRadius), Math.min(transitionPoints.length, index + opts.stableRadius + 1))
    const weights = window.map((item) => item.filtered).filter(Number.isFinite)
    const q10 = quantile(weights, 0.1)
    const q90 = quantile(weights, 0.9)
    const range = Number.isFinite(q10) && Number.isFinite(q90) ? q90 - q10 : Number.POSITIVE_INFINITY
    return {
      ...point,
      stable: weights.length >= opts.stableMinPoints && range <= opts.stableRangeKg
    }
  })

  const runs = []
  let current = []
  for (const point of marked) {
    if (point.stable) {
      current.push(point)
      continue
    }
    if (current.length >= opts.stableMinPoints) runs.push(current)
    current = []
  }
  if (current.length >= opts.stableMinPoints) runs.push(current)

  const candidates = []
  const addCandidate = (run, capped = false, reason = 'stable-transition') => {
    const summary = summarizePoints(run)
    if (!Number.isFinite(summary.level)) return
    const candidate = {
      synthetic: true,
      inserted: true,
      insertedReason: reason,
      capped,
      startMs: run[0].x,
      endMs: run[run.length - 1].x,
      startTime: new Date(run[0].x),
      endTime: new Date(run[run.length - 1].x),
      level: summary.level,
      q10: summary.q10,
      q90: summary.q90,
      points: run.length,
      source: run
    }
    if (!candidates.some((item) => candidate.startMs <= item.endMs && candidate.endMs >= item.startMs)) {
      candidates.push(candidate)
    }
  }

  for (const item of runs.flatMap((run) => splitStableRun(run, opts))) {
    const run = item.points
    const durationMs = run[run.length - 1].x - run[0].x
    if (minMs && durationMs + 1000 < minMs) continue
    addCandidate(run, item.capped)
  }

  const inStartSoftZone = Number.isFinite(softStartEndMs) &&
    from.endMs <= softStartEndMs &&
    transitionPoints[0]?.x <= softStartEndMs

  if (inStartSoftZone && Number.isFinite(fromLevel) && Number.isFinite(toLevel) && toLevel - fromLevel >= 150) {
    let flatRun = []
    const flushFlatRun = () => {
      if (flatRun.length >= opts.stableMinPoints) {
        const durationMs = flatRun[flatRun.length - 1].x - flatRun[0].x
        const weights = flatRun.map((point) => point.filtered).filter(Number.isFinite)
        const level = eventLevel(median(weights))
        const firstDelta = level - fromLevel
        const remainingDelta = toLevel - level
        if (
          durationMs >= Math.max(0, Number(opts.startSoftPlateauMinSec) || 0) * 1000 &&
          firstDelta >= opts.startSoftMinLoadKg &&
          firstDelta < 150 &&
          remainingDelta >= opts.minLoadStepKg
        ) {
          addCandidate(flatRun, false, 'short-load-shelf')
        }
      }
      flatRun = []
    }

    for (const point of transitionPoints) {
      const nextRun = flatRun.concat(point)
      const weights = nextRun.map((item) => item.filtered).filter(Number.isFinite)
      const range = Math.max(...weights) - Math.min(...weights)
      const net = Math.abs(nextRun[nextRun.length - 1].filtered - nextRun[0].filtered)
      if (range <= opts.startSoftPlateauRangeKg && net <= opts.startSoftPlateauRangeKg) {
        flatRun = nextRun
      } else {
        flushFlatRun()
        flatRun = [point]
      }
    }
    flushFlatRun()
  }

  const firstShortShelfIndex = candidates.findIndex((candidate) => candidate.insertedReason === 'short-load-shelf')
  if (firstShortShelfIndex >= 0) {
    return candidates.filter((candidate, index) =>
      candidate.insertedReason !== 'short-load-shelf' || index === firstShortShelfIndex
    )
  }

  return candidates
}

function insertTransitionPlateaus(points, plateaus, opts, batchStartMs = null) {
  if (plateaus.length < 2) return plateaus
  const result = []
  for (let index = 0; index < plateaus.length - 1; index += 1) {
    const from = plateaus[index]
    const to = plateaus[index + 1]
    result.push(from)
    const candidates = buildTransitionPlateaus(points, from, to, opts, batchStartMs)
    for (const candidate of candidates) {
      const farFromLeft = candidate.startMs - from.endMs > 1000
      const farFromRight = to.startMs - candidate.endMs > 1000
      if (farFromLeft && farFromRight) result.push(candidate)
    }
  }
  result.push(plateaus[plateaus.length - 1])
  result.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  return decoratePlateaus(result, opts)
}

function speedSummary(points, fromMs, toMs, movingSpeedKmh = 0.1) {
  const selected = points.filter((point) => {
    const speedX = Number.isFinite(point.speedX) ? point.speedX : point.x
    return speedX >= fromMs && speedX <= toMs
  })
  const speeds = selected.map((point) => Math.abs(point.speed)).filter(Number.isFinite)
  if (!speeds.length) return { avg: null, max: null, movingPct: null }
  let movingMs = 0
  let coveredMs = 0
  for (let index = 0; index < selected.length; index += 1) {
    const point = selected[index]
    const next = selected[index + 1]
    const pointSpeedX = Number.isFinite(point.speedX) ? point.speedX : point.x
    const nextSpeedX = Number.isFinite(next?.speedX) ? next.speedX : next?.x
    const segmentStart = Math.max(fromMs, pointSpeedX)
    const segmentEnd = Math.min(toMs, nextSpeedX ?? toMs)
    const segmentMs = Math.max(0, segmentEnd - segmentStart)
    if (!segmentMs) continue
    coveredMs += segmentMs
    if (Number.isFinite(point.speed) && Math.abs(point.speed) > movingSpeedKmh) {
      movingMs += segmentMs
    }
  }
  return {
    avg: speeds.reduce((sum, item) => sum + item, 0) / speeds.length,
    max: Math.max(...speeds),
    movingPct: coveredMs > 0 ? (movingMs / coveredMs) * 100 : null
  }
}

function stationaryPointCount(points, fromMs, toMs, maxSpeedKmh) {
  return points.reduce((count, point) => {
    const speedX = Number.isFinite(point.speedX) ? point.speedX : point.x
    const speed = Math.abs(Number(point.speed))
    return speedX >= fromMs &&
      speedX <= toMs &&
      Number.isFinite(speed) &&
      speed <= maxSpeedKmh
      ? count + 1
      : count
  }, 0)
}

function loadBoundaryStopEvidence(points, startMs, endMs, opts) {
  const windowMs = Math.max(0, Number(opts.loadBoundaryStopWindowSec) || 0) * 1000
  const maxSpeedKmh = Math.max(0, Number(opts.loadBoundaryStopSpeedKmh) || 0)
  const minPoints = Math.max(1, Math.trunc(Number(opts.loadBoundaryStopMinPoints) || 1))
  if (!windowMs) {
    return { before: false, after: false, beforePoints: 0, afterPoints: 0 }
  }

  const afterPoints = stationaryPointCount(points, endMs, endMs + windowMs, maxSpeedKmh)
  return {
    before: false,
    after: afterPoints >= minPoints,
    beforePoints: 0,
    afterPoints
  }
}

function eventKind(delta) {
  if (delta > 0) return 'load'
  if (delta < 0) return 'unload'
  return 'flat'
}

function summarizeEdgePlateau(points) {
  const weights = points.map((point) => point.filtered).filter(Number.isFinite)
  return {
    startMs: points[0].x,
    endMs: points[points.length - 1].x,
    level: median(weights),
    range: (quantile(weights, 0.9) ?? Number.POSITIVE_INFINITY) - (quantile(weights, 0.1) ?? 0),
    points: points.length
  }
}

function findEdgePlateau(points, side, opts) {
  const minMs = Math.max(0, Number(opts.edgePlateauMinSec) || 0) * 1000
  const maxMs = Math.max(minMs, Number(opts.edgePlateauMaxSec) || 0) * 1000
  if (!minMs || points.length < opts.stableMinPoints) return null

  const ordered = side === 'start' ? points : points.slice().reverse()
  const origin = ordered[0].x
  let best = null
  for (let count = opts.stableMinPoints; count <= ordered.length; count += 1) {
    const candidate = ordered.slice(0, count).slice().sort((left, right) => left.x - right.x)
    const durationMs = candidate[candidate.length - 1].x - candidate[0].x
    const edgeDurationMs = Math.abs(ordered[count - 1].x - origin)
    if (edgeDurationMs > maxMs) break
    if (durationMs < minMs) continue
    const summary = summarizeEdgePlateau(candidate)
    const net = Math.abs(candidate[candidate.length - 1].filtered - candidate[0].filtered)
    if (
      Number.isFinite(summary.level) &&
      summary.range <= opts.edgePlateauRangeKg &&
      net <= opts.edgePlateauRangeKg
    ) {
      best = summary
    }
  }
  return best
}

function trimTransitionEdges(points, from, to, opts) {
  const leftLevel = plateauLevel(from, 'right', opts)
  const rightLevel = plateauLevel(to, 'left', opts)
  const leftPlateauStartMs = Math.max(from.startMs, from.endMs - opts.anchorSec * 1000)
  const leftPlateauEndMs = from.endMs
  const rightPlateauStartMs = to.startMs
  const rightPlateauEndMs = Math.min(to.endMs, to.startMs + opts.anchorSec * 1000)
  const transitionPoints = points.filter((point) => point.x >= from.endMs && point.x <= to.startMs)
  if (transitionPoints.length < opts.stableMinPoints * 2) {
    return {
      startMs: from.endMs,
      endMs: to.startMs,
      beforeLevel: leftLevel,
      afterLevel: rightLevel,
      beforePlateauStartMs: leftPlateauStartMs,
      beforePlateauEndMs: leftPlateauEndMs,
      afterPlateauStartMs: rightPlateauStartMs,
      afterPlateauEndMs: rightPlateauEndMs,
      edgeStart: null,
      edgeEnd: null
    }
  }

  const edgeStart = findEdgePlateau(transitionPoints, 'start', opts)
  const afterStartMs = edgeStart ? edgeStart.endMs : from.endMs
  const endCandidates = transitionPoints.filter((point) => point.x >= afterStartMs)
  const edgeEnd = findEdgePlateau(endCandidates, 'end', opts)
  const startMs = edgeStart ? edgeStart.endMs : from.endMs
  const endMs = edgeEnd ? edgeEnd.startMs : to.startMs

  if (startMs >= endMs) {
    return {
      startMs: from.endMs,
      endMs: to.startMs,
      beforeLevel: leftLevel,
      afterLevel: rightLevel,
      beforePlateauStartMs: leftPlateauStartMs,
      beforePlateauEndMs: leftPlateauEndMs,
      afterPlateauStartMs: rightPlateauStartMs,
      afterPlateauEndMs: rightPlateauEndMs,
      edgeStart: null,
      edgeEnd: null
    }
  }

  return {
    startMs,
    endMs,
    beforeLevel: leftLevel,
    afterLevel: rightLevel,
    beforePlateauStartMs: leftPlateauStartMs,
    beforePlateauEndMs: leftPlateauEndMs,
    afterPlateauStartMs: rightPlateauStartMs,
    afterPlateauEndMs: rightPlateauEndMs,
    edgeStart,
    edgeEnd
  }
}

function moving(point, opts) {
  return Number.isFinite(point?.speed) && Math.abs(point.speed) > opts.boundarySpeedKmh
}

function findAnalysisBounds(points, batchStartMs, batchEndMs, opts) {
  const explicitStartMs = Number.isFinite(opts.analysisStartMs) ? opts.analysisStartMs : null
  const minStart = explicitStartMs ?? (batchStartMs - opts.boundaryMinExtendMs)
  const minEnd = batchEndMs + opts.boundaryMinExtendMs
  const firstPointMs = points[0]?.x ?? minStart
  const lastPointMs = points[points.length - 1]?.x ?? minEnd
  let startMs = Math.max(firstPointMs, minStart)
  let endMs = Math.min(lastPointMs, minEnd)

  if (explicitStartMs === null) {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const point = points[index]
      const speedX = Number.isFinite(point.speedX) ? point.speedX : point.x
      if (speedX > minStart) continue
      if (moving(point, opts)) {
        startMs = Math.max(firstPointMs, speedX)
        break
      }
    }
  }

  for (const point of points) {
    const speedX = Number.isFinite(point.speedX) ? point.speedX : point.x
    if (speedX < minEnd) continue
    if (moving(point, opts)) {
      endMs = Math.min(lastPointMs, speedX)
      break
    }
  }

  if (startMs >= batchStartMs) startMs = Math.max(firstPointMs, minStart)
  if (endMs <= batchEndMs) endMs = Math.min(lastPointMs, minEnd)

  return { startMs, endMs, minStart, minEnd }
}

function markBounceArtifacts(events, opts) {
  const marked = events.map((event) => {
    const forceLoad = event.delta > 0 && event.absKg >= opts.loadForceKg
    const boundaryStopConfirmed = event.delta > 0 && Boolean(event.boundaryStopAfter)
    const movingSmallDrop = event.delta < 0 &&
      event.absKg <= opts.movementDipKg &&
      Number.isFinite(event.speedAvg) &&
      event.speedAvg >= opts.movementDipSpeedKmh
    const mostlyMovingLoad = event.delta > 0 &&
      !forceLoad &&
      !boundaryStopConfirmed &&
      Number.isFinite(event.movingPct) &&
      event.movingPct > opts.loadMovingMaxPct
    const movingSmallLoad = event.delta > 0 &&
      !forceLoad &&
      !boundaryStopConfirmed &&
      event.absKg <= opts.loadDriftMaxKg &&
      Number.isFinite(event.movingPct) &&
      event.movingPct > Math.min(40, opts.loadMovingMaxPct)
    const artifactReason = mostlyMovingLoad
      ? 'moving-load-percent'
      : movingSmallLoad
        ? 'moving-load-drift'
        : movingSmallDrop
          ? 'moving-dip'
          : ''
    return {
      ...event,
      forceLoad,
      boundaryStopConfirmed,
      artifact: movingSmallDrop || movingSmallLoad || mostlyMovingLoad,
      artifactReason
    }
  })
  if (!opts.excludeBounceDips) return marked

  for (let i = 0; i < marked.length - 1; i += 1) {
    const first = marked[i]
    const second = marked[i + 1]
    const opposite = first.delta * second.delta < 0
    const shortEnough = second.endMs - first.startMs <= opts.bounceWindowSec * 1000
    const returnsNearStart = Math.abs(Number(second.afterLevel) - Number(first.beforeLevel)) <= opts.bounceReturnKg
    if (opposite && shortEnough && returnsNearStart) {
      first.artifact = true
      second.artifact = true
      first.artifactReason = 'rebound'
      second.artifactReason = 'rebound'
      i += 1
    }
  }

  return marked
}

function markBatchLifecycleArtifacts(events) {
  const counted = events.filter((event) => !event.artifact)
  const firstLoad = counted.find((event) => event.delta > 0)
  const lastUnload = counted.slice().reverse().find((event) => event.delta < 0)
  let seenStrongUnload = false
  const strongUnloads = counted.filter((event) => event.delta < 0 && event.absKg > 200)

  return events.map((event) => {
    if (event.artifact) return event
    if (firstLoad && event.delta < 0 && event.endMs <= firstLoad.startMs) {
      return { ...event, artifact: true, artifactReason: 'before-first-load' }
    }
    if (lastUnload && event.delta > 0 && event.startMs >= lastUnload.endMs) {
      return { ...event, artifact: true, artifactReason: 'after-last-unload' }
    }
    if (seenStrongUnload && event.delta > 0 && event.absKg < 150) {
      return { ...event, artifact: true, artifactReason: 'small-load-after-unload' }
    }
    if (event.delta > 0 && event.absKg < 150) {
      const beforeStrongUnload = strongUnloads.some((unload) => {
        const gapMs = unload.startMs - event.endMs
        return gapMs >= 0 && gapMs <= 90 * 1000
      })
      if (beforeStrongUnload) {
        return { ...event, artifact: true, artifactReason: 'small-load-before-unload' }
      }
    }
    if (event.delta < 0 && event.absKg > 200) {
      seenStrongUnload = true
    }
    return event
  })
}

function markRestPlateauArtifacts(events, restPlateaus, opts, batchStartMs) {
  if (!opts.restPlateauEnabled || !Array.isArray(restPlateaus) || !restPlateaus.length) {
    return events
  }

  const returnToleranceKg = Math.max(0, Number(opts.restPlateauReturnToleranceKg) || 0)
  const maxGapMs = Math.max(0, Number(opts.restPlateauMergeGapSec) || 0) * 1000
  const minLeadMs = Math.max(0, Number(opts.restPlateauPreBatchMinLeadSec) || 0) * 1000

  return events.map((event) => {
    if (event.artifact || event.kind !== 'load') return event
    if (!Number.isFinite(batchStartMs) || event.endMs > batchStartMs - minLeadMs) return event

    const coveringPlateau = restPlateaus.find((plateau) => (
      plateau.startMs <= event.startMs && plateau.endMs >= event.endMs
    ))
    if (coveringPlateau) {
      return {
        ...event,
        artifact: true,
        artifactReason: 'rest-plateau-return',
        restBeforeLevel: eventLevel(coveringPlateau.level),
        restAfterLevel: eventLevel(coveringPlateau.level),
        restReturnDeltaKg: 0,
        restGapMs: 0
      }
    }

    let before = null
    let after = null
    for (const plateau of restPlateaus) {
      if (plateau.endMs <= event.startMs) before = plateau
      if (!after && plateau.startMs >= event.endMs) after = plateau
    }
    if (!before || !after) return event

    const gapMs = after.startMs - before.endMs
    const returnDeltaKg = Math.abs(Number(after.level) - Number(before.level))
    if (
      gapMs < 0 ||
      gapMs > maxGapMs ||
      !Number.isFinite(returnDeltaKg) ||
      returnDeltaKg > returnToleranceKg
    ) {
      return event
    }

    return {
      ...event,
      artifact: true,
      artifactReason: 'rest-plateau-return',
      restBeforeLevel: eventLevel(before.level),
      restAfterLevel: eventLevel(after.level),
      restReturnDeltaKg: eventLevel(returnDeltaKg),
      restGapMs: gapMs
    }
  })
}

function mergeCloseLoadEvents(events, points, opts) {
  const maxGapMs = Math.max(0, Number(opts.loadMergeGapSec) || 0) * 1000
  if (!maxGapMs || events.length < 2) return events

  const merged = []
  for (const event of events) {
    const previous = merged[merged.length - 1]
    const gapMs = previous ? event.startMs - previous.endMs : Number.POSITIVE_INFINITY
    if (
      previous &&
      previous.kind === 'load' &&
      event.kind === 'load' &&
      gapMs >= 0 &&
      gapMs < maxGapMs
    ) {
      const beforeLevel = eventLevel(previous.beforeLevel)
      const afterLevel = eventLevel(event.afterLevel)
      const delta = eventDelta(beforeLevel, afterLevel)
      if (!Number.isFinite(delta)) continue
      const speeds = speedSummary(points, previous.startMs, event.endMs, opts.loadMovingSpeedKmh)
      Object.assign(previous, {
        endMs: event.endMs,
        afterPlateauStartMs: event.afterPlateauStartMs,
        afterPlateauEndMs: event.afterPlateauEndMs,
        beforeLevel,
        afterLevel,
        delta,
        absKg: Math.abs(delta),
        transitionMs: event.endMs - previous.startMs,
        speedAvg: speeds.avg,
        speedMax: speeds.max,
        movingPct: speeds.movingPct,
        toPlateau: event.toPlateau,
        mergedCount: Number(previous.mergedCount || 1) + Number(event.mergedCount || 1)
      })
      continue
    }
    merged.push({ ...event, mergedCount: event.mergedCount || 1 })
  }

  return merged.map((event, index) => ({ ...event, id: index + 1 }))
}

function boundaryPlateau(points, side) {
  if (!points.length) return null
  const summary = summarizePoints(points)
  const level = summary.level
  if (!Number.isFinite(level)) return null
  const edgeSummary = { ...summary, level }
  return {
    index: side === 'start' ? -1 : 999999,
    synthetic: true,
    side,
    startMs: points[0].x,
    endMs: points[points.length - 1].x,
    startTime: new Date(points[0].x),
    endTime: new Date(points[points.length - 1].x),
    level,
    q10: summary.q10,
    q90: summary.q90,
    points: points.length,
    source: points,
    beforeAnchor: edgeSummary,
    afterAnchor: edgeSummary
  }
}

function addBoundaryPlateaus(inBatch, plateaus, batchStartMs, batchEndMs, opts) {
  if (!inBatch.length) return plateaus
  const anchorMs = opts.anchorSec * 1000
  const minGapMs = Math.max(5000, anchorMs * 0.45)
  const result = plateaus.slice()
  const startPoints = inBatch.filter((point) => point.x <= batchStartMs + anchorMs)
  const endPoints = inBatch.filter((point) => point.x >= batchEndMs - anchorMs)
  const first = result[0]
  const last = result[result.length - 1]
  const startPlateau = boundaryPlateau(startPoints, 'start')
  const endPlateau = boundaryPlateau(endPoints, 'end')

  if (startPlateau && (!first || first.startMs - startPlateau.endMs >= minGapMs)) {
    result.unshift(startPlateau)
  }
  if (endPlateau && (!last || endPlateau.startMs - last.endMs >= minGapMs)) {
    result.push(endPlateau)
  }

  return result.map((plateau, index) => ({ ...plateau, index }))
}

function serializePoint(point) {
  return {
    id: point.id,
    timestamp: new Date(point.x),
    receivedAt: point.receivedAt || null,
    weight: eventLevel(point.filtered),
    filteredWeight: eventLevel(point.filtered),
    rawWeight: Number.isFinite(point.raw) ? point.raw : null,
    telemetryWeight: Number.isFinite(point.weight) ? point.weight : null,
    weightValid: point.weightValid ?? null,
    rawSpeedKmh: Number.isFinite(point.rawSpeed) ? point.rawSpeed : null,
    speedKmh: Number.isFinite(point.speed) ? point.speed : null,
    speedTimestamp: Number.isFinite(point.speedX) ? new Date(point.speedX) : null,
    lat: Number.isFinite(point.lat) ? point.lat : null,
    lon: Number.isFinite(point.lon) ? point.lon : null
  }
}

function serializePlateau(plateau) {
  return {
    index: plateau.index,
    startTime: new Date(plateau.startMs),
    endTime: new Date(plateau.endMs),
    level: eventLevel(plateau.level),
    points: plateau.points,
    synthetic: Boolean(plateau.synthetic),
    insertedReason: plateau.insertedReason || null
  }
}

function serializeEvent(event) {
  return {
    id: event.id,
    kind: event.kind,
    startTime: new Date(event.startMs),
    endTime: new Date(event.endMs),
    beforePlateauStartTime: new Date(event.beforePlateauStartMs),
    beforePlateauEndTime: new Date(event.beforePlateauEndMs),
    afterPlateauStartTime: new Date(event.afterPlateauStartMs),
    afterPlateauEndTime: new Date(event.afterPlateauEndMs),
    beforeLevel: eventLevel(event.beforeLevel),
    afterLevel: eventLevel(event.afterLevel),
    delta: eventLevel(event.delta),
    absKg: Math.abs(eventLevel(event.delta)),
    transitionMs: event.transitionMs,
    speedAvg: event.speedAvg,
    speedMax: event.speedMax,
    movingPct: event.movingPct,
    boundaryStopBefore: Boolean(event.boundaryStopBefore),
    boundaryStopAfter: Boolean(event.boundaryStopAfter),
    boundaryStopBeforePoints: Number(event.boundaryStopBeforePoints || 0),
    boundaryStopAfterPoints: Number(event.boundaryStopAfterPoints || 0),
    boundaryStopConfirmed: Boolean(event.boundaryStopConfirmed),
    restBeforeLevel: Number.isFinite(event.restBeforeLevel) ? event.restBeforeLevel : null,
    restAfterLevel: Number.isFinite(event.restAfterLevel) ? event.restAfterLevel : null,
    restReturnDeltaKg: Number.isFinite(event.restReturnDeltaKg) ? event.restReturnDeltaKg : null,
    restGapMs: Number.isFinite(event.restGapMs) ? event.restGapMs : null,
    artifact: Boolean(event.artifact),
    artifactReason: event.artifactReason || '',
    mergedCount: Number(event.mergedCount || 1),
    fromPlateau: event.fromPlateau,
    toPlateau: event.toPlateau
  }
}

export function detectWeightStepMarkup(batch, telemetryRows = [], rawOptions = {}) {
  if (!batch?.endTime) {
    return {
      status: 'in_progress',
      reason: 'batch_in_progress',
      filter: WEIGHT_FILTER,
      speedFilter: HOST_SPEED_FILTER,
      options: resolveWeightStepOptions(rawOptions),
      points: [],
      plateaus: [],
      restPlateaus: [],
      events: [],
      includedEvents: []
    }
  }

  if (!hasUsableRawWeight(telemetryRows)) {
    return {
      status: 'processing',
      reason: 'raw_weight_missing',
      filter: WEIGHT_FILTER,
      speedFilter: HOST_SPEED_FILTER,
      options: resolveWeightStepOptions(rawOptions),
      points: [],
      plateaus: [],
      restPlateaus: [],
      events: [],
      includedEvents: []
    }
  }

  const opts = resolveWeightStepOptions(rawOptions)
  const points = buildFilteredWeightPoints(telemetryRows, opts)
  const batchStartMs = timestampMs(batch.startTime)
  const batchEndMs = timestampMs(batch.endTime)

  if (!Number.isFinite(batchStartMs) || !Number.isFinite(batchEndMs) || points.length < opts.stableMinPoints * 2) {
    return {
      status: 'processing',
      reason: 'insufficient_points',
      filter: WEIGHT_FILTER,
      speedFilter: HOST_SPEED_FILTER,
      options: opts,
      points: points.map(serializePoint),
      plateaus: [],
      restPlateaus: [],
      events: [],
      includedEvents: []
    }
  }

  const bounds = findAnalysisBounds(points, batchStartMs, batchEndMs, opts)
  const inBatch = points.filter((point) => point.x >= bounds.startMs && point.x <= bounds.endMs)
  if (inBatch.length < opts.stableMinPoints * 2) {
    return {
      status: 'processing',
      reason: 'insufficient_analysis_points',
      filter: WEIGHT_FILTER,
      speedFilter: HOST_SPEED_FILTER,
      options: opts,
      points: points.map(serializePoint),
      plateaus: [],
      restPlateaus: [],
      events: [],
      includedEvents: []
    }
  }

  const detectedPlateaus = buildPlateaus(inBatch, opts)
  const restLookbackMs = Math.max(0, Number(opts.restPlateauLookbackMinutes) || 0) * 60 * 1000
  const restStartMs = Math.max(points[0]?.x ?? batchStartMs, batchStartMs - restLookbackMs)
  const restPoints = points.filter((point) => point.x >= restStartMs && point.x <= bounds.endMs)
  const restPlateaus = buildRestPlateaus(restPoints, opts)
  const plateaus = insertTransitionPlateaus(
    inBatch,
    addBoundaryPlateaus(inBatch, detectedPlateaus, bounds.startMs, bounds.endMs, opts),
    opts,
    batchStartMs
  )
  const events = []

  for (let index = 0; index < plateaus.length - 1; index += 1) {
    const from = plateaus[index]
    const to = plateaus[index + 1]
    const trimmed = trimTransitionEdges(inBatch, from, to, opts)
    const transitionMs = trimmed.endMs - trimmed.startMs
    if (transitionMs < 0) continue

    const beforeLevel = eventLevel(trimmed.beforeLevel)
    const afterLevel = eventLevel(trimmed.afterLevel)
    const delta = eventDelta(beforeLevel, afterLevel)
    if (!Number.isFinite(delta)) continue
    const kind = eventKind(delta)
    const minStepKg = kind === 'unload' ? opts.minUnloadStepKg : opts.minLoadStepKg
    const maxTransitionSec = kind === 'unload' ? opts.maxUnloadTransitionSec : opts.maxLoadTransitionSec
    if (kind === 'flat' || Math.abs(delta) < minStepKg || transitionMs > maxTransitionSec * 1000) continue

    const speeds = speedSummary(inBatch, trimmed.startMs, trimmed.endMs, opts.loadMovingSpeedKmh)
    const boundaryStop = loadBoundaryStopEvidence(inBatch, trimmed.startMs, trimmed.endMs, opts)
    events.push({
      id: events.length + 1,
      startMs: trimmed.startMs,
      endMs: trimmed.endMs,
      beforePlateauStartMs: trimmed.beforePlateauStartMs,
      beforePlateauEndMs: trimmed.beforePlateauEndMs,
      afterPlateauStartMs: trimmed.afterPlateauStartMs,
      afterPlateauEndMs: trimmed.afterPlateauEndMs,
      beforeLevel,
      afterLevel,
      delta,
      absKg: Math.abs(delta),
      kind,
      transitionMs,
      maxTransitionSec,
      minStepKg,
      speedAvg: speeds.avg,
      speedMax: speeds.max,
      movingPct: speeds.movingPct,
      boundaryStopBefore: boundaryStop.before,
      boundaryStopAfter: boundaryStop.after,
      boundaryStopBeforePoints: boundaryStop.beforePoints,
      boundaryStopAfterPoints: boundaryStop.afterPoints,
      edgeTrimmed: Boolean(trimmed.edgeStart || trimmed.edgeEnd),
      fromPlateau: from.index,
      toPlateau: to.index
    })
  }

  const mergedEvents = mergeCloseLoadEvents(events, inBatch, opts)
  const bounceMarkedEvents = markBounceArtifacts(mergedEvents, opts)
  const restMarkedEvents = markRestPlateauArtifacts(bounceMarkedEvents, restPlateaus, opts, batchStartMs)
  const markedEvents = markBatchLifecycleArtifacts(restMarkedEvents)
  const finalEvents = markedEvents.map((event, index) => ({ ...event, id: index + 1 }))
  const includedEvents = finalEvents.filter((event) => !event.artifact)
  const loaded = includedEvents.filter((event) => event.delta > 0).reduce((sum, event) => sum + event.delta, 0)
  const unloaded = includedEvents.filter((event) => event.delta < 0).reduce((sum, event) => sum + Math.abs(event.delta), 0)
  const first = inBatch[0]?.filtered ?? null
  const last = inBatch[inBatch.length - 1]?.filtered ?? null
  const min = inBatch.length ? Math.min(...inBatch.map((point) => point.filtered)) : null
  const max = inBatch.length ? Math.max(...inBatch.map((point) => point.filtered)) : null

  return {
    status: 'complete',
    reason: null,
    filter: WEIGHT_FILTER,
    speedFilter: HOST_SPEED_FILTER,
    options: opts,
    bounds: {
      startTime: new Date(bounds.startMs),
      endTime: new Date(bounds.endMs),
      minStartTime: new Date(bounds.minStart),
      minEndTime: new Date(bounds.minEnd)
    },
    restBounds: {
      startTime: new Date(restStartMs),
      endTime: new Date(bounds.endMs)
    },
    points: points.map(serializePoint),
    inBatchPoints: inBatch.map(serializePoint),
    plateaus: plateaus.map(serializePlateau),
    restPlateaus: restPlateaus.map((plateau) => ({ ...serializePlateau(plateau), kind: 'rest' })),
    events: finalEvents.map(serializeEvent),
    includedEvents: includedEvents.map(serializeEvent),
    loaded: eventLevel(loaded),
    unloaded: eventLevel(unloaded),
    net: eventLevel(loaded - unloaded),
    observedNet: Number.isFinite(first) && Number.isFinite(last) ? eventLevel(last - first) : null,
    range: Number.isFinite(min) && Number.isFinite(max) ? eventLevel(max - min) : null,
    first: Number.isFinite(first) ? eventLevel(first) : null,
    last: Number.isFinite(last) ? eventLevel(last) : null
  }
}

export function buildPostprocessedHostTrack(analysis) {
  const points = Array.isArray(analysis?.points) ? analysis.points : []
  return points.map((point) => ({
    id: point.id,
    timestamp: point.timestamp,
    receivedAt: point.receivedAt,
    weight: point.filteredWeight ?? point.weight,
    rawWeight: point.rawWeight,
    telemetryWeight: point.telemetryWeight,
    weightValid: point.weightValid,
    speedKmh: point.speedKmh,
    rawSpeedKmh: point.rawSpeedKmh,
    speedTimestamp: point.speedTimestamp,
    lat: point.lat,
    lon: point.lon
  })).sort(compareTrackPoints)
}

export const REALTIME_WEIGHT_FILTER = Object.freeze({
  source: 'rawWeight',
  causal: true,
  hampelWindow: 9,
  hampelSigma: 1,
  medianWindow: 7,
  emaAlpha: 0.1,
  fastAlpha: 0.8,
  fastStepKg: 180,
  resetGapSeconds: 4,
  roundToKg: 5,
  minRawWeightKg: -1000,
  maxRawWeightKg: 8000
})

function finite(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function causalHampel(history, value, windowSize, sigma) {
  if (windowSize <= 1) return value
  const slice = history
    .slice(Math.max(0, history.length - windowSize + 1))
    .concat(value)
    .filter(Number.isFinite)
  const med = median(slice)
  if (!Number.isFinite(med)) return value
  const mad = median(slice.map((item) => Math.abs(item - med)))
  const threshold = Math.max(0.001, sigma * 1.4826 * (mad || 1))
  return Math.abs(value - med) > threshold ? med : value
}

function roundStep(value, step) {
  return Number.isFinite(value) && step > 0
    ? Math.round(value / step) * step
    : value
}

export function filterRealtimeWeightSeries(rows = [], rawOptions = {}) {
  const options = { ...REALTIME_WEIGHT_FILTER, ...rawOptions }
  const ordered = rows
    .map((row, index) => ({ row, index, timestampMs: new Date(row?.timestamp).getTime() }))
    .filter((item) => Number.isFinite(item.timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs || a.index - b.index)

  const output = []
  let rawHistory = []
  let cleanedHistory = []
  let ema = null
  let previousTimestampMs = null

  for (const item of ordered) {
    const rawWeight = finite(item.row?.rawWeight)
    const valid = item.row?.weightValid !== false &&
      Number.isFinite(rawWeight) &&
      rawWeight >= options.minRawWeightKg &&
      rawWeight <= options.maxRawWeightKg
    const gapSeconds = previousTimestampMs == null
      ? 0
      : (item.timestampMs - previousTimestampMs) / 1000

    if (!valid) {
      rawHistory = []
      cleanedHistory = []
      ema = null
      output.push({ ...item.row, realtimeWeight: null, source: null, sampleCount: 0 })
      previousTimestampMs = item.timestampMs
      continue
    }

    if (options.resetGapSeconds > 0 && gapSeconds > options.resetGapSeconds) {
      rawHistory = []
      cleanedHistory = []
      ema = null
    }

    const cleaned = causalHampel(
      rawHistory,
      rawWeight,
      Math.max(1, Math.round(options.hampelWindow)),
      Math.max(0.1, Number(options.hampelSigma) || 1)
    )
    rawHistory.push(rawWeight)
    cleanedHistory.push(cleaned)
    const historyLimit = Math.max(options.hampelWindow, options.medianWindow, 1)
    if (rawHistory.length > historyLimit) rawHistory.shift()
    if (cleanedHistory.length > historyLimit) cleanedHistory.shift()

    const trailing = median(cleanedHistory.slice(-Math.max(1, Math.round(options.medianWindow)))) ?? cleaned
    if (!Number.isFinite(ema)) {
      ema = trailing
    } else {
      const delta = Math.abs(trailing - ema)
      const alpha = options.fastStepKg > 0 && delta >= options.fastStepKg
        ? options.fastAlpha
        : options.emaAlpha
      ema += Math.min(1, Math.max(0.01, alpha)) * (trailing - ema)
    }

    output.push({
      ...item.row,
      realtimeWeight: roundStep(ema, options.roundToKg),
      source: 'rawWeight-causal-hampel-median-ema',
      sampleCount: cleanedHistory.length
    })
    previousTimestampMs = item.timestampMs
  }

  return {
    points: output,
    latest: output.at(-1) || null,
    options
  }
}

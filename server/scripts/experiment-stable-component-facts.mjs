import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const DEFAULT_BATCH_IDS = [46, 33]
const FARM_TIME_ZONE = 'Asia/Novosibirsk'
const WINDOW_BEFORE_SEC = 25
const WINDOW_AFTER_SEC = 25
const SETTLE_DELAY_SEC = 3
const CONTEXT_SEC = 5 * 60
const MAX_STABLE_SPEED_KMH = 1.5
const MIN_POINTS = 4
const GOOD_NOISE_KG = 60
const OK_NOISE_KG = 110
const RAW_MEDIAN_RADIUS = 4
const RAW_AVG_RADIUS = 3

const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: FARM_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: FARM_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

function parseBatchIds(argv) {
  const ids = argv
    .filter((arg) => !arg.startsWith('--'))
    .flatMap((arg) => String(arg).split(','))
    .map((arg) => Number.parseInt(arg, 10))
    .filter((id) => Number.isInteger(id) && id > 0)

  return ids.length ? ids : DEFAULT_BATCH_IDS
}

function fmtDate(value) {
  return value ? dateTimeFormatter.format(new Date(value)) : '-'
}

function fmtTime(value) {
  return value ? timeFormatter.format(new Date(value)) : '-'
}

function roundKg(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : null
}

function median(values) {
  const sorted = values
    .map((value) => Number(value))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function quantile(values, q) {
  const sorted = values
    .map((value) => Number(value))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  if (!sorted.length) return null
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] === undefined) return sorted[base]
  return sorted[base] + rest * (sorted[base + 1] - sorted[base])
}

function rollingMedian(values, radius) {
  return values.map((value, index) => {
    const slice = values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1))
    return median(slice) ?? value
  })
}

function rollingAverage(values, radius) {
  return values.map((value, index) => {
    const slice = values
      .slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1))
      .filter(Number.isFinite)
    if (!slice.length) return value
    return slice.reduce((sum, item) => sum + item, 0) / slice.length
  })
}

function buildSeries(rows, mode) {
  if (mode === 'rawFiltered') {
    const rawValues = rows.map((row) => {
      const raw = Number(row.rawWeight)
      return Number.isFinite(raw) ? raw : Number(row.weight)
    })
    const medianValues = rollingMedian(rawValues, RAW_MEDIAN_RADIUS)
    const filteredValues = rollingAverage(medianValues, RAW_AVG_RADIUS)
    return rows.map((row, index) => ({
      timestamp: row.timestamp,
      timestampMs: new Date(row.timestamp).getTime(),
      weight: filteredValues[index],
      sourceWeight: rawValues[index],
      speedKmh: Number(row.speedKmh)
    }))
  }

  return rows.map((row) => ({
    timestamp: row.timestamp,
    timestampMs: new Date(row.timestamp).getTime(),
    weight: Number(row.weight),
    sourceWeight: Number(row.weight),
    speedKmh: Number(row.speedKmh)
  }))
}

function selectWindow(series, fromMs, toMs, { preferStableSpeed = true } = {}) {
  const points = series.filter((point) =>
    Number.isFinite(point.timestampMs) &&
    point.timestampMs >= fromMs &&
    point.timestampMs <= toMs &&
    Number.isFinite(point.weight)
  )

  if (!preferStableSpeed) return points

  const stable = points.filter((point) =>
    Number.isFinite(point.speedKmh) &&
    Math.abs(point.speedKmh) <= MAX_STABLE_SPEED_KMH
  )

  return stable.length >= MIN_POINTS ? stable : points
}

function summarizeWindow(points) {
  const weights = points.map((point) => Number(point.weight)).filter(Number.isFinite)
  if (weights.length < MIN_POINTS) {
    return {
      ok: false,
      median: null,
      points: weights.length,
      noiseKg: null,
      confidence: 'none'
    }
  }

  const q10 = quantile(weights, 0.1)
  const q90 = quantile(weights, 0.9)
  const noiseKg = Number.isFinite(q10) && Number.isFinite(q90) ? q90 - q10 : null
  const med = median(weights)
  const confidence = noiseKg <= GOOD_NOISE_KG
    ? 'high'
    : noiseKg <= OK_NOISE_KG
      ? 'medium'
      : 'low'

  return {
    ok: true,
    median: med,
    points: weights.length,
    noiseKg,
    confidence
  }
}

function estimateEpisode(series, ingredient, nextIngredient = null) {
  const startMs = new Date(ingredient.startedAt || ingredient.addedAt).getTime()
  const endMs = new Date(ingredient.addedAt).getTime()
  const nextStartMs = nextIngredient
    ? new Date(nextIngredient.startedAt || nextIngredient.addedAt).getTime()
    : null

  const beforePoints = selectWindow(
    series,
    startMs - WINDOW_BEFORE_SEC * 1000,
    startMs - SETTLE_DELAY_SEC * 1000
  )

  const afterEndLimit = Number.isFinite(nextStartMs)
    ? Math.min(endMs + WINDOW_AFTER_SEC * 1000, nextStartMs - SETTLE_DELAY_SEC * 1000)
    : endMs + WINDOW_AFTER_SEC * 1000
  const afterPoints = selectWindow(
    series,
    endMs + SETTLE_DELAY_SEC * 1000,
    Math.max(endMs + SETTLE_DELAY_SEC * 1000, afterEndLimit)
  )

  const before = summarizeWindow(beforePoints)
  const after = summarizeWindow(afterPoints)
  const rawDelta = before.ok && after.ok ? after.median - before.median : null
  const corrected = Number.isFinite(rawDelta) ? Math.max(0, rawDelta) : null
  const localNoise = Math.max(Number(before.noiseKg || 0), Number(after.noiseKg || 0))
  const confidence = !before.ok || !after.ok
    ? 'none'
    : localNoise <= GOOD_NOISE_KG
      ? 'high'
      : localNoise <= OK_NOISE_KG
        ? 'medium'
        : 'low'

  return {
    ingredientId: ingredient.id,
    name: ingredient.ingredientName,
    oldWeight: Number(ingredient.actualWeight || 0),
    correctedWeight: corrected,
    rawDelta,
    before,
    after,
    localNoise,
    confidence,
    startTime: ingredient.startedAt || ingredient.addedAt,
    endTime: ingredient.addedAt
  }
}

function aggregateByIngredient(rows, key) {
  const map = new Map()
  for (const row of rows) {
    const current = map.get(row.name) || { name: row.name, oldWeight: 0, correctedWeight: 0, missing: 0 }
    current.oldWeight += Number(row.oldWeight || 0)
    if (Number.isFinite(Number(row[key]))) {
      current.correctedWeight += Number(row[key])
    } else {
      current.missing += 1
    }
    map.set(row.name, current)
  }
  return [...map.values()]
}

function stableBatchGain(series, batch) {
  const startMs = new Date(batch.startTime).getTime()
  const endMs = new Date(batch.endTime || batch.startTime).getTime()
  const start = summarizeWindow(selectWindow(series, startMs - 30_000, startMs + 30_000))
  const loadedCandidates = series.filter((point) =>
    point.timestampMs >= startMs &&
    point.timestampMs <= endMs &&
    Number.isFinite(point.weight)
  )
  const loadedStable = summarizeWindow(loadedCandidates.slice(Math.max(0, loadedCandidates.length - 60)))
  const maxWeight = loadedCandidates.reduce((max, point) => Math.max(max, Number(point.weight)), Number.NEGATIVE_INFINITY)
  return {
    startStable: start.median,
    tailStable: loadedStable.median,
    maxWeight: Number.isFinite(maxWeight) ? maxWeight : null,
    gainByMax: Number.isFinite(maxWeight) && Number.isFinite(Number(start.median)) ? maxWeight - start.median : null
  }
}

function printEpisodeTable(title, rows) {
  console.log(`\n${title}`)
  console.log('time       component          old   corrected  before  after   noise conf pts')
  for (const row of rows) {
    const correctedLabel = Number.isFinite(Number(row.correctedWeight)) ? String(roundKg(row.correctedWeight)).padStart(5) : '    ?'
    const beforeLabel = Number.isFinite(Number(row.before.median)) ? String(roundKg(row.before.median)).padStart(6) : '     ?'
    const afterLabel = Number.isFinite(Number(row.after.median)) ? String(roundKg(row.after.median)).padStart(6) : '     ?'
    const noiseLabel = Number.isFinite(Number(row.localNoise)) ? String(roundKg(row.localNoise)).padStart(5) : '    ?'
    const pointsLabel = `${row.before.points}/${row.after.points}`.padStart(5)
    console.log(`${fmtTime(row.endTime)}  ${row.name.padEnd(17)} ${String(roundKg(row.oldWeight)).padStart(5)} ${correctedLabel} ${beforeLabel} ${afterLabel} ${noiseLabel} ${row.confidence.padEnd(6)} ${pointsLabel}`)
  }
}

function printAggregate(title, rows) {
  console.log(`\n${title}`)
  console.log('component          old   corrected  diff')
  for (const row of rows) {
    const diff = row.correctedWeight - row.oldWeight
    console.log(`${row.name.padEnd(17)} ${String(roundKg(row.oldWeight)).padStart(5)} ${String(roundKg(row.correctedWeight)).padStart(9)} ${String(roundKg(diff)).padStart(6)}${row.missing ? ` missing=${row.missing}` : ''}`)
  }
}

async function analyzeBatch(batchId) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: {
      group: true,
      ration: true,
      actualIngredients: {
        orderBy: [
          { startedAt: 'asc' },
          { addedAt: 'asc' },
          { id: 'asc' }
        ]
      }
    }
  })

  if (!batch) {
    console.log(`Batch #${batchId} not found`)
    return
  }

  const startMs = new Date(batch.startTime).getTime()
  const endMs = new Date(batch.endTime || batch.startTime).getTime()
  const telemetryRows = await prisma.telemetry.findMany({
    where: {
      deviceId: batch.deviceId,
      timestamp: {
        gte: new Date(startMs - CONTEXT_SEC * 1000),
        lte: new Date(endMs + CONTEXT_SEC * 1000)
      }
    },
    select: {
      timestamp: true,
      weight: true,
      rawWeight: true,
      speedKmh: true
    },
    orderBy: [
      { timestamp: 'asc' },
      { id: 'asc' }
    ]
  })

  console.log(`\n${'='.repeat(80)}`)
  console.log(`#${batch.id} ${fmtDate(batch.startTime)} - ${fmtDate(batch.endTime)} ${batch.group?.name || '-'} / ${batch.ration?.name || '-'}`)
  console.log(`episodes=${batch.actualIngredients.length} telemetry=${telemetryRows.length}`)
  console.log(`old sum=${roundKg(batch.actualIngredients.reduce((sum, row) => sum + Number(row.actualWeight || 0), 0))} kg`)

  for (const mode of ['weight', 'rawFiltered']) {
    const series = buildSeries(telemetryRows, mode)
    const estimates = batch.actualIngredients.map((ingredient, index) =>
      estimateEpisode(series, ingredient, batch.actualIngredients[index + 1] || null)
    )
    const aggregate = aggregateByIngredient(estimates, 'correctedWeight')
    const correctedSum = aggregate.reduce((sum, row) => sum + Number(row.correctedWeight || 0), 0)
    const physical = stableBatchGain(series, batch)

    printEpisodeTable(`${mode}: stable before/after episodes`, estimates)
    printAggregate(`${mode}: aggregate by component`, aggregate)
    console.log(`${mode}: corrected sum=${roundKg(correctedSum)} kg, max-based physical gain=${roundKg(physical.gainByMax)} kg, maxWeight=${roundKg(physical.maxWeight)} kg, startStable=${roundKg(physical.startStable)} kg`)
  }
}

const batchIds = parseBatchIds(process.argv.slice(2))
for (const batchId of batchIds) {
  await analyzeBatch(batchId)
}

await prisma.$disconnect()

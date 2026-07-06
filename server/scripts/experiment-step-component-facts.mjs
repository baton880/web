import { PrismaClient } from '@prisma/client'
import { calculateHaversine, detectZoneObject } from '../../module-1/geo.js'

const prisma = new PrismaClient()

const DEFAULT_BATCH_IDS = [33, 46]
const FARM_TIME_ZONE = 'Asia/Novosibirsk'
function envNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

const CONTEXT_SEC = envNumber('CONTEXT_SEC', 90)
const MEDIAN_RADIUS = envNumber('MEDIAN_RADIUS', 3)
const STABLE_RADIUS = envNumber('STABLE_RADIUS', 4)
const STABLE_RANGE_KG = envNumber('STABLE_RANGE_KG', 55)
const STABLE_MIN_POINTS = envNumber('STABLE_MIN_POINTS', 4)
const STABLE_MAX_SPEED_KMH = envNumber('STABLE_MAX_SPEED_KMH', 2)
const PLATEAU_MERGE_GAP_MS = envNumber('PLATEAU_MERGE_GAP_MS', 12_000)
const PLATEAU_MERGE_LEVEL_KG = envNumber('PLATEAU_MERGE_LEVEL_KG', 35)
const MIN_STEP_KG = envNumber('MIN_STEP_KG', 35)
const STEP_ZONE_PADDING_MS = envNumber('STEP_ZONE_PADDING_MS', 20_000)
const MAX_PRINT_STEPS = 40
const DEFAULT_LOADER_OFFLINE_TIMEOUT_MINUTES = 4
const DEFAULT_LOADER_MAX_DISTANCE_METERS = 150

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

function roundStep5(value) {
  if (!Number.isFinite(Number(value))) return null
  return Math.round(Number(value) / 5) * 5
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

function indexRtkPoints(rows) {
  const byDevice = new Map()
  const all = rows
    .map((point) => ({ ...point, timestampMs: new Date(point.timestamp).getTime() }))
    .filter((point) => Number.isFinite(point.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs || left.id - right.id)

  for (const point of all) {
    const key = point.deviceId || ''
    if (!byDevice.has(key)) byDevice.set(key, [])
    byDevice.get(key).push(point)
  }

  return { byDevice, all }
}

function latestFreshPoint(points, referenceMs, thresholdMs) {
  if (!Array.isArray(points) || !points.length || !Number.isFinite(referenceMs)) return null

  let left = 0
  let right = points.length - 1
  let found = -1

  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    if (points[mid].timestampMs <= referenceMs) {
      found = mid
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  if (found < 0) return null
  const point = points[found]
  return referenceMs - point.timestampMs <= thresholdMs ? point : null
}

function resolveEffectivePosition(row, rtkIndex, settings = {}) {
  const referenceMs = new Date(row.timestamp).getTime()
  const loaderOfflineTimeoutMinutes = Number(settings.loaderOfflineTimeoutMinutes) > 0
    ? Number(settings.loaderOfflineTimeoutMinutes)
    : DEFAULT_LOADER_OFFLINE_TIMEOUT_MINUTES
  const loaderMaxDistanceMeters = Number(settings.loaderMaxDistanceMeters) > 0
    ? Number(settings.loaderMaxDistanceMeters)
    : DEFAULT_LOADER_MAX_DISTANCE_METERS
  const freshnessMs = loaderOfflineTimeoutMinutes * 60 * 1000
  const sameDevice = latestFreshPoint(rtkIndex.byDevice.get(row.deviceId), referenceMs, freshnessMs)
  const rtkPoint = sameDevice || latestFreshPoint(rtkIndex.all, referenceMs, freshnessMs)

  if (!rtkPoint) {
    return {
      lat: Number(row.lat),
      lon: Number(row.lon),
      source: 'host'
    }
  }

  const hostLat = Number(row.lat)
  const hostLon = Number(row.lon)
  const loaderLat = Number(rtkPoint.lat)
  const loaderLon = Number(rtkPoint.lon)

  if (
    Number.isFinite(hostLat) &&
    Number.isFinite(hostLon) &&
    Number.isFinite(loaderLat) &&
    Number.isFinite(loaderLon)
  ) {
    const distanceMeters = calculateHaversine(hostLat, hostLon, loaderLat, loaderLon)
    if (distanceMeters <= loaderMaxDistanceMeters) {
      return {
        lat: loaderLat,
        lon: loaderLon,
        source: 'rtk',
        loaderDistanceMeters: distanceMeters
      }
    }
  }

  return {
    lat: hostLat,
    lon: hostLon,
    source: 'host'
  }
}

function buildRawSeries(rows, rtkIndex, settings) {
  const rawValues = rows.map((row) => {
    const raw = Number(row.rawWeight)
    const fallback = Number(row.weight)
    return Number.isFinite(raw) ? raw : fallback
  })
  const filtered = rollingMedian(rawValues, MEDIAN_RADIUS)

  return rows.map((row, index) => {
    const effectivePosition = resolveEffectivePosition(row, rtkIndex, settings)
    return {
      id: row.id,
      timestamp: row.timestamp,
      timestampMs: new Date(row.timestamp).getTime(),
      rawWeight: rawValues[index],
      filteredWeight: roundStep5(filtered[index]),
      lat: effectivePosition.lat,
      lon: effectivePosition.lon,
      positionSource: effectivePosition.source,
      speedKmh: Number(row.speedKmh)
    }
  }).filter((point) =>
    Number.isFinite(point.timestampMs) &&
    Number.isFinite(point.filteredWeight)
  )
}

function markStablePoints(series) {
  return series.map((point, index) => {
    const window = series.slice(Math.max(0, index - STABLE_RADIUS), Math.min(series.length, index + STABLE_RADIUS + 1))
    const weights = window.map((item) => item.filteredWeight).filter(Number.isFinite)
    const q10 = quantile(weights, 0.1)
    const q90 = quantile(weights, 0.9)
    const range = Number.isFinite(q10) && Number.isFinite(q90) ? q90 - q10 : Number.POSITIVE_INFINITY
    const stableBySpeed = !Number.isFinite(point.speedKmh) || Math.abs(point.speedKmh) <= STABLE_MAX_SPEED_KMH

    return {
      ...point,
      stable: weights.length >= STABLE_MIN_POINTS && range <= STABLE_RANGE_KG && stableBySpeed,
      localRangeKg: range
    }
  })
}

function summarizePlateau(points) {
  const weights = points.map((point) => point.filteredWeight).filter(Number.isFinite)
  return {
    startMs: points[0].timestampMs,
    endMs: points[points.length - 1].timestampMs,
    startTime: points[0].timestamp,
    endTime: points[points.length - 1].timestamp,
    level: median(weights),
    minLevel: Math.min(...weights),
    maxLevel: Math.max(...weights),
    points: points.length
  }
}

function buildPlateaus(series) {
  const marked = markStablePoints(series)
  const runs = []
  let current = []

  for (const point of marked) {
    if (point.stable) {
      current.push(point)
      continue
    }

    if (current.length >= STABLE_MIN_POINTS) {
      runs.push(summarizePlateau(current))
    }
    current = []
  }

  if (current.length >= STABLE_MIN_POINTS) {
    runs.push(summarizePlateau(current))
  }

  const merged = []
  for (const run of runs) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      run.startMs - previous.endMs <= PLATEAU_MERGE_GAP_MS &&
      Math.abs(Number(run.level) - Number(previous.level)) <= PLATEAU_MERGE_LEVEL_KG
    ) {
      const combinedWeights = [
        previous.minLevel,
        previous.level,
        previous.maxLevel,
        run.minLevel,
        run.level,
        run.maxLevel
      ].filter(Number.isFinite)
      previous.endMs = run.endMs
      previous.endTime = run.endTime
      previous.level = median(combinedWeights)
      previous.minLevel = Math.min(previous.minLevel, run.minLevel)
      previous.maxLevel = Math.max(previous.maxLevel, run.maxLevel)
      previous.points += run.points
      continue
    }

    merged.push({ ...run })
  }

  return merged
}

function isLoadingZone(zone, linkedBarnZoneIds = new Set()) {
  if (!zone) return false
  if (linkedBarnZoneIds.has(Number(zone.id))) return false
  const zoneType = String(zone.zoneType || '').trim().toUpperCase()
  if (!zoneType) return true
  return zoneType === 'STORAGE' || zoneType === 'FEED' || zoneType === 'LOADING'
}

function zoneScoreForStep(series, zones, step) {
  const scores = new Map()
  const fromMs = step.from.endMs - STEP_ZONE_PADDING_MS
  const toMs = step.to.startMs + STEP_ZONE_PADDING_MS
  const points = series.filter((point) =>
    point.timestampMs >= fromMs &&
    point.timestampMs <= toMs &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon)
  )

  for (const point of points) {
    const matchedZones = zones.filter((zone) => detectZoneObject(point.lat, point.lon, [zone]))
    for (const zone of matchedZones) {
      const ingredient = String(zone.ingredient || zone.name || '').trim()
      if (!ingredient) continue
      const current = scores.get(ingredient) || { ingredient, points: 0, zones: new Set() }
      current.points += 1
      current.zones.add(zone.name)
      scores.set(ingredient, current)
    }
  }

  const sorted = [...scores.values()].sort((left, right) => right.points - left.points)
  const best = sorted[0] || null
  if (!best) {
    return {
      ingredient: 'Неопределено',
      confidence: 'none',
      points: 0,
      zones: ''
    }
  }

  return {
    ingredient: best.ingredient,
    confidence: best.points >= 4 ? 'zone' : 'weak-zone',
    points: best.points,
    zones: [...best.zones].join(','),
    candidates: sorted.slice(0, 3).map((row) => `${row.ingredient}:${row.points}`).join(' ')
  }
}

function oldIngredientForStep(ingredients, step) {
  const midMs = (step.from.endMs + step.to.startMs) / 2
  let best = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const ingredient of ingredients) {
    const startMs = new Date(ingredient.startedAt || ingredient.addedAt).getTime()
    const endMs = new Date(ingredient.addedAt).getTime()
    const clamped = Math.min(Math.max(midMs, startMs), endMs)
    const distance = Math.abs(midMs - clamped)
    if (distance < bestDistance) {
      best = ingredient
      bestDistance = distance
    }
  }

  return best
}

function buildSteps(series, plateaus, zones, oldIngredients) {
  const steps = []
  for (let index = 0; index < plateaus.length - 1; index += 1) {
    const from = plateaus[index]
    const to = plateaus[index + 1]
    const delta = Number(to.level) - Number(from.level)
    if (delta < MIN_STEP_KG) continue

    const zone = zoneScoreForStep(series, zones, { from, to })
    const old = oldIngredientForStep(oldIngredients, { from, to })
    steps.push({
      from,
      to,
      startTime: from.endTime,
      endTime: to.startTime,
      weight: delta,
      ingredientName: zone.ingredient,
      confidence: zone.confidence,
      zonePoints: zone.points,
      zones: zone.zones,
      candidates: zone.candidates || '',
      oldIngredientName: old?.ingredientName || '-',
      oldWeight: Number(old?.actualWeight || 0)
    })
  }

  return steps
}

function aggregateSteps(steps) {
  const map = new Map()
  for (const step of steps) {
    const key = step.ingredientName || 'Неопределено'
    const current = map.get(key) || { ingredientName: key, weight: 0, steps: 0 }
    current.weight += Number(step.weight || 0)
    current.steps += 1
    map.set(key, current)
  }
  return [...map.values()].sort((left, right) => right.weight - left.weight)
}

function aggregateOld(ingredients) {
  const map = new Map()
  for (const ingredient of ingredients) {
    const key = ingredient.ingredientName || 'Неопределено'
    const current = map.get(key) || { ingredientName: key, weight: 0, steps: 0 }
    current.weight += Number(ingredient.actualWeight || 0)
    current.steps += 1
    map.set(key, current)
  }
  return [...map.values()].sort((left, right) => right.weight - left.weight)
}

function printStepTable(steps) {
  console.log('\nstep-table: raw -> median -> stable plateaus, old buckets only for comparison')
  console.log('time             kg   component         conf       zonePts old-nearest    candidates')
  for (const step of steps.slice(0, MAX_PRINT_STEPS)) {
    const time = `${fmtTime(step.startTime)}-${fmtTime(step.endTime)}`
    const kg = String(roundKg(step.weight)).padStart(4)
    console.log(`${time} ${kg}  ${step.ingredientName.padEnd(16)} ${step.confidence.padEnd(10)} ${String(step.zonePoints).padStart(3)}     ${step.oldIngredientName.padEnd(14)} ${step.candidates}`)
  }
  if (steps.length > MAX_PRINT_STEPS) {
    console.log(`... ${steps.length - MAX_PRINT_STEPS} more steps`)
  }
}

function printAggregate(title, rows) {
  console.log(`\n${title}`)
  console.log('component          kg    steps')
  for (const row of rows) {
    console.log(`${row.ingredientName.padEnd(17)} ${String(roundKg(row.weight)).padStart(5)} ${String(row.steps).padStart(5)}`)
  }
}

async function loadLoadingZones() {
  const groups = await prisma.livestockGroup.findMany({
    select: { storageZoneId: true }
  })
  const linkedBarnZoneIds = new Set(groups
    .map((group) => Number(group.storageZoneId))
    .filter((id) => Number.isInteger(id) && id > 0))

  const zones = await prisma.storageZone.findMany({
    where: { active: true },
    orderBy: { id: 'asc' }
  })

  return zones.filter((zone) => isLoadingZone(zone, linkedBarnZoneIds))
}

async function analyzeBatch(batchId, zones, settings) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: {
      group: true,
      ration: {
        include: {
          ingredients: {
            orderBy: [
              { sortOrder: 'asc' },
              { id: 'asc' }
            ]
          }
        }
      },
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
      id: true,
      deviceId: true,
      timestamp: true,
      lat: true,
      lon: true,
      speedKmh: true,
      weight: true,
      rawWeight: true
    },
    orderBy: [
      { timestamp: 'asc' },
      { id: 'asc' }
    ]
  })

  const rtkRows = await prisma.rtkTelemetry.findMany({
    where: {
      timestamp: {
        gte: new Date(startMs - (CONTEXT_SEC + DEFAULT_LOADER_OFFLINE_TIMEOUT_MINUTES * 60) * 1000),
        lte: new Date(endMs + CONTEXT_SEC * 1000)
      }
    },
    select: {
      id: true,
      deviceId: true,
      timestamp: true,
      lat: true,
      lon: true
    },
    orderBy: [
      { timestamp: 'asc' },
      { id: 'asc' }
    ]
  })

  const rtkIndex = indexRtkPoints(rtkRows)
  const series = buildRawSeries(telemetryRows, rtkIndex, settings).filter((point) =>
    point.timestampMs >= startMs &&
    point.timestampMs <= endMs
  )
  const plateaus = buildPlateaus(series)
  const steps = buildSteps(series, plateaus, zones, batch.actualIngredients)
  const oldSum = batch.actualIngredients.reduce((sum, row) => sum + Number(row.actualWeight || 0), 0)
  const stepSum = steps.reduce((sum, step) => sum + Number(step.weight || 0), 0)

  console.log(`\n${'='.repeat(90)}`)
  console.log(`#${batch.id} ${fmtDate(batch.startTime)} - ${fmtDate(batch.endTime)} ${batch.group?.name || '-'} / ${batch.ration?.name || '-'}`)
  console.log(`params medianRadius=${MEDIAN_RADIUS}, stableRadius=${STABLE_RADIUS}, stableRange=${STABLE_RANGE_KG}, minStep=${MIN_STEP_KG}, mergeGapMs=${PLATEAU_MERGE_GAP_MS}, mergeLevel=${PLATEAU_MERGE_LEVEL_KG}`)
  const rtkPoints = series.filter((point) => point.positionSource === 'rtk').length
  console.log(`telemetry=${series.length}, rtk-position=${rtkPoints}, rtkRows=${rtkRows.length}, plateaus=${plateaus.length}, positive steps=${steps.length}`)
  console.log(`old bucket sum=${roundKg(oldSum)} kg, step sum=${roundKg(stepSum)} kg`)
  const plan = (batch.ration?.ingredients || [])
    .map((ingredient) => `${ingredient.name}:${roundKg(ingredient.plannedWeight)}`)
    .join(' -> ')
  if (plan) console.log(`ration order: ${plan}`)

  printStepTable(steps)
  printAggregate('step aggregate by detected zone', aggregateSteps(steps))
  printAggregate('old aggregate by recorded bucket', aggregateOld(batch.actualIngredients))
}

const batchIds = parseBatchIds(process.argv.slice(2))
const zones = await loadLoadingZones()
const settings = await prisma.telemetrySettings.findUnique({ where: { id: 1 } }) || {}
for (const batchId of batchIds) {
  await analyzeBatch(batchId, zones, settings)
}

await prisma.$disconnect()

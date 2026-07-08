import { detectZoneObject } from '../../../../module-1/geo.js'
import { normalizeIngredientName } from '../../../../module-2/rationManager.js'
import { roundWeight } from '../../../../module-2/weightRounding.js'
import { TelemetryProcessor } from '../../../../module-3/telemetryProcessor.js'
import { recalculateBatchViolations } from './batch-violations.js'
import { buildPostprocessedHostTrack, detectWeightStepMarkup } from './weight-step-postprocess.js'

const POSTPROCESS_CONTEXT_MS = 10 * 60 * 1000
const POSTPROCESS_CACHE = new Map()

function timestampMs(value) {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeZoneType(value) {
  if (!value) return ''
  return String(value).trim().toUpperCase()
}

function isBarnZone(zone, linkedBarnZoneIds = new Set()) {
  if (!zone) return false
  const zoneType = normalizeZoneType(zone.zoneType)
  if (linkedBarnZoneIds.has(Number(zone.id))) return true
  return zoneType === 'BARN' || zoneType === 'LIVESTOCK' || zoneType === 'COWSHED' || zoneType === 'GROUP'
}

function isLoadingZone(zone, linkedBarnZoneIds = new Set()) {
  if (!zone) return false
  if (isBarnZone(zone, linkedBarnZoneIds)) return false
  const zoneType = normalizeZoneType(zone.zoneType)
  if (!zoneType) return true
  return zoneType === 'STORAGE' || zoneType === 'FEED' || zoneType === 'LOADING'
}

function expectedIngredientsFromBatch(batch) {
  const ingredients = batch?.ration?.ingredients?.length
    ? batch.ration.ingredients
    : batch?.group?.ration?.ingredients

  return (Array.isArray(ingredients) ? ingredients : [])
    .map((ingredient, index) => ({
      name: ingredient.name,
      sortOrder: Number(ingredient.sortOrder || index + 1)
    }))
    .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0))
}

function fallbackExpectedIngredientName(expectedIngredients, usedKeys) {
  return expectedIngredients.find((ingredient) => {
    const key = normalizeIngredientName(ingredient.name)
    return key && !usedKeys.has(key)
  })?.name || 'Unknown'
}

function eventCenterMs(event) {
  const startMs = timestampMs(event?.startTime)
  const endMs = timestampMs(event?.endTime)
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) return (startMs + endMs) / 2
  return Number.isFinite(startMs) ? startMs : endMs
}

function findClosestTelemetryPoint(points, referenceMs) {
  if (!Array.isArray(points) || !points.length || !Number.isFinite(referenceMs)) return null
  let best = null
  for (const point of points) {
    const pointMs = timestampMs(point.timestamp)
    if (!Number.isFinite(pointMs)) continue
    const distance = Math.abs(pointMs - referenceMs)
    if (!best || distance < best.distance) {
      best = { point, distance }
    }
  }
  return best?.point || null
}

function findExistingIngredientName(batch, event, usedIds = new Set()) {
  const rows = Array.isArray(batch?.actualIngredients) ? batch.actualIngredients : []
  if (!rows.length) return null

  const eventStartMs = timestampMs(event.startTime)
  const eventEndMs = timestampMs(event.endTime)
  const centerMs = eventCenterMs(event)
  const toleranceMs = 3 * 60 * 1000
  let best = null

  for (const row of rows) {
    if (usedIds.has(row.id)) continue
    const rowStartMs = timestampMs(row.startedAt || row.addedAt)
    const rowEndMs = timestampMs(row.addedAt || row.startedAt)
    const rowCenterMs = Number.isFinite(rowStartMs) && Number.isFinite(rowEndMs)
      ? (rowStartMs + rowEndMs) / 2
      : rowEndMs
    if (!Number.isFinite(rowCenterMs)) continue

    const overlaps = Number.isFinite(eventStartMs) &&
      Number.isFinite(eventEndMs) &&
      Number.isFinite(rowStartMs) &&
      Number.isFinite(rowEndMs) &&
      rowEndMs >= eventStartMs - toleranceMs &&
      rowStartMs <= eventEndMs + toleranceMs
    const distance = Number.isFinite(centerMs) ? Math.abs(rowCenterMs - centerMs) : Number.POSITIVE_INFINITY
    if (!overlaps && distance > toleranceMs) continue

    if (!best || distance < best.distance) {
      best = { row, distance }
    }
  }

  if (best?.row) {
    usedIds.add(best.row.id)
    return String(best.row.ingredientName || '').trim() || null
  }

  return null
}

function buildCacheKey(batch, telemetryRows) {
  const last = telemetryRows[telemetryRows.length - 1]
  return [
    batch?.id,
    batch?.startTime ? new Date(batch.startTime).toISOString() : '',
    batch?.endTime ? new Date(batch.endTime).toISOString() : '',
    telemetryRows.length,
    last?.id || '',
    last?.timestamp ? new Date(last.timestamp).toISOString() : ''
  ].join(':')
}

function postprocessOptionsFromSettings(settings = {}) {
  const factor = Number(settings?.weightCalibrationFactor)
  if (Number.isFinite(factor) && factor > 0 && Math.abs(factor - 1) > 0.000001) {
    return { weightScale: factor }
  }
  return {}
}

async function loadBatchForPostprocess(prismaClient, batchId) {
  return prismaClient.batch.findUnique({
    where: { id: Number(batchId) },
    include: {
      group: {
        include: {
          ration: {
            include: { ingredients: true }
          }
        }
      },
      ration: { include: { ingredients: true } },
      actualIngredients: {
        orderBy: [
          { startedAt: 'asc' },
          { addedAt: 'asc' },
          { id: 'asc' }
        ]
      }
    }
  })
}

export async function loadBatchPostprocessTelemetry(prismaClient, batch) {
  const startMs = timestampMs(batch?.startTime)
  const endMs = timestampMs(batch?.endTime || batch?.startTime)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return []

  return prismaClient.telemetry.findMany({
    where: {
      deviceId: batch.deviceId,
      timestamp: {
        gte: new Date(startMs - POSTPROCESS_CONTEXT_MS),
        lte: new Date(endMs + POSTPROCESS_CONTEXT_MS)
      }
    },
    select: {
      id: true,
      timestamp: true,
      receivedAt: true,
      weight: true,
      rawWeight: true,
      weightValid: true,
      speedKmh: true,
      lat: true,
      lon: true
    },
    orderBy: [
      { timestamp: 'asc' },
      { id: 'asc' }
    ]
  })
}

async function loadLoadingZones(prismaClient) {
  const [activeZones, livestockGroups] = await Promise.all([
    prismaClient.storageZone.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
    prismaClient.livestockGroup.findMany({
      select: { storageZoneId: true }
    })
  ])
  const linkedBarnZoneIds = new Set(
    livestockGroups
      .map((group) => Number(group.storageZoneId))
      .filter((zoneId) => Number.isInteger(zoneId) && zoneId > 0)
  )
  return {
    activeZones,
    loadingZones: activeZones.filter((zone) => isLoadingZone(zone, linkedBarnZoneIds))
  }
}

function resolveIngredientWithProcessor({
  batch,
  event,
  eventIndex,
  processor,
  processedTelemetry,
  loadingZones,
  telemetrySettings,
  expectedIngredients,
  usedExpectedKeys
}) {
  const deviceId = batch.deviceId || 'host_01'
  const startMs = timestampMs(event.startTime)
  if (!Number.isFinite(startMs)) {
    return null
  }

  for (const point of processedTelemetry) {
    if (point._processedForPostprocess) continue
    const pointMs = timestampMs(point.timestamp)
    if (!Number.isFinite(pointMs) || pointMs > startMs) break
    point._processedForPostprocess = true
    if (!Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lon))) continue
    processor.processLoaderPacket({
      deviceId,
      timestamp: point.timestamp,
      lat: Number(point.lat),
      lon: Number(point.lon),
      speedKmh: Number(point.speedKmh || 0)
    }, loadingZones, telemetrySettings, { deviceId })
  }

  let state = processor.deviceStates.get(deviceId)
  if (!state) {
    state = processor.getInitialState(Number(event.beforeLevel || 0))
    processor.deviceStates.set(deviceId, state)
  }

  const nearest = findClosestTelemetryPoint(processedTelemetry, startMs)
  const activeZone = nearest ? detectZoneObject(Number(nearest.lat), Number(nearest.lon), loadingZones) : null
  if (activeZone) {
    state.currentZone = { ...activeZone, ingredient: activeZone.ingredient || activeZone.name || null }
    state.confirmedZoneName = activeZone.name || null
  }

  state.loadingStartTimeMs = startMs
  state.loadingStartLat = finiteNumberOrNull(nearest?.lat)
  state.loadingStartLon = finiteNumberOrNull(nearest?.lon)
  processor._freezeZoneScoreboardForLoading(state)

  const visitedZoneMaxAgeMs = processor._getVisitedZoneMaxAgeMs(processor._resolveThresholds(telemetrySettings))
  const ingredientName = processor._resolveSegmentIngredient(state, expectedIngredients, {
    allowVisitedZoneIngredient: true,
    preferCurrentZoneIngredient: true,
    packetTimeMs: startMs,
    visitedZoneMaxAgeMs
  })

  const normalized = normalizeIngredientName(ingredientName)
  if (normalized && normalized !== 'unknown') {
    usedExpectedKeys.add(normalized)
    processor._resetVisitedZones(state, timestampMs(event.endTime) || startMs)
    state.loadedIngredientKeys = Array.from(usedExpectedKeys)
    state.lastIngredientName = ingredientName
    state.loadingStartTimeMs = null
    state.loadingStartLat = null
    state.loadingStartLon = null
    return ingredientName
  }

  processor._resetVisitedZones(state, timestampMs(event.endTime) || startMs)
  state.loadedIngredientKeys = Array.from(usedExpectedKeys)
  state.loadingStartTimeMs = null
  state.loadingStartLat = null
  state.loadingStartLon = null
  return null
}

async function buildPostprocessedIngredients(prismaClient, batch, analysis, telemetrySettings) {
  const loadEvents = (analysis.includedEvents || []).filter((event) => event.delta > 0)
  if (!loadEvents.length) return []

  const { loadingZones } = await loadLoadingZones(prismaClient)
  const expectedIngredients = expectedIngredientsFromBatch(batch)
  const processor = new TelemetryProcessor()
  const usedExpectedKeys = new Set()
  const usedExistingIds = new Set()
  const processedTelemetry = (Array.isArray(analysis.points) ? analysis.points : []).map((point) => ({
    timestamp: point.timestamp,
    lat: point.lat,
    lon: point.lon,
    speedKmh: point.speedKmh,
    _processedForPostprocess: false
  }))

  return loadEvents.map((event, index) => {
    const existingName = findExistingIngredientName(batch, event, usedExistingIds)
    const processorName = loadingZones.length
      ? resolveIngredientWithProcessor({
        batch,
        event,
        eventIndex: index,
        processor,
        processedTelemetry,
        loadingZones,
        telemetrySettings,
        expectedIngredients,
        usedExpectedKeys
      })
      : null
    const ingredientName = existingName || processorName || fallbackExpectedIngredientName(expectedIngredients, usedExpectedKeys) || 'Unknown'
    const ingredientKey = normalizeIngredientName(ingredientName)
    if (ingredientKey) usedExpectedKeys.add(ingredientKey)

    const closestStart = findClosestTelemetryPoint(analysis.points, timestampMs(event.startTime))
    const closestEnd = findClosestTelemetryPoint(analysis.points, timestampMs(event.endTime))
    return {
      ingredientName,
      actualWeight: roundWeight(event.delta),
      startedAt: event.startTime ? new Date(event.startTime) : null,
      addedAt: event.endTime ? new Date(event.endTime) : null,
      startLat: finiteNumberOrNull(closestStart?.lat),
      startLon: finiteNumberOrNull(closestStart?.lon),
      endLat: finiteNumberOrNull(closestEnd?.lat),
      endLon: finiteNumberOrNull(closestEnd?.lon),
      postprocessEventId: event.id,
      beforeLevel: event.beforeLevel,
      afterLevel: event.afterLevel
    }
  })
}

export function buildPostprocessMeta(result) {
  return {
    status: result?.status || 'processing',
    reason: result?.reason || null,
    loaded: result?.analysis?.loaded ?? result?.loaded ?? null,
    unloaded: result?.analysis?.unloaded ?? result?.unloaded ?? null,
    net: result?.analysis?.net ?? result?.net ?? null,
    eventCount: Array.isArray(result?.analysis?.includedEvents)
      ? result.analysis.includedEvents.length
      : (Array.isArray(result?.includedEvents) ? result.includedEvents.length : 0),
    generatedAt: result?.generatedAt || null
  }
}

export async function buildBatchPostprocess(prismaClient, batch, telemetrySettings = {}, options = {}) {
  if (!batch) {
    return { status: 'missing', reason: 'batch_missing' }
  }
  if (!batch.endTime) {
    return { status: 'in_progress', reason: 'batch_in_progress' }
  }

  const telemetryRows = options.telemetryRows || await loadBatchPostprocessTelemetry(prismaClient, batch)
  const cacheKey = buildCacheKey(batch, telemetryRows)
  const cached = POSTPROCESS_CACHE.get(batch.id)
  if (cached?.cacheKey === cacheKey && (!options.requirePersisted || cached.persisted)) {
    return cached.result
  }

  const analysis = detectWeightStepMarkup(batch, telemetryRows, {
    ...postprocessOptionsFromSettings(telemetrySettings),
    ...(options.stepOptions || {})
  })

  if (analysis.status !== 'complete') {
    const result = {
      status: analysis.status,
      reason: analysis.reason,
      analysis,
      ingredients: [],
      generatedAt: new Date()
    }
    POSTPROCESS_CACHE.set(batch.id, { cacheKey, result, persisted: false })
    return result
  }

  const ingredients = await buildPostprocessedIngredients(prismaClient, batch, analysis, telemetrySettings)
  const result = {
    status: 'complete',
    reason: null,
    analysis,
    ingredients,
    hostTrack: buildPostprocessedHostTrack(analysis),
    generatedAt: new Date()
  }
  POSTPROCESS_CACHE.set(batch.id, { cacheKey, result, persisted: false })
  return result
}

export async function postprocessCompletedBatch(prismaClient, batchId, telemetrySettings = {}, options = {}) {
  const batch = options.batch || await loadBatchForPostprocess(prismaClient, batchId)
  if (!batch) {
    return { status: 'missing', reason: 'batch_missing' }
  }

  const result = await buildBatchPostprocess(prismaClient, batch, telemetrySettings, options)
  if (result.status !== 'complete' || options.persist === false) {
    return result
  }

  const cacheEntry = POSTPROCESS_CACHE.get(batch.id)
  if (cacheEntry?.persisted) {
    return result
  }

  await prismaClient.$transaction(async (tx) => {
    await tx.batchIngredient.deleteMany({ where: { batchId: batch.id } })

    for (const ingredient of result.ingredients) {
      await tx.batchIngredient.create({
        data: {
          batchId: batch.id,
          ingredientName: ingredient.ingredientName,
          actualWeight: roundWeight(ingredient.actualWeight || 0),
          startedAt: ingredient.startedAt,
          startLat: ingredient.startLat,
          startLon: ingredient.startLon,
          endLat: ingredient.endLat,
          endLon: ingredient.endLon,
          addedAt: ingredient.addedAt || ingredient.startedAt || batch.endTime
        }
      })
    }

    await tx.batch.update({
      where: { id: batch.id },
      data: {
        startWeight: result.analysis.first ?? batch.startWeight,
        endWeight: result.analysis.last ?? batch.endWeight
      }
    })
  })

  await recalculateBatchViolations(prismaClient, batch.id, telemetrySettings)
  const nextEntry = POSTPROCESS_CACHE.get(batch.id)
  if (nextEntry) {
    nextEntry.persisted = true
  }
  return { ...result, persisted: true }
}

export async function getBatchPostprocessForResponse(prismaClient, batch, telemetrySettings = {}) {
  if (!batch?.endTime) {
    return { status: 'in_progress', reason: 'batch_in_progress' }
  }
  return postprocessCompletedBatch(prismaClient, batch.id, telemetrySettings, { batch, persist: true })
}

export function clearBatchPostprocessCache(batchId = null) {
  if (batchId === null || batchId === undefined) {
    POSTPROCESS_CACHE.clear()
    return
  }
  POSTPROCESS_CACHE.delete(Number(batchId))
}

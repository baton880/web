import { detectZoneObject } from '../../../../module-1/geo.js'
import { normalizeIngredientName } from '../../../../module-2/rationManager.js'
import { roundWeight } from '../../../../module-2/weightRounding.js'
import { TelemetryProcessor } from '../../../../module-3/telemetryProcessor.js'
import { getBatchPlan, recalculateBatchViolations } from './batch-violations.js'
import { buildPostprocessedHostTrack, detectWeightStepMarkup, resolveWeightStepOptions } from './weight-step-postprocess.js'
import { resolveEffectiveCoordinatesFromRtkPoint } from '../telemetry/telemetry-helpers.js'

const POSTPROCESS_CONTEXT_MS = 10 * 60 * 1000
const DEFAULT_FALLBACK_LEFT_BOUNDARY_MS = 10 * 60 * 1000
const MAX_DYNAMIC_LEFT_BOUNDARY_GAP_MS = 3 * 60 * 60 * 1000
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
  const calculatedPlan = getBatchPlan(batch)
  if (calculatedPlan.ingredients.length) {
    return calculatedPlan.ingredients
      .map((ingredient, index) => ({
        name: ingredient.name,
        sortOrder: Number(ingredient.sortOrder || index + 1),
        targetWeight: finiteNumberOrNull(ingredient.targetWeight)
      }))
      .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0))
  }

  const ingredients = batch?.ration?.ingredients?.length
    ? batch.ration.ingredients
    : batch?.group?.ration?.ingredients

  return (Array.isArray(ingredients) ? ingredients : [])
    .map((ingredient, index) => ({
      name: ingredient.name,
      sortOrder: Number(ingredient.sortOrder || index + 1),
      targetWeight: null
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

function buildCacheKey(batch, telemetryRows, rtkRows = [], resolvedOptions = {}, telemetrySettings = {}) {
  const last = telemetryRows[telemetryRows.length - 1]
  const lastRtk = rtkRows[rtkRows.length - 1]
  return [
    batch?.id,
    batch?.startTime ? new Date(batch.startTime).toISOString() : '',
    batch?.endTime ? new Date(batch.endTime).toISOString() : '',
    telemetryRows.length,
    last?.id || '',
    last?.timestamp ? new Date(last.timestamp).toISOString() : '',
    rtkRows.length,
    lastRtk?.id || '',
    lastRtk?.timestamp ? new Date(lastRtk.timestamp).toISOString() : '',
    JSON.stringify(resolvedOptions),
    JSON.stringify(telemetrySettings)
  ].join(':')
}

export function choosePostprocessedIngredientName(processorName, existingName, fallbackName, expectedIngredients = []) {
  const expectedKeys = new Set(expectedIngredients.map((item) => normalizeIngredientName(item.name)))
  const existingExpected = expectedKeys.has(normalizeIngredientName(existingName))
  const processorExpected = expectedKeys.has(normalizeIngredientName(processorName))

  if (processorName && (!expectedKeys.size || processorExpected)) return processorName
  if (existingName && (!expectedKeys.size || existingExpected)) return existingName
  return processorName || existingName || fallbackName || 'Unknown'
}

export function alignRepeatedIngredientWithPlan(candidateName, eventWeight, expectedIngredients, assignedWeights) {
  const candidateKey = normalizeIngredientName(candidateName)
  const assignedWeight = Number(assignedWeights.get(candidateKey) || 0)
  if (!candidateKey || assignedWeight <= 0) return candidateName

  const candidateIndex = expectedIngredients.findIndex((item) => normalizeIngredientName(item.name) === candidateKey)
  if (candidateIndex < 0 || candidateIndex + 1 >= expectedIngredients.length) return candidateName

  const current = expectedIngredients[candidateIndex]
  const next = expectedIngredients[candidateIndex + 1]
  const nextKey = normalizeIngredientName(next.name)
  if (!nextKey || Number(assignedWeights.get(nextKey) || 0) > 0) return candidateName
  if (candidateKey !== normalizeIngredientName('Солома') || nextKey !== normalizeIngredientName('Люцерна')) {
    return candidateName
  }

  const weight = Number(eventWeight)
  const currentTarget = Number(current.targetWeight)
  const nextTarget = Number(next.targetWeight)
  if (!(weight > 0) || !(currentTarget > 0) || !(nextTarget > 0)) return candidateName

  const currentErrorAfter = Math.abs(currentTarget - assignedWeight - weight)
  const nextError = Math.abs(nextTarget - weight)
  return nextError + 20 < currentErrorAfter ? next.name : candidateName
}

function isInvalidWeightPoint(point) {
  return point?.weightValid === false || point?.weightValid === 0
}

function buildInvalidWeightMarkers(telemetryRows = []) {
  return (Array.isArray(telemetryRows) ? telemetryRows : [])
    .filter(isInvalidWeightPoint)
    .map((row) => ({
      id: row.id ?? null,
      timestamp: row.timestamp,
      receivedAt: row.receivedAt || null,
      weight: 0,
      rawWeight: finiteNumberOrNull(row.rawWeight),
      telemetryWeight: finiteNumberOrNull(row.weight),
      weightValid: false,
      invalidWeight: true,
      speedKmh: finiteNumberOrNull(row.speedKmh),
      lat: finiteNumberOrNull(row.lat),
      lon: finiteNumberOrNull(row.lon)
    }))
    .filter((point) => Number.isFinite(timestampMs(point.timestamp)))
}

function compareHostTrackPoints(left, right) {
  const timeDiff = (timestampMs(left?.timestamp) ?? 0) - (timestampMs(right?.timestamp) ?? 0)
  if (timeDiff !== 0) return timeDiff

  if (Boolean(left?.invalidWeight) !== Boolean(right?.invalidWeight)) {
    return left?.invalidWeight ? 1 : -1
  }

  return Number(left?.id || 0) - Number(right?.id || 0)
}

function buildGraphHostTrack(analysis, telemetryRows = []) {
  return [
    ...buildPostprocessedHostTrack(analysis),
    ...buildInvalidWeightMarkers(telemetryRows)
  ].sort(compareHostTrackPoints)
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

export async function loadBatchPostprocessTelemetry(prismaClient, batch, options = {}) {
  const startMs = timestampMs(batch?.startTime)
  const endMs = timestampMs(batch?.endTime || batch?.startTime)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return []

  const analysisStartMs = timestampMs(options.analysisStartTime ?? options.analysisStartMs)
  const contextStartMs = Number.isFinite(analysisStartMs)
    ? Math.min(startMs - POSTPROCESS_CONTEXT_MS, analysisStartMs - POSTPROCESS_CONTEXT_MS)
    : startMs - POSTPROCESS_CONTEXT_MS

  return prismaClient.telemetry.findMany({
    where: {
      deviceId: batch.deviceId,
      timestamp: {
        gte: new Date(contextStartMs),
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
      lon: true,
      rawPayload: true
    },
    orderBy: [
      { timestamp: 'asc' },
      { id: 'asc' }
    ]
  })
}

async function findPreviousCompletedBatchEnd(prismaClient, batch) {
  const batchStartMs = timestampMs(batch?.startTime)
  if (!batch?.deviceId || !Number.isFinite(batchStartMs)) return null

  const previous = await prismaClient.batch.findFirst({
    where: {
      deviceId: batch.deviceId,
      endTime: { not: null, lt: new Date(batchStartMs) }
    },
    select: { endTime: true },
    orderBy: { endTime: 'desc' }
  })
  return timestampMs(previous?.endTime)
}

function findLastUnloadEndBeforeBatch(analysis, batchStartMs, minStartMs) {
  const events = Array.isArray(analysis?.includedEvents) ? analysis.includedEvents : []
  let lastUnloadEndMs = null
  for (const event of events) {
    if (!(Number(event?.delta) < 0)) continue
    const endMs = timestampMs(event?.endTime)
    if (!Number.isFinite(endMs) || endMs > batchStartMs || endMs < minStartMs) continue
    if (lastUnloadEndMs === null || endMs > lastUnloadEndMs) {
      lastUnloadEndMs = endMs
    }
  }
  return lastUnloadEndMs
}

function findLastTerminalRestart(telemetryRows, minStartMs, maxEndMs) {
  const ordered = (Array.isArray(telemetryRows) ? telemetryRows : [])
    .filter((row) => {
      const rowMs = timestampMs(row?.timestamp)
      return Number.isFinite(rowMs) && rowMs >= minStartMs && rowMs <= maxEndMs
    })
    .sort((left, right) => {
      const timeDiff = timestampMs(left.timestamp) - timestampMs(right.timestamp)
      return timeDiff || Number(left.id || 0) - Number(right.id || 0)
    })

  let invalidWeightSeen = false
  let lastRestartMs = null
  for (const row of ordered) {
    if (isInvalidWeightPoint(row)) {
      invalidWeightSeen = true
      continue
    }
    if (invalidWeightSeen) {
      lastRestartMs = timestampMs(row.timestamp)
      invalidWeightSeen = false
    }
  }

  return lastRestartMs
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
    loadingZones: activeZones.filter((zone) => isLoadingZone(zone, linkedBarnZoneIds)),
    linkedBarnZoneIds
  }
}

function parseRawPayload(value) {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function readRawValue(raw, keys = []) {
  const sections = [raw, raw?.pvt, raw?.navPvt, raw?.nav_pvt, raw?.position, raw?.relposned, raw?.relPosNed, raw?.rel_pos_ned, raw?.relpos, raw?.relPos, raw?.baseline]
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue
    for (const key of keys) {
      if (section[key] !== undefined && section[key] !== null && section[key] !== '') return section[key]
    }
  }
  return undefined
}

function readRawNumber(raw, keys = []) {
  const value = Number(readRawValue(raw, keys))
  return Number.isFinite(value) ? value : null
}

function readRawBoolean(raw, keys = []) {
  const value = readRawValue(raw, keys)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return undefined
}

function indexRtkPoints(points = []) {
  const all = points.map((point) => ({ ...point, timestampMs: timestampMs(point.timestamp) }))
    .filter((point) => Number.isFinite(point.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs || Number(left.id) - Number(right.id))
  const byDevice = new Map()
  for (const point of all) {
    const key = String(point.deviceId || '')
    if (!byDevice.has(key)) byDevice.set(key, [])
    byDevice.get(key).push(point)
  }
  return { all, byDevice }
}

function latestFreshPoint(points, referenceMs, freshnessMs) {
  let result = null
  for (const point of points || []) {
    if (point.timestampMs > referenceMs) break
    result = point
  }
  return result && referenceMs - result.timestampMs <= freshnessMs ? result : null
}

function resolveReplayRtkPoint(hostPoint, rtkIndex, telemetrySettings) {
  const referenceMs = timestampMs(hostPoint.timestamp)
  const freshnessMs = Number(telemetrySettings.loaderOfflineTimeoutMinutes || 4) * 60 * 1000
  return latestFreshPoint(rtkIndex.byDevice.get(hostPoint.deviceId), referenceMs, freshnessMs)
    || latestFreshPoint(rtkIndex.all, referenceMs, freshnessMs)
}

function buildRtkScoreboardPacket(point, deviceId) {
  const raw = parseRawPayload(point.rawPayload)
  const flags = readRawNumber(raw, ['relPosFlags', 'rel_pos_flags', 'flags'])
  return {
    deviceId,
    hostDeviceId: deviceId,
    timestamp: point.timestamp,
    lat: Number(point.lat),
    lon: Number(point.lon),
    speedKmh: Number(point.speed || 0),
    headingDeg: point.course ?? readRawNumber(raw, ['heading', 'course', 'azimuth', 'headingDeg', 'heading_deg']),
    headingAccDeg: readRawNumber(raw, ['headingAccDeg', 'heading_acc_deg', 'accHeadingDeg', 'acc_heading_deg']),
    relPosValid: readRawBoolean(raw, ['rel_pos_valid', 'relPosValid']) ?? (Number.isInteger(flags) ? Boolean(flags & (1 << 2)) : undefined),
    relPosHeadingValid: readRawBoolean(raw, ['rel_pos_heading_valid', 'relPosHeadingValid', 'headingValid', 'heading_valid'])
      ?? (Number.isInteger(flags) ? Boolean(flags & (1 << 8)) : undefined)
  }
}

async function loadPostprocessRtk(prismaClient, telemetryRows, telemetrySettings) {
  const firstMs = timestampMs(telemetryRows[0]?.timestamp)
  const lastMs = timestampMs(telemetryRows[telemetryRows.length - 1]?.timestamp)
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return []
  const freshnessMs = Number(telemetrySettings.loaderOfflineTimeoutMinutes || 4) * 60 * 1000
  return prismaClient.rtkTelemetry.findMany({
    where: { timestamp: { gte: new Date(firstMs - freshnessMs), lte: new Date(lastMs) } },
    orderBy: [{ timestamp: 'asc' }, { id: 'asc' }]
  })
}

async function buildPostprocessedIngredients(prismaClient, batch, analysis, telemetrySettings, telemetryRows = [], rtkRows = []) {
  const loadEvents = (analysis.includedEvents || []).filter((event) => event.delta > 0)

  const { activeZones, loadingZones, linkedBarnZoneIds } = await loadLoadingZones(prismaClient)
  const expectedIngredients = expectedIngredientsFromBatch(batch)
  const processor = new TelemetryProcessor()
  const usedExpectedKeys = new Set()
  const filteredSpeedTimeline = (analysis.points || []).map((point) => ({
    timestamp: point.speedTimestamp || point.timestamp,
    speedKmh: point.speedKmh
  }))
  const hostPoints = telemetryRows.map((point) => ({
    ...point,
    deviceId: batch.deviceId || point.deviceId || 'host_01',
    speedKmh: findClosestTelemetryPoint(filteredSpeedTimeline, timestampMs(point.timestamp))?.speedKmh ?? 0
  }))
  const rtkIndex = indexRtkPoints(rtkRows)
  const deviceId = batch.deviceId || 'host_01'
  let hostCursor = 0
  let rtkScoreCursor = 0
  let lastReplayPacket = null
  const replayFrames = []

  function serializeReplayZone(zone) {
    return zone ? {
      id: zone.id ?? null,
      name: zone.name || null,
      ingredient: zone.ingredient || zone.name || null
    } : null
  }

  function replayRtkUntil(referenceMs) {
    while (rtkScoreCursor < rtkIndex.all.length && rtkIndex.all[rtkScoreCursor].timestampMs <= referenceMs) {
      processor.processLoaderPacket(buildRtkScoreboardPacket(rtkIndex.all[rtkScoreCursor], deviceId), loadingZones, telemetrySettings, { deviceId })
      rtkScoreCursor += 1
    }
  }

  function replayHostUntil(referenceMs) {
    while (hostCursor < hostPoints.length && timestampMs(hostPoints[hostCursor].timestamp) <= referenceMs) {
      const hostPoint = hostPoints[hostCursor]
      const pointMs = timestampMs(hostPoint.timestamp)
      replayRtkUntil(pointMs)
      const raw = parseRawPayload(hostPoint.rawPayload)
      const rtkPoint = resolveReplayRtkPoint(hostPoint, rtkIndex, telemetrySettings)
      const effective = resolveEffectiveCoordinatesFromRtkPoint(hostPoint, rtkPoint, telemetrySettings)
      const currentZoneEvidenceAgeMs = effective.source === 'rtk'
        ? Math.max(0, pointMs - timestampMs(effective.rtkPoint?.timestamp))
        : null
      const processorPacket = {
        ...hostPoint,
        weight: 0,
        rawWeight: 0,
        weightValid: true,
        lat: effective.lat,
        lon: effective.lon,
        headingDeg: effective.rtkPoint?.course ?? readRawNumber(raw, ['heading', 'headingDeg', 'heading_deg', 'course']),
        course: effective.rtkPoint?.course ?? readRawNumber(raw, ['course', 'heading'])
      }
      const currentZone = detectZoneObject(effective.lat, effective.lon, activeZones)
      const hostLoadingZone = detectZoneObject(Number(hostPoint.lat), Number(hostPoint.lon), loadingZones)
      const hostForceIngredientName = hostLoadingZone?.ingredient || hostLoadingZone?.name || null
      const suppressLoading = isBarnZone(currentZone, linkedBarnZoneIds)
      processor.processPacket(processorPacket, loadingZones, telemetrySettings, {
        suppressLoading,
        skipZoneVisit: effective.source === 'rtk',
        allowVisitedZoneIngredient: effective.source === 'rtk',
        preferCurrentZoneIngredient: effective.source === 'rtk',
        currentZoneEvidenceAgeMs,
        hostLat: Number(hostPoint.lat),
        hostLon: Number(hostPoint.lon),
        hostForceIngredientName,
        expectedIngredients
      })
      const loaderZone = rtkPoint
        ? detectZoneObject(Number(rtkPoint.lat), Number(rtkPoint.lon), loadingZones)
        : null
      replayFrames.push({
        timestamp: hostPoint.timestamp,
        filteredSpeedKmh: Number(hostPoint.speedKmh || 0),
        host: {
          lat: Number(hostPoint.lat),
          lon: Number(hostPoint.lon),
          zone: serializeReplayZone(hostLoadingZone)
        },
        loader: rtkPoint ? {
          lat: Number(rtkPoint.lat),
          lon: Number(rtkPoint.lon),
          speedKmh: finiteNumberOrNull(rtkPoint.speed),
          course: finiteNumberOrNull(rtkPoint.course),
          zone: serializeReplayZone(loaderZone)
        } : null,
        effective: {
          source: effective.source,
          lat: Number(effective.lat),
          lon: Number(effective.lon),
          zone: serializeReplayZone(currentZone),
          loaderDistanceMeters: finiteNumberOrNull(effective.loaderDistanceMeters),
          ignoredReason: effective.ignoredReason || null
        },
        scoreboard: processor.getZoneScoreboard(deviceId)
      })
      lastReplayPacket = { packet: processorPacket, effective }
      hostCursor += 1
    }
  }

  const results = []
  for (const event of loadEvents) {
    const startMs = timestampMs(event.startTime)
    const endMs = timestampMs(event.endTime) || startMs
    replayHostUntil(startMs)
    replayRtkUntil(startMs)
    const startHost = findClosestTelemetryPoint(hostPoints, startMs)
    if (!lastReplayPacket && startHost) replayHostUntil(timestampMs(startHost.timestamp))
    const startPacket = lastReplayPacket?.packet || {
      deviceId,
      timestamp: new Date(startMs),
      lat: Number(startHost?.lat),
      lon: Number(startHost?.lon),
      speedKmh: Number(startHost?.speedKmh || 0),
      weight: 0
    }
    const determination = loadingZones.length
      ? processor.resolveIngredientAtKnownLoadingStart({ ...startPacket, timestamp: new Date(startMs) }, loadingZones, telemetrySettings, {
        deviceId,
        allowVisitedZoneIngredient: lastReplayPacket?.effective?.source === 'rtk',
        preferCurrentZoneIngredient: lastReplayPacket?.effective?.source === 'rtk',
        expectedIngredients,
        effectivePositionSource: lastReplayPacket?.effective?.source || 'host',
        currentZoneEvidenceAgeMs: lastReplayPacket?.effective?.source === 'rtk'
          ? Math.max(0, startMs - timestampMs(lastReplayPacket.effective.rtkPoint?.timestamp))
          : null,
        hostLat: Number(startHost?.lat),
        hostLon: Number(startHost?.lon),
        returnDecisionDetails: true
      })
      : null
    const processorName = determination?.ingredientName || null
    const ingredientName = processorName || 'Unknown'
    const ingredientKey = normalizeIngredientName(ingredientName)
    if (ingredientKey) {
      usedExpectedKeys.add(ingredientKey)
    }

    replayHostUntil(endMs)
    replayRtkUntil(endMs)
    processor.completeKnownLoadingSegment(deviceId, {
      timestamp: new Date(endMs),
      lat: lastReplayPacket?.packet?.lat,
      lon: lastReplayPacket?.packet?.lon,
      weight: 0
    })
    const state = processor.deviceStates.get(deviceId)
    if (state) {
      state.loadedIngredientKeys = Array.from(usedExpectedKeys)
      state.lastIngredientName = ingredientName
    }

    const closestStart = findClosestTelemetryPoint(analysis.points, timestampMs(event.startTime))
    const closestEnd = findClosestTelemetryPoint(analysis.points, timestampMs(event.endTime))
    results.push({
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
      afterLevel: event.afterLevel,
      determination
    })
  }
  const replayEndMs = timestampMs(analysis?.bounds?.endTime)
  if (Number.isFinite(replayEndMs)) {
    replayHostUntil(replayEndMs)
    replayRtkUntil(replayEndMs)
  }
  return { ingredients: results, replayFrames }
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

  const baseStepOptions = {
    ...postprocessOptionsFromSettings(telemetrySettings),
    ...(options.stepOptions || {})
  }
  const resolvedOptions = resolveWeightStepOptions(baseStepOptions)
  const batchStartMs = timestampMs(batch.startTime)
  const defaultLeftBoundaryMs = batchStartMs - DEFAULT_FALLBACK_LEFT_BOUNDARY_MS
  const previousBatchEndMs = await findPreviousCompletedBatchEnd(prismaClient, batch)
  const previousBatchIsRecent = Number.isFinite(previousBatchEndMs) &&
    batchStartMs - previousBatchEndMs <= MAX_DYNAMIC_LEFT_BOUNDARY_GAP_MS
  const initialLeftBoundaryMs = previousBatchIsRecent
    ? previousBatchEndMs
    : defaultLeftBoundaryMs
  const telemetryRows = options.telemetryRows || await loadBatchPostprocessTelemetry(prismaClient, batch, {
    analysisStartMs: initialLeftBoundaryMs
  })
  const rtkRows = options.rtkRows || await loadPostprocessRtk(prismaClient, telemetryRows, telemetrySettings)
  const cacheKey = buildCacheKey(batch, telemetryRows, rtkRows, resolvedOptions, telemetrySettings)
  const cached = POSTPROCESS_CACHE.get(batch.id)
  if (!options.disableCache && cached?.cacheKey === cacheKey && (!options.requirePersisted || cached.persisted)) {
    return cached.result
  }

  const terminalRestartMs = findLastTerminalRestart(telemetryRows, initialLeftBoundaryMs, timestampMs(batch.endTime))
  const restartAwareLeftBoundaryMs = Number.isFinite(terminalRestartMs)
    ? Math.max(initialLeftBoundaryMs, terminalRestartMs)
    : initialLeftBoundaryMs
  const initialAnalysis = detectWeightStepMarkup(batch, telemetryRows, {
    ...baseStepOptions,
    analysisStartMs: restartAwareLeftBoundaryMs
  })
  const lastUnloadEndMs = findLastUnloadEndBeforeBatch(initialAnalysis, batchStartMs, restartAwareLeftBoundaryMs)
  const leftBoundaryMs = Number.isFinite(lastUnloadEndMs)
    ? Math.max(restartAwareLeftBoundaryMs, lastUnloadEndMs)
    : restartAwareLeftBoundaryMs
  const analysis = leftBoundaryMs > restartAwareLeftBoundaryMs
    ? detectWeightStepMarkup(batch, telemetryRows, { ...baseStepOptions, analysisStartMs: leftBoundaryMs })
    : initialAnalysis

  if (analysis?.bounds) {
    analysis.bounds.terminalRestartTime = Number.isFinite(terminalRestartMs) ? new Date(terminalRestartMs) : null
    analysis.bounds.leftSource = Number.isFinite(lastUnloadEndMs) && lastUnloadEndMs >= restartAwareLeftBoundaryMs
      ? 'last-unload-end'
      : Number.isFinite(terminalRestartMs) && terminalRestartMs >= initialLeftBoundaryMs
        ? 'terminal-restart'
      : previousBatchIsRecent
        ? 'previous-batch-end'
        : 'default-lookback'
  }

  if (analysis.status !== 'complete') {
    const result = {
      status: analysis.status,
      reason: analysis.reason,
      analysis,
      ingredients: [],
      generatedAt: new Date()
    }
    if (!options.disableCache) {
      POSTPROCESS_CACHE.set(batch.id, { cacheKey, result, persisted: false })
    }
    return result
  }

  const replayTelemetryRows = telemetryRows.filter((row) => timestampMs(row.timestamp) >= leftBoundaryMs)
  const replayRtkRows = rtkRows.filter((row) => timestampMs(row.timestamp) >= leftBoundaryMs)
  const postprocessed = await buildPostprocessedIngredients(
    prismaClient,
    batch,
    analysis,
    telemetrySettings,
    replayTelemetryRows,
    replayRtkRows
  )
  const result = {
    status: 'complete',
    reason: null,
    analysis,
    ingredients: postprocessed.ingredients,
    replayFrames: postprocessed.replayFrames,
    hostTrack: buildGraphHostTrack(analysis, telemetryRows),
    generatedAt: new Date()
  }
  if (!options.disableCache) {
    POSTPROCESS_CACHE.set(batch.id, { cacheKey, result, persisted: false })
  }
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

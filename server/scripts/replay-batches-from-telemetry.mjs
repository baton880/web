import { PrismaClient } from '@prisma/client'

import telemetryProcessor from '../../module-3/telemetryProcessor.js'
import { calculateHaversine, detectZoneObject } from '../../module-1/geo.js'
import { normalizeIngredientName } from '../../module-2/rationManager.js'
import { roundNonNegativeWeight, roundWeight } from '../../module-2/weightRounding.js'
import { DEFAULT_TELEMETRY_SETTINGS } from '../src/modules/telemetry/telemetry-settings.js'
import { TELEMETRY_FRESHNESS_MS } from '../src/modules/telemetry/telemetry-helpers.js'
import { recalculateBatchViolations } from '../src/modules/batches/batch-violations.js'
import { recordLeftoverViolation } from '../src/modules/violations/violation-service.js'
import { alignAmbiguousIngredientsWithRation } from '../src/modules/telemetry/loading-zone-correction.js'

const prisma = new PrismaClient()
const SAME_INGREDIENT_MERGE_WINDOW_MS = 10000
const UNLOAD_GROUP_STICKY_MS = 120000
const UNLOAD_GROUP_CONFIRM_PACKETS = 2
const MIN_UNLOAD_GROUP_CONFIRM_DROP_KG = 500
const PRELUDE_BATCH_MAX_DURATION_MS = 3 * 60 * 1000
const PRELUDE_BATCH_MAX_GAP_MS = 4 * 60 * 1000
const PRELUDE_BATCH_MAX_INGREDIENTS = 1
const PRELUDE_BATCH_MAX_WEIGHT_BUFFER_KG = 30
const BATCH_START_INGREDIENT_LOOKBACK_MS = 10 * 60 * 1000
const APPLY_WEIGHT_CALIBRATION_ON_REPLAY = ['1', 'true', 'yes'].includes(
  String(process.env.REPLAY_APPLY_WEIGHT_CALIBRATION || '').trim().toLowerCase()
)

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return Boolean(value)
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function timestampMs(value) {
  if (!value) return Number.NaN
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
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

function buildGroupZoneShape(group) {
  if (group?.storageZone) {
    return {
      ...group.storageZone,
      lat: Number(group.storageZone.lat),
      lon: Number(group.storageZone.lon),
      radius: Number(group.storageZone.radius)
    }
  }

  if (
    Number.isFinite(Number(group?.lat)) &&
    Number.isFinite(Number(group?.lon)) &&
    Number.isFinite(Number(group?.radius)) &&
    Number(group.radius) > 0
  ) {
    return {
      id: `group-fallback-${group.id}`,
      name: group.name,
      lat: Number(group.lat),
      lon: Number(group.lon),
      radius: Number(group.radius),
      shapeType: 'CIRCLE',
      active: true
    }
  }

  return null
}

function resolveGroupFromList(groups, lat, lon) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    return null
  }

  for (const group of groups) {
    const zoneCandidate = buildGroupZoneShape(group)
    if (!zoneCandidate) continue

    const matchedZone = detectZoneObject(Number(lat), Number(lon), [zoneCandidate])
    if (!matchedZone) continue

    return {
      id: group.id,
      name: group.name,
      rationId: group.rationId ?? null,
      storageZoneId: group.storageZoneId ?? null,
      matchedZoneId: group.storageZone?.id ?? null,
      ration: group.ration || null
    }
  }

  return null
}

function resolveExpectedIngredientsFromGroup(group) {
  const ingredients = group?.ration?.ingredients
  return Array.isArray(ingredients)
    ? ingredients.map((ingredient) => ({
      name: ingredient.name,
      sortOrder: Number(ingredient.sortOrder || 0)
    }))
    : []
}

function unloadGroupConfirmDropKg(settings = {}) {
  const configured = Number(settings.unloadDropThresholdKg)
  return Number.isFinite(configured) && configured > 0
    ? Math.max(MIN_UNLOAD_GROUP_CONFIRM_DROP_KG, configured)
    : MIN_UNLOAD_GROUP_CONFIRM_DROP_KG
}

function createUnloadGroupEvidence(weight, timestamp, group = null) {
  const timestampMs = new Date(timestamp).getTime()
  return {
    lastWeight: Number.isFinite(Number(weight)) ? Number(weight) : null,
    lastTimeMs: Number.isFinite(timestampMs) ? timestampMs : null,
    lastGroup: group || null,
    lastGroupSeenAtMs: group && Number.isFinite(timestampMs) ? timestampMs : null,
    confirmedGroupId: null,
    groups: new Map()
  }
}

function rememberUnloadGroupEvidence(evidenceMap, batchId, { weight, timestamp, group = null, settings = {} }) {
  if (!batchId) return null
  const parsedWeight = Number(weight)
  const timestampMs = new Date(timestamp).getTime()
  if (!Number.isFinite(parsedWeight) || !Number.isFinite(timestampMs)) return null

  let evidence = evidenceMap.get(batchId)
  if (!evidence) {
    evidence = createUnloadGroupEvidence(parsedWeight, timestamp, group)
    evidenceMap.set(batchId, evidence)
    return null
  }

  let evidenceGroup = group || null
  if (group) {
    evidence.lastGroup = group
    evidence.lastGroupSeenAtMs = timestampMs
  } else if (
    evidence.lastGroup &&
    Number.isFinite(Number(evidence.lastGroupSeenAtMs)) &&
    timestampMs - Number(evidence.lastGroupSeenAtMs) <= UNLOAD_GROUP_STICKY_MS
  ) {
    evidenceGroup = evidence.lastGroup
  }

  const previousWeight = Number(evidence.lastWeight)
  const drop = Number.isFinite(previousWeight) ? previousWeight - parsedWeight : 0
  if (evidenceGroup?.id && Number.isFinite(drop) && drop > 0) {
    const key = String(evidenceGroup.id)
    const current = evidence.groups.get(key) || {
      group: evidenceGroup,
      dropKg: 0,
      packets: 0
    }
    current.group = evidenceGroup
    current.dropKg += drop
    current.packets += 1
    evidence.groups.set(key, current)
  }

  evidence.lastWeight = parsedWeight
  evidence.lastTimeMs = timestampMs

  let best = null
  for (const item of evidence.groups.values()) {
    if (!best || item.dropKg > best.dropKg) {
      best = item
    }
  }

  if (
    best?.group?.id &&
    best.dropKg >= unloadGroupConfirmDropKg(settings) &&
    best.packets >= UNLOAD_GROUP_CONFIRM_PACKETS &&
    evidence.confirmedGroupId !== best.group.id
  ) {
    evidence.confirmedGroupId = best.group.id
    return best.group
  }

  return null
}

function indexRtkPoints(points) {
  const byDevice = new Map()
  for (const point of points) {
    const timestampMs = new Date(point.timestamp).getTime()
    const item = { ...point, timestampMs }
    const deviceId = String(point.deviceId || '')
    if (!byDevice.has(deviceId)) byDevice.set(deviceId, [])
    byDevice.get(deviceId).push(item)
  }

  for (const list of byDevice.values()) {
    list.sort((left, right) => left.timestampMs - right.timestampMs || left.id - right.id)
  }

  const all = points
    .map((point) => ({ ...point, timestampMs: new Date(point.timestamp).getTime() }))
    .sort((left, right) => left.timestampMs - right.timestampMs || left.id - right.id)

  return { byDevice, all }
}

function latestFreshPoint(points, referenceMs, thresholdMs = TELEMETRY_FRESHNESS_MS) {
  if (!Array.isArray(points) || !points.length || !Number.isFinite(referenceMs)) {
    return null
  }

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

function resolveEffectivePosition(packet, rtkIndex, settings = {}) {
  const referenceMs = new Date(packet.timestamp).getTime()
  const loaderOfflineTimeoutMinutes = Number(settings.loaderOfflineTimeoutMinutes) > 0
    ? Number(settings.loaderOfflineTimeoutMinutes)
    : DEFAULT_TELEMETRY_SETTINGS.loaderOfflineTimeoutMinutes
  const loaderMaxDistanceMeters = Number(settings.loaderMaxDistanceMeters) > 0
    ? Number(settings.loaderMaxDistanceMeters)
    : 150
  const freshnessMs = loaderOfflineTimeoutMinutes * 60 * 1000
  const sameDevice = latestFreshPoint(rtkIndex.byDevice.get(packet.deviceId), referenceMs, freshnessMs)
  const rtkPoint = sameDevice || latestFreshPoint(rtkIndex.all, referenceMs, freshnessMs)

  if (rtkPoint) {
    const hostLat = Number(packet.lat)
    const hostLon = Number(packet.lon)
    const loaderLat = Number(rtkPoint.lat)
    const loaderLon = Number(rtkPoint.lon)
    if (
      Number.isFinite(hostLat) &&
      Number.isFinite(hostLon) &&
      Number.isFinite(loaderLat) &&
      Number.isFinite(loaderLon)
    ) {
      const distanceMeters = calculateHaversine(hostLat, hostLon, loaderLat, loaderLon)
      if (distanceMeters > loaderMaxDistanceMeters) {
        return {
          lat: hostLat,
          lon: hostLon,
          source: 'host',
          rtkPoint: null,
          ignoredRtkPoint: rtkPoint,
          ignoredReason: 'loader_far',
          loaderDistanceMeters: distanceMeters
        }
      }

      return {
        lat: loaderLat,
        lon: loaderLon,
        source: 'rtk',
        rtkPoint,
        loaderDistanceMeters: distanceMeters
      }
    }

    return {
      lat: Number(packet.lat),
      lon: Number(packet.lon),
      source: 'host',
      rtkPoint: null,
      ignoredRtkPoint: rtkPoint,
      ignoredReason: 'host_position_missing'
    }
  }

  return {
    lat: Number(packet.lat),
    lon: Number(packet.lon),
    source: 'host',
    rtkPoint: null,
    ignoredReason: 'loader_offline'
  }
}

function normalizeTelemetryRow(row) {
  return {
    id: row.id,
    deviceId: row.deviceId || 'host_01',
    timestamp: row.timestamp,
    lat: Number(row.lat || 0),
    lon: Number(row.lon || 0),
    gpsValid: parseBoolean(row.gpsValid),
    gpsSatellites: Number(row.gpsSatellites || 0),
    speedKmh: row.speedKmh === null || row.speedKmh === undefined ? null : Number(row.speedKmh),
    weight: Number(row.weight || 0),
    rawWeight: row.rawWeight === null || row.rawWeight === undefined ? null : Number(row.rawWeight),
    weightValid: parseBoolean(row.weightValid),
    gpsQuality: Number(row.gpsQuality || 0),
    wifiClients: row.wifiClients ?? [],
    cpuTempC: row.cpuTempC ?? null,
    lteRssiDbm: row.lteRssiDbm ?? null,
    lteAccessTech: row.lteAccessTech ?? null,
    eventsReaderOk: parseBoolean(row.eventsReaderOk)
  }
}

function applyWeightCalibration(packet, telemetrySettings = {}) {
  const factor = Number(telemetrySettings.weightCalibrationFactor)
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) {
    return packet
  }

  return {
    ...packet,
    weight: Number(packet.weight || 0) * factor
  }
}

function parseRawPayload(rawPayload) {
  if (typeof rawPayload !== 'string' || !rawPayload.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawPayload)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function readRawBoolean(raw, keys = []) {
  for (const key of keys) {
    if (raw[key] === undefined || raw[key] === null) continue
    if (typeof raw[key] === 'boolean') return raw[key]
    if (typeof raw[key] === 'number') return raw[key] !== 0
    if (typeof raw[key] === 'string') {
      const normalized = raw[key].trim().toLowerCase()
      if (normalized === 'true' || normalized === '1') return true
      if (normalized === 'false' || normalized === '0') return false
    }
  }

  return undefined
}

function readRawNumber(raw, keys = []) {
  for (const key of keys) {
    const parsed = Number(raw[key])
    if (Number.isFinite(parsed)) return parsed
  }

  return null
}

function buildLoaderScoreboardPacket(row, hostDeviceId) {
  const raw = parseRawPayload(row.rawPayload)

  return {
    deviceId: hostDeviceId,
    hostDeviceId,
    timestamp: row.timestamp,
    lat: Number(row.lat),
    lon: Number(row.lon),
    speedKmh: Number(row.speed || 0),
    headingDeg: readRawNumber(raw, ['heading', 'headingDeg', 'heading_deg']) ?? row.course,
    headingAccDeg: readRawNumber(raw, ['heading_acc_deg', 'headingAccDeg', 'headingAcc']),
    relPosValid: readRawBoolean(raw, ['rel_pos_valid', 'relPosValid']),
    relPosHeadingValid: readRawBoolean(raw, ['rel_pos_heading_valid', 'relPosHeadingValid', 'headingValid'])
  }
}

function replayRtkScoreboardUntil({
  rtkPoints = [],
  cursor = 0,
  referenceMs,
  hostDeviceId,
  loadingZones,
  telemetrySettings
}) {
  let nextCursor = cursor

  while (
    nextCursor < rtkPoints.length &&
    Number(rtkPoints[nextCursor].timestampMs) <= referenceMs
  ) {
    telemetryProcessor.processLoaderPacket(
      buildLoaderScoreboardPacket(rtkPoints[nextCursor], hostDeviceId),
      loadingZones,
      telemetrySettings,
      { deviceId: hostDeviceId }
    )
    nextCursor += 1
  }

  return nextCursor
}

function rememberRecentWeight(recentWeightsByDevice, deviceId, weight, limit) {
  const list = recentWeightsByDevice.get(deviceId) || []
  list.unshift(roundWeight(weight || 0))
  if (list.length > limit) list.length = limit
  recentWeightsByDevice.set(deviceId, list)
  return list
}

async function resetCalculatedTables() {
  await prisma.violation.deleteMany({})
  await prisma.batchIngredient.deleteMany({})
  await prisma.batch.deleteMany({})
  await prisma.$executeRawUnsafe("DELETE FROM sqlite_sequence WHERE name IN ('Violation', 'BatchIngredient', 'Batch')")

  const batchIdSequenceStart = Number.parseInt(process.env.REPLAY_BATCH_ID_SEQUENCE_START || '', 10)
  if (Number.isInteger(batchIdSequenceStart) && batchIdSequenceStart > 0) {
    await prisma.$executeRawUnsafe(
      `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('Batch', ${batchIdSequenceStart})`
    )
  }
}

async function mergeEmptyCarryoverBatches(batchIdsToRecalculate) {
  const batches = await prisma.batch.findMany({
    orderBy: [
      { deviceId: 'asc' },
      { startTime: 'asc' },
      { id: 'asc' }
    ],
    include: {
      actualIngredients: {
        select: { id: true }
      }
    }
  })

  let merged = 0
  let previous = null

  for (const batch of batches) {
    const hasIngredients = (batch.actualIngredients?.length || 0) > 0
    const previousEndMs = previous?.endTime ? new Date(previous.endTime).getTime() : Number.NaN
    const batchStartMs = batch.startTime ? new Date(batch.startTime).getTime() : Number.NaN
    const isAdjacentCarryover = previous &&
      previous.deviceId === batch.deviceId &&
      Number.isFinite(previousEndMs) &&
      Number.isFinite(batchStartMs) &&
      Math.abs(previousEndMs - batchStartMs) <= 1000

    if (hasIngredients && isAdjacentCarryover && !previous.groupId && batch.groupId) {
      await prisma.violation.deleteMany({ where: { batchId: batch.id } })
      await prisma.batchIngredient.updateMany({
        where: { batchId: batch.id },
        data: { batchId: previous.id }
      })

      const data = {
        endTime: batch.endTime,
        endWeight: roundWeight(batch.endWeight ?? previous.endWeight ?? 0),
        groupId: batch.groupId
      }
      if (batch.rationId) {
        data.rationId = batch.rationId
      }

      previous = await prisma.batch.update({
        where: { id: previous.id },
        data,
        include: {
          actualIngredients: {
            select: { id: true }
          }
        }
      })
      await prisma.batch.delete({ where: { id: batch.id } })
      batchIdsToRecalculate.delete(batch.id)
      batchIdsToRecalculate.add(previous.id)
      merged += 1
      continue
    }

    if (!hasIngredients && batch.endTime && isAdjacentCarryover) {
      await prisma.violation.deleteMany({ where: { batchId: batch.id } })

      const data = {
        endTime: batch.endTime,
        endWeight: roundWeight(batch.endWeight ?? previous.endWeight ?? 0)
      }
      if (batch.groupId) {
        data.groupId = batch.groupId
      }
      if (batch.rationId) {
        data.rationId = batch.rationId
      }

      previous = await prisma.batch.update({
        where: { id: previous.id },
        data,
        include: {
          actualIngredients: {
            select: { id: true }
          }
        }
      })
      await prisma.batch.delete({ where: { id: batch.id } })
      batchIdsToRecalculate.delete(batch.id)
      batchIdsToRecalculate.add(previous.id)
      merged += 1
      continue
    }

    previous = batch
  }

  return merged
}

function batchIngredientTotal(batch) {
  return (batch.actualIngredients || []).reduce((sum, ingredient) => {
    const weight = Number(ingredient.actualWeight || 0)
    return sum + (Number.isFinite(weight) ? Math.max(0, weight) : 0)
  }, 0)
}

function earliestIngredientDate(batch) {
  let earliest = null
  for (const ingredient of (batch.actualIngredients || [])) {
    const candidates = [ingredient.startedAt, ingredient.addedAt]
    for (const candidate of candidates) {
      const candidateMs = timestampMs(candidate)
      if (!Number.isFinite(candidateMs)) continue
      if (!earliest || candidateMs < earliest.getTime()) {
        earliest = new Date(candidateMs)
      }
    }
  }
  return earliest
}

function ingredientMatchesBatchPlan(ingredientName, batch) {
  const normalized = normalizeIngredientName(ingredientName)
  if (!normalized) return false
  const planIngredients = batch?.ration?.ingredients || batch?.group?.ration?.ingredients || []
  return planIngredients.some((item) => normalizeIngredientName(item?.name) === normalized)
}

function shouldMergePreludeBatch(previous, batch, settings = {}) {
  if (!previous || !batch) return false
  if (previous.deviceId !== batch.deviceId) return false

  const previousIngredients = previous.actualIngredients || []
  const nextIngredients = batch.actualIngredients || []
  if (previousIngredients.length < 1 || previousIngredients.length > PRELUDE_BATCH_MAX_INGREDIENTS) return false
  if (nextIngredients.length < 1) return false

  const previousStartMs = timestampMs(previous.startTime)
  const previousEndMs = timestampMs(previous.endTime)
  const batchStartMs = timestampMs(batch.startTime)
  if (!Number.isFinite(previousStartMs) || !Number.isFinite(previousEndMs) || !Number.isFinite(batchStartMs)) return false

  const durationMs = previousEndMs - previousStartMs
  const gapMs = batchStartMs - previousEndMs
  if (durationMs < 0 || durationMs > PRELUDE_BATCH_MAX_DURATION_MS) return false
  if (gapMs < 0 || gapMs > PRELUDE_BATCH_MAX_GAP_MS) return false

  const emptyThresholdKg = Number(settings.emptyVehicleThresholdKg) > 0
    ? Number(settings.emptyVehicleThresholdKg)
    : DEFAULT_TELEMETRY_SETTINGS.emptyVehicleThresholdKg
  const maxPreludeWeightKg = emptyThresholdKg + PRELUDE_BATCH_MAX_WEIGHT_BUFFER_KG
  const totalWeight = batchIngredientTotal(previous)
  if (totalWeight <= 0 || totalWeight > maxPreludeWeightKg) return false

  const previousEndWeight = roundNonNegativeWeight(previous.endWeight ?? 0)
  if (previousEndWeight > emptyThresholdKg) return false

  return previousIngredients.every((ingredient) => (
    ingredientMatchesBatchPlan(ingredient.ingredientName, batch)
  ))
}

async function mergeShortPreludeBatches(batchIdsToRecalculate, settings = {}) {
  const batches = await prisma.batch.findMany({
    orderBy: [
      { deviceId: 'asc' },
      { startTime: 'asc' },
      { id: 'asc' }
    ],
    include: {
      group: {
        include: {
          ration: {
            include: { ingredients: true }
          }
        }
      },
      ration: {
        include: { ingredients: true }
      },
      actualIngredients: {
        orderBy: [
          { addedAt: 'asc' },
          { id: 'asc' }
        ]
      }
    }
  })

  let merged = 0
  let previous = null

  for (const batch of batches) {
    if (!shouldMergePreludeBatch(previous, batch, settings)) {
      previous = batch
      continue
    }

    const mergedStart = earliestIngredientDate(previous) || previous.startTime
    const data = {
      startTime: mergedStart,
      startWeight: roundWeight(previous.startWeight ?? batch.startWeight ?? 0)
    }

    await prisma.violation.deleteMany({
      where: { batchId: { in: [previous.id, batch.id] } }
    })
    await prisma.batchIngredient.updateMany({
      where: { batchId: previous.id },
      data: { batchId: batch.id }
    })
    const updatedBatch = await prisma.batch.update({
      where: { id: batch.id },
      data,
      include: {
        group: {
          include: {
            ration: {
              include: { ingredients: true }
            }
          }
        },
        ration: {
          include: { ingredients: true }
        },
        actualIngredients: {
          orderBy: [
            { addedAt: 'asc' },
            { id: 'asc' }
          ]
        }
      }
    })
    await prisma.batch.delete({ where: { id: previous.id } })
    batchIdsToRecalculate.delete(previous.id)
    batchIdsToRecalculate.add(updatedBatch.id)
    previous = updatedBatch
    merged += 1
  }

  return merged
}

async function alignBatchStartsWithEarliestIngredient(batchIdsToRecalculate) {
  const batches = await prisma.batch.findMany({
    include: {
      actualIngredients: {
        select: {
          startedAt: true,
          addedAt: true
        }
      }
    }
  })

  let aligned = 0
  for (const batch of batches) {
    const batchStartMs = timestampMs(batch.startTime)
    const ingredientStart = earliestIngredientDate(batch)
    const ingredientStartMs = timestampMs(ingredientStart)
    if (!Number.isFinite(batchStartMs) || !Number.isFinite(ingredientStartMs)) continue

    const lookbackMs = batchStartMs - ingredientStartMs
    if (lookbackMs <= 1000 || lookbackMs > BATCH_START_INGREDIENT_LOOKBACK_MS) continue

    await prisma.batch.update({
      where: { id: batch.id },
      data: { startTime: ingredientStart }
    })
    batchIdsToRecalculate.add(batch.id)
    aligned += 1
  }

  return aligned
}

async function main() {
  telemetryProcessor.clearStates()

  const [
    telemetryCount,
    rtkCount,
    activeZones,
    livestockGroups,
    telemetrySettingsRaw
  ] = await Promise.all([
    prisma.telemetry.count(),
    prisma.rtkTelemetry.count(),
    prisma.storageZone.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
    prisma.livestockGroup.findMany({
      include: {
        storageZone: true,
        ration: { include: { ingredients: true } }
      },
      orderBy: { id: 'asc' }
    }),
    prisma.telemetrySettings.findUnique({ where: { id: 1 } })
  ])

  const telemetrySettings = telemetrySettingsRaw || DEFAULT_TELEMETRY_SETTINGS
  const autoCloseZeroWeightKg = Number(telemetrySettings.autoCloseZeroWeightKg) > 0
    ? Number(telemetrySettings.autoCloseZeroWeightKg)
    : DEFAULT_TELEMETRY_SETTINGS.autoCloseZeroWeightKg
  const autoCloseEmptyStreak = Number(telemetrySettings.autoCloseEmptyStreak) > 0
    ? Number(telemetrySettings.autoCloseEmptyStreak)
    : DEFAULT_TELEMETRY_SETTINGS.autoCloseEmptyStreak
  const autoCloseNegativeStreak = Number(telemetrySettings.autoCloseNegativeStreak) > 0
    ? Number(telemetrySettings.autoCloseNegativeStreak)
    : DEFAULT_TELEMETRY_SETTINGS.autoCloseNegativeStreak
  const emptyVehicleThresholdKg = Number(telemetrySettings.emptyVehicleThresholdKg) > 0
    ? Number(telemetrySettings.emptyVehicleThresholdKg)
    : DEFAULT_TELEMETRY_SETTINGS.emptyVehicleThresholdKg
  const linkedBarnZoneIds = new Set(
    livestockGroups
      .map((group) => Number(group.storageZoneId))
      .filter((zoneId) => Number.isInteger(zoneId) && zoneId > 0)
  )
  const loadingZones = activeZones.filter((zone) => isLoadingZone(zone, linkedBarnZoneIds))

  console.log(`Raw telemetry rows: ${telemetryCount}`)
  console.log(`RTK rows: ${rtkCount}`)
  console.log(`Active zones: ${activeZones.length}, loading zones: ${loadingZones.length}`)
  console.log('Clearing calculated batches...')
  await resetCalculatedTables()

  console.log('Loading RTK index...')
  const rtkIndex = indexRtkPoints(await prisma.rtkTelemetry.findMany({
    orderBy: [
      { timestamp: 'asc' },
      { id: 'asc' }
    ],
    select: {
      id: true,
      deviceId: true,
      timestamp: true,
      lat: true,
      lon: true,
      speed: true,
      rawPayload: true,
      course: true
    }
  }))

  const activeBatchByDevice = new Map()
  const unloadGroupEvidenceByBatch = new Map()
  const recentWeightsByDevice = new Map()
  const batchIdsToRecalculate = new Set()
  const stickyViolationBatchIds = new Set()
  const stats = {
    processed: 0,
    skippedInvalid: 0,
    starts: 0,
    ingredients: 0,
    completes: 0,
    forceCloses: 0,
    fallbackCloses: 0,
    leftovers: 0
  }

  const pageSize = 1000
  let cursor = null
  let rtkReplayCursor = 0

  while (true) {
    const rows = await prisma.telemetry.findMany({
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: [
        { timestamp: 'asc' },
        { id: 'asc' }
      ]
    })

    if (!rows.length) break

    for (const row of rows) {
      const packet = APPLY_WEIGHT_CALIBRATION_ON_REPLAY
        ? applyWeightCalibration(normalizeTelemetryRow(row), telemetrySettings)
        : normalizeTelemetryRow(row)
      const deviceId = packet.deviceId
      const packetTimeMs = new Date(packet.timestamp).getTime()
      rtkReplayCursor = replayRtkScoreboardUntil({
        rtkPoints: rtkIndex.all,
        cursor: rtkReplayCursor,
        referenceMs: packetTimeMs,
        hostDeviceId: deviceId,
        loadingZones,
        telemetrySettings
      })
      const recentWeights = rememberRecentWeight(recentWeightsByDevice, deviceId, packet.weight, autoCloseEmptyStreak)
      const effectivePosition = resolveEffectivePosition(packet, rtkIndex, telemetrySettings)
      const processorPacket = {
        ...packet,
        lat: effectivePosition.lat,
        lon: effectivePosition.lon,
        headingDeg: effectivePosition.rtkPoint?.course ?? packet.headingDeg ?? packet.heading ?? packet.course,
        course: effectivePosition.rtkPoint?.course ?? packet.course ?? packet.heading
      }
      const resolvedGroup = resolveGroupFromList(livestockGroups, effectivePosition.lat, effectivePosition.lon)
      const hostResolvedGroup = resolveGroupFromList(livestockGroups, packet.lat, packet.lon)
      const activeBatchForHints = activeBatchByDevice.get(deviceId) || null
      const expectedIngredients = activeBatchForHints?.expectedIngredients || resolveExpectedIngredientsFromGroup(resolvedGroup)
      const currentZone = detectZoneObject(effectivePosition.lat, effectivePosition.lon, activeZones)
      const hostLoadingZone = detectZoneObject(packet.lat, packet.lon, loadingZones)
      const hostForceIngredientName = hostLoadingZone?.ingredient || hostLoadingZone?.name || null
      const suppressLoading = isBarnZone(currentZone, linkedBarnZoneIds)
      const result = telemetryProcessor.processPacket(processorPacket, loadingZones, telemetrySettings, {
        suppressLoading,
        skipZoneVisit: effectivePosition.source === 'rtk',
        allowVisitedZoneIngredient: effectivePosition.source === 'rtk',
        preferCurrentZoneIngredient: effectivePosition.source === 'rtk',
        hostForceIngredientName,
        expectedIngredients
      })

      stats.processed += 1
      if (!result.isValid) {
        stats.skippedInvalid += 1
        continue
      }

      let activeBatch = activeBatchByDevice.get(deviceId) || null

      async function bindBatchToResolvedGroup({ overwriteExisting = false, group = resolvedGroup, alignIngredients = true } = {}) {
        if (!activeBatch || !group) return
        const patch = {}
        if (group.id && (overwriteExisting || !activeBatch.groupId) && activeBatch.groupId !== group.id) {
          patch.groupId = group.id
        }
        if (group.rationId && (overwriteExisting || !activeBatch.rationId) && activeBatch.rationId !== group.rationId) {
          patch.rationId = group.rationId
        }
        if (!Object.keys(patch).length) {
          if (!alignIngredients) {
            return
          }
          await alignAmbiguousIngredientsWithRation(prisma, {
            batchId: activeBatch.id,
            expectedIngredients: group.ration?.ingredients || [],
            loadingZones
          })
          return
        }

        activeBatch = await prisma.batch.update({
          where: { id: activeBatch.id },
          data: patch
        })
        if (alignIngredients) {
          await alignAmbiguousIngredientsWithRation(prisma, {
            batchId: activeBatch.id,
            expectedIngredients: group.ration?.ingredients || [],
            loadingZones
          })
        }
        activeBatch.expectedIngredients = resolveExpectedIngredientsFromGroup(group)
        activeBatchByDevice.set(deviceId, activeBatch)
        batchIdsToRecalculate.add(activeBatch.id)
      }

      const dbActions = result.dbActions || []
      for (let actionIndex = 0; actionIndex < dbActions.length; actionIndex += 1) {
        const action = dbActions[actionIndex]
        switch (action.type) {
          case 'START_BATCH':
            if (!activeBatch) {
              const actionStartTime = action.startTime ? new Date(action.startTime) : packet.timestamp
              activeBatch = await prisma.batch.create({
                data: {
                  deviceId,
                  startTime: Number.isNaN(actionStartTime.getTime()) ? packet.timestamp : actionStartTime,
                  startWeight: roundWeight(action.startWeight ?? packet.weight),
                  hasViolations: false,
                  ...(resolvedGroup ? {
                    groupId: resolvedGroup.id,
                    ...(resolvedGroup.rationId ? { rationId: resolvedGroup.rationId } : {})
                  } : {})
                }
              })
              activeBatchByDevice.set(deviceId, activeBatch)
              activeBatch.expectedIngredients = resolveExpectedIngredientsFromGroup(resolvedGroup)
              stats.starts += 1
            }
            break

          case 'ADD_INGREDIENT':
            if (!activeBatch) {
              const actionStartTime = action.startTime ? new Date(action.startTime) : packet.timestamp
              activeBatch = await prisma.batch.create({
                data: {
                  deviceId,
                  startTime: Number.isNaN(actionStartTime.getTime()) ? packet.timestamp : actionStartTime,
                  startWeight: roundWeight(packet.weight),
                  hasViolations: false,
                  ...(resolvedGroup ? {
                    groupId: resolvedGroup.id,
                    ...(resolvedGroup.rationId ? { rationId: resolvedGroup.rationId } : {})
                  } : {})
                }
              })
              activeBatchByDevice.set(deviceId, activeBatch)
              activeBatch.expectedIngredients = resolveExpectedIngredientsFromGroup(resolvedGroup)
              stats.starts += 1
            }

            {
              const ingredientName = String(action.ingredientName || '').trim() || 'Unknown'
              const actualWeight = roundWeight(action.actualWeight || 0)
              const actionStartedAt = action.startTime ? new Date(action.startTime) : null
              const actionEndedAt = action.endTime ? new Date(action.endTime) : packet.timestamp
              const useStartTimeForIngredient = normalizeIngredientName(ingredientName) === normalizeIngredientName('Неопределено') &&
                actionStartedAt &&
                !Number.isNaN(actionStartedAt.getTime())
              const effectiveIngredientAddedAt = useStartTimeForIngredient
                ? actionStartedAt
                : actionEndedAt && !Number.isNaN(actionEndedAt.getTime())
                ? actionEndedAt
                : packet.timestamp
              const latestIngredient = await prisma.batchIngredient.findFirst({
                where: { batchId: activeBatch.id },
                orderBy: [
                  { addedAt: 'desc' },
                  { id: 'desc' }
                ]
              })
              const latestAddedAtMs = new Date(latestIngredient?.addedAt || 0).getTime()
              const ingredientAddedAtMs = new Date(effectiveIngredientAddedAt).getTime()
              const timeSinceLatestMs = ingredientAddedAtMs - latestAddedAtMs
              const isSameIngredient = latestIngredient &&
                normalizeIngredientName(latestIngredient.ingredientName) === normalizeIngredientName(ingredientName)
              const isSameBucket = isSameIngredient &&
                Number.isFinite(timeSinceLatestMs) &&
                timeSinceLatestMs >= 0 &&
                timeSinceLatestMs < SAME_INGREDIENT_MERGE_WINDOW_MS

              if (isSameBucket) {
                await prisma.batchIngredient.update({
                  where: { id: latestIngredient.id },
                  data: {
                    actualWeight: roundWeight(Number(latestIngredient.actualWeight || 0) + actualWeight),
                    startedAt: latestIngredient.startedAt || (actionStartedAt && !Number.isNaN(actionStartedAt.getTime()) ? actionStartedAt : null),
                    startLat: latestIngredient.startLat ?? finiteNumberOrNull(action.startLat),
                    startLon: latestIngredient.startLon ?? finiteNumberOrNull(action.startLon),
                    endLat: finiteNumberOrNull(action.endLat),
                    endLon: finiteNumberOrNull(action.endLon),
                    addedAt: effectiveIngredientAddedAt
                  }
                })
              } else {
                await prisma.batchIngredient.create({
                  data: {
                    batchId: activeBatch.id,
                    ingredientName,
                    actualWeight,
                    startedAt: actionStartedAt && !Number.isNaN(actionStartedAt.getTime()) ? actionStartedAt : null,
                    startLat: finiteNumberOrNull(action.startLat),
                    startLon: finiteNumberOrNull(action.startLon),
                    endLat: finiteNumberOrNull(action.endLat),
                    endLon: finiteNumberOrNull(action.endLon),
                    addedAt: effectiveIngredientAddedAt
                  }
                })
              }
            }
            batchIdsToRecalculate.add(activeBatch.id)
            stats.ingredients += 1
            break

          case 'START_UNLOAD':
            if (activeBatch) {
              unloadGroupEvidenceByBatch.set(
                activeBatch.id,
                createUnloadGroupEvidence(action.startUnloadWeight ?? packet.weight, packet.timestamp, hostResolvedGroup)
              )
              activeBatch = await prisma.batch.update({
                where: { id: activeBatch.id },
                data: { endWeight: roundWeight(action.startUnloadWeight ?? packet.weight) }
              })
              activeBatchByDevice.set(deviceId, activeBatch)
            }
            break

          case 'UPDATE_UNLOAD':
            if (activeBatch) {
              if (Number(action.endWeight ?? packet.weight) >= emptyVehicleThresholdKg) {
                const confirmedUnloadGroup = rememberUnloadGroupEvidence(unloadGroupEvidenceByBatch, activeBatch.id, {
                  weight: action.endWeight ?? packet.weight,
                  timestamp: packet.timestamp,
                  group: hostResolvedGroup,
                  settings: telemetrySettings
                })
                if (confirmedUnloadGroup) {
                  await bindBatchToResolvedGroup({
                    overwriteExisting: true,
                    group: confirmedUnloadGroup,
                    alignIngredients: false
                  })
                }
              }
              activeBatch = await prisma.batch.update({
                where: { id: activeBatch.id },
                data: { endWeight: roundWeight(action.endWeight ?? packet.weight) }
              })
              activeBatch.expectedIngredients = resolveExpectedIngredientsFromGroup(resolvedGroup)
              activeBatchByDevice.set(deviceId, activeBatch)
            }
            break

          case 'LEFTOVER_VIOLATION':
            if (activeBatch) {
              stickyViolationBatchIds.add(activeBatch.id)
              activeBatch = await prisma.batch.update({
                where: { id: activeBatch.id },
                data: {
                  hasViolations: true,
                  endWeight: roundWeight(action.leftoverWeight ?? activeBatch.endWeight ?? packet.weight)
                }
              })
              activeBatchByDevice.set(deviceId, activeBatch)
              await recordLeftoverViolation(prisma, {
                batchId: activeBatch.id,
                deviceId,
                leftoverWeight: roundWeight(action.leftoverWeight ?? packet.weight),
                detectedAt: packet.timestamp
              })
              stats.leftovers += 1
            }
            break

          case 'COMPLETE_BATCH':
            if (activeBatch) {
              const completedBatchId = activeBatch.id
              unloadGroupEvidenceByBatch.delete(completedBatchId)
              await prisma.batch.update({
                where: { id: activeBatch.id },
                data: {
                  endTime: packet.timestamp,
                  endWeight: roundWeight(action.endWeight ?? packet.weight)
                }
              })
              batchIdsToRecalculate.add(completedBatchId)
              activeBatch = null
              activeBatchByDevice.delete(deviceId)
              stats.completes += 1
            }
            break

          case 'FORCE_CLOSE_BATCH':
            if (activeBatch) {
              const closedBatchId = activeBatch.id
              const actionEndTime = action.endTime ? new Date(action.endTime) : packet.timestamp
              unloadGroupEvidenceByBatch.delete(closedBatchId)
              stickyViolationBatchIds.add(closedBatchId)
              await prisma.batch.update({
                where: { id: activeBatch.id },
                data: {
                  endTime: Number.isNaN(actionEndTime.getTime()) ? packet.timestamp : actionEndTime,
                  endWeight: roundWeight(action.closeWeight ?? packet.weight),
                  hasViolations: true
                }
              })
              batchIdsToRecalculate.add(closedBatchId)
              stats.forceCloses += 1
            }

            if (dbActions.slice(actionIndex + 1).some((item) => item.type === 'ADD_INGREDIENT')) {
              activeBatch = await prisma.batch.create({
                data: {
                  deviceId,
                  startTime: packet.timestamp,
                  startWeight: roundWeight(action.nextStartWeight ?? packet.weight),
                  hasViolations: false,
                  ...(resolvedGroup ? {
                    groupId: resolvedGroup.id,
                    ...(resolvedGroup.rationId ? { rationId: resolvedGroup.rationId } : {})
                  } : {})
                }
              })
              activeBatch.expectedIngredients = resolveExpectedIngredientsFromGroup(resolvedGroup)
              activeBatchByDevice.set(deviceId, activeBatch)
              stats.starts += 1
            } else {
              activeBatch = null
              activeBatchByDevice.delete(deviceId)
            }
            break
        }
      }

      if (activeBatch) {
        const hasCloseAction = (result.dbActions || []).some((action) =>
          action.type === 'COMPLETE_BATCH' || action.type === 'FORCE_CLOSE_BATCH'
        )
        const hasAddAction = (result.dbActions || []).some((action) => action.type === 'ADD_INGREDIENT')

        if (!hasCloseAction && !hasAddAction) {
          const ingredientCount = await prisma.batchIngredient.count({
            where: { batchId: activeBatch.id }
          })

          if (ingredientCount > 0) {
            const negativeCount = recentWeights.filter((weight) => Number(weight || 0) < 0).length
            const nearZeroCount = recentWeights.filter((weight) => Math.max(0, Number(weight || 0)) <= autoCloseZeroWeightKg).length
            const shouldAutoCloseByNegative = recentWeights.length >= autoCloseNegativeStreak && negativeCount >= autoCloseNegativeStreak
            const shouldAutoCloseByEmpty = recentWeights.length >= autoCloseEmptyStreak && nearZeroCount >= autoCloseEmptyStreak
            const currentWeight = roundWeight(packet.weight || 0)
            const currentPacketIsNegative = currentWeight < 0
            const currentPacketIsEmpty = Math.max(0, currentWeight) <= autoCloseZeroWeightKg

            if (
              (shouldAutoCloseByNegative && currentPacketIsNegative) ||
              (shouldAutoCloseByEmpty && currentPacketIsEmpty)
            ) {
              const closedBatchId = activeBatch.id
              unloadGroupEvidenceByBatch.delete(closedBatchId)
              await prisma.batch.update({
                where: { id: closedBatchId },
                data: {
                  endTime: packet.timestamp,
                  endWeight: roundNonNegativeWeight(packet.weight || 0)
                }
              })
              batchIdsToRecalculate.add(closedBatchId)
              telemetryProcessor.clearDeviceState(deviceId)
              activeBatch = null
              activeBatchByDevice.delete(deviceId)
              stats.fallbackCloses += 1
            }
          }
        }
      }
    }

    cursor = rows[rows.length - 1].id
    if (stats.processed % 10000 < pageSize) {
      console.log(`Processed ${stats.processed}/${telemetryCount}`)
    }
  }

  const mergedCarryovers = await mergeEmptyCarryoverBatches(batchIdsToRecalculate)
  if (mergedCarryovers > 0) {
    console.log(`Merged empty carryover batches: ${mergedCarryovers}`)
  }
  const mergedPreludes = await mergeShortPreludeBatches(batchIdsToRecalculate, telemetrySettings)
  if (mergedPreludes > 0) {
    console.log(`Merged short prelude batches: ${mergedPreludes}`)
  }
  const alignedStarts = await alignBatchStartsWithEarliestIngredient(batchIdsToRecalculate)
  if (alignedStarts > 0) {
    console.log(`Aligned batch starts with first ingredient: ${alignedStarts}`)
  }

  console.log(`Recalculating violations for ${batchIdsToRecalculate.size} batches...`)
  for (const batchId of batchIdsToRecalculate) {
    const recalculation = await recalculateBatchViolations(prisma, batchId, telemetrySettings)
    if (recalculation?.status === 'missing') {
      continue
    }
    if (stickyViolationBatchIds.has(batchId)) {
      await prisma.batch.update({
        where: { id: batchId },
        data: { hasViolations: true }
      })
    }
  }

  const [batchCount, ingredientCount, openBatchCount, violationCount] = await Promise.all([
    prisma.batch.count(),
    prisma.batchIngredient.count(),
    prisma.batch.count({ where: { endTime: null } }),
    prisma.violation.count()
  ])
  const latestBatches = await prisma.batch.findMany({
    orderBy: { id: 'desc' },
    take: 10,
    include: {
      group: true,
      ration: true,
      actualIngredients: {
        orderBy: [
          { addedAt: 'asc' },
          { id: 'asc' }
        ]
      }
    }
  })

  console.log('Replay complete')
  console.log(JSON.stringify({
    stats,
    batchCount,
    ingredientCount,
    openBatchCount,
    violationCount,
    latestBatches: latestBatches.map((batch) => ({
      id: batch.id,
      startTime: batch.startTime,
      endTime: batch.endTime,
      group: batch.group?.name || null,
      ration: batch.ration?.name || null,
      startWeight: batch.startWeight,
      endWeight: batch.endWeight,
      ingredients: batch.actualIngredients.map((item) => ({
        name: item.ingredientName,
        weight: item.actualWeight,
        addedAt: item.addedAt
      }))
    }))
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

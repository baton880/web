import { Router } from 'express'
import prisma from "../../database.js"
import { authenticate, requireAdmin, requireReadAccess, requireWriteAccess } from "../../middleware/auth.js"
import telemetryProcessor from '../../../../module-3/telemetryProcessor.js'
import { buildIngredientSummary, buildUnloadProgress, recalculateBatchViolations } from '../batches/batch-violations.js'
import { getZoneByCoordinates, resolveEffectiveCoordinates, resolveGroupByCoordinates } from './telemetry-helpers.js'
import { DEFAULT_TELEMETRY_SETTINGS, getTelemetrySettings } from './telemetry-settings.js'
import { MOVEMENT_CONFIRM_PACKETS, MOVEMENT_SPEED_THRESHOLD_KMH } from '../../../../module-3/config.js'
import { normalizeIngredientName } from '../../../../module-2/rationManager.js'
import { roundNonNegativeWeight, roundOptionalWeight, roundWeight } from '../../../../module-2/weightRounding.js'
import { recordLeftoverViolation } from '../violations/violation-service.js'
import { getHostTrackClearSince, setHostTrackClearSince } from './track-state-store.js'
import { alignAmbiguousIngredientsWithRation } from './loading-zone-correction.js'
import { getHostIngressStore } from './host-ingress-store.js'
import { postprocessCompletedBatch } from '../batches/batch-postprocess-service.js'
import { farmDateRange, getFarmDateString } from '../../utils/farm-date.js'
import { parseHostTimestamp } from './host-timestamp.js'

const router = Router()
const hostIngressStore = getHostIngressStore()
const DEFAULT_RECENT_LIMIT = 5
const DEFAULT_ADMIN_HISTORY_LIMIT = 10
const MAX_TELEMETRY_HISTORY_LIMIT = 20000
const MAX_REPLAY_DAY_ROWS = 100000
const SAME_INGREDIENT_MERGE_WINDOW_MS = 10000
const UNLOAD_GROUP_STICKY_MS = 120000
const UNLOAD_GROUP_CONFIRM_PACKETS = 2
const MIN_UNLOAD_GROUP_CONFIRM_DROP_KG = 500
const unloadGroupEvidenceByBatch = new Map()

function normalizeZoneType(value) {
  if (!value) return ''
  return String(value).trim().toUpperCase()
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
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

function resolveExpectedIngredientsFromBatch(batch) {
  const ingredients = batch?.ration?.ingredients?.length
    ? batch.ration.ingredients
    : batch?.group?.ration?.ingredients

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

function rememberUnloadGroupEvidence(batchId, { weight, timestamp, group = null, settings = {} }) {
  if (!batchId) return null
  const parsedWeight = Number(weight)
  const timestampMs = new Date(timestamp).getTime()
  if (!Number.isFinite(parsedWeight) || !Number.isFinite(timestampMs)) return null

  let evidence = unloadGroupEvidenceByBatch.get(batchId)
  if (!evidence) {
    evidence = createUnloadGroupEvidence(parsedWeight, timestamp, group)
    unloadGroupEvidenceByBatch.set(batchId, evidence)
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

function parseLimit(rawValue, fallback, maxLimit = MAX_TELEMETRY_HISTORY_LIMIT) {
  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback
  }

  if (Number.isInteger(maxLimit) && maxLimit > 0) {
    return Math.min(parsed, maxLimit)
  }

  return parsed
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function orderBySourceTimestampDesc() {
  return [
    { timestamp: 'desc' },
    { id: 'desc' }
  ]
}

function orderBySourceTimestampAsc() {
  return [
    { timestamp: 'asc' },
    { id: 'asc' }
  ]
}

function resolveMovementState(recentPoints = [], telemetrySettings = {}, memoryState = {}) {
  if (memoryState?.isMoving) {
    return true
  }

  const speedThreshold = Number(telemetrySettings.movementSpeedThresholdKmh) > 0
    ? Number(telemetrySettings.movementSpeedThresholdKmh)
    : MOVEMENT_SPEED_THRESHOLD_KMH
  const confirmPackets = Number(telemetrySettings.movementConfirmPackets) > 0
    ? Number(telemetrySettings.movementConfirmPackets)
    : MOVEMENT_CONFIRM_PACKETS

  let streak = 0
  for (const point of Array.isArray(recentPoints) ? recentPoints : []) {
    const speed = Number(point?.speedKmh)
    if (Number.isFinite(speed) && speed >= speedThreshold) {
      streak += 1
      if (streak >= confirmPackets) {
        return true
      }
    } else {
      break
    }
  }

  return false
}

const RAW_WEIGHT_INVALID_BELOW_KG = -2000

export function normalizeTelemetryPacket(packet) {
  const rawWeight = parseOptionalNumber(packet.raw ?? packet.rawWeight ?? packet.raw_weight)
  const reportedWeightValid = parseBoolean(packet.weightValid ?? packet.weight_valid)

  return {
    deviceId: packet.deviceId || packet.device_id || 'host_01',
    timestamp: parseHostTimestamp(packet.timestamp),
    lat: Number(packet.lat || 0),
    lon: Number(packet.lon || 0),
    gpsValid: parseBoolean(packet.gpsValid ?? packet.gps_valid),
    gpsSatellites: Number(packet.gpsSatellites ?? packet.gps_satellites ?? 0),
    gpsAgeS: parseOptionalNumber(packet.gpsAgeS ?? packet.gps_age_s),
    speedKmh: parseOptionalNumber(packet.speedKmh ?? packet.speed_kmh ?? packet.speed),
    weight: Number(packet.weight || 0),
    rawWeight,
    weightValid: reportedWeightValid && (rawWeight === null || rawWeight >= RAW_WEIGHT_INVALID_BELOW_KG),
    gpsQuality: Number(packet.gpsQuality ?? packet.gps_quality ?? 0),
    wifiClients: packet.wifiClients ?? packet.wifi_clients ?? [],
    cpuTempC: packet.cpuTempC ?? packet.cpu_temp_c ?? null,
    lteRssiDbm: packet.lteRssiDbm ?? packet.lte_rssi_dbm ?? null,
    lteAccessTech: packet.lteAccessTech ?? packet.lte_access_tech ?? null,
    eventsReaderOk: parseBoolean(packet.eventsReaderOk ?? packet.events_reader_ok)
  }
}

function stringifyRawPayload(payload) {
  try {
    return JSON.stringify(payload ?? {})
  } catch {
    return JSON.stringify({})
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

// Хелпер для пустых ответов
function buildEmptyLatestResponse(deviceId = null) {
  return {
    id: null, deviceId, timestamp: null, receivedAt: null, lat: null, lon: null,
    speedKmh: null, weight: null, rawWeight: null, weightValid: false, gpsValid: false, gpsSatellites: 0, gpsAgeS: null,
    gpsQuality: 0, wifiClients: null, cpuTempC: null, lteRssiDbm: null,
    lteAccessTech: null, eventsReaderOk: false, banner: null,
    mode: 'Ожидание',
    isMixing: false,
    isUnloading: false,
    unload_progress: null,
    active_batch: null
  }
}

function serializeTelemetryForResponse(row) {
  if (!row) return row
  return {
    ...row,
    weight: roundWeight(row.weight),
    rawWeight: roundOptionalWeight(row.rawWeight)
  }
}

function getRequestedDeviceId(req) {
  const value = req.query.deviceId || req.query.device_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function inferMachineStateFromDatabase(
  deviceId,
  latestTelemetry,
  activeBatch,
  memoryState = {},
  telemetrySettings = {},
  options = {}
) {
  const currentZone = memoryState?.currentZone || options.currentZone || null
  const modeUnloadDropHintKg = Number(telemetrySettings.modeUnloadDropHintKg) > 0
    ? Number(telemetrySettings.modeUnloadDropHintKg)
    : DEFAULT_TELEMETRY_SETTINGS.modeUnloadDropHintKg
  const modeLoadingDeltaHintKg = Number(telemetrySettings.modeLoadingDeltaHintKg) > 0
    ? Number(telemetrySettings.modeLoadingDeltaHintKg)
    : DEFAULT_TELEMETRY_SETTINGS.modeLoadingDeltaHintKg

  if (!latestTelemetry) {
    return {
      mode: 'Ожидание',
      isMixing: false,
      isUnloading: false,
      peakWeight: 0,
      currentZone
    }
  }

  if (!activeBatch) {
    return {
      mode: 'Ожидание',
      isMixing: false,
      isUnloading: false,
      peakWeight: roundWeight(latestTelemetry.weight || 0),
      currentZone
    }
  }

  const telemetryWhere = {
    deviceId,
    timestamp: { gte: activeBatch.startTime }
  }

  const [recentPoints, peakTelemetry] = await Promise.all([
    prisma.telemetry.findMany({
      where: telemetryWhere,
      orderBy: orderBySourceTimestampDesc(),
      take: 8,
      select: { weight: true, speedKmh: true, timestamp: true }
    }),
    prisma.telemetry.aggregate({
      where: telemetryWhere,
      _max: { weight: true }
    })
  ])

  const currentWeight = roundWeight(latestTelemetry.weight || 0)
  const previousWeight = roundWeight(recentPoints[1]?.weight ?? currentWeight)
  const isMoving = resolveMovementState(recentPoints, telemetrySettings, memoryState)
  const peakWeight = Math.max(
    roundWeight(peakTelemetry._max.weight || 0),
    roundWeight(activeBatch.startWeight || 0),
    currentWeight
  )
  const dropFromPeak = peakWeight - currentWeight
  const recentDelta = currentWeight - previousWeight

  let mode = 'Ожидание'
  if (memoryState?.isUnloading) {
    mode = 'Выгрузка'
  } else if (memoryState?.isMixing && !isMoving) {
    mode = 'Загрузка'
  } else if (!isMoving && dropFromPeak > modeUnloadDropHintKg) {
    mode = 'Выгрузка'
  } else if (!isMoving && (recentDelta > modeLoadingDeltaHintKg || (activeBatch.actualIngredients || []).length > 0)) {
    mode = 'Загрузка'
  }

  return {
    ...memoryState,
    mode,
    isMixing: mode === 'Загрузка',
    isUnloading: mode === 'Выгрузка',
    isMoving,
    peakWeight,
    currentZone
  }
}

// ============================================================================
// POST / - ПРИЕМ ТЕЛЕМЕТРИИ
// ============================================================================
export class HostTelemetryValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HostTelemetryValidationError'
    this.permanent = true
  }
}

function telemetryIdentity(row) {
  const streamId = row?.sourceStreamId
  const packetId = Number(row?.sourcePacketId)
  if (streamId && Number.isInteger(packetId)) return `stream:${streamId}:${packetId}`
  return `timestamp:${row?.deviceId || ''}:${new Date(row?.timestamp || 0).getTime()}`
}

export async function findAdminHistoryTelemetry({
  limit = DEFAULT_ADMIN_HISTORY_LIMIT,
  requestedDeviceId = null,
  clearSince = null
} = {}) {
  const take = parseLimit(limit, DEFAULT_ADMIN_HISTORY_LIMIT)
  const where = {
    ...(requestedDeviceId ? { deviceId: requestedDeviceId } : {}),
    ...(clearSince ? { timestamp: { gt: clearSince } } : {})
  }
  const [processed, telemetrySettings] = await Promise.all([
    prisma.telemetry.findMany({
      where: Object.keys(where).length ? where : undefined,
      orderBy: orderBySourceTimestampDesc(),
      take
    }),
    getTelemetrySettings(prisma)
  ])
  const accepted = hostIngressStore.recentAccepted(take, requestedDeviceId)
    .map((entry) => {
      const packet = normalizeTelemetryPacket(entry.payload)
      if (Number.isNaN(packet.timestamp.getTime())) return null
      if (clearSince && packet.timestamp <= clearSince) return null
      return applyWeightCalibration({
        id: null,
        ingressId: entry.inboxId,
        sourceStreamId: entry.streamId || null,
        sourcePacketId: Number.isInteger(entry.packetId) ? entry.packetId : null,
        receivedAt: new Date(entry.receivedAt),
        ...packet,
        wifiClients: Array.isArray(packet.wifiClients)
          ? JSON.stringify(packet.wifiClients)
          : String(packet.wifiClients || '[]'),
        pipelineStatus: entry.status,
        processed: entry.status === 'processed'
      }, telemetrySettings)
    })
    .filter(Boolean)

  const byIdentity = new Map(processed.map((row) => [telemetryIdentity(row), row]))
  for (const row of accepted) {
    const key = telemetryIdentity(row)
    if (!byIdentity.has(key)) byIdentity.set(key, row)
  }
  return [...byIdentity.values()]
    .sort((left, right) => {
      const timestampDelta = new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()
      if (timestampDelta !== 0) return timestampDelta
      return new Date(right.receivedAt || 0).getTime() - new Date(left.receivedAt || 0).getTime()
    })
    .slice(0, take)
}

function buildTelemetryCreateData(packet, receivedAt, rawPayload, identity = {}) {
  return {
    sourceStreamId: identity.streamId || null,
    sourcePacketId: Number.isInteger(identity.packetId) ? identity.packetId : null,
    deviceId: packet.deviceId,
    timestamp: packet.timestamp,
    receivedAt,
    lat: packet.lat,
    lon: packet.lon,
    gpsValid: packet.gpsValid,
    gpsSatellites: packet.gpsSatellites,
    gpsAgeS: packet.gpsAgeS,
    speedKmh: packet.speedKmh,
    weight: packet.weight,
    rawWeight: packet.rawWeight,
    rawPayload,
    weightValid: packet.weightValid,
    gpsQuality: packet.gpsQuality,
    wifiClients: Array.isArray(packet.wifiClients) ? JSON.stringify(packet.wifiClients) : String(packet.wifiClients || '[]'),
    cpuTempC: packet.cpuTempC,
    lteRssiDbm: packet.lteRssiDbm,
    lteAccessTech: packet.lteAccessTech,
    eventsReaderOk: packet.eventsReaderOk
  }
}

async function updateDeviceCurrentTelemetry(telemetry, receivedAt, identity = {}) {
  if (!identity.isLive || !telemetry?.id || !telemetry?.deviceId) return false

  const candidateReceivedAt = receivedAt instanceof Date ? receivedAt : new Date(receivedAt)
  if (Number.isNaN(candidateReceivedAt.getTime())) return false

  const existing = await prisma.deviceCurrentTelemetry.findUnique({
    where: { deviceId: telemetry.deviceId },
    select: { receivedAt: true, sourceStreamId: true, sourcePacketId: true }
  })
  if (existing) {
    const candidatePacketId = Number.isInteger(identity.packetId) ? identity.packetId : null
    const isSameStream = Boolean(identity.streamId) && existing.sourceStreamId === identity.streamId
    if (
      isSameStream &&
      Number.isInteger(existing.sourcePacketId) &&
      Number.isInteger(candidatePacketId) &&
      candidatePacketId <= existing.sourcePacketId
    ) {
      return false
    }
    const existingReceivedAtMs = existing.receivedAt.getTime()
    const candidateReceivedAtMs = candidateReceivedAt.getTime()
    if (candidateReceivedAtMs < existingReceivedAtMs) return false
    if (
      candidateReceivedAtMs === existingReceivedAtMs &&
      existing.sourceStreamId === (identity.streamId || null) &&
      Number.isInteger(existing.sourcePacketId) &&
      Number.isInteger(identity.packetId) &&
      identity.packetId <= existing.sourcePacketId
    ) {
      return false
    }
  }

  await prisma.deviceCurrentTelemetry.upsert({
    where: { deviceId: telemetry.deviceId },
    create: {
      deviceId: telemetry.deviceId,
      telemetryId: telemetry.id,
      sourceStreamId: identity.streamId || null,
      sourcePacketId: Number.isInteger(identity.packetId) ? identity.packetId : null,
      receivedAt: candidateReceivedAt,
      updatedAt: new Date()
    },
    update: {
      telemetryId: telemetry.id,
      sourceStreamId: identity.streamId || null,
      sourcePacketId: Number.isInteger(identity.packetId) ? identity.packetId : null,
      receivedAt: candidateReceivedAt,
      updatedAt: new Date()
    }
  })
  return true
}

export async function findCurrentTelemetry(requestedDeviceId = null) {
  const accepted = hostIngressStore.latestAccepted(requestedDeviceId)
  const current = requestedDeviceId
    ? await prisma.deviceCurrentTelemetry.findUnique({
        where: { deviceId: requestedDeviceId },
        include: { telemetry: true }
      })
    : await prisma.deviceCurrentTelemetry.findFirst({
        orderBy: [{ receivedAt: 'desc' }, { deviceId: 'asc' }],
        include: { telemetry: true }
      })
  const processed = current?.telemetry || await prisma.telemetry.findFirst({
    where: requestedDeviceId ? { deviceId: requestedDeviceId } : undefined,
    orderBy: orderBySourceTimestampDesc()
  })
  if (!accepted?.payload) return processed

  const acceptedReceivedAt = new Date(accepted.receivedAt)
  const processedReceivedAt = processed?.receivedAt instanceof Date
    ? processed.receivedAt
    : new Date(processed?.receivedAt || 0)
  if (Number.isNaN(acceptedReceivedAt.getTime()) || acceptedReceivedAt <= processedReceivedAt) {
    return processed
  }

  const packet = normalizeTelemetryPacket(accepted.payload)
  if (Number.isNaN(packet.timestamp.getTime())) return processed
  const processedTimestampMs = new Date(processed?.timestamp || 0).getTime()
  if (Number.isFinite(processedTimestampMs) && packet.timestamp.getTime() < processedTimestampMs) {
    return processed
  }
  return {
    id: null,
    sourceStreamId: accepted.streamId || null,
    sourcePacketId: Number.isInteger(accepted.packetId) ? accepted.packetId : null,
    receivedAt: acceptedReceivedAt,
    ...packet,
    wifiClients: Array.isArray(packet.wifiClients) ? JSON.stringify(packet.wifiClients) : String(packet.wifiClients || '[]'),
    pipelineStatus: 'accepted',
    processed: false
  }
}

export async function processHostTelemetryPacket(body, receivedAt = new Date(), identity = {}) {
    let packet = normalizeTelemetryPacket(body);
    if (!(packet.timestamp instanceof Date) || Number.isNaN(packet.timestamp.getTime())) {
      throw new HostTelemetryValidationError('Invalid telemetry timestamp')
    }
    const deviceId = packet.deviceId;
    const rawPayload = stringifyRawPayload(body)

    if (identity.streamId && Number.isInteger(identity.packetId)) {
      const existing = await prisma.telemetry.findFirst({
        where: {
          deviceId,
          sourceStreamId: identity.streamId,
          sourcePacketId: identity.packetId
        },
        select: { id: true, deviceId: true, timestamp: true, receivedAt: true }
      })
      if (existing) {
        await updateDeviceCurrentTelemetry(existing, existing.receivedAt, identity)
        return {
          status: 'duplicate',
          id: existing.id,
          outOfOrder: false,
          timestamp: existing.timestamp.toISOString()
        }
      }
    }

    const [telemetrySettings, latestStoredTelemetry] = await Promise.all([
      getTelemetrySettings(prisma),
      prisma.telemetry.findFirst({
        where: { deviceId },
        orderBy: orderBySourceTimestampDesc(),
        select: { id: true, timestamp: true }
      })
    ])
    packet = applyWeightCalibration(packet, telemetrySettings)
    const latestStoredTimestampMs = latestStoredTelemetry?.timestamp instanceof Date
      ? latestStoredTelemetry.timestamp.getTime()
      : Number.NaN
    const currentPacketTimestampMs = packet.timestamp.getTime()
    const isOutOfOrderPacket = Number.isFinite(latestStoredTimestampMs) &&
      currentPacketTimestampMs < latestStoredTimestampMs

    if (isOutOfOrderPacket) {
      if (!Number.isFinite(packet.lat) || !Number.isFinite(packet.lon) ||
          packet.lat < -90 || packet.lat > 90 || packet.lon < -180 || packet.lon > 180) {
        throw new HostTelemetryValidationError('Invalid coordinates')
      }
      const telemetry = await prisma.telemetry.create({
        data: buildTelemetryCreateData(packet, receivedAt, rawPayload, identity)
      })
      return {
        status: 'ok',
        id: telemetry.id,
        banner: null,
        outOfOrder: true,
        timestamp: packet.timestamp.toISOString()
      }
    }

    // 1. Достаем геозоны из базы
    const [activeZones, groupsWithZones, activeBatchForHints] = await Promise.all([
      prisma.storageZone.findMany({ where: { active: true } }),
      prisma.livestockGroup.findMany({
        where: { storageZoneId: { not: null } },
        select: { storageZoneId: true }
      }),
      prisma.batch.findFirst({
        where: { deviceId, endTime: null },
        orderBy: { startTime: 'desc' },
        include: {
          ration: { include: { ingredients: true } },
          group: { include: { ration: { include: { ingredients: true } } } }
        }
      })
    ]);
    const linkedBarnZoneIds = new Set(
      groupsWithZones
        .map((group) => Number(group.storageZoneId))
        .filter((zoneId) => Number.isInteger(zoneId) && zoneId > 0)
    )
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
    const loadingZones = activeZones.filter((zone) => isLoadingZone(zone, linkedBarnZoneIds))
    const effectivePosition = await resolveEffectiveCoordinates(prisma, packet, {
      deviceId,
      referenceTime: packet.timestamp,
      loaderMaxDistanceMeters: telemetrySettings.loaderMaxDistanceMeters,
      loaderOfflineTimeoutMinutes: telemetrySettings.loaderOfflineTimeoutMinutes
    });
    const processorPacket = {
      ...packet,
      lat: effectivePosition.lat,
      lon: effectivePosition.lon,
      headingDeg: effectivePosition.rtkPoint?.course ?? packet.headingDeg ?? packet.heading ?? packet.course,
      course: effectivePosition.rtkPoint?.course ?? packet.course ?? packet.heading
    };
    const resolvedGroup = await resolveGroupByCoordinates(prisma, effectivePosition.lat, effectivePosition.lon);
    const hostResolvedGroup = await resolveGroupByCoordinates(prisma, packet.lat, packet.lon);
    const currentZone = getZoneByCoordinates(effectivePosition.lat, effectivePosition.lon, activeZones)
    const hostLoadingZone = getZoneByCoordinates(packet.lat, packet.lon, loadingZones)
    const hostForceIngredientName = hostLoadingZone?.ingredient || hostLoadingZone?.name || null
    const suppressLoading = isBarnZone(currentZone, linkedBarnZoneIds)
    const currentZoneEvidenceAgeMs = effectivePosition.source === 'rtk'
      ? Math.max(0, new Date(packet.timestamp).getTime() - new Date(effectivePosition.rtkPoint?.timestamp).getTime())
      : null

    // Вся валидация координат, смена зон и расчет дельт
    const result = telemetryProcessor.processPacket(processorPacket, loadingZones, telemetrySettings, {
      suppressLoading,
      // Loader RTK packets maintain the scoreboard in rtk.routes.js.
      // HOST has no heading and only contributes its direct zone hit.
      skipZoneVisit: true,
      allowVisitedZoneIngredient: effectivePosition.source === 'rtk',
      preferCurrentZoneIngredient: effectivePosition.source === 'rtk',
      currentZoneEvidenceAgeMs,
      hostLat: Number(packet.lat),
      hostLon: Number(packet.lon),
      hostForceIngredientName,
      expectedIngredients: resolveExpectedIngredientsFromBatch(activeBatchForHints)
    });

    if (!result.isValid) {
      console.warn(`[Фильтр] Отброшен невалидный пакет от ${deviceId}:`, result.error);
      throw new HostTelemetryValidationError(result.error || 'Invalid coordinates')
    }

    let telemetry = null
    let shouldClearDeviceState = false
    let shouldScheduleReplay = false
    const postprocessBatchIds = new Set()
    await prisma.$transaction(async (tx) => {
      telemetry = await tx.telemetry.create({
        data: buildTelemetryCreateData(packet, receivedAt, rawPayload, identity)
      })

      let activeBatch = await tx.batch.findFirst({
        where: { deviceId, endTime: null },
        orderBy: { startTime: 'desc' }
      })
      const batchIdsToRecalculate = new Set()
      const stickyViolationBatchIds = new Set()

      async function bindBatchToResolvedGroup({ overwriteExisting = false, group = resolvedGroup, alignIngredients = true } = {}) {
        if (!activeBatch || !group) {
          return
        }

        const patch = {}

        if ((overwriteExisting || !activeBatch.groupId) && activeBatch.groupId !== group.id) {
          patch.groupId = group.id
        }

        if (group.rationId && (overwriteExisting || !activeBatch.rationId) && activeBatch.rationId !== group.rationId) {
          patch.rationId = group.rationId
        }

        if (!Object.keys(patch).length) {
          if (!alignIngredients) {
            return
          }
          await alignAmbiguousIngredientsWithRation(tx, {
            batchId: activeBatch.id,
            expectedIngredients: group.ration?.ingredients || [],
            loadingZones
          })
          return
        }

        activeBatch = await tx.batch.update({
          where: { id: activeBatch.id },
          data: patch
        })
        if (alignIngredients) {
          await alignAmbiguousIngredientsWithRation(tx, {
            batchId: activeBatch.id,
            expectedIngredients: group.ration?.ingredients || [],
            loadingZones
          })
        }
        batchIdsToRecalculate.add(activeBatch.id)
      }

      const dbActions = result.dbActions || []
      for (let actionIndex = 0; actionIndex < dbActions.length; actionIndex += 1) {
        const action = dbActions[actionIndex]
        switch (action.type) {
          case 'START_BATCH':
            if (!activeBatch) {
              const actionStartTime = action.startTime ? new Date(action.startTime) : telemetry.timestamp
              const initialBatchData = {
                deviceId,
                startTime: Number.isNaN(actionStartTime.getTime()) ? telemetry.timestamp : actionStartTime,
                startWeight: roundWeight(action.startWeight ?? telemetry.weight),
                hasViolations: false
              }

              if (resolvedGroup) {
                initialBatchData.groupId = resolvedGroup.id
                if (resolvedGroup.rationId) {
                  initialBatchData.rationId = resolvedGroup.rationId
                }
              }

              activeBatch = await tx.batch.create({
                data: initialBatchData
              })
              console.log(`Открыт новый замес ${activeBatch.id} (${activeBatch.startWeight} кг)`)
            }
            break

          case 'ADD_INGREDIENT':
            if (!activeBatch) {
              const actionStartTime = action.startTime ? new Date(action.startTime) : telemetry.timestamp
              const initialBatchData = {
                deviceId,
                startTime: Number.isNaN(actionStartTime.getTime()) ? telemetry.timestamp : actionStartTime,
                startWeight: roundWeight(telemetry.weight),
                hasViolations: false
              }

              if (resolvedGroup) {
                initialBatchData.groupId = resolvedGroup.id
                if (resolvedGroup.rationId) {
                  initialBatchData.rationId = resolvedGroup.rationId
                }
              }

              activeBatch = await tx.batch.create({
                data: initialBatchData
              })
            }

            {
              const ingredientName = String(action.ingredientName || '').trim() || 'Unknown'
              const actualWeight = roundWeight(action.actualWeight || 0)
              const actionStartedAt = action.startTime ? new Date(action.startTime) : null
              const actionEndedAt = action.endTime ? new Date(action.endTime) : telemetry.timestamp
              const useStartTimeForIngredient = normalizeIngredientName(ingredientName) === normalizeIngredientName('Неопределено') &&
                actionStartedAt &&
                !Number.isNaN(actionStartedAt.getTime())
              const effectiveIngredientAddedAt = useStartTimeForIngredient
                ? actionStartedAt
                : actionEndedAt && !Number.isNaN(actionEndedAt.getTime())
                ? actionEndedAt
                : telemetry.timestamp
              const latestIngredient = await tx.batchIngredient.findFirst({
                where: { batchId: activeBatch.id },
                orderBy: { addedAt: 'desc' }
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
                await tx.batchIngredient.update({
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
                await tx.batchIngredient.create({
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
            console.log(`Добавлен ингредиент: ${action.ingredientName} (${action.actualWeight} кг)`)
            break

          case 'START_UNLOAD':
            if (activeBatch) {
              unloadGroupEvidenceByBatch.set(
                activeBatch.id,
                createUnloadGroupEvidence(action.startUnloadWeight ?? telemetry.weight, telemetry.timestamp, hostResolvedGroup)
              )
              await tx.batch.update({
                where: { id: activeBatch.id },
                data: { endWeight: roundWeight(action.startUnloadWeight ?? telemetry.weight) }
              })
              console.log(`Замес ${activeBatch.id}: началась выгрузка`)
            }
            break

          case 'UPDATE_UNLOAD':
            if (activeBatch) {
              if (Number(action.endWeight ?? telemetry.weight) >= emptyVehicleThresholdKg) {
                const confirmedUnloadGroup = rememberUnloadGroupEvidence(activeBatch.id, {
                  weight: action.endWeight ?? telemetry.weight,
                  timestamp: telemetry.timestamp,
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
              await tx.batch.update({
                where: { id: activeBatch.id },
                data: { endWeight: roundWeight(action.endWeight ?? telemetry.weight) }
              })
            }
            break

          case 'LEFTOVER_VIOLATION':
            if (activeBatch) {
              stickyViolationBatchIds.add(activeBatch.id)
              await tx.batch.update({
                where: { id: activeBatch.id },
                data: {
                  hasViolations: true,
                  endWeight: roundWeight(action.leftoverWeight ?? activeBatch.endWeight ?? telemetry.weight)
                }
              })
              await recordLeftoverViolation(tx, {
                batchId: activeBatch.id,
                deviceId,
                leftoverWeight: roundWeight(action.leftoverWeight ?? telemetry.weight),
                detectedAt: telemetry.timestamp
              })
              console.log(`Замес ${activeBatch.id}: зафиксирован остаток ${action.leftoverWeight} кг`)
            }
            break

          case 'COMPLETE_BATCH':
            if (activeBatch) {
              const completedBatchId = activeBatch.id
              unloadGroupEvidenceByBatch.delete(completedBatchId)
              await tx.batch.update({
                where: { id: activeBatch.id },
                data: {
                  endTime: telemetry.timestamp,
                  endWeight: roundWeight(action.endWeight ?? telemetry.weight)
                }
              })
              batchIdsToRecalculate.add(completedBatchId)
              postprocessBatchIds.add(completedBatchId)
              console.log(`Замес ${activeBatch.id} закрыт!`)
              activeBatch = null
            }
            break

          case 'FORCE_CLOSE_BATCH':
            if (activeBatch) {
              const closedBatchId = activeBatch.id
              const actionEndTime = action.endTime ? new Date(action.endTime) : telemetry.timestamp
              unloadGroupEvidenceByBatch.delete(closedBatchId)
              stickyViolationBatchIds.add(closedBatchId)
              await tx.batch.update({
                where: { id: activeBatch.id },
                data: {
                  endTime: Number.isNaN(actionEndTime.getTime()) ? telemetry.timestamp : actionEndTime,
                  endWeight: roundWeight(action.closeWeight ?? telemetry.weight),
                  hasViolations: true
                }
              })
              batchIdsToRecalculate.add(closedBatchId)
              postprocessBatchIds.add(closedBatchId)
              console.log(`Замес ${activeBatch.id} принудительно закрыт (недовыгрузка)!`)
            }

            if (dbActions.slice(actionIndex + 1).some((item) => item.type === 'ADD_INGREDIENT')) {
              activeBatch = await tx.batch.create({
                data: {
                  deviceId,
                  startTime: telemetry.timestamp,
                  startWeight: roundWeight(action.nextStartWeight ?? telemetry.weight),
                  hasViolations: false,
                  ...(resolvedGroup ? {
                    groupId: resolvedGroup.id,
                    ...(resolvedGroup.rationId ? { rationId: resolvedGroup.rationId } : {})
                  } : {})
                }
              })
            } else {
              activeBatch = null
            }
            break
        }
      }

      // Fallback: если замес завис (весы выключили/ушли в минус), принудительно закрываем.
      // Это работает даже когда dbActions пустой и FSM не смог довести замес до COMPLETE_BATCH.
      if (activeBatch) {
        const hasCloseAction = (result.dbActions || []).some((action) =>
          action.type === 'COMPLETE_BATCH' || action.type === 'FORCE_CLOSE_BATCH'
        )
        const hasAddAction = (result.dbActions || []).some((action) => action.type === 'ADD_INGREDIENT')

        if (!hasCloseAction && !hasAddAction) {
          const [recentTelemetry, ingredientCount] = await Promise.all([
            tx.telemetry.findMany({
              where: {
                deviceId,
                timestamp: {
                  gte: activeBatch.startTime,
                  lte: telemetry.timestamp
                }
              },
              orderBy: orderBySourceTimestampDesc(),
              take: autoCloseEmptyStreak,
              select: { weight: true }
            }),
            tx.batchIngredient.count({
              where: { batchId: activeBatch.id }
            })
          ])

          if (ingredientCount > 0) {
            const currentWeight = roundWeight(packet.weight || 0)
            const negativeCount = recentTelemetry.filter((item) => Number(item.weight || 0) < 0).length
            const nearZeroCount = recentTelemetry.filter((item) => Math.max(0, Number(item.weight || 0)) <= autoCloseZeroWeightKg).length

            const shouldAutoCloseByNegative = recentTelemetry.length >= autoCloseNegativeStreak && negativeCount >= autoCloseNegativeStreak
            const shouldAutoCloseByEmpty = recentTelemetry.length >= autoCloseEmptyStreak && nearZeroCount >= autoCloseEmptyStreak
            const currentPacketIsNegative = currentWeight < 0
            const currentPacketIsEmpty = Math.max(0, currentWeight) <= autoCloseZeroWeightKg

            if (
              (shouldAutoCloseByNegative && currentPacketIsNegative) ||
              (shouldAutoCloseByEmpty && currentPacketIsEmpty)
            ) {
              const closedBatchId = activeBatch.id
              unloadGroupEvidenceByBatch.delete(closedBatchId)
              await tx.batch.update({
                where: { id: closedBatchId },
                data: {
                  endTime: telemetry.timestamp,
                  endWeight: roundNonNegativeWeight(packet.weight || 0)
                }
              })
              batchIdsToRecalculate.add(closedBatchId)
              postprocessBatchIds.add(closedBatchId)
              shouldClearDeviceState = true
              console.log(`Замес ${closedBatchId} автозакрыт (fallback по серии пустого/негативного веса)`)
              activeBatch = null
            }
          }
        }
      }

      for (const batchId of batchIdsToRecalculate) {
        await recalculateBatchViolations(tx, batchId, telemetrySettings)
        if (stickyViolationBatchIds.has(batchId)) {
          await tx.batch.update({
            where: { id: batchId },
            data: { hasViolations: true }
          })
        }
      }
    })

    for (const batchId of postprocessBatchIds) {
      try {
        await postprocessCompletedBatch(prisma, batchId, telemetrySettings, { persist: true })
      } catch (postprocessError) {
        console.error(`[Postprocess] Не удалось пересчитать замес ${batchId}:`, postprocessError)
      }
    }

    if (shouldClearDeviceState) {
      telemetryProcessor.clearDeviceState(deviceId)
    }

    await updateDeviceCurrentTelemetry(telemetry, receivedAt, identity)

    return {
      status: 'ok',
      id: telemetry.id,
      banner: result.banner,
      outOfOrder: shouldScheduleReplay,
      timestamp: packet.timestamp.toISOString()
    }
}

function normalizeBatchEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HostTelemetryValidationError('Batch body must be an object')
  }
  if (Number(body.protocol_version) !== 1) throw new HostTelemetryValidationError('Unsupported protocol_version')
  const deviceId = String(body.device_id || '').trim()
  const streamId = String(body.stream_id || '').trim()
  if (!deviceId || !streamId || deviceId.length > 128 || streamId.length > 128) {
    throw new HostTelemetryValidationError('device_id and stream_id are required')
  }
  if (!Array.isArray(body.packets) || body.packets.length < 1 || body.packets.length > 50) {
    throw new HostTelemetryValidationError('packets must contain 1..50 entries')
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 1024 * 1024) {
    throw new HostTelemetryValidationError('Batch body exceeds 1 MiB')
  }
  const packetIds = new Set()
  const packets = body.packets.map((entry) => {
    const packetId = Number(entry?.packet_id)
    if (!Number.isSafeInteger(packetId) || packetId <= 0 || packetIds.has(packetId)) {
      throw new HostTelemetryValidationError('packet_id must be a unique positive integer')
    }
    if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) {
      throw new HostTelemetryValidationError(`packet ${packetId} payload must be an object`)
    }
    packetIds.add(packetId)
    return { packetId, payload: { ...entry.payload, device_id: deviceId, deviceId } }
  })
  const livePacketId = Number(body.live_packet_id)
  if (!packetIds.has(livePacketId)) throw new HostTelemetryValidationError('live_packet_id must identify a packet in this batch')
  return { deviceId, streamId, livePacketId, packets }
}

router.post('/batch', (req, res) => {
  try {
    const accepted = hostIngressStore.enqueueBatch(normalizeBatchEnvelope(req.body), new Date())
    return res.status(202).json({ status: 'accepted', receipt_id: accepted.receiptId, acked_packet_ids: accepted.ackedPacketIds })
  } catch (error) {
    const status = error?.permanent ? 400 : 503
    if (status === 503) res.set('Retry-After', '5')
    return res.status(status).json({ error: error?.message || 'Host ingress unavailable', retryable: status === 503 })
  }
})

router.post('/', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new HostTelemetryValidationError('Telemetry body must be an object')
    }
    const accepted = hostIngressStore.enqueueLegacy(req.body, new Date())
    return res.status(202).json({ status: 'accepted', receipt_id: accepted.receiptId })
  } catch (error) {
    const status = error?.permanent ? 400 : 503
    if (status === 503) res.set('Retry-After', '5')
    return res.status(status).json({ error: error?.message || 'Host ingress unavailable', retryable: status === 503 })
  }
})

// ============================================================================
// POST /manual-stop - РУЧНАЯ ОСТАНОВКА АКТИВНОГО ЗАМЕСА
// ============================================================================
router.post('/manual-stop', authenticate, requireAdmin, async (req, res) => {
  try {
    const rawBatchId = req.body?.batchId;
    const rawDeviceId = req.body?.deviceId;
    const batchId = rawBatchId === undefined || rawBatchId === null || rawBatchId === ''
      ? null
      : Number.parseInt(rawBatchId, 10);
    const requestedDeviceId = typeof rawDeviceId === 'string' && rawDeviceId.trim()
      ? rawDeviceId.trim()
      : null;

    if (rawBatchId !== undefined && rawBatchId !== null && rawBatchId !== '' && !Number.isInteger(batchId)) {
      return res.status(400).json({ error: 'Некорректный batchId' });
    }

    const activeBatch = await prisma.batch.findFirst({
      where: {
        endTime: null,
        ...(Number.isInteger(batchId) ? { id: batchId } : {}),
        ...(requestedDeviceId ? { deviceId: requestedDeviceId } : {})
      },
      orderBy: { startTime: 'desc' }
    });

    if (!activeBatch) {
      return res.status(404).json({ error: 'Активный замес не найден' });
    }

    const latestTelemetry = await prisma.telemetry.findFirst({
      where: { deviceId: activeBatch.deviceId },
      orderBy: orderBySourceTimestampDesc(),
      select: { weight: true }
    });

    const endWeight = Number.isFinite(Number(latestTelemetry?.weight))
      ? roundWeight(latestTelemetry.weight)
      : roundWeight(activeBatch.endWeight ?? activeBatch.startWeight ?? 0);

    const now = new Date();
    const updatedBatch = await prisma.batch.update({
      where: { id: activeBatch.id },
      data: {
        endTime: now,
        endWeight
      }
    });

    const telemetrySettings = await getTelemetrySettings(prisma)
    await recalculateBatchViolations(prisma, updatedBatch.id, telemetrySettings);
    try {
      await postprocessCompletedBatch(prisma, updatedBatch.id, telemetrySettings, { persist: true })
    } catch (postprocessError) {
      console.error(`[Postprocess] Не удалось пересчитать вручную остановленный замес ${updatedBatch.id}:`, postprocessError)
    }
    telemetryProcessor.clearDeviceState(updatedBatch.deviceId);

    res.json({
      status: 'ok',
      message: `Замес #${updatedBatch.id} остановлен вручную`,
      batch: {
        id: updatedBatch.id,
        deviceId: updatedBatch.deviceId,
        endTime: updatedBatch.endTime,
        endWeight: updatedBatch.endWeight
      }
    });
  } catch (error) {
    console.error('[Ошибка POST /manual-stop]:', error);
    res.status(500).json({ error: 'Не удалось остановить замес' });
  }
});


// ============================================================================
// GET /current - ДАННЫЕ ДЛЯ ГЛАВНОЙ СТРАНИЦЫ
// ============================================================================
router.get('/current', authenticate, requireReadAccess, async (req, res) => {
  try {
    const requestedDeviceId = getRequestedDeviceId(req)
    let data = await findCurrentTelemetry(requestedDeviceId);
    
    if (!data) return res.json(buildEmptyLatestResponse(requestedDeviceId));

    const memoryState = telemetryProcessor.getState(data.deviceId);
    const [activeBatch, activeZones, telemetrySettings] = await Promise.all([
      prisma.batch.findFirst({
      where: { deviceId: data.deviceId, endTime: null },
      include: {
        group: {
          include: {
            ration: {
              include: {
                ingredients: true
              }
            }
          }
        },
        ration: { include: { ingredients: true } },
        actualIngredients: true
      },
      orderBy: { startTime: 'desc' }
      }),
      prisma.storageZone.findMany({ where: { active: true } }),
      getTelemetrySettings(prisma)
    ]);
    if (data.pipelineStatus === 'accepted') {
      data = applyWeightCalibration(data, telemetrySettings)
    }
    const effectivePosition = await resolveEffectiveCoordinates(prisma, data, {
      deviceId: data.deviceId,
      referenceTime: data.timestamp,
      loaderMaxDistanceMeters: telemetrySettings.loaderMaxDistanceMeters,
      loaderOfflineTimeoutMinutes: telemetrySettings.loaderOfflineTimeoutMinutes
    });
    const detectedZone = getZoneByCoordinates(effectivePosition.lat, effectivePosition.lon, activeZones);

    const machineState = await inferMachineStateFromDatabase(
      data.deviceId,
      data,
      activeBatch,
      memoryState,
      telemetrySettings,
      {
        currentZone: detectedZone?.name || null
      }
    );

    let mode = 'Ожидание';
    let unload_progress = null;
    let active_banner = null;

    if (machineState) {
      mode = machineState.mode || mode;

      // БАННЕР ЗОНЫ (И для загрузки, и для выгрузки)
      if (machineState.currentZone) {
        active_banner = { 
          type: 'zone_info', 
          message: `Зона: ${machineState.currentZone}` 
        };
      }

      if (machineState.isUnloading) {
        mode = 'Выгрузка';
        unload_progress = buildUnloadProgress(activeBatch, roundWeight(data.weight), machineState);
      } else if (machineState.isMixing) {
        mode = 'Загрузка';
      }
    }

    // 2. СИСТЕМНЫЕ БАННЕРЫ (Приоритет: если есть ошибка GPS, она важнее зоны)
    if (data.lat === 0 && data.lon === 0) {
      if (data.gpsQuality === 0) {
        active_banner = { type: 'gps_warning', message: 'Ожидание GPS fix' };
      } else if (data.gpsQuality === 1) {
        active_banner = { type: 'gps_error', message: 'Координаты не распознаны' };
      }
    }

    let active_batch_data = null;
    if (activeBatch) {
      active_batch_data = {
        id: activeBatch.id,
        rationId: activeBatch.rationId,
        groupId: activeBatch.groupId,
        ingredients: buildIngredientSummary(activeBatch, telemetrySettings)
      };
    }

    res.json({
      ...serializeTelemetryForResponse(data),
      selectedDeviceId: data.deviceId,
      banner: active_banner, // Вот тут будет висеть зона, пока трактор там
      mode,
      isMixing: machineState.isMixing,
      isUnloading: machineState.isUnloading,
      unload_progress,
      active_batch: active_batch_data
    });

  } catch (error) {
    console.error('[Ошибка /current]:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ============================================================================
// GET /recent - НЕДАВНИЕ ТОЧКИ
// ============================================================================
router.get('/recent', authenticate, requireReadAccess, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, DEFAULT_RECENT_LIMIT);
    const requestedDeviceId = getRequestedDeviceId(req)
    const clearSince = await getHostTrackClearSince(prisma)
    const where = {
      ...(requestedDeviceId ? { deviceId: requestedDeviceId } : {}),
      ...(clearSince ? { timestamp: { gt: clearSince } } : {})
    }
    const data = await prisma.telemetry.findMany({ 
      where: Object.keys(where).length ? where : undefined,
      orderBy: orderBySourceTimestampDesc(), take: limit,
      select: { id: true, timestamp: true, receivedAt: true, lat: true, lon: true, speedKmh: true, weight: true, rawWeight: true, weightValid: true, gpsValid: true, gpsAgeS: true, deviceId: true }
    });
    res.json(data.map(serializeTelemetryForResponse));
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ============================================================================
// АДМИНСКИЕ ЭНДПОИНТЫ (История, сидирование, удаление)
// ============================================================================
router.get('/admin/latest', authenticate, requireAdmin, async (req, res) => {
  try {
    let data = await findCurrentTelemetry(getRequestedDeviceId(req));
    if (!data) return res.json(buildEmptyLatestResponse());
    if (data.pipelineStatus === 'accepted') {
      data = applyWeightCalibration(data, await getTelemetrySettings(prisma))
    }
    res.json({ ...serializeTelemetryForResponse(data), banner: null });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/admin/replay-days', authenticate, requireAdmin, async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT DISTINCT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', '+7 hours') AS date
      FROM Telemetry
      WHERE timestamp IS NOT NULL
      ORDER BY date DESC
      LIMIT 120
    `)
    const dates = rows
      .map((row) => String(row?.date || '').trim())
      .filter(Boolean)

    res.json({ dates })
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/host/admin/replay-days]:', error)
    res.status(500).json({ error: 'Не удалось получить даты истории' })
  }
})

router.get('/admin/replay-day', authenticate, requireAdmin, async (req, res) => {
  try {
    const selectedDate = String(req.query.date || getFarmDateString()).trim()
    const range = farmDateRange(selectedDate)
    if (!range) {
      return res.status(400).json({ error: 'Некорректная дата истории' })
    }

    const hostWhere = {
      timestamp: {
        gte: range.start,
        lte: range.end
      }
    }
    const rtkWhere = {
      timestamp: {
        gte: range.start,
        lte: range.end
      }
    }
    const batchWhere = {
      startTime: { lte: range.end },
      OR: [
        { endTime: null },
        { endTime: { gte: range.start } }
      ]
    }

    const [hostCount, hostRows, rtkRows, batches, telemetrySettings] = await Promise.all([
      prisma.telemetry.count({ where: hostWhere }),
      prisma.telemetry.findMany({
        where: hostWhere,
        orderBy: orderBySourceTimestampAsc(),
        take: MAX_REPLAY_DAY_ROWS,
        select: {
          id: true,
          deviceId: true,
          timestamp: true,
          receivedAt: true,
          lat: true,
          lon: true,
          gpsValid: true,
          gpsSatellites: true,
          gpsAgeS: true,
          gpsQuality: true,
          speedKmh: true,
          weight: true,
          rawWeight: true,
          weightValid: true,
          cpuTempC: true,
          lteRssiDbm: true,
          lteAccessTech: true,
          eventsReaderOk: true
        }
      }),
      prisma.rtkTelemetry.findMany({
        where: rtkWhere,
        orderBy: [
          { timestamp: 'asc' },
          { id: 'asc' }
        ],
        take: MAX_REPLAY_DAY_ROWS,
        select: {
          id: true,
          deviceId: true,
          timestamp: true,
          lat: true,
          lon: true,
          rtkQuality: true,
          rtkAge: true,
          speed: true,
          course: true,
          satellites: true,
          fixType: true
        }
      }),
      prisma.batch.findMany({
        where: batchWhere,
        orderBy: [
          { startTime: 'asc' },
          { id: 'asc' }
        ],
        select: {
          id: true,
          deviceId: true,
          startTime: true,
          endTime: true,
          startWeight: true,
          endWeight: true,
          actualIngredients: {
            orderBy: [
              { addedAt: 'asc' },
              { id: 'asc' }
            ],
            select: {
              id: true,
              ingredientName: true,
              actualWeight: true,
              startedAt: true,
              addedAt: true
            }
          }
        }
      }),
      getTelemetrySettings(prisma)
    ])

    res.json({
      date: selectedDate,
      range: {
        from: range.start,
        to: range.end
      },
      truncated: hostCount > hostRows.length,
      host: hostRows.map(serializeTelemetryForResponse),
      rtk: rtkRows,
      batches,
      settings: {
        unloadDropThresholdKg: telemetrySettings.unloadDropThresholdKg,
        unloadMinPeakKg: telemetrySettings.unloadMinPeakKg,
        modeUnloadDropHintKg: telemetrySettings.modeUnloadDropHintKg,
        modeLoadingDeltaHintKg: telemetrySettings.modeLoadingDeltaHintKg,
        movementSpeedThresholdKmh: telemetrySettings.movementSpeedThresholdKmh,
        movementConfirmPackets: telemetrySettings.movementConfirmPackets,
        loaderOfflineTimeoutMinutes: telemetrySettings.loaderOfflineTimeoutMinutes
      }
    })
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/host/admin/replay-day]:', error)
    res.status(500).json({ error: 'Не удалось загрузить историю за день' })
  }
})

router.get('/admin/history', authenticate, requireAdmin, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, DEFAULT_ADMIN_HISTORY_LIMIT);
    const requestedDeviceId = getRequestedDeviceId(req)
    const includeCleared = String(req.query.includeCleared || '').trim() === '1'
    const clearSince = includeCleared ? null : await getHostTrackClearSince(prisma)
    const data = await findAdminHistoryTelemetry({ limit, requestedDeviceId, clearSince })
    res.json(data.map(serializeTelemetryForResponse));
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/admin/seed', authenticate, requireAdmin, async (req, res) => {
  try {
    const points = [];
    let startLat = 52.52, startLon = 85.12;
    for (let i = 0; i < 20; i++) {
      points.push({
        deviceId: 'test_seeder_01', timestamp: new Date(Date.now() - (20 - i) * 10000), 
        lat: startLat + (i * 0.0005), lon: startLon + (i * 0.0005), gpsValid: true, gpsSatellites: 15,
        weight: roundWeight(2450.5 + (i * 10)), weightValid: true, gpsQuality: 4, wifiClients: '[]', eventsReaderOk: true,
        rawPayload: JSON.stringify({ seeded: true, index: i }),
        receivedAt: new Date()
      });
    }
    const created = await prisma.telemetry.createMany({ data: points });
    res.json({ status: 'ok', message: `Добавлено ${created.count} точек` });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/admin/truncate', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const clearSince = await setHostTrackClearSince(prisma, new Date());
    res.json({
      status: 'ok',
      message: 'Трек скрыт до новых пакетов',
      clearSince: clearSince.toISOString(),
      persisted: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

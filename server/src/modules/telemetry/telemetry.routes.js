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
import { scheduleReplayAfterBufferedTelemetry } from './replay-scheduler.js'
import { postprocessCompletedBatch } from '../batches/batch-postprocess-service.js'

const router = Router()
const DEFAULT_RECENT_LIMIT = 5
const DEFAULT_ADMIN_HISTORY_LIMIT = 10
const MAX_TELEMETRY_HISTORY_LIMIT = 5000
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

function normalizeTelemetryPacket(packet) {
  return {
    deviceId: packet.deviceId || packet.device_id || 'host_01',
    timestamp: packet.timestamp ? new Date(packet.timestamp) : new Date(),
    lat: Number(packet.lat || 0),
    lon: Number(packet.lon || 0),
    gpsValid: parseBoolean(packet.gpsValid ?? packet.gps_valid),
    gpsSatellites: Number(packet.gpsSatellites ?? packet.gps_satellites ?? 0),
    speedKmh: parseOptionalNumber(packet.speedKmh ?? packet.speed_kmh ?? packet.speed),
    weight: Number(packet.weight || 0),
    rawWeight: parseOptionalNumber(packet.raw ?? packet.rawWeight ?? packet.raw_weight),
    weightValid: parseBoolean(packet.weightValid ?? packet.weight_valid),
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
    speedKmh: null, weight: null, rawWeight: null, weightValid: false, gpsValid: false, gpsSatellites: 0,
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
router.post('/', async (req, res) => {
  try {
    const receivedAt = new Date()
    let packet = normalizeTelemetryPacket(req.body);
    const deviceId = packet.deviceId;
    const rawPayload = stringifyRawPayload(req.body)

    // 1. Достаем геозоны из базы
    const [activeZones, groupsWithZones, telemetrySettings, activeBatchForHints, latestStoredTelemetry] = await Promise.all([
      prisma.storageZone.findMany({ where: { active: true } }),
      prisma.livestockGroup.findMany({
        where: { storageZoneId: { not: null } },
        select: { storageZoneId: true }
      }),
      getTelemetrySettings(prisma),
      prisma.batch.findFirst({
        where: { deviceId, endTime: null },
        orderBy: { startTime: 'desc' },
        include: {
          ration: { include: { ingredients: true } },
          group: { include: { ration: { include: { ingredients: true } } } }
        }
      }),
      prisma.telemetry.findFirst({
        where: { deviceId },
        orderBy: orderBySourceTimestampDesc(),
        select: { id: true, timestamp: true }
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
    packet = applyWeightCalibration(packet, telemetrySettings)
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

    // Вся валидация координат, смена зон и расчет дельт
    const result = telemetryProcessor.processPacket(processorPacket, loadingZones, telemetrySettings, {
      suppressLoading,
      skipZoneVisit: effectivePosition.source === 'rtk',
      allowVisitedZoneIngredient: effectivePosition.source === 'rtk',
      preferCurrentZoneIngredient: effectivePosition.source === 'rtk',
      hostForceIngredientName,
      expectedIngredients: resolveExpectedIngredientsFromBatch(activeBatchForHints)
    });

    if (!result.isValid) {
      console.warn(`[Фильтр] Отброшен невалидный пакет от ${deviceId}:`, result.error);
      return res.status(400).json({ error: result.error || 'Invalid coordinates' });
    }

    let telemetry = null
    let shouldClearDeviceState = false
    let shouldScheduleReplay = false
    const postprocessBatchIds = new Set()
    const latestStoredTimestampMs = latestStoredTelemetry?.timestamp instanceof Date
      ? latestStoredTelemetry.timestamp.getTime()
      : Number.NaN
    const currentPacketTimestampMs = packet.timestamp instanceof Date
      ? packet.timestamp.getTime()
      : Number.NaN
    const isOutOfOrderPacket = Number.isFinite(latestStoredTimestampMs) &&
      Number.isFinite(currentPacketTimestampMs) &&
      currentPacketTimestampMs < latestStoredTimestampMs
    await prisma.$transaction(async (tx) => {
      telemetry = await tx.telemetry.create({
        data: {
          deviceId: deviceId,
          timestamp: packet.timestamp,
          receivedAt,
          lat: packet.lat,
          lon: packet.lon,
          gpsValid: packet.gpsValid,
          gpsSatellites: packet.gpsSatellites,
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
      })

      if (isOutOfOrderPacket) {
        shouldScheduleReplay = true
        return
      }

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

      for (const action of (result.dbActions || [])) {
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

    if (shouldScheduleReplay) {
      const replay = scheduleReplayAfterBufferedTelemetry('host-buffer-out-of-order', {
        deviceId,
        telemetryId: telemetry?.id || null,
        packetTimestamp: packet.timestamp,
        latestKnownTimestamp: latestStoredTelemetry?.timestamp || null,
        receivedAt
      })

      if (replay.scheduled) {
        console.log('[Host ingest background]: scheduled replay after out-of-order buffered telemetry', {
          deviceId,
          telemetryId: telemetry?.id || null,
          packetTimestamp: packet.timestamp?.toISOString?.() || null,
          latestKnownTimestamp: latestStoredTelemetry?.timestamp?.toISOString?.() || null,
          delayMs: replay.delayMs
        })
      }
    }

    // Возвращаем ответ контроллеру трактора
    res.status(201).json({ status: 'ok', id: telemetry.id, banner: result.banner });

  } catch (error) {
    console.error('[Ошибка POST /]:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
    const data = await prisma.telemetry.findFirst({
      where: requestedDeviceId ? { deviceId: requestedDeviceId } : undefined,
      orderBy: orderBySourceTimestampDesc()
    });
    
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
      select: { id: true, timestamp: true, receivedAt: true, lat: true, lon: true, speedKmh: true, weight: true, rawWeight: true, weightValid: true, gpsValid: true, deviceId: true }
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
    const data = await prisma.telemetry.findFirst({ orderBy: orderBySourceTimestampDesc() });
    if (!data) return res.json(buildEmptyLatestResponse());
    res.json({ ...serializeTelemetryForResponse(data), banner: null });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/admin/history', authenticate, requireAdmin, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, DEFAULT_ADMIN_HISTORY_LIMIT);
    const requestedDeviceId = getRequestedDeviceId(req)
    const clearSince = await getHostTrackClearSince(prisma)
    const where = {
      ...(requestedDeviceId ? { deviceId: requestedDeviceId } : {}),
      ...(clearSince ? { timestamp: { gt: clearSince } } : {})
    }
    const data = await prisma.telemetry.findMany({
      where: Object.keys(where).length ? where : undefined,
      orderBy: orderBySourceTimestampDesc(),
      take: limit
    });
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

import { PrismaClient } from '@prisma/client'

import telemetryProcessor from '../../module-3/telemetryProcessor.js'
import { calculateHaversine, detectZoneObject } from '../../module-1/geo.js'
import { normalizeIngredientName } from '../../module-2/rationManager.js'
import { DEFAULT_TELEMETRY_SETTINGS } from '../src/modules/telemetry/telemetry-settings.js'
import { TELEMETRY_FRESHNESS_MS } from '../src/modules/telemetry/telemetry-helpers.js'
import { recalculateBatchViolations } from '../src/modules/batches/batch-violations.js'
import { recordLeftoverViolation } from '../src/modules/violations/violation-service.js'
import { alignAmbiguousIngredientsWithRation } from '../src/modules/telemetry/loading-zone-correction.js'

const prisma = new PrismaClient()
const SAME_INGREDIENT_MERGE_WINDOW_MS = 10000

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
    : 15
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
    weightValid: parseBoolean(row.weightValid),
    gpsQuality: Number(row.gpsQuality || 0),
    wifiClients: row.wifiClients ?? [],
    cpuTempC: row.cpuTempC ?? null,
    lteRssiDbm: row.lteRssiDbm ?? null,
    lteAccessTech: row.lteAccessTech ?? null,
    eventsReaderOk: parseBoolean(row.eventsReaderOk)
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
  list.unshift(Number(weight || 0))
  if (list.length > limit) list.length = limit
  recentWeightsByDevice.set(deviceId, list)
  return list
}

async function resetCalculatedTables() {
  await prisma.violation.deleteMany({})
  await prisma.batchIngredient.deleteMany({})
  await prisma.batch.deleteMany({})
  await prisma.$executeRawUnsafe("DELETE FROM sqlite_sequence WHERE name IN ('Violation', 'BatchIngredient', 'Batch')")
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
      const packet = normalizeTelemetryRow(row)
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
      const activeBatchForHints = activeBatchByDevice.get(deviceId) || null
      const expectedIngredients = activeBatchForHints?.expectedIngredients || resolveExpectedIngredientsFromGroup(resolvedGroup)
      const currentZone = detectZoneObject(effectivePosition.lat, effectivePosition.lon, activeZones)
      const suppressLoading = isBarnZone(currentZone, linkedBarnZoneIds)
      const result = telemetryProcessor.processPacket(processorPacket, loadingZones, telemetrySettings, {
        suppressLoading,
        skipZoneVisit: effectivePosition.source === 'rtk',
        allowVisitedZoneIngredient: effectivePosition.source === 'rtk',
        expectedIngredients
      })

      stats.processed += 1
      if (!result.isValid) {
        stats.skippedInvalid += 1
        continue
      }

      let activeBatch = activeBatchByDevice.get(deviceId) || null

      async function bindBatchToResolvedGroup() {
        if (!activeBatch || !resolvedGroup) return
        const patch = {}
        if (resolvedGroup.id && activeBatch.groupId !== resolvedGroup.id) {
          patch.groupId = resolvedGroup.id
        }
        if (resolvedGroup.rationId && activeBatch.rationId !== resolvedGroup.rationId) {
          patch.rationId = resolvedGroup.rationId
        }
        if (!Object.keys(patch).length) {
          await alignAmbiguousIngredientsWithRation(prisma, {
            batchId: activeBatch.id,
            expectedIngredients: resolvedGroup.ration?.ingredients || [],
            loadingZones
          })
          return
        }

        activeBatch = await prisma.batch.update({
          where: { id: activeBatch.id },
          data: patch
        })
        await alignAmbiguousIngredientsWithRation(prisma, {
          batchId: activeBatch.id,
          expectedIngredients: resolvedGroup.ration?.ingredients || [],
          loadingZones
        })
        activeBatch.expectedIngredients = resolveExpectedIngredientsFromGroup(resolvedGroup)
        activeBatchByDevice.set(deviceId, activeBatch)
        batchIdsToRecalculate.add(activeBatch.id)
      }

      for (const action of (result.dbActions || [])) {
        switch (action.type) {
          case 'START_BATCH':
            if (!activeBatch) {
              const actionStartTime = action.startTime ? new Date(action.startTime) : packet.timestamp
              activeBatch = await prisma.batch.create({
                data: {
                  deviceId,
                  startTime: Number.isNaN(actionStartTime.getTime()) ? packet.timestamp : actionStartTime,
                  startWeight: Number(action.startWeight ?? packet.weight),
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
                  startWeight: packet.weight,
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
              const actualWeight = Number(action.actualWeight || 0)
              const actionStartedAt = action.startTime ? new Date(action.startTime) : null
              const actionEndedAt = action.endTime ? new Date(action.endTime) : packet.timestamp
              const effectiveIngredientAddedAt = actionEndedAt && !Number.isNaN(actionEndedAt.getTime())
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
                    actualWeight: Number(latestIngredient.actualWeight || 0) + actualWeight,
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
              await bindBatchToResolvedGroup()
              activeBatch = await prisma.batch.update({
                where: { id: activeBatch.id },
                data: { endWeight: Number(action.startUnloadWeight ?? packet.weight) }
              })
              activeBatch.expectedIngredients = resolveExpectedIngredientsFromGroup(resolvedGroup)
              activeBatchByDevice.set(deviceId, activeBatch)
            }
            break

          case 'UPDATE_UNLOAD':
            if (activeBatch) {
              if (Number(action.endWeight ?? packet.weight) >= emptyVehicleThresholdKg) {
                await bindBatchToResolvedGroup()
              }
              activeBatch = await prisma.batch.update({
                where: { id: activeBatch.id },
                data: { endWeight: action.endWeight }
              })
              activeBatch.expectedIngredients = resolveExpectedIngredientsFromGroup(resolvedGroup)
              activeBatchByDevice.set(deviceId, activeBatch)
            }
            break

          case 'LEFTOVER_VIOLATION':
            if (activeBatch) {
              await bindBatchToResolvedGroup()
              stickyViolationBatchIds.add(activeBatch.id)
              activeBatch = await prisma.batch.update({
                where: { id: activeBatch.id },
                data: {
                  hasViolations: true,
                  endWeight: Number(action.leftoverWeight ?? activeBatch.endWeight ?? packet.weight)
                }
              })
              activeBatchByDevice.set(deviceId, activeBatch)
              await recordLeftoverViolation(prisma, {
                batchId: activeBatch.id,
                deviceId,
                leftoverWeight: Number(action.leftoverWeight ?? packet.weight),
                detectedAt: packet.timestamp
              })
              stats.leftovers += 1
            }
            break

          case 'COMPLETE_BATCH':
            if (activeBatch) {
              const completedBatchId = activeBatch.id
              await prisma.batch.update({
                where: { id: activeBatch.id },
                data: {
                  endTime: packet.timestamp,
                  endWeight: Number(action.endWeight ?? packet.weight)
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
              await bindBatchToResolvedGroup()
              const closedBatchId = activeBatch.id
              stickyViolationBatchIds.add(closedBatchId)
              await prisma.batch.update({
                where: { id: activeBatch.id },
                data: {
                  endTime: packet.timestamp,
                  endWeight: Number(action.closeWeight ?? packet.weight),
                  hasViolations: true
                }
              })
              batchIdsToRecalculate.add(closedBatchId)
              stats.forceCloses += 1
            }

            activeBatch = await prisma.batch.create({
              data: {
                deviceId,
                startTime: packet.timestamp,
                startWeight: Number(action.nextStartWeight ?? packet.weight),
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

            if (shouldAutoCloseByNegative || shouldAutoCloseByEmpty) {
              const closedBatchId = activeBatch.id
              await prisma.batch.update({
                where: { id: closedBatchId },
                data: {
                  endTime: packet.timestamp,
                  endWeight: Math.max(0, Number(packet.weight || 0))
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

  console.log(`Recalculating violations for ${batchIdsToRecalculate.size} batches...`)
  for (const batchId of batchIdsToRecalculate) {
    await recalculateBatchViolations(prisma, batchId, telemetrySettings)
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

import '../src/load-env.js'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import prisma from '../src/database.js'
import telemetryProcessor from '../../module-3/telemetryProcessor.js'
import { detectZoneObject } from '../../module-1/geo.js'
import { normalizeIngredientName } from '../../module-2/rationManager.js'
import { recalculateBatchViolations } from '../src/modules/batches/batch-violations.js'
import { DEFAULT_TELEMETRY_SETTINGS, getTelemetrySettings } from '../src/modules/telemetry/telemetry-settings.js'
import { resolveGroupByCoordinates } from '../src/modules/telemetry/telemetry-helpers.js'
import { recordLeftoverViolation } from '../src/modules/violations/violation-service.js'

const TZ_OFFSET = '+07:00'
const START_LOCAL = process.env.REPLAY_START_LOCAL || '2026-07-01T00:00:00'
const END_LOCAL = process.env.REPLAY_END_LOCAL || '2026-07-03T00:00:00'
const START = new Date(`${START_LOCAL}${TZ_OFFSET}`)
const END = new Date(`${END_LOCAL}${TZ_OFFSET}`)
const RTK_LOOKBACK_MS = 60 * 1000
const RTK_FRESHNESS_MS = 15 * 1000
const SAME_INGREDIENT_MERGE_WINDOW_MS = 10 * 1000
const PRESERVE_ID_MAX_DIFF_MS = Number(process.env.REPLAY_ID_MAX_DIFF_SECONDS || 120) * 1000
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ID_MAP_DB_PATH = process.env.REPLAY_ID_MAP_DB ||
  path.resolve(SCRIPT_DIR, '../prisma/dev.before-replay-20260701-20260702.db.backup')

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return null
}

function normalizeZoneType(value) {
  return String(value || '').trim().toUpperCase()
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

function parseRawPayload(value) {
  if (!value) return {}
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function readRawValue(raw, keys, sectionKeys = []) {
  for (const key of keys) {
    if (raw?.[key] !== undefined && raw?.[key] !== null && raw?.[key] !== '') {
      return raw[key]
    }
  }

  for (const sectionKey of sectionKeys) {
    const section = raw?.[sectionKey]
    if (!section || typeof section !== 'object') continue
    for (const key of keys) {
      if (section[key] !== undefined && section[key] !== null && section[key] !== '') {
        return section[key]
      }
    }
  }

  return undefined
}

function parseInteger(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) ? parsed : null
}

function parseDateValue(value) {
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return new Date(Number(value))
  }
  return new Date(value)
}

function loadOriginalIdCandidates() {
  if (!fs.existsSync(ID_MAP_DB_PATH)) {
    console.warn('[Replay] preserved id map not found', { path: ID_MAP_DB_PATH })
    return []
  }

  const db = new Database(ID_MAP_DB_PATH, { readonly: true, fileMustExist: true })
  try {
    return db.prepare('SELECT id, startTime, endTime FROM Batch ORDER BY startTime, id').all()
      .map((row) => ({
        id: Number(row.id),
        startTime: parseDateValue(row.startTime),
        endTime: row.endTime === null || row.endTime === undefined ? null : parseDateValue(row.endTime)
      }))
      .filter((row) =>
        Number.isInteger(row.id) &&
        Number.isFinite(row.startTime.getTime()) &&
        row.startTime >= START &&
        row.startTime < END
      )
  } finally {
    db.close()
  }
}

function createPreservedIdAllocator(originalBatches) {
  const candidates = originalBatches
    .map((batch) => ({ ...batch, startMs: batch.startTime.getTime() }))
    .sort((left, right) => left.startMs - right.startMs || left.id - right.id)
  const usedIds = new Set()

  return (startTime) => {
    const startMs = parseDateValue(startTime).getTime()
    if (!Number.isFinite(startMs)) return null

    let best = null
    for (const candidate of candidates) {
      if (usedIds.has(candidate.id)) continue
      const diffMs = Math.abs(candidate.startMs - startMs)
      if (diffMs > PRESERVE_ID_MAX_DIFF_MS) continue
      if (!best || diffMs < best.diffMs || (diffMs === best.diffMs && candidate.id < best.id)) {
        best = { ...candidate, diffMs }
      }
    }

    if (!best) return null
    usedIds.add(best.id)
    return best.id
  }
}

function parseRelPosFlags(raw) {
  return parseInteger(readRawValue(raw, ['relPosFlags', 'rel_pos_flags', 'flags'], [
    'relposned',
    'relPosNed',
    'rel_pos_ned',
    'relpos',
    'relPos',
    'baseline'
  ]))
}

function parseRawBoolean(raw, keys) {
  return parseBoolean(readRawValue(raw, keys, [
    'relposned',
    'relPosNed',
    'rel_pos_ned',
    'relpos',
    'relPos',
    'baseline'
  ]))
}

function parseRelPosValid(raw, flags = null) {
  const explicit = parseRawBoolean(raw, ['relPosValid', 'rel_pos_valid'])
  if (explicit !== null) return explicit
  return flags !== null ? Boolean(flags & (1 << 2)) : null
}

function parseRelPosHeadingValid(raw, flags = null) {
  const explicit = parseRawBoolean(raw, [
    'relPosHeadingValid',
    'rel_pos_heading_valid',
    'headingValid',
    'heading_valid'
  ])
  if (explicit !== null) return explicit
  return flags !== null ? Boolean(flags & (1 << 8)) : null
}

function resolveScoreboardDeviceId(raw) {
  const value = readRawValue(raw, [
    'hostDeviceId',
    'host_device_id',
    'targetDeviceId',
    'target_device_id',
    'esrkDeviceId',
    'esrk_device_id'
  ])

  return typeof value === 'string' && value.trim() ? value.trim() : 'host_01'
}

async function findFreshRtkPointAt(rtkRows, deviceId, referenceTime) {
  const referenceMs = new Date(referenceTime).getTime()
  const minMs = referenceMs - RTK_FRESHNESS_MS

  const candidates = rtkRows.filter((row) => {
    const ts = new Date(row.timestamp).getTime()
    return Number.isFinite(ts) && ts >= minMs && ts <= referenceMs
  })

  const sameDevice = candidates
    .filter((row) => row.deviceId === deviceId)
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime() || right.id - left.id)

  if (sameDevice.length) return sameDevice[0]

  return candidates
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime() || right.id - left.id)[0] || null
}

async function loadReplayContext() {
  const [activeZones, groupsWithZones, telemetrySettings] = await Promise.all([
    prisma.storageZone.findMany({ where: { active: true } }),
    prisma.livestockGroup.findMany({
      where: { storageZoneId: { not: null } },
      select: { storageZoneId: true }
    }),
    getTelemetrySettings(prisma)
  ])

  const linkedBarnZoneIds = new Set(
    groupsWithZones
      .map((group) => Number(group.storageZoneId))
      .filter((zoneId) => Number.isInteger(zoneId) && zoneId > 0)
  )

  return {
    activeZones,
    loadingZones: activeZones.filter((zone) => isLoadingZone(zone, linkedBarnZoneIds)),
    linkedBarnZoneIds,
    telemetrySettings
  }
}

async function createBatch(activeBatchByDevice, deviceId, telemetry, action, resolvedGroup, allocatePreservedId = null) {
  const preservedId = allocatePreservedId ? allocatePreservedId(telemetry.timestamp) : null
  const canUsePreservedId = preservedId
    ? !(await prisma.batch.findUnique({ where: { id: preservedId }, select: { id: true } }))
    : false
  const data = {
    ...(canUsePreservedId ? { id: preservedId } : {}),
    deviceId,
    startTime: telemetry.timestamp,
    startWeight: Number(action.startWeight ?? telemetry.weight),
    hasViolations: false,
    ...(resolvedGroup ? {
      groupId: resolvedGroup.id,
      ...(resolvedGroup.rationId ? { rationId: resolvedGroup.rationId } : {})
    } : {})
  }

  const batch = await prisma.batch.create({ data })
  if (preservedId && !canUsePreservedId) {
    console.warn('[Replay] preserved id already exists, using autoincrement id', {
      preservedId,
      startTime: telemetry.timestamp
    })
  }
  activeBatchByDevice.set(deviceId, batch)
  return batch
}

async function bindBatchToResolvedGroup(batch, resolvedGroup, touchedBatchIds) {
  if (!batch || !resolvedGroup) return batch

  const patch = {}
  if (batch.groupId !== resolvedGroup.id) patch.groupId = resolvedGroup.id
  if (resolvedGroup.rationId && batch.rationId !== resolvedGroup.rationId) {
    patch.rationId = resolvedGroup.rationId
  }

  if (!Object.keys(patch).length) return batch

  const updated = await prisma.batch.update({
    where: { id: batch.id },
    data: patch
  })
  touchedBatchIds.add(updated.id)
  return updated
}

async function addIngredient(activeBatch, telemetry, action) {
  const ingredientName = String(action.ingredientName || '').trim() || 'Unknown'
  const actualWeight = Number(action.actualWeight || 0)
  const ingredientAddedAt = telemetry.timestamp instanceof Date
    ? telemetry.timestamp
    : new Date(telemetry.timestamp)

  const latestIngredient = await prisma.batchIngredient.findFirst({
    where: { batchId: activeBatch.id },
    orderBy: { addedAt: 'desc' }
  })

  const latestAddedAtMs = new Date(latestIngredient?.addedAt || 0).getTime()
  const ingredientAddedAtMs = ingredientAddedAt.getTime()
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
        actualWeight: Number(latestIngredient.actualWeight || 0) + actualWeight
      }
    })
    return 'merged'
  }

  await prisma.batchIngredient.create({
    data: {
      batchId: activeBatch.id,
      ingredientName,
      actualWeight,
      addedAt: ingredientAddedAt
    }
  })
  return 'created'
}

async function applyActions({
  deviceId,
  telemetry,
  result,
  resolvedGroup,
  activeBatchByDevice,
  touchedBatchIds,
  stickyViolationBatchIds,
  allocatePreservedId
}) {
  for (const action of result.dbActions || []) {
    let activeBatch = activeBatchByDevice.get(deviceId) || null

    if (action.type === 'START_BATCH') {
      if (!activeBatch) {
        await createBatch(activeBatchByDevice, deviceId, telemetry, action, resolvedGroup, allocatePreservedId)
      }
      continue
    }

    if (action.type === 'ADD_INGREDIENT') {
      if (!activeBatch) {
        activeBatch = await createBatch(
          activeBatchByDevice,
          deviceId,
          telemetry,
          { startWeight: telemetry.weight },
          resolvedGroup,
          allocatePreservedId
        )
      }

      await addIngredient(activeBatch, telemetry, action)
      touchedBatchIds.add(activeBatch.id)
      continue
    }

    if (action.type === 'START_UNLOAD') {
      if (activeBatch) {
        activeBatch = await bindBatchToResolvedGroup(activeBatch, resolvedGroup, touchedBatchIds)
        activeBatch = await prisma.batch.update({
          where: { id: activeBatch.id },
          data: { endWeight: Number(action.startUnloadWeight ?? telemetry.weight) }
        })
        activeBatchByDevice.set(deviceId, activeBatch)
      }
      continue
    }

    if (action.type === 'UPDATE_UNLOAD') {
      if (activeBatch) {
        activeBatch = await bindBatchToResolvedGroup(activeBatch, resolvedGroup, touchedBatchIds)
        activeBatch = await prisma.batch.update({
          where: { id: activeBatch.id },
          data: { endWeight: action.endWeight }
        })
        activeBatchByDevice.set(deviceId, activeBatch)
      }
      continue
    }

    if (action.type === 'LEFTOVER_VIOLATION') {
      if (activeBatch) {
        activeBatch = await bindBatchToResolvedGroup(activeBatch, resolvedGroup, touchedBatchIds)
        stickyViolationBatchIds.add(activeBatch.id)
        activeBatch = await prisma.batch.update({
          where: { id: activeBatch.id },
          data: {
            hasViolations: true,
            endWeight: Number(action.leftoverWeight ?? activeBatch.endWeight ?? telemetry.weight)
          }
        })
        activeBatchByDevice.set(deviceId, activeBatch)
        await recordLeftoverViolation(prisma, {
          batchId: activeBatch.id,
          deviceId,
          leftoverWeight: Number(action.leftoverWeight ?? telemetry.weight),
          detectedAt: telemetry.timestamp
        })
      }
      continue
    }

    if (action.type === 'COMPLETE_BATCH') {
      if (activeBatch) {
        activeBatch = await bindBatchToResolvedGroup(activeBatch, resolvedGroup, touchedBatchIds)
        const completedBatchId = activeBatch.id
        await prisma.batch.update({
          where: { id: completedBatchId },
          data: {
            endTime: telemetry.timestamp,
            endWeight: Number(action.endWeight ?? telemetry.weight)
          }
        })
        touchedBatchIds.add(completedBatchId)
        activeBatchByDevice.delete(deviceId)
      }
      continue
    }

    if (action.type === 'FORCE_CLOSE_BATCH') {
      if (activeBatch) {
        activeBatch = await bindBatchToResolvedGroup(activeBatch, resolvedGroup, touchedBatchIds)
        const closedBatchId = activeBatch.id
        stickyViolationBatchIds.add(closedBatchId)
        await prisma.batch.update({
          where: { id: closedBatchId },
          data: {
            endTime: telemetry.timestamp,
            endWeight: Number(action.closeWeight ?? telemetry.weight),
            hasViolations: true
          }
        })
        touchedBatchIds.add(closedBatchId)
      }

      const preservedId = allocatePreservedId ? allocatePreservedId(telemetry.timestamp) : null
      const canUsePreservedId = preservedId
        ? !(await prisma.batch.findUnique({ where: { id: preservedId }, select: { id: true } }))
        : false
      const nextBatch = await prisma.batch.create({
        data: {
          ...(canUsePreservedId ? { id: preservedId } : {}),
          deviceId,
          startTime: telemetry.timestamp,
          startWeight: Number(action.nextStartWeight ?? telemetry.weight),
          hasViolations: false,
          ...(resolvedGroup ? {
            groupId: resolvedGroup.id,
            ...(resolvedGroup.rationId ? { rationId: resolvedGroup.rationId } : {})
          } : {})
        }
      })
      if (preservedId && !canUsePreservedId) {
        console.warn('[Replay] preserved id already exists, using autoincrement id', {
          preservedId,
          startTime: telemetry.timestamp
        })
      }
      activeBatchByDevice.set(deviceId, nextBatch)
    }
  }
}

async function maybeAutoCloseHungBatch({
  deviceId,
  telemetry,
  result,
  activeBatchByDevice,
  recentTelemetryByDevice,
  telemetrySettings,
  touchedBatchIds,
  resolvedGroup
}) {
  let activeBatch = activeBatchByDevice.get(deviceId) || null
  if (!activeBatch) return false

  const hasCloseAction = (result.dbActions || []).some((action) =>
    action.type === 'COMPLETE_BATCH' || action.type === 'FORCE_CLOSE_BATCH'
  )
  const hasAddAction = (result.dbActions || []).some((action) => action.type === 'ADD_INGREDIENT')
  if (hasCloseAction || hasAddAction) return false

  const autoCloseZeroWeightKg = Number(telemetrySettings.autoCloseZeroWeightKg) > 0
    ? Number(telemetrySettings.autoCloseZeroWeightKg)
    : DEFAULT_TELEMETRY_SETTINGS.autoCloseZeroWeightKg
  const autoCloseEmptyStreak = Number(telemetrySettings.autoCloseEmptyStreak) > 0
    ? Number(telemetrySettings.autoCloseEmptyStreak)
    : DEFAULT_TELEMETRY_SETTINGS.autoCloseEmptyStreak
  const autoCloseNegativeStreak = Number(telemetrySettings.autoCloseNegativeStreak) > 0
    ? Number(telemetrySettings.autoCloseNegativeStreak)
    : DEFAULT_TELEMETRY_SETTINGS.autoCloseNegativeStreak

  const [recentTelemetry, ingredientCount] = await Promise.all([
    Promise.resolve((recentTelemetryByDevice.get(deviceId) || []).slice(-autoCloseEmptyStreak).reverse()),
    prisma.batchIngredient.count({ where: { batchId: activeBatch.id } })
  ])

  if (ingredientCount <= 0) return false

  const negativeCount = recentTelemetry.filter((item) => Number(item.weight || 0) < 0).length
  const nearZeroCount = recentTelemetry.filter((item) => Math.max(0, Number(item.weight || 0)) <= autoCloseZeroWeightKg).length
  const shouldAutoCloseByNegative = recentTelemetry.length >= autoCloseNegativeStreak && negativeCount >= autoCloseNegativeStreak
  const shouldAutoCloseByEmpty = recentTelemetry.length >= autoCloseEmptyStreak && nearZeroCount >= autoCloseEmptyStreak

  if (!shouldAutoCloseByNegative && !shouldAutoCloseByEmpty) return false

  activeBatch = await bindBatchToResolvedGroup(activeBatch, resolvedGroup, touchedBatchIds)
  const closedBatchId = activeBatch.id
  await prisma.batch.update({
    where: { id: closedBatchId },
    data: {
      endTime: telemetry.timestamp,
      endWeight: Math.max(0, Number(telemetry.weight || 0))
    }
  })
  touchedBatchIds.add(closedBatchId)
  activeBatchByDevice.delete(deviceId)
  telemetryProcessor.clearDeviceState(deviceId)
  return true
}

async function main() {
  if (Number.isNaN(START.getTime()) || Number.isNaN(END.getTime()) || START >= END) {
    throw new Error(`Invalid replay window: ${START_LOCAL} - ${END_LOCAL}`)
  }

  telemetryProcessor.clearStates()
  const context = await loadReplayContext()
  const originalIdCandidates = loadOriginalIdCandidates()
  const allocatePreservedId = createPreservedIdAllocator(originalIdCandidates)

  const [oldBatches, hostRows, rtkRows] = await Promise.all([
    prisma.batch.findMany({
      where: { startTime: { gte: START, lt: END } },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
      select: { id: true, startTime: true, endTime: true }
    }),
    prisma.telemetry.findMany({
      where: { timestamp: { gte: START, lt: END } },
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }]
    }),
    prisma.rtkTelemetry.findMany({
      where: { timestamp: { gte: new Date(START.getTime() - RTK_LOOKBACK_MS), lt: END } },
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }]
    })
  ])

  const oldBatchIds = oldBatches.map((batch) => batch.id)
  console.log('[Replay] window', { start: START.toISOString(), end: END.toISOString() })
  console.log('[Replay] before', {
    batches: oldBatches.length,
    hostRows: hostRows.length,
    rtkRows: rtkRows.length,
    preservedIdCandidates: originalIdCandidates.length
  })

  if (!hostRows.length) {
    console.log('[Replay] no host telemetry found, nothing to replay')
    return
  }

  if (oldBatchIds.length) {
    await prisma.violation.deleteMany({ where: { batchId: { in: oldBatchIds } } })
    await prisma.batchIngredient.deleteMany({ where: { batchId: { in: oldBatchIds } } })
    await prisma.batch.deleteMany({ where: { id: { in: oldBatchIds } } })
  }

  const events = [
    ...rtkRows.map((row) => ({ type: 'rtk', at: row.timestamp, row })),
    ...hostRows.map((row) => ({ type: 'host', at: row.timestamp, row }))
  ].sort((left, right) =>
    new Date(left.at).getTime() - new Date(right.at).getTime() ||
    (left.type === 'rtk' ? -1 : 1)
  )

  const activeBatchByDevice = new Map()
  const recentTelemetryByDevice = new Map()
  const touchedBatchIds = new Set()
  const stickyViolationBatchIds = new Set()
  let rtkProcessed = 0
  let hostProcessed = 0

  for (const event of events) {
    if (event.type === 'rtk') {
      const raw = parseRawPayload(event.row.rawPayload)
      const relPosFlags = parseRelPosFlags(raw)
      const hostDeviceId = resolveScoreboardDeviceId(raw)
      telemetryProcessor.processLoaderPacket({
        deviceId: hostDeviceId,
        hostDeviceId,
        timestamp: event.row.timestamp,
        lat: event.row.lat,
        lon: event.row.lon,
        speedKmh: event.row.speed,
        headingDeg: event.row.course,
        relPosValid: parseRelPosValid(raw, relPosFlags),
        relPosHeadingValid: parseRelPosHeadingValid(raw, relPosFlags)
      }, context.loadingZones, context.telemetrySettings, { deviceId: hostDeviceId })
      rtkProcessed += 1
      continue
    }

    const telemetry = event.row
    const deviceId = telemetry.deviceId
    const recentRows = recentTelemetryByDevice.get(deviceId) || []
    recentRows.push(telemetry)
    recentTelemetryByDevice.set(deviceId, recentRows.slice(-Math.max(
      Number(context.telemetrySettings.autoCloseEmptyStreak || 0),
      Number(context.telemetrySettings.autoCloseNegativeStreak || 0),
      DEFAULT_TELEMETRY_SETTINGS.autoCloseEmptyStreak,
      DEFAULT_TELEMETRY_SETTINGS.autoCloseNegativeStreak
    )))

    const freshRtk = await findFreshRtkPointAt(rtkRows, deviceId, telemetry.timestamp)
    const effectiveLat = freshRtk ? Number(freshRtk.lat) : Number(telemetry.lat)
    const effectiveLon = freshRtk ? Number(freshRtk.lon) : Number(telemetry.lon)
    const currentZone = detectZoneObject(effectiveLat, effectiveLon, context.activeZones)
    const suppressLoading = isBarnZone(currentZone, context.linkedBarnZoneIds)
    const resolvedGroup = await resolveGroupByCoordinates(prisma, effectiveLat, effectiveLon)
    const result = telemetryProcessor.processPacket({
      ...telemetry,
      lat: effectiveLat,
      lon: effectiveLon,
      headingDeg: freshRtk?.course ?? telemetry.headingDeg ?? telemetry.heading ?? telemetry.course,
      course: freshRtk?.course ?? telemetry.course ?? telemetry.heading
    }, context.loadingZones, context.telemetrySettings, {
      suppressLoading,
      skipZoneVisit: Boolean(freshRtk),
      hostPosition: {
        lat: Number(telemetry.lat),
        lon: Number(telemetry.lon)
      },
      rtkPosition: freshRtk
        ? {
            lat: Number(freshRtk.lat),
            lon: Number(freshRtk.lon)
          }
        : null,
      rtkFresh: Boolean(freshRtk)
    })

    if (!result.isValid) {
      console.warn('[Replay] skipped invalid host telemetry', {
        id: telemetry.id,
        timestamp: telemetry.timestamp,
        error: result.error
      })
      continue
    }

    await applyActions({
      deviceId,
      telemetry,
      result,
      resolvedGroup,
      activeBatchByDevice,
      touchedBatchIds,
      stickyViolationBatchIds,
      allocatePreservedId
    })
    await maybeAutoCloseHungBatch({
      deviceId,
      telemetry,
      result,
      activeBatchByDevice,
      recentTelemetryByDevice,
      telemetrySettings: context.telemetrySettings,
      touchedBatchIds,
      resolvedGroup
    })
    hostProcessed += 1
  }

  for (const batchId of touchedBatchIds) {
    await recalculateBatchViolations(prisma, batchId, context.telemetrySettings)
    if (stickyViolationBatchIds.has(batchId)) {
      await prisma.batch.update({
        where: { id: batchId },
        data: { hasViolations: true }
      })
    }
  }

  const newBatches = await prisma.batch.findMany({
    where: { startTime: { gte: START, lt: END } },
    include: { actualIngredients: { orderBy: { addedAt: 'asc' } } },
    orderBy: [{ startTime: 'asc' }, { id: 'asc' }]
  })

  console.log('[Replay] processed', { hostProcessed, rtkProcessed, recalculated: touchedBatchIds.size })
  console.log('[Replay] after', {
    batches: newBatches.length,
    ingredients: newBatches.reduce((sum, batch) => sum + batch.actualIngredients.length, 0)
  })

  for (const batch of newBatches) {
    console.log(`[Replay] batch #${batch.id} ${batch.startTime.toISOString()} - ${batch.endTime ? batch.endTime.toISOString() : 'open'}`)
    for (const ingredient of batch.actualIngredients) {
      console.log(`  - ${ingredient.addedAt.toISOString()} ${ingredient.ingredientName}: ${ingredient.actualWeight} kg`)
    }
  }
}

main()
  .catch((error) => {
    console.error('[Replay] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

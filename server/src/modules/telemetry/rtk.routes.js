import { Router } from 'express'
import prisma from '../../database.js'
import { authenticate, requireAdmin, requireReadAccess, requireWriteAccess } from '../../middleware/auth.js'
import { calculateHaversine, detectZoneObject } from '../../../../module-1/geo.js'

const router = Router()
const DEFAULT_RECENT_LIMIT = 5
const DEFAULT_HISTORY_LIMIT = 20
const MAX_RTK_HISTORY_LIMIT = 5000
const DEFAULT_ZONE_SECONDS = 30
const MAX_ZONE_SECONDS = 3600
const MAX_ZONE_SCAN_ROWS = 5000
const MAX_BULK_RTK_PACKETS = 1000

function parseTimestamp(value) {
  if (!value) return new Date()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

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

function parseInteger(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = parseInt(value, 10)
  return Number.isInteger(parsed) ? parsed : null
}

function parseLimit(value, fallback, options = {}) {
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : 500
  const parsed = parseInteger(value)
  if (!parsed || parsed <= 0) return fallback

  if (max > 0) {
    return Math.min(parsed, max)
  }

  return parsed
}

function getRequestedDeviceId(req) {
  const value = req.query.deviceId || req.query.device_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function mapQualityLabel(quality) {
  switch (quality) {
    case 0:
      return 'invalid_fix'
    case 1:
      return 'gps_fix'
    case 2:
      return 'dgps'
    case 4:
      return 'rtk_fixed'
    case 5:
      return 'rtk_float'
    default:
      return quality == null ? null : 'other'
  }
}

function resolveQualityLabel(rawLabel, quality) {
  return mapQualityLabel(quality)
}

function resolveWifiConnected(raw, wifiProfile, rssiDbm) {
  const explicit = parseBoolean(raw.wifi_connected ?? raw.wifiConnected)
  if (explicit !== null) {
    return explicit
  }

  const normalizedProfile = typeof wifiProfile === 'string'
    ? wifiProfile.trim().toLowerCase()
    : ''

  if (normalizedProfile === 'primary' || normalizedProfile === 'fallback') {
    return true
  }

  if (normalizedProfile === 'disconnected' || normalizedProfile === 'unknown') {
    return false
  }

  if (rssiDbm !== null) {
    return true
  }

  return null
}

function sanitizeAccuracyMeters(value, hasValidFix) {
  const parsed = parseNumber(value)

  if (parsed === null || !hasValidFix) {
    return null
  }

  if (parsed < 0 || parsed > 10000) {
    return null
  }

  return parsed
}

function sanitizeRawGga(value, hasValidFix) {
  if (!hasValidFix || typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeRtkPacket(raw) {
  const timestamp = parseTimestamp(raw.timestamp)
  const lat = parseNumber(raw.lat)
  const lon = parseNumber(raw.lon)
  const qualityNumberRaw = raw.quality ?? raw.fixQuality ?? raw.fix_quality ?? raw.solution
  const quality = parseInteger(qualityNumberRaw)
  const qualityLabelRaw = raw.quality_label ?? raw.rtkQuality ?? raw.rtk_quality ?? raw.solution_label
  const resolvedQualityLabel = resolveQualityLabel(qualityLabelRaw, quality)
  const fixTypeRaw = raw.fixType ?? raw.fix_type ?? raw.mode ?? raw.solutionType ?? raw.solution_type ?? resolvedQualityLabel ?? qualityNumberRaw

  return {
    deviceId: String(raw.deviceId || raw.device_id || 'host_01').trim() || 'host_01',
    timestamp,
    lat,
    lon,
    rtkQuality: resolvedQualityLabel,
    rtkAge: parseNumber(raw.corr_age_s ?? raw.corrAgeS ?? raw.rtkAge ?? raw.rtk_age ?? raw.age ?? raw.ageSeconds ?? raw.age_seconds),
    speed: parseNumber(raw.speed ?? raw.speedKmh ?? raw.speed_kmh),
    course: parseNumber(raw.course ?? raw.heading ?? raw.azimuth),
    supplyVoltage: parseNumber(raw.supplyVoltage ?? raw.supply_voltage ?? raw.voltage),
    satellites: parseInteger(raw.satellites ?? raw.gpsSatellites ?? raw.gps_satellites ?? raw.sats ?? raw.sat_count),
    fixType: fixTypeRaw !== undefined && fixTypeRaw !== null && String(fixTypeRaw).trim() !== ''
      ? String(fixTypeRaw).trim()
      : null,
    rawPayload: JSON.stringify(raw)
  }
}

function validateRtkPacket(packet) {
  if (!packet.timestamp) {
    return 'Некорректный timestamp'
  }

  if (!Number.isFinite(packet.lat) || packet.lat < -90 || packet.lat > 90) {
    return 'Некорректная широта lat'
  }

  if (!Number.isFinite(packet.lon) || packet.lon < -180 || packet.lon > 180) {
    return 'Некорректная долгота lon'
  }

  return null
}

function extractRtkPayloads(body) {
  if (Array.isArray(body)) {
    return body
  }

  if (Array.isArray(body?.packets)) {
    return body.packets
  }

  if (Array.isArray(body?.items)) {
    return body.items
  }

  if (Array.isArray(body?.data)) {
    return body.data
  }

  return [body || {}]
}

function buildEmptyRtkResponse(deviceId = null) {
  return {
    id: null,
    deviceId,
    timestamp: null,
    lat: null,
    lon: null,
    rtkQuality: null,
    rtkAge: null,
    speed: null,
    course: null,
    supplyVoltage: null,
    satellites: null,
    fixType: null,
    valid: null,
    quality: null,
    qualityLabel: null,
    qualityFlag: null,
    hacc: null,
    vacc: null,
    corrAgeS: null,
    rawGga: null,
    eventsReaderOk: null,
    wifiConnected: null,
    wifiSsid: null,
    wifiProfile: null,
    rssiDbm: null,
    sdReady: null,
    sdQueueLen: null,
    ramQueueLen: null,
    queueLen: null,
    freeHeapBytes: null,
    zone: null
  }
}

async function loadActiveZones() {
  return prisma.storageZone.findMany({
    where: { active: true },
    orderBy: { id: 'asc' }
  })
}

function serializeZone(zone, lat, lon) {
  if (!zone) return null

  const distance = Number.isFinite(lat) && Number.isFinite(lon)
    ? Math.round(calculateHaversine(lat, lon, Number(zone.lat), Number(zone.lon)) * 10) / 10
    : null

  return {
    id: zone.id,
    name: zone.name,
    ingredient: zone.ingredient,
    zoneType: zone.zoneType,
    radius: zone.radius,
    distanceMeters: distance
  }
}

function parseRawPayload(rawPayload) {
  if (typeof rawPayload !== 'string' || !rawPayload.trim()) {
    return null
  }

  try {
    return JSON.parse(rawPayload)
  } catch (error) {
    return null
  }
}

function serializeRtkTelemetry(row, zones = []) {
  if (!row) return null

  const raw = parseRawPayload(row.rawPayload) || {}
  const zone = detectZoneObject(row.lat, row.lon, zones)
  const quality = parseInteger(raw.quality ?? raw.fixQuality ?? raw.fix_quality ?? raw.solution)
  const qualityLabel = resolveQualityLabel(
    raw.quality_label ?? raw.rtkQuality ?? raw.rtk_quality ?? row.rtkQuality,
    quality
  )
  const rssiDbm = parseInteger(raw.rssi_dbm ?? raw.rssiDbm)
  const wifiProfile = raw.wifi_profile ?? raw.wifiProfile ?? null
  const valid = parseBoolean(raw.valid) ?? (quality != null ? quality > 0 : null)
  const hasValidFix = valid === true

  return {
    ...row,
    valid,
    quality,
    qualityLabel,
    qualityFlag: qualityLabel,
    hacc: sanitizeAccuracyMeters(raw.hacc, hasValidFix),
    vacc: sanitizeAccuracyMeters(raw.vacc, hasValidFix),
    corrAgeS: parseNumber(raw.corr_age_s ?? raw.corrAgeS ?? raw.rtkAge ?? raw.rtk_age ?? row.rtkAge),
    rawGga: sanitizeRawGga(raw.raw_gga ?? raw.rawGga ?? null, hasValidFix),
    eventsReaderOk: parseBoolean(raw.events_reader_ok ?? raw.eventsReaderOk),
    wifiConnected: resolveWifiConnected(raw, wifiProfile, rssiDbm),
    wifiSsid: raw.wifi_ssid ?? raw.wifiSsid ?? null,
    wifiProfile,
    rssiDbm,
    sdReady: parseBoolean(raw.sd_ready ?? raw.sdReady),
    sdQueueLen: parseInteger(raw.sd_queue_len ?? raw.sdQueueLen),
    ramQueueLen: parseInteger(raw.ram_queue_len ?? raw.ramQueueLen),
    queueLen: parseInteger(raw.queue_len ?? raw.queueLen),
    freeHeapBytes: parseInteger(raw.free_heap_bytes ?? raw.freeHeapBytes),
    zone: serializeZone(zone, row.lat, row.lon)
  }
}

async function getLatestRtkPoint(deviceId) {
  return prisma.rtkTelemetry.findFirst({
    where: deviceId ? { deviceId } : undefined,
    orderBy: [
      { timestamp: 'desc' },
      { id: 'desc' }
    ]
  })
}

async function buildLatestResponse(deviceId) {
  const latest = await getLatestRtkPoint(deviceId)
  if (!latest) {
    return buildEmptyRtkResponse(deviceId)
  }

  const zones = await loadActiveZones()
  return serializeRtkTelemetry(latest, zones)
}

async function findLatestZonePoint(zoneId, seconds, deviceId) {
  const zone = await prisma.storageZone.findUnique({ where: { id: zoneId } })
  if (!zone) {
    return { missingZone: true }
  }

  const since = new Date(Date.now() - seconds * 1000)
  const rows = await prisma.rtkTelemetry.findMany({
    where: {
      timestamp: { gte: since },
      ...(deviceId ? { deviceId } : {})
    },
    orderBy: [
      { timestamp: 'desc' },
      { id: 'desc' }
    ],
    take: MAX_ZONE_SCAN_ROWS
  })

  const point = rows.find((row) => Boolean(detectZoneObject(row.lat, row.lon, [zone]))) || null

  return {
    missingZone: false,
    zone,
    point
  }
}

router.post('/', async (req, res) => {
  try {
    const payloads = extractRtkPayloads(req.body)

    if (!payloads.length) {
      return res.status(400).json({ error: 'Empty RTK buffer' })
    }

    if (payloads.length > MAX_BULK_RTK_PACKETS) {
      return res.status(413).json({
        error: `RTK buffer is too large: max ${MAX_BULK_RTK_PACKETS} packets`
      })
    }

    const packets = payloads.map((payload) => normalizeRtkPacket(payload || {}))
    const invalidPacket = packets
      .map((packet, index) => ({ index, error: validateRtkPacket(packet) }))
      .find((item) => item.error)

    if (invalidPacket) {
      return res.status(400).json({
        error: invalidPacket.error,
        index: invalidPacket.index
      })
    }

    if (packets.length === 1) {
      const created = await prisma.rtkTelemetry.create({
        data: packets[0]
      })

      return res.status(201).json({ status: 'ok', id: created.id, count: 1 })
    }

    const created = await prisma.rtkTelemetry.createMany({
      data: packets
    })

    res.status(201).json({ status: 'ok', count: created.count })
  } catch (error) {
    console.error('[Ошибка POST /api/telemetry/rtk]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/current', authenticate, requireReadAccess, async (req, res) => {
  try {
    const deviceId = getRequestedDeviceId(req)
    const latest = await buildLatestResponse(deviceId)
    res.json(latest)
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/rtk/current]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/latest', authenticate, requireReadAccess, async (req, res) => {
  try {
    const deviceId = getRequestedDeviceId(req)
    const latest = await buildLatestResponse(deviceId)
    res.json(latest)
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/rtk/latest]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/recent', authenticate, requireReadAccess, async (req, res) => {
  try {
    const deviceId = getRequestedDeviceId(req)
    const limit = parseLimit(req.query.limit, DEFAULT_RECENT_LIMIT)
    const zones = await loadActiveZones()
    const rows = await prisma.rtkTelemetry.findMany({
      where: deviceId ? { deviceId } : undefined,
      orderBy: [
        { timestamp: 'desc' },
        { id: 'desc' }
      ],
      take: limit
    })
    res.json(rows.map((row) => serializeRtkTelemetry(row, zones)))
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/rtk/recent]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/history', authenticate, requireReadAccess, async (req, res) => {
  try {
    const deviceId = getRequestedDeviceId(req)
    const limit = parseLimit(req.query.limit, DEFAULT_HISTORY_LIMIT, { max: MAX_RTK_HISTORY_LIMIT })
    const zones = await loadActiveZones()
    const rows = await prisma.rtkTelemetry.findMany({
      where: deviceId ? { deviceId } : undefined,
      orderBy: [
        { timestamp: 'desc' },
        { id: 'desc' }
      ],
      take: limit
    })
    res.json(rows.map((row) => serializeRtkTelemetry(row, zones)))
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/rtk/history]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/zone/latest', authenticate, requireReadAccess, async (req, res) => {
  try {
    const zoneId = parseInteger(req.query.zoneId ?? req.query.zone_id)
    const seconds = parseLimit(req.query.seconds, DEFAULT_ZONE_SECONDS)
    const deviceId = getRequestedDeviceId(req)

    if (!zoneId || zoneId <= 0) {
      return res.status(400).json({ error: 'Некорректный zoneId' })
    }

    const boundedSeconds = Math.min(Math.max(seconds, 1), MAX_ZONE_SECONDS)
    const result = await findLatestZonePoint(zoneId, boundedSeconds, deviceId)

    if (result.missingZone) {
      return res.status(404).json({ error: 'Зона не найдена' })
    }

    res.json({
      found: Boolean(result.point),
      zone: serializeZone(result.zone, result.point?.lat ?? null, result.point?.lon ?? null),
      searchedSeconds: boundedSeconds,
      point: serializeRtkTelemetry(result.point, [result.zone])
    })
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/rtk/zone/latest]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/zone/current', authenticate, requireReadAccess, async (req, res) => {
  try {
    const zoneId = parseInteger(req.query.zoneId ?? req.query.zone_id)
    const seconds = parseLimit(req.query.seconds, DEFAULT_ZONE_SECONDS)
    const deviceId = getRequestedDeviceId(req)

    if (!zoneId || zoneId <= 0) {
      return res.status(400).json({ error: 'Некорректный zoneId' })
    }

    const boundedSeconds = Math.min(Math.max(seconds, 1), MAX_ZONE_SECONDS)
    const result = await findLatestZonePoint(zoneId, boundedSeconds, deviceId)

    if (result.missingZone) {
      return res.status(404).json({ error: 'Зона не найдена' })
    }

    res.json({
      found: Boolean(result.point),
      zone: serializeZone(result.zone, result.point?.lat ?? null, result.point?.lon ?? null),
      searchedSeconds: boundedSeconds,
      point: serializeRtkTelemetry(result.point, [result.zone])
    })
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/rtk/zone/current]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/admin/latest', authenticate, requireAdmin, async (req, res) => {
  try {
    const deviceId = getRequestedDeviceId(req)
    const latest = await buildLatestResponse(deviceId)
    res.json(latest)
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/rtk/admin/latest]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/admin/history', authenticate, requireAdmin, async (req, res) => {
  try {
    const deviceId = getRequestedDeviceId(req)
    const limit = parseLimit(req.query.limit, DEFAULT_HISTORY_LIMIT, { max: MAX_RTK_HISTORY_LIMIT })
    const zones = await loadActiveZones()
    const rows = await prisma.rtkTelemetry.findMany({
      where: deviceId ? { deviceId } : undefined,
      orderBy: [
        { timestamp: 'desc' },
        { id: 'desc' }
      ],
      take: limit
    })
    res.json(rows.map((row) => serializeRtkTelemetry(row, zones)))
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/rtk/admin/history]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

async function clearRtkTrack(req, res) {
  try {
    const deviceId = getRequestedDeviceId(req)
    const before = req.query.before ? parseTimestamp(req.query.before) : null

    if (req.query.before && !before) {
      return res.status(400).json({ error: 'Некорректный параметр before' })
    }

    const where = {
      ...(deviceId ? { deviceId } : {}),
      ...(before ? { timestamp: { lte: before } } : {})
    }

    const deleted = await prisma.rtkTelemetry.deleteMany({
      where: Object.keys(where).length ? where : undefined
    })

    res.json({
      status: 'ok',
      count: deleted.count,
      scope: {
        deviceId: deviceId || null,
        before: before ? before.toISOString() : null
      }
    })
  } catch (error) {
    console.error('[Ошибка DELETE /api/telemetry/rtk/admin/truncate]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

router.delete('/admin/truncate', authenticate, requireWriteAccess, clearRtkTrack)
router.delete('/admin/clear-track', authenticate, requireWriteAccess, clearRtkTrack)

export default router

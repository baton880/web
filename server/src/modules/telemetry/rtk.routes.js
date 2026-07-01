import { Router } from 'express'
import prisma from '../../database.js'
import { authenticate, requireAdmin, requireReadAccess, requireWriteAccess } from '../../middleware/auth.js'
import { calculateHaversine, detectZoneObject } from '../../../../module-1/geo.js'
import { getTelemetrySettings } from './telemetry-settings.js'
import { getHostTrackClearSince } from './track-state-store.js'
import telemetryProcessor from '../../../../module-3/telemetryProcessor.js'

const router = Router()
const DEFAULT_RECENT_LIMIT = 5
const DEFAULT_HISTORY_LIMIT = 20
const MAX_RTK_HISTORY_LIMIT = 5000
const DEFAULT_ZONE_SECONDS = 30
const MAX_ZONE_SECONDS = 3600
const MAX_ZONE_SCAN_ROWS = 5000
const MAX_BULK_RTK_PACKETS = 1000
const CURRENT_RTK_SCAN_LIMIT = 200
const STALE_BUFFERED_RTK_MAX_LAG_MS = 10 * 60 * 1000

function parseTimestamp(value, fallback = new Date()) {
  if (!value) return fallback
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function hasRawValue(value) {
  return value !== undefined && value !== null && value !== ''
}

const PVT_SECTION_KEYS = ['pvt', 'navPvt', 'nav_pvt', 'position']
const RELPOS_SECTION_KEYS = ['relposned', 'relPosNed', 'rel_pos_ned', 'relpos', 'relPos', 'baseline']

function readRawValue(raw, keys, sectionKeys = []) {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }

  for (const key of keys) {
    if (hasRawValue(raw[key])) {
      return raw[key]
    }
  }

  for (const sectionKey of sectionKeys) {
    const section = raw[sectionKey]
    if (!section || typeof section !== 'object') {
      continue
    }

    for (const key of keys) {
      if (hasRawValue(section[key])) {
        return section[key]
      }
    }
  }

  return undefined
}

function parseRawNumber(raw, keys, sectionKeys = []) {
  return parseNumber(readRawValue(raw, keys, sectionKeys))
}

function parseRawInteger(raw, keys, sectionKeys = []) {
  return parseInteger(readRawValue(raw, keys, sectionKeys))
}

function parseRawBoolean(raw, keys, sectionKeys = []) {
  return parseBoolean(readRawValue(raw, keys, sectionKeys))
}

function normalizeDegrees(value) {
  if (value === null) {
    return null
  }

  const normalized = value % 360
  return normalized < 0 ? normalized + 360 : normalized
}

function applyHeadingOffset(heading, offsetDeg = 0) {
  if (heading === null || heading === undefined) {
    return null
  }

  const parsedHeading = Number(heading)
  if (!Number.isFinite(parsedHeading)) {
    return null
  }

  const parsedOffset = Number(offsetDeg)
  return normalizeDegrees(parsedHeading + (Number.isFinite(parsedOffset) ? parsedOffset : 0))
}

function parseHeadingDegrees(raw) {
  const degrees = parseRawNumber(raw, [
    'heading',
    'course',
    'azimuth',
    'headingDeg',
    'heading_deg',
    'baselineHeadingDeg',
    'baseline_heading_deg',
    'relPosHeadingDeg',
    'rel_pos_heading_deg'
  ], RELPOS_SECTION_KEYS)

  if (degrees !== null) {
    return normalizeDegrees(degrees)
  }

  const ubxHeading = parseRawNumber(raw, ['relPosHeading', 'rel_pos_heading'], RELPOS_SECTION_KEYS)
  return ubxHeading !== null ? normalizeDegrees(ubxHeading / 100000) : null
}

function parseHeadingAccuracyDegrees(raw) {
  const degrees = parseRawNumber(raw, [
    'headingAccDeg',
    'heading_acc_deg',
    'baselineHeadingAccDeg',
    'baseline_heading_acc_deg',
    'accHeadingDeg',
    'acc_heading_deg'
  ], RELPOS_SECTION_KEYS)

  if (degrees !== null) {
    return degrees
  }

  const ubxAccuracy = parseRawNumber(raw, ['accHeading', 'acc_heading'], RELPOS_SECTION_KEYS)
  return ubxAccuracy !== null ? ubxAccuracy / 100000 : null
}

function parseBaselineMeters(raw) {
  const meters = parseRawNumber(raw, [
    'baselineM',
    'baseline_m',
    'baselineMeters',
    'baseline_meters',
    'relPosLengthM',
    'rel_pos_length_m'
  ], RELPOS_SECTION_KEYS)

  if (meters !== null) {
    return meters
  }

  const centimeters = parseRawNumber(raw, [
    'baselineCm',
    'baseline_cm',
    'relPosLengthCm',
    'rel_pos_length_cm',
    'relPosLength',
    'rel_pos_length'
  ], RELPOS_SECTION_KEYS)

  return centimeters !== null ? centimeters / 100 : null
}

function parseBaselineAccuracyMeters(raw) {
  const meters = parseRawNumber(raw, [
    'baselineAccM',
    'baseline_acc_m',
    'baselineAccuracyM',
    'baseline_accuracy_m',
    'accLengthM',
    'acc_length_m'
  ], RELPOS_SECTION_KEYS)

  if (meters !== null) {
    return meters
  }

  const millimeters = parseRawNumber(raw, ['baselineAccMm', 'baseline_acc_mm', 'accLengthMm', 'acc_length_mm'], RELPOS_SECTION_KEYS)
  if (millimeters !== null) {
    return millimeters / 1000
  }

  const ubxAccuracy = parseRawNumber(raw, ['accLength', 'acc_length'], RELPOS_SECTION_KEYS)
  return ubxAccuracy !== null ? ubxAccuracy * 0.0001 : null
}

function parseRelativePositionMeters(raw, axis) {
  const lowerAxis = axis.toLowerCase()
  const meters = parseRawNumber(raw, [
    `relPos${axis}M`,
    `rel_pos_${lowerAxis}_m`
  ], RELPOS_SECTION_KEYS)

  if (meters !== null) {
    return meters
  }

  const centimeters = parseRawNumber(raw, [
    `relPos${axis}`,
    `rel_pos_${lowerAxis}`
  ], RELPOS_SECTION_KEYS)

  return centimeters !== null ? centimeters / 100 : null
}

function parseRelativeAccuracyMeters(raw, axis) {
  const lowerAxis = axis.toLowerCase()
  const meters = parseRawNumber(raw, [
    `acc${axis}M`,
    `acc_${lowerAxis}_m`
  ], RELPOS_SECTION_KEYS)

  if (meters !== null) {
    return meters
  }

  const millimeters = parseRawNumber(raw, [
    `acc${axis}Mm`,
    `acc_${lowerAxis}_mm`
  ], RELPOS_SECTION_KEYS)

  if (millimeters !== null) {
    return millimeters / 1000
  }

  const ubxAccuracy = parseRawNumber(raw, [`acc${axis}`, `acc_${lowerAxis}`], RELPOS_SECTION_KEYS)
  return ubxAccuracy !== null ? ubxAccuracy * 0.0001 : null
}

function parseRelPosFlags(raw) {
  return parseRawInteger(raw, ['relPosFlags', 'rel_pos_flags', 'flags'], RELPOS_SECTION_KEYS)
}

function mapCarrierSolution(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const numeric = Number(value)
  if (Number.isInteger(numeric)) {
    if (numeric === 1) return 'float'
    if (numeric === 2) return 'fixed'
    return 'none'
  }

  const normalized = String(value).trim().toLowerCase()
  if (normalized === '1' || normalized === 'float' || normalized === 'rtk_float') return 'float'
  if (normalized === '2' || normalized === 'fixed' || normalized === 'rtk_fixed') return 'fixed'
  if (normalized === '0' || normalized === 'none' || normalized === 'no_fix') return 'none'
  return normalized || null
}

function parseRelPosCarrierSolution(raw, flags = null) {
  const explicit = readRawValue(raw, [
    'relPosCarrierSolution',
    'rel_pos_carrier_solution',
    'carrierSolution',
    'carrier_solution',
    'carrSoln',
    'carr_soln'
  ], RELPOS_SECTION_KEYS)

  if (hasRawValue(explicit)) {
    return mapCarrierSolution(explicit)
  }

  return flags !== null ? mapCarrierSolution((flags >> 3) & 0x03) : null
}

function parseRelPosValid(raw, flags = null) {
  const explicit = parseRawBoolean(raw, ['relPosValid', 'rel_pos_valid'], RELPOS_SECTION_KEYS)
  if (explicit !== null) {
    return explicit
  }

  return flags !== null ? Boolean(flags & (1 << 2)) : null
}

function parseRelPosHeadingValid(raw, flags = null) {
  const explicit = parseRawBoolean(raw, [
    'relPosHeadingValid',
    'rel_pos_heading_valid',
    'headingValid',
    'heading_valid'
  ], RELPOS_SECTION_KEYS)

  if (explicit !== null) {
    return explicit
  }

  return flags !== null ? Boolean(flags & (1 << 8)) : null
}

function hasRelPosData(raw) {
  return readRawValue(raw, [
    'baselineM',
    'baseline_m',
    'relPosLength',
    'rel_pos_length',
    'relPosHeading',
    'rel_pos_heading',
    'relPosHeadingDeg',
    'rel_pos_heading_deg',
    'accHeading',
    'acc_heading',
    'flags'
  ], RELPOS_SECTION_KEYS) !== undefined
}

function normalizePacketType(value) {
  if (!hasRawValue(value)) {
    return null
  }

  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, '_')
  if (!normalized) {
    return null
  }

  if (['rtk_mb', 'moving_base', 'pvt_relposned', 'rtk_moving_base', 'relposned'].includes(normalized)) {
    return 'moving_base'
  }

  if (['rtk_pvt', 'nav_pvt', 'pvt'].includes(normalized)) {
    return 'pvt'
  }

  return normalized
}

function resolvePacketType(raw) {
  const explicit = normalizePacketType(readRawValue(raw, [
    'packetType',
    'packet_type',
    'type',
    'messageType',
    'message_type',
    'msgType',
    'msg_type'
  ]))

  if (explicit) {
    return explicit
  }

  return hasRelPosData(raw) ? 'moving_base' : 'pvt'
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
  const mapped = mapQualityLabel(quality)
  if (mapped) {
    return mapped
  }

  return hasRawValue(rawLabel) ? String(rawLabel).trim() || null : null
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

function sanitizeAccuracyMeters(value) {
  const parsed = parseNumber(value)

  if (parsed === null) {
    return null
  }

  if (parsed < 0 || parsed > 10000) {
    return null
  }

  return parsed
}

function sanitizeRawGga(value) {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeRtkPacket(raw, settings = {}, receivedAt = new Date()) {
  const timestamp = parseTimestamp(readRawValue(raw, ['timestamp', 'time', 'datetime'], PVT_SECTION_KEYS), receivedAt)
  const lat = parseRawNumber(raw, ['lat', 'latitude'], PVT_SECTION_KEYS)
  const lon = parseRawNumber(raw, ['lon', 'lng', 'longitude'], PVT_SECTION_KEYS)
  const qualityNumberRaw = readRawValue(raw, ['quality', 'fixQuality', 'fix_quality', 'solution'], PVT_SECTION_KEYS)
  const quality = parseInteger(qualityNumberRaw)
  const qualityLabelRaw = readRawValue(raw, ['quality_label', 'rtkQuality', 'rtk_quality', 'solution_label'], PVT_SECTION_KEYS)
  const resolvedQualityLabel = resolveQualityLabel(qualityLabelRaw, quality)
  const fixTypeRaw = readRawValue(raw, ['fixType', 'fix_type', 'mode', 'solutionType', 'solution_type'], PVT_SECTION_KEYS) ?? resolvedQualityLabel ?? qualityNumberRaw
  const heading = applyHeadingOffset(parseHeadingDegrees(raw), settings.rtkHeadingOffsetDeg)

  return {
    deviceId: String(readRawValue(raw, ['deviceId', 'device_id']) || 'host_01').trim() || 'host_01',
    timestamp,
    lat,
    lon,
    rtkQuality: resolvedQualityLabel,
    rtkAge: parseRawNumber(raw, ['corr_age_s', 'corrAgeS', 'rtkAge', 'rtk_age', 'age', 'ageSeconds', 'age_seconds'], PVT_SECTION_KEYS),
    speed: parseRawNumber(raw, ['speed', 'speedKmh', 'speed_kmh'], PVT_SECTION_KEYS),
    course: heading,
    supplyVoltage: parseRawNumber(raw, ['supplyVoltage', 'supply_voltage', 'voltage'], PVT_SECTION_KEYS),
    satellites: parseRawInteger(raw, ['satellites', 'gpsSatellites', 'gps_satellites', 'sats', 'sat_count'], PVT_SECTION_KEYS),
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
    packetType: null,
    rtkQuality: null,
    rtkAge: null,
    speed: null,
    course: null,
    heading: null,
    headingAccDeg: null,
    baselineM: null,
    baselineAccM: null,
    relPosValid: null,
    relPosHeadingValid: null,
    relPosCarrierSolution: null,
    relPosFlags: null,
    relPosN: null,
    relPosE: null,
    relPosD: null,
    accN: null,
    accE: null,
    accD: null,
    itow: null,
    relPosItow: null,
    supplyVoltage: null,
    satellites: null,
    fixType: null,
    valid: null,
    quality: null,
    qualityLabel: null,
    qualityFlag: null,
    hacc: null,
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
  if (!zone || isBarnZone(zone, linkedBarnZoneIds)) return false
  const zoneType = normalizeZoneType(zone.zoneType)
  if (!zoneType) return true
  return zoneType === 'STORAGE' || zoneType === 'FEED' || zoneType === 'LOADING'
}

async function loadActiveLoadingZones() {
  const [zones, groupsWithZones] = await Promise.all([
    loadActiveZones(),
    prisma.livestockGroup.findMany({
      where: { storageZoneId: { not: null } },
      select: { storageZoneId: true }
    })
  ])
  const linkedBarnZoneIds = new Set(
    groupsWithZones
      .map((group) => Number(group.storageZoneId))
      .filter((zoneId) => Number.isInteger(zoneId) && zoneId > 0)
  )

  return zones.filter((zone) => isLoadingZone(zone, linkedBarnZoneIds))
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

async function updateLoaderZoneScoreboard(rawPayloads, packets, settings) {
  const zones = await loadActiveLoadingZones()
  if (!zones.length) return

  packets.forEach((packet, index) => {
    const raw = rawPayloads[index] || {}
    const relPosFlags = parseRelPosFlags(raw)
    const hostDeviceId = resolveScoreboardDeviceId(raw)

    telemetryProcessor.processLoaderPacket({
      deviceId: hostDeviceId,
      hostDeviceId,
      timestamp: packet.timestamp,
      lat: packet.lat,
      lon: packet.lon,
      speedKmh: packet.speed,
      headingDeg: packet.course,
      headingAccDeg: parseHeadingAccuracyDegrees(raw),
      relPosValid: parseRelPosValid(raw, relPosFlags),
      relPosHeadingValid: parseRelPosHeadingValid(raw, relPosFlags)
    }, zones, settings, { deviceId: hostDeviceId })
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
    loadingWallSide: zone.loadingWallSide ?? null,
    loadingNormalDeg: zone.loadingNormalDeg ?? null,
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

function parseTimestampMs(value) {
  if (!value) return NaN
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : NaN
}

function isStaleBufferedRtkRow(row) {
  if (!row) return false

  const sourceMs = parseTimestampMs(row.timestamp)
  const receivedMs = parseTimestampMs(row.createdAt)
  if (!Number.isFinite(sourceMs) || !Number.isFinite(receivedMs)) {
    return false
  }

  const lagMs = receivedMs - sourceMs
  if (lagMs <= STALE_BUFFERED_RTK_MAX_LAG_MS) {
    return false
  }

  const raw = parseRawPayload(row.rawPayload) || {}
  const wifiProfile = String(readRawValue(raw, ['wifi_profile', 'wifiProfile']) ?? '').trim().toLowerCase()
  const sdQueueLen = parseRawInteger(raw, ['sd_queue_len', 'sdQueueLen'])
  const queueLen = parseRawInteger(raw, ['queue_len', 'queueLen'])

  return wifiProfile === 'disconnected'
    || (sdQueueLen !== null && sdQueueLen > 0)
    || (queueLen !== null && queueLen > 0)
}

function serializeRtkTelemetry(row, zones = [], settings = {}, options = {}) {
  if (!row) return null

  const raw = parseRawPayload(row.rawPayload) || {}
  const zone = detectZoneObject(row.lat, row.lon, zones)
  const responseTimestamp = options.useReceivedAtAsTimestamp && row.createdAt
    ? row.createdAt
    : row.timestamp
  const quality = parseRawInteger(raw, ['quality', 'fixQuality', 'fix_quality', 'solution'], PVT_SECTION_KEYS)
  const qualityLabel = resolveQualityLabel(
    readRawValue(raw, ['quality_label', 'rtkQuality', 'rtk_quality'], PVT_SECTION_KEYS) ?? row.rtkQuality,
    quality
  )
  const rssiDbm = parseRawInteger(raw, ['rssi_dbm', 'rssiDbm'])
  const wifiProfile = readRawValue(raw, ['wifi_profile', 'wifiProfile']) ?? null
  const valid = parseRawBoolean(raw, ['valid'], PVT_SECTION_KEYS) ?? (quality != null ? quality > 0 : null)
  const relPosFlags = parseRelPosFlags(raw)
  const rawHeading = parseHeadingDegrees(raw)
  const heading = rawHeading !== null
    ? applyHeadingOffset(rawHeading, settings.rtkHeadingOffsetDeg)
    : parseNumber(row.course)
  const headingAccDeg = parseHeadingAccuracyDegrees(raw)
  const baselineM = parseBaselineMeters(raw)
  const baselineAccM = parseBaselineAccuracyMeters(raw)

  return {
    ...row,
    timestamp: responseTimestamp,
    sourceTimestamp: row.timestamp,
    receivedAt: row.createdAt ?? null,
    bufferedStale: isStaleBufferedRtkRow(row),
    packetType: resolvePacketType(raw),
    valid,
    quality,
    qualityLabel,
    qualityFlag: qualityLabel,
    speedKmh: row.speed,
    heading,
    course: heading,
    headingAccDeg,
    baselineM,
    baselineAccM,
    relPosValid: parseRelPosValid(raw, relPosFlags),
    relPosHeadingValid: parseRelPosHeadingValid(raw, relPosFlags),
    relPosCarrierSolution: parseRelPosCarrierSolution(raw, relPosFlags),
    relPosFlags,
    relPosN: parseRelativePositionMeters(raw, 'N'),
    relPosE: parseRelativePositionMeters(raw, 'E'),
    relPosD: parseRelativePositionMeters(raw, 'D'),
    accN: parseRelativeAccuracyMeters(raw, 'N'),
    accE: parseRelativeAccuracyMeters(raw, 'E'),
    accD: parseRelativeAccuracyMeters(raw, 'D'),
    itow: parseRawInteger(raw, ['iTOW', 'itow'], PVT_SECTION_KEYS),
    relPosItow: parseRawInteger(raw, ['iTOW', 'itow'], RELPOS_SECTION_KEYS),
    hacc: sanitizeAccuracyMeters(readRawValue(raw, ['hacc', 'hAcc', 'hacc_m', 'hAccM'], PVT_SECTION_KEYS)),
    corrAgeS: parseRawNumber(raw, ['corr_age_s', 'corrAgeS', 'rtkAge', 'rtk_age'], PVT_SECTION_KEYS) ?? row.rtkAge,
    rawGga: sanitizeRawGga(readRawValue(raw, ['raw_gga', 'rawGga'], PVT_SECTION_KEYS) ?? null),
    eventsReaderOk: parseRawBoolean(raw, ['events_reader_ok', 'eventsReaderOk']),
    wifiConnected: resolveWifiConnected(raw, wifiProfile, rssiDbm),
    wifiSsid: readRawValue(raw, ['wifi_ssid', 'wifiSsid']) ?? null,
    wifiProfile,
    rssiDbm,
    sdReady: parseRawBoolean(raw, ['sd_ready', 'sdReady']),
    sdQueueLen: parseRawInteger(raw, ['sd_queue_len', 'sdQueueLen']),
    ramQueueLen: parseRawInteger(raw, ['ram_queue_len', 'ramQueueLen']),
    queueLen: parseRawInteger(raw, ['queue_len', 'queueLen']),
    freeHeapBytes: parseRawInteger(raw, ['free_heap_bytes', 'freeHeapBytes']),
    zone: serializeZone(zone, row.lat, row.lon)
  }
}

async function getLatestRtkPoint(deviceId) {
  const rows = await prisma.rtkTelemetry.findMany({
    where: deviceId ? { deviceId } : undefined,
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ],
    take: CURRENT_RTK_SCAN_LIMIT
  })

  return rows.find((row) => !isStaleBufferedRtkRow(row)) || null
}

async function buildLatestResponse(deviceId) {
  const latest = await getLatestRtkPoint(deviceId)
  if (!latest) {
    return buildEmptyRtkResponse(deviceId)
  }

  const [zones, settings] = await Promise.all([
    loadActiveZones(),
    getTelemetrySettings(prisma)
  ])
  return serializeRtkTelemetry(latest, zones, settings, { useReceivedAtAsTimestamp: true })
}

async function buildVisibleRtkTrackWhere(deviceId) {
  const clearSince = await getHostTrackClearSince(prisma)

  return {
    ...(deviceId ? { deviceId } : {}),
    ...(clearSince ? { createdAt: { gt: clearSince } } : {})
  }
}

function orderByReceivedDesc() {
  return [
    { createdAt: 'desc' },
    { id: 'desc' }
  ]
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

export async function processRtkTelemetryBody(body, receivedAt = new Date()) {
  const payloads = extractRtkPayloads(body)

  if (!payloads.length) {
    return {
      status: 'ok',
      id: null,
      count: 0,
      received: 0,
      accepted: 0,
      dropped: 0,
      validationErrors: [],
      warning: 'Empty RTK buffer acknowledged'
    }
  }

  const processPayloads = payloads.slice(0, MAX_BULK_RTK_PACKETS)
  const overLimitDropped = Math.max(0, payloads.length - processPayloads.length)
  if (overLimitDropped > 0) {
    console.warn('[RTK ingest warning]: oversized buffer acknowledged, dropping tail', {
      received: payloads.length,
      processed: processPayloads.length,
      dropped: overLimitDropped
    })
  }

  const settings = await getTelemetrySettings(prisma)
  const entries = processPayloads.map((payload, index) => {
    const packet = normalizeRtkPacket(payload || {}, settings, receivedAt)
    return {
      index,
      payload: payload || {},
      packet,
      error: validateRtkPacket(packet)
    }
  })
  const validEntries = entries.filter((entry) => !entry.error)
  const invalidEntries = entries.filter((entry) => entry.error)

  if (invalidEntries.length > 0) {
    console.warn('[RTK ingest warning]: invalid packets acknowledged and dropped', {
      dropped: invalidEntries.length,
      examples: invalidEntries.slice(0, 5).map((entry) => ({
        index: entry.index,
        error: entry.error
      }))
    })
  }

  if (validEntries.length > 0) {
    try {
      await updateLoaderZoneScoreboard(
        validEntries.map((entry) => entry.payload),
        validEntries.map((entry) => entry.packet),
        settings
      )
    } catch (scoreboardError) {
      console.warn('[RTK zone scoreboard warning]:', scoreboardError)
    }
  }

  let createdCount = 0
  let createdId = null
  const packets = validEntries.map((entry) => entry.packet)

  if (packets.length === 1) {
    const created = await prisma.rtkTelemetry.create({
      data: packets[0]
    })
    createdCount = 1
    createdId = created.id
  } else if (packets.length > 1) {
    const created = await prisma.rtkTelemetry.createMany({
      data: packets
    })
    createdCount = created.count
  }

  return {
    status: 'ok',
    id: createdId,
    count: createdCount,
    received: payloads.length,
    accepted: createdCount,
    dropped: invalidEntries.length + overLimitDropped,
    validationErrors: invalidEntries.slice(0, 5).map((entry) => ({
      index: entry.index,
      error: entry.error
    }))
  }
}

export function handleRtkTelemetryPost(req, res) {
  const receivedAt = new Date()

  res.status(201).end()

  setImmediate(() => {
    processRtkTelemetryBody(req.body, receivedAt)
      .then((result) => {
        if (result.accepted > 0 || result.dropped > 0) {
          console.log('[RTK ingest background]:', {
            received: result.received,
            accepted: result.accepted,
            dropped: result.dropped
          })
        }
      })
      .catch((error) => {
        console.error('[Ошибка POST /api/telemetry/rtk background]:', error)
      })
  })
}

router.post('/', handleRtkTelemetryPost)

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
    const [zones, settings] = await Promise.all([
      loadActiveZones(),
      getTelemetrySettings(prisma)
    ])
    const where = await buildVisibleRtkTrackWhere(deviceId)
    const rows = await prisma.rtkTelemetry.findMany({
      where: Object.keys(where).length ? where : undefined,
      orderBy: orderByReceivedDesc(),
      take: limit
    })
    res.json(rows.map((row) => serializeRtkTelemetry(row, zones, settings)))
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/rtk/recent]:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/history', authenticate, requireReadAccess, async (req, res) => {
  try {
    const deviceId = getRequestedDeviceId(req)
    const limit = parseLimit(req.query.limit, DEFAULT_HISTORY_LIMIT, { max: MAX_RTK_HISTORY_LIMIT })
    const [zones, settings] = await Promise.all([
      loadActiveZones(),
      getTelemetrySettings(prisma)
    ])
    const where = await buildVisibleRtkTrackWhere(deviceId)
    const rows = await prisma.rtkTelemetry.findMany({
      where: Object.keys(where).length ? where : undefined,
      orderBy: orderByReceivedDesc(),
      take: limit
    })
    res.json(rows.map((row) => serializeRtkTelemetry(row, zones, settings)))
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
    const [result, settings] = await Promise.all([
      findLatestZonePoint(zoneId, boundedSeconds, deviceId),
      getTelemetrySettings(prisma)
    ])

    if (result.missingZone) {
      return res.status(404).json({ error: 'Зона не найдена' })
    }

    res.json({
      found: Boolean(result.point),
      zone: serializeZone(result.zone, result.point?.lat ?? null, result.point?.lon ?? null),
      searchedSeconds: boundedSeconds,
      point: serializeRtkTelemetry(result.point, [result.zone], settings)
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
    const [result, settings] = await Promise.all([
      findLatestZonePoint(zoneId, boundedSeconds, deviceId),
      getTelemetrySettings(prisma)
    ])

    if (result.missingZone) {
      return res.status(404).json({ error: 'Зона не найдена' })
    }

    res.json({
      found: Boolean(result.point),
      zone: serializeZone(result.zone, result.point?.lat ?? null, result.point?.lon ?? null),
      searchedSeconds: boundedSeconds,
      point: serializeRtkTelemetry(result.point, [result.zone], settings)
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
    const [zones, settings] = await Promise.all([
      loadActiveZones(),
      getTelemetrySettings(prisma)
    ])
    const where = await buildVisibleRtkTrackWhere(deviceId)
    const rows = await prisma.rtkTelemetry.findMany({
      where: Object.keys(where).length ? where : undefined,
      orderBy: orderByReceivedDesc(),
      take: limit
    })
    res.json(rows.map((row) => serializeRtkTelemetry(row, zones, settings)))
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

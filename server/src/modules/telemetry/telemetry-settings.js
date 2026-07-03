import prisma from '../../database.js'

export const TELEMETRY_SETTINGS_SINGLETON_ID = 1

export const DEFAULT_TELEMETRY_SETTINGS = {
  batchStartThresholdKg: 30,
  leftoverThresholdKg: 50,
  unloadDropThresholdKg: 200,
  unloadMinPeakKg: 400,
  unloadUpdateDeltaKg: 1,
  unloadWeightBufferKg: 50,
  emptyVehicleThresholdKg: 50,
  autoCloseZeroWeightKg: 10,
  autoCloseEmptyStreak: 5,
  autoCloseNegativeStreak: 3,
  modeUnloadDropHintKg: 30,
  modeLoadingDeltaHintKg: 5,
  anomalyThresholdKg: 200,
  anomalyConfirmDeltaKg: 40,
  anomalyConfirmPackets: 3,
  movementSpeedThresholdKmh: 3,
  movementConfirmPackets: 3,
  zoneChangeDebounceMs: 3000,
  nullZoneConfirmSeconds: 120,
  zoneChangeConfirmPackets: 2,
  zoneDwellScoreCapSeconds: 45,
  zoneEntryFrontBonus: 8,
  zoneEntryRearPenalty: 10,
  zoneEntryFrontAngleDeg: 75,
  zoneEntryRearAngleDeg: 120,
  squareHeadingScorePerSecond: 2,
  squareHeadingScoreCap: 30,
  squareHeadingMaxAngleDeg: 90,
  deviationPercentThreshold: 10,
  deviationMinKgThreshold: 10,
  rtkTrackResetTime: '03:00',
  rtkHeadingOffsetDeg: 0,
  weightCalibrationFactor: 1,
  loaderMaxDistanceMeters: 20,
  loaderOfflineTimeoutMinutes: 4
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

function isMissingColumnError(error) {
  return error?.code === 'P2022' || /no such column|does not exist/i.test(String(error?.message || ''))
}

async function getTelemetrySettingsFallback(db) {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM "TelemetrySettings" WHERE "id" = ${TELEMETRY_SETTINGS_SINGLETON_ID} LIMIT 1`
    )
    const row = Array.isArray(rows) ? rows[0] : null

    return row ? coerceTelemetrySettings(row) : { ...DEFAULT_TELEMETRY_SETTINGS }
  } catch (fallbackError) {
    console.warn('[TelemetrySettings] fallback read failed:', fallbackError?.message || fallbackError)
    return { ...DEFAULT_TELEMETRY_SETTINGS }
  }
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback
  }

  return parsed
}

function toBoundedInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback
  }

  return parsed
}

function normalizeTime(value, fallback) {
  if (typeof value !== 'string') {
    return fallback
  }

  const normalized = value.trim()
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
    return fallback
  }

  return normalized
}

function normalizeHeadingOffset(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < -360 || parsed > 360) {
    return fallback
  }

  return parsed
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function coerceTelemetrySettings(row = {}) {
  return {
    batchStartThresholdKg: toPositiveInteger(row.batchStartThresholdKg, DEFAULT_TELEMETRY_SETTINGS.batchStartThresholdKg),
    leftoverThresholdKg: toPositiveInteger(row.leftoverThresholdKg, DEFAULT_TELEMETRY_SETTINGS.leftoverThresholdKg),
    unloadDropThresholdKg: toPositiveInteger(row.unloadDropThresholdKg, DEFAULT_TELEMETRY_SETTINGS.unloadDropThresholdKg),
    unloadMinPeakKg: toPositiveInteger(row.unloadMinPeakKg, DEFAULT_TELEMETRY_SETTINGS.unloadMinPeakKg),
    unloadUpdateDeltaKg: toPositiveInteger(row.unloadUpdateDeltaKg, DEFAULT_TELEMETRY_SETTINGS.unloadUpdateDeltaKg),
    unloadWeightBufferKg: toPositiveInteger(row.unloadWeightBufferKg, DEFAULT_TELEMETRY_SETTINGS.unloadWeightBufferKg),
    emptyVehicleThresholdKg: toPositiveInteger(row.emptyVehicleThresholdKg, DEFAULT_TELEMETRY_SETTINGS.emptyVehicleThresholdKg),
    autoCloseZeroWeightKg: toPositiveInteger(row.autoCloseZeroWeightKg, DEFAULT_TELEMETRY_SETTINGS.autoCloseZeroWeightKg),
    autoCloseEmptyStreak: toPositiveInteger(row.autoCloseEmptyStreak, DEFAULT_TELEMETRY_SETTINGS.autoCloseEmptyStreak),
    autoCloseNegativeStreak: toPositiveInteger(row.autoCloseNegativeStreak, DEFAULT_TELEMETRY_SETTINGS.autoCloseNegativeStreak),
    modeUnloadDropHintKg: toPositiveInteger(row.modeUnloadDropHintKg, DEFAULT_TELEMETRY_SETTINGS.modeUnloadDropHintKg),
    modeLoadingDeltaHintKg: toPositiveInteger(row.modeLoadingDeltaHintKg, DEFAULT_TELEMETRY_SETTINGS.modeLoadingDeltaHintKg),
    anomalyThresholdKg: toPositiveInteger(row.anomalyThresholdKg, DEFAULT_TELEMETRY_SETTINGS.anomalyThresholdKg),
    anomalyConfirmDeltaKg: toPositiveInteger(row.anomalyConfirmDeltaKg, DEFAULT_TELEMETRY_SETTINGS.anomalyConfirmDeltaKg),
    anomalyConfirmPackets: toPositiveInteger(row.anomalyConfirmPackets, DEFAULT_TELEMETRY_SETTINGS.anomalyConfirmPackets),
    movementSpeedThresholdKmh: toPositiveInteger(row.movementSpeedThresholdKmh, DEFAULT_TELEMETRY_SETTINGS.movementSpeedThresholdKmh),
    movementConfirmPackets: toPositiveInteger(row.movementConfirmPackets, DEFAULT_TELEMETRY_SETTINGS.movementConfirmPackets),
    zoneChangeDebounceMs: toPositiveInteger(row.zoneChangeDebounceMs, DEFAULT_TELEMETRY_SETTINGS.zoneChangeDebounceMs),
    nullZoneConfirmSeconds: toPositiveInteger(row.nullZoneConfirmSeconds, DEFAULT_TELEMETRY_SETTINGS.nullZoneConfirmSeconds),
    zoneChangeConfirmPackets: toPositiveInteger(row.zoneChangeConfirmPackets, DEFAULT_TELEMETRY_SETTINGS.zoneChangeConfirmPackets),
    zoneDwellScoreCapSeconds: toPositiveInteger(row.zoneDwellScoreCapSeconds, DEFAULT_TELEMETRY_SETTINGS.zoneDwellScoreCapSeconds),
    zoneEntryFrontBonus: toNonNegativeInteger(row.zoneEntryFrontBonus, DEFAULT_TELEMETRY_SETTINGS.zoneEntryFrontBonus),
    zoneEntryRearPenalty: toNonNegativeInteger(row.zoneEntryRearPenalty, DEFAULT_TELEMETRY_SETTINGS.zoneEntryRearPenalty),
    zoneEntryFrontAngleDeg: toBoundedInteger(row.zoneEntryFrontAngleDeg, DEFAULT_TELEMETRY_SETTINGS.zoneEntryFrontAngleDeg, 1, 180),
    zoneEntryRearAngleDeg: toBoundedInteger(row.zoneEntryRearAngleDeg, DEFAULT_TELEMETRY_SETTINGS.zoneEntryRearAngleDeg, 1, 180),
    squareHeadingScorePerSecond: toNonNegativeInteger(row.squareHeadingScorePerSecond, DEFAULT_TELEMETRY_SETTINGS.squareHeadingScorePerSecond),
    squareHeadingScoreCap: toNonNegativeInteger(row.squareHeadingScoreCap, DEFAULT_TELEMETRY_SETTINGS.squareHeadingScoreCap),
    squareHeadingMaxAngleDeg: toBoundedInteger(row.squareHeadingMaxAngleDeg, DEFAULT_TELEMETRY_SETTINGS.squareHeadingMaxAngleDeg, 1, 180),
    deviationPercentThreshold: toPositiveInteger(row.deviationPercentThreshold, DEFAULT_TELEMETRY_SETTINGS.deviationPercentThreshold),
    deviationMinKgThreshold: toPositiveInteger(row.deviationMinKgThreshold, DEFAULT_TELEMETRY_SETTINGS.deviationMinKgThreshold),
    rtkTrackResetTime: normalizeTime(row.rtkTrackResetTime, DEFAULT_TELEMETRY_SETTINGS.rtkTrackResetTime),
    rtkHeadingOffsetDeg: normalizeHeadingOffset(row.rtkHeadingOffsetDeg, DEFAULT_TELEMETRY_SETTINGS.rtkHeadingOffsetDeg),
    weightCalibrationFactor: toPositiveNumber(row.weightCalibrationFactor, DEFAULT_TELEMETRY_SETTINGS.weightCalibrationFactor),
    loaderMaxDistanceMeters: toPositiveInteger(row.loaderMaxDistanceMeters, DEFAULT_TELEMETRY_SETTINGS.loaderMaxDistanceMeters),
    loaderOfflineTimeoutMinutes: toPositiveInteger(row.loaderOfflineTimeoutMinutes, DEFAULT_TELEMETRY_SETTINGS.loaderOfflineTimeoutMinutes),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  }
}

export async function getTelemetrySettings(db = prisma) {
  let row = null

  try {
    row = await db.telemetrySettings.findUnique({
      where: { id: TELEMETRY_SETTINGS_SINGLETON_ID }
    })
  } catch (error) {
    if (isMissingColumnError(error)) {
      console.warn('[TelemetrySettings] schema is missing a column, using available settings with defaults')
      return getTelemetrySettingsFallback(db)
    }

    throw error
  }

  if (!row) {
    return { ...DEFAULT_TELEMETRY_SETTINGS }
  }

  return coerceTelemetrySettings(row)
}

export function validateTelemetrySettingsInput(payload = {}, { partial = false } = {}) {
  const integerFields = [
    'batchStartThresholdKg',
    'leftoverThresholdKg',
    'unloadDropThresholdKg',
    'unloadMinPeakKg',
    'unloadUpdateDeltaKg',
    'unloadWeightBufferKg',
    'emptyVehicleThresholdKg',
    'autoCloseZeroWeightKg',
    'autoCloseEmptyStreak',
    'autoCloseNegativeStreak',
    'modeUnloadDropHintKg',
    'modeLoadingDeltaHintKg',
    'anomalyThresholdKg',
    'anomalyConfirmDeltaKg',
    'anomalyConfirmPackets',
    'movementSpeedThresholdKmh',
    'movementConfirmPackets',
    'zoneChangeDebounceMs',
    'nullZoneConfirmSeconds',
    'zoneChangeConfirmPackets',
    'zoneDwellScoreCapSeconds',
    'deviationPercentThreshold',
    'deviationMinKgThreshold',
    'loaderMaxDistanceMeters',
    'loaderOfflineTimeoutMinutes'
  ]
  const nonNegativeIntegerFields = [
    'zoneEntryFrontBonus',
    'zoneEntryRearPenalty',
    'squareHeadingScorePerSecond',
    'squareHeadingScoreCap'
  ]
  const boundedIntegerFields = [
    ['zoneEntryFrontAngleDeg', 1, 180],
    ['zoneEntryRearAngleDeg', 1, 180],
    ['squareHeadingMaxAngleDeg', 1, 180]
  ]
  const positiveNumberFields = [
    'weightCalibrationFactor'
  ]

  const data = {}

  for (const field of integerFields) {
    if (payload[field] === undefined) {
      if (!partial) {
        data[field] = DEFAULT_TELEMETRY_SETTINGS[field]
      }
      continue
    }

    const parsed = Number(payload[field])
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        error: `${field} должен быть положительным целым числом`
      }
    }

    data[field] = parsed
  }

  for (const field of nonNegativeIntegerFields) {
    if (payload[field] === undefined) {
      if (!partial) {
        data[field] = DEFAULT_TELEMETRY_SETTINGS[field]
      }
      continue
    }

    const parsed = Number(payload[field])
    if (!Number.isInteger(parsed) || parsed < 0) {
      return {
        error: `${field} должен быть целым числом не меньше 0`
      }
    }

    data[field] = parsed
  }

  for (const [field, min, max] of boundedIntegerFields) {
    if (payload[field] === undefined) {
      if (!partial) {
        data[field] = DEFAULT_TELEMETRY_SETTINGS[field]
      }
      continue
    }

    const parsed = Number(payload[field])
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      return {
        error: `${field} должен быть целым числом от ${min} до ${max}`
      }
    }

    data[field] = parsed
  }

  for (const field of positiveNumberFields) {
    if (payload[field] === undefined) {
      if (!partial) {
        data[field] = DEFAULT_TELEMETRY_SETTINGS[field]
      }
      continue
    }

    const parsed = Number(payload[field])
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return {
        error: `${field} должен быть положительным числом`
      }
    }

    data[field] = parsed
  }

  if (payload.rtkTrackResetTime === undefined) {
    if (!partial) {
      data.rtkTrackResetTime = DEFAULT_TELEMETRY_SETTINGS.rtkTrackResetTime
    }
  } else {
    const normalizedTime = normalizeTime(payload.rtkTrackResetTime, null)
    if (!normalizedTime) {
      return {
        error: 'rtkTrackResetTime должен быть в формате HH:mm'
      }
    }

    data.rtkTrackResetTime = normalizedTime
  }

  if (payload.rtkHeadingOffsetDeg === undefined) {
    if (!partial) {
      data.rtkHeadingOffsetDeg = DEFAULT_TELEMETRY_SETTINGS.rtkHeadingOffsetDeg
    }
  } else {
    const parsedOffset = Number(payload.rtkHeadingOffsetDeg)
    if (!Number.isFinite(parsedOffset) || parsedOffset < -360 || parsedOffset > 360) {
      return {
        error: 'rtkHeadingOffsetDeg должен быть числом от -360 до 360'
      }
    }

    data.rtkHeadingOffsetDeg = parsedOffset
  }

  return { data }
}

export async function upsertTelemetrySettings(payload = {}, db = prisma) {
  const validation = validateTelemetrySettingsInput(payload, { partial: true })
  if (validation.error) {
    throw new Error(validation.error)
  }

  return db.telemetrySettings.upsert({
    where: { id: TELEMETRY_SETTINGS_SINGLETON_ID },
    update: validation.data,
    create: {
      id: TELEMETRY_SETTINGS_SINGLETON_ID,
      ...DEFAULT_TELEMETRY_SETTINGS,
      ...validation.data
    }
  })
}

const CHECK_INTERVAL_MS = 60 * 1000
const DEFAULT_TIMEZONE = process.env.DATA_RETENTION_TIMEZONE || process.env.TELEMETRY_TIMEZONE || process.env.APP_TIMEZONE || 'Asia/Novosibirsk'
const DEFAULT_RUN_TIME = '03:20'
const BATCH_DELETE_CHUNK_SIZE = 500

export const DEFAULT_RETENTION_DAYS = Object.freeze({
  rawTelemetry: 14,
  batches: 45,
  deviceEvents: 90,
  resolvedTechnicalWarnings: 90,
  orphanViolations: 90
})

let schedulerTimer = null
let isTickRunning = false
let lastCleanupDayKey = null

function readBooleanEnv(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function readPositiveIntegerEnv(name, fallback, { min = 1, max = 3650 } = {}) {
  const parsed = Number(process.env[name])
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback
  }

  return parsed
}

function normalizeTime(value, fallback = DEFAULT_RUN_TIME) {
  if (typeof value !== 'string') {
    return fallback
  }

  const normalized = value.trim()
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
    return fallback
  }

  return normalized
}

function minutesFromTime(value) {
  const [hours, minutes] = normalizeTime(value).split(':').map(Number)
  return hours * 60 + minutes
}

function formatNowInTimezone(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  )

  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    timeKey: `${parts.hour}:${parts.minute}`,
    minutesFromStartOfDay: (Number(parts.hour) * 60) + Number(parts.minute)
  }
}

function buildCutoff(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

export function getRetentionPolicyFromEnv() {
  return {
    rawTelemetryDays: readPositiveIntegerEnv('DATA_RETENTION_RAW_TELEMETRY_DAYS', DEFAULT_RETENTION_DAYS.rawTelemetry),
    batchDays: readPositiveIntegerEnv('DATA_RETENTION_BATCH_DAYS', DEFAULT_RETENTION_DAYS.batches),
    deviceEventDays: readPositiveIntegerEnv('DATA_RETENTION_DEVICE_EVENT_DAYS', DEFAULT_RETENTION_DAYS.deviceEvents),
    resolvedTechnicalWarningDays: readPositiveIntegerEnv(
      'DATA_RETENTION_RESOLVED_TECHNICAL_WARNING_DAYS',
      DEFAULT_RETENTION_DAYS.resolvedTechnicalWarnings
    ),
    orphanViolationDays: readPositiveIntegerEnv('DATA_RETENTION_ORPHAN_VIOLATION_DAYS', DEFAULT_RETENTION_DAYS.orphanViolations)
  }
}

async function deleteOldBatches(prisma, cutoff) {
  const counts = {
    batchViolations: 0,
    batchIngredients: 0,
    batches: 0
  }

  for (;;) {
    const rows = await prisma.batch.findMany({
      where: {
        endTime: { lt: cutoff }
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH_DELETE_CHUNK_SIZE
    })

    if (!rows.length) {
      break
    }

    const batchIds = rows.map((row) => row.id)
    const [deletedViolations, deletedIngredients, deletedBatches] = await prisma.$transaction([
      prisma.violation.deleteMany({ where: { batchId: { in: batchIds } } }),
      prisma.batchIngredient.deleteMany({ where: { batchId: { in: batchIds } } }),
      prisma.batch.deleteMany({ where: { id: { in: batchIds } } })
    ])

    counts.batchViolations += deletedViolations.count
    counts.batchIngredients += deletedIngredients.count
    counts.batches += deletedBatches.count

    if (rows.length < BATCH_DELETE_CHUNK_SIZE) {
      break
    }
  }

  return counts
}

async function runSqliteMaintenance(prisma, totalDeleted) {
  const maintenance = {
    optimize: false,
    checkpoint: false,
    vacuum: false
  }

  if (totalDeleted <= 0) {
    return maintenance
  }

  try {
    await prisma.$queryRawUnsafe('PRAGMA optimize')
    maintenance.optimize = true
  } catch (error) {
    console.warn('[RETENTION] SQLite optimize failed:', error)
  }

  if (readBooleanEnv('DATA_RETENTION_SQLITE_CHECKPOINT', true)) {
    try {
      await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')
      maintenance.checkpoint = true
    } catch (error) {
      console.warn('[RETENTION] SQLite checkpoint failed:', error)
    }
  }

  if (readBooleanEnv('DATA_RETENTION_SQLITE_VACUUM', false)) {
    try {
      await prisma.$executeRawUnsafe('VACUUM')
      maintenance.vacuum = true
    } catch (error) {
      console.warn('[RETENTION] SQLite vacuum failed:', error)
    }
  }

  return maintenance
}

export async function runDataRetention(prisma, { now = new Date(), policy = getRetentionPolicyFromEnv() } = {}) {
  const rawTelemetryCutoff = buildCutoff(now, policy.rawTelemetryDays)
  const batchCutoff = buildCutoff(now, policy.batchDays)
  const deviceEventCutoff = buildCutoff(now, policy.deviceEventDays)
  const resolvedTechnicalWarningCutoff = buildCutoff(now, policy.resolvedTechnicalWarningDays)
  const orphanViolationCutoff = buildCutoff(now, policy.orphanViolationDays)

  const [deletedTelemetry, deletedRtkTelemetry, deletedDeviceEvents, deletedResolvedTechnicalWarnings, deletedOrphanViolations] =
    await prisma.$transaction([
      prisma.telemetry.deleteMany({ where: { timestamp: { lt: rawTelemetryCutoff } } }),
      prisma.rtkTelemetry.deleteMany({ where: { timestamp: { lt: rawTelemetryCutoff } } }),
      prisma.deviceEvent.deleteMany({ where: { timestamp: { lt: deviceEventCutoff } } }),
      prisma.technicalWarning.deleteMany({
        where: {
          status: 'RESOLVED',
          lastSeenAt: { lt: resolvedTechnicalWarningCutoff }
        }
      }),
      prisma.violation.deleteMany({
        where: {
          batchId: null,
          status: { in: ['CLOSED', 'RESOLVED'] },
          detectedAt: { lt: orphanViolationCutoff }
        }
      })
    ])

  const deletedBatchData = await deleteOldBatches(prisma, batchCutoff)
  const counts = {
    telemetry: deletedTelemetry.count,
    rtkTelemetry: deletedRtkTelemetry.count,
    deviceEvents: deletedDeviceEvents.count,
    resolvedTechnicalWarnings: deletedResolvedTechnicalWarnings.count,
    orphanViolations: deletedOrphanViolations.count,
    ...deletedBatchData
  }
  const totalDeleted = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0)
  const sqliteMaintenance = await runSqliteMaintenance(prisma, totalDeleted)

  return {
    policy,
    cutoffs: {
      rawTelemetry: rawTelemetryCutoff,
      batches: batchCutoff,
      deviceEvents: deviceEventCutoff,
      resolvedTechnicalWarnings: resolvedTechnicalWarningCutoff,
      orphanViolations: orphanViolationCutoff
    },
    counts,
    totalDeleted,
    sqliteMaintenance
  }
}

async function runDataRetentionTick(prisma) {
  if (isTickRunning) {
    return
  }

  if (!readBooleanEnv('DATA_RETENTION_ENABLED', true)) {
    return
  }

  const runTime = normalizeTime(process.env.DATA_RETENTION_RUN_TIME, DEFAULT_RUN_TIME)
  const nowDate = new Date()
  const now = formatNowInTimezone(nowDate, DEFAULT_TIMEZONE)
  const runMinute = minutesFromTime(runTime)

  if (now.minutesFromStartOfDay < runMinute) {
    return
  }

  if (lastCleanupDayKey === now.dayKey) {
    return
  }

  isTickRunning = true

  try {
    const result = await runDataRetention(prisma, { now: nowDate })
    lastCleanupDayKey = now.dayKey
    console.log(
      `[RETENTION] Daily cleanup complete (${runTime}, ${DEFAULT_TIMEZONE}), ` +
      `deleted=${result.totalDeleted}, policy=${JSON.stringify(result.policy)}, counts=${JSON.stringify(result.counts)}`
    )
  } catch (error) {
    console.error('[RETENTION] Daily cleanup failed:', error)
  } finally {
    isTickRunning = false
  }
}

export function startDataRetentionScheduler(prisma) {
  if (schedulerTimer) {
    return
  }

  if (!readBooleanEnv('DATA_RETENTION_ENABLED', true)) {
    console.log('[RETENTION] Scheduler disabled by DATA_RETENTION_ENABLED')
    return
  }

  void runDataRetentionTick(prisma)
  schedulerTimer = setInterval(() => {
    void runDataRetentionTick(prisma)
  }, CHECK_INTERVAL_MS)
}

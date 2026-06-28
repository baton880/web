import { DEFAULT_TELEMETRY_SETTINGS, getTelemetrySettings } from './telemetry-settings.js'
import { setHostTrackClearSince } from './track-state-store.js'

const CHECK_INTERVAL_MS = 60 * 1000
const DEFAULT_TIMEZONE = process.env.TELEMETRY_TIMEZONE || process.env.APP_TIMEZONE || 'Asia/Novosibirsk'

let schedulerTimer = null
let isTickRunning = false
let lastClearedDayKey = null

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

function normalizeResetTime(value) {
  if (typeof value !== 'string') {
    return DEFAULT_TELEMETRY_SETTINGS.rtkTrackResetTime
  }

  const normalized = value.trim()
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
    return DEFAULT_TELEMETRY_SETTINGS.rtkTrackResetTime
  }

  return normalized
}

async function runRtkTrackCleanupTick(prisma) {
  if (isTickRunning) {
    return
  }

  isTickRunning = true

  try {
    const telemetrySettings = await getTelemetrySettings(prisma)
    const resetTime = normalizeResetTime(telemetrySettings.rtkTrackResetTime)
    const now = formatNowInTimezone(new Date(), DEFAULT_TIMEZONE)

    if (now.timeKey !== resetTime) {
      return
    }

    if (lastClearedDayKey === now.dayKey) {
      return
    }

    const clearSince = await setHostTrackClearSince(prisma, new Date())
    lastClearedDayKey = now.dayKey

    console.log(
      `[TRACK] Daily visible track reset (${resetTime}, ${DEFAULT_TIMEZONE}), ` +
      `clearSince=${clearSince.toISOString()}`
    )
  } catch (error) {
    console.error('[TRACK] Daily visible track reset failed:', error)
  } finally {
    isTickRunning = false
  }
}

export function startRtkTrackScheduler(prisma) {
  if (schedulerTimer) {
    return
  }

  void runRtkTrackCleanupTick(prisma)
  schedulerTimer = setInterval(() => {
    void runRtkTrackCleanupTick(prisma)
  }, CHECK_INTERVAL_MS)
}

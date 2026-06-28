const CHECK_INTERVAL_MS = 60 * 1000
const TRACK_CLEANUP_OFFSET_MINUTES = 7 * 60
const TRACK_CLEANUP_TIME = '03:00'
import { setHostTrackClearSince } from './track-state-store.js'

let cleanupTimer = null
let isCleanupRunning = false
let lastCleanupDayKey = null

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatInFixedOffset(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000)

  return {
    dayKey: [
      shifted.getUTCFullYear(),
      pad2(shifted.getUTCMonth() + 1),
      pad2(shifted.getUTCDate())
    ].join('-'),
    timeKey: `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`
  }
}

export async function clearTelemetryTrack(prisma) {
  const clearSince = await setHostTrackClearSince(prisma, new Date())

  return {
    rtkCount: 0,
    totalCount: 0,
    clearSince
  }
}

export async function runTrackCleanupTick(prisma, now = new Date()) {
  if (isCleanupRunning) return null

  const zonedNow = formatInFixedOffset(now, TRACK_CLEANUP_OFFSET_MINUTES)

  if (zonedNow.timeKey !== TRACK_CLEANUP_TIME) return null
  if (lastCleanupDayKey === zonedNow.dayKey) return null

  isCleanupRunning = true

  try {
    const result = await clearTelemetryTrack(prisma)
    lastCleanupDayKey = zonedNow.dayKey
    console.log(
      `[TRACK CLEANUP] Track cleared for ${zonedNow.dayKey} ${TRACK_CLEANUP_TIME} UTC+7: ` +
      `clearSince=${result.clearSince.toISOString()}`
    )
    return result
  } catch (error) {
    console.error('[TRACK CLEANUP] Automatic track cleanup failed:', error)
    return null
  } finally {
    isCleanupRunning = false
  }
}

export function startTrackCleanupScheduler(prisma) {
  if (cleanupTimer) {
    return
  }

  void runTrackCleanupTick(prisma)
  cleanupTimer = setInterval(() => {
    void runTrackCleanupTick(prisma)
  }, CHECK_INTERVAL_MS)
}

import '../src/load-env.js'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const DEVICE_ID = process.env.RTK_JUMP_DEVICE_ID || 'rtk_jump_demo'

const now = Date.now()
const minutesAgo = (minutes) => new Date(now - minutes * 60 * 1000)

const demoPoints = [
  { minutesAgo: 11, lat: 53.341900, lon: 83.769400, speed: 1.4 },
  { minutesAgo: 10, lat: 53.342000, lon: 83.769520, speed: 1.5 },
  { minutesAgo: 9, lat: 53.342120, lon: 83.769650, speed: 1.6 },

  // Coordinate jump: only 10 seconds passed, but the point moved hundreds of meters.
  { secondsAgo: 530, lat: 53.345850, lon: 83.775150, speed: 92.0 },

  { minutesAgo: 8, lat: 53.345950, lon: 83.775300, speed: 1.7 },
  { minutesAgo: 7, lat: 53.346070, lon: 83.775440, speed: 1.6 },

  // Time jump: more than 45 seconds between points, with a visible distance gap.
  { minutesAgo: 5, lat: 53.347100, lon: 83.777000, speed: 0.8 },

  { minutesAgo: 4, lat: 53.347210, lon: 83.777150, speed: 1.1 },
  { minutesAgo: 3, lat: 53.347320, lon: 83.777300, speed: 1.0 },
  { minutesAgo: 2, lat: 53.347430, lon: 83.777450, speed: 1.2 },
]

function buildPayload(point, index) {
  return {
    deviceId: DEVICE_ID,
    timestamp: point.timestamp.toISOString(),
    lat: point.lat,
    lon: point.lon,
    quality: 4,
    valid: true,
    hacc: 0.012,
    vacc: 0.018,
    corr_age_s: 0.4,
    speed: point.speed,
    course: 48 + index,
    satellites: 22,
    wifi_profile: 'primary',
    rssi_dbm: -54,
    sd_ready: true,
    sd_queue_len: 2,
    ram_queue_len: 1,
    queue_len: 3,
    free_heap_bytes: 181248,
    demo: 'rtk-track-jumps',
  }
}

async function main() {
  const points = demoPoints.map((point) => ({
    ...point,
    timestamp: point.secondsAgo
      ? new Date(now - point.secondsAgo * 1000)
      : minutesAgo(point.minutesAgo),
  }))

  const existing = await prisma.rtkTelemetry.deleteMany({
    where: { deviceId: DEVICE_ID },
  })

  const data = points.map((point, index) => {
    const payload = buildPayload(point, index)

    return {
      deviceId: DEVICE_ID,
      timestamp: point.timestamp,
      lat: point.lat,
      lon: point.lon,
      rtkQuality: 'rtk_fixed',
      rtkAge: payload.corr_age_s,
      speed: point.speed,
      course: payload.course,
      supplyVoltage: 12.7,
      satellites: payload.satellites,
      fixType: 'rtk_fixed',
      rawPayload: JSON.stringify(payload),
    }
  })

  await prisma.rtkTelemetry.createMany({ data })

  console.log(`Seeded ${data.length} RTK demo points for ${DEVICE_ID}. Removed ${existing.count} old demo points.`)
  console.log('Open http://127.0.0.1:3000/ and inspect the loader track: dashed links mark coordinate/time jumps.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

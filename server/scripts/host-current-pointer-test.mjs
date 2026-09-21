import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scaleMeasurement } from '../src/modules/loader/scale-measurement.js'

const __filename = fileURLToPath(import.meta.url)
const serverRoot = path.resolve(path.dirname(__filename), '..')
const projectTempRoot = path.resolve(serverRoot, '..', '..', 'tmp')
fs.mkdirSync(projectTempRoot, { recursive: true })
const tempDir = fs.mkdtempSync(path.join(projectTempRoot, 'host-current-test-'))
const databasePath = path.join(tempDir, 'current.sqlite3')
const postgresTestUrl = process.env.TEST_POSTGRES_DATABASE_URL
if (postgresTestUrl && !new URL(postgresTestUrl).pathname.startsWith('/farm_test')) throw new Error('Isolated farm_test database required')
const databaseUrl = postgresTestUrl || `file:${databasePath.replaceAll('\\', '/')}`
const prismaCli = path.join(serverRoot, 'node_modules', 'prisma', 'build', 'index.js')

process.env.DATABASE_URL = databaseUrl
process.env.HOST_INGRESS_DATABASE_PATH = path.join(tempDir, 'host-ingress.sqlite3')
process.env.INGRESS_BACKEND = postgresTestUrl ? 'postgres' : 'sqlite'
process.env.RTK_BUFFER_REPLAY_ENABLED = '0'
process.env.DATA_RETENTION_ENABLED = 'false'

try {
  fs.closeSync(fs.openSync(databasePath, 'w'))
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', ...(postgresTestUrl ? ['--schema', 'prisma/postgresql/schema.prisma'] : [])], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit'
  })

  const [{ default: prisma }, { processHostTelemetryPacket, findCurrentTelemetry, findAdminHistoryTelemetry }, { getHostIngressStore }] = await Promise.all([
    import('../src/database.js'),
    import('../src/modules/telemetry/telemetry.routes.js'),
    import('../src/modules/telemetry/host-ingress-store.js')
  ])

  const deviceId = 'host-current-test'
  const streamId = 'stream-current-test'
  const makePacket = (timestamp, weight) => ({
    device_id: deviceId,
    timestamp,
    lat: 55.1,
    lon: 82.8,
    gps_valid: true,
    gps_satellites: 12,
    gps_age_s: 0.2,
    speed_kmh: 5,
    weight,
    raw: weight,
    weight_valid: true,
    gps_quality: 1,
    wifi_clients: [],
    cpu_temp_c: 50,
    lte_rssi_dbm: -70,
    lte_access_tech: 'LTE',
    events_reader_ok: true,
    scale_measurement: { version: 1, deviceId, calibrationId: 'cal-test', packetId: 'measurement-' + weight,
      timestampMs: new Date(timestamp).getTime(), weightKg: weight + .25, valid: true }
  })

  await processHostTelemetryPacket(
    makePacket('2026-07-18T07:00:00Z', 100),
    new Date('2026-07-18T07:10:00Z'),
    { deviceId, streamId, packetId: 1, isLive: false }
  )
  const liveResult = await processHostTelemetryPacket(
    makePacket('2026-07-18T07:00:04Z', 120),
    new Date('2026-07-18T07:10:04Z'),
    { deviceId, streamId, packetId: 3, isLive: true }
  )
  await processHostTelemetryPacket(
    makePacket('2026-07-18T07:00:02Z', 110),
    new Date('2026-07-18T07:10:06Z'),
    { deviceId, streamId, packetId: 2, isLive: false }
  )

  // A delayed duplicate must not move the pointer backwards in one stream,
  // even if an upstream bug were to mark it live again.
  await processHostTelemetryPacket(
    makePacket('2026-07-18T07:00:00Z', 100),
    new Date('2026-07-18T07:10:08Z'),
    { deviceId, streamId, packetId: 1, isLive: true }
  )

  const current = await prisma.deviceCurrentTelemetry.findUnique({
    where: { deviceId },
    include: { telemetry: true }
  })
  assert.ok(current)
  assert.equal(current.telemetryId, liveResult.id)
  assert.equal(current.sourcePacketId, 3)
  assert.equal(current.telemetry.timestamp.toISOString(), '2026-07-18T07:00:04.000Z')
  assert.equal(current.telemetry.weight, 120)
  assert.equal(scaleMeasurement(current.telemetry).weightKg, 120.25, 'Persisted source measurement survives processing')
  assert.equal(current.telemetry.gpsAgeS, 0.2)

  await processHostTelemetryPacket(
    makePacket('2026-07-18T06:59:00Z', 90),
    new Date('2026-07-18T07:10:09Z'),
    { deviceId, streamId: 'replacement-stream', packetId: 1, isLive: false }
  )
  const currentAfterHistoricalStream = await prisma.deviceCurrentTelemetry.findUnique({
    where: { deviceId },
    include: { telemetry: true }
  })
  assert.equal(currentAfterHistoricalStream.telemetryId, liveResult.id)
  assert.equal(currentAfterHistoricalStream.telemetry.timestamp.toISOString(), '2026-07-18T07:00:04.000Z')

  await getHostIngressStore().enqueueBatch({
    deviceId,
    streamId: 'rebooted-stream',
    livePacketId: 1,
    packets: [{ packetId: 1, payload: makePacket('2026-07-18T06:58:00Z', 80) }]
  }, new Date('2026-07-18T07:10:09.500Z'))
  const currentAfterHistoricalAccepted = await findCurrentTelemetry(deviceId)
  assert.equal(currentAfterHistoricalAccepted.id, liveResult.id)
  assert.equal(currentAfterHistoricalAccepted.timestamp.toISOString(), '2026-07-18T07:00:04.000Z')

  await getHostIngressStore().enqueueBatch({
    deviceId,
    streamId,
    livePacketId: 4,
    packets: [{ packetId: 4, payload: makePacket('2026-07-18T07:00:06Z', 130) }]
  }, new Date('2026-07-18T07:10:10Z'))
  const acceptedCurrent = await findCurrentTelemetry(deviceId)
  assert.equal(acceptedCurrent.id, null)
  assert.equal(acceptedCurrent.sourcePacketId, 4)
  assert.equal(acceptedCurrent.weight, 130)
  assert.equal(acceptedCurrent.pipelineStatus, 'accepted')
  assert.equal(scaleMeasurement(acceptedCurrent).weightKg, 130.25, 'Accepted inbox keeps source measurement before processing')

  const adminHistory = await findAdminHistoryTelemetry({ limit: 20, requestedDeviceId: deviceId })
  assert.equal(adminHistory[0].sourcePacketId, 4)
  assert.equal(adminHistory[0].weight, 130)
  assert.equal(adminHistory[0].pipelineStatus, 'pending')
  assert.equal(adminHistory.filter((row) => row.sourcePacketId === 3).length, 1, 'processed ingress rows must be deduplicated')

  getHostIngressStore().close()
  await prisma.$disconnect()
  console.log('Host current pointer test passed')
} finally {
  await (await import('../src/modules/telemetry/ingress-postgres-pool.js')).closeIngressPool()
  fs.rmSync(tempDir, { recursive: true, force: true })
}

import '../src/load-env.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import jwt from 'jsonwebtoken'
import clientModule from '../generated/postgresql-client/index.js'
if (process.env.ALLOW_STAGING_LOAD !== 'yes' || !['/farm_staging','/farm_stage2_20260919'].includes(new URL(process.env.DATABASE_URL).pathname)) throw Error('Only the explicit farm_staging load target is supported')
const db = new clientModule.PrismaClient()
const duration = Number(process.env.LOAD_SECONDS || 60), devices = 20
const stream = randomUUID(), ids = Array.from({ length: devices }, (_, i) => `load-${stream}-${i}`)
const base = process.env.LOAD_BASE_URL || (new URL(process.env.DATABASE_URL).pathname === '/farm_stage2_20260919' ? 'http://127.0.0.1:3103' : 'http://127.0.0.1:3101')
if (!['http://127.0.0.1:3101','http://127.0.0.1:3103','http://127.0.0.1:3104'].includes(base)) throw Error('Only isolated loopback staging ports allowed')
const stats = { writeMs: [], readMs: [], errors: [], accepted: 0 }
const sent = new Map(ids.map(id => [id, 0]))
try {
  const admin = await db.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true, role: true } })
  const token = jwt.sign(admin, process.env.JWT_SECRET, { expiresIn: '10m' })
  const end = performance.now() + duration * 1000
  const readers = ids.map(async deviceId => {
    while (performance.now() < end) {
      const start = performance.now()
      try {
        const response = await fetch(`${base}/api/loader/weight?deviceId=${deviceId}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
        await response.arrayBuffer()
        if (response.status !== 200) stats.errors.push(`read:${response.status}`)
      } catch (e) { stats.errors.push(`read:${e.name}`) }
      stats.readMs.push(performance.now() - start)
      await sleep(Math.max(0, 500 - (performance.now() - start)))
    }
  })
  const writers = ids.map(async deviceId => {
    while (performance.now() < end) {
      const start = performance.now(), packetId = sent.get(deviceId) + 1
      try {
        const response = await fetch(`${base}/api/telemetry/host/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ protocol_version: 1, device_id: deviceId, stream_id: stream, live_packet_id: packetId,
            packets: [{ packet_id: packetId, payload: { device_id: deviceId, timestamp: new Date().toISOString(), lat: 55.1, lon: 82.8,
              gps_valid: true, gps_satellites: 12, gps_age_s: 0.1, speed_kmh: 0, weight: 0, raw_weight: 0, weight_valid: true } }] }) })
        const body = await response.json()
        if (response.status !== 202 || !body.acked_packet_ids?.includes(packetId)) stats.errors.push(`write:${response.status}`)
        else { sent.set(deviceId, packetId); stats.accepted++ }
      } catch (e) { stats.errors.push(`write:${e.name}`) }
      stats.writeMs.push(performance.now() - start)
      await sleep(Math.max(0, 1000 - (performance.now() - start)))
    }
  })
  await Promise.all([...readers, ...writers])
  const drainStart = performance.now()
  let processed = 0
  do {
    processed = await db.telemetry.count({ where: { sourceStreamId: stream } })
    if (processed >= stats.accepted) break
    await sleep(500)
  } while (performance.now() - drainStart < 120000)
  const percentile = a => a.sort((x,y) => x-y)[Math.floor((a.length-1)*0.95)]
  const result = { duration, devices, accepted: stats.accepted, processed, reads: stats.readMs.length,
    writeP95Ms: percentile(stats.writeMs), readP95Ms: percentile(stats.readMs), drainSeconds: (performance.now()-drainStart)/1000, errors: stats.errors }
  console.log(JSON.stringify(result))
  assert.equal(stats.errors.length, 0)
  assert.equal(processed, stats.accepted, 'Every acknowledged packet must be processed once')
  for (const deviceId of ids) {
    const current = await db.deviceCurrentTelemetry.findUnique({ where: { deviceId } })
    assert.equal(current?.sourcePacketId, sent.get(deviceId), 'Current points to the latest source packet')
  }
  assert.ok(result.drainSeconds < 10, 'Calculation backlog drains within 10 seconds')
  assert.ok(result.writeP95Ms < 200, 'ACK p95 < 200 ms')
  assert.ok(result.readP95Ms < 500, 'Current p95 < 500 ms')
  console.log('PASS 20 HOST devices at 1 Hz + 20 tablets at 2 Hz, complete drain and correct current pointers')
} finally { await db.$disconnect() }

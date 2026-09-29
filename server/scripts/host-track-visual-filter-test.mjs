import assert from 'node:assert/strict'

await import('../../frontend/js/host-track-visual-filter.js')

const filter = globalThis.HostTrackVisualFilter?.filter
assert.equal(typeof filter, 'function')

const origin = { lat: 52.42718, lon: 85.70212 }
const timestamp = (seconds) => new Date(Date.parse('2026-08-24T00:00:00Z') + seconds * 1000).toISOString()
const point = (seconds, northMeters = 0, options = {}) => ({
  id: seconds,
  timestamp: timestamp(seconds),
  lat: origin.lat + northMeters / 111320,
  lon: origin.lon,
  gpsValid: options.gpsValid ?? true,
  gpsAgeS: options.gpsAgeS ?? 0.1,
  gpsSatellites: options.gpsSatellites ?? 12,
  speedKmh: options.speedKmh ?? 5
})

const stable = filter([point(0), point(2, 2), point(4, 4)])
assert.equal(stable.points.length, 3)
assert.equal(stable.points[0].visualGapBefore, false)

const afterReportedSpeedSpike = filter([
  point(0), point(2, 2), point(4, 4),
  point(6, 100, { speedKmh: 80 }),
  point(8, 6), point(10, 8), point(12, 10)
])
assert.deepEqual(afterReportedSpeedSpike.points.map((row) => row.source.id), [0, 2, 4, 8, 10, 12])
assert.equal(afterReportedSpeedSpike.points[3].visualGapBefore, true)
assert.equal(afterReportedSpeedSpike.stats.rejectedReportedSpeed, 1)

const afterLowSatelliteFix = filter([
  point(0), point(2, 2), point(4, 4),
  point(6, 5, { gpsSatellites: 5 }),
  point(8, 6), point(10, 8), point(12, 10)
])
assert.equal(afterLowSatelliteFix.stats.rejectedSatellites, 1)
assert.equal(afterLowSatelliteFix.points[3].visualGapBefore, true)

const impliedJump = filter([
  point(0), point(2, 2), point(4, 4),
  point(6, 150, { speedKmh: 3, gpsSatellites: 12 }),
  point(8, 6), point(10, 8), point(12, 10)
])
assert.equal(impliedJump.stats.rejectedImpliedSpeed, 1)
assert.deepEqual(impliedJump.points.map((row) => row.source.id), [0, 2, 4, 8, 10, 12])

const roadGap = filter([
  point(0), point(2, 2), point(4, 4),
  point(6, 0, { gpsValid: false, gpsSatellites: 0, speedKmh: 0 }),
  point(124, 300, { speedKmh: 10, gpsSatellites: 8 }),
  point(126, 305, { speedKmh: 10, gpsSatellites: 8 }),
  point(128, 310, { speedKmh: 10, gpsSatellites: 8 })
])
assert.equal(roadGap.points.length, 6)
assert.equal(roadGap.points[3].visualGapBefore, true)
assert.ok(globalThis.HostTrackVisualFilter.calculateImpliedSpeedKmh(roadGap.points[2], roadGap.points[3]) < 30)

// Reversed API history and out-of-order DB ids must follow source packets.
const twoHz = Array.from({ length: 12 }, (_, i) => ({
  ...point(Math.floor(i / 2), i * 1.5),
  id: 100 - i, deviceId: 'host', sourceStreamId: 'stream', sourcePacketId: i,
  receivedAt: timestamp(100),
}))
const ordered = filter([...twoHz].reverse())
assert.equal(ordered.points.length, twoHz.length)
assert.deepEqual(ordered.points.map(p => p.source.sourcePacketId), twoHz.map(p => p.sourcePacketId))
assert.equal(ordered.stats.rejectedImpliedSpeed, 0)
assert.equal(ordered.stats.recoveryCount, 0)
assert.deepEqual(ordered.points.map(p => p.timestampMs), twoHz.map(p => Date.parse(p.timestamp)))

// Non-admin history has no stream identity; receivedAt preserves packet order.
const recent = twoHz.map((p, i) => ({ ...p, sourceStreamId: undefined, sourcePacketId: undefined, receivedAt: timestamp(i * 0.5) }))
assert.deepEqual(filter([...recent].reverse()).points.map(p => p.source.id), recent.map(p => p.id))

const sameSecondJump = twoHz.map(p => ({ ...p }))
sameSecondJump[5].lat += 150 / 111320
const jumpResult = filter(sameSecondJump)
assert.ok(!jumpResult.points.some(p => p.source.sourcePacketId === 5))
assert.equal(jumpResult.stats.rejectedImpliedSpeed, 1)
assert.equal(jumpResult.stats.recoveryCount, 1)

// Future precise source timestamps keep their real elapsed time.
assert.equal(filter([point(0), point(0.5, 1.5), point(1, 3), point(1.01, 5)]).stats.rejectedImpliedSpeed, 1)
console.log('Host visual track filter tests passed')

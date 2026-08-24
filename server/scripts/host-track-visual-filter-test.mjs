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

console.log('Host visual track filter tests passed')

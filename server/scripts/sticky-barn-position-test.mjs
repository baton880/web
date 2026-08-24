import assert from 'node:assert/strict'
import {
  findLastUsableHostPosition,
  getZoneByCoordinatesWithinRadius,
  getZoneCenterCoordinates,
  hasUsableHostCoordinates
} from '../src/modules/telemetry/telemetry-helpers.js'

assert.equal(hasUsableHostCoordinates({ lat: 52.4, lon: 85.7, gpsValid: true, gpsAgeS: 1 }), true)
assert.equal(hasUsableHostCoordinates({ lat: 0, lon: 0, gpsValid: false, gpsAgeS: null }), false)
assert.equal(hasUsableHostCoordinates({ lat: 52.4, lon: 85.7, gpsValid: false, gpsAgeS: 1 }), false)
assert.equal(hasUsableHostCoordinates({ lat: 52.4, lon: 85.7, gpsValid: true, gpsAgeS: 4 }), false)

const center = getZoneCenterCoordinates({
  lat: 1,
  lon: 1,
  polygonCoords: JSON.stringify([[52, 85], [52, 87], [54, 87], [54, 85]])
})
assert.deepEqual(center, { lat: 53, lon: 86 })

const circularBarn = { id: 1, name: 'Barn', lat: 52, lon: 85, radius: 10, shapeType: 'CIRCLE' }
const pointFourMetersOutside = { lat: 52 + 14 / 111320, lon: 85 }
assert.equal(
  getZoneByCoordinatesWithinRadius(pointFourMetersOutside.lat, pointFourMetersOutside.lon, [circularBarn], 5)?.id,
  circularBarn.id
)
assert.equal(
  getZoneByCoordinatesWithinRadius(pointFourMetersOutside.lat, pointFourMetersOutside.lon, [circularBarn], 3),
  null
)

const queriedRows = [
  { id: 3, deviceId: 'host', timestamp: new Date('2026-08-24T00:00:04Z'), lat: 52.4, lon: 85.7, gpsValid: false, gpsAgeS: null },
  { id: 2, deviceId: 'host', timestamp: new Date('2026-08-24T00:00:02Z'), lat: 52.4, lon: 85.7, gpsValid: true, gpsAgeS: 2 }
]
const prisma = {
  telemetry: {
    findMany: async (query) => {
      assert.equal(query.where.deviceId, 'host')
      assert.equal(query.take, 20)
      return queriedRows
    }
  }
}
const last = await findLastUsableHostPosition(prisma, {
  deviceId: 'host',
  referenceTime: new Date('2026-08-24T00:00:06Z'),
  maxAgeMs: 30 * 60 * 1000
})
assert.equal(last.id, 2)

console.log('Sticky barn position helpers test passed')

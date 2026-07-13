import assert from 'node:assert/strict'

import { detectZoneWithinRadius, distanceToZoneMeters } from '../../module-1/geo.js'

const strawZone = {
  id: 22,
  name: 'Солома',
  ingredient: 'Солома',
  shapeType: 'SQUARE',
  lat: 52.42909675,
  lon: 85.70790675,
  radius: 20,
  polygonCoords: '[[52.4291614,85.7076321],[52.4291794,85.7081437],[52.4290488,85.7081858],[52.4290141,85.7076277]]'
}

const batch80HostPoint = { lat: 52.42919831666666, lon: 85.70825341666666 }
const distance = distanceToZoneMeters(batch80HostPoint.lat, batch80HostPoint.lon, strawZone)
assert.ok(distance > 0 && distance < 20, `expected point near straw boundary, got ${distance}m`)
assert.equal(
  detectZoneWithinRadius(batch80HostPoint.lat, batch80HostPoint.lon, [strawZone], 20)?.name,
  'Солома'
)
assert.equal(detectZoneWithinRadius(batch80HostPoint.lat, batch80HostPoint.lon, [strawZone], 4), null)

const circleZone = { name: 'Circle', shapeType: 'CIRCLE', lat: 52.43, lon: 85.70, radius: 20 }
const nearCircle = { lat: 52.4303, lon: 85.70 }
assert.equal(detectZoneWithinRadius(nearCircle.lat, nearCircle.lon, [circleZone], 20)?.name, 'Circle')

console.log(`PASS host zone intersection radius (${distance.toFixed(1)}m to straw boundary)`)

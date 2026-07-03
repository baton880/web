import assert from 'node:assert/strict'

import { TelemetryProcessor } from '../../module-3/telemetryProcessor.js'

const settings = {
  batchStartThresholdKg: 30,
  movementSpeedThresholdKmh: 3,
  movementConfirmPackets: 3,
  zoneChangeDebounceMs: 3000,
  zoneChangeConfirmPackets: 2,
  nullZoneConfirmSeconds: 120
}

const loadingZone = {
  id: 1,
  name: 'Silo',
  ingredient: 'Silage',
  lat: 52.43,
  lon: 85.70,
  radius: 30,
  active: true
}

const outside = { lat: 52.431, lon: 85.701 }
const inside = { lat: 52.43, lon: 85.70 }

function packet(timestamp, point, weight, speedKmh = 0, deviceId = 'motion-test') {
  return {
    deviceId,
    timestamp: new Date(timestamp).toISOString(),
    lat: point.lat,
    lon: point.lon,
    speedKmh,
    weight,
    weightValid: true,
    gpsValid: true,
    gpsSatellites: 12
  }
}

function collectActions(processor, packets, zones = []) {
  const actions = []
  for (const item of packets) {
    const result = processor.processPacket(item, zones, settings)
    actions.push(...(result.dbActions || []))
  }
  return actions
}

function runCase(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

runCase('moving weight bounce outside loading zones does not start a batch', () => {
  const processor = new TelemetryProcessor()
  const actions = collectActions(processor, [
    packet('2026-07-02T00:00:00.000Z', outside, 0, 0),
    packet('2026-07-02T00:00:03.000Z', outside, 50, 6),
    packet('2026-07-02T00:00:06.000Z', outside, 52, 6),
    packet('2026-07-02T00:00:09.000Z', outside, 49, 6),
    packet('2026-07-02T00:00:12.000Z', outside, 48, 6)
  ])

  assert.deepEqual(actions, [])
})

runCase('unknown drift outside loading zones is not flushed when movement starts', () => {
  const processor = new TelemetryProcessor()
  const actions = collectActions(processor, [
    packet('2026-07-02T00:01:00.000Z', outside, -3000, 0),
    packet('2026-07-02T00:01:03.000Z', outside, -1000, 0),
    packet('2026-07-02T00:01:06.000Z', outside, 5, 0),
    packet('2026-07-02T00:01:09.000Z', outside, 35, 0),
    packet('2026-07-02T00:01:12.000Z', outside, 58, 0),
    packet('2026-07-02T00:01:15.000Z', outside, 57, 6),
    packet('2026-07-02T00:01:18.000Z', outside, 56, 6),
    packet('2026-07-02T00:01:21.000Z', outside, 55, 6)
  ])

  assert.deepEqual(actions, [])
})

runCase('zero-speed packet immediately leaves moving state', () => {
  const processor = new TelemetryProcessor()
  const deviceId = 'motion-state-test'
  processor.processPacket(packet('2026-07-02T00:02:00.000Z', outside, 0, 0, deviceId), [], settings)
  processor.processPacket(packet('2026-07-02T00:02:03.000Z', outside, 40, 3, deviceId), [], settings)
  processor.processPacket(packet('2026-07-02T00:02:06.000Z', outside, 45, 3, deviceId), [], settings)
  processor.processPacket(packet('2026-07-02T00:02:09.000Z', outside, 50, 3, deviceId), [], settings)

  assert.equal(processor.getState(deviceId).isMoving, true)

  processor.processPacket(packet('2026-07-02T00:02:12.000Z', outside, 80, 0, deviceId), [], settings)

  assert.equal(processor.getState(deviceId).isMoving, false)
})

runCase('real loading in a confirmed zone is recorded after motion settles', () => {
  const processor = new TelemetryProcessor()
  const actions = collectActions(processor, [
    packet('2026-07-02T00:03:00.000Z', inside, 100, 0),
    packet('2026-07-02T00:03:04.000Z', inside, 100, 0),
    packet('2026-07-02T00:03:08.000Z', inside, 165, 0),
    packet('2026-07-02T00:03:12.000Z', inside, 165, 0),
    packet('2026-07-02T00:03:15.000Z', outside, 164, 6),
    packet('2026-07-02T00:03:18.000Z', outside, 164, 6),
    packet('2026-07-02T00:03:21.000Z', outside, 164, 6),
    packet('2026-07-02T00:03:24.000Z', outside, 170, 0)
  ], [loadingZone])

  assert.deepEqual(
    actions.map((action) => action.type),
    ['START_BATCH', 'ADD_INGREDIENT']
  )
  assert.equal(actions[1].ingredientName, 'Silage')
  assert.equal(actions[1].actualWeight, 70)
})

runCase('single in-zone weight spike is only a candidate and does not create a component', () => {
  const processor = new TelemetryProcessor()
  const actions = collectActions(processor, [
    packet('2026-07-02T00:04:00.000Z', inside, 100, 0),
    packet('2026-07-02T00:04:04.000Z', inside, 100, 0),
    packet('2026-07-02T00:04:08.000Z', inside, 165, 0),
    packet('2026-07-02T00:04:12.000Z', inside, 101, 0),
    packet('2026-07-02T00:04:15.000Z', outside, 101, 6),
    packet('2026-07-02T00:04:18.000Z', outside, 101, 6),
    packet('2026-07-02T00:04:21.000Z', outside, 101, 6)
  ], [loadingZone])

  assert.deepEqual(actions, [])
})

runCase('two stable in-zone growth packets confirm loading start', () => {
  const processor = new TelemetryProcessor()
  const actions = collectActions(processor, [
    packet('2026-07-02T00:05:00.000Z', inside, 100, 0),
    packet('2026-07-02T00:05:04.000Z', inside, 100, 0),
    packet('2026-07-02T00:05:08.000Z', inside, 160, 0),
    packet('2026-07-02T00:05:12.000Z', inside, 165, 0),
    packet('2026-07-02T00:05:15.000Z', outside, 165, 6),
    packet('2026-07-02T00:05:18.000Z', outside, 165, 6),
    packet('2026-07-02T00:05:21.000Z', outside, 165, 6),
    packet('2026-07-02T00:05:24.000Z', outside, 165, 0)
  ], [loadingZone])

  assert.deepEqual(
    actions.map((action) => action.type),
    ['START_BATCH', 'ADD_INGREDIENT']
  )
  assert.equal(actions[1].actualWeight, 65)
  assert.equal(actions[1].startTime, '2026-07-02T00:05:08.000Z')
})

console.log('PASS motion filter suite')

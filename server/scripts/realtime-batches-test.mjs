import assert from 'node:assert/strict'
import { TelemetryProcessor } from '../../module-3/telemetryProcessor.js'
import { newRealtimeState, reduceRealtimePacket } from '../src/modules/batches/realtime-processor-adapter.js'
import { realtimeContext } from '../src/modules/batches/realtime-batch-service.js'
const start = Date.parse('2026-10-01T00:00:00Z')
const zone = { id: 1, name: 'Силос', ingredient: 'Силос', lat: 52, lon: 85, radius: 30, zoneType: 'STORAGE' }
const context = { loadingZones: [zone], barn: true }
const packets = Array.from({ length: 100 }, (_, i) => ({ deviceId: 'test', timestamp: new Date(start + i * 1000),
  weight: i < 10 ? 0 : i < 30 ? 500 : i < 65 ? 1000 : 0, rawWeight: -9000,
  weightValid: true, lat: 52, lon: 85, speedKmh: 0, sourceStreamId: 'test', sourcePacketId: i }))
function run(rows, initial = newRealtimeState()) {
  let state = initial; const actions = []; const processorActions = []
  for (const packet of rows) {
    const result = reduceRealtimePacket(state, packet, context)
    state = result.state; actions.push(...result.actions); processorActions.push(...result.processorActions || [])
  }
  return { state, actions, processorActions }
}
const complete = run(packets)
const legacy = new TelemetryProcessor()
const expected = packets.flatMap(packet => legacy.processPacket(packet, [zone], {}, {
  suppressLoading: true, skipZoneVisit: true, allowVisitedZoneIngredient: false,
  preferCurrentZoneIngredient: false, hostLat: packet.lat, hostLon: packet.lon,
  hostForceIngredientName: null, expectedIngredients: [] }).dbActions)
assert.deepEqual(complete.processorActions, expected, 'all transitions come from the existing TelemetryProcessor')
assert.equal(complete.actions.filter(a => a.type === 'start').length, 1)
assert.deepEqual(complete.actions.filter(a => a.type === 'load').map(a => a.weight), [500, 500])
assert.equal(complete.actions.filter(a => a.type === 'end').length, 1, 'loading/barn overlap remains supported')
const prefix = run(packets.slice(0, 40))
const restored = run(packets.slice(40), JSON.parse(JSON.stringify(prefix.state)))
assert.deepEqual([...prefix.actions, ...restored.actions], complete.actions, 'durable restart parity')
assert.deepEqual(prefix.actions, complete.actions.filter(a => a.confirmedAt <= start + 39 * 1000), 'future data does not replace saved facts')
const late = reduceRealtimePacket(prefix.state, packets[0], context)
assert.deepEqual(late.state, prefix.state)
assert.equal(late.actions.length, 0)
const calibration = reduceRealtimePacket({ ...prefix.state, calibrationId: 'old' },
  { ...packets[40], weight: 0, calibrationId: 'new' }, context)
assert.equal(calibration.ignored, 'calibration_changed')
assert.ok(calibration.actions.every(action => action.type === 'quality'), 'a calibration reset cannot become a load/unload event')
assert.ok(calibration.state.active, 'manual review preserves the existing batch')
const sameSecond = reduceRealtimePacket(newRealtimeState(), { ...packets[0], sourceStreamId: null, sourcePacketId: null, id: 1 }, context)
assert.equal(reduceRealtimePacket(sameSecond.state, { ...packets[0], sourceStreamId: null, sourcePacketId: null, id: 2 }, context).ignored, undefined,
  'distinct legacy packets sharing a whole-second timestamp must both be processed')
const withoutLoadingZone = run(packets.map(p => ({ ...p, lat: 50, lon: 80 })))
assert.equal(withoutLoadingZone.actions.filter(a => a.type === 'start').length, 0, 'RTK alone cannot start a batch')
const ambiguous = realtimeContext({ lat: 52, lon: 85, gpsValid: true, timestamp: new Date(start) }, [{ ...zone, ingredient: 'Люцерна' }], [])
assert.equal(ambiguous.ingredientName, 'Солома/люцерна (не определено)')
assert.equal(ambiguous.confidence, 'low_confidence')
const tablet = { ...newRealtimeState(), tablet: { id: 'task' }, active: { startAt: start, startWeight: 0, peak: 0, batchId: 1 } }
assert.equal(run(packets, tablet).actions.filter(a => a.type === 'load').length, 0, 'tablet facts cannot be duplicated by automatic segments')
console.log('PASS realtime: TelemetryProcessor action parity, zone overlap, causal saved facts, restart, late packets, RTK uncertainty, tablet suppression')

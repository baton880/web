import assert from 'node:assert/strict'
import { REALTIME_WEIGHT_FILTER, filterRealtimeWeightSeries } from '../src/modules/telemetry/realtime-weight-filter.js'

assert.deepEqual(
  {
    hampelWindow: REALTIME_WEIGHT_FILTER.hampelWindow,
    hampelSigma: REALTIME_WEIGHT_FILTER.hampelSigma,
    medianWindow: REALTIME_WEIGHT_FILTER.medianWindow,
    emaAlpha: REALTIME_WEIGHT_FILTER.emaAlpha,
    fastAlpha: REALTIME_WEIGHT_FILTER.fastAlpha,
    fastStepKg: REALTIME_WEIGHT_FILTER.fastStepKg,
    resetGapSeconds: REALTIME_WEIGHT_FILTER.resetGapSeconds,
    roundToKg: REALTIME_WEIGHT_FILTER.roundToKg
  },
  {
    hampelWindow: 9,
    hampelSigma: 1,
    medianWindow: 7,
    emaAlpha: 0.1,
    fastAlpha: 0.8,
    fastStepKg: 180,
    resetGapSeconds: 4,
    roundToKg: 5
  }
)

const start = Date.parse('2026-08-24T00:00:00Z')
const makeRow = (index, rawWeight, extra = {}) => ({
  timestamp: new Date(start + index * 2000),
  rawWeight,
  weightValid: true,
  ...extra
})

const noisyPlateau = [1000, 1040, 960, 1015, 980, 1025, 970, 1010, 995]
const plateauResult = filterRealtimeWeightSeries(noisyPlateau.map((value, index) => makeRow(index, value)))
assert.equal(plateauResult.points.length, noisyPlateau.length)
assert.ok(Number.isFinite(plateauResult.latest.realtimeWeight))
assert.ok(Math.abs(plateauResult.latest.realtimeWeight - 1000) <= 30)

const stepped = noisyPlateau.concat([1400, 1420, 1390, 1410, 1405, 1395, 1415, 1400, 1410])
const stepResult = filterRealtimeWeightSeries(stepped.map((value, index) => makeRow(index, value)))
assert.ok(stepResult.latest.realtimeWeight > 1200, 'confirmed step must propagate through the causal filter')

const resetResult = filterRealtimeWeightSeries([
  makeRow(0, 1000),
  makeRow(1, 1020),
  { timestamp: new Date(start + 10000), rawWeight: 1600, weightValid: true }
])
assert.equal(resetResult.latest.realtimeWeight, 1600, 'gap above four seconds must reset the filter')

const invalidResult = filterRealtimeWeightSeries([
  makeRow(0, 1000),
  makeRow(1, 1100, { weightValid: false }),
  makeRow(2, 1500)
])
assert.equal(invalidResult.points[1].realtimeWeight, null)
assert.equal(invalidResult.latest.realtimeWeight, 1500)

console.log('Realtime weight filter test passed')

import assert from 'node:assert/strict'

import { buildRestPlateaus, resolveWeightStepOptions } from '../src/modules/batches/weight-step-postprocess.js'

const options = resolveWeightStepOptions({
  stableRadius: 5,
  stableMinPoints: 4,
  stableRangeKg: 20,
  restPlateauEnabled: true,
  restPlateauRadius: 5,
  restPlateauMinPoints: 4,
  restPlateauRangeKg: 20,
  restPlateauMaxSec: 0,
  restPlateauMergeGapSec: 0,
  restPlateauSameKg: 5,
  restPlateauMinDurationSec: 20
})

const quietOscillation = Array.from({ length: 80 }, (_, index) => ({
  x: index * 2000,
  filtered: 500 + (index % 2 ? 5 : -5)
}))
const restPlateaus = buildRestPlateaus(quietOscillation, options)
assert.ok(restPlateaus.some((plateau) => plateau.kind === 'rest'))

const ramp = Array.from({ length: 80 }, (_, index) => ({
  x: index * 2000,
  filtered: 200 + index * 8
}))
const rampPlateaus = buildRestPlateaus(ramp, options)
assert.equal(rampPlateaus.some((plateau) => plateau.kind === 'rest'), false)

const tooShort = quietOscillation.slice(0, 8)
assert.deepEqual(buildRestPlateaus(tooShort, { ...options, restPlateauMinDurationSec: 30 }), [])

const disabledOptions = resolveWeightStepOptions({ ...options, restPlateauEnabled: false })
assert.deepEqual(buildRestPlateaus(quietOscillation, disabledOptions), [])

console.log('PASS rest plateau independently copies ordinary plateau settings and supports minimum duration')

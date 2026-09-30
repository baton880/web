import assert from 'node:assert/strict'
import { selectTabletTask, verifyTabletSteps } from '../src/modules/batches/tablet-ingredients.js'

const start = Date.parse('2026-09-29T03:51:23Z')
const batch = { startTime: new Date(start), endTime: new Date(start + 20 * 60000), groupId: 5, rationId: 4 }
const task = {
  id: 'tablet-task', groupId: 5, rationId: 4, status: 'completed', lastEventAt: start + 600000,
  steps: [
    { name: 'Силос', baseline: { timestampMs: start - 15000 }, end: { timestampMs: start + 180000 }, actualKg: 1020 },
    { name: 'Солома', baseline: { timestampMs: start + 240000 }, end: { timestampMs: start + 300000 }, actualKg: 100 }
  ]
}
assert.equal(selectTabletTask(batch, [{ state: JSON.stringify(task) }])?.id, 'tablet-task')
assert.equal(selectTabletTask({ ...batch, groupId: 6 }, [{ state: JSON.stringify(task) }]), null)
const delayedTask = { ...task, steps: task.steps.map((step, index) => ({ ...step,
  baseline: { timestampMs: start + (index ? 14 : 11) * 60000 },
  end: { timestampMs: start + (index ? 16 : 13) * 60000 }
})), lastEventAt: start + 16 * 60000 }
assert.equal(selectTabletTask(batch, [{ state: JSON.stringify(delayedTask) }])?.id, 'tablet-task')
const detected = [
  { ingredientName: 'Силос', actualWeight: 1015, startedAt: new Date(start + 10000), addedAt: new Date(start + 160000) },
  { ingredientName: 'Солома', actualWeight: 100, startedAt: new Date(start + 245000), addedAt: new Date(start + 290000), determination: { positionDebug: { loaderEligible: false } } }
]
const [silo, straw] = verifyTabletSteps(task, detected)
assert.equal(silo.actualWeight, 1020)
assert.equal(silo.verificationStatus, 'confirmed')
assert.equal(straw.verificationStatus, 'low_confidence')
assert.equal(verifyTabletSteps(task, [])[0].verificationStatus, 'unconfirmed')
const contradictoryLoader = [{ ingredientName: 'Люцерна', actualWeight: 100,
  startedAt: new Date(start + 245000), addedAt: new Date(start + 290000),
  determination: { positionDebug: { loaderEligible: true } } }]
assert.equal(verifyTabletSteps(task, contradictoryLoader)[1].verificationStatus, 'unconfirmed')
assert.equal(verifyTabletSteps(task, contradictoryLoader)[1].algorithmIngredientName, 'Люцерна')
assert.equal(verifyTabletSteps(task, contradictoryLoader)[1].algorithmWeight, 100)
console.log('Tablet facts and verification: OK')

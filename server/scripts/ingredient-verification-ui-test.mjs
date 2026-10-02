import assert from 'node:assert/strict'

await import('../../frontend/js/ingredient-verification-ui.js')

const { inspect, WEIGHT_TOLERANCE_PERCENT, WEIGHT_TOLERANCE_MIN_KG } = globalThis.IngredientVerificationUi

assert.equal(WEIGHT_TOLERANCE_PERCENT, 5)
assert.equal(WEIGHT_TOLERANCE_MIN_KG, 5)

const exactFive = inspect({
  name: 'Комбикорм', fact: 200, tabletWeight: 200, plan: 390, algorithmWeight: 210,
  tabletTaskId: 'task', verificationStatus: 'confirmed'
})
assert.equal(exactFive.weightConfirmed, false)
assert.equal(exactFive.weightMismatch, true)

const smallLoadFloor = inspect({
  name: 'Комбикорм', fact: 45, tabletWeight: 40, plan: 40, algorithmWeight: 45,
  tabletTaskId: 'task', verificationStatus: 'confirmed'
})
assert.equal(smallLoadFloor.weightConfirmed, true)
assert.equal(smallLoadFloor.weightMismatch, false)

const configuredTolerance = inspect({
  name: 'Комбикорм', fact: 44, tabletWeight: 40, algorithmWeight: 44, tabletTaskId: 'task',
  weightTolerancePercent: 2, weightToleranceMinKg: 3
})
assert.equal(configuredTolerance.weightConfirmed, false)
assert.equal(configuredTolerance.weightTolerancePercent, 2)
assert.equal(configuredTolerance.weightToleranceMinKg, 3)

const staleConfirmed = inspect({
  name: 'Комбикорм', fact: 595, tabletWeight: 585, plan: 585, algorithmWeight: 595,
  tabletTaskId: 'task', verificationStatus: 'confirmed'
})
assert.equal(staleConfirmed.weightConfirmed, true, 'a ten kilogram difference can be acceptable below five percent')
assert.equal(staleConfirmed.weightMismatch, false)

const differentFeed = inspect({
  name: 'Зерносенаж', fact: 565, tabletWeight: 560, plan: 565, algorithmWeight: 565,
  algorithmIngredientName: 'Солома', tabletTaskId: 'task',
  verificationStatus: 'unconfirmed', verificationReason: 'ingredient_disagreement'
})
assert.equal(differentFeed.weightConfirmed, true, 'weight can be verified independently of feed identity')
assert.equal(differentFeed.identityMismatch, true)

const mixedEvidenceForSameFeed = inspect({
  name: 'Комбикорм', fact: 300, tabletWeight: 300, plan: 350, algorithmWeight: 300,
  algorithmIngredientName: 'Комбикорм', tabletTaskId: 'task',
  verificationStatus: 'unconfirmed', verificationReason: 'mixed_components'
})
assert.equal(mixedEvidenceForSameFeed.weightConfirmed, true)
assert.equal(mixedEvidenceForSameFeed.identityMismatch, false, 'mixed GPS evidence does not mean the selected ingredient name differs')
assert.equal(mixedEvidenceForSameFeed.algorithmWarning, false, 'legacy mixed evidence is not a reliable warning')

const lowConfidence = inspect({
  name: 'Люцерна', fact: 845, algorithmWeight: 845, tabletTaskId: 'task',
  verificationStatus: 'low_confidence', verificationReason: 'pair_tablet_hint'
})
assert.equal(lowConfidence.weightConfirmed, true)
assert.equal(lowConfidence.lowConfidence, true)

const missing = inspect({
  name: 'Люцерна', fact: 0, plan: 450, isViolation: true, violationStatus: 'critical',
  violationCodes: ['MISSING_COMPONENT'], violationMessages: ['Не загружен плановый компонент «Люцерна».']
})
assert.equal(missing.planViolation, true)
assert.equal(missing.weightPlanViolation, true)
assert.equal(missing.orderViolation, false)
assert.match(missing.criticalMessage, /Не загружен/)

const extra = inspect({
  name: 'Неизвестный компонент', fact: 1000, plan: 0, isViolation: true,
  violationCodes: ['EXTRA_COMPONENT']
})
assert.match(extra.criticalMessage, /вне плана/)
assert.equal(extra.weightPlanViolation, true)

const order = inspect({
  name: 'Комбикорм', fact: 280, plan: 280, isViolation: true,
  violationCodes: ['ORDER_MISMATCH'], violationMessages: ['Комбикорм загружен после зерносенажа']
})
assert.match(order.criticalMessage, /после зерносенажа/)
assert.equal(order.planViolation, true)
assert.equal(order.weightPlanViolation, false, 'an order violation must not color a correct weight red')
assert.equal(order.orderViolation, true)
assert.match(order.orderMessage, /после зерносенажа/)

console.log('ingredient verification UI checks passed')

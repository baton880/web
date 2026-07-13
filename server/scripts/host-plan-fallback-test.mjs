import assert from 'node:assert/strict'

import { applyHostPlanIngredientFallbacks } from '../src/modules/batches/batch-postprocess-service.js'

const planWithStraw = [{ name: 'Солома' }, { name: 'Силос' }]
const hostAlfalfa = {
  ingredientName: 'Люцерна',
  actualWeight: 50,
  determination: { source: 'host_current_zone', ingredientName: 'Люцерна' }
}

const adjusted = applyHostPlanIngredientFallbacks([hostAlfalfa], planWithStraw)
assert.equal(adjusted[0].ingredientName, 'Солома')
assert.equal(adjusted[0].lowConfidence, true)
assert.equal(adjusted[0].originalIngredientName, 'Люцерна')
assert.equal(adjusted[0].determination.source, 'host_current_zone')

for (const source of ['loader_current_zone', 'loader_scoreboard']) {
  const loaderResult = applyHostPlanIngredientFallbacks([
    { ...hostAlfalfa, determination: { ...hostAlfalfa.determination, source } }
  ], planWithStraw)
  assert.equal(loaderResult[0].ingredientName, 'Люцерна')
  assert.equal(loaderResult[0].lowConfidence, undefined)
}

const withDetectedStraw = applyHostPlanIngredientFallbacks([
  hostAlfalfa,
  { ingredientName: 'Солома', determination: { source: 'host_current_zone' } }
], planWithStraw)
assert.equal(withDetectedStraw[0].ingredientName, 'Люцерна')

const planWithAlfalfa = applyHostPlanIngredientFallbacks([
  hostAlfalfa
], [{ name: 'Солома' }, { name: 'Люцерна' }])
assert.equal(planWithAlfalfa[0].ingredientName, 'Люцерна')

console.log('PASS host-only alfalfa to missing planned straw fallback')

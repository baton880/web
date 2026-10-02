import assert from 'node:assert/strict'
import { beginIngredientEvidence, observeIngredientEvidence, confirmIngredientEvidence, buildRealtimeAssessment, exceedsRealtimePlan, realtimeWeightMatches } from '../src/modules/batches/realtime-ingredient-verification.js'
import { realtimeContext } from '../src/modules/batches/realtime-batch-service.js'
import { validateTelemetrySettingsInput } from '../src/modules/telemetry/telemetry-settings.js'

const base = Date.parse('2026-10-01T00:00:00Z')
const context = { evidenceIngredientName: 'Силос', evidenceSource: 'host', pairAmbiguous: false }
function sample(state, second, weight, ctx = context, settings = {}) {
  return observeIngredientEvidence(state, { timestamp: new Date(base + second * 1000), weight, weightValid: true }, ctx, settings)
}
function scenario({ tabletName = 'Силос', tabletWeight = 100, hostWeight = 100, ctx = context, endPacketLate = false, midPeak = null, settings = {} } = {}) {
  let state = {}; sample(state, 0, 0, context, settings); sample(state, 1, 0, context, settings)
  const task = { id: 'task', steps: [{ name: tabletName, actualKg: tabletWeight,
    baseline: { timestampMs: base + 1000, weightKg: 99999 }, end: { timestampMs: base + 9000, weightKg: -99999 } }] }
  beginIngredientEvidence(state, task, 0)
  for (let i = 2; i <= (endPacketLate ? 8 : 9); i++) sample(state, i, i === 3 && midPeak ? midPeak : hostWeight, ctx, settings)
  // Serialize exactly as a process restart; neither tablet weight field may be
  // used for the independent weight estimate.
  state = JSON.parse(JSON.stringify(state))
  let result = confirmIngredientEvidence(state, task, 0, 1, 1, base + 9500, settings)
  if (endPacketLate) {
    assert.equal(result.verificationStatus, 'pending')
    const actions = sample(state, 9, hostWeight, ctx, settings)
    assert.equal(actions.length, 1); result = actions[0]
  }
  assert.equal(sample(state, 12, 90000, ctx, settings).length, 0, 'future packets do not rewrite the confirmed evidence')
  return result
}
const assessment = (tabletWeight, algorithm, name = 'Силос', plan = 100, settings = {}) => buildRealtimeAssessment({
  actualIngredients: [{ ingredientName: name, plannedWeight: plan, actualWeight: tabletWeight, tabletTaskId: 'task', ...algorithm }]
}, [{ name, targetWeight: plan }], settings)

const matched = scenario(); assert.equal(matched.verificationStatus, 'confirmed'); assert.equal(matched.algorithmWeight, 100)
assert.equal(scenario({ tabletWeight: 200, hostWeight: 205 }).verificationStatus, 'confirmed', 'a difference below five percent is accepted')
assert.equal(scenario({ tabletWeight: 40, hostWeight: 45 }).verificationStatus, 'confirmed', 'the five kilogram floor covers small loads')
assert.equal(scenario({ tabletWeight: 200, hostWeight: 210 }).verificationStatus, 'unconfirmed', 'exactly five percent remains outside the strict percentage rule above the floor')
const tenKgMismatch = scenario({ tabletWeight: 100, hostWeight: 110 })
assert.equal(tenKgMismatch.verificationStatus, 'unconfirmed', 'more than five kilograms is not verified')
assert.equal(tenKgMismatch.verificationReason, 'weight_mismatch')
assert.equal(scenario({ midPeak: 500 }).algorithmWeight, 100, 'a transient peak is not loaded weight')
assert.equal(scenario({ endPacketLate: true }).algorithmWeight, 100, 'short host/event delivery race resolves once')
assert.equal(assessment(100, matched).violations.length, 0)
assert.equal(assessment(115, scenario({ tabletWeight: 115 })).violations[0].source, 'tablet', 'tablet deviation is red even if HOST says fine')
assert.equal(assessment(100, scenario({ hostWeight: 130 })).violations[0].source, 'algorithm', 'algorithm-only deviation is yellow')
assert.equal(assessment(115, scenario({ tabletWeight: 115, hostWeight: 130 })).hasCritical, true)
assert.equal(assessment(100, scenario({ hostWeight: 110 })).violations.length, 0, 'exactly ten percent is allowed')
assert.equal(assessment(90, scenario({ tabletWeight:90,hostWeight:110 })).violations.length,0,'both estimates within plan tolerance remain fine even if they differ')
assert.equal(assessment(100, tenKgMismatch).violations.length, 0, 'a verification mismatch does not become a plan violation')
assert.equal(exceedsRealtimePlan(110, 100), false); assert.equal(exceedsRealtimePlan(110.01, 100), true)
assert.equal(realtimeWeightMatches(585, 595), true)
assert.equal(realtimeWeightMatches(40, 45), true)
assert.equal(realtimeWeightMatches(200, 210), false)
assert.equal(realtimeWeightMatches(40, 43, { tabletAlgorithmWeightTolerancePercent: 2, tabletAlgorithmWeightToleranceMinKg: 3 }), true)
assert.equal(realtimeWeightMatches(40, 44, { tabletAlgorithmWeightTolerancePercent: 2, tabletAlgorithmWeightToleranceMinKg: 3 }), false)
assert.deepEqual(validateTelemetrySettingsInput({ tabletAlgorithmWeightTolerancePercent: 7, tabletAlgorithmWeightToleranceMinKg: 4 }, { partial: true }).data,
  { tabletAlgorithmWeightTolerancePercent: 7, tabletAlgorithmWeightToleranceMinKg: 4 })
const acceptedAlgorithmWeight = assessment(585, {
  algorithmWeight: 595, algorithmIngredientName: 'Силос', verificationStatus: 'confirmed', verificationReason: 'host_algorithm_match'
}, 'Силос', 585)
assert.equal(acceptedAlgorithmWeight.summary[0].tabletWeight, 585)
assert.equal(acceptedAlgorithmWeight.summary[0].fact, 595, 'accepted algorithm weight becomes the working fact')
const smallLoadWorkingWeight = assessment(40, {
  algorithmWeight: 45, algorithmIngredientName: 'Силос', verificationStatus: 'confirmed', verificationReason: 'host_algorithm_match'
}, 'Силос', 40)
assert.equal(smallLoadWorkingWeight.summary[0].fact, 45, 'the minimum kilogram tolerance selects the algorithm weight')
const configuredMismatchKeepsTablet = assessment(40, {
  algorithmWeight: 44, algorithmIngredientName: 'Силос', verificationStatus: 'unconfirmed', verificationReason: 'weight_mismatch'
}, 'Силос', 40, { tabletAlgorithmWeightTolerancePercent: 2, tabletAlgorithmWeightToleranceMinKg: 3 })
assert.equal(configuredMismatchKeepsTablet.summary[0].fact, 40, 'outside both configured tolerances the tablet remains the working fact')
const parallelAutomaticRow = buildRealtimeAssessment({ actualIngredients: [
  { ingredientName: 'Силос', actualWeight: 830, tabletTaskId: 'task', algorithmWeight: 835, algorithmIngredientName: 'Силос' },
  { ingredientName: 'Силос', actualWeight: 80, algorithmWeight: 80, algorithmIngredientName: 'Силос' }
] }, [{ name: 'Силос', targetWeight: 835 }])
assert.equal(parallelAutomaticRow.summary[0].fact, 835, 'parallel automatic evidence must not be added to tablet steps')
const thresholdCrossingAgreement = assessment(220, {
  algorithmWeight: 225, algorithmIngredientName: 'Силос', verificationStatus: 'confirmed', verificationReason: 'host_algorithm_match'
}, 'Силос', 200)
assert.equal(thresholdCrossingAgreement.summary[0].fact, 225)
assert.equal(thresholdCrossingAgreement.violations[0]?.code, 'TABLET_DEVIATION', 'the accepted algorithm weight drives the plan check')

const hint = scenario({ tabletName: 'Люцерна', ctx: { ...context, evidenceIngredientName: 'Солома', pairAmbiguous: true } })
assert.equal(hint.algorithmIngredientName, 'Люцерна'); assert.equal(hint.verificationStatus, 'low_confidence'); assert.equal(hint.verificationReason, 'pair_tablet_hint')
assert.equal(assessment(100, hint, 'Люцерна').violations.length, 0, 'uncertain pair is not a business violation')
const pairState={};sample(pairState,0,0);const pairTask={id:'pair',steps:[{name:'Люцерна',actualKg:100,baseline:{timestampMs:base},end:{timestampMs:base+5000}}]};beginIngredientEvidence(pairState,pairTask,0)
for(let i=1;i<=5;i++)sample(pairState,i,i<3?50:100,{...context,evidenceIngredientName:i<3?'Солома':'Люцерна',pairAmbiguous:true})
assert.equal(confirmIngredientEvidence(pairState,pairTask,0,9,1,base+5000).verificationReason,'pair_tablet_hint','GPS jitter between the ambiguous pair is not a mixed-feed violation')
const transitState={};sample(transitState,0,0);const transitTask={id:'transit',steps:[{name:'Комбикорм',actualKg:100,baseline:{timestampMs:base},end:{timestampMs:base+5000}}]};beginIngredientEvidence(transitState,transitTask,0)
sample(transitState,1,50,{...context,evidenceIngredientName:'Комбикорм'});sample(transitState,2,100,{...context,evidenceIngredientName:'Комбикорм'});sample(transitState,3,150,{...context,evidenceIngredientName:'Солома'});sample(transitState,4,100,{...context,evidenceIngredientName:'Солома'});sample(transitState,5,100,{...context,evidenceIngredientName:'Силос'})
const transitResult=confirmIngredientEvidence(transitState,transitTask,0,10,1,base+5000)
assert.equal(transitResult.verificationReason,'host_algorithm_match','transport through another zone before confirm is not proof of another loaded component')
assert.equal(transitResult.algorithmWeight,100)
assert.equal(assessment(115, { ...hint, algorithmWeight: 100 }, 'Люцерна').hasCritical, true, 'low GPS confidence cannot hide confirmed tablet deviation')
const decisive = scenario({ tabletName: 'Люцерна', ctx: { ...context, evidenceIngredientName: 'Солома', evidenceSource: 'rtk' } })
assert.equal(decisive.algorithmIngredientName, 'Солома'); assert.equal(decisive.verificationStatus, 'unconfirmed')
assert.equal(assessment(100, decisive, 'Люцерна').hasWarning, true, 'clear GPS is compared after independent identification')
const remoteHint = scenario({ tabletName: 'Солома', ctx: context })
assert.equal(remoteHint.algorithmIngredientName, 'Силос', 'the tablet cannot rename a feed outside the pair area')
const missingGps = scenario({ ctx: { evidenceIngredientName: null } }); assert.equal(missingGps.verificationStatus, 'low_confidence'); assert.equal(missingGps.algorithmWeight, 100)
assert.equal(assessment(100, missingGps).violations.length, 0, 'missing GPS is not proof of a plan violation')
const auto = buildRealtimeAssessment({ actualIngredients: [{ ingredientName: 'Силос', actualWeight: 130, algorithmWeight: 130, algorithmIngredientName: 'Силос' }] }, [{ name: 'Силос', targetWeight: 100 }])
assert.equal(auto.hasCritical, false); assert.equal(auto.hasWarning, true, 'no tablet confirmation means yellow')

const structuralPlan = [
  { id: 1, name: 'Люцерна', targetWeight: 100, sortOrder: 1 },
  { id: 2, name: 'Комбикорм', targetWeight: 100, sortOrder: 2 }
]
const inProgressMissing = buildRealtimeAssessment({ actualIngredients: [
  { id: 2, ingredientName: 'Комбикорм', actualWeight: 100, addedAt: new Date(base + 2000) }
] }, structuralPlan)
assert.equal(inProgressMissing.violations.some(row => row.code === 'MISSING_COMPONENT'), false, 'future steps are not missing while a batch is open')
const completedMissing = buildRealtimeAssessment({ endTime: new Date(base + 3000), actualIngredients: [
  { id: 2, ingredientName: 'Комбикорм', actualWeight: 100, addedAt: new Date(base + 2000) }
] }, structuralPlan)
assert.equal(completedMissing.violations.find(row => row.code === 'MISSING_COMPONENT')?.ingredient, 'Люцерна')
assert.equal(completedMissing.summary.find(row => row.name === 'Люцерна')?.violationStatus, 'critical')

const extraUnknown = buildRealtimeAssessment({ endTime: new Date(base + 3000), actualIngredients: [
  { id: 1, ingredientName: 'Силос', actualWeight: 100, addedAt: new Date(base + 1000) },
  { id: 2, ingredientName: 'unknown', actualWeight: 1000, addedAt: new Date(base + 2000) }
] }, [{ id: 1, name: 'Силос', targetWeight: 100, sortOrder: 1 }])
assert.equal(extraUnknown.violations.find(row => row.code === 'EXTRA_COMPONENT')?.ingredient, 'Неизвестный компонент')
assert.equal(extraUnknown.hasCritical, true)

const wrongOrder = buildRealtimeAssessment({ endTime: new Date(base + 5000), actualIngredients: [
  { id: 1, ingredientName: 'Люцерна', actualWeight: 100, addedAt: new Date(base + 1000) },
  { id: 3, ingredientName: 'Силос', actualWeight: 100, addedAt: new Date(base + 2000) },
  { id: 2, ingredientName: 'Комбикорм', actualWeight: 100, addedAt: new Date(base + 3000) }
] }, [
  ...structuralPlan,
  { id: 3, name: 'Силос', targetWeight: 100, sortOrder: 3 }
])
assert.match(wrongOrder.violations.find(row => row.code === 'ORDER_MISMATCH')?.message || '', /должен идти раньше/)
assert.equal(wrongOrder.summary.find(row => row.name === 'Комбикорм')?.violationStatus, 'critical')

const screenshotCase = buildRealtimeAssessment({ endTime: new Date(base + 5000), actualIngredients: [
  { id: 1, ingredientName: 'Зерносенаж', actualWeight: 1310, addedAt: new Date(base + 1000), tabletTaskId: 'task' },
  { id: 2, ingredientName: 'Комбикорм', actualWeight: 280, addedAt: new Date(base + 2000), tabletTaskId: 'task' },
  { id: 3, ingredientName: 'Силос', actualWeight: 1510, addedAt: new Date(base + 3000), tabletTaskId: 'task' }
] }, [
  { id: 1, name: 'Люцерна', targetWeight: 450, sortOrder: 1 },
  { id: 2, name: 'Комбикорм', targetWeight: 280, sortOrder: 2 },
  { id: 3, name: 'Зерносенаж', targetWeight: 1260, sortOrder: 3 },
  { id: 4, name: 'Силос', targetWeight: 1440, sortOrder: 4 }
])
assert.deepEqual(screenshotCase.violations.filter(row => ['MISSING_COMPONENT', 'ORDER_MISMATCH'].includes(row.code)).map(row => row.code).sort(), ['MISSING_COMPONENT', 'ORDER_MISMATCH'])
assert.equal(screenshotCase.violations.find(row => row.code === 'ORDER_MISMATCH')?.fact, 3)
assert.equal(screenshotCase.hasCritical, true)

const pairRatio = buildRealtimeAssessment({ endTime: new Date(base + 5000), actualIngredients: [
  { ingredientName: 'Солома', plannedWeight: 100, actualWeight: 150, tabletTaskId: 'task', algorithmWeight: 150, algorithmIngredientName: 'Солома' },
  { ingredientName: 'Люцерна', plannedWeight: 100, actualWeight: 50, tabletTaskId: 'task', algorithmWeight: 50, algorithmIngredientName: 'Люцерна' }
] }, [
  { name: 'Солома', targetWeight: 100, sortOrder: 1 },
  { name: 'Люцерна', targetWeight: 100, sortOrder: 2 }
])
assert.equal(pairRatio.violations.filter(row => row.code === 'TABLET_DEVIATION').length, 2, 'the old straw/alfalfa ratio check is covered by authoritative tablet facts')
assert.equal(pairRatio.hasCritical, true)

const zones = [{ id: 1, name: 'Солома', ingredient: 'Солома', lat: 52, lon: 85, radius: 12 },
  { id: 2, name: 'Люцерна', ingredient: 'Люцерна', lat: 52, lon: 85.0005, radius: 12 }]
process.env.REALTIME_RTK_MODE = 'auto'
const host = { lat: 52, lon: 85.0001, gpsValid: true, timestamp: new Date(base) }
assert.equal(realtimeContext(host, zones, []).pairAmbiguous, true)
const rtk = { lat: 52, lon: 85, timestamp: new Date(base - 1000) }
assert.equal(realtimeContext(host, zones, [], {}, rtk).evidenceSource, 'rtk')
assert.equal(realtimeContext(host, zones, [], {}, { ...rtk, timestamp: new Date(base - 4000) }).evidenceSource, 'host')
assert.equal(realtimeContext(host, zones, [], {}, { ...rtk, lat: 51 }).evidenceSource, 'host')
console.log('PASS realtime verification: independent HOST, causal plateau, configurable percent/minimum tolerance, algorithm working weight, structural violations, GPS priority, bounded pair hint')

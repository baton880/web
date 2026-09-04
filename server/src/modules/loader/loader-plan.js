import { createHash } from 'node:crypto'
import { calculatePlan } from '../../../../module-2/rationManager.js'
import { roundWeight } from '../../../../module-2/weightRounding.js'

export function isLoaderGroupAvailable(group) {
  // Groups currently have no independent active flag in Prisma. Honor one if added later.
  return !!group?.ration && group.isActive !== false && group.active !== false && group.ration.isActive === true
}

export function buildLoaderPlan(group) {
  if (!isLoaderGroupAvailable(group) || !(group.headcount > 0)) return null
  const source = [...(group.ration.ingredients || [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
  // Keep source identity/order consistent with calculatePlan, including old zero sortOrder rows.
  const ordered = source.map((item, index) => ({ ...item, sortOrder: index + 1 }))
  const plan = calculatePlan(ordered, group.headcount, group.ration.feedingsPerDay)
  const steps = plan.ingredients.flatMap((item, index) => {
    const target = roundWeight(item.targetWeight)
    // A compound ration item is a premixed feed loaded as one physical component.
    return Number.isFinite(target) && target > 0
      ? [{ id: String(ordered[index].id), name: item.name, targetKg: target }]
      : []
  })
  if (!steps.length) return null
  const result = {
    groupId: group.id, groupName: group.name, rationId: group.ration.id, rationName: group.ration.name,
    headcount: group.headcount, feedingsPerDay: group.ration.feedingsPerDay || 1,
    totalKg: steps.reduce((sum, s) => sum + s.targetKg, 0), steps
  }
  return { ...result, planRevision: createHash('sha256').update(JSON.stringify(result)).digest('hex') }
}

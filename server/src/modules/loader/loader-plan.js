import { createHash } from 'node:crypto'
import { calculatePlan } from '../../../../module-2/rationManager.js'
import { roundWeight } from '../../../../module-2/weightRounding.js'

export function buildLoaderPlan(group) {
  if (!group?.ration || !(group.headcount > 0)) return null
  const source = [...(group.ration.ingredients || [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
  const plan = calculatePlan(source, group.headcount, group.ration.feedingsPerDay)
  const steps = []
  for (let i = 0; i < plan.ingredients.length; i++) {
    const item = plan.ingredients[i]
    const target = roundWeight(item.targetWeight)
    if (!(target > 0)) continue
    let components = []
    if (item.isCompound) {
      try { components = JSON.parse(item.componentsJson || '[]') } catch { return null }
      if (!Array.isArray(components) || !components.length || components.some(c => !c.name || !(Number(c.plannedWeight) > 0))) return null
    }
    if (!components.length) steps.push({ id: String(source[i].id), name: item.name, targetKg: target })
    else {
      const total = components.reduce((sum, c) => sum + Number(c.plannedWeight), 0)
      let allocated = 0
      components.forEach((c, index) => {
        const weight = index === components.length - 1 ? target - allocated : Math.min(target - allocated, Math.max(0, roundWeight(target * c.plannedWeight / total)))
        allocated += weight
        if (weight > 0) steps.push({ id: `${source[i].id}:${index}`, name: c.name, parentName: item.name, targetKg: weight })
      })
    }
  }
  if (!steps.length) return null
  const result = {
    groupId: group.id, groupName: group.name, rationId: group.ration.id, rationName: group.ration.name,
    headcount: group.headcount, feedingsPerDay: group.ration.feedingsPerDay || 1,
    totalKg: steps.reduce((sum, s) => sum + s.targetKg, 0), steps
  }
  return { ...result, planRevision: createHash('sha256').update(JSON.stringify(result)).digest('hex') }
}

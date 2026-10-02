import { normalizeIngredientName } from '../../../../module-2/rationManager.js'
import { roundWeight } from '../../../../module-2/weightRounding.js'

function getIngredientSortOrder(ingredient, fallbackIndex = 0) {
  const parsed = Number(ingredient?.sortOrder)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackIndex + 1
}

function displayIngredientName(value) {
  const raw = String(value || '').trim()
  return raw && normalizeIngredientName(raw) !== 'unknown' ? raw : 'Неизвестный компонент'
}

function getIngredientTimestampMs(ingredient) {
  const parsed = new Date(ingredient?.startedAt || ingredient?.addedAt || 0).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

export function sortPlanIngredients(ingredients) {
  return [...(Array.isArray(ingredients) ? ingredients : [])].sort((left, right) => {
    const orderDiff = getIngredientSortOrder(left) - getIngredientSortOrder(right)
    if (orderDiff !== 0) return orderDiff
    const leftId = Number(left?.id || 0)
    const rightId = Number(right?.id || 0)
    if (leftId !== rightId) return leftId - rightId
    return String(left?.name || '').localeCompare(String(right?.name || ''), 'ru')
  })
}

export function buildOrderViolations(planIngredients, actualIngredients) {
  const expectedSequence = sortPlanIngredients(planIngredients)
    .filter(ingredient => normalizeIngredientName(ingredient?.name))
    .map((ingredient, index) => ({
      key: normalizeIngredientName(ingredient.name),
      name: displayIngredientName(ingredient.name),
      position: index + 1
    }))

  if (expectedSequence.length <= 1) return []

  const expectedByKey = new Map(expectedSequence.map(item => [item.key, item]))
  const actualSequence = [...(Array.isArray(actualIngredients) ? actualIngredients : [])]
    .sort((left, right) => {
      const timeDiff = getIngredientTimestampMs(left) - getIngredientTimestampMs(right)
      return timeDiff || Number(left?.id || 0) - Number(right?.id || 0)
    })
    .map(ingredient => ({
      key: normalizeIngredientName(ingredient?.ingredientName),
      name: displayIngredientName(ingredient?.ingredientName),
      weight: roundWeight(ingredient?.actualWeight || 0)
    }))
    .filter(ingredient => ingredient.weight > 0 && expectedByKey.has(ingredient.key))

  const violations = []
  const loadedKeys = new Set()
  let latestExpected = null

  actualSequence.forEach((actual) => {
    const expected = expectedByKey.get(actual.key)
    if (!expected || loadedKeys.has(actual.key)) return

    if (latestExpected && expected.position < latestExpected.position) {
      violations.push({
        code: 'ORDER_MISMATCH',
        ingredient: actual.name,
        plan: expected.position,
        // Report the meaningful position among distinct loaded plan components.
        // A component can have several fact rows (for example after a resumed
        // tablet step); those rows must not inflate "actual position" to #5/#6.
        fact: Math.max(loadedKeys.size + 1, latestExpected.position),
        deviationPercent: 0,
        message: `Компонент «${actual.name}» загружен после «${latestExpected.name}», хотя по плану должен идти раньше (позиции ${expected.position} и ${latestExpected.position})`
      })
    }

    if (!latestExpected || expected.position > latestExpected.position) latestExpected = expected
    loadedKeys.add(actual.key)
  })

  return violations
}

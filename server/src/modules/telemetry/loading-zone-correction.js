import { calculateHaversine } from '../../../../module-1/geo.js'
import { normalizeIngredientName } from '../../../../module-2/rationManager.js'

const OVERLAP_BUFFER_METERS = 3

function normalizeExpectedIngredients(expectedIngredients = []) {
  return (Array.isArray(expectedIngredients) ? expectedIngredients : [])
    .map((ingredient, index) => {
      const name = typeof ingredient === 'string' ? ingredient : ingredient?.name
      const key = normalizeIngredientName(name)
      const sortOrder = Number(ingredient?.sortOrder ?? ingredient?.loadOrder ?? index + 1)
      return key ? {
        key,
        name,
        sortOrder: Number.isFinite(sortOrder) && sortOrder > 0 ? sortOrder : index + 1
      } : null
    })
    .filter(Boolean)
    .sort((left, right) => left.sortOrder - right.sortOrder)
}

function zoneIngredientKey(zone) {
  return normalizeIngredientName(zone?.ingredient || zone?.name)
}

function pointInsideIngredientZone(lat, lon, ingredientKey, zones = []) {
  if (!ingredientKey || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    return false
  }

  return (Array.isArray(zones) ? zones : []).some((zone) => {
    if (zoneIngredientKey(zone) !== ingredientKey) return false

    const zoneLat = Number(zone?.lat)
    const zoneLon = Number(zone?.lon)
    const radius = Number(zone?.radius)
    if (!Number.isFinite(zoneLat) || !Number.isFinite(zoneLon) || !Number.isFinite(radius) || radius <= 0) {
      return false
    }

    return calculateHaversine(Number(lat), Number(lon), zoneLat, zoneLon) <= radius + OVERLAP_BUFFER_METERS
  })
}

export async function alignAmbiguousIngredientsWithRation(prismaClient, {
  batchId,
  expectedIngredients = [],
  loadingZones = []
} = {}) {
  const expected = normalizeExpectedIngredients(expectedIngredients)
  if (!batchId || expected.length <= 1 || !Array.isArray(loadingZones) || !loadingZones.length) {
    return 0
  }

  const rows = await prismaClient.batchIngredient.findMany({
    where: { batchId },
    orderBy: [
      { startedAt: 'asc' },
      { addedAt: 'asc' },
      { id: 'asc' }
    ]
  })

  let updates = 0
  let expectedIndex = 0

  for (const row of rows) {
    if (expectedIndex >= expected.length) {
      break
    }

    const expectedItem = expected[expectedIndex]
    const actualKey = normalizeIngredientName(row.ingredientName)
    if (!actualKey || actualKey === expectedItem.key) {
      if (actualKey === expectedItem.key) {
        expectedIndex += 1
      }
      continue
    }

    const lat = Number(row.startLat)
    const lon = Number(row.startLon)
    const actualZoneMatches = pointInsideIngredientZone(lat, lon, actualKey, loadingZones)
    const expectedZoneMatches = pointInsideIngredientZone(lat, lon, expectedItem.key, loadingZones)

    if (!actualZoneMatches || !expectedZoneMatches) {
      if (expected.some((ingredient) => ingredient.key === actualKey)) {
        expectedIndex += 1
      }
      continue
    }

    await prismaClient.batchIngredient.update({
      where: { id: row.id },
      data: { ingredientName: expectedItem.name }
    })
    updates += 1
    expectedIndex += 1
  }

  return updates
}

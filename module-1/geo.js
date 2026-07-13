/**
 * Вычисляет расстояние между двумя точками по формуле гаверсинуса.
 * @param {number} lat1 - Широта первой точки (градусы)
 * @param {number} lon1 - Долгота первой точки (градусы)
 * @param {number} lat2 - Широта второй точки (градусы)
 * @param {number} lon2 - Долгота второй точки (градусы)
 * @returns {number} Расстояние в метрах
 */
export function calculateHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Средний радиус Земли в метрах
  const toRad = deg => deg * Math.PI / 180;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);

  const sinDPhi2 = Math.sin(dPhi / 2);
  const sinDLambda2 = Math.sin(dLambda / 2);

  let a = sinDPhi2 * sinDPhi2 + 
          Math.cos(phi1) * Math.cos(phi2) * 
          sinDLambda2 * sinDLambda2;

  // Защита от микропереполнения float: a может стать 1.0000000000000002
  if (a > 1) a = 1;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function isPointInsidePolygon(lat, lon, polygonCoords = []) {
    let isInside = false

    for (let i = 0, j = polygonCoords.length - 1; i < polygonCoords.length; j = i++) {
        const yi = Number(polygonCoords[i]?.[0])
        const xi = Number(polygonCoords[i]?.[1])
        const yj = Number(polygonCoords[j]?.[0])
        const xj = Number(polygonCoords[j]?.[1])

        const intersects = ((yi > lat) !== (yj > lat))
            && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi)

        if (intersects) {
            isInside = !isInside
        }
    }

    return isInside
}

function parsePolygonCoords(value) {
    if (!value) return null
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value
        return Array.isArray(parsed) && parsed.length >= 3 ? parsed : null
    } catch {
        return null
    }
}

function squarePolygonCoords(zone) {
    const polygon = parsePolygonCoords(zone?.polygonCoords)
    if (polygon) return polygon

    if (
        Number.isFinite(Number(zone?.squareMinLat)) &&
        Number.isFinite(Number(zone?.squareMinLon)) &&
        Number.isFinite(Number(zone?.squareMaxLat)) &&
        Number.isFinite(Number(zone?.squareMaxLon))
    ) {
        const minLat = Math.min(Number(zone.squareMinLat), Number(zone.squareMaxLat))
        const maxLat = Math.max(Number(zone.squareMinLat), Number(zone.squareMaxLat))
        const minLon = Math.min(Number(zone.squareMinLon), Number(zone.squareMaxLon))
        const maxLon = Math.max(Number(zone.squareMinLon), Number(zone.squareMaxLon))
        return [[minLat, minLon], [minLat, maxLon], [maxLat, maxLon], [maxLat, minLon]]
    }

    return null
}

function pointToSegmentDistanceMeters(lat, lon, first, second) {
    const metersPerLat = 111320
    const metersPerLon = Math.max(Math.cos(lat * Math.PI / 180) * 111320, 1)
    const ax = (Number(first?.[1]) - lon) * metersPerLon
    const ay = (Number(first?.[0]) - lat) * metersPerLat
    const bx = (Number(second?.[1]) - lon) * metersPerLon
    const by = (Number(second?.[0]) - lat) * metersPerLat
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    const projection = lengthSquared > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0
    return Math.hypot(ax + projection * dx, ay + projection * dy)
}

export function distanceToZoneMeters(lat, lon, zone) {
    const shapeType = String(zone?.shapeType || 'CIRCLE').trim().toUpperCase()
    if (shapeType === 'SQUARE') {
        const polygon = squarePolygonCoords(zone)
        if (polygon) {
            if (isPointInsidePolygon(lat, lon, polygon)) return 0
            let closest = Number.POSITIVE_INFINITY
            for (let index = 0; index < polygon.length; index += 1) {
                closest = Math.min(
                    closest,
                    pointToSegmentDistanceMeters(lat, lon, polygon[index], polygon[(index + 1) % polygon.length])
                )
            }
            return closest
        }
    }

    const centerDistance = calculateHaversine(lat, lon, Number(zone?.lat), Number(zone?.lon))
    const radius = Math.max(0, Number(zone?.radius) || 0)
    return Math.max(0, centerDistance - radius)
}

export function detectZoneWithinRadius(lat, lon, zonesConfig = [], radiusMeters = 0) {
    const exactZone = detectZoneObject(lat, lon, zonesConfig)
    if (exactZone) return exactZone

    const radius = Math.max(0, Number(radiusMeters) || 0)
    let closestZone = null
    let closestDistance = Number.POSITIVE_INFINITY
    for (const zone of zonesConfig) {
        const distance = distanceToZoneMeters(lat, lon, zone)
        if (Number.isFinite(distance) && distance <= radius && distance < closestDistance) {
            closestZone = zone
            closestDistance = distance
        }
    }
    return closestZone
}


export function detectZoneObject(lat, lon, zonesConfig = []) {
    let distance
    for (const zone of zonesConfig)
    {
        const shapeType = String(zone?.shapeType || 'CIRCLE').trim().toUpperCase()

        if (shapeType === 'SQUARE' && zone?.polygonCoords) {
            let polygonCoords = null

            polygonCoords = parsePolygonCoords(zone.polygonCoords)

            if (Array.isArray(polygonCoords) && polygonCoords.length >= 3 && isPointInsidePolygon(lat, lon, polygonCoords)) {
                return zone
            }
        }

        if (
            shapeType === 'SQUARE' &&
            Number.isFinite(Number(zone.squareMinLat)) &&
            Number.isFinite(Number(zone.squareMinLon)) &&
            Number.isFinite(Number(zone.squareMaxLat)) &&
            Number.isFinite(Number(zone.squareMaxLon))
        ) {
            const minLat = Math.min(Number(zone.squareMinLat), Number(zone.squareMaxLat))
            const maxLat = Math.max(Number(zone.squareMinLat), Number(zone.squareMaxLat))
            const minLon = Math.min(Number(zone.squareMinLon), Number(zone.squareMaxLon))
            const maxLon = Math.max(Number(zone.squareMinLon), Number(zone.squareMaxLon))

            if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
                return zone
            }

            continue
        }

        distance = calculateHaversine(lat, lon, Number(zone.lat), Number(zone.lon))
        if (distance <= Number(zone.radius))
        {
            return zone
        }
    }
    return null
}

export function detectZone(lat, lon, zonesConfig = []) {
    return detectZoneObject(lat, lon, zonesConfig)?.name || null
}

export default detectZone

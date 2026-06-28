import { Router } from 'express'
import prisma from "../../database.js"
import { requireReadAccess, requireWriteAccess } from "../../middleware/auth.js"

const router = Router()
const DEFAULT_RADIUS = 20
const DEFAULT_SIDE_METERS = 40
const ZONE_TYPES = new Set(['STORAGE', 'BARN'])

function parseId(value) {
  const id = parseInt(value, 10)
  return Number.isInteger(id) && id > 0 ? id : null
}

function parseBooleanField(value) {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value === 'boolean') return { ok: true, value }
  if (typeof value === 'number') return value === 0 || value === 1 ? { ok: true, value: value !== 0 } : { ok: false, value: null }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return { ok: true, value: true }
    if (normalized === 'false' || normalized === '0') return { ok: true, value: false }
  }
  return { ok: false, value: null }
}

function parseNumberField(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : NaN
}

function normalizeShapeType(value) {
  const normalized = String(value || 'CIRCLE').trim().toUpperCase()
  return normalized === 'SQUARE' ? 'SQUARE' : 'CIRCLE'
}

function normalizeZoneType(value) {
  const normalized = String(value || '').trim().toUpperCase()
  return ZONE_TYPES.has(normalized) ? normalized : null
}

function normalizeZoneName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function normalizeDegrees(value) {
  const normalized = Number(value) % 360
  return normalized < 0 ? normalized + 360 : normalized
}

function calculateBearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => deg * Math.PI / 180
  const toDeg = (rad) => rad * 180 / Math.PI
  const phi1 = toRad(lat1)
  const phi2 = toRad(lat2)
  const lambdaDelta = toRad(lon2 - lon1)
  const y = Math.sin(lambdaDelta) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambdaDelta)

  return normalizeDegrees(toDeg(Math.atan2(y, x)))
}

function parseLoadingWallSide(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 3 ? parsed : NaN
}

function calculateLoadingNormalDeg(polygonCoords, wallSide) {
  if (!Array.isArray(polygonCoords) || polygonCoords.length < 4) return null
  if (!Number.isInteger(wallSide) || wallSide < 0 || wallSide > 3) return null

  const first = polygonCoords[wallSide]
  const second = polygonCoords[(wallSide + 1) % 4]
  if (!first || !second) return null

  const centerLat = polygonCoords.slice(0, 4).reduce((sum, point) => sum + Number(point[0]), 0) / 4
  const centerLon = polygonCoords.slice(0, 4).reduce((sum, point) => sum + Number(point[1]), 0) / 4
  const midpointLat = (Number(first[0]) + Number(second[0])) / 2
  const midpointLon = (Number(first[1]) + Number(second[1])) / 2

  if (
    !Number.isFinite(centerLat) ||
    !Number.isFinite(centerLon) ||
    !Number.isFinite(midpointLat) ||
    !Number.isFinite(midpointLon)
  ) {
    return null
  }

  return calculateBearingDeg(centerLat, centerLon, midpointLat, midpointLon)
}

function parsePolygonCoords(value) {
  if (!value) return null

  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }

  if (!Array.isArray(parsed) || parsed.length < 4) return null

  const normalized = parsed.map((point) => {
    if (!Array.isArray(point) || point.length < 2) return null
    const lat = Number(point[0])
    const lon = Number(point[1])
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return null
    }

    return [lat, lon]
  })

  return normalized.every(Boolean) ? normalized : null
}

function buildSquareMetaFromBounds(minLat, minLon, maxLat, maxLon) {
  const normalizedMinLat = Math.min(minLat, maxLat)
  const normalizedMaxLat = Math.max(minLat, maxLat)
  const normalizedMinLon = Math.min(minLon, maxLon)
  const normalizedMaxLon = Math.max(minLon, maxLon)
  const lat = (normalizedMinLat + normalizedMaxLat) / 2
  const lon = (normalizedMinLon + normalizedMaxLon) / 2
  const latMeters = (normalizedMaxLat - normalizedMinLat) * 111320
  const lonMeters = (normalizedMaxLon - normalizedMinLon) * Math.max(Math.cos(lat * Math.PI / 180) * 111320, 1)

  return {
    lat,
    lon,
    sideMeters: Math.max(latMeters, lonMeters),
    squareMinLat: normalizedMinLat,
    squareMinLon: normalizedMinLon,
    squareMaxLat: normalizedMaxLat,
    squareMaxLon: normalizedMaxLon,
    polygonCoords: JSON.stringify([
      [normalizedMaxLat, normalizedMinLon],
      [normalizedMaxLat, normalizedMaxLon],
      [normalizedMinLat, normalizedMaxLon],
      [normalizedMinLat, normalizedMinLon]
    ])
  }
}

function buildSquareMetaFromPolygon(polygonCoords) {
  const lats = polygonCoords.map((point) => Number(point[0]))
  const lons = polygonCoords.map((point) => Number(point[1]))
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const meta = buildSquareMetaFromBounds(minLat, minLon, maxLat, maxLon)

  return {
    ...meta,
    polygonCoords: JSON.stringify(polygonCoords)
  }
}

function normalizeZonePayload(body, options = {}) {
  const { partial = false, currentZone = null } = options
  const data = {}
  const shapeType = body.shapeType !== undefined
    ? normalizeShapeType(body.shapeType)
    : normalizeShapeType(currentZone?.shapeType)

  if (!partial || body.zoneType !== undefined) {
    const zoneType = body.zoneType !== undefined
      ? normalizeZoneType(body.zoneType)
      : normalizeZoneType(currentZone?.zoneType)
    if (!zoneType) {
      return { ok: false, error: 'Выберите тип зоны' }
    }
    data.zoneType = zoneType
  }

  if (!partial || body.name !== undefined) {
    const name = normalizeZoneName(body.name)
    if (!name) {
      return { ok: false, error: 'Название зоны не может быть пустым' }
    }
    data.name = name
  }

  if (!partial || body.ingredient !== undefined) {
    const ingredient = normalizeZoneName(body.ingredient)
    if (!ingredient) {
      return { ok: false, error: 'Название не может быть пустым' }
    }
    data.ingredient = ingredient
  }

  if (shapeType !== 'SQUARE' && (!partial || body.lat !== undefined)) {
    const lat = body.lat !== undefined ? parseNumberField(body.lat) : Number(currentZone?.lat)
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return { ok: false, error: 'Неверный формат широты (lat)' }
    }
    data.lat = lat
  }

  if (shapeType !== 'SQUARE' && (!partial || body.lon !== undefined)) {
    const lon = body.lon !== undefined ? parseNumberField(body.lon) : Number(currentZone?.lon)
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      return { ok: false, error: 'Неверный формат долготы (lon)' }
    }
    data.lon = lon
  }

  data.shapeType = shapeType

  if (shapeType === 'SQUARE') {
    const lat = body.lat !== undefined ? parseNumberField(body.lat) : Number(currentZone?.lat)
    const lon = body.lon !== undefined ? parseNumberField(body.lon) : Number(currentZone?.lon)
    const sideMeters = body.sideMeters !== undefined
      ? parseNumberField(body.sideMeters)
      : Number(currentZone?.sideMeters || DEFAULT_SIDE_METERS)
    const squareMinLat = body.squareMinLat !== undefined ? parseNumberField(body.squareMinLat) : parseNumberField(currentZone?.squareMinLat)
    const squareMinLon = body.squareMinLon !== undefined ? parseNumberField(body.squareMinLon) : parseNumberField(currentZone?.squareMinLon)
    const squareMaxLat = body.squareMaxLat !== undefined ? parseNumberField(body.squareMaxLat) : parseNumberField(currentZone?.squareMaxLat)
    const squareMaxLon = body.squareMaxLon !== undefined ? parseNumberField(body.squareMaxLon) : parseNumberField(currentZone?.squareMaxLon)
    const polygonCoords = body.polygonCoords !== undefined
      ? parsePolygonCoords(body.polygonCoords)
      : parsePolygonCoords(currentZone?.polygonCoords)
    const loadingWallSide = body.loadingWallSide !== undefined
      ? parseLoadingWallSide(body.loadingWallSide)
      : parseLoadingWallSide(currentZone?.loadingWallSide)

    let meta = null

    if (Number.isNaN(loadingWallSide)) {
      return { ok: false, error: 'Некорректная сторона загрузки квадратной зоны' }
    }

    if (polygonCoords) {
      meta = buildSquareMetaFromPolygon(polygonCoords)
    } else if (
      Number.isFinite(squareMinLat) &&
      Number.isFinite(squareMinLon) &&
      Number.isFinite(squareMaxLat) &&
      Number.isFinite(squareMaxLon)
    ) {
      if (
        squareMinLat < -90 || squareMinLat > 90 ||
        squareMaxLat < -90 || squareMaxLat > 90 ||
        squareMinLon < -180 || squareMinLon > 180 ||
        squareMaxLon < -180 || squareMaxLon > 180
      ) {
        return { ok: false, error: 'Неверные координаты углов квадрата' }
      }

      meta = buildSquareMetaFromBounds(squareMinLat, squareMinLon, squareMaxLat, squareMaxLon)
    } else {
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return { ok: false, error: 'Неверный формат широты (lat)' }
      }

      if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
        return { ok: false, error: 'Неверный формат долготы (lon)' }
      }

      if (!Number.isFinite(sideMeters) || sideMeters <= 0) {
        return { ok: false, error: 'Неверная длина стороны квадрата' }
      }

      const halfSideMeters = sideMeters / 2
      const latDelta = halfSideMeters / 111320
      const lonDelta = halfSideMeters / Math.max(Math.cos(lat * Math.PI / 180) * 111320, 1)

      meta = {
        lat,
        lon,
        sideMeters,
        squareMinLat: lat - latDelta,
        squareMinLon: lon - lonDelta,
        squareMaxLat: lat + latDelta,
        squareMaxLon: lon + lonDelta,
        polygonCoords: JSON.stringify([
          [lat + latDelta, lon - lonDelta],
          [lat + latDelta, lon + lonDelta],
          [lat - latDelta, lon + lonDelta],
          [lat - latDelta, lon - lonDelta]
        ])
      }
    }

    data.lat = meta.lat
    data.lon = meta.lon
    data.sideMeters = meta.sideMeters
    data.polygonCoords = meta.polygonCoords
    data.squareMinLat = meta.squareMinLat
    data.squareMinLon = meta.squareMinLon
    data.squareMaxLat = meta.squareMaxLat
    data.squareMaxLon = meta.squareMaxLon
    data.loadingWallSide = loadingWallSide
    data.loadingNormalDeg = loadingWallSide === null
      ? null
      : calculateLoadingNormalDeg(parsePolygonCoords(meta.polygonCoords), loadingWallSide)
    data.radius = DEFAULT_RADIUS
  } else {
    if (!partial || body.radius !== undefined) {
      const radius = body.radius === undefined ? DEFAULT_RADIUS : parseNumberField(body.radius)
      if (!Number.isFinite(radius) || radius <= 0) {
        return { ok: false, error: 'Неверный радиус зоны' }
      }
      data.radius = radius
    }

    data.sideMeters = null
    data.polygonCoords = null
    data.squareMinLat = null
    data.squareMinLon = null
    data.squareMaxLat = null
    data.squareMaxLon = null
    data.loadingWallSide = null
    data.loadingNormalDeg = null
  }

  if (!partial || body.active !== undefined) {
    const parsedActive = parseBooleanField(body.active)
    if (!parsedActive.ok) {
      return { ok: false, error: 'Поле active должно быть boolean true/false' }
    }
    if (parsedActive.value !== undefined) {
      data.active = parsedActive.value
    }
  }

  return { ok: true, data }
}

// GET все активные зоны - доступно для чтения всем авторизованным
router.get('/', requireReadAccess, async (req, res) => {
  try {
    const includeInactive = parseBooleanField(req.query.includeInactive)
    if (!includeInactive.ok) {
      return res.status(400).json({ error: 'Параметр includeInactive должен быть boolean true/false' })
    }
    const zoneType = req.query.type !== undefined || req.query.zoneType !== undefined
      ? normalizeZoneType(req.query.type ?? req.query.zoneType)
      : null
    if ((req.query.type !== undefined || req.query.zoneType !== undefined) && !zoneType) {
      return res.status(400).json({ error: 'Параметр type должен быть STORAGE или BARN' })
    }

    const where = {
      ...(includeInactive.value ? {} : { active: true }),
      ...(zoneType ? { zoneType } : {})
    }

    const zones = await prisma.storageZone.findMany({
      where,
      orderBy: [
        { active: 'desc' },
        { zoneType: 'asc' },
        { id: 'asc' }
      ]
    })
    res.json(zones)  // ← без map и toUTC7
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /:id - Обновление существующей зоны - только для записи
router.put('/:id', requireWriteAccess, async (req, res) => {
  try {
    const id = parseId(req.params.id)
    if (!id) {
      return res.status(400).json({ error: 'Некорректный ID зоны' })
    }

    const existingZone = await prisma.storageZone.findUnique({
      where: { id }
    })

    if (!existingZone) {
      return res.status(404).json({ error: 'Зона с таким ID не найдена' })
    }

    const payload = normalizeZonePayload(req.body, { partial: true, currentZone: existingZone })
    if (!payload.ok) {
      return res.status(400).json({ error: payload.error })
    }

    if (Object.keys(payload.data).length === 0) {
      return res.status(400).json({ error: 'Не передано ни одного поля для обновления' })
    }

    const nextName = payload.data.name || existingZone.name
    const duplicateZone = await prisma.storageZone.findFirst({
      where: {
        name: nextName,
        NOT: { id }
      },
      select: { id: true }
    })

    if (duplicateZone) {
      return res.status(409).json({ error: 'Зона с таким названием уже существует' })
    }

    const updatedZone = await prisma.storageZone.update({
      where: { id },
      data: payload.data
    });

    res.json({ status: 'ok', zone: updatedZone });
  } catch (error) {
    // Если Prisma не нашла зону по ID, она выкинет ошибку с кодом P2025
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Зона с таким ID не найдена' });
    }
    console.error('[Ошибка обновления зоны]:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST создать зону - только для записи
router.post('/', requireWriteAccess, async (req, res) => {
  try {
    const payload = normalizeZonePayload(req.body)
    if (!payload.ok) {
      return res.status(400).json({ error: payload.error })
    }

    const duplicateZone = await prisma.storageZone.findFirst({
      where: { name: payload.data.name },
      select: { id: true }
    })

    if (duplicateZone) {
      return res.status(409).json({ error: 'Зона с таким названием уже существует' })
    }

    const zone = await prisma.storageZone.create({
      data: payload.data
    })
    res.status(201).json(zone)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE деактивировать зону - только для записи
router.delete('/:id', requireWriteAccess, async (req, res) => {
  try {
    const id = parseId(req.params.id)
    if (!id) {
      return res.status(400).json({ error: 'Некорректный ID зоны' })
    }

    await prisma.storageZone.update({
      where: { id },
      data: { active: false }
    })
    res.json({ message: 'Zone deactivated' })
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Зона с таким ID не найдена' })
    }
    console.error(error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

const BASE_URL = (process.env.SCENARIO_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const USERNAME = process.env.SCENARIO_USERNAME || 'admin'
const PASSWORD = process.env.SCENARIO_PASSWORD || ''
const DEVICE_ID = process.env.SCENARIO_DEVICE_ID || `problem_piles_${Date.now().toString().slice(-6)}`
const STEP_DELAY_MS = Number.parseInt(process.env.SCENARIO_STEP_DELAY_MS || '1000', 10)
const TICK_SECONDS = Number.parseFloat(process.env.SCENARIO_TICK_SECONDS || '1')

const TARGET_ZONES = {
  lucerne: process.env.SCENARIO_LUCERNE_ZONE || 'Люцерна',
  straw: process.env.SCENARIO_STRAW_ZONE || 'Солома'
}

function apiUrl(path) {
  return `${BASE_URL}${path}`
}

async function readBody(response) {
  const type = response.headers.get('content-type') || ''
  if (type.includes('application/json')) {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  try {
    return await response.text()
  } catch {
    return null
  }
}

async function request(method, path, options = {}) {
  const headers = {
    ...(options.headers || {})
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`
  }

  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await fetch(apiUrl(path), {
    method,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined
  })
  const body = await readBody(response)

  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(body)}`)
  }

  return body
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parsePolygon(zone) {
  if (!zone?.polygonCoords) return null

  try {
    const parsed = typeof zone.polygonCoords === 'string'
      ? JSON.parse(zone.polygonCoords)
      : zone.polygonCoords
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function zoneCenter(zone) {
  const polygon = parsePolygon(zone)
  if (Array.isArray(polygon) && polygon.length) {
    const sum = polygon.reduce((acc, point) => {
      acc.lat += Number(point[0])
      acc.lon += Number(point[1])
      return acc
    }, { lat: 0, lon: 0 })

    return {
      lat: sum.lat / polygon.length,
      lon: sum.lon / polygon.length
    }
  }

  if (
    Number.isFinite(Number(zone.squareMinLat)) &&
    Number.isFinite(Number(zone.squareMaxLat)) &&
    Number.isFinite(Number(zone.squareMinLon)) &&
    Number.isFinite(Number(zone.squareMaxLon))
  ) {
    return {
      lat: (Number(zone.squareMinLat) + Number(zone.squareMaxLat)) / 2,
      lon: (Number(zone.squareMinLon) + Number(zone.squareMaxLon)) / 2
    }
  }

  return {
    lat: Number(zone.lat),
    lon: Number(zone.lon)
  }
}

function metersPerLonAt(lat) {
  return Math.max(Math.cos(lat * Math.PI / 180) * 111320, 1)
}

function toLocalMeters(point, origin) {
  return {
    north: (point.lat - origin.lat) * 111320,
    east: (point.lon - origin.lon) * metersPerLonAt(origin.lat)
  }
}

function fromLocalMeters(local, origin) {
  return {
    lat: origin.lat + local.north / 111320,
    lon: origin.lon + local.east / metersPerLonAt(origin.lat)
  }
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.north, vector.east)
  if (!Number.isFinite(length) || length <= 0) {
    return { north: 1, east: 0 }
  }

  return {
    north: vector.north / length,
    east: vector.east / length
  }
}

function offsetMeters(point, origin, northMeters, eastMeters) {
  const local = toLocalMeters(point, origin)
  return fromLocalMeters({
    north: local.north + northMeters,
    east: local.east + eastMeters
  }, origin)
}

function interpolate(a, b, ratio) {
  return {
    lat: a.lat + (b.lat - a.lat) * ratio,
    lon: a.lon + (b.lon - a.lon) * ratio
  }
}

function buildRoutePoints(lucerneCenter, strawCenter) {
  const origin = lucerneCenter
  const lucerneLocal = toLocalMeters(lucerneCenter, origin)
  const strawLocal = toLocalMeters(strawCenter, origin)
  const lucerneToStraw = normalizeVector({
    north: strawLocal.north - lucerneLocal.north,
    east: strawLocal.east - lucerneLocal.east
  })
  const perpendicularLeft = {
    north: -lucerneToStraw.east,
    east: lucerneToStraw.north
  }

  const between = interpolate(lucerneCenter, strawCenter, 0.5)
  const approach = offsetMeters(lucerneCenter, origin, -lucerneToStraw.north * 30, -lucerneToStraw.east * 30)
  const lucerneEntry = offsetMeters(lucerneCenter, origin, -lucerneToStraw.north * 10, -lucerneToStraw.east * 10)
  const strawEntry = offsetMeters(strawCenter, origin, -lucerneToStraw.north * 8, -lucerneToStraw.east * 8)
  const roadAfterLeftTurn = offsetMeters(between, origin, perpendicularLeft.north * 28, perpendicularLeft.east * 28)
  const mixerPoint = offsetMeters(roadAfterLeftTurn, origin, perpendicularLeft.north * 34, perpendicularLeft.east * 34)
  const unloadProbe = offsetMeters(mixerPoint, origin, perpendicularLeft.north * 16, perpendicularLeft.east * 16)

  return {
    approach,
    lucerneEntry,
    lucerneCenter,
    strawEntry,
    strawCenter,
    between,
    roadAfterLeftTurn,
    mixerPoint,
    unloadProbe
  }
}

function isoAt(baseTimeMs, offsetSeconds) {
  return new Date(baseTimeMs + offsetSeconds * 1000).toISOString()
}

function buildRtkPacket(timestamp, point) {
  return {
    deviceId: DEVICE_ID,
    timestamp,
    lat: point.lat,
    lon: point.lon,
    valid: true,
    quality: 4,
    quality_label: 'rtk_fixed',
    satellites: 18,
    raw_gga: '$GNGGA,PROBLEM-PILES-NO-COURSE',
    events_reader_ok: true,
    wifi_connected: true,
    wifi_ssid: 'ISRK_Hozyain',
    wifi_profile: 'primary',
    rssi_dbm: -61,
    sd_ready: true,
    ram_queue_len: 0,
    free_heap_bytes: 214320
  }
}

function buildHostPacket(timestamp, point, weight) {
  return {
    deviceId: DEVICE_ID,
    timestamp,
    lat: point.lat,
    lon: point.lon,
    gpsValid: true,
    gpsSatellites: 12,
    weight,
    weightValid: true,
    gpsQuality: 4,
    wifiClients: [],
    cpuTempC: 56.2,
    lteRssiDbm: -72,
    lteAccessTech: 'LTE',
    eventsReaderOk: true
  }
}

function expandScenario(route) {
  const steps = []

  function hold(label, point, weights) {
    for (const weight of weights) {
      steps.push({ label, point, weight })
    }
  }

  function travel(label, from, to, count, weight) {
    for (let index = 1; index <= count; index += 1) {
      steps.push({
        label,
        point: interpolate(from, to, index / count),
        weight
      })
    }
  }

  travel('slow_approach_to_lucerne', route.approach, route.lucerneEntry, 6, 80)
  travel('front_enter_lucerne', route.lucerneEntry, route.lucerneCenter, 4, 80)
  hold(
    'lucerne_bucket_loading_20s',
    route.lucerneCenter,
    Array.from({ length: 20 }, () => 80)
  )
  travel('reverse_from_lucerne_to_straw', route.lucerneCenter, route.strawEntry, 4, 80)
  hold(
    'short_reverse_touch_straw_5s',
    route.strawCenter,
    Array.from({ length: 5 }, () => 80)
  )
  travel('leave_straw_back_to_road', route.strawCenter, route.between, 4, 80)
  travel('left_turn_between_piles', route.between, route.roadAfterLeftTurn, 5, 80)
  hold('bucket_dump_into_stationary_mixer', route.roadAfterLeftTurn, [120, 190, 270, 360, 470, 570, 650, 650])

  // This final drop is not part of the pile maneuver. It only makes the current
  // processor flush the component into BatchIngredient, so the bug is visible.
  hold('flush_probe_simulated_mixer_unload', route.unloadProbe, [640, 520, 390, 250, 120, 35])

  return steps
}

function findZone(zones, query) {
  const normalizedQuery = String(query).trim().toLowerCase()
  return zones.find((zone) => {
    const name = String(zone.name || '').trim().toLowerCase()
    const ingredient = String(zone.ingredient || '').trim().toLowerCase()
    return name.includes(normalizedQuery) || ingredient.includes(normalizedQuery)
  })
}

async function main() {
  console.log(`[Scenario] Base URL: ${BASE_URL}`)
  console.log(`[Scenario] Device ID: ${DEVICE_ID}`)
  console.log('[Scenario] No course/speed/voltage fields will be sent.')

  if (!PASSWORD) {
    throw new Error('Set SCENARIO_PASSWORD before running this scenario')
  }

  const login = await request('POST', '/api/auth/login', {
    json: {
      username: USERNAME,
      password: PASSWORD
    }
  })

  const token = login.token
  if (!token) {
    throw new Error('Login did not return a token')
  }

  const zones = await request('GET', '/api/telemetry/zones?includeInactive=true', { token })
  const lucerneZone = findZone(zones, TARGET_ZONES.lucerne)
  const strawZone = findZone(zones, TARGET_ZONES.straw)

  if (!lucerneZone || !strawZone) {
    throw new Error(
      `Target zones not found. lucerne=${Boolean(lucerneZone)}, straw=${Boolean(strawZone)}. ` +
      `Available zones: ${zones.map((zone) => zone.name).join(', ')}`
    )
  }

  const route = buildRoutePoints(zoneCenter(lucerneZone), zoneCenter(strawZone))
  const scenario = expandScenario(route)
  const baseTimeMs = Date.now()

  console.log(`[Scenario] Lucerne zone: #${lucerneZone.id} ${lucerneZone.name}`)
  console.log(`[Scenario] Straw zone: #${strawZone.id} ${strawZone.name}`)
  console.log(`[Scenario] Packets: ${scenario.length} RTK + ${scenario.length} host`)
  console.log(
    `[Scenario] Host/mixer stays fixed at lat=${route.mixerPoint.lat.toFixed(6)} ` +
    `lon=${route.mixerPoint.lon.toFixed(6)}`
  )

  for (let index = 0; index < scenario.length; index += 1) {
    const step = scenario[index]
    const timestamp = isoAt(baseTimeMs, index * TICK_SECONDS)

    await request('POST', '/api/telemetry/rtk', {
      json: buildRtkPacket(timestamp, step.point)
    })

    await request('POST', '/api/telemetry/host', {
      json: buildHostPacket(timestamp, route.mixerPoint, step.weight)
    })

    console.log(
      `[${String(index + 1).padStart(2, '0')}/${scenario.length}] ` +
      `${step.label} weight=${step.weight} lat=${step.point.lat.toFixed(6)} lon=${step.point.lon.toFixed(6)}`
    )

    if (STEP_DELAY_MS > 0) {
      await sleep(STEP_DELAY_MS)
    }
  }

  const batches = await request('GET', '/api/batches', { token })
  const latestBatch = Array.isArray(batches)
    ? batches.find((batch) => batch.deviceId === DEVICE_ID)
    : null

  if (!latestBatch?.id) {
    console.log('[Scenario] No batch was created for this device.')
    return
  }

  const details = await request('GET', `/api/batches/${latestBatch.id}`, { token })
  console.log('[Scenario] Latest batch:')
  console.log(JSON.stringify({
    id: details.id,
    deviceId: details.deviceId,
    startWeight: details.startWeight,
    endWeight: details.endWeight,
    actualIngredients: details.actualIngredients
  }, null, 2))
}

main().catch((error) => {
  console.error('[Scenario] Failed:', error)
  process.exitCode = 1
})

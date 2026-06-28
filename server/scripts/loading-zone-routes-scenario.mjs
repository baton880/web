import '../src/load-env.js'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const BASE_URL = (process.env.SCENARIO_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const HOST_DEVICE_ID = process.env.SCENARIO_HOST_DEVICE_ID || `host_loading_demo_${Date.now().toString().slice(-5)}`
const LOADER_DEVICE_ID = process.env.SCENARIO_LOADER_DEVICE_ID || `rtk_loader_demo_${Date.now().toString().slice(-5)}`
const STRAW_QUERY = process.env.SCENARIO_STRAW_ZONE || 'Солома'
const LUCERNE_QUERY = process.env.SCENARIO_LUCERNE_ZONE || 'Люцерна'
const STEP_DELAY_MS = Number.parseInt(process.env.SCENARIO_STEP_DELAY_MS || '900', 10)
const TICK_SECONDS = Number.parseFloat(process.env.SCENARIO_TICK_SECONDS || '1')
const JITTER_METERS = Number.parseFloat(process.env.SCENARIO_JITTER_METERS || '0.85')
const GPS_SPIKE_METERS = Number.parseFloat(process.env.SCENARIO_GPS_SPIKE_METERS || '1.25')
const SEED = Number.parseInt(process.env.SCENARIO_SEED || '28062026', 10)
const KEEP_OLD = process.env.SCENARIO_KEEP_OLD === '1'

function apiUrl(path) {
  return `${BASE_URL}${path}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function request(method, path, json) {
  const response = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json)
  })
  const body = await readBody(response)

  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(body)}`)
  }

  return body
}

function createRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const random = createRandom(SEED)

function randomBetween(min, max) {
  return min + (max - min) * random()
}

function normalizeDegrees(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  const normalized = parsed % 360
  return normalized < 0 ? normalized + 360 : normalized
}

function angleAdd(deg, delta) {
  return normalizeDegrees(Number(deg) + Number(delta))
}

function bearingToVector(bearingDeg) {
  const rad = Number(bearingDeg) * Math.PI / 180
  return {
    north: Math.cos(rad),
    east: Math.sin(rad)
  }
}

function vectorToBearing(vector) {
  return normalizeDegrees(Math.atan2(vector.east, vector.north) * 180 / Math.PI)
}

function metersPerLonAt(lat) {
  return Math.max(Math.cos(Number(lat) * Math.PI / 180) * 111320, 1)
}

function toLocalMeters(point, origin) {
  return {
    north: (Number(point.lat) - origin.lat) * 111320,
    east: (Number(point.lon) - origin.lon) * metersPerLonAt(origin.lat)
  }
}

function fromLocalMeters(local, origin) {
  return {
    lat: origin.lat + Number(local.north) / 111320,
    lon: origin.lon + Number(local.east) / metersPerLonAt(origin.lat)
  }
}

function offsetLocal(point, origin, northMeters, eastMeters) {
  const local = toLocalMeters(point, origin)
  return fromLocalMeters({
    north: local.north + northMeters,
    east: local.east + eastMeters
  }, origin)
}

function offsetByVector(point, origin, vector, meters) {
  return offsetLocal(point, origin, vector.north * meters, vector.east * meters)
}

function interpolate(a, b, ratio) {
  return {
    lat: Number(a.lat) + (Number(b.lat) - Number(a.lat)) * ratio,
    lon: Number(a.lon) + (Number(b.lon) - Number(a.lon)) * ratio
  }
}

function calculateBearing(a, b) {
  const from = toLocalMeters(a, a)
  const to = toLocalMeters(b, a)
  return vectorToBearing({
    north: to.north - from.north,
    east: to.east - from.east
  })
}

function distanceMeters(a, b) {
  const local = toLocalMeters(b, a)
  return Math.hypot(local.north, local.east)
}

function jitter(point, origin, meters = JITTER_METERS) {
  if (!Number.isFinite(meters) || meters <= 0) return point
  const radius = randomBetween(0, meters)
  const angle = randomBetween(0, Math.PI * 2)
  return offsetLocal(point, origin, Math.cos(angle) * radius, Math.sin(angle) * radius)
}

function parsePolygon(zone) {
  if (!zone?.polygonCoords) return null

  try {
    const parsed = typeof zone.polygonCoords === 'string'
      ? JSON.parse(zone.polygonCoords)
      : zone.polygonCoords
    if (!Array.isArray(parsed) || parsed.length < 4) return null
    return parsed.slice(0, 4).map((point) => ({
      lat: Number(point[0]),
      lon: Number(point[1])
    })).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
  } catch {
    return null
  }
}

function zoneCenter(zone) {
  const polygon = parsePolygon(zone)
  if (polygon?.length) {
    const sum = polygon.reduce((acc, point) => {
      acc.lat += point.lat
      acc.lon += point.lon
      return acc
    }, { lat: 0, lon: 0 })
    return { lat: sum.lat / polygon.length, lon: sum.lon / polygon.length }
  }

  return { lat: Number(zone.lat), lon: Number(zone.lon) }
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase()
}

function findZone(zones, query) {
  const normalizedQuery = normalizeText(query)
  return zones.find((zone) => {
    const haystack = [
      zone.name,
      zone.ingredient
    ].map(normalizeText).join(' ')
    return haystack.includes(normalizedQuery)
  })
}

function fallbackNormalDeg(zone, otherZone) {
  const center = zoneCenter(zone)
  const other = zoneCenter(otherZone)
  return calculateBearing(other, center)
}

function buildZoneModel(zone, otherZone, origin) {
  const center = zoneCenter(zone)
  const polygon = parsePolygon(zone)
  const normalDeg = normalizeDegrees(zone.loadingNormalDeg) ?? fallbackNormalDeg(zone, otherZone)
  const normal = bearingToVector(normalDeg)
  const tangent = bearingToVector(angleAdd(normalDeg, 90))

  const localPoints = polygon?.length
    ? polygon.map((point) => {
      const local = toLocalMeters(point, center)
      return {
        normal: local.north * normal.north + local.east * normal.east,
        tangent: local.north * tangent.north + local.east * tangent.east
      }
    })
    : [
      { normal: Number(zone.radius || 20), tangent: Number(zone.radius || 20) },
      { normal: -Number(zone.radius || 20), tangent: -Number(zone.radius || 20) }
    ]

  const normalAbs = Math.max(8, ...localPoints.map((point) => Math.abs(point.normal)))
  const tangentAbs = Math.max(8, ...localPoints.map((point) => Math.abs(point.tangent)))

  function point(normalMeters, tangentMeters, jitterMeters = JITTER_METERS) {
    const base = offsetLocal(
      center,
      origin,
      normal.north * normalMeters + tangent.north * tangentMeters,
      normal.east * normalMeters + tangent.east * tangentMeters
    )
    return jitter(base, origin, jitterMeters)
  }

  return {
    zone,
    name: zone.name,
    ingredient: zone.ingredient || zone.name,
    center,
    normalDeg,
    normal,
    tangent,
    normalAbs,
    tangentAbs,
    point,
    outsideBack: (side = 0) => point(-normalAbs - 14, side, 0.2),
    entryBack: (side = 0) => point(-normalAbs + 1.5, side, JITTER_METERS),
    middle: (side = 0) => point(-normalAbs * 0.15, side, JITTER_METERS),
    wall: (side = 0) => point(normalAbs - 3.5, side, JITTER_METERS),
    outsideWall: (side = 0) => point(normalAbs + 9, side, JITTER_METERS),
    cornerLeft: () => point(normalAbs - 4, -tangentAbs * 0.62, JITTER_METERS),
    cornerRight: () => point(normalAbs - 4, tangentAbs * 0.62, JITTER_METERS),
    boundaryLeft: () => point(0, -tangentAbs + 1.2, GPS_SPIKE_METERS),
    boundaryRight: () => point(0, tangentAbs - 1.2, GPS_SPIKE_METERS)
  }
}

function labelStep(label, point, options = {}) {
  return {
    label,
    point,
    heading: normalizeDegrees(options.heading),
    weight: options.weight,
    speed: options.speed,
    note: options.note
  }
}

function addTravel(steps, label, from, to, count, options = {}) {
  for (let index = 1; index <= count; index += 1) {
    const ratio = index / count
    const point = interpolate(from, to, ratio)
    const movementBearing = calculateBearing(index === 1 ? from : steps[steps.length - 1].point, point)
    const heading = options.heading !== undefined
      ? options.heading
      : angleAdd(movementBearing, options.headingOffset || 0)
    steps.push(labelStep(label, point, {
      heading,
      weight: options.weight,
      speed: options.speed
    }))
  }
}

function addHold(steps, label, point, count, options = {}) {
  for (let index = 0; index < count; index += 1) {
    const heading = options.headingSequence?.[index] ?? options.heading
    steps.push(labelStep(label, jitter(point, options.origin, options.jitterMeters ?? JITTER_METERS), {
      heading,
      weight: options.weight,
      speed: options.speed ?? 0.4,
      note: options.note
    }))
  }
}

function addDumpAndClose(steps, route, scenarioWeightBase = 24) {
  const dumpWeights = [
    scenarioWeightBase + 55,
    scenarioWeightBase + 125,
    scenarioWeightBase + 220,
    scenarioWeightBase + 330,
    scenarioWeightBase + 440,
    scenarioWeightBase + 525
  ]
  const closeWeights = [
    scenarioWeightBase + 500,
    scenarioWeightBase + 360,
    scenarioWeightBase + 220,
    scenarioWeightBase + 95,
    35
  ]

  for (const weight of dumpWeights) {
    steps.push(labelStep('dump_bucket_into_host', jitter(route.mixerPoint, route.origin, 0.35), {
      heading: route.mixerHeading,
      weight,
      speed: 0.5
    }))
  }

  for (const weight of closeWeights) {
    steps.push(labelStep('close_batch_simulated_unload', jitter(route.mixerPoint, route.origin, 0.35), {
      heading: route.mixerHeading,
      weight,
      speed: 0.4
    }))
  }
}

function buildMixerPoint(straw, lucerne, origin) {
  const between = interpolate(straw.center, lucerne.center, 0.5)
  const strawToLucerne = calculateBearing(straw.center, lucerne.center)
  const side = bearingToVector(angleAdd(strawToLucerne, 90))
  return offsetByVector(between, origin, side, 46)
}

function buildRoutes(straw, lucerne, origin) {
  const mixerPoint = buildMixerPoint(straw, lucerne, origin)
  const mixerHeading = calculateBearing(interpolate(straw.center, lucerne.center, 0.5), mixerPoint)
  const route = { origin, mixerPoint, mixerHeading }
  const base = 24

  function withPrelude(name, expected) {
    const steps = []
    addHold(steps, 'empty_baseline_before_route', mixerPoint, 3, {
      origin,
      heading: mixerHeading,
      weight: base,
      jitterMeters: 0.25
    })
    return {
      name,
      expected,
      steps
    }
  }

  const scenarios = []

  {
    const scenario = withPrelude('01_straw_front_then_lucerne_edge_touch', straw.ingredient)
    const start = straw.outsideBack(-straw.tangentAbs * 0.15)
    const entry = straw.entryBack(-straw.tangentAbs * 0.1)
    const wall = straw.wall(-straw.tangentAbs * 0.12)
    const lucerneBrush = lucerne.boundaryLeft()

    addTravel(scenario.steps, 'straw_front_approach', start, entry, 5, {
      heading: straw.normalDeg,
      weight: base,
      speed: 3.2
    })
    addTravel(scenario.steps, 'straw_front_to_wall', entry, wall, 5, {
      heading: straw.normalDeg,
      weight: base,
      speed: 2.1
    })
    addHold(scenario.steps, 'straw_good_heading_loading', wall, 9, {
      origin,
      heading: straw.normalDeg,
      weight: base
    })
    addTravel(scenario.steps, 'leave_straw_and_brush_lucerne_edge', wall, lucerneBrush, 6, {
      headingOffset: 12,
      weight: base,
      speed: 3.4
    })
    addHold(scenario.steps, 'short_bad_lucerne_edge_noise', lucerneBrush, 3, {
      origin,
      heading: angleAdd(lucerne.normalDeg, 95),
      weight: base,
      jitterMeters: GPS_SPIKE_METERS
    })
    addTravel(scenario.steps, 'go_to_host_after_straw', lucerneBrush, mixerPoint, 8, {
      weight: base,
      speed: 4.2
    })
    addDumpAndClose(scenario.steps, route, base)
    scenarios.push(scenario)
  }

  {
    const scenario = withPrelude('02_lucerne_parallel_entry_turn_and_corner_hunt', lucerne.ingredient)
    const parallelStart = lucerne.point(-lucerne.normalAbs * 0.35, -lucerne.tangentAbs - 12, 0.4)
    const parallelEnd = lucerne.point(-lucerne.normalAbs * 0.25, lucerne.tangentAbs * 0.55, JITTER_METERS)
    const wallCenter = lucerne.wall(0)
    const left = lucerne.cornerLeft()
    const right = lucerne.cornerRight()

    addTravel(scenario.steps, 'lucerne_parallel_entry_along_wall', parallelStart, parallelEnd, 10, {
      heading: angleAdd(lucerne.normalDeg, 84),
      weight: base,
      speed: 2.6
    })
    addHold(scenario.steps, 'lucerne_turning_bucket_to_wall', parallelEnd, 5, {
      origin,
      headingSequence: [angleAdd(lucerne.normalDeg, 70), angleAdd(lucerne.normalDeg, 45), angleAdd(lucerne.normalDeg, 25), angleAdd(lucerne.normalDeg, 10), lucerne.normalDeg],
      weight: base
    })
    addTravel(scenario.steps, 'lucerne_corner_left_scrape', parallelEnd, left, 5, {
      heading: angleAdd(lucerne.normalDeg, -14),
      weight: base,
      speed: 1.4
    })
    addTravel(scenario.steps, 'lucerne_corner_right_scrape', left, right, 8, {
      heading: angleAdd(lucerne.normalDeg, 8),
      weight: base,
      speed: 1.2
    })
    addHold(scenario.steps, 'lucerne_good_heading_wall_center', wallCenter, 8, {
      origin,
      heading: lucerne.normalDeg,
      weight: base
    })
    addTravel(scenario.steps, 'go_to_host_after_lucerne', wallCenter, mixerPoint, 9, {
      weight: base,
      speed: 4.0
    })
    addDumpAndClose(scenario.steps, route, base)
    scenarios.push(scenario)
  }

  {
    const scenario = withPrelude('03_straw_reverse_entry_then_recover_inside', straw.ingredient)
    const wallOutside = straw.outsideWall(straw.tangentAbs * 0.1)
    const insideFromWall = straw.wall(straw.tangentAbs * 0.05)
    const middle = straw.middle(-straw.tangentAbs * 0.1)

    addTravel(scenario.steps, 'straw_reverse_entry_from_component_side', wallOutside, insideFromWall, 5, {
      heading: angleAdd(calculateBearing(wallOutside, insideFromWall), 180),
      weight: base,
      speed: 1.8
    })
    addHold(scenario.steps, 'straw_turn_around_inside', insideFromWall, 5, {
      origin,
      headingSequence: [angleAdd(straw.normalDeg, 160), angleAdd(straw.normalDeg, 120), angleAdd(straw.normalDeg, 80), angleAdd(straw.normalDeg, 35), straw.normalDeg],
      weight: base
    })
    addTravel(scenario.steps, 'straw_reposition_after_reverse', insideFromWall, middle, 4, {
      heading: straw.normalDeg,
      weight: base,
      speed: 1.1
    })
    addHold(scenario.steps, 'straw_recovered_good_loading', straw.wall(0), 12, {
      origin,
      heading: straw.normalDeg,
      weight: base
    })
    addTravel(scenario.steps, 'go_to_host_after_recovered_straw', straw.wall(0), mixerPoint, 8, {
      weight: base,
      speed: 3.7
    })
    addDumpAndClose(scenario.steps, route, base)
    scenarios.push(scenario)
  }

  {
    const scenario = withPrelude('04_lucerne_good_load_then_reverse_touch_straw', lucerne.ingredient)
    const lucerneStart = lucerne.outsideBack(0)
    const lucerneWall = lucerne.wall(lucerne.tangentAbs * 0.22)
    const strawTouch = straw.middle(straw.tangentAbs * 0.18)

    addTravel(scenario.steps, 'lucerne_clean_front_entry', lucerneStart, lucerneWall, 8, {
      heading: lucerne.normalDeg,
      weight: base,
      speed: 2.7
    })
    addHold(scenario.steps, 'lucerne_good_loading_before_confusion', lucerneWall, 10, {
      origin,
      heading: lucerne.normalDeg,
      weight: base
    })
    addTravel(scenario.steps, 'reverse_into_straw_after_lucerne', lucerneWall, strawTouch, 7, {
      heading: angleAdd(calculateBearing(lucerneWall, strawTouch), 180),
      weight: base,
      speed: 2.2
    })
    addHold(scenario.steps, 'short_straw_reverse_touch_only', strawTouch, 4, {
      origin,
      heading: angleAdd(straw.normalDeg, 180),
      weight: base,
      jitterMeters: GPS_SPIKE_METERS
    })
    addTravel(scenario.steps, 'go_to_host_after_lucerne_with_straw_touch', strawTouch, mixerPoint, 8, {
      weight: base,
      speed: 4.1
    })
    addDumpAndClose(scenario.steps, route, base)
    scenarios.push(scenario)
  }

  {
    const scenario = withPrelude('05_boundary_jitter_between_straw_and_lucerne_then_straw', straw.ingredient)
    const strawBoundary = straw.boundaryRight()
    const lucerneBoundary = lucerne.boundaryLeft()
    const strawWall = straw.wall(-straw.tangentAbs * 0.4)
    const strawCorner = straw.cornerRight()

    addTravel(scenario.steps, 'boundary_zigzag_straw_to_lucerne_noise', strawBoundary, lucerneBoundary, 8, {
      headingOffset: 35,
      weight: base,
      speed: 2.5
    })
    addTravel(scenario.steps, 'boundary_zigzag_back_to_straw_noise', lucerneBoundary, strawBoundary, 8, {
      headingOffset: -25,
      weight: base,
      speed: 2.4
    })
    addTravel(scenario.steps, 'commit_to_straw_after_boundary_noise', strawBoundary, strawWall, 5, {
      heading: straw.normalDeg,
      weight: base,
      speed: 1.8
    })
    addHold(scenario.steps, 'straw_corner_loading_with_gps_spikes', strawCorner, 10, {
      origin,
      heading: angleAdd(straw.normalDeg, randomBetween(-18, 18)),
      weight: base,
      jitterMeters: GPS_SPIKE_METERS
    })
    addTravel(scenario.steps, 'go_to_host_after_boundary_straw', strawCorner, mixerPoint, 8, {
      weight: base,
      speed: 4.4
    })
    addDumpAndClose(scenario.steps, route, base)
    scenarios.push(scenario)
  }

  return { scenarios, mixerPoint }
}

function buildRtkPacket(timestamp, step, index) {
  return {
    deviceId: LOADER_DEVICE_ID,
    hostDeviceId: HOST_DEVICE_ID,
    timestamp,
    lat: step.point.lat,
    lon: step.point.lon,
    valid: true,
    quality: 4,
    quality_label: 'rtk_fixed',
    fixType: 'rtk_fixed',
    satellites: 20 + (index % 4),
    hacc: 0.012 + (index % 3) * 0.004,
    vacc: 0.018,
    corr_age_s: 0.3 + (index % 4) * 0.05,
    speed: Number.isFinite(step.speed) ? step.speed : 1.2,
    course: step.heading,
    headingAccDeg: 1.1 + (index % 3) * 0.4,
    relPosValid: true,
    relPosHeadingValid: true,
    rssi_dbm: -56 - (index % 5),
    wifi_profile: 'primary',
    sd_ready: true,
    queue_len: index % 3,
    scenario: 'loading-zone-routes',
    label: step.label
  }
}

function buildHostPacket(timestamp, point, weight) {
  return {
    deviceId: HOST_DEVICE_ID,
    timestamp,
    lat: point.lat,
    lon: point.lon,
    gpsValid: true,
    gpsSatellites: 13,
    speedKmh: 0.4,
    weight,
    weightValid: true,
    gpsQuality: 4,
    wifiClients: [],
    cpuTempC: 54.4,
    lteRssiDbm: -70,
    lteAccessTech: 'LTE',
    eventsReaderOk: true
  }
}

function scenarioFilter(scenarios) {
  const only = String(process.env.SCENARIO_ONLY || '').trim()
  if (!only) return scenarios
  const parts = only.split(',').map((item) => item.trim()).filter(Boolean)
  return scenarios.filter((scenario, index) => {
    const number = String(index + 1)
    return parts.some((part) => scenario.name.includes(part) || number === part)
  })
}

async function cleanupDemoTelemetry() {
  if (KEEP_OLD) return
  await Promise.all([
    prisma.rtkTelemetry.deleteMany({ where: { deviceId: LOADER_DEVICE_ID } }),
    prisma.telemetry.deleteMany({ where: { deviceId: HOST_DEVICE_ID } })
  ])
}

async function printRecentBatches(startedAt) {
  const batches = await prisma.batch.findMany({
    where: {
      deviceId: HOST_DEVICE_ID,
      startTime: { gte: startedAt }
    },
    orderBy: { id: 'asc' },
    include: { actualIngredients: true }
  })

  console.log('')
  console.log(`[Result] Batches created for ${HOST_DEVICE_ID}: ${batches.length}`)
  for (const batch of batches) {
    const ingredients = batch.actualIngredients
      .map((item) => `${item.ingredientName}:${Math.round(item.actualWeight)}kg`)
      .join(', ')
    console.log(
      `[Result] batch #${batch.id} start=${Math.round(batch.startWeight)} ` +
      `end=${batch.endWeight == null ? 'open' : Math.round(batch.endWeight)} ` +
      `ingredients=[${ingredients || 'none'}]`
    )
  }
}

async function main() {
  const startedAt = new Date()
  console.log(`[Scenario] base=${BASE_URL}`)
  console.log(`[Scenario] host=${HOST_DEVICE_ID}`)
  console.log(`[Scenario] loader=${LOADER_DEVICE_ID}`)
  console.log(`[Scenario] seed=${SEED} delay=${STEP_DELAY_MS}ms jitter=${JITTER_METERS}m spike=${GPS_SPIKE_METERS}m`)

  const zones = await prisma.storageZone.findMany({
    where: { active: true },
    orderBy: { id: 'asc' }
  })
  const strawZone = findZone(zones, STRAW_QUERY)
  const lucerneZone = findZone(zones, LUCERNE_QUERY)

  if (!strawZone || !lucerneZone) {
    throw new Error(
      `Zones not found. straw=${Boolean(strawZone)} lucerne=${Boolean(lucerneZone)}. ` +
      `Available: ${zones.map((zone) => `${zone.id}:${zone.name}/${zone.ingredient}`).join(', ')}`
    )
  }

  const strawCenter = zoneCenter(strawZone)
  const lucerneCenter = zoneCenter(lucerneZone)
  const origin = interpolate(strawCenter, lucerneCenter, 0.5)
  const straw = buildZoneModel(strawZone, lucerneZone, origin)
  const lucerne = buildZoneModel(lucerneZone, strawZone, origin)
  const { scenarios: allScenarios, mixerPoint } = buildRoutes(straw, lucerne, origin)
  const scenarios = scenarioFilter(allScenarios)

  if (!scenarios.length) {
    throw new Error(`No scenarios selected by SCENARIO_ONLY=${process.env.SCENARIO_ONLY}`)
  }

  await cleanupDemoTelemetry()

  console.log(`[Scenario] straw=#${strawZone.id} ${strawZone.name} normal=${Math.round(straw.normalDeg)}deg`)
  console.log(`[Scenario] lucerne=#${lucerneZone.id} ${lucerneZone.name} normal=${Math.round(lucerne.normalDeg)}deg`)
  console.log(`[Scenario] mixer lat=${mixerPoint.lat.toFixed(7)} lon=${mixerPoint.lon.toFixed(7)}`)
  console.log(`[Scenario] selected routes=${scenarios.map((item) => item.name).join(', ')}`)
  console.log('')

  let packetIndex = 0
  let simulatedSeconds = 0

  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex]
    console.log(
      `[Scenario ${scenarioIndex + 1}/${scenarios.length}] ${scenario.name} ` +
      `expected=${scenario.expected}`
    )

    for (const step of scenario.steps) {
      const timestamp = new Date(Date.now() + simulatedSeconds * 1000).toISOString()
      const weight = Number.isFinite(step.weight) ? step.weight : 24

      await request('POST', '/api/telemetry/rtk', buildRtkPacket(timestamp, step, packetIndex))
      await request('POST', '/api/telemetry/host', buildHostPacket(timestamp, mixerPoint, weight))

      packetIndex += 1
      simulatedSeconds += TICK_SECONDS

      console.log(
        `[${String(packetIndex).padStart(3, '0')}] ${step.label.padEnd(42)} ` +
        `w=${String(Math.round(weight)).padStart(3)} ` +
        `h=${String(Math.round(step.heading ?? 0)).padStart(3)} ` +
        `lat=${step.point.lat.toFixed(7)} lon=${step.point.lon.toFixed(7)}`
      )

      if (STEP_DELAY_MS > 0) {
        await sleep(STEP_DELAY_MS)
      }
    }

    console.log(`[Scenario ${scenarioIndex + 1}] done`)
    console.log('')
  }

  await printRecentBatches(startedAt)
}

main()
  .catch((error) => {
    console.error('[Scenario] Failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

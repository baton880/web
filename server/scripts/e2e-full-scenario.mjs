const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000'
const scenarioLog = []

function apiUrl(path) {
  return `${BASE_URL}${path}`
}

function pushLog(step, details) {
  scenarioLog.push({ step, ...details })
}

async function readResponseBody(response) {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    try {
      return await response.json()
    } catch (error) {
      return null
    }
  }

  try {
    return await response.text()
  } catch (error) {
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
    body: options.form
      ? options.form
      : options.json !== undefined
        ? JSON.stringify(options.json)
        : undefined
  })

  const body = await readResponseBody(response)
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(body)}`)
  }

  return body
}

function isoAt(baseTimeMs, offsetSeconds) {
  return new Date(baseTimeMs + offsetSeconds * 1000).toISOString()
}

function offsetPoint(point, latOffset = 0, lonOffset = 0) {
  return {
    lat: point.lat + latOffset,
    lon: point.lon + lonOffset
  }
}

function buildRtkPacket(deviceId, timestamp, point, overrides = {}) {
  return {
    deviceId,
    timestamp,
    lat: point.lat,
    lon: point.lon,
    valid: true,
    quality: 4,
    quality_label: 'rtk_fixed',
    satellites: 18,
    raw_gga: '$GNGGA,E2E',
    events_reader_ok: true,
    wifi_connected: true,
    wifi_ssid: 'ISRK_Hozyain',
    wifi_profile: 'primary',
    rssi_dbm: -61,
    sd_ready: true,
    ram_queue_len: 0,
    free_heap_bytes: 214320,
    ...overrides
  }
}

function buildHostPacket(deviceId, timestamp, point, weight, overrides = {}) {
  return {
    deviceId,
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
    eventsReaderOk: true,
    ...overrides
  }
}

async function main() {
  const startedAt = new Date()
  const runTag = Date.now().toString().slice(-6)
  const userName = `e2e_operator_${runTag}`
  const userEmail = `e2e.operator.${runTag}@example.com`
  const hostDeviceId = `host_e2e_${runTag}`
  const loaderDeviceId = `rtk_loader_e2e_${runTag}`
  const polygonZoneName = `Concentrate polygon E2E ${runTag}`
  const squareBarnZoneName = `Square barn E2E ${runTag}`
  const geoSeed = Number(runTag) % 1000
  const latShift = 0.02 + geoSeed * 0.00002
  const lonShift = 0.02 + geoSeed * 0.00002
  const point = (lat, lon) => ({ lat: lat + latShift, lon: lon + lonShift })
  const scenarioPoints = {
    yardWest: point(52.5278, 85.1268),
    circleStorage: point(52.5284, 85.1275),
    yardBetweenCircleSquare: point(52.5289, 85.12745),
    squareStorage: point(52.5292, 85.1284),
    yardBetweenSquarePolygon: point(52.52965, 85.12895),
    polygonStorage: point(52.52875, 85.12975),
    serviceLane: point(52.52965, 85.12975),
    squareBarn: point(52.5308, 85.13015),
    yardBeforeBarn: point(52.53055, 85.1286),
    circleBarn: point(52.53, 85.1293),
    yardEast: point(52.53055, 85.13025),
    polygonCoords: [
      point(52.52905, 85.1294),
      point(52.52905, 85.13005),
      point(52.52855, 85.13012),
      point(52.52845, 85.12955)
    ]
  }
  const circleZoneName = `Силосная зона E2E ${runTag}`
  const squareZoneName = `Сенная зона E2E ${runTag}`
  const unloadZoneName = `Коровник E2E ${runTag}`
  const rationName = `Рацион E2E ${runTag}`
  const mainGroupName = `Группа E2E ${runTag}`
  const updatedGroupName = `Группа E2E основная ${runTag}`
  const tempGroupName = `Группа E2E временная ${runTag}`

  const health = await request('GET', '/api/health')
  pushLog('health', { status: 'ok', health })

  const login = await request('POST', '/api/auth/login', {
    json: {
      username: 'admin',
      password: 'KorovkiTOP'
    }
  })
  const adminToken = login.token
  pushLog('login', { status: 'ok', role: login.role })

  const createdUser = await request('POST', '/api/users', {
    token: adminToken,
    json: {
      username: userName,
      email: userEmail,
      password: 'Operator123',
      role: 'GUEST'
    }
  })
  pushLog('user_create', { status: 'ok', id: createdUser.id })

  const promotedUser = await request('PATCH', `/api/users/${createdUser.id}/role`, {
    token: adminToken,
    json: { role: 'DIRECTOR' }
  })
  pushLog('user_patch_role', { status: 'ok', role: promotedUser.user?.role || 'DIRECTOR' })

  const circleZone = await request('POST', '/api/telemetry/zones', {
    token: adminToken,
    json: {
      name: circleZoneName,
      ingredient: 'Silage',
      zoneType: 'STORAGE',
      shapeType: 'CIRCLE',
      lat: scenarioPoints.circleStorage.lat,
      lon: scenarioPoints.circleStorage.lon,
      radius: 40,
      active: true
    }
  })
  pushLog('zone_circle_create', { status: 'ok', id: circleZone.id })

  const squareZone = await request('POST', '/api/telemetry/zones', {
    token: adminToken,
    json: {
      name: squareZoneName,
      ingredient: 'Hay',
      zoneType: 'STORAGE',
      shapeType: 'SQUARE',
      lat: scenarioPoints.squareStorage.lat,
      lon: scenarioPoints.squareStorage.lon,
      sideMeters: 60,
      active: true
    }
  })
  pushLog('zone_square_create', { status: 'ok', id: squareZone.id })

  const polygonZone = await request('POST', '/api/telemetry/zones', {
    token: adminToken,
    json: {
      name: polygonZoneName,
      ingredient: 'Concentrate',
      zoneType: 'STORAGE',
      shapeType: 'SQUARE',
      polygonCoords: scenarioPoints.polygonCoords.map((item) => [item.lat, item.lon]),
      active: true
    }
  })
  pushLog('zone_polygon_create', { status: 'ok', id: polygonZone.id })

  const unloadZone = await request('POST', '/api/telemetry/zones', {
    token: adminToken,
    json: {
      name: unloadZoneName,
      ingredient: 'Коровник',
      zoneType: 'BARN',
      shapeType: 'CIRCLE',
      lat: scenarioPoints.circleBarn.lat,
      lon: scenarioPoints.circleBarn.lon,
      radius: 45,
      active: true
    }
  })
  pushLog('zone_unload_create', { status: 'ok', id: unloadZone.id })

  const squareBarnZone = await request('POST', '/api/telemetry/zones', {
    token: adminToken,
    json: {
      name: squareBarnZoneName,
      ingredient: 'Square barn',
      zoneType: 'BARN',
      shapeType: 'SQUARE',
      lat: scenarioPoints.squareBarn.lat,
      lon: scenarioPoints.squareBarn.lon,
      sideMeters: 55,
      active: true
    }
  })
  pushLog('zone_square_barn_create', { status: 'ok', id: squareBarnZone.id })

  const rationCreate = await request('POST', '/api/rations', {
    token: adminToken,
    json: {
      name: rationName,
      ingredients: [
        { name: 'Silage', plannedWeight: 90, dryMatterWeight: 35 },
        { name: 'Hay', plannedWeight: 120, dryMatterWeight: 80 },
        { name: 'Concentrate', plannedWeight: 150, dryMatterWeight: 120 }
      ]
    }
  })
  const ration = rationCreate.ration
  pushLog('ration_create', { status: 'ok', id: ration.id, ingredients: ration.ingredients?.length || 0 })

  const mainGroup = await request('POST', '/api/groups', {
    token: adminToken,
    json: {
      name: mainGroupName,
      headcount: 1,
      rationId: ration.id,
      storageZoneId: unloadZone.id
    }
  })
  pushLog('group_create', { status: 'ok', id: mainGroup.id })

  const updatedGroup = await request('PUT', `/api/groups/${mainGroup.id}`, {
    token: adminToken,
    json: {
      name: updatedGroupName,
      headcount: 1,
      rationId: ration.id,
      storageZoneId: unloadZone.id
    }
  })
  pushLog('group_update', { status: 'ok', id: updatedGroup.group?.id || mainGroup.id })

  const tempGroup = await request('POST', '/api/groups', {
    token: adminToken,
    json: {
      name: tempGroupName,
      headcount: 5,
      storageZoneId: squareBarnZone.id
    }
  })
  pushLog('group_temp_create', { status: 'ok', id: tempGroup.id })

  await request('DELETE', `/api/groups/${tempGroup.id}`, {
    token: adminToken
  })
  pushLog('group_delete', { status: 'ok', id: tempGroup.id })

  const deviceEvent = await request('POST', '/api/events', {
    json: {
      device_id: hostDeviceId,
      type: 'sms',
      timestamp: new Date().toISOString(),
      from: '+79990000000',
      text: 'E2E test event'
    }
  })
  pushLog('event_post', { status: 'ok', id: deviceEvent.id })

  const events = await request('GET', '/api/events?limit=5', {
    token: adminToken
  })
  pushLog('event_get', { status: 'ok', count: Array.isArray(events) ? events.length : 0 })

  const digestSettings = await request('PUT', '/api/digest-settings', {
    token: adminToken,
    json: {
      enabled: false,
      senderEmail: 'digest@example.com',
      sendTime: '08:00',
      timezone: 'Asia/Novosibirsk',
      recipients: ['digest@example.com']
    }
  })
  pushLog('digest_put', { status: 'ok', enabled: digestSettings.settings?.enabled ?? false })

  const digestLoaded = await request('GET', '/api/digest-settings', {
    token: adminToken
  })
  pushLog('digest_get', { status: 'ok', recipients: digestLoaded.recipients?.length || 0 })

  const baseTime = Date.now()
  const routePoints = scenarioPoints
  const driveSteps = [
    { offset: 0, label: 'outside_start', point: routePoints.yardWest, weight: 80 },
    { offset: 2, label: 'enter_circle_storage', point: routePoints.circleStorage, weight: 82 },
    { offset: 4, label: 'load_circle_storage', point: routePoints.circleStorage, weight: 170 },
    { offset: 6, label: 'exit_circle_storage', point: routePoints.yardBetweenCircleSquare, weight: 170 },
    { offset: 8, label: 'enter_square_storage', point: routePoints.squareStorage, weight: 172 },
    { offset: 10, label: 'load_square_storage', point: routePoints.squareStorage, weight: 290 },
    { offset: 12, label: 'exit_square_storage', point: routePoints.yardBetweenSquarePolygon, weight: 290 },
    { offset: 14, label: 'enter_polygon_storage', point: routePoints.polygonStorage, weight: 292 },
    { offset: 16, label: 'load_polygon_storage', point: routePoints.polygonStorage, weight: 440 },
    { offset: 18, label: 'exit_polygon_storage', point: routePoints.serviceLane, weight: 440 },
    { offset: 20, label: 'enter_square_barn', point: routePoints.squareBarn, weight: 438 },
    { offset: 22, label: 'exit_square_barn', point: routePoints.yardBeforeBarn, weight: 438 },
    { offset: 24, label: 'enter_circle_barn', point: routePoints.circleBarn, weight: 250 },
    { offset: 26, label: 'start_unload_circle_barn', point: routePoints.circleBarn, weight: 230 },
    { offset: 28, label: 'continue_unload_circle_barn', point: routePoints.circleBarn, weight: 140 },
    { offset: 30, label: 'finish_unload_circle_barn', point: routePoints.circleBarn, weight: 35 },
    { offset: 32, label: 'exit_circle_barn_empty', point: routePoints.yardEast, weight: 35 }
  ]

  for (const step of driveSteps) {
    const timestamp = isoAt(baseTime, step.offset)
    const loaderPoint = offsetPoint(step.point, 0.000015, -0.000015)
    const hostPoint = offsetPoint(step.point, -0.000012, 0.000012)

    await request('POST', '/api/telemetry/rtk', {
      json: buildRtkPacket(loaderDeviceId, timestamp, loaderPoint, {
        speed: step.label.includes('load') || step.label.includes('unload') ? 0.2 : 6.5,
        course: 45
      })
    })

    await request('POST', '/api/telemetry/host', {
      json: buildHostPacket(hostDeviceId, timestamp, hostPoint, step.weight)
    })
  }
  pushLog('telemetry_flow', {
    status: 'ok',
    hostDeviceId,
    loaderDeviceId,
    steps: driveSteps.length,
    route: driveSteps.map((step) => step.label)
  })

  const hostCurrent = await request('GET', `/api/telemetry/host/current?deviceId=${encodeURIComponent(hostDeviceId)}`, {
    token: adminToken
  })
  const rtkCurrent = await request('GET', `/api/telemetry/rtk/current?deviceId=${encodeURIComponent(loaderDeviceId)}`, {
    token: adminToken
  })
  pushLog('telemetry_current', {
    status: 'ok',
    hostMode: hostCurrent.mode,
    rtkQuality: rtkCurrent.qualityLabel || rtkCurrent.rtkQuality || null
  })

  const zoneVisitChecks = [
    ['circle_storage', circleZone.id],
    ['square_storage', squareZone.id],
    ['polygon_storage', polygonZone.id],
    ['circle_barn', unloadZone.id],
    ['square_barn', squareBarnZone.id]
  ]
  for (const [zoneKey, zoneId] of zoneVisitChecks) {
    const zoneVisit = await request(
      'GET',
      `/api/telemetry/rtk/zone/latest?zoneId=${zoneId}&seconds=120&deviceId=${encodeURIComponent(loaderDeviceId)}`,
      { token: adminToken }
    )
    if (!zoneVisit.found) {
      throw new Error(`Loader RTK did not visit expected zone: ${zoneKey}`)
    }
    pushLog('rtk_zone_visit', { status: 'ok', zoneKey, zoneId })
  }

  const batches = await request('GET', '/api/batches', {
    token: adminToken
  })
  const latestBatch = Array.isArray(batches)
    ? batches.find((batch) => batch.deviceId === hostDeviceId)
    : null
  if (!latestBatch?.id) {
    throw new Error('После телеметрии не найден ни один замес')
  }
  pushLog('batches_list', { status: 'ok', count: batches.length, latestBatchId: latestBatch.id })

  const batchDetails = await request('GET', `/api/batches/${latestBatch.id}`, {
    token: adminToken
  })
  if (batchDetails.groupId !== mainGroup.id || batchDetails.rationId !== ration.id) {
    throw new Error(`Автопривязка batch не сработала: groupId=${batchDetails.groupId}, rationId=${batchDetails.rationId}`)
  }
  if ((batchDetails.actualIngredients?.length || 0) < 3) {
    throw new Error(`Diverse drive did not record all storage-zone loads: actualIngredients=${batchDetails.actualIngredients?.length || 0}`)
  }
  pushLog('batch_details', {
    status: 'ok',
    ingredients: batchDetails.ingredients?.length || 0,
    actualIngredients: batchDetails.actualIngredients?.length || 0,
    unloadingBarn: batchDetails.unloadingInfo?.barnName || null
  })
  pushLog('batch_auto_binding', {
    status: 'ok',
    batchId: latestBatch.id,
    groupId: batchDetails.groupId,
    rationId: batchDetails.rationId
  })

  const reports = await request('GET', '/api/reports', {
    token: adminToken
  })
  pushLog('reports', {
    status: 'ok',
    batches: reports.batches?.length || 0,
    violations: reports.violations?.length || 0
  })

  const violations = await request('GET', '/api/violations', {
    token: adminToken
  })
  pushLog('violations', {
    status: 'ok',
    count: Array.isArray(violations) ? violations.length : 0
  })

  const warnings = await request('GET', '/api/telemetry/warnings/current', {
    token: adminToken
  })
  pushLog('warnings', {
    status: 'ok',
    count: warnings.items?.length || 0
  })

  const groups = await request('GET', '/api/groups', {
    token: adminToken
  })
  const zones = await request('GET', '/api/telemetry/zones?includeInactive=true', {
    token: adminToken
  })
  const users = await request('GET', '/api/users', {
    token: adminToken
  })
  pushLog('reference_lists', {
    status: 'ok',
    groups: Array.isArray(groups) ? groups.length : 0,
    zones: Array.isArray(zones) ? zones.length : 0,
    users: Array.isArray(users) ? users.length : 0
  })

  await request('DELETE', `/api/users/${createdUser.id}`, {
    token: adminToken
  })
  pushLog('user_delete', { status: 'ok', id: createdUser.id })

  const result = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    created: {
      runTag,
      hostDeviceId,
      loaderDeviceId,
      latShift,
      lonShift,
      userId: createdUser.id,
      userName,
      rationId: ration.id,
      groupId: mainGroup.id,
      circleZoneId: circleZone.id,
      squareZoneId: squareZone.id,
      polygonZoneId: polygonZone.id,
      unloadZoneId: unloadZone.id,
      squareBarnZoneId: squareBarnZone.id,
      latestBatchId: latestBatch.id
    },
    credentials: {
      admin: { username: 'admin', password: 'KorovkiTOP' },
      director: { username: 'dir', password: 'SrostkiFARM' },
      guest: { username: 'guest', password: 'pass123' }
    },
    reportSnapshot: {
      batches: reports.batches?.length || 0,
      violations: reports.violations?.length || 0,
      violationItems: Array.isArray(violations) ? violations.length : 0,
      warnings: warnings.items?.length || 0
    },
    drive: {
      hostDeviceId,
      loaderDeviceId,
      steps: driveSteps.map((step) => ({
        label: step.label,
        weight: step.weight,
        lat: step.point.lat,
        lon: step.point.lon
      }))
    },
    steps: scenarioLog
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error('[E2E] Scenario failed:', error)
  process.exitCode = 1
})

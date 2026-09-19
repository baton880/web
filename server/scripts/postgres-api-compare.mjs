import '../src/load-env.js'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import clientModule from '../generated/postgresql-client/index.js'
const prisma = new clientModule.PrismaClient()
try {
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true, role: true } })
  const token = jwt.sign(admin, process.env.JWT_SECRET, { expiresIn: '10m' })
  const paths = ['/api/batches', '/api/rations', '/api/groups', '/api/telemetry/zones', '/api/telemetry/settings',
    '/api/telemetry/host/admin/replay-days', '/api/telemetry/host/current', '/api/telemetry/host/admin/latest',
    '/api/telemetry/rtk/latest', '/api/loader/terminals', '/api/loader/groups']
  for (const route of paths) {
    const results = await Promise.all([3102, 3101].map(async port => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: `Bearer ${token}` } })
      assert.equal(response.status, 200, `${route} on ${port}`)
      return response.json()
    }))
    // Dynamic current freshness differs between independently running processes.
    if (!/current|latest/.test(route)) assert.deepEqual(results[1], results[0], route)
    else {
      for (const key of ['id', 'deviceId', 'timestamp', 'weight', 'rawWeight', 'gpsValid', 'gpsAgeS'])
        assert.deepEqual(results[1]?.[key], results[0]?.[key], `${route}.${key}`)
    }
    console.log('PASS', route)
  }
} finally { await prisma.$disconnect() }

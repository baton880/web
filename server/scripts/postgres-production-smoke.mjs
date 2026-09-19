import '../src/load-env.js'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import clientModule from '../generated/postgresql-client/index.js'
const prisma = new clientModule.PrismaClient()
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3002'
try {
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true, role: true } })
  assert.ok(admin, 'Existing administrator preserved')
  const token = jwt.sign(admin, process.env.JWT_SECRET, { expiresIn: '5m' })
  for (const route of ['/api/health','/api/batches','/api/rations','/api/groups','/api/telemetry/zones','/api/telemetry/settings','/api/telemetry/host/admin/replay-days','/api/telemetry/host/current','/api/telemetry/rtk/latest','/api/loader/terminals','/api/loader/groups']) {
    const response = await fetch(base + route, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200, route)
    await response.json()
    console.log('PASS', route)
  }
  const roles = await prisma.$queryRawUnsafe('SELECT current_database() AS database, current_user AS role')
  console.log(JSON.stringify(roles))
} finally { await prisma.$disconnect() }

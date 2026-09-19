import '../src/load-env.js'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import jwt from 'jsonwebtoken'
import clientModule from '../generated/postgresql-client/index.js'
const db = new clientModule.PrismaClient()
try {
  const expected = await db.$queryRawUnsafe(`SELECT DISTINCT to_char(timestamp AT TIME ZONE 'Asia/Barnaul', 'YYYY-MM-DD') AS date FROM "Telemetry" ORDER BY date DESC LIMIT 120`)
  const admin = await db.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true, role: true } })
  const token = jwt.sign(admin, process.env.JWT_SECRET, { expiresIn: '5m' })
  const start = performance.now()
  const response = await fetch('http://127.0.0.1:3101/api/telemetry/host/admin/replay-days', { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).dates, expected.map(r => r.date))
  console.log('PASS indexed replay-days: identical UTC+7 calendar days, API ms=', performance.now()-start)
} finally { await db.$disconnect() }

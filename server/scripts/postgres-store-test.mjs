import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import clientModule from '../generated/postgresql-client/index.js'
import { PostgresLoaderTaskStore, PostgresLoaderTerminalStore } from '../src/modules/loader/loader-postgres-store.js'
import { buildLoaderPlan } from '../src/modules/loader/loader-plan.js'
const url = process.env.TEST_POSTGRES_DATABASE_URL
if (!url || !new URL(url).pathname.startsWith('/farm_test')) throw Error('An isolated farm_test* database is required')
const prisma = new clientModule.PrismaClient({ datasources: { db: { url } } })
const other = new clientModule.PrismaClient({ datasources: { db: { url } } })
const tasks = new PostgresLoaderTaskStore(prisma), concurrent = new PostgresLoaderTaskStore(other)
const terminals = new PostgresLoaderTerminalStore(prisma)
const actor = { id: 1, role: 'DIRECTOR', password: 'isolated-test-password-hash' }
const deviceId = `test-${randomUUID()}`
const group = { id: 1, name: 'Test', headcount: 1, ration: { id: 1, name: 'Test', isActive: true, feedingsPerDay: 1,
  ingredients: [{ id: 1, name: 'Silage', plannedWeight: 100, sortOrder: 1 }] } }
const plan = buildLoaderPlan(group)
const body = { id: randomUUID(), deviceId, groupId: 1, planRevision: plan.planRevision }
try {
  await prisma.user.upsert({ where: { id: 1 }, create: { ...actor, username: 'pg-test' }, update: {} })
  const simultaneous = await Promise.allSettled([tasks.create(body, plan, actor), concurrent.create({ ...body, id: randomUUID() }, plan, actor)])
  assert.equal(simultaneous.filter(r => r.status === 'fulfilled').length, 1, 'Only one active task under concurrency')
  let task = simultaneous.find(r => r.status === 'fulfilled').value
  const at = Date.now() - 1000
  const event = { id: randomUUID(), revision: 0, type: 'begin', at,
    reading: { deviceId, valid: true, weightKg: 500, timestampMs: at } }
  const acks = await Promise.all([tasks.apply(task.id, event, actor), concurrent.apply(task.id, event, actor)])
  assert.deepEqual(acks[0], acks[1], 'Concurrent retry acknowledged without a second event')
  assert.equal((await tasks.events(task.id, actor)).length, 1)
  task = acks[0].task
  await assert.rejects(tasks.apply(task.id, { ...event, id: randomUUID(), revision: 0 }, actor), /изменилось/)
  await assert.rejects(tasks.apply(task.id, { ...event, reading: { ...event.reading, weightKg: 501 } }, actor), /содержимым/)
  assert.equal((await tasks.get(task.id, actor)).revision, 1)
  await assert.rejects(tasks.get(task.id, { id: 99, role: 'DIRECTOR' }), /другого оператора/)
  const id = randomUUID(), registration = { id, name: 'Test tablet', deviceId, key: `vkt1_${id}_${randomBytes(32).toString('base64url')}` }
  const registered = await terminals.register(registration, actor)
  assert.deepEqual(await terminals.register(registration, actor), registered)
  assert.equal((await terminals.authenticate(registration.key)).terminalDeviceId, deviceId)
  assert.ok(!JSON.stringify(await terminals.list(actor)).includes('keyHash'))
  await terminals.revoke(id, actor)
  await assert.rejects(terminals.authenticate(registration.key), /отозван/)
  await assert.rejects(terminals.register(registration, actor), /отозвана/)
  // An error after an insert must roll back the whole PG transaction.
  const stateKey = randomUUID()
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.appState.create({ data: { key: stateKey, value: 'never committed', updatedAt: new Date().toISOString() } })
    throw Error('forced rollback')
  }), /forced rollback/)
  assert.equal(await prisma.appState.findUnique({ where: { key: stateKey } }), null)
  console.log('PASS PostgreSQL: concurrent task creation, concurrent duplicate ACK, revision conflict, atomic rejection, owner isolation, terminal persistence/revocation, transaction rollback')
} finally {
  await prisma.$disconnect(); await other.$disconnect()
}

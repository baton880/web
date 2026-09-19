import { createHash, timingSafeEqual } from 'node:crypto'
import { TaskError, check, uuid, canonical, reduceTask } from './loader-task-store.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const keyParts = key => typeof key === 'string' ? /^vkt1_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/.exec(key) : null
const safeTerminal = row => ({ id: row.id, name: row.name, deviceId: row.deviceId, ownerId: row.ownerId,
  createdAt: Number(row.createdAt), lastSeenAt: row.lastSeenAt == null ? null : Number(row.lastSeenAt),
  revokedAt: row.revokedAt == null ? null : Number(row.revokedAt) })

async function locked(prisma, scope, action) {
  return prisma.$transaction(async tx => {
    // Transaction-scoped and shared by all processes connected to this farm DB.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))::text`
    return action(tx)
  }, { maxWait: 5000, timeout: 10000 })
}

function authorize(row, actor) {
  check(row, 'Задание не найдено', 404)
  check(!actor.terminalDeviceId || row.deviceId === actor.terminalDeviceId, 'Задание другого Хозяина', 403)
  check(row.ownerId === actor.id || (actor.role === 'ADMIN' && !actor.terminalId), 'Задание другого оператора', 403)
  return row
}

export class PostgresLoaderTaskStore {
  constructor(prisma) { this.prisma = prisma }
  async row(id, actor, db = this.prisma) { return authorize(await db.loaderTask.findUnique({ where: { id } }), actor) }
  async get(id, actor) { return JSON.parse((await this.row(id, actor)).state) }
  async findExisting(id, actor) {
    const row = await this.prisma.loaderTask.findUnique({ where: { id } })
    return row ? JSON.parse(authorize(row, actor).state) : null
  }
  async list(deviceId, actor) {
    const rows = await this.prisma.loaderTask.findMany({ where: { deviceId,
      ...(actor.role === 'ADMIN' && !actor.terminalId ? {} : { ownerId: actor.id }) }, orderBy: { createdAt: 'desc' }, take: 50 })
    return rows.map(row => JSON.parse(row.state))
  }
  async active(deviceId, actor) {
    const row = await this.prisma.loaderTask.findFirst({ where: { deviceId, status: { in: ['ready', 'active'] } } })
    if (!row) return null
    check(!actor.terminalDeviceId || row.deviceId === actor.terminalDeviceId, 'Задание другого Хозяина', 403)
    check(row.ownerId === actor.id || (actor.role === 'ADMIN' && !actor.terminalId), 'У Хозяина уже есть задание другого оператора', 409)
    return JSON.parse(row.state)
  }
  async create(body, plan, actor) {
    check(uuid(body.id), 'Некорректный ID задания')
    check(typeof body.deviceId === 'string' && body.deviceId.length > 0 && body.deviceId.length <= 120, 'Некорректный Хозяин')
    return locked(this.prisma, `loader-device:${body.deviceId}`, async tx => {
      const row = await tx.loaderTask.findUnique({ where: { id: body.id } })
      if (row) {
        const existing = JSON.parse(authorize(row, actor).state)
        check(existing.deviceId === body.deviceId && existing.groupId === body.groupId && existing.planRevision === body.planRevision, 'ID задания использован с другими параметрами', 409)
        return existing
      }
      check(body.planRevision === plan.planRevision, 'Рацион изменился. Обновите план перед запуском', 409)
      check(!await tx.loaderTask.findFirst({ where: { deviceId: body.deviceId, status: { in: ['ready', 'active'] } } }), 'У Хозяина уже есть незавершённое задание', 409)
      const state = { ...structuredClone(plan), id: body.id, deviceId: body.deviceId, ownerId: actor.id,
        createdAt: Date.now(), revision: 0, currentIndex: 0, status: 'ready' }
      try {
        await tx.loaderTask.create({ data: { id: state.id, deviceId: state.deviceId, ownerId: actor.id,
          status: state.status, createdAt: BigInt(state.createdAt), state: JSON.stringify(state) } })
      } catch (error) { if (error.code === 'P2002') throw new TaskError(409, 'Задание уже изменилось. Требуется сверка'); throw error }
      return state
    })
  }
  async apply(id, event, actor) {
    const initial = await this.row(id, actor)
    return locked(this.prisma, `loader-device:${initial.deviceId}`, async tx => {
      const task = JSON.parse((await this.row(id, actor, tx)).state)
      const duplicate = await tx.loaderTaskEvent.findUnique({ where: { id: event.id } })
      if (duplicate) {
        check(duplicate.taskId === id && duplicate.payload === canonical(event), 'ID события использован с другим содержимым', 409)
        return { acknowledged: event.id, task }
      }
      const next = reduceTask(task, event)
      if (['ready', 'active'].includes(next.status)) check(!await tx.loaderTask.findFirst({ where: {
        deviceId: next.deviceId, id: { not: id }, status: { in: ['ready', 'active'] } } }), 'Создано другое задание. Требуется сверка', 409)
      try {
        await tx.loaderTaskEvent.create({ data: { id: event.id, taskId: id, revision: next.revision,
          receivedAt: BigInt(Date.now()), payload: canonical(event) } })
        await tx.loaderTask.update({ where: { id }, data: { status: next.status, state: JSON.stringify(next) } })
      } catch (error) { if (error.code === 'P2002') throw new TaskError(409, 'Событие уже изменилось. Требуется сверка'); throw error }
      return { acknowledged: event.id, task: next }
    })
  }
  async events(id, actor) {
    await this.row(id, actor)
    return (await this.prisma.loaderTaskEvent.findMany({ where: { taskId: id }, orderBy: { revision: 'asc' } }))
      .map(row => ({ ...JSON.parse(row.payload), receivedAt: Number(row.receivedAt) }))
  }
  close() {} // The application owns the Prisma client.
}

export class PostgresLoaderTerminalStore {
  constructor(prisma) { this.prisma = prisma }
  async register(body, user) {
    const parts = keyParts(body?.key)
    check(parts && parts[1] === body.id, 'Некорректный ключ терминала')
    check(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 80, 'Укажите название планшета')
    check(typeof body.deviceId === 'string' && body.deviceId.trim().length > 0 && body.deviceId.length <= 120, 'Укажите Хозяина')
    check(['ADMIN', 'DIRECTOR'].includes(user?.role), 'Регистрация доступна администратору или директору', 403)
    return locked(this.prisma, `loader-owner:${user.id}`, async tx => {
      const old = await tx.loaderTerminal.findUnique({ where: { id: body.id } })
      if (old) {
        check(!old.revokedAt && old.ownerId === user.id && old.deviceId === body.deviceId && old.keyHash === digest(body.key) && old.passwordVersion === digest(user.password), 'Регистрация уже изменена или отозвана', 409)
        return safeTerminal(old)
      }
      check(await tx.loaderTerminal.count({ where: { ownerId: user.id, revokedAt: null } }) < 100, 'Слишком много активных терминалов. Отзовите неиспользуемые', 409)
      return safeTerminal(await tx.loaderTerminal.create({ data: { id: body.id, name: body.name.trim(), deviceId: body.deviceId,
        ownerId: user.id, keyHash: digest(body.key), passwordVersion: digest(user.password), createdAt: BigInt(Date.now()) } }))
    })
  }
  async authenticate(key, prisma = this.prisma) {
    const parts = keyParts(key)
    check(parts, 'Неверный ключ терминала', 401)
    const row = await this.prisma.loaderTerminal.findUnique({ where: { id: parts[1] } })
    check(row && !row.revokedAt && timingSafeEqual(Buffer.from(row.keyHash, 'hex'), Buffer.from(digest(key), 'hex')), 'Доступ планшета отозван. Требуется регистрация', 401)
    const user = await prisma.user.findUnique({ where: { id: row.ownerId }, select: { id: true, role: true, password: true } })
    if (!user || !['ADMIN', 'DIRECTOR'].includes(user.role) || digest(user.password) !== row.passwordVersion) {
      await this.prisma.loaderTerminal.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: BigInt(Date.now()) } })
      throw new TaskError(401, 'Учётная запись изменена. Зарегистрируйте планшет повторно')
    }
    if (!row.lastSeenAt || Date.now() - Number(row.lastSeenAt) >= 60000)
      await this.prisma.loaderTerminal.updateMany({ where: { id: row.id, revokedAt: null }, data: { lastSeenAt: BigInt(Date.now()) } })
    return { id: user.id, role: user.role, terminalId: row.id, terminalDeviceId: row.deviceId, terminalName: row.name }
  }
  async list(actor) {
    return (await this.prisma.loaderTerminal.findMany({ where: actor.role === 'ADMIN' ? {} : { ownerId: actor.id }, orderBy: { createdAt: 'desc' }, take: 200 })).map(safeTerminal)
  }
  async revoke(id, actor) {
    const row = await this.prisma.loaderTerminal.findUnique({ where: { id } })
    check(row && (row.ownerId === actor.id || actor.role === 'ADMIN'), 'Терминал не найден', 404)
    await this.prisma.loaderTerminal.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: BigInt(Date.now()) } })
  }
}

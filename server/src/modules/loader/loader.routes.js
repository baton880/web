import { Router } from 'express'
import { buildLoaderPlan, isLoaderGroupAvailable } from './loader-plan.js'
import { TaskError } from './loader-task-store.js'
import { signPlan, verifyPlan } from './offline-plan.js'

// Authentication is mounted by index.js; the factory also enables isolated HTTP tests.
export function createLoaderRouter({ prisma, store, terminals, weightHandler, remote, offlineKey = process.env.LOADER_OFFLINE_PLAN_KEY || process.env.JWT_SECRET }) {
  const router = Router()
  router.use((req, res, next) => {
    if (!req.user || !['ADMIN', 'DIRECTOR', 'GUEST'].includes(req.user.role)) return res.status(403).json({ error: 'Нет доступа к заданиям' })
    res.set('Cache-Control', 'no-store')
    next()
  })
  const assignedDevice = (req, res, next) => {
    const device = req.method === 'POST' ? req.body?.deviceId : req.query.deviceId
    if (req.user.terminalId && device !== req.user.terminalDeviceId) return res.status(403).json({ error: 'Терминал привязан к другому Хозяину' })
    next()
  }
  const wrap = fn => async (req, res, next) => { try { await fn(req, res) } catch (error) { next(error) } }
  const writer = (req, res, next) => ['ADMIN', 'DIRECTOR'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Для ведения заданий нужны права директора или администратора' })
  router.get('/session', (req,res) => res.json({ userId:req.user.id, terminalId:req.user.terminalId || null, deviceId:req.user.terminalDeviceId || null, name:req.user.terminalName || null }))
  router.get('/dashboard', wrap(async (req, res) => {
    if (req.user.terminalId) return res.status(403).json({ error: 'Только для сайта' })
    const registered = prisma.loaderTerminal
      ? await prisma.loaderTerminal.findMany({ where: { revokedAt: null }, select: { id: true, name: true, deviceId: true, lastSeenAt: true }, orderBy: { createdAt: 'desc' }, take: 20 })
      : (terminals ? (await terminals.list({ ...req.user, role: 'ADMIN' })).filter(item => !item.revokedAt) : [])
    const devices = await Promise.all(registered.map(async terminal => {
      const row = prisma.loaderTask
        ? await prisma.loaderTask.findFirst({ where: { deviceId: terminal.deviceId, status: { in: ['ready', 'active'] } }, orderBy: { createdAt: 'desc' }, select: { state: true } })
        : null
      const task = row ? JSON.parse(row.state) : (prisma.loaderTask ? null : (await store.list(terminal.deviceId, { ...req.user, role: 'ADMIN' })).find(item => ['ready', 'active'].includes(item.status)) || null)
      const heartbeat = remote ? remote.status(terminal.id) : null
      return {
        id: terminal.id, name: terminal.name, deviceId: terminal.deviceId,
        lastSeenAt: Number(heartbeat?.lastSeenAt || terminal.lastSeenAt || 0) || null,
        version: heartbeat?.version || null,
        task: task ? {
          status: task.status, groupName: task.groupName, rationName: task.rationName,
          currentIndex: task.currentIndex, totalKg: task.totalKg,
          steps: task.steps.map(step => ({ name: step.name, targetKg: step.targetKg,
            actualKg: step.actualKg ?? null, baselineKg: step.baseline?.weightKg ?? null }))
        } : null
      }
    }))
    res.json({ devices })
  }))
  if(remote) {
    const terminalOnly=(req,res,next)=>req.user.terminalId?next():res.status(403).json({error:'Нужен ключ планшета'})
    router.post('/remote/poll',terminalOnly,wrap(async(req,res)=>res.json({command:remote.heartbeat(req.user.terminalId,req.body||{})})))
    router.post('/remote/result',terminalOnly,wrap(async(req,res)=>{remote.result(req.user.terminalId,req.body||{});res.json({ok:true})}))
  }
  if (weightHandler) router.get('/weight', assignedDevice, weightHandler)
  const include = { ration: { include: { ingredients: true } } }
  router.get('/groups', wrap(async (req, res) => {
    const groups = await prisma.livestockGroup.findMany({ include, orderBy: { name: 'asc' } })
    res.json({ groups: groups.filter(isLoaderGroupAvailable).map(g => ({ id: g.id, name: g.name, plan: signPlan(buildLoaderPlan(g), req.user, offlineKey) })) })
  }))
  router.get('/tasks', assignedDevice, wrap(async (req, res) => res.json({ tasks: await store.list(String(req.query.deviceId || ''), req.user) })))
  router.get('/tasks/active', assignedDevice, wrap(async (req, res) => res.json({ task: await store.active(String(req.query.deviceId || ''), req.user) })))
  router.get('/tasks/:id', wrap(async (req, res) => res.json({ task: await store.get(req.params.id, req.user), events: await store.events(req.params.id, req.user) })))
  router.post('/tasks', writer, assignedDevice, wrap(async (req, res) => {
    const body = req.body
    if (!body || !Number.isSafeInteger(body.groupId) || body.groupId <= 0) throw new TaskError(400, 'Некорректная группа')
    // Retry must return the original snapshot even if its source ration changed or was deleted.
    const existing = typeof body.id === 'string' ? await store.findExisting(body.id, req.user) : null
    if (existing) return res.json({ task: await store.create(body, existing, req.user) })
    if (body.offlineToken) {
      const plan = verifyPlan(body.offlineToken, req.user, body.deviceId, offlineKey)
      if (plan.groupId !== body.groupId) throw new TaskError(400, 'Группа не совпадает с автономным планом')
      return res.status(201).json({ task: await store.create(body, plan, req.user) })
    }
    const group = await prisma.livestockGroup.findUnique({ where: { id: body.groupId }, include })
    const plan = buildLoaderPlan(group)
    if (!plan) throw new TaskError(400, 'У группы нет корректного плана загрузки')
    res.status(201).json({ task: await store.create(body, plan, req.user) })
  }))
  router.post('/tasks/:id/events', writer, wrap(async (req, res) => {
    if (!req.body || typeof req.body.id !== 'string') throw new TaskError(400, 'Некорректное событие')
    res.json(await store.apply(req.params.id, req.body, req.user))
  }))
  router.use((error, req, res, next) => {
    if (error instanceof TaskError) return res.status(error.status).json({ error: error.message })
    console.error('[Loader tasks]', error.message)
    res.status(500).json({ error: 'Не удалось обработать задание' })
  })
  return router
}

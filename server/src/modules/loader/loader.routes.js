import { Router } from 'express'
import { buildLoaderPlan, isLoaderGroupAvailable } from './loader-plan.js'
import { TaskError } from './loader-task-store.js'

// Authentication is mounted by index.js; the factory also enables isolated HTTP tests.
export function createLoaderRouter({ prisma, store, weightHandler }) {
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
  if (weightHandler) router.get('/weight', assignedDevice, weightHandler)
  const include = { ration: { include: { ingredients: true } } }
  router.get('/groups', wrap(async (req, res) => {
    const groups = await prisma.livestockGroup.findMany({ include, orderBy: { name: 'asc' } })
    res.json({ groups: groups.filter(isLoaderGroupAvailable).map(g => ({ id: g.id, name: g.name, plan: buildLoaderPlan(g) })) })
  }))
  router.get('/tasks', assignedDevice, wrap(async (req, res) => res.json({ tasks: store.list(String(req.query.deviceId || ''), req.user) })))
  router.get('/tasks/active', assignedDevice, wrap(async (req, res) => res.json({ task: store.active(String(req.query.deviceId || ''), req.user) })))
  router.get('/tasks/:id', wrap(async (req, res) => res.json({ task: store.get(req.params.id, req.user), events: store.events(req.params.id, req.user) })))
  router.post('/tasks', writer, assignedDevice, wrap(async (req, res) => {
    const body = req.body
    if (!body || !Number.isSafeInteger(body.groupId) || body.groupId <= 0) throw new TaskError(400, 'Некорректная группа')
    // Retry must return the original snapshot even if its source ration changed or was deleted.
    const existing = typeof body.id === 'string' ? store.findExisting(body.id, req.user) : null
    if (existing) return res.json({ task: store.create(body, existing, req.user) })
    const group = await prisma.livestockGroup.findUnique({ where: { id: body.groupId }, include })
    const plan = buildLoaderPlan(group)
    if (!plan) throw new TaskError(400, 'У группы нет корректного плана загрузки')
    res.status(201).json({ task: store.create(body, plan, req.user) })
  }))
  router.post('/tasks/:id/events', writer, wrap(async (req, res) => {
    if (!req.body || typeof req.body.id !== 'string') throw new TaskError(400, 'Некорректное событие')
    res.json(store.apply(req.params.id, req.body, req.user))
  }))
  router.use((error, req, res, next) => {
    if (error instanceof TaskError) return res.status(error.status).json({ error: error.message })
    console.error('[Loader tasks]', error.message)
    res.status(500).json({ error: 'Не удалось обработать задание' })
  })
  return router
}

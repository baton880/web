import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { TaskError } from './loader-task-store.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const keyParts = key => typeof key === 'string' ? /^vkt1_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/.exec(key) : null
const safe = row => ({ id: row.id, name: row.name, deviceId: row.deviceId, ownerId: row.ownerId,
  createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, revokedAt: row.revokedAt })
const fail = (condition, status, message) => { if (!condition) throw new TaskError(status, message) }

export class LoaderTerminalStore {
  constructor(db) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS LoaderTerminal(id TEXT PRIMARY KEY, name TEXT NOT NULL, deviceId TEXT NOT NULL,
      ownerId INTEGER NOT NULL, keyHash TEXT NOT NULL, passwordVersion TEXT NOT NULL, createdAt INTEGER NOT NULL,
      lastSeenAt INTEGER, revokedAt INTEGER); CREATE INDEX IF NOT EXISTS LoaderTerminal_owner ON LoaderTerminal(ownerId);`)
  }
  register(body, user) {
    const parts = keyParts(body?.key)
    fail(parts && parts[1] === body.id, 400, 'Некорректный ключ терминала')
    fail(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 80, 400, 'Укажите название планшета')
    fail(typeof body.deviceId === 'string' && body.deviceId.trim().length > 0 && body.deviceId.length <= 120, 400, 'Укажите Хозяина')
    fail(['ADMIN', 'DIRECTOR'].includes(user?.role), 403, 'Регистрация доступна администратору или директору')
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT * FROM LoaderTerminal WHERE id=?').get(body.id)
      if (old) {
        fail(!old.revokedAt && old.ownerId === user.id && old.deviceId === body.deviceId && old.keyHash === digest(body.key) && old.passwordVersion === digest(user.password), 409, 'Регистрация уже изменена или отозвана')
        return safe(old)
      }
      fail(this.db.prepare('SELECT COUNT(*) AS n FROM LoaderTerminal WHERE ownerId=? AND revokedAt IS NULL').get(user.id).n < 100, 409, 'Слишком много активных терминалов. Отзовите неиспользуемые')
      const now = Date.now()
      this.db.prepare('INSERT INTO LoaderTerminal VALUES (?,?,?,?,?,?,?,NULL,NULL)').run(body.id, body.name.trim(), body.deviceId, user.id, digest(body.key), digest(user.password), now)
      return safe(this.db.prepare('SELECT * FROM LoaderTerminal WHERE id=?').get(body.id))
    })()
  }
  async authenticate(key, prisma) {
    const parts = keyParts(key)
    fail(parts, 401, 'Неверный ключ терминала')
    const row = this.db.prepare('SELECT * FROM LoaderTerminal WHERE id=?').get(parts[1])
    fail(row && !row.revokedAt && timingSafeEqual(Buffer.from(row.keyHash, 'hex'), Buffer.from(digest(key), 'hex')), 401, 'Доступ планшета отозван. Требуется регистрация')
    const user = await prisma.user.findUnique({ where: { id: row.ownerId }, select: { id: true, role: true, password: true } })
    if (!user || !['ADMIN', 'DIRECTOR'].includes(user.role) || digest(user.password) !== row.passwordVersion) {
      this.db.prepare('UPDATE LoaderTerminal SET revokedAt=? WHERE id=? AND revokedAt IS NULL').run(Date.now(), row.id)
      throw new TaskError(401, 'Учётная запись изменена. Зарегистрируйте планшет повторно')
    }
    if (!row.lastSeenAt || Date.now() - row.lastSeenAt >= 60000)
      this.db.prepare('UPDATE LoaderTerminal SET lastSeenAt=? WHERE id=? AND revokedAt IS NULL').run(Date.now(), row.id)
    return { id: user.id, role: user.role, terminalId: row.id, terminalDeviceId: row.deviceId, terminalName: row.name }
  }
  list(actor) {
    return this.db.prepare("SELECT * FROM LoaderTerminal WHERE ownerId=? OR ?='ADMIN' ORDER BY createdAt DESC LIMIT 200")
      .all(actor.id, actor.role).map(safe)
  }
  revoke(id, actor) {
    const row = this.db.prepare('SELECT * FROM LoaderTerminal WHERE id=?').get(id)
    fail(row && (row.ownerId === actor.id || actor.role === 'ADMIN'), 404, 'Терминал не найден')
    this.db.prepare('UPDATE LoaderTerminal SET revokedAt=COALESCE(revokedAt,?) WHERE id=?').run(Date.now(), id)
  }
}

export function createLoaderAuthentication({ authenticate, prisma, terminals }) {
  return async (req, res, next) => {
    const header = req.headers.authorization || ''
    if (!header.startsWith('Bearer vkt1_')) return authenticate(req, res, next)
    res.set('Cache-Control', 'no-store')
    try { req.user = await terminals.authenticate(header.slice(7), prisma); next() }
    catch (error) { res.status(error instanceof TaskError ? error.status : 503).json({ error: error instanceof TaskError ? error.message : 'Проверка терминала временно недоступна' }) }
  }
}

// Mounted before terminal-capable routes, with regular site JWT authentication only.
export function createTerminalManagementRouter({ prisma, terminals }) {
  const router = Router()
  router.use((req,res,next) => {
    res.set('Cache-Control','no-store')
    if (!['ADMIN','DIRECTOR'].includes(req.user?.role) || req.user.terminalId) return res.status(403).json({error:'Войдите на сайт как директор или администратор'})
    next()
  })
  const wrap = action => async (req,res,next) => { try { await action(req,res) } catch(error) { next(error) } }
  router.get('/', wrap(async (req,res) => res.json({terminals:terminals.list(req.user)})))
  router.post('/', wrap(async (req,res) => {
    const user = await prisma.user.findUnique({where:{id:req.user.id},select:{id:true,role:true,password:true}})
    res.status(201).json({terminal:terminals.register(req.body,user)})
  }))
  router.post('/:id/revoke', wrap(async(req,res) => {terminals.revoke(req.params.id,req.user);res.json({ok:true})}))
  router.use((error,req,res,next) => res.status(error instanceof TaskError ? error.status : 500).json({error:error instanceof TaskError ? error.message:'Не удалось обработать регистрацию'}))
  return router
}

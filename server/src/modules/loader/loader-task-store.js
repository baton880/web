import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export class TaskError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
function check(condition, message, status = 400) { if (!condition) throw new TaskError(status, message) }
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
function measurement(value, deviceId, at) {
  check(value && value.deviceId === deviceId && value.valid === true, 'Нет валидного измерения Хозяина')
  check(typeof value.weightKg === 'number' && Number.isFinite(value.weightKg), 'Некорректный вес')
  check(Number.isSafeInteger(value.timestampMs) && value.timestampMs > 0 && Math.abs(at - value.timestampMs) <= 5000, 'Подтверждение требует свежего измерения')
  return { weightKg: value.weightKg, timestampMs: value.timestampMs, packetId: value.packetId ?? null, deviceId, valid: true }
}

export function reduceTask(task, event) {
  check(uuid(event.id), 'Некорректный ID события')
  check(event.revision === task.revision, 'Состояние задания изменилось. Требуется сверка', 409)
  check(Number.isSafeInteger(event.at) && event.at > 0 && event.at <= Date.now() + 30000, 'Некорректное время события')
  check(task.status !== 'cancelled', 'Задание отменено', 409)
  check(!task.lastEventAt || event.at >= task.lastEventAt, 'Нарушен порядок событий', 409)
  const next = structuredClone(task)
  if (event.type === 'cancel') {
    check(task.status !== 'completed', 'Завершённое задание нельзя отменить', 409)
    check(typeof event.reason === 'string' && event.reason.trim().length > 0 && event.reason.length <= 500, 'Нужна причина отмены')
    next.status = 'cancelled'
    next.cancelReason = event.reason.trim()
  } else {
    const reading = measurement(event.reading, task.deviceId, event.at)
    if (event.type === 'begin') {
      check(task.status === 'ready', 'Задание уже начато', 409)
      next.status = 'active'
      next.steps[0].baseline = reading
    } else if (event.type === 'confirm') {
      check(task.status === 'active' && event.stepIndex === task.currentIndex, 'Компонент уже изменился', 409)
      const step = next.steps[next.currentIndex]
      check(reading.timestampMs >= step.baseline.timestampMs, 'Измерение старее начала компонента')
      const actual = reading.weightKg - step.baseline.weightKg
      check(actual >= -5, 'Вес уменьшился. Проверьте весы и задание')
      step.end = reading
      step.actualKg = Math.max(0, actual)
      step.confirmedAt = event.at
      next.currentIndex++
      if (next.currentIndex === next.steps.length) next.status = 'completed'
      else next.steps[next.currentIndex].baseline = reading
    } else if (event.type === 'undo') {
      check(task.currentIndex > 0 && task.lastEventType === 'confirm', 'Можно отменить только последнее подтверждение', 409)
      const previous = next.steps[next.currentIndex - 1]
      check(reading.timestampMs >= previous.end.timestampMs && Math.abs(reading.weightKg - previous.end.weightKg) <= 5, 'Следующий компонент уже загружается: автоматический возврат запрещён', 409)
      if (next.currentIndex < next.steps.length) delete next.steps[next.currentIndex].baseline
      delete previous.end; delete previous.actualKg; delete previous.confirmedAt
      next.currentIndex--
      next.status = 'active'
    } else throw new TaskError(400, 'Неизвестное действие')
  }
  next.revision++
  next.lastEventAt = event.at
  next.lastEventType = event.type
  return next
}

export class LoaderTaskStore {
  constructor(filename = process.env.LOADER_TASK_DATABASE_PATH || fileURLToPath(new URL('../../../runtime/loader-tasks.sqlite3', import.meta.url))) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 5000')
    this.db.exec(`CREATE TABLE IF NOT EXISTS LoaderTask(id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, ownerId INTEGER NOT NULL,
      status TEXT NOT NULL, createdAt INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS LoaderTask_one_active ON LoaderTask(deviceId) WHERE status IN ('ready','active');
      CREATE TABLE IF NOT EXISTS LoaderTaskEvent(id TEXT PRIMARY KEY, taskId TEXT NOT NULL, revision INTEGER NOT NULL,
      receivedAt INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(taskId, revision));`)
  }
  row(id, actor) {
    const row = this.db.prepare('SELECT * FROM LoaderTask WHERE id=?').get(id)
    check(row, 'Задание не найдено', 404)
    check(row.ownerId === actor.id || actor.role === 'ADMIN', 'Задание другого оператора', 403)
    return row
  }
  get(id, actor) { return JSON.parse(this.row(id, actor).state) }
  findExisting(id, actor) { return this.db.prepare('SELECT id FROM LoaderTask WHERE id=?').get(id) ? this.get(id, actor) : null }
  list(deviceId, actor) {
    return this.db.prepare(`SELECT state FROM LoaderTask WHERE deviceId=? AND (ownerId=? OR ?='ADMIN') ORDER BY createdAt DESC LIMIT 50`)
      .all(deviceId, actor.id, actor.role).map(r => JSON.parse(r.state))
  }
  active(deviceId, actor) {
    const row = this.db.prepare("SELECT * FROM LoaderTask WHERE deviceId=? AND status IN ('ready','active')").get(deviceId)
    if (!row) return null
    check(row.ownerId === actor.id || actor.role === 'ADMIN', 'У Хозяина уже есть задание другого оператора', 409)
    return JSON.parse(row.state)
  }
  create(body, plan, actor) {
    check(uuid(body.id), 'Некорректный ID задания')
    check(typeof body.deviceId === 'string' && body.deviceId.length > 0 && body.deviceId.length <= 120, 'Некорректный Хозяин')
    return this.db.transaction(() => {
      const existing = this.findExisting(body.id, actor)
      if (existing) {
        check(existing.deviceId === body.deviceId && existing.groupId === body.groupId && existing.planRevision === body.planRevision, 'ID задания использован с другими параметрами', 409)
        return existing
      }
      check(body.planRevision === plan.planRevision, 'Рацион изменился. Обновите план перед запуском', 409)
      check(!this.db.prepare("SELECT id FROM LoaderTask WHERE deviceId=? AND status IN ('ready','active')").get(body.deviceId), 'У Хозяина уже есть незавершённое задание', 409)
      const state = { ...structuredClone(plan), id: body.id, deviceId: body.deviceId, ownerId: actor.id,
        createdAt: Date.now(), revision: 0, currentIndex: 0, status: 'ready' }
      this.db.prepare('INSERT INTO LoaderTask VALUES (?,?,?,?,?,?)').run(state.id, state.deviceId, actor.id, state.status, state.createdAt, JSON.stringify(state))
      return state
    })()
  }
  apply(id, event, actor) {
    return this.db.transaction(() => {
      const task = this.get(id, actor)
      const duplicate = this.db.prepare('SELECT * FROM LoaderTaskEvent WHERE id=?').get(event.id)
      if (duplicate) {
        check(duplicate.taskId === id && duplicate.payload === canonical(event), 'ID события использован с другим содержимым', 409)
        return { acknowledged: event.id, task }
      }
      const next = reduceTask(task, event)
      if (['ready', 'active'].includes(next.status)) {
        check(!this.db.prepare("SELECT id FROM LoaderTask WHERE deviceId=? AND id<>? AND status IN ('ready','active')").get(next.deviceId, id), 'Создано другое задание. Требуется сверка', 409)
      }
      this.db.prepare('INSERT INTO LoaderTaskEvent VALUES (?,?,?,?,?)').run(event.id, id, next.revision, Date.now(), canonical(event))
      this.db.prepare('UPDATE LoaderTask SET status=?,state=? WHERE id=?').run(next.status, JSON.stringify(next), id)
      return { acknowledged: event.id, task: next }
    })()
  }
  events(id, actor) { this.row(id, actor); return this.db.prepare('SELECT receivedAt,payload FROM LoaderTaskEvent WHERE taskId=? ORDER BY revision').all(id).map(r => ({ ...JSON.parse(r.payload), receivedAt: r.receivedAt })) }
  close() { this.db.close() }
}

import { createHmac, timingSafeEqual } from 'node:crypto'
import { check } from './loader-task-store.js'

// Separate domain from JWTs. Keep the key stable across deployments.
const mac = (data, key) => createHmac('sha256', key).update('loader-offline-v1:' + data).digest('base64url')
export function signPlan(plan, actor, key) {
  if (!plan || !key || !actor.terminalId) return plan
  const payload = Buffer.from(JSON.stringify({ plan, ownerId: actor.id, terminalId: actor.terminalId,
    deviceId: actor.terminalDeviceId })).toString('base64url')
  return { ...plan, offlineToken: payload + '.' + mac(payload, key) }
}
export function verifyPlan(token, actor, deviceId, key) {
  check(key && typeof token === 'string' && token.length < 60000, 'Нет подписанного автономного плана')
  const parts = token.split('.')
  check(parts.length === 2, 'Некорректная подпись плана')
  const expected = Buffer.from(mac(parts[0], key)), actual = Buffer.from(parts[1])
  check(expected.length === actual.length && timingSafeEqual(expected, actual), 'Подпись плана не совпадает', 403)
  let value
  try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) } catch { check(false, 'Некорректный план') }
  check(value.ownerId === actor.id && value.terminalId === actor.terminalId && value.deviceId === deviceId,
    'Автономный план другого планшета или Хозяина', 403)
  return value.plan
}

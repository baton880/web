export const FARM_TIME_ZONE = 'Asia/Novosibirsk'
export const FARM_UTC_OFFSET_MINUTES = 7 * 60

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function getFarmDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: FARM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${byType.year}-${byType.month}-${byType.day}`
}

export function parseFarmDateOnly(value) {
  const match = DATE_ONLY_RE.exec(String(value || '').trim())
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utcCheck = new Date(Date.UTC(year, month - 1, day))

  if (
    utcCheck.getUTCFullYear() !== year ||
    utcCheck.getUTCMonth() !== month - 1 ||
    utcCheck.getUTCDate() !== day
  ) {
    return null
  }

  return { year, month, day }
}

export function farmDateBoundary(value, kind = 'from') {
  const parts = parseFarmDateOnly(value)
  if (!parts) return null

  const startUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day) -
    FARM_UTC_OFFSET_MINUTES * 60 * 1000

  if (kind === 'to') {
    return new Date(startUtcMs + 24 * 60 * 60 * 1000 - 1)
  }

  return new Date(startUtcMs)
}

export function farmDateRange(value) {
  const start = farmDateBoundary(value, 'from')
  const end = farmDateBoundary(value, 'to')
  return start && end ? { start, end } : null
}

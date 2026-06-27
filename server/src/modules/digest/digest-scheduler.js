import { collectReportData } from '../reports/report-data.js'
import { buildSenderEnvelope, createTransporter, isSmtpConfigured } from '../../utils/smtp.js'

const DIGEST_SETTINGS_ID = 1
const CHECK_INTERVAL_MS = 60 * 1000
const DIGEST_BATCH_LIMIT = 100
const DIGEST_VIOLATION_PREVIEW_LIMIT = 10

let digestTimer = null
let isTickRunning = false

function formatNowInTimezone(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  )

  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    timeKey: `${parts.hour}:${parts.minute}`
  }
}

function parseRecipients(value) {
  if (!value) return []

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
      : []
  } catch (error) {
    return []
  }
}

export function isOrderViolation(item) {
  return item?.code === 'ORDER_MISMATCH'
}

export function formatOrderPosition(value) {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) && numericValue > 0
    ? `#${Math.round(numericValue)}`
    : '—'
}

export function formatViolationPlan(item) {
  return isOrderViolation(item) ? formatOrderPosition(item.plan) : (item.plan ?? '—')
}

export function formatViolationFact(item) {
  return isOrderViolation(item) ? formatOrderPosition(item.fact) : (item.fact ?? '—')
}

export function formatViolationDeviation(item) {
  return isOrderViolation(item) ? 'Порядок' : (item.deviation ?? '—')
}

export function buildDigestHtml(settings, reportData, now) {
  const batches = Array.isArray(reportData?.batches) ? reportData.batches : []
  const violations = Array.isArray(reportData?.violations) ? reportData.violations : []
  const problemBatches = batches.filter((item) => Number(item?.violationsCount || 0) > 0)
  const violationsPreview = violations.slice(0, DIGEST_VIOLATION_PREVIEW_LIMIT)

  const violationRows = violationsPreview.length > 0
    ? violationsPreview.map((item) => `
        <tr>
          <td style="padding:6px 8px;border:1px solid #dfe3ea;">${item.batchLabel || item.batch || `Замес #${item.batchId}`}</td>
          <td style="padding:6px 8px;border:1px solid #dfe3ea;">${item.groupName || item.group || 'Без группы'}</td>
          <td style="padding:6px 8px;border:1px solid #dfe3ea;">${item.component || '—'}</td>
          <td style="padding:6px 8px;border:1px solid #dfe3ea;">${item.type || item.violationType || 'Нарушение'}</td>
          <td style="padding:6px 8px;border:1px solid #dfe3ea;">${formatViolationPlan(item)}</td>
          <td style="padding:6px 8px;border:1px solid #dfe3ea;">${formatViolationFact(item)}</td>
          <td style="padding:6px 8px;border:1px solid #dfe3ea;">${formatViolationDeviation(item)}</td>
        </tr>
      `).join('')
    : `
      <tr>
        <td colspan="7" style="padding:8px;border:1px solid #dfe3ea;">Нарушений не найдено.</td>
      </tr>
    `

  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #2f3b52;">
      <h2 style="margin-top:0;">Ежедневный дайджест по кормлению</h2>
      <p>Сформировано: ${now.toLocaleString('ru-RU')}</p>
      <ul>
        <li><b>Статус дайджеста:</b> ${settings.enabled ? 'включен' : 'выключен'}</li>
        <li><b>Часовой пояс:</b> ${settings.timezone}</li>
        <li><b>Время отправки:</b> ${settings.sendTime}</li>
        <li><b>Замесов в сводке:</b> ${batches.length}</li>
        <li><b>Замесов с нарушениями:</b> ${problemBatches.length}</li>
        <li><b>Нарушений в сводке:</b> ${violations.length}</li>
      </ul>

      <h3>Последние нарушения</h3>
      <table style="border-collapse: collapse; width: 100%; font-size: 14px;">
        <thead>
          <tr>
            <th style="padding:6px 8px;border:1px solid #dfe3ea;text-align:left;">Замес</th>
            <th style="padding:6px 8px;border:1px solid #dfe3ea;text-align:left;">Группа</th>
            <th style="padding:6px 8px;border:1px solid #dfe3ea;text-align:left;">Компонент</th>
            <th style="padding:6px 8px;border:1px solid #dfe3ea;text-align:left;">Тип</th>
            <th style="padding:6px 8px;border:1px solid #dfe3ea;text-align:left;">План</th>
            <th style="padding:6px 8px;border:1px solid #dfe3ea;text-align:left;">Факт</th>
            <th style="padding:6px 8px;border:1px solid #dfe3ea;text-align:left;">Отклонение</th>
          </tr>
        </thead>
        <tbody>
          ${violationRows}
        </tbody>
      </table>
    </div>
  `
}

async function sendScheduledDigest(prisma, settings) {
  const recipients = parseRecipients(settings.recipientsJson)
  if (!recipients.length) {
    return false
  }

  const transporter = createTransporter()
  const now = new Date()
  const reportData = await collectReportData({ limit: DIGEST_BATCH_LIMIT })
  const senderEnvelope = buildSenderEnvelope(settings.senderEmail, 'Дайджест по кормлению')

  await transporter.sendMail({
    from: senderEnvelope.from,
    ...(senderEnvelope.replyTo ? { replyTo: senderEnvelope.replyTo } : {}),
    to: recipients.join(', '),
    subject: 'Ежедневный дайджест по кормлению',
    html: buildDigestHtml(settings, reportData, now)
  })

  await prisma.digestSettings.update({
    where: { id: DIGEST_SETTINGS_ID },
    data: { lastSentAt: now }
  })

  console.log(`[DIGEST] Ежедневный дайджест отправлен: ${recipients.join(', ')}`)
  return true
}

async function runDigestTick(prisma) {
  if (isTickRunning) return
  if (!isSmtpConfigured()) return

  isTickRunning = true

  try {
    const settings = await prisma.digestSettings.findUnique({
      where: { id: DIGEST_SETTINGS_ID }
    })

    if (!settings?.enabled) return

    const timezone = settings.timezone || 'UTC'
    const sendTime = String(settings.sendTime || '').trim()
    if (!/^\d{2}:\d{2}$/.test(sendTime)) return

    const now = new Date()
    const currentZoned = formatNowInTimezone(now, timezone)
    const lastSentZoned = settings.lastSentAt ? formatNowInTimezone(settings.lastSentAt, timezone) : null

    if (currentZoned.timeKey !== sendTime) return
    if (lastSentZoned?.dayKey === currentZoned.dayKey) return

    await sendScheduledDigest(prisma, settings)
  } catch (error) {
    console.error('[DIGEST] Ошибка фоновой отправки дайджеста:', error)
  } finally {
    isTickRunning = false
  }
}

export function startDigestScheduler(prisma) {
  if (digestTimer) {
    return
  }

  void runDigestTick(prisma)
  digestTimer = setInterval(() => {
    void runDigestTick(prisma)
  }, CHECK_INTERVAL_MS)
}

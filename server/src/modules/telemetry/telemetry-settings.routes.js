import { Router } from 'express'
import { authenticate, requireAdmin } from '../../middleware/auth.js'
import { getTelemetrySettings, upsertTelemetrySettings } from './telemetry-settings.js'

const router = Router()

router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const settings = await getTelemetrySettings()
    res.json(settings)
  } catch (error) {
    console.error('[Ошибка GET /api/telemetry/settings]:', error)
    res.status(500).json({ error: 'Не удалось получить настройки телеметрии' })
  }
})

router.put('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const settings = await upsertTelemetrySettings(req.body || {})
    res.json({ status: 'ok', settings })
  } catch (error) {
    if (
      error.message?.includes('должен быть положительным') ||
      error.message?.includes('формате HH:mm') ||
      error.message?.includes('rtkHeadingOffsetDeg')
    ) {
      return res.status(400).json({ error: error.message })
    }

    console.error('[Ошибка PUT /api/telemetry/settings]:', error)
    res.status(500).json({ error: 'Не удалось сохранить настройки телеметрии' })
  }
})

export default router

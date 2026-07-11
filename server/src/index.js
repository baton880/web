  import './load-env.js'
  import express from 'express'
  import cookieParser from 'cookie-parser'
  import cors from 'cors'
  import path from 'path'
  import { fileURLToPath } from 'url'
  import telemetryRouter from './modules/telemetry/telemetry.routes.js'
  import rtkTelemetryRouter, { handleRtkTelemetryPost } from './modules/telemetry/rtk.routes.js'
  import { recordRtkMalformedRequest } from './modules/telemetry/rtk-ingest-monitor.js'
  import telemetryWarningsRouter from './modules/telemetry/warnings.routes.js'
  import telemetrySettingsRouter from './modules/telemetry/telemetry-settings.routes.js'
  import storageZonesRouter from './modules/storage-zones/storage-zones.routes.js'
  import eventsRouter from './modules/events/events.routes.js'
  import { authenticate, extractTokenFromRequest, requireAdmin, requireReadAccess, verifyAccessToken } from './middleware/auth.js'
  import authRouter from './modules/auth/auth.routes.js'
  import rationsRouter from './modules/rations/rations.routes.js'
  import prisma from './database.js'
  import batchesRoutes from './modules/batches/batches.routes.js'
  import groupsRoutes from './modules/groups/groups.routes.js'
  import usersRoutes from './modules/users/users.routes.js';
  import reportsRoutes from './modules/reports/reports.routes.js';
  import violationsRoutes from './modules/violations/violations.routes.js';
  import digestRoutes from './modules/digest/digest.routes.js';
  import { startDigestScheduler } from './modules/digest/digest-scheduler.js';
  import { startRtkTrackScheduler } from './modules/telemetry/rtk-track-scheduler.js';
  import { startDataRetentionScheduler } from './modules/maintenance/data-retention-scheduler.js';

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)

  const app = express()
  const PORT = process.env.PORT || 3000

  function captureRawRequestBody(req, res, buf, encoding) {
    if (req.originalUrl?.startsWith('/api/telemetry/rtk')) {
      req.rawBody = buf.toString(encoding || 'utf8')
    }
  }

  const rtkRawBodyParser = express.raw({
    type: () => true,
    limit: '50mb'
  })

  function parseRtkRawBody(req, res, next) {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : (typeof req.body === 'string' ? req.body : '')
    req.rawBody = rawBody

    if (!rawBody.trim()) {
      req.body = {}
      return next()
    }

    try {
      req.body = JSON.parse(rawBody)
      return next()
    } catch (error) {
      console.warn('[RTK ingest warning]: malformed raw body acknowledged and recorded before JSON parser', {
        type: error?.type,
        status: error?.status,
        message: error?.message,
        rawLength: rawBody.length,
        rawPreview: rawBody.slice(0, 200)
      })
      recordRtkMalformedRequest(rawBody, error).catch((monitorError) => {
        console.error('[RTK ingest monitor] Failed to record malformed body:', monitorError)
      })
      return res.status(201).end()
    }
  }

  app.use(cors({
    origin: true, // Разрешает запросы с любых адресов (для разработки самое то)
    credentials: true // Обязательно, чтобы пропускать токены и куки (у тебя там res.cookie)
  }));

  app.post('/api/telemetry/rtk', rtkRawBodyParser, parseRtkRawBody, handleRtkTelemetryPost)

  app.use(express.json({
    limit: '10mb',
    verify: captureRawRequestBody
  }))
  app.use((error, req, res, next) => {
    if (req.originalUrl?.startsWith('/api/telemetry/rtk')) {
      console.warn('[RTK ingest warning]: malformed body acknowledged and recorded before route', {
        type: error?.type,
        status: error?.status,
        message: error?.message,
        rawLength: req.rawBody?.length ?? null,
        rawPreview: req.rawBody ? req.rawBody.slice(0, 200) : null
      })
      recordRtkMalformedRequest(req.rawBody || '', error).catch((monitorError) => {
        console.error('[RTK ingest monitor] Failed to record malformed body:', monitorError)
      })
      return res.status(201).end()
    }

    next(error)
  })
  app.use(cookieParser())

  // Healthcheck - быстрая проверка статуса
  app.get('/api/health', async (req, res) => {
    try {
      // Делаем легкий запрос к базе, чтобы убедиться, что Prisma жива
      await prisma.$queryRaw`SELECT 1`;
      
      // Формируем красивый ответ
      res.json({
        status: 'ok',
        message: 'Сервер работает нормально',
        uptime: Math.floor(process.uptime()) + ' секунд',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[Healthcheck Error]: База данных недоступна', error);
      res.status(503).json({ 
        status: 'error', 
        message: 'Сервер работает, но отвалилась база данных' 
      });
    }
  });

  // API
  app.use('/api/auth', authRouter)

  // Телеметрия: POST открыт для всех, GET защищен
  app.use('/api/telemetry/host', telemetryRouter)
  app.use('/api/telemetry/rtk', rtkTelemetryRouter)
  app.use('/api/telemetry/warnings', telemetryWarningsRouter)
  app.use('/api/telemetry/settings', telemetrySettingsRouter)

  // Зоны: разделяем доступ по ролям
  app.use('/api/telemetry/zones', authenticate, storageZonesRouter)

  // События: POST публичный для устройства, чтение защищено внутри роутера
  app.use('/api/events', eventsRouter)

  // Рационы: разделяем доступ по ролям
  app.use('/api/rations', authenticate, rationsRouter)

  // Замесы: доступно всем авторизованным (гость может только смотреть, админ/директор - управлять)
  app.use('/api/batches', authenticate, requireReadAccess, batchesRoutes)

  // Группы/коровники для селектов и справочников
  app.use('/api/groups', authenticate, requireReadAccess, groupsRoutes)

  app.use('/api/reports', authenticate, requireReadAccess, reportsRoutes)
  app.use('/api/violations', authenticate, requireReadAccess, violationsRoutes)
  app.use('/api/digest-settings', authenticate, digestRoutes)

  app.use('/api/users', authenticate, requireAdmin, usersRoutes);

  // Static Frontend
  const frontendPath = path.resolve(__dirname, '../../frontend')

  // Middleware для защиты админской страницы телеметрии (должен быть ДО express.static)
  const protectedTelemetryPages = ['/telemetry.html', '/telemetry-admin.html']
  app.use(protectedTelemetryPages, (req, res, next) => {
    const token = extractTokenFromRequest(req);
    if (!token) {
      return res.status(401).send('Доступ запрещен: требуется авторизация');
    }
    
    try {
      const decoded = verifyAccessToken(token);
      // Проверяем, что пользователь ADMIN
      if (decoded.role !== 'ADMIN') {
        return res.status(403).send('Доступ запрещен: только для администраторов');
      }
      next();
    } catch (error) {
      return res.status(403).send('Неверный или просроченный токен');
    }
  });

  // Статические файлы (после middleware защиты)
  app.use(express.static(frontendPath))

  // Главная страница
  app.get('/', (req, res) => { //любой
    res.sendFile(path.join(frontendPath, 'index.html'))
  })


  // Для всех остальных путей (решение ошибки PathError)
  app.get(/\/(.*)/, (req, res, next) => {
    if (req.url.startsWith('/api')) return next()
    res.sendFile(path.join(frontendPath, 'index.html'))
  })

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server & Website running on http://127.0.0.1:${PORT}`)
  })

  startDigestScheduler(prisma)
  startRtkTrackScheduler(prisma)
  startDataRetentionScheduler(prisma)

  // Запуск
  //app.listen(PORT, () => {
    // console.log(`Server is running on port ${PORT}`)
    // console.log(`http://localhost:${PORT}`)
    // console.log(`POST: http://localhost:${PORT}/api/telemetry/host`)
    // console.log(`GET:  http://localhost:${PORT}/api/telemetry/host/latest`)
    // console.log(`GET:  http://localhost:${PORT}/api/telemetry/host/history`)
    // console.log(`GET:  http://localhost:${PORT}/api/telemetry/zones`)
  //})

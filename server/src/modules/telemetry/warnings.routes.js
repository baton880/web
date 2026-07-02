import { Router } from 'express';
import prisma from '../../database.js';
import { authenticate, requireAdmin, requireWriteAccess } from '../../middleware/auth.js';
import { getZoneByCoordinates, isFreshTimestamp, resolveEffectiveCoordinates } from './telemetry-helpers.js';
import { getTelemetrySettings } from './telemetry-settings.js';
import { syncTechnicalWarnings } from './technical-warning-service.js';

const router = Router();

function hasValidCoordinates(lat, lon) {
    return Number.isFinite(Number(lat))
        && Number.isFinite(Number(lon))
        && Number(lat) >= -90
        && Number(lat) <= 90
        && Number(lon) >= -180
        && Number(lon) <= 180;
}

function asBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') return true;
        if (normalized === 'false' || normalized === '0') return false;
    }
    return Boolean(value);
}

function buildUpdatedAt(hostRow, rtkRow) {
    const timestamps = [hostRow?.timestamp, rtkRow?.timestamp]
        .map((value) => value ? new Date(value).getTime() : NaN)
        .filter((value) => !Number.isNaN(value));

    if (!timestamps.length) {
        return null;
    }

    return new Date(Math.max(...timestamps)).toISOString();
}

function toTrackedWarning(baseWarning, scopeKey, deviceId = null) {
    return {
        ...baseWarning,
        scopeKey,
        deviceId
    };
}

router.get('/current', authenticate, requireAdmin, async (req, res) => {
    try {
        const [latestHost, latestRtk, activeZones, telemetrySettings] = await Promise.all([
            prisma.telemetry.findFirst({
                orderBy: { timestamp: 'desc' },
                select: {
                    id: true,
                    deviceId: true,
                    timestamp: true,
                    lat: true,
                    lon: true,
                    gpsValid: true,
                    gpsQuality: true
                }
            }),
            prisma.rtkTelemetry.findFirst({
                orderBy: { timestamp: 'desc' },
                select: {
                    id: true,
                    deviceId: true,
                    timestamp: true,
                    lat: true,
                    lon: true
                }
            }),
            prisma.storageZone.findMany({
                where: { active: true }
            }),
            getTelemetrySettings(prisma)
        ]);

        const items = [];
        const trackedWarnings = [];
        const updatedAt = buildUpdatedAt(latestHost, latestRtk);
        const detectedAt = updatedAt ? new Date(updatedAt) : new Date();

        if (!latestHost || !isFreshTimestamp(latestHost.timestamp)) {
            const warning = {
                code: 'no_fresh_packets',
                title: 'Нет свежих пакетов',
                message: latestHost?.timestamp
                    ? `Последний host пакет устарел: ${new Date(latestHost.timestamp).toLocaleString('ru-RU')}.`
                    : 'Телеметрия от host ещё не поступала.',
                severity: 'warning'
            };
            items.push(warning);
            trackedWarnings.push(toTrackedWarning(warning, latestHost?.deviceId || 'host_01', latestHost?.deviceId || 'host_01'));
            await syncTechnicalWarnings(prisma, trackedWarnings, detectedAt);

            return res.json({
                items,
                source: 'backend',
                updatedAt
            });
        }

        const gpsQuality = Number(latestHost.gpsQuality);
        const hasGpsCoordinates = hasValidCoordinates(latestHost.lat, latestHost.lon);
        const hasGpsFlag = latestHost.gpsValid == null ? true : asBoolean(latestHost.gpsValid);
        const hasGps = hasGpsCoordinates && hasGpsFlag && (!Number.isFinite(gpsQuality) || gpsQuality > 0);

        if (!hasGps) {
            const warning = {
                code: 'no_gps',
                title: 'Нет GPS',
                message: 'Координаты не определены или GPS fix отсутствует.',
                severity: 'danger'
            };
            items.push(warning);
            trackedWarnings.push(toTrackedWarning(warning, latestHost.deviceId, latestHost.deviceId));
        }

        const loaderFreshnessMs = Number(telemetrySettings.loaderOfflineTimeoutMinutes || 15) * 60 * 1000;
        if (!latestRtk || !isFreshTimestamp(latestRtk.timestamp, loaderFreshnessMs)) {
            const warning = {
                code: 'no_rtk',
                title: 'Нет RTK',
                message: latestRtk?.timestamp
                    ? `Последний RTK пакет устарел: ${new Date(latestRtk.timestamp).toLocaleString('ru-RU')}.`
                    : 'RTK телеметрия ещё не поступала.',
                severity: 'warning'
            };
            items.push(warning);
            trackedWarnings.push(toTrackedWarning(warning, latestRtk?.deviceId || 'RTK', latestRtk?.deviceId || null));
        }

        if (activeZones.length > 0 && hasGpsCoordinates) {
            const effectivePosition = await resolveEffectiveCoordinates(prisma, latestHost, {
                deviceId: latestHost.deviceId,
                referenceTime: latestHost.timestamp,
                loaderMaxDistanceMeters: telemetrySettings.loaderMaxDistanceMeters,
                loaderOfflineTimeoutMinutes: telemetrySettings.loaderOfflineTimeoutMinutes
            });
            const currentZone = getZoneByCoordinates(effectivePosition.lat, effectivePosition.lon, activeZones);
            if (!currentZone) {
                const warning = {
                    code: 'unknown_zone',
                    title: 'Неизвестная зона',
                    message: 'Текущие координаты не попали ни в одну активную зону.',
                    severity: 'warning'
                };
                items.push(warning);
                trackedWarnings.push(toTrackedWarning(warning, latestHost.deviceId, latestHost.deviceId));
            }
        }

        await syncTechnicalWarnings(prisma, trackedWarnings, detectedAt);

        res.json({
            items,
            source: 'backend',
            updatedAt
        });
    } catch (error) {
        console.error('[Ошибка GET /telemetry/warnings/current]:', error);
        res.status(500).json({ error: 'Не удалось получить технические предупреждения' });
    }
});

router.get('/history', authenticate, requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const status = typeof req.query.status === 'string' && req.query.status.trim()
            ? req.query.status.trim().toUpperCase()
            : null;

        const warnings = await prisma.technicalWarning.findMany({
            where: status ? { status } : undefined,
            orderBy: { lastSeenAt: 'desc' },
            take: limit
        });

        res.json(warnings);
    } catch (error) {
        console.error('[Ошибка GET /telemetry/warnings/history]:', error);
        res.status(500).json({ error: 'Не удалось получить историю техпредупреждений' });
    }
});

router.patch('/:id', authenticate, requireAdmin, requireWriteAccess, async (req, res) => {
    try {
        const warningId = parseInt(req.params.id, 10);
        if (!Number.isInteger(warningId) || warningId <= 0) {
            return res.status(400).json({ error: 'Некорректный ID предупреждения' });
        }

        const status = typeof req.body.status === 'string' ? req.body.status.trim().toUpperCase() : '';
        if (!['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(status)) {
            return res.status(400).json({ error: 'status должен быть OPEN, ACKNOWLEDGED или RESOLVED' });
        }

        const warning = await prisma.technicalWarning.update({
            where: { id: warningId },
            data: {
                status,
                resolvedAt: status === 'RESOLVED' ? new Date() : null
            }
        });

        res.json({ status: 'ok', warning });
    } catch (error) {
        console.error('[Ошибка PATCH /telemetry/warnings/:id]:', error);
        if (error.code === 'P2025') {
            return res.status(404).json({ error: 'Предупреждение не найдено' });
        }
        res.status(500).json({ error: 'Не удалось обновить предупреждение' });
    }
});

export default router;

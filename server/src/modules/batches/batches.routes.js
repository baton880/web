import { Router } from 'express';
import prisma from "../../database.js";
import { authenticate, requireAdmin, requireReadAccess, requireWriteAccess } from "../../middleware/auth.js";
import { buildIngredientSummary, buildUnloadProgress, recalculateBatchViolations, toDisplayIngredientName } from './batch-violations.js';
import { normalizeIngredientName } from '../../../../module-2/rationManager.js';
import { roundNonNegativeWeight, roundWeight } from '../../../../module-2/weightRounding.js';
import { getTelemetrySettings } from '../telemetry/telemetry-settings.js';
import telemetryProcessor from '../../../../module-3/telemetryProcessor.js';
import { farmDateRange, getFarmDateString } from '../../utils/farm-date.js';
import { buildPostprocessMeta, postprocessCompletedBatch } from './batch-postprocess-service.js';

const router = Router();
const ACTIVE_VIOLATION_STATUSES = ['OPEN', 'IN_PROGRESS'];
const STRAW_ALFALFA_VIOLATION_CODES = new Set([
    'STRAW_ALFALFA_RATIO_MISMATCH',
    'STRAW_ALFALFA_TOTAL_MISMATCH'
]);
const RECOVERED_INGREDIENT_GRAPH_LOOKBACK_SECONDS = 10 * 60;
const INSTANT_START_INGREDIENT_TOLERANCE_MS = 5000;
const BUFFER_OVERLAP_WINDOW_MS = 10 * 1000;
const BUFFER_OVERLAP_MAX_DISTANCE_M = 50;

function parseTimestampMs(value) {
    const timestamp = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function isExplicitlyInvalidWeight(point) {
    return point?.weightValid === false || point?.weightValid === 0;
}

function hasTrackCoordinates(point) {
    const lat = Number(point?.lat);
    const lon = Number(point?.lon);
    return Number.isFinite(lat)
        && Number.isFinite(lon)
        && Math.abs(lat) <= 90
        && Math.abs(lon) <= 180
        && !(lat === 0 && lon === 0);
}

function trackDistanceMeters(left, right) {
    if (!hasTrackCoordinates(left) || !hasTrackCoordinates(right)) return Number.POSITIVE_INFINITY;

    const toRadians = (degrees) => degrees * Math.PI / 180;
    const earthRadiusMeters = 6371000;
    const lat1 = toRadians(Number(left.lat));
    const lat2 = toRadians(Number(right.lat));
    const deltaLat = toRadians(Number(right.lat) - Number(left.lat));
    const deltaLon = toRadians(Number(right.lon) - Number(left.lon));
    const sinLat = Math.sin(deltaLat / 2);
    const sinLon = Math.sin(deltaLon / 2);
    const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function compareTelemetryTrackPoints(left, right) {
    const leftMs = parseTimestampMs(left?.timestamp);
    const rightMs = parseTimestampMs(right?.timestamp);
    if (leftMs !== rightMs) return (leftMs ?? 0) - (rightMs ?? 0);

    if (isExplicitlyInvalidWeight(left) !== isExplicitlyInvalidWeight(right)) {
        return isExplicitlyInvalidWeight(left) ? 1 : -1;
    }

    const leftReceivedMs = parseTimestampMs(left?.receivedAt);
    const rightReceivedMs = parseTimestampMs(right?.receivedAt);
    if (leftReceivedMs !== rightReceivedMs) return (leftReceivedMs ?? 0) - (rightReceivedMs ?? 0);

    return Number(left?.id || 0) - Number(right?.id || 0);
}

function removeOverlappingBufferedTrackPoints(points = []) {
    const ordered = (Array.isArray(points) ? points : [])
        .slice()
        .sort(compareTelemetryTrackPoints);
    const reliablePoints = ordered.filter((point) => !isExplicitlyInvalidWeight(point) && hasTrackCoordinates(point));

    return ordered.filter((point) => {
        if (!isExplicitlyInvalidWeight(point) || !hasTrackCoordinates(point)) {
            return true;
        }

        const pointMs = parseTimestampMs(point.timestamp);
        if (pointMs === null) return true;

        const overlappingReliablePoint = reliablePoints.find((candidate) => {
            const candidateMs = parseTimestampMs(candidate.timestamp);
            return candidateMs !== null
                && Math.abs(candidateMs - pointMs) <= BUFFER_OVERLAP_WINDOW_MS
                && trackDistanceMeters(candidate, point) > BUFFER_OVERLAP_MAX_DISTANCE_M;
        });

        return !overlappingReliablePoint;
    });
}

function isStrawAlfalfaViolationCode(code) {
    return STRAW_ALFALFA_VIOLATION_CODES.has(String(code || ''));
}

// ============================================================================
// ADMIN: очистка замесов и связанных ошибок (без удаления рационов и групп)
// ============================================================================
router.delete('/admin/truncate', authenticate, requireAdmin, requireWriteAccess, async (req, res) => {
    try {
        const result = await prisma.$transaction(async (tx) => {
            const deletedViolations = await tx.violation.deleteMany({});
            const deletedIngredients = await tx.batchIngredient.deleteMany({});
            const deletedBatches = await tx.batch.deleteMany({});

            return {
                deletedViolations: deletedViolations.count,
                deletedIngredients: deletedIngredients.count,
                deletedBatches: deletedBatches.count,
            };
        });

        telemetryProcessor.clearStates();

        res.json({
            status: 'ok',
            message: 'Замесы и связанные нарушения очищены',
            ...result
        });
    } catch (error) {
        console.error('[Ошибка DELETE /batches/admin/truncate]:', error);
        res.status(500).json({ error: 'Не удалось очистить замесы и нарушения' });
    }
});

async function getBatchWeightContext(batch, prismaClient = prisma) {
    const telemetryWhere = {
        deviceId: batch.deviceId,
        timestamp: {
            gte: batch.startTime,
            ...(batch.endTime ? { lte: batch.endTime } : {})
        }
    };

    const [latestTelemetry, peakTelemetry] = await Promise.all([
        prismaClient.telemetry.findFirst({
            where: telemetryWhere,
            orderBy: { timestamp: 'desc' },
            select: { weight: true, timestamp: true }
        }),
        prismaClient.telemetry.aggregate({
            where: telemetryWhere,
            _max: { weight: true }
        })
    ]);

    const currentWeight = roundWeight(batch.endTime
        ? batch.endWeight ?? latestTelemetry?.weight ?? 0
        : latestTelemetry?.weight ?? batch.endWeight ?? batch.startWeight ?? 0);
    const peakWeight = Math.max(
        roundWeight(peakTelemetry._max.weight || 0),
        roundWeight(batch.startWeight || 0),
        currentWeight
    );

    return {
        currentWeight,
        peakWeight,
        remainingWeight: roundNonNegativeWeight(currentWeight),
        latestTelemetryAt: latestTelemetry?.timestamp || null
    };
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function findInstantStartIngredient(batch) {
    const batchStartMs = new Date(batch?.startTime || 0).getTime();
    if (!Number.isFinite(batchStartMs)) {
        return null;
    }

    const ingredients = Array.isArray(batch?.actualIngredients) ? batch.actualIngredients : [];
    return ingredients.find((ingredient) => {
        const addedAtMs = new Date(ingredient?.addedAt || 0).getTime();
        const startedAtMs = new Date(ingredient?.startedAt || ingredient?.addedAt || 0).getTime();
        const actualWeight = Number(ingredient?.actualWeight || 0);
        return Number.isFinite(addedAtMs) &&
            Number.isFinite(startedAtMs) &&
            actualWeight > 0 &&
            Math.abs(addedAtMs - batchStartMs) <= INSTANT_START_INGREDIENT_TOLERANCE_MS &&
            Math.abs(startedAtMs - addedAtMs) <= INSTANT_START_INGREDIENT_TOLERANCE_MS;
    }) || null;
}

function findRecoveredGraphAnchorPoint(batch, hostTrack = []) {
    if (!findInstantStartIngredient(batch)) {
        return null;
    }

    const batchStartMs = new Date(batch?.startTime || 0).getTime();
    if (!Number.isFinite(batchStartMs)) {
        return null;
    }

    return (Array.isArray(hostTrack) ? hostTrack : [])
        .filter((point) => {
            const pointTimeMs = new Date(point?.timestamp || 0).getTime();
            return Number.isFinite(pointTimeMs) &&
                pointTimeMs < batchStartMs &&
                batchStartMs - pointTimeMs <= RECOVERED_INGREDIENT_GRAPH_LOOKBACK_SECONDS * 1000 &&
                Number.isFinite(Number(point?.weight));
        })
        .reduce((best, point) => {
            if (!best) return point;
            return Number(point.weight) < Number(best.weight) ? point : best;
        }, null);
}

function parseRtkRawPayload(value) {
    if (!value) return {};

    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function readFirstString(source, keys = []) {
    for (const key of keys) {
        const value = source?.[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return null;
}

function readFirstBoolean(source, keys = []) {
    for (const key of keys) {
        const value = source?.[key];
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1') return true;
            if (normalized === 'false' || normalized === '0') return false;
        }
    }

    return null;
}

function getRtkLinkedHostDeviceId(row) {
    const raw = parseRtkRawPayload(row?.rawPayload);
    return readFirstString(raw, [
        'hostDeviceId',
        'host_device_id',
        'targetDeviceId',
        'target_device_id',
        'esrkDeviceId',
        'esrk_device_id'
    ]);
}

function serializeRtkTrackPoint(row) {
    const raw = parseRtkRawPayload(row?.rawPayload);

    return {
        timestamp: row.timestamp,
        lat: row.lat,
        lon: row.lon,
        speed: row.speed,
        course: row.course,
        heading: row.course,
        relPosValid: readFirstBoolean(raw, ['relPosValid', 'rel_pos_valid']),
        relPosHeadingValid: readFirstBoolean(raw, ['relPosHeadingValid', 'rel_pos_heading_valid', 'headingValid', 'heading_valid']),
        deviceId: row.deviceId,
        rtkQuality: row.rtkQuality,
        fixType: row.fixType
    };
}

async function getBatchLoaderTrack(batch, prismaClient = prisma, options = {}) {
    const lookbackSeconds = parsePositiveInteger(options.lookbackSeconds, 60);
    const windowStart = new Date(new Date(batch.startTime).getTime() - lookbackSeconds * 1000);
    const windowEnd = batch.endTime || new Date();

    const rows = await prismaClient.rtkTelemetry.findMany({
        where: {
            timestamp: {
                gte: windowStart,
                lte: windowEnd
            }
        },
        select: {
            timestamp: true,
            lat: true,
            lon: true,
            speed: true,
            course: true,
            deviceId: true,
            rtkQuality: true,
            fixType: true,
            rawPayload: true
        },
        orderBy: [
            { timestamp: 'asc' },
            { id: 'asc' }
        ]
    });

    const byLinkedHost = rows.filter((row) => getRtkLinkedHostDeviceId(row) === batch.deviceId);
    const selectedRows = byLinkedHost.length
        ? byLinkedHost
        : rows.filter((row) => row.deviceId === batch.deviceId);

    if (selectedRows.length) {
        return selectedRows.map(serializeRtkTrackPoint);
    }

    const deviceIds = new Set(rows.map((row) => row.deviceId).filter(Boolean));
    return deviceIds.size === 1 ? rows.map(serializeRtkTrackPoint) : [];
}

async function getDetailedBatchById(batchId, prismaClient = prisma, options = {}) {
    const batch = await prismaClient.batch.findUnique({
        where: { id: batchId },
        include: {
            group: {
                include: {
                    ration: {
                        include: {
                            ingredients: true
                        }
                    }
                }
            },
            ration: {
                include: { ingredients: true }
            },
            actualIngredients: {
                orderBy: [
                    { startedAt: 'asc' },
                    { addedAt: 'asc' },
                    { id: 'asc' }
                ]
            }
        }
    });

    if (!batch) {
        return null;
    }

    const sourceRation = batch.ration || batch.group?.ration || null;
    const rationIngredients = [...(sourceRation?.ingredients || [])].sort((left, right) => {
        const orderDiff = Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
        if (orderDiff !== 0) return orderDiff;
        return Number(left.id || 0) - Number(right.id || 0);
    });

    const [weightContext, telemetrySettings] = await Promise.all([
        getBatchWeightContext(batch, prismaClient),
        options.telemetrySettings ? Promise.resolve(options.telemetrySettings) : getTelemetrySettings(prismaClient)
    ]);
    const postprocess = options.postprocess || (
        batch.endTime
            ? { status: 'processing', reason: 'not_checked' }
            : { status: 'in_progress', reason: 'batch_in_progress' }
    );
    const ingredientSummary = buildIngredientSummary(batch, telemetrySettings);
    const summaryViolationByKey = new Map(ingredientSummary.map((item) => [
        normalizeIngredientName(item.name),
        Boolean(item.isViolation ?? item.is_violation)
    ]));

    return {
        id: batch.id,
        deviceId: batch.deviceId,
        startTime: batch.startTime,
        endTime: batch.endTime,
        rationId: batch.rationId,
        groupId: batch.groupId,
        rationName: sourceRation?.name || 'Без рациона',
        groupName: batch.group?.name || 'Без группы',
        ration: sourceRation ? {
            id: sourceRation.id,
            name: sourceRation.name,
            feedingsPerDay: Number(sourceRation.feedingsPerDay || 1),
            isActive: sourceRation.isActive,
            ingredients: rationIngredients.map((ing) => ({
                id: ing.id,
                name: ing.name,
                sortOrder: Number(ing.sortOrder || 0),
                plannedWeight: ing.plannedWeight,
                dryMatterWeight: ing.dryMatterWeight,
                isCompound: Boolean(ing.isCompound),
                components: (() => {
                    try {
                        const parsed = JSON.parse(ing.componentsJson || '[]');
                        return Array.isArray(parsed) ? parsed : [];
                    } catch (error) {
                        return [];
                    }
                })()
            }))
        } : null,
        group: batch.group ? {
            id: batch.group.id,
            name: batch.group.name,
            headcount: batch.group.headcount,
            rationId: batch.group.rationId,
            lat: batch.group.lat,
            lon: batch.group.lon,
            radius: batch.group.radius
        } : null,
        unloadingInfo: {
            barnName: batch.group?.name || 'Коровник не выбран',
            remainingWeight: weightContext.remainingWeight,
            latestTelemetryAt: weightContext.latestTelemetryAt,
            progress: buildUnloadProgress(batch, weightContext.currentWeight, { peakWeight: weightContext.peakWeight })
        },
        actualIngredients: batch.actualIngredients.map((ing) => ({
            id: ing.id,
            name: toDisplayIngredientName(ing.ingredientName),
            startTime: ing.startedAt || null,
            time: ing.addedAt,
            endTime: ing.addedAt,
            plan: roundWeight(ing.plannedWeight || 0),
            fact: roundWeight(ing.actualWeight || 0),
            deviation: ing.plannedWeight ? roundWeight(Number(ing.actualWeight || 0) - Number(ing.plannedWeight || 0)) : 0,
            isViolation: summaryViolationByKey.has(normalizeIngredientName(ing.ingredientName))
                ? summaryViolationByKey.get(normalizeIngredientName(ing.ingredientName))
                : ing.isViolation,
            startLat: ing.startLat,
            startLon: ing.startLon,
            endLat: ing.endLat,
            endLon: ing.endLon
        })),
        ingredients: ingredientSummary,
        postprocess: buildPostprocessMeta(postprocess)
    };
}

function normalizeBatchTrackWeights(batch, hostTrack = []) {
    if (!Array.isArray(hostTrack) || hostTrack.length === 0) {
        return [];
    }

    const serializePoint = (point, weightValue) => {
        const rawWeight = Number(point?.weight);
        return {
            ...point,
            weight: roundNonNegativeWeight(weightValue),
            rawWeight: Number.isFinite(rawWeight) ? rawWeight : point?.rawWeight
        };
    };

    const batchStartTimeMs = new Date(batch?.startTime || 0).getTime();
    const anchorPoint = hostTrack.find((point) => {
        const pointTimeMs = new Date(point?.timestamp || 0).getTime();
        return Number.isFinite(pointTimeMs) && pointTimeMs >= batchStartTimeMs;
    }) || hostTrack[0];
    const batchStartWeight = Number(batch?.startWeight || 0);
    const firstRawWeight = Number(anchorPoint?.weight);
    if (!Number.isFinite(firstRawWeight)) {
        return hostTrack.map((point) => serializePoint(point, point?.weight));
    }

    const weightOffset = firstRawWeight - batchStartWeight;
    if (!Number.isFinite(weightOffset) || Math.abs(weightOffset) < 1) {
        return hostTrack.map((point) => serializePoint(point, point?.weight));
    }

    return hostTrack.map((point) => {
        const rawWeight = Number(point?.weight);
        if (!Number.isFinite(rawWeight)) {
            return point;
        }

        return {
            ...serializePoint(point, rawWeight - weightOffset),
            rawWeight
        };
    });
}

// ============================================================================
// 1. GET / - Получить список замесов (с фильтром по дате, нарушениями и планом)
// ============================================================================
router.get('/', authenticate, requireReadAccess, async (req, res) => {
    try {
        // Логика фильтрации по датам (По умолчанию - сегодня)
        let selectedDate = getFarmDateString();
        let startDate;
        let endDate;

        if (req.query.date) {
            if (Number.isNaN(Date.parse(req.query.date))) {
                return res.status(400).json({ error: 'Некорректная дата фильтра' });
            }
            startDate = new Date(req.query.date);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(req.query.date);
            endDate.setHours(23, 59, 59, 999);
        }

        if (req.query.date) {
            selectedDate = String(req.query.date);
        }

        const dateRange = farmDateRange(selectedDate);
        if (!dateRange) {
            return res.status(400).json({ error: 'РќРµРєРѕСЂСЂРµРєС‚РЅР°СЏ РґР°С‚Р° С„РёР»СЊС‚СЂР°' });
        }
        startDate = dateRange.start;
        endDate = dateRange.end;

        const [batches, telemetrySettings] = await Promise.all([
            prisma.batch.findMany({
                where: {
                    startTime: {
                        gte: startDate,
                        lte: endDate
                    }
                },
                include: {
                    group: {
                        include: {
                            ration: {
                                include: {
                                    ingredients: true
                                }
                            }
                        }
                    },
                    ration: { include: { ingredients: true } }, // Связка с "Планом"
                    actualIngredients: true, // Тут лежат компоненты и их нарушения
                    violations: {
                        where: { status: { in: ACTIVE_VIOLATION_STATUSES } },
                        select: {
                            id: true,
                            code: true
                        }
                    }
                },
                orderBy: { startTime: 'desc' }
            }),
            getTelemetrySettings(prisma)
        ]);

        // Форматируем ответ для удобной таблицы фронтенда
        const formattedBatches = batches.map(b => {
            const ingredients = buildIngredientSummary(b, telemetrySettings);
            const hasLoggedViolations = (b.violations?.length || 0) > 0;
            const activeViolationCodes = (b.violations || []).map((violation) => String(violation.code || ''));
            const hasStrawAlfalfaWarning = activeViolationCodes.some(isStrawAlfalfaViolationCode);
            const hasOnlyStrawAlfalfaWarning = activeViolationCodes.length > 0 &&
                activeViolationCodes.every(isStrawAlfalfaViolationCode);
            const violationStatus = hasOnlyStrawAlfalfaWarning
                ? 'warning'
                : (hasLoggedViolations ? 'critical' : 'none');

            return {
                id: b.id,
                deviceId: b.deviceId,
                startTime: b.startTime,
                endTime: b.endTime,
                rationName: b.ration?.name || 'Неизвестный рацион',
                groupName: b.group?.name || 'Без группы',
                hasViolations: hasLoggedViolations, // Единый источник статуса: журнал нарушений (все зафиксированные кейсы)
                violationStatus,
                violationLabel: hasStrawAlfalfaWarning ? 'Сол.+Люц.' : null,
                startWeight: roundWeight(b.startWeight || 0),
                endWeight: b.endWeight === null || b.endWeight === undefined ? null : roundWeight(b.endWeight),
                ingredients,
                postprocess: {
                    status: b.endTime ? 'complete' : 'in_progress',
                    reason: b.endTime ? null : 'batch_in_progress'
                }
            };
        });

        res.json(formattedBatches);
    } catch (error) {
        console.error('[Ошибка GET /batches]:', error);
        res.status(500).json({ error: 'Не удалось получить список замесов' });
    }
});

// ============================================================================
// 4. GET /:id - Получить детальную информацию по одному замесу
// ============================================================================
router.get('/:id', authenticate, requireReadAccess, async (req, res) => {
    try {
        const batchId = parseInt(req.params.id, 10);
        if (!Number.isInteger(batchId)) {
            return res.status(400).json({ error: 'Некорректный ID замеса' });
        }

        const existingBatch = await prisma.batch.findUnique({
            where: { id: batchId },
            select: { id: true, endTime: true }
        });
        if (!existingBatch) {
            return res.status(404).json({ error: 'Р—Р°РјРµСЃ РЅРµ РЅР°Р№РґРµРЅ' });
        }

        const telemetrySettings = await getTelemetrySettings(prisma);
        const postprocess = existingBatch.endTime
            ? await postprocessCompletedBatch(prisma, batchId, telemetrySettings, { persist: false })
            : { status: 'in_progress', reason: 'batch_in_progress' };
        const detailedBatch = await getDetailedBatchById(batchId, prisma, { telemetrySettings, postprocess });
        if (!detailedBatch) {
            return res.status(404).json({ error: 'Замес не найден' });
        }

        res.json(detailedBatch);
    } catch (error) {
        console.error('[Ошибка GET /batches/:id]:', error);
        res.status(500).json({ error: 'Не удалось получить замес' });
    }
});

// ============================================================================
// 2. GET /:id/telemetry - Детальная инфа (time/weight + lat/lon) для графика и трека
// ============================================================================
router.get('/:id/telemetry', authenticate, requireReadAccess, async (req, res) => {
    try {
        const batchId = parseInt(req.params.id, 10);
        if (!Number.isInteger(batchId)) {
            return res.status(400).json({ error: 'Некорректный ID замеса' });
        }

        const batch = await prisma.batch.findUnique({
            where: { id: batchId },
            include: {
                actualIngredients: {
                    orderBy: [
                        { startedAt: 'asc' },
                        { addedAt: 'asc' },
                        { id: 'asc' }
                    ]
                }
            }
        });

        if (!batch) return res.status(404).json({ error: 'Замес не найден' });

        const includeRtk = req.query.includeRtk === 'true' || req.query.includeRtk === '1';
        const loaderLookbackSeconds = parsePositiveInteger(req.query.loaderLookbackSeconds, 180);
        const hostLookbackSeconds = parsePositiveInteger(req.query.hostLookbackSeconds, 180);
        const hostLookaheadSeconds = parsePositiveInteger(req.query.hostLookaheadSeconds, 180);
        const telemetrySettings = await getTelemetrySettings(prisma);
        const postprocess = batch.endTime
            ? await postprocessCompletedBatch(prisma, batch.id, telemetrySettings, { persist: false })
            : { status: 'in_progress', reason: 'batch_in_progress' };

        if (postprocess.status === 'complete') {
            const normalizedHostTrack = Array.isArray(postprocess.hostTrack) ? postprocess.hostTrack : [];
            if (!includeRtk) {
                return res.json(normalizedHostTrack);
            }

            const loaderTrack = await getBatchLoaderTrack(batch, prisma, {
                lookbackSeconds: loaderLookbackSeconds
            });
            const postprocessMeta = buildPostprocessMeta(postprocess);

            return res.json({
                hostTrack: normalizedHostTrack,
                hostContextTrack: normalizedHostTrack,
                loaderTrack,
                postprocess: postprocessMeta,
                postprocessIngredients: postprocess.ingredients || [],
                events: postprocess.analysis?.includedEvents || [],
                plateaus: postprocess.analysis?.plateaus || [],
                meta: {
                    batchId: batch.id,
                    deviceId: batch.deviceId,
                    hostLookbackSeconds,
                    hostLookaheadSeconds,
                    loaderLookbackSeconds,
                    recoveredGraphAnchorAt: null,
                    hostPoints: normalizedHostTrack.length,
                    hostContextPoints: normalizedHostTrack.length,
                    loaderPoints: loaderTrack.length,
                    postprocess: postprocessMeta
                }
            });
        }

        const hasInstantStartIngredient = Boolean(findInstantStartIngredient(batch));
        const effectiveHostLookbackSeconds = hasInstantStartIngredient
            ? Math.max(hostLookbackSeconds, RECOVERED_INGREDIENT_GRAPH_LOOKBACK_SECONDS)
            : hostLookbackSeconds;
        const hostWindowStart = new Date(new Date(batch.startTime).getTime() - effectiveHostLookbackSeconds * 1000);
        const hostWindowEnd = new Date(new Date(batch.endTime || new Date()).getTime() + hostLookaheadSeconds * 1000);

        // Ищем все точки телеметрии за время этого замеса
        const hostTrack = await prisma.telemetry.findMany({
            where: {
                deviceId: batch.deviceId,
                timestamp: {
                    gte: hostWindowStart,
                    lte: hostWindowEnd
                }
            },
            select: {
                id: true,
                timestamp: true,
                receivedAt: true,
                weight: true,
                rawWeight: true,
                weightValid: true,
                lat: true,
                lon: true
            },
            orderBy: [
                { timestamp: 'asc' },
                { id: 'asc' }
            ]
        });

        const cleanedHostTrack = removeOverlappingBufferedTrackPoints(hostTrack);
        const recoveredGraphAnchorPoint = findRecoveredGraphAnchorPoint(batch, cleanedHostTrack);
        const graphNormalizationBatch = recoveredGraphAnchorPoint
            ? { ...batch, startTime: recoveredGraphAnchorPoint.timestamp, startWeight: 0 }
            : batch;
        const normalizedHostTrack = normalizeBatchTrackWeights(graphNormalizationBatch, cleanedHostTrack);

        if (!includeRtk) {
            return res.json(normalizedHostTrack);
        }

        const hostContextTrack = hostLookbackSeconds > 0 || hostLookaheadSeconds > 0
            ? await prisma.telemetry.findMany({
                where: {
                    deviceId: batch.deviceId,
                    timestamp: {
                        gte: hostWindowStart,
                        lte: hostWindowEnd
                    }
                },
                select: {
                    id: true,
                    timestamp: true,
                    receivedAt: true,
                    weight: true,
                    rawWeight: true,
                    weightValid: true,
                    lat: true,
                    lon: true
                },
                orderBy: [
                    { timestamp: 'asc' },
                    { id: 'asc' }
                ]
            })
            : hostTrack;
        const cleanedHostContextTrack = hostContextTrack === hostTrack
            ? cleanedHostTrack
            : removeOverlappingBufferedTrackPoints(hostContextTrack);
        const normalizedHostContextTrack = cleanedHostContextTrack === cleanedHostTrack
            ? normalizedHostTrack
            : normalizeBatchTrackWeights(graphNormalizationBatch, cleanedHostContextTrack);

        const loaderTrack = await getBatchLoaderTrack(batch, prisma, {
            lookbackSeconds: loaderLookbackSeconds
        });

        res.json({
            hostTrack: normalizedHostTrack,
            hostContextTrack: normalizedHostContextTrack,
            loaderTrack,
            postprocess: buildPostprocessMeta(postprocess),
            meta: {
                batchId: batch.id,
                deviceId: batch.deviceId,
                hostLookbackSeconds: effectiveHostLookbackSeconds,
                hostLookaheadSeconds,
                loaderLookbackSeconds,
                recoveredGraphAnchorAt: recoveredGraphAnchorPoint?.timestamp || null,
                hostPoints: normalizedHostTrack.length,
                hostContextPoints: normalizedHostContextTrack.length,
                loaderPoints: loaderTrack.length,
                postprocess: buildPostprocessMeta(postprocess)
            }
        });
    } catch (error) {
        console.error('[Ошибка графика замеса]:', error);
        res.status(500).json({ error: 'Не удалось получить график замеса' });
    }
});

// ============================================================================
// 3. PATCH /:id - Ручное редактирование (изменение группы или рациона)
// ============================================================================
router.patch('/:id', authenticate, requireWriteAccess, async (req, res) => {
    try {
        const { rationId, groupId } = req.body;
        const batchId = parseInt(req.params.id, 10);

        if (!Number.isInteger(batchId)) {
            return res.status(400).json({ error: 'Некорректный ID замеса' });
        }

        const data = {};

        if (rationId !== undefined) {
            if (rationId === null || rationId === '') {
                data.rationId = null;
            } else {
                const parsedRationId = parseInt(rationId, 10);
                if (!Number.isInteger(parsedRationId)) return res.status(400).json({ error: 'Некорректный rationId' });
                const ration = await prisma.ration.findUnique({ where: { id: parsedRationId } });
                if (!ration) return res.status(404).json({ error: 'Рацион не найден' });
                data.rationId = parsedRationId;
            }
        }

        if (groupId !== undefined) {
            if (groupId === null || groupId === '') {
                data.groupId = null;
            } else {
                const parsedGroupId = parseInt(groupId, 10);
                if (!Number.isInteger(parsedGroupId)) return res.status(400).json({ error: 'Некорректный groupId' });
                const group = await prisma.livestockGroup.findUnique({ where: { id: parsedGroupId } });
                if (!group) return res.status(404).json({ error: 'Группа не найдена' });
                data.groupId = parsedGroupId;
            }
        }
        
        // Обновляем замес новыми данными от пользователя
        const updatedBatch = await prisma.batch.update({
            where: { id: batchId },
            data
        });

        const recalculation = await recalculateBatchViolations(prisma, updatedBatch.id);

        res.json({ status: 'ok', batch: updatedBatch, recalculation });
    } catch (error) {
        console.error('[Ошибка редактирования замеса]:', error);
        if (error.code === 'P2025') return res.status(404).json({ error: 'Замес не найден' });
        res.status(500).json({ error: 'Не удалось обновить замес' });
    }
});

// ============================================================================
// DELETE /:id - Точечное удаление замеса
// ============================================================================
router.delete('/:id', authenticate, requireWriteAccess, async (req, res) => {
    try {
        const batchId = parseInt(req.params.id, 10);
        if (!Number.isInteger(batchId)) {
            return res.status(400).json({ error: 'Некорректный ID замеса' });
        }

        const batch = await prisma.batch.findUnique({
            where: { id: batchId },
            select: {
                id: true,
                deviceId: true,
                endTime: true,
            }
        });

        if (!batch) {
            return res.status(404).json({ error: 'Замес не найден' });
        }

        const deletion = await prisma.$transaction(async (tx) => {
            const deletedViolations = await tx.violation.deleteMany({
                where: { batchId }
            });
            await tx.batch.delete({
                where: { id: batchId }
            });

            return {
                deletedViolations: deletedViolations.count
            };
        });

        // Если удалили активный замес — очищаем in-memory FSM, чтобы не "воскрешался".
        if (!batch.endTime && batch.deviceId) {
            telemetryProcessor.clearDeviceState(batch.deviceId);
        }

        return res.json({
            status: 'ok',
            message: `Замес #${batchId} удалён`,
            ...deletion
        });
    } catch (error) {
        console.error('[Ошибка DELETE /batches/:id]:', error);
        if (error.code === 'P2025') {
            return res.status(404).json({ error: 'Замес не найден' });
        }
        return res.status(500).json({ error: 'Не удалось удалить замес' });
    }
});

// ============================================================================
// 5. PATCH /:batchId/ingredients/:ingredientId - Изменение компонента в замесе
// ============================================================================
router.patch('/:batchId/ingredients/:ingredientId', authenticate, requireWriteAccess, async (req, res) => {
    try {
        const { ingredientName } = req.body;
        const batchId = parseInt(req.params.batchId, 10);
        const ingredientId = parseInt(req.params.ingredientId, 10);
        
        if (!Number.isInteger(batchId) || !Number.isInteger(ingredientId)) {
            return res.status(400).json({ error: 'Некорректный ID замеса или ингредиента' });
        }

        if (!ingredientName) {
            return res.status(400).json({ error: 'Не указано новое название корма' });
        }

        const nextIngredientName = String(ingredientName).trim().replace(/\s+/g, ' ');
        if (!nextIngredientName) {
            return res.status(400).json({ error: 'Название корма не может быть пустым' });
        }

        const batch = await prisma.batch.findUnique({
            where: { id: batchId },
            include: {
                ration: { include: { ingredients: true } },
                actualIngredients: true
            }
        });

        if (!batch) {
            return res.status(404).json({ error: 'Замес не найден' });
        }

        const batchIngredient = batch.actualIngredients.find((item) => item.id === ingredientId);
        if (!batchIngredient) {
            return res.status(404).json({ error: 'Ингредиент замеса не найден' });
        }

        let canonicalIngredientName = nextIngredientName;
        if (batch.ration) {
            const matchedRationIngredient = batch.ration.ingredients.find((item) =>
                normalizeIngredientName(item.name) === normalizeIngredientName(nextIngredientName)
            );

            if (!matchedRationIngredient) {
                return res.status(400).json({
                    error: 'Корм не входит в рацион этого замеса',
                    allowedIngredients: batch.ration.ingredients.map((item) => item.name)
                });
            }

            canonicalIngredientName = matchedRationIngredient.name;
        }

        // Обновляем имя компонента в базе
        const updatedIngredient = await prisma.batchIngredient.update({
            where: { id: ingredientId },
            data: { ingredientName: canonicalIngredientName }
        });

        const recalculation = await recalculateBatchViolations(prisma, batchId);

        res.json({ status: 'ok', ingredient: updatedIngredient, recalculation });
    } catch (error) {
        console.error('[Ошибка обновления ингредиента]:', error);
        if (error.code === 'P2025') return res.status(404).json({ error: 'Ингредиент замеса не найден' });
        res.status(500).json({ error: 'Не удалось обновить ингредиент замеса' });
    }
});

// ============================================================================
// 6. DELETE /:batchId/ingredients/:ingredientId - Удаление компонента из замеса
// ============================================================================
router.delete('/:batchId/ingredients/:ingredientId', authenticate, requireWriteAccess, async (req, res) => {
    try {
        const batchId = parseInt(req.params.batchId, 10);
        const ingredientId = parseInt(req.params.ingredientId, 10);

        if (!Number.isInteger(batchId) || !Number.isInteger(ingredientId)) {
            return res.status(400).json({ error: 'Некорректный ID замеса или ингредиента' });
        }

        const batch = await prisma.batch.findUnique({
            where: { id: batchId },
            select: { id: true }
        });

        if (!batch) {
            return res.status(404).json({ error: 'Замес не найден' });
        }

        const batchIngredient = await prisma.batchIngredient.findFirst({
            where: { id: ingredientId, batchId },
            select: { id: true, ingredientName: true }
        });

        if (!batchIngredient) {
            return res.status(404).json({ error: 'Ингредиент замеса не найден' });
        }

        await prisma.batchIngredient.delete({
            where: { id: ingredientId }
        });

        const recalculation = await recalculateBatchViolations(prisma, batchId);
        const updatedBatch = await getDetailedBatchById(batchId);

        res.json({
            status: 'ok',
            message: `Компонент "${toDisplayIngredientName(batchIngredient.ingredientName)}" удалён`,
            recalculation,
            batch: updatedBatch
        });
    } catch (error) {
        console.error('[Ошибка удаления ингредиента замеса]:', error);
        if (error.code === 'P2025') return res.status(404).json({ error: 'Ингредиент замеса не найден' });
        res.status(500).json({ error: 'Не удалось удалить ингредиент замеса' });
    }
});

export default router;

import { Router } from 'express';
import prisma from "../../database.js";
import { authenticate, requireAdmin, requireReadAccess, requireWriteAccess } from "../../middleware/auth.js";
import { buildIngredientSummary, buildUnloadProgress, recalculateBatchViolations, toDisplayIngredientName } from './batch-violations.js';
import { normalizeIngredientName } from '../../../../module-2/rationManager.js';
import { getTelemetrySettings } from '../telemetry/telemetry-settings.js';
import telemetryProcessor from '../../../../module-3/telemetryProcessor.js';

const router = Router();

function round1(value) {
    return Math.round(Number(value || 0) * 10) / 10;
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

    const currentWeight = batch.endTime
        ? Number(batch.endWeight ?? latestTelemetry?.weight ?? 0)
        : Number(latestTelemetry?.weight ?? batch.endWeight ?? batch.startWeight ?? 0);
    const peakWeight = Math.max(
        Number(peakTelemetry._max.weight || 0),
        Number(batch.startWeight || 0),
        currentWeight
    );

    return {
        currentWeight,
        peakWeight,
        remainingWeight: round1(Math.max(0, currentWeight)),
        latestTelemetryAt: latestTelemetry?.timestamp || null
    };
}

async function getDetailedBatchById(batchId, prismaClient = prisma) {
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
                orderBy: { addedAt: 'asc' }
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
        getTelemetrySettings(prismaClient)
    ]);

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
            time: ing.addedAt,
            plan: ing.plannedWeight || 0,
            fact: ing.actualWeight,
            deviation: ing.plannedWeight ? (ing.actualWeight - ing.plannedWeight) : 0,
            isViolation: ing.isViolation
        })),
        ingredients: buildIngredientSummary(batch, telemetrySettings)
    };
}

// ============================================================================
// 1. GET / - Получить список замесов (с фильтром по дате, нарушениями и планом)
// ============================================================================
router.get('/', authenticate, requireReadAccess, async (req, res) => {
    try {
        // Логика фильтрации по датам (По умолчанию - сегодня)
        let startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
        let endDate = new Date();
        endDate.setHours(23, 59, 59, 999);

        if (req.query.date) {
            if (Number.isNaN(Date.parse(req.query.date))) {
                return res.status(400).json({ error: 'Некорректная дата фильтра' });
            }
            startDate = new Date(req.query.date);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(req.query.date);
            endDate.setHours(23, 59, 59, 999);
        }

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
                        select: {
                            id: true
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

            return {
                id: b.id,
                deviceId: b.deviceId,
                startTime: b.startTime,
                endTime: b.endTime,
                rationName: b.ration?.name || 'Неизвестный рацион',
                groupName: b.group?.name || 'Без группы',
                hasViolations: hasLoggedViolations, // Единый источник статуса: журнал нарушений (все зафиксированные кейсы)
                startWeight: b.startWeight,
                endWeight: b.endWeight,
                ingredients
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

        const detailedBatch = await getDetailedBatchById(batchId);
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
            where: { id: batchId }
        });

        if (!batch) return res.status(404).json({ error: 'Замес не найден' });

        // Ищем все точки телеметрии за время этого замеса
        const telemetryData = await prisma.telemetry.findMany({
            where: {
                deviceId: batch.deviceId,
                timestamp: {
                    gte: batch.startTime,
                    lte: batch.endTime || new Date() // Если еще не закончен, берем до текущего момента
                }
            },
            select: {
                timestamp: true,
                weight: true,
                lat: true,
                lon: true
            },
            orderBy: { timestamp: 'asc' }
        });

        res.json(telemetryData);
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

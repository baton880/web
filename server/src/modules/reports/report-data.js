import prisma from '../../database.js';
import { aggregateFacts, buildIngredientSummary, getBatchPlan } from '../batches/batch-violations.js';
import { getTelemetrySettings } from '../telemetry/telemetry-settings.js';

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;
export const VIOLATION_THRESHOLD = 10;
export const WORKFLOW_STATUSES_ALL = ['OPEN', 'IN_PROGRESS', 'CLOSED', 'RESOLVED'];
export const WORKFLOW_STATUSES_ACTIVE = new Set(['OPEN', 'IN_PROGRESS']);
export const WORKFLOW_STATUSES_RESOLVED = new Set(['CLOSED', 'RESOLVED']);

function round1(value) {
    return Math.round(Number(value || 0) * 10) / 10;
}

const REPORT_NO_RATION = '\u0411\u0435\u0437 \u0440\u0430\u0446\u0438\u043e\u043d\u0430';
const REPORT_NO_GROUP = '\u0411\u0435\u0437 \u0433\u0440\u0443\u043f\u043f\u044b';
const REPORT_BATCH_PREFIX = '\u0417\u0430\u043c\u0435\u0441';

function buildReportBatchLabel(batchId) {
    return `${REPORT_BATCH_PREFIX} #${batchId}`;
}

export function parsePositiveInt(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseDateBoundary(value, kind) {
    if (!value) return null;

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return { error: `Некорректная дата параметра ${kind}` };
    }

    if (kind === 'from') {
        parsed.setHours(0, 0, 0, 0);
    } else {
        parsed.setHours(23, 59, 59, 999);
    }

    return parsed;
}

function buildBatchDate(batch) {
    return batch.endTime || batch.startTime || null;
}

function getBatchFeedingsPerDay(batch) {
    const parsed = Number(batch?.ration?.feedingsPerDay || batch?.group?.ration?.feedingsPerDay || 1);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getBatchRationName(batch) {
    return batch?.ration?.name || batch?.group?.ration?.name || REPORT_NO_RATION;
}

export function toUiViolationStatus(violation) {
    if (violation.status === 'RESOLVED') return 'closed';
    if (violation.status === 'CLOSED') return 'closed';
    if (violation.status === 'IN_PROGRESS') return 'in_progress';

    const deviationPercent = Math.abs(Number(violation?.deviationPercent || 0));
    if (violation.code === 'MISSING_COMPONENT' || violation.code === 'EXTRA_COMPONENT' || violation.code === 'LEFTOVER_WEIGHT' || violation.code === 'ORDER_MISMATCH' || deviationPercent >= 20) {
        return 'critical';
    }

    return 'open';
}

function incrementCounter(map, key) {
    const normalizedKey = String(key || '').trim() || '—';
    map.set(normalizedKey, Number(map.get(normalizedKey) || 0) + 1);
}

function toTopList(counterMap, top = 3) {
    return Array.from(counterMap.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => {
            if (right.count !== left.count) return right.count - left.count;
            return left.name.localeCompare(right.name, 'ru');
        })
        .slice(0, top);
}

export async function collectReportData({ fromDate = null, toDate = null, limit = DEFAULT_LIMIT } = {}) {
    const where = {};

    if (fromDate || toDate) {
        where.startTime = {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {})
        };
    }

    const [batches, telemetrySettings] = await Promise.all([
        prisma.batch.findMany({
        where,
        include: {
            group: {
                select: {
                    id: true,
                    name: true,
                    headcount: true,
                    ration: {
                        select: {
                            id: true,
                            name: true,
                            feedingsPerDay: true,
                            ingredients: {
                                select: {
                                    id: true,
                                    name: true,
                                    sortOrder: true,
                                    plannedWeight: true,
                                    dryMatterWeight: true,
                                    isCompound: true,
                                    componentsJson: true
                                }
                            }
                        }
                    }
                }
            },
            ration: {
                select: {
                    id: true,
                    name: true,
                    feedingsPerDay: true,
                    ingredients: {
                        select: {
                            id: true,
                            name: true,
                            sortOrder: true,
                            plannedWeight: true,
                            dryMatterWeight: true,
                            isCompound: true,
                            componentsJson: true
                        }
                    }
                }
            },
            actualIngredients: {
                select: {
                    id: true,
                    ingredientName: true,
                    plannedWeight: true,
                    actualWeight: true,
                    isViolation: true,
                    startedAt: true,
                    addedAt: true
                },
                orderBy: [
                    { startedAt: 'asc' },
                    { addedAt: 'asc' },
                    { id: 'asc' }
                ]
            },
            violations: {
                where: { status: { in: WORKFLOW_STATUSES_ALL } },
                select: {
                    id: true,
                    status: true
                }
            }
        },
        orderBy: { startTime: 'desc' },
        take: Math.min(limit, MAX_LIMIT)
        }),
        getTelemetrySettings(prisma)
    ]);

    const violations = await prisma.violation.findMany({
        where: {
            ...(fromDate || toDate ? {
                detectedAt: {
                    ...(fromDate ? { gte: fromDate } : {}),
                    ...(toDate ? { lte: toDate } : {})
                }
            } : {}),
            status: { in: WORKFLOW_STATUSES_ALL }
        },
        include: {
            batch: {
                include: {
                    group: {
                        select: {
                            id: true,
                            name: true
                        }
                    }
                }
            }
        },
        orderBy: { detectedAt: 'desc' },
        take: Math.min(limit, MAX_LIMIT)
    });

    const reportBatches = [];
    const reportViolations = [];
    const reportComponents = [];
    const componentsCounter = new Map();
    const groupsCounter = new Map();
    let activeViolationsCount = 0;
    let resolvedViolationsCount = 0;
    let criticalViolationsCount = 0;

    for (const batch of batches) {
        const plan = getBatchPlan(batch);
        const facts = aggregateFacts(batch.actualIngredients || []);
        const factTotal = facts.reduce((sum, item) => sum + Number(item.actualWeight || 0), 0);
        const batchDate = buildBatchDate(batch);
        const feedingsPerDay = getBatchFeedingsPerDay(batch);

        const violationsCount = batch.violations.length;
        const openViolationsCount = batch.violations.reduce((sum, item) => (
            sum + (WORKFLOW_STATUSES_ACTIVE.has(item.status) ? 1 : 0)
        ), 0);
        const resolvedForBatchCount = batch.violations.reduce((sum, item) => (
            sum + (WORKFLOW_STATUSES_RESOLVED.has(item.status) ? 1 : 0)
        ), 0);

        reportBatches.push({
            id: batch.id,
            date: batchDate,
            rationName: getBatchRationName(batch),
            groupName: batch.group?.name || REPORT_NO_GROUP,
            feedingsPerDay,
            planTotal: round1(plan.totalBatchWeight || 0),
            factTotal: round1(factTotal),
            violationsCount,
            openViolationsCount,
            resolvedViolationsCount: resolvedForBatchCount,
            hasViolations: openViolationsCount > 0
        });

        const componentRows = buildIngredientSummary(batch, telemetrySettings);
        for (const componentRow of componentRows) {
            if (componentRow.isCompound && Array.isArray(componentRow.components) && componentRow.components.length > 0) {
                for (const child of componentRow.components) {
                    reportComponents.push({
                        batchId: batch.id,
                        date: batchDate,
                        batchLabel: buildReportBatchLabel(batch.id),
                        rationName: getBatchRationName(batch),
                        groupName: batch.group?.name || REPORT_NO_GROUP,
                        feedingsPerDay,
                        parentComponent: componentRow.name,
                        component: child.name,
                        plan: round1(child.plan || 0),
                        fact: round1(child.fact || 0),
                        deviation: round1((child.fact || 0) - (child.plan || 0)),
                        deviationPercent: child.deviation_percent ?? 0,
                        isViolation: Boolean(child.isViolation ?? child.is_violation)
                    });
                }
                continue;
            }

            reportComponents.push({
                batchId: batch.id,
                date: batchDate,
                        batchLabel: buildReportBatchLabel(batch.id),
                        rationName: getBatchRationName(batch),
                        groupName: batch.group?.name || REPORT_NO_GROUP,
                        feedingsPerDay,
                parentComponent: '',
                component: componentRow.name,
                plan: round1(componentRow.plan || 0),
                fact: round1(componentRow.fact || 0),
                deviation: round1((componentRow.fact || 0) - (componentRow.plan || 0)),
                deviationPercent: componentRow.deviation_percent ?? 0,
                isViolation: Boolean(componentRow.isViolation ?? componentRow.is_violation)
            });
        }
    }

    for (const violation of violations) {
        const batch = violation.batch;
        const batchDate = violation.detectedAt || buildBatchDate(batch);
        const severityStatus = toUiViolationStatus(violation);
        const workflowStatus = String(violation.status || 'OPEN').toUpperCase();
        const groupName = batch?.group?.name || 'Без группы';
        const componentName = violation.componentName || '—';

        if (WORKFLOW_STATUSES_ACTIVE.has(workflowStatus)) {
            activeViolationsCount += 1;
        } else if (WORKFLOW_STATUSES_RESOLVED.has(workflowStatus)) {
            resolvedViolationsCount += 1;
        }

        if (severityStatus === 'critical') {
            criticalViolationsCount += 1;
        }

        incrementCounter(componentsCounter, componentName);
        incrementCounter(groupsCounter, groupName);

        reportViolations.push({
            id: violation.id,
            batchId: violation.batchId,
            date: batchDate,
            batchLabel: violation.batchId ? `Замес #${violation.batchId}` : 'Без замеса',
            batch: violation.batchId ? `Замес #${violation.batchId}` : 'Без замеса',
            groupName,
            group: groupName,
            component: componentName,
            type: violation.title,
            violationType: violation.title,
            plan: round1(violation.planWeight || 0),
            fact: round1(violation.actualWeight || 0),
            deviation: round1(violation.deviation || 0),
            status: severityStatus,
            workflowStatus,
            code: violation.code,
            message: violation.message,
            comment: violation.comment || null
        });
    }

    const batchesWithViolationsCount = reportBatches.reduce((sum, item) => (
        sum + (item.openViolationsCount > 0 ? 1 : 0)
    ), 0);

    return {
        period: {
            from: fromDate ? fromDate.toISOString() : null,
            to: toDate ? toDate.toISOString() : null
        },
        batches: reportBatches,
        violations: reportViolations,
        components: reportComponents,
        summary: {
            counts: {
                batches: reportBatches.length,
                batchesWithViolations: batchesWithViolationsCount,
                violationsTotal: reportViolations.length,
                violationsActive: activeViolationsCount,
                violationsResolved: resolvedViolationsCount,
                violationsCritical: criticalViolationsCount
            },
            topComponents: toTopList(componentsCounter, 3),
            topGroups: toTopList(groupsCounter, 3)
        }
    };
}

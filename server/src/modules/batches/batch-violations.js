import { calculatePlan, checkViolations, normalizeIngredientName } from '../../../../module-2/rationManager.js';
import { roundWeight } from '../../../../module-2/weightRounding.js';
import { syncBatchViolationLog } from '../violations/violation-service.js';
import { getTelemetrySettings } from '../telemetry/telemetry-settings.js';

function parseCompoundComponents(value) {
    if (Array.isArray(value)) {
        return value
            .map((component) => ({
                name: String(component?.name || '').trim(),
                plannedWeight: Number(component?.plannedWeight || 0)
            }))
            .filter((component) => component.name && component.plannedWeight > 0);
    }

    if (!value) return [];

    try {
        const parsed = JSON.parse(value);
        return parseCompoundComponents(parsed);
    } catch (error) {
        return [];
    }
}

function getIngredientSortOrder(ingredient, fallbackIndex = 0) {
    const parsed = Number(ingredient?.sortOrder);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackIndex + 1;
}

function sortPlanIngredients(ingredients) {
    return [...(Array.isArray(ingredients) ? ingredients : [])].sort((left, right) => {
        const orderDiff = getIngredientSortOrder(left) - getIngredientSortOrder(right);
        if (orderDiff !== 0) return orderDiff;

        const leftId = Number(left?.id || 0);
        const rightId = Number(right?.id || 0);
        if (leftId !== rightId) return leftId - rightId;

        return String(left?.name || '').localeCompare(String(right?.name || ''), 'ru');
    });
}

function getIngredientTimestampMs(ingredient) {
    const parsed = new Date(ingredient?.startedAt || ingredient?.addedAt || 0).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

export function buildOrderViolations(planIngredients, actualIngredients) {
    const expectedSequence = sortPlanIngredients(planIngredients)
        .filter((ingredient) => normalizeIngredientName(ingredient?.name))
        .map((ingredient, index) => ({
            key: normalizeIngredientName(ingredient.name),
            name: toDisplayIngredientName(ingredient.name),
            position: index + 1
        }));

    if (expectedSequence.length <= 1) {
        return [];
    }

    const expectedByKey = new Map(expectedSequence.map((item) => [item.key, item]));
    const actualSequence = [...(Array.isArray(actualIngredients) ? actualIngredients : [])]
        .sort((left, right) => {
            const timeDiff = getIngredientTimestampMs(left) - getIngredientTimestampMs(right);
            if (timeDiff !== 0) return timeDiff;
            return Number(left?.id || 0) - Number(right?.id || 0);
        })
        .map((ingredient) => ({
            key: normalizeIngredientName(ingredient?.ingredientName),
            name: toDisplayIngredientName(ingredient?.ingredientName),
            weight: roundWeight(ingredient?.actualWeight || 0)
        }))
        .filter((ingredient) => ingredient.weight > 0 && expectedByKey.has(ingredient.key));

    const violations = [];
    const loadedKeys = new Set();
    let maxExpectedPosition = 0;

    actualSequence.forEach((actual, actualIndex) => {
        const expected = expectedByKey.get(actual.key);
        if (!expected) return;

        if (!loadedKeys.has(actual.key)) {
            if (expected.position < maxExpectedPosition) {
                violations.push({
                    code: 'ORDER_MISMATCH',
                    ingredient: actual.name,
                    plan: expected.position,
                    fact: actualIndex + 1,
                    deviationPercent: 0,
                    message: `Компонент "${actual.name}" загружен ${actualIndex + 1}-м, но в рационе должен идти ${expected.position}-м`
                });
            }
            maxExpectedPosition = Math.max(maxExpectedPosition, expected.position);
            loadedKeys.add(actual.key);
        }
    });

    return violations;
}

function buildCompoundComponentSummaries(planItem, parentPlanWeight, parentFactWeight, parentIsViolation = false) {
    if (!planItem?.isCompound) {
        return [];
    }

    const components = parseCompoundComponents(planItem.components || planItem.componentsJson);
    if (!components.length || parentPlanWeight <= 0) {
        return [];
    }

    const componentPlanTotal = components.reduce((sum, component) => sum + component.plannedWeight, 0);
    const sourceTotal = componentPlanTotal > 0 ? componentPlanTotal : Number(planItem.plannedWeight || 0);
    const roundedParentPlanWeight = roundWeight(parentPlanWeight);
    const roundedParentFactWeight = roundWeight(parentFactWeight);

    return components.map((component) => {
        const componentPlanWeight = sourceTotal > 0
            ? roundedParentPlanWeight * (component.plannedWeight / sourceTotal)
            : 0;
        const componentFactWeight = sourceTotal > 0
            ? roundedParentFactWeight * (component.plannedWeight / sourceTotal)
            : 0;
        const deviationPercent = componentPlanWeight > 0
            ? Math.round(((componentFactWeight - componentPlanWeight) / componentPlanWeight) * 1000) / 10
            : 0;

        return {
            name: component.name,
            plan: componentPlanWeight,
            fact: componentFactWeight,
            deviation_percent: deviationPercent,
            is_violation: Boolean(parentIsViolation),
            isViolation: Boolean(parentIsViolation)
        };
    });
}

export function resolveDeviationSettings(options = null) {
    if (typeof options === 'number') {
        return {
            percentThreshold: options > 0 ? options : 10,
            minDeviationKg: 10
        };
    }

    const percentRaw = Number(
        options?.percentThreshold
        ?? options?.deviationPercentThreshold
        ?? 10
    );
    const minKgRaw = Number(
        options?.minDeviationKg
        ?? options?.deviationMinKgThreshold
        ?? 10
    );

    return {
        percentThreshold: Number.isFinite(percentRaw) && percentRaw > 0 ? percentRaw : 10,
        minDeviationKg: Number.isFinite(minKgRaw) && minKgRaw > 0 ? minKgRaw : 10
    };
}

export function toDisplayIngredientName(value) {
    const raw = String(value || '').trim();
    const normalized = normalizeIngredientName(raw);

    if (!raw || normalized === 'unknown') {
        return 'Неизвестный';
    }

    return raw;
}

export function aggregateFacts(ingredients) {
    const facts = new Map();

    for (const ingredient of ingredients) {
        const key = normalizeIngredientName(ingredient.ingredientName);
        const current = facts.get(key) || { name: toDisplayIngredientName(ingredient.ingredientName), actualWeight: 0 };
        current.actualWeight += Number(ingredient.actualWeight || 0);
        facts.set(key, current);
    }

    return Array.from(facts.values()).map((item) => ({
        ...item,
        actualWeight: roundWeight(item.actualWeight)
    }));
}

function resolvePlanContext(batch) {
    const groupHeadcount = Number(batch?.group?.headcount || 0);
    const batchFeedingsPerDay = Number(batch?.ration?.feedingsPerDay || 0);
    const groupFeedingsPerDay = Number(batch?.group?.ration?.feedingsPerDay || 0);
    const batchRationIngredients = Array.isArray(batch?.ration?.ingredients) ? batch.ration.ingredients : [];
    const groupRationIngredients = Array.isArray(batch?.group?.ration?.ingredients) ? batch.group.ration.ingredients : [];

    if (groupHeadcount <= 0) {
        return { headcount: 0, feedingsPerDay: 1, ingredients: [] };
    }

    if (batchRationIngredients.length > 0) {
        return {
            headcount: groupHeadcount,
            feedingsPerDay: batchFeedingsPerDay > 0 ? batchFeedingsPerDay : 1,
            ingredients: sortPlanIngredients(batchRationIngredients)
        };
    }

    if (groupRationIngredients.length > 0) {
        return {
            headcount: groupHeadcount,
            feedingsPerDay: groupFeedingsPerDay > 0 ? groupFeedingsPerDay : 1,
            ingredients: sortPlanIngredients(groupRationIngredients)
        };
    }

    return { headcount: groupHeadcount, feedingsPerDay: 1, ingredients: [] };
}

export function getBatchPlan(batch) {
    const context = resolvePlanContext(batch);
    if (!context.ingredients.length || !context.headcount) {
        return { totalBatchWeight: 0, totalDryMatterWeight: 0, ingredients: [] };
    }

    return calculatePlan(context.ingredients, context.headcount, context.feedingsPerDay);
}

export function buildIngredientSummary(batch, deviationOptions = null) {
    const deviationSettings = resolveDeviationSettings(deviationOptions);
    const plan = getBatchPlan(batch);
    const facts = aggregateFacts(batch?.actualIngredients || []);
    const hasPlanContext = plan.ingredients.length > 0;
    const factMap = new Map(facts.map((item) => [normalizeIngredientName(item.name), item.actualWeight]));
    const planMap = new Map(plan.ingredients.map((item) => [normalizeIngredientName(item.name), item.targetWeight]));
    const planItemMap = new Map(plan.ingredients.map((item) => [normalizeIngredientName(item.name), item]));
    const nameMap = new Map([
        ...facts.map((item) => [normalizeIngredientName(item.name), item.name]),
        ...plan.ingredients.map((item) => [normalizeIngredientName(item.name), item.name])
    ]);
    const persistedViolationMap = new Map((batch?.actualIngredients || []).map((item) => [normalizeIngredientName(item.ingredientName), item.isViolation]));
    const names = new Set([...planMap.keys(), ...factMap.keys()]);

    return Array.from(names).map((key) => {
        const name = toDisplayIngredientName(nameMap.get(key) || key || 'Unknown');
        const planItem = planItemMap.get(key) || null;
        const planWeight = planMap.get(key) || 0;
        const factWeight = factMap.get(key) || 0;
        const deviationKg = factWeight - planWeight;
        const allowedDeviationKg = Math.max((planWeight * deviationSettings.percentThreshold) / 100, deviationSettings.minDeviationKg);
        const deviationPercent = planWeight > 0
            ? Math.round(((factWeight - planWeight) / planWeight) * 1000) / 10
            : (factWeight > 0 ? 100 : 0);
        const isViolation = planWeight > 0
            ? Math.abs(deviationKg) > allowedDeviationKg
            : (hasPlanContext
                ? factWeight > 0
                : Boolean(factWeight > 0 || persistedViolationMap.get(key) || key === 'unknown'));

        return {
            name,
            plan: roundWeight(planWeight),
            fact: roundWeight(factWeight),
            deviation_percent: deviationPercent,
            is_violation: isViolation,
            isCompound: Boolean(planItem?.isCompound),
            components: buildCompoundComponentSummaries(planItem, planWeight, factWeight, isViolation)
        };
    });
}

export function buildUnloadProgress(batch, currentWeight, machineState = {}) {
    if (!batch) return null;

    const factLoaded = aggregateFacts(batch.actualIngredients || []).reduce((sum, item) => sum + item.actualWeight, 0);
    const peakWeight = Math.max(Number(machineState.peakWeight || 0), Number(batch.startWeight || 0) + factLoaded);
    const targetWeight = factLoaded > 0 ? factLoaded : Math.max(0, peakWeight - Number(batch.startWeight || 0));
    const unloadedFact = Math.max(0, peakWeight - Number(currentWeight || 0));

    return {
        target_weight: roundWeight(targetWeight),
        unloaded_fact: roundWeight(unloadedFact)
    };
}

export async function recalculateBatchViolations(prisma, batchId, deviationOptions = null) {
    const batch = await prisma.batch.findUnique({
        where: { id: Number(batchId) },
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
            ration: { include: { ingredients: true } },
            actualIngredients: true
        }
    });

    if (!batch) {
        return { status: 'missing', hasViolations: false };
    }

    const plan = getBatchPlan(batch);
    if (!plan.ingredients.length) {
        const facts = aggregateFacts(batch.actualIngredients);
        const syntheticViolations = facts
            .filter((item) => Number(item.actualWeight || 0) > 0)
            .map((item) => ({
                ingredient: toDisplayIngredientName(item.name || 'Unknown'),
                plan: 0,
                fact: roundWeight(item.actualWeight || 0),
                deviationPercent: 100,
                message: 'Загружен компонент вне плана (рацион/группа не назначены)'
            }));
        const violationNames = new Set(syntheticViolations.map((item) => normalizeIngredientName(item.ingredient)));

        for (const ingredient of batch.actualIngredients) {
            await prisma.batchIngredient.update({
                where: { id: ingredient.id },
                data: {
                    plannedWeight: 0,
                    isViolation: violationNames.has(normalizeIngredientName(ingredient.ingredientName))
                }
            });
        }

        await syncBatchViolationLog(prisma, batch, { matches: [], violations: syntheticViolations });

        await prisma.batch.update({
            where: { id: batch.id },
            data: { hasViolations: syntheticViolations.length > 0 }
        });

        return {
            status: 'skipped',
            reason: 'Batch has no ration/group assignment',
            hasViolations: syntheticViolations.length > 0,
            violations: syntheticViolations
        };
    }

    const settings = deviationOptions || await getTelemetrySettings(prisma);
    const deviationSettings = resolveDeviationSettings(settings);
    const facts = aggregateFacts(batch.actualIngredients);
    const check = checkViolations(plan.ingredients, facts, {
        percentThreshold: deviationSettings.percentThreshold,
        minDeviationKg: deviationSettings.minDeviationKg
    });
    const orderViolations = buildOrderViolations(plan.ingredients, batch.actualIngredients);
    const allViolations = [...check.violations, ...orderViolations];
    const weightViolationNames = new Set(check.violations.map((item) => normalizeIngredientName(item.ingredient)));
    const planByName = new Map(plan.ingredients.map((item) => [normalizeIngredientName(item.name), item.targetWeight]));

    for (const ingredient of batch.actualIngredients) {
        await prisma.batchIngredient.update({
            where: { id: ingredient.id },
            data: {
                plannedWeight: roundWeight(planByName.get(normalizeIngredientName(ingredient.ingredientName)) ?? 0),
                isViolation: weightViolationNames.has(normalizeIngredientName(ingredient.ingredientName))
            }
        });
    }

    await prisma.batch.update({
        where: { id: batch.id },
        data: { hasViolations: allViolations.length > 0 }
    });

    await syncBatchViolationLog(prisma, batch, { ...check, violations: allViolations });

    return {
        status: 'ok',
        hasViolations: allViolations.length > 0,
        matches: check.matches,
        violations: allViolations
    };
}

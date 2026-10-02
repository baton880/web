(function (root) {
    "use strict";

    const WEIGHT_TOLERANCE_PERCENT = 5;
    const WEIGHT_TOLERANCE_MIN_KG = 5;
    const IDENTITY_MISMATCH_REASONS = new Set(["ingredient_disagreement"]);

    function finiteNumber(value) {
        if (value === null || value === undefined || value === "") return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizeName(value) {
        return String(value || "").trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
    }

    function inspect(row) {
        const fact = finiteNumber(row?.fact ?? row?.actualWeight);
        const plan = finiteNumber(row?.plan ?? row?.plannedWeight);
        const algorithmWeight = finiteNumber(row?.algorithmWeight);
        const hasTablet = Boolean(row?.tabletTaskId);
        const tabletWeight = hasTablet
            ? finiteNumber(row?.tabletWeight ?? row?.actualWeight ?? row?.fact)
            : null;
        const weightDelta = tabletWeight !== null && algorithmWeight !== null
            ? Math.abs(tabletWeight - algorithmWeight)
            : null;
        const weightDeltaPercent = weightDelta !== null
            ? (tabletWeight === 0 ? (algorithmWeight === 0 ? 0 : Infinity) : weightDelta / Math.abs(tabletWeight) * 100)
            : null;
        const configuredPercent = finiteNumber(row?.weightTolerancePercent);
        const configuredMinKg = finiteNumber(row?.weightToleranceMinKg);
        const weightTolerancePercent = configuredPercent > 0 ? configuredPercent : WEIGHT_TOLERANCE_PERCENT;
        const weightToleranceMinKg = configuredMinKg > 0 ? configuredMinKg : WEIGHT_TOLERANCE_MIN_KG;
        const weightConfirmed = weightDelta !== null && (
            weightDelta <= weightToleranceMinKg || weightDeltaPercent < weightTolerancePercent
        );
        const reason = String(row?.verificationReason || "");
        const algorithmName = String(row?.algorithmIngredientName || "").trim();
        const displayedName = String(row?.name ?? row?.ingredientName ?? "").trim();
        const namesDiffer = Boolean(algorithmName && displayedName && normalizeName(algorithmName) !== normalizeName(displayedName));
        const identityMismatch = IDENTITY_MISMATCH_REASONS.has(reason) || namesDiffer;
        const lowConfidence = row?.verificationStatus === "low_confidence";
        const violationCodes = Array.isArray(row?.violationCodes)
            ? row.violationCodes.map(value => String(value || "")).filter(Boolean)
            : (row?.violationCode ? [String(row.violationCode)] : []);
        const violationMessages = Array.isArray(row?.violationMessages)
            ? row.violationMessages.map(value => String(value || "")).filter(Boolean)
            : [];
        const weightViolationCodes = new Set(["TABLET_DEVIATION", "MISSING_COMPONENT", "EXTRA_COMPONENT"]);
        const orderViolationIndex = violationCodes.indexOf("ORDER_MISMATCH");
        const weightViolationIndex = violationCodes.findIndex(code => weightViolationCodes.has(code));
        const explicitCritical = Boolean(row?.isViolation ?? row?.is_violation) || row?.violationStatus === "critical";
        const orderViolation = orderViolationIndex >= 0;
        const weightPlanViolation = weightViolationIndex >= 0 || (explicitCritical && violationCodes.length === 0);
        const orderMessage = orderViolation
            ? (violationMessages[orderViolationIndex] || "Нарушен порядок загрузки компонентов")
            : "";
        const weightViolationMessage = weightViolationIndex >= 0
            ? (violationMessages[weightViolationIndex] || "Отклонение веса от плана")
            : "";
        const criticalMessage = violationMessages[0]
            || (violationCodes.includes("MISSING_COMPONENT") ? `Не загружен плановый компонент «${displayedName || "без названия"}»`
                : violationCodes.includes("EXTRA_COMPONENT") ? `Загружен компонент вне плана: «${displayedName || "неизвестный компонент"}»`
                    : violationCodes.includes("ORDER_MISMATCH") ? "Нарушен порядок загрузки компонентов"
                        : "Отклонение от плана больше 10%, подтверждено планшетом");

        return {
            fact,
            plan,
            tabletWeight,
            algorithmWeight,
            algorithmName,
            hasTablet,
            weightDelta,
            weightDeltaPercent,
            weightTolerancePercent,
            weightToleranceMinKg,
            weightConfirmed,
            weightMismatch: weightDelta !== null && !weightConfirmed,
            identityMismatch,
            lowConfidence,
            pending: row?.verificationStatus === "pending",
            planViolation: explicitCritical,
            weightPlanViolation,
            weightViolationMessage,
            orderViolation,
            orderMessage,
            violationCodes,
            violationMessages,
            criticalMessage,
            algorithmWarning: row?.violationStatus === "warning",
            reason
        };
    }

    root.IngredientVerificationUi = Object.freeze({
        WEIGHT_TOLERANCE_PERCENT,
        WEIGHT_TOLERANCE_MIN_KG,
        inspect
    });
}(typeof window !== "undefined" ? window : globalThis));

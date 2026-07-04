(function () {
    const API_URL = window.AppAuth?.getApiUrl?.("/api/reports") || "/api/reports";
    const BATCHES_RESET_API_URL = window.AppAuth?.getApiUrl?.("/api/batches/admin/truncate") || "/api/batches/admin/truncate";
    const CAN_ADMIN_RESET = window.AppAuth?.isAdmin?.() === true;
    const DEFAULT_LIMIT = 1000;

    const state = {
        batches: [],
        violations: [],
        components: [],
        summary: {
            counts: {
                batches: 0,
                batchesWithViolations: 0,
                violationsTotal: 0,
                violationsActive: 0,
                violationsResolved: 0,
            },
            topComponents: [],
            topGroups: [],
        },
        fromDate: "",
        toDate: "",
        usingMock: false,
        lastError: "",
    };

    const elements = {
        fromDate: document.getElementById("reportsFromDate"),
        toDate: document.getElementById("reportsToDate"),
        reloadButton: document.getElementById("reportsReloadButton"),
        resetButton: document.getElementById("reportsResetButton"),
        exportButton: document.getElementById("reportsExportButton"),
        periodMeta: document.getElementById("reportsPeriodMeta"),
        quickStats: document.getElementById("reportsQuickStats"),
        batchesCount: document.getElementById("reportsBatchesCount"),
        problemBatchesCount: document.getElementById("reportsProblemBatchesCount"),
        violationsCount: document.getElementById("reportsViolationsCount"),
        openViolationsCount: document.getElementById("reportsOpenViolationsCount"),
        resolvedViolationsCount: document.getElementById("reportsResolvedViolationsCount"),
        violationRate: document.getElementById("reportsViolationRate"),
        batchesMeta: document.getElementById("reportsBatchesMeta"),
        violationsMeta: document.getElementById("reportsViolationsMeta"),
        batchesTableBody: document.getElementById("reportsBatchesTableBody"),
        violationsTableBody: document.getElementById("reportsViolationsTableBody"),
        topComponents: document.getElementById("reportsTopComponents"),
        topGroups: document.getElementById("reportsTopGroups"),
    };

    const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Asia/Novosibirsk",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    });

    const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Asia/Novosibirsk",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

    const numberFormatter = new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
    });

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    async function readErrorMessage(response) {
        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
            try {
                const payload = await response.json();
                return payload?.error || payload?.message || "";
            } catch (error) {
                return "";
            }
        }

        try {
            return (await response.text()).trim();
        } catch (error) {
            return "";
        }
    }

    function toNumber(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }

        if (typeof value === "string" && value.trim()) {
            const normalized = Number(value.replace(",", "."));
            return Number.isFinite(normalized) ? normalized : null;
        }

        return null;
    }

    function parseDate(value) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    function formatDateValue(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
            return "";
        }

        return [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, "0"),
            String(date.getDate()).padStart(2, "0"),
        ].join("-");
    }

    function getDateKey(value) {
        const parsed = parseDate(value);
        if (!parsed) {
            return "";
        }

        return [
            parsed.getFullYear(),
            String(parsed.getMonth() + 1).padStart(2, "0"),
            String(parsed.getDate()).padStart(2, "0"),
        ].join("-");
    }

    function formatDateTime(value) {
        const parsed = parseDate(value);
        if (!parsed) {
            return "—";
        }

        return dateTimeFormatter.format(parsed);
    }

    function formatDateOnly(value) {
        const parsed = parseDate(value);
        if (!parsed) {
            return "—";
        }

        return dateFormatter.format(parsed);
    }

    function formatWeight(value) {
        const numericValue = toNumber(value);
        if (!Number.isFinite(numericValue)) {
            return "—";
        }

        return `${numberFormatter.format(numericValue)} кг`;
    }

    function formatSignedWeight(value) {
        const numericValue = toNumber(value);
        if (!Number.isFinite(numericValue)) {
            return "—";
        }

        const sign = numericValue > 0 ? "+" : "";
        return `${sign}${numberFormatter.format(numericValue)} кг`;
    }

    function isOrderViolation(item) {
        return item?.code === "ORDER_MISMATCH";
    }

    function formatOrderPosition(value) {
        const numericValue = toNumber(value);
        if (!Number.isFinite(numericValue) || numericValue <= 0) {
            return "—";
        }

        return `#${Math.round(numericValue)}`;
    }

    function formatViolationPlan(item) {
        return isOrderViolation(item) ? formatOrderPosition(item.plan) : formatWeight(item.plan);
    }

    function formatViolationFact(item) {
        return isOrderViolation(item) ? formatOrderPosition(item.fact) : formatWeight(item.fact);
    }

    function formatViolationDeviation(item) {
        return isOrderViolation(item) ? "Порядок" : formatSignedWeight(item.deviation);
    }

    function formatPercent(value) {
        const numericValue = toNumber(value);
        if (!Number.isFinite(numericValue)) {
            return "0%";
        }

        return `${numberFormatter.format(numericValue)}%`;
    }

    function normalizeBatch(item) {
        const batchId = item.id ?? item.batchId ?? null;
        const date = item.date ?? item.startTime ?? item.timestamp ?? "";
        const violationsCount = Number(item.violationsCount ?? item.violations ?? 0) || 0;

        return {
            id: batchId,
            date,
            dateKey: getDateKey(date),
            label: item.label ?? item.batchLabel ?? (batchId ? `Замес #${batchId}` : "Замес"),
            rationName: item.rationName ?? item.ration ?? "Без рациона",
            groupName: item.groupName ?? item.group ?? "Без группы",
            feedingsPerDay: Math.max(1, parseInt(item.feedingsPerDay || 1, 10) || 1),
            planTotal: toNumber(item.planTotal ?? item.plan ?? item.targetWeight) ?? 0,
            factTotal: toNumber(item.factTotal ?? item.fact ?? item.actualWeight) ?? 0,
            violationsCount,
            openViolationsCount: Number(item.openViolationsCount ?? 0) || 0,
            resolvedViolationsCount: Number(item.resolvedViolationsCount ?? 0) || 0,
            hasViolations: violationsCount > 0 || Boolean(item.hasViolations),
        };
    }

    function normalizeViolation(item) {
        const date = item.date ?? item.createdAt ?? item.timestamp ?? "";
        const batchId = item.batchId ?? item.id ?? null;
        const plan = toNumber(item.plan ?? item.planned ?? item.planWeight) ?? 0;
        const fact = toNumber(item.fact ?? item.actual ?? item.actualWeight) ?? 0;
        const deviation = toNumber(item.deviation ?? item.delta ?? (fact - plan)) ?? 0;

        return {
            batchId,
            date,
            dateKey: getDateKey(date),
            batchLabel: item.batchLabel ?? item.batch ?? (batchId ? `Замес #${batchId}` : "Замес"),
            groupName: item.groupName ?? item.group ?? "Без группы",
            component: item.component ?? item.componentName ?? "—",
            type: item.type ?? item.violationType ?? item.reason ?? "Нарушение",
            plan,
            fact,
            deviation,
            code: String(item.code || "").trim(),
            message: item.message ?? "",
        };
    }

    const REPORT_NO_RATION = "\u0411\u0435\u0437 \u0440\u0430\u0446\u0438\u043e\u043d\u0430";
    const REPORT_NO_GROUP = "\u0411\u0435\u0437 \u0433\u0440\u0443\u043f\u043f\u044b";
    const REPORT_BATCH_PREFIX = "\u0417\u0430\u043c\u0435\u0441";

    function normalizeComponent(item) {
        const date = item.date ?? item.createdAt ?? item.timestamp ?? "";
        const batchId = item.batchId ?? null;
        const plan = toNumber(item.plan ?? item.planned ?? item.planWeight) ?? 0;
        const fact = toNumber(item.fact ?? item.actual ?? item.actualWeight) ?? 0;
        const deviation = toNumber(item.deviation ?? item.delta ?? (fact - plan)) ?? 0;

        return {
            batchId,
            date,
            dateKey: getDateKey(date),
            batchLabel: item.batchLabel ?? (batchId ? `${REPORT_BATCH_PREFIX} #${batchId}` : REPORT_BATCH_PREFIX),
            rationName: item.rationName ?? item.ration ?? REPORT_NO_RATION,
            groupName: item.groupName ?? item.group ?? REPORT_NO_GROUP,
            feedingsPerDay: Math.max(1, parseInt(item.feedingsPerDay || 1, 10) || 1),
            parentComponent: item.parentComponent ?? "",
            component: item.component ?? item.name ?? "\u2014",
            plan,
            fact,
            deviation,
        };
    }

    function normalizeTopItems(items) {
        if (!Array.isArray(items)) return [];
        return items
            .map((item) => ({
                name: String(item?.name || "—").trim() || "—",
                count: Number(item?.count || 0) || 0,
            }))
            .filter((item) => item.count > 0);
    }

    function normalizeSummary(summary) {
        const counts = summary?.counts || {};
        return {
            counts: {
                batches: Number(counts.batches || 0) || 0,
                batchesWithViolations: Number(counts.batchesWithViolations || 0) || 0,
                violationsTotal: Number(counts.violationsTotal || 0) || 0,
                violationsActive: Number(counts.violationsActive || 0) || 0,
                violationsResolved: Number(counts.violationsResolved || 0) || 0,
            },
            topComponents: normalizeTopItems(summary?.topComponents),
            topGroups: normalizeTopItems(summary?.topGroups),
        };
    }

    function sortByDateDesc(left, right) {
        const leftTime = parseDate(left.date)?.getTime() ?? 0;
        const rightTime = parseDate(right.date)?.getTime() ?? 0;
        return rightTime - leftTime;
    }

    function setDefaultPeriod() {
        const today = new Date();
        const from = new Date(today);
        from.setDate(from.getDate() - 6);

        state.fromDate = formatDateValue(from);
        state.toDate = formatDateValue(today);
    }

    function syncFilterInputs() {
        if (elements.fromDate) {
            elements.fromDate.value = state.fromDate;
        }

        if (elements.toDate) {
            elements.toDate.value = state.toDate;
        }
    }

    function buildReportsUrl() {
        const url = new URL(API_URL, window.location.origin);
        if (state.fromDate) url.searchParams.set("from", state.fromDate);
        if (state.toDate) url.searchParams.set("to", state.toDate);
        url.searchParams.set("limit", String(DEFAULT_LIMIT));
        return url.toString();
    }

    function renderSourceState() {
        if (!state.lastError) return;
        window.AppAuth?.showAlert?.(`Не удалось загрузить данные: ${state.lastError}`, "danger");
    }

    function renderPeriodMeta() {
        const fromText = state.fromDate ? formatDateOnly(state.fromDate) : "—";
        const toText = state.toDate ? formatDateOnly(state.toDate) : "—";

        elements.periodMeta.textContent = `${fromText} - ${toText}`;
        elements.batchesMeta.textContent = `Показано ${state.batches.length} замесов`;
        elements.violationsMeta.textContent = `Показано ${state.violations.length} нарушений`;
    }

    function renderSummary() {
        const counts = state.summary.counts;
        const totalBatches = counts.batches;
        const problemBatches = counts.batchesWithViolations;
        const totalViolations = counts.violationsTotal;
        const openViolations = counts.violationsActive;
        const resolvedViolations = counts.violationsResolved;
        const rate = totalBatches > 0 ? (problemBatches / totalBatches) * 100 : 0;

        elements.batchesCount.textContent = String(totalBatches);
        elements.problemBatchesCount.textContent = String(problemBatches);
        elements.violationsCount.textContent = String(totalViolations);
        if (elements.openViolationsCount) elements.openViolationsCount.textContent = String(openViolations);
        if (elements.resolvedViolationsCount) elements.resolvedViolationsCount.textContent = String(resolvedViolations);
        elements.violationRate.textContent = formatPercent(Math.round(rate * 10) / 10);
        elements.quickStats.textContent = `${totalBatches} замесов · ${totalViolations} нарушений · ${openViolations} открыто`;
    }

    function renderTopList(container, items) {
        if (!container) return;
        if (!Array.isArray(items) || !items.length) {
            container.innerHTML = '<li class="text-muted">Нет данных за период</li>';
            return;
        }

        container.innerHTML = items.map((item) => (
            `<li><span class="font-weight-bold">${escapeHtml(item.name)}</span> · ${item.count}</li>`
        )).join("");
    }

    function renderTopProblems() {
        renderTopList(elements.topComponents, state.summary.topComponents);
        renderTopList(elements.topGroups, state.summary.topGroups);
    }

    function renderBatchesTable() {
        if (!state.batches.length) {
            elements.batchesTableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="reports-empty-state">За выбранный период замесы не найдены.</td>
                </tr>
            `;
            return;
        }

        elements.batchesTableBody.innerHTML = state.batches.map((item) => {
            const statusClassName = item.hasViolations
                ? "reports-status reports-status--danger"
                : "reports-status reports-status--success";
            const statusLabel = item.hasViolations ? "Есть нарушения" : "Без нарушений";
            const batchHref = item.id
                ? `batch-details.html?id=${encodeURIComponent(item.id)}&date=${encodeURIComponent(item.dateKey)}`
                : "";
            const batchLabel = batchHref
                ? `<a class="reports-batch-link" href="${batchHref}">${escapeHtml(item.label)}</a>`
                : escapeHtml(item.label);

            return `
                <tr>
                    <td>
                        <div class="reports-cell-primary">${escapeHtml(formatDateTime(item.date))}</div>
                    </td>
                    <td>${batchLabel}</td>
                    <td>${escapeHtml(item.rationName)}</td>
                    <td>${escapeHtml(item.groupName)}</td>
                    <td><span class="reports-number">${escapeHtml(formatWeight(item.planTotal))}</span></td>
                    <td><span class="reports-number">${escapeHtml(formatWeight(item.factTotal))}</span></td>
                    <td><span class="reports-count-badge">${item.violationsCount}</span></td>
                    <td><span class="${statusClassName}">${statusLabel}</span></td>
                </tr>
            `;
        }).join("");
    }

    function renderViolationsTable() {
        if (!state.violations.length) {
            elements.violationsTableBody.innerHTML = `
                <tr>
                    <td colspan="8" class="reports-empty-state">За выбранный период нарушений не найдено.</td>
                </tr>
            `;
            return;
        }

        elements.violationsTableBody.innerHTML = state.violations.map((item) => {
            const deviationClassName = isOrderViolation(item)
                ? "reports-number"
                : item.deviation > 0
                ? "reports-number reports-number--positive"
                : item.deviation < 0
                    ? "reports-number reports-number--negative"
                    : "reports-number";

            return `
                <tr>
                    <td>
                        <div class="reports-cell-primary">${escapeHtml(formatDateTime(item.date))}</div>
                    </td>
                    <td>${escapeHtml(item.batchLabel)}</td>
                    <td>${escapeHtml(item.groupName)}</td>
                    <td>${escapeHtml(item.component)}</td>
                    <td>${escapeHtml(item.type)}</td>
                    <td><span class="reports-number">${escapeHtml(formatViolationPlan(item))}</span></td>
                    <td><span class="reports-number">${escapeHtml(formatViolationFact(item))}</span></td>
                    <td><span class="${deviationClassName}">${escapeHtml(formatViolationDeviation(item))}</span></td>
                </tr>
            `;
        }).join("");
    }

    function render() {
        renderSourceState();
        renderPeriodMeta();
        renderSummary();
        renderTopProblems();
        renderBatchesTable();
        renderViolationsTable();
    }

    function normalizeApiPayload(payload) {
        const batches = Array.isArray(payload?.batches)
            ? payload.batches
            : Array.isArray(payload?.items)
                ? payload.items
                : Array.isArray(payload)
                    ? payload
                    : [];

        const violations = Array.isArray(payload?.violations) ? payload.violations : [];
        const components = Array.isArray(payload?.components) ? payload.components : [];
        const summary = normalizeSummary(payload?.summary);

        if (!summary.counts.batches) summary.counts.batches = batches.length;
        if (!summary.counts.violationsTotal) summary.counts.violationsTotal = violations.length;
        if (!summary.counts.batchesWithViolations) {
            summary.counts.batchesWithViolations = batches.filter((item) => Number(item?.violationsCount || 0) > 0).length;
        }

        return {
            batches: batches.map(normalizeBatch).sort(sortByDateDesc),
            violations: violations.map(normalizeViolation).sort(sortByDateDesc),
            components: components.map(normalizeComponent).sort(sortByDateDesc),
            summary,
        };
    }

    function applyReportData(reportData, lastError = "") {
        state.batches = reportData.batches;
        state.violations = reportData.violations;
        state.components = reportData.components || [];
        state.summary = reportData.summary;
        state.lastError = lastError;
        render();
    }

    async function loadReports() {
        elements.periodMeta.textContent = "Загрузка...";
        elements.batchesMeta.textContent = "Загрузка...";
        elements.violationsMeta.textContent = "Загрузка...";

        try {
            const response = await fetch(buildReportsUrl(), {
                headers: window.AppAuth?.getAuthHeaders?.() || {},
                credentials: "same-origin",
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const payload = await response.json();
            const normalized = normalizeApiPayload(payload);
            applyReportData(normalized, "");
        } catch (error) {
            applyReportData({
                batches: [],
                violations: [],
                summary: {
                    counts: {
                        batches: 0,
                        batchesWithViolations: 0,
                        violationsTotal: 0,
                        violationsActive: 0,
                        violationsResolved: 0,
                    },
                    topComponents: [],
                    topGroups: [],
                },
            }, error?.message || "Не удалось загрузить данные");
        }
    }

    async function handleResetBatches() {
        if (!CAN_ADMIN_RESET || !elements.resetButton) {
            return;
        }

        const confirmed = window.confirm("Очистить все замесы и связанные нарушения? Рационы и группы останутся.");
        if (!confirmed) {
            return;
        }

        elements.resetButton.disabled = true;
        const previousLabel = elements.resetButton.innerHTML;
        elements.resetButton.innerHTML = '<span class="spinner-border spinner-border-sm mr-2" role="status" aria-hidden="true"></span>Очищаем...';

        try {
            const response = await fetch(BATCHES_RESET_API_URL, {
                method: "DELETE",
                headers: window.AppAuth?.getAuthHeaders?.() || {},
                credentials: "same-origin",
            });

            if (!response.ok) {
                const message = await readErrorMessage(response);
                throw new Error(message || "Не удалось очистить замесы");
            }

            window.AppAuth?.showAlert?.("Замесы и связанные нарушения очищены", "success");
            await loadReports();
        } catch (error) {
            window.AppAuth?.showAlert?.(error.message || "Не удалось очистить замесы", "danger");
        } finally {
            elements.resetButton.disabled = false;
            elements.resetButton.innerHTML = previousLabel;
        }
    }

    function buildExportRows() {
        const summary = [
            ["Показатель", "Значение"],
            ["Период с", state.fromDate || ""],
            ["Период по", state.toDate || ""],
            ["Замесов", String(state.summary.counts.batches || 0)],
            ["Замесов с нарушениями", String(state.summary.counts.batchesWithViolations || 0)],
            ["Нарушений всего", String(state.summary.counts.violationsTotal || 0)],
        ];

        const batches = [
            ["Дата", "Замес", "Рацион", "Группа", "План", "Факт", "Нарушения", "Статус"],
            ...state.batches.map((item) => [
                formatDateTime(item.date),
                item.label,
                item.rationName,
                item.groupName,
                formatWeight(item.planTotal),
                formatWeight(item.factTotal),
                String(item.violationsCount),
                item.hasViolations ? "Есть нарушения" : "Без нарушений",
            ]),
        ];

        const violations = [
            ["Дата", "Замес", "Группа", "Компонент", "Тип", "План", "Факт", "Отклонение"],
            ...state.violations.map((item) => [
                formatDateTime(item.date),
                item.batchLabel,
                item.groupName,
                item.component,
                item.type,
                formatViolationPlan(item),
                formatViolationFact(item),
                formatViolationDeviation(item),
            ]),
        ];

        const components = [
            ["Дата", "Замес", "Рацион", "Группа", "Компонент", "В составе", "План", "Факт", "Отклонение"],
            ...state.components.map((item) => [
                formatDateTime(item.date),
                item.batchLabel,
                item.rationName,
                item.groupName,
                item.component,
                item.parentComponent || "",
                formatWeight(item.plan),
                formatWeight(item.fact),
                formatSignedWeight(item.deviation),
            ]),
        ];

        return { summary, batches, violations, components };
    }

    function normalizeIssuedRationName(value) {
        const raw = String(value || "").trim();
        if (!raw) return REPORT_NO_RATION;

        const lower = raw.toLocaleLowerCase("ru-RU");
        if (
            lower.includes("\u0434\u043e\u0439\u043d")
            && (lower.includes("\u0431\u0430\u0437") || lower.includes("\u0431\u0440\u0438\u0433") || /\b[124]\b/.test(lower))
        ) {
            return "\u0414\u043e\u0439\u043d\u044b\u0435 \u0411\u0430\u0437\u043e\u0432\u044b\u0439";
        }

        return raw;
    }

    function buildDailyDeviationRows() {
        const totals = new Map();

        for (const item of state.components) {
            const dateKey = getDateKey(item.date);
            const componentName = String(item.component || "").trim();
            if (!dateKey || !componentName || componentName === "\u2014") {
                continue;
            }

            const rationName = item.rationName || REPORT_NO_RATION;
            const groupName = item.groupName || REPORT_NO_GROUP;
            const key = [dateKey, rationName, groupName, componentName].join("\u0000");
            const current = totals.get(key) || {
                date: dateKey,
                rationName,
                groupName,
                component: componentName,
                plan: 0,
                fact: 0,
            };

            current.plan += toNumber(item.plan) ?? 0;
            current.fact += toNumber(item.fact) ?? 0;
            totals.set(key, current);
        }

        const rows = [
            [
                "\u0414\u0430\u0442\u0430",
                "\u0420\u0430\u0446\u0438\u043e\u043d",
                "\u0413\u0440\u0443\u043f\u043f\u0430",
                "\u041a\u043e\u043c\u043f\u043e\u043d\u0435\u043d\u0442",
                "\u041f\u043b\u0430\u043d \u0437\u0430 \u0441\u0443\u0442\u043a\u0438",
                "\u0424\u0430\u043a\u0442 \u0437\u0430 \u0441\u0443\u0442\u043a\u0438",
                "\u041e\u0442\u043a\u043b\u043e\u043d\u0435\u043d\u0438\u0435 \u0437\u0430 \u0441\u0443\u0442\u043a\u0438",
            ],
        ];

        Array.from(totals.values())
            .sort((left, right) => (
                left.date.localeCompare(right.date)
                || left.rationName.localeCompare(right.rationName, "ru")
                || left.groupName.localeCompare(right.groupName, "ru")
                || left.component.localeCompare(right.component, "ru")
            ))
            .forEach((item) => {
                rows.push([
                    item.date,
                    item.rationName,
                    item.groupName,
                    item.component,
                    Math.round(item.plan * 10) / 10,
                    Math.round(item.fact * 10) / 10,
                    Math.round((item.fact - item.plan) * 10) / 10,
                ]);
            });

        return rows;
    }

    function buildIssuedFactRows(dateKey = null) {
        const rationNames = [];
        const rationSeen = new Set();
        const componentNames = [];
        const componentSeen = new Set();
        const totals = new Map();

        for (const item of state.components) {
            if (dateKey && getDateKey(item.date) !== dateKey) {
                continue;
            }

            const rationName = normalizeIssuedRationName(item.rationName);
            const componentName = String(item.component || "").trim();
            const fact = toNumber(item.fact) ?? 0;

            if (!componentName || componentName === "\u2014") {
                continue;
            }

            if (!rationSeen.has(rationName)) {
                rationSeen.add(rationName);
                rationNames.push(rationName);
            }

            const componentKey = componentName.toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
            if (!componentSeen.has(componentKey)) {
                componentSeen.add(componentKey);
                componentNames.push(componentName);
            }

            const totalKey = `${componentKey}\u0000${rationName}`;
            totals.set(totalKey, (totals.get(totalKey) || 0) + fact);
        }

        const rows = [
            ["\u043d\u0430\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u043d\u0438\u0435 \u043a\u043e\u0440\u043c\u0430", ...rationNames],
            ["", ...rationNames.map(() => "\u0432\u044b\u0434\u0430\u043d\u043e \u043f\u043e \u0444\u0430\u043a\u0442\u0443")],
        ];

        for (const componentName of componentNames) {
            const componentKey = componentName.toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
            rows.push([
                componentName,
                ...rationNames.map((rationName) => Math.round((totals.get(`${componentKey}\u0000${rationName}`) || 0) * 10) / 10),
            ]);
        }

        return rows;
    }

    function buildIssuedFactSheets() {
        const dateKeys = Array.from(new Set(
            state.components
                .map((item) => getDateKey(item.date))
                .filter(Boolean)
        )).sort();

        if (!dateKeys.length) {
            return [{
                name: "\u0412\u044b\u0434\u0430\u043d\u043e \u043f\u043e \u0444\u0430\u043a\u0442\u0443",
                rows: buildIssuedFactRows(),
            }];
        }

        return dateKeys.map((dateKey) => ({
            name: `\u0412\u044b\u0434\u0430\u043d\u043e ${dateKey}`,
            rows: buildIssuedFactRows(dateKey),
        }));
    }

    function xmlEscape(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function sanitizeWorksheetName(value) {
        const name = String(value || "Sheet").replace(/[\\/?*:[\]]/g, " ").trim() || "Sheet";
        return name.slice(0, 31);
    }

    function buildWorkbookCell(value, rowIndex) {
        const numericValue = typeof value === "number" && Number.isFinite(value) ? value : null;
        const styleId = rowIndex === 0 ? ' ss:StyleID="Header"' : "";

        if (numericValue !== null) {
            return `<Cell${styleId}><Data ss:Type="Number">${numericValue}</Data></Cell>`;
        }

        return `<Cell${styleId}><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
    }

    function getWorkbookCellTextLength(value) {
        if (value === null || value === undefined) {
            return 0;
        }

        return String(value).length;
    }

    function buildWorkbookColumns(rows) {
        const widths = [];

        rows.forEach((row) => {
            row.forEach((cell, index) => {
                widths[index] = Math.max(widths[index] || 0, getWorkbookCellTextLength(cell));
            });
        });

        return widths.map((width) => {
            const excelWidth = Math.max(48, Math.min(320, Math.round((width + 2) * 7)));
            return `<Column ss:AutoFitWidth="0" ss:Width="${excelWidth}"/>`;
        }).join("");
    }

    function buildWorkbookWorksheet(name, rows) {
        const columns = buildWorkbookColumns(rows);
        const tableRows = rows.map((row, rowIndex) => (
            `<Row>${row.map((cell) => buildWorkbookCell(cell, rowIndex)).join("")}</Row>`
        )).join("");

        return `
            <Worksheet ss:Name="${xmlEscape(sanitizeWorksheetName(name))}">
                <Table>${columns}${tableRows}</Table>
            </Worksheet>
        `;
    }

    function buildWorkbookXml(sheets) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
    xmlns="urn:schemas-microsoft-com:office:spreadsheet"
    xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:x="urn:schemas-microsoft-com:office:excel"
    xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
    xmlns:html="http://www.w3.org/TR/REC-html40">
    <Styles>
        <Style ss:ID="Header">
            <Font ss:Bold="1"/>
            <Interior ss:Color="#EEF3FF" ss:Pattern="Solid"/>
        </Style>
    </Styles>
    ${sheets.map((sheet) => buildWorkbookWorksheet(sheet.name, sheet.rows)).join("")}
</Workbook>`;
    }

    function exportToExcel() {
        const rows = buildExportRows();
        const workbookXml = buildWorkbookXml([
            { name: "\u0421\u0432\u043e\u0434\u043a\u0430", rows: rows.summary },
            { name: "\u0417\u0430\u043c\u0435\u0441\u044b", rows: rows.batches },
            { name: "\u041d\u0430\u0440\u0443\u0448\u0435\u043d\u0438\u044f", rows: rows.violations },
            { name: "\u041a\u043e\u043c\u043f\u043e\u043d\u0435\u043d\u0442\u044b \u0437\u0430\u043c\u0435\u0441\u043e\u0432", rows: rows.components },
            { name: "\u0421\u0443\u0442\u043e\u0447\u043d\u044b\u0435 \u043e\u0442\u043a\u043b\u043e\u043d\u0435\u043d\u0438\u044f", rows: buildDailyDeviationRows() },
            ...buildIssuedFactSheets(),
        ]);

        const blob = new Blob(["\ufeff", workbookXml], {
            type: "application/vnd.ms-excel;charset=utf-8;",
        });

        const fromPart = state.fromDate || "from";
        const toPart = state.toDate || "to";
        const fileName = `reports_${fromPart}_${toPart}.xls`;
        const link = document.createElement("a");
        const objectUrl = URL.createObjectURL(blob);

        link.href = objectUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(objectUrl);
    }

    function handleDateChange() {
        const nextFromDate = elements.fromDate?.value || "";
        const nextToDate = elements.toDate?.value || "";

        if (nextFromDate && nextToDate && nextFromDate > nextToDate) {
            window.AppAuth?.showAlert?.("Дата начала периода не может быть позже даты окончания.", "warning");
            syncFilterInputs();
            return;
        }

        state.fromDate = nextFromDate;
        state.toDate = nextToDate;
        loadReports();
    }

    function bindEvents() {
        elements.fromDate?.addEventListener("change", handleDateChange);
        elements.toDate?.addEventListener("change", handleDateChange);
        elements.reloadButton?.addEventListener("click", loadReports);
        elements.resetButton?.addEventListener("click", handleResetBatches);
        elements.exportButton?.addEventListener("click", exportToExcel);
    }

    function init() {
        if (elements.resetButton) {
            elements.resetButton.hidden = !CAN_ADMIN_RESET;
        }

        setDefaultPeriod();
        syncFilterInputs();
        bindEvents();
        loadReports();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();

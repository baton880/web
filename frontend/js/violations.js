(function () {
    const API_URL = window.AppAuth?.getApiUrl?.("/api/violations") || "/api/violations";
    const RESET_API_URL = window.AppAuth?.getApiUrl?.("/api/violations/admin/reset") || "/api/violations/admin/reset";
    const DEFAULT_LIMIT = 1000;
    const CAN_ADMIN_RESET = window.AppAuth?.isAdmin?.() === true;

    const STATUS_META = {
        critical: {
            label: "Критично",
            className: "violations-status violations-status--critical",
        },
        open: {
            label: "Открыто",
            className: "violations-status violations-status--open",
        },
        in_progress: {
            label: "В работе",
            className: "violations-status violations-status--progress",
        },
        closed: {
            label: "Закрыто",
            className: "violations-status violations-status--closed",
        },
    };

    const state = {
        items: [],
        filteredItems: [],
        summary: {
            counts: {
                violationsCritical: 0,
                violationsActive: 0,
                violationsResolved: 0,
            },
            topComponents: [],
            topGroups: [],
            shownCount: 0,
            scope: "all",
        },
        lastError: "",
        fromDate: "",
        toDate: "",
    };

    const elements = {
        tableBody: document.getElementById("violationsTableBody"),
        panelMeta: document.getElementById("violationsPanelMeta"),
        fromDateFilter: document.getElementById("violationsFromDateFilter"),
        toDateFilter: document.getElementById("violationsToDateFilter"),
        typeFilter: document.getElementById("violationsTypeFilter"),
        groupFilter: document.getElementById("violationsGroupFilter"),
        componentFilter: document.getElementById("violationsComponentFilter"),
        scopeFilter: document.getElementById("violationsScopeFilter"),
        reloadButton: document.getElementById("violationsReloadButton"),
        resetButton: document.getElementById("violationsResetButton"),
        criticalCount: document.getElementById("violationsCriticalCount"),
        openCount: document.getElementById("violationsOpenCount"),
        progressCount: document.getElementById("violationsProgressCount"),
        closedCount: document.getElementById("violationsClosedCount"),
        topComponents: document.getElementById("violationsTopComponents"),
        topGroups: document.getElementById("violationsTopGroups"),
    };

    const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Asia/Novosibirsk",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function parseNumber(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }

        if (typeof value === "string" && value.trim()) {
            const normalized = Number(value.replace(",", "."));
            return Number.isFinite(normalized) ? normalized : null;
        }

        return null;
    }

    function formatWeight(value) {
        if (!Number.isFinite(value)) {
            return "—";
        }

        return `${new Intl.NumberFormat("ru-RU", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 1,
        }).format(value)} кг`;
    }

    function formatDeviation(value) {
        if (!Number.isFinite(value)) {
            return '<span class="violations-number">—</span>';
        }

        const sign = value > 0 ? "+" : "";
        const className = value > 0
            ? "violations-number violations-number--positive"
            : value < 0
                ? "violations-number violations-number--negative"
                : "violations-number";

        return `<span class="${className}">${sign}${escapeHtml(formatWeight(value))}</span>`;
    }

    function isOrderViolation(item) {
        return item?.code === "ORDER_MISMATCH";
    }

    function formatOrderPosition(value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || numericValue <= 0) {
            return "—";
        }

        return `#${Math.round(numericValue)}`;
    }

    function formatPlanCell(item) {
        return isOrderViolation(item) ? formatOrderPosition(item.plan) : formatWeight(item.plan);
    }

    function formatFactCell(item) {
        return isOrderViolation(item) ? formatOrderPosition(item.fact) : formatWeight(item.fact);
    }

    function formatDeviationCell(item) {
        if (isOrderViolation(item)) {
            return '<span class="violations-number">Порядок</span>';
        }

        return formatDeviation(item.deviation);
    }

    function formatDate(value) {
        if (!value) {
            return "—";
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return escapeHtml(value);
        }

        return dateTimeFormatter.format(date);
    }

    function getDateKey(value) {
        if (!value) {
            return "";
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return String(value).slice(0, 10);
        }

        return [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, "0"),
            String(date.getDate()).padStart(2, "0"),
        ].join("-");
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

    function getTableColumnSpan() {
        return CAN_ADMIN_RESET ? 10 : 9;
    }

    function normalizeSeverityStatus(value) {
        const normalized = String(value || "").trim().toLowerCase();
        if (normalized === "critical") return "critical";
        if (normalized === "in_progress" || normalized === "in progress" || normalized === "processing") return "in_progress";
        if (normalized === "closed" || normalized === "resolved") return "closed";
        return "open";
    }

    function normalizeWorkflowStatus(value) {
        const normalized = String(value || "").trim().toUpperCase();
        if (["OPEN", "IN_PROGRESS", "CLOSED", "RESOLVED"].includes(normalized)) {
            return normalized;
        }

        if (normalized === "IN PROGRESS") return "IN_PROGRESS";
        return "OPEN";
    }

    function inferViolationType(plan, fact, deviation, fallback) {
        if (fallback) return fallback;
        if (Number.isFinite(plan) && Number.isFinite(fact) && plan > 0 && fact === 0) return "Пропуск компонента";
        if (Number.isFinite(deviation) && deviation < 0) return "Недовложение";
        if (Number.isFinite(deviation) && deviation > 0) return "Перевложение";
        return "Нарушение рецепта";
    }

    function normalizeItem(item) {
        const plan = parseNumber(item.plan ?? item.planned ?? item.planWeight ?? item.target);
        const fact = parseNumber(item.fact ?? item.actual ?? item.factWeight ?? item.actualWeight);
        const deviation = parseNumber(
            item.deviation ?? item.delta ?? (Number.isFinite(plan) && Number.isFinite(fact) ? fact - plan : null)
        );
        const type = inferViolationType(plan, fact, deviation, item.violationType ?? item.type ?? item.reason ?? "");

        return {
            id: item.id ?? null,
            date: item.date ?? item.createdAt ?? item.timestamp ?? item.eventTime ?? "",
            batch: item.batch ?? item.batchName ?? item.mix ?? item.mixName ?? "—",
            group: item.group ?? item.groupName ?? "—",
            component: item.component ?? item.componentName ?? "—",
            type,
            violationType: type,
            plan,
            fact,
            deviation,
            status: normalizeSeverityStatus(item.status ?? item.state),
            workflowStatus: normalizeWorkflowStatus(item.workflowStatus ?? item.state ?? item.status),
            code: String(item.code || "").trim(),
            message: item.message ?? "",
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
                violationsCritical: Number(counts.violationsCritical || 0) || 0,
                violationsActive: Number(counts.violationsActive || 0) || 0,
                violationsResolved: Number(counts.violationsResolved || 0) || 0,
            },
            topComponents: normalizeTopItems(summary?.topComponents),
            topGroups: normalizeTopItems(summary?.topGroups),
            shownCount: Number(summary?.shownCount || 0) || 0,
            scope: String(summary?.scope || "all"),
        };
    }

    function getStatusMeta(status) {
        return STATUS_META[status] || STATUS_META.open;
    }

    function buildUniqueValues(items, fieldName) {
        return Array.from(new Set(
            items
                .map((item) => String(item?.[fieldName] ?? "").trim())
                .filter(Boolean)
                .filter((value) => value !== "—")
        )).sort((left, right) => left.localeCompare(right, "ru"));
    }

    function syncFilterSelectOptions(select, values, defaultLabel) {
        if (!select) return;
        const previousValue = select.value;
        const options = [`<option value="">${escapeHtml(defaultLabel)}</option>`]
            .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`));

        select.innerHTML = options.join("");
        if (values.includes(previousValue)) {
            select.value = previousValue;
        }
    }

    function renderFilterOptions() {
        syncFilterSelectOptions(elements.typeFilter, buildUniqueValues(state.items, "type"), "Все типы");
        syncFilterSelectOptions(elements.groupFilter, buildUniqueValues(state.items, "group"), "Все группы");
        syncFilterSelectOptions(elements.componentFilter, buildUniqueValues(state.items, "component"), "Все компоненты");
    }

    function getVisibleItems() {
        const typeFilter = elements.typeFilter?.value || "";
        const groupFilter = elements.groupFilter?.value || "";
        const componentFilter = elements.componentFilter?.value || "";

        return state.items.filter((item) => {
            if (typeFilter && item.type !== typeFilter) return false;
            if (groupFilter && item.group !== groupFilter) return false;
            if (componentFilter && item.component !== componentFilter) return false;
            return true;
        });
    }

    function renderSummary() {
        const criticalCount = state.items.filter((item) => item.status === "critical").length;
        const openCount = state.items.filter((item) => item.workflowStatus === "OPEN").length;
        const progressCount = state.items.filter((item) => item.workflowStatus === "IN_PROGRESS").length;
        const closedCount = state.items.filter((item) => ["CLOSED", "RESOLVED"].includes(item.workflowStatus)).length;

        elements.criticalCount.textContent = String(criticalCount);
        elements.openCount.textContent = String(openCount);
        elements.progressCount.textContent = String(progressCount);
        elements.closedCount.textContent = String(closedCount);
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

    function renderBanner() {
        if (!state.lastError) return;
        window.AppAuth?.showAlert?.(`Не удалось загрузить данные: ${state.lastError}`, "danger");
    }

    function renderMeta() {
        if (!elements.panelMeta) return;
        const shownCount = state.filteredItems.length;
        const totalCount = state.items.length;
        elements.panelMeta.textContent = `Показано ${shownCount} из ${totalCount}`;
    }

    function renderTable() {
        if (!elements.tableBody) return;

        if (!state.filteredItems.length) {
            elements.tableBody.innerHTML = `
                <tr>
                    <td colspan="${getTableColumnSpan()}" class="violations-empty-state">По текущим фильтрам записи не найдены.</td>
                </tr>
            `;
            return;
        }

        elements.tableBody.innerHTML = state.filteredItems.map((item) => {
            const statusMeta = getStatusMeta(item.status);
            return `
                <tr>
                    <td>
                        <div class="violations-cell-primary">${escapeHtml(formatDate(item.date))}</div>
                        <div class="violations-cell-secondary">${escapeHtml(getDateKey(item.date) || "—")}</div>
                    </td>
                    <td class="violations-cell-primary">${escapeHtml(item.batch)}</td>
                    <td>${escapeHtml(item.group)}</td>
                    <td>${escapeHtml(item.component)}</td>
                    <td>${escapeHtml(item.violationType)}</td>
                    <td><span class="violations-number">${escapeHtml(formatPlanCell(item))}</span></td>
                    <td><span class="violations-number">${escapeHtml(formatFactCell(item))}</span></td>
                    <td>${formatDeviationCell(item)}</td>
                    <td><span class="${statusMeta.className}">${escapeHtml(statusMeta.label)}</span></td>
                    ${CAN_ADMIN_RESET ? `
                        <td data-requires-admin>
                            <button type="button" class="btn btn-sm btn-outline-danger" data-role="violation-reset-one" data-violation-id="${Number(item.id) || ""}">
                                Сбросить
                            </button>
                        </td>
                    ` : ""}
                </tr>
            `;
        }).join("");
    }

    function render() {
        renderFilterOptions();
        state.filteredItems = getVisibleItems();
        renderSummary();
        renderTopList(elements.topComponents, state.summary.topComponents);
        renderTopList(elements.topGroups, state.summary.topGroups);
        renderBanner();
        renderMeta();
        renderTable();
    }

    function setDefaultPeriod() {
        const today = new Date();
        const from = new Date(today);
        from.setDate(from.getDate() - 6);

        state.fromDate = formatDateValue(from);
        state.toDate = formatDateValue(today);
    }

    function syncDateInputs() {
        if (elements.fromDateFilter) {
            elements.fromDateFilter.value = state.fromDate;
        }
        if (elements.toDateFilter) {
            elements.toDateFilter.value = state.toDate;
        }
    }

    function buildApiUrl() {
        const url = new URL(API_URL, window.location.origin);
        if (state.fromDate) url.searchParams.set("from", state.fromDate);
        if (state.toDate) url.searchParams.set("to", state.toDate);
        const scope = elements.scopeFilter?.value || "all";
        url.searchParams.set("scope", scope);
        url.searchParams.set("limit", String(DEFAULT_LIMIT));
        return url.toString();
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

    async function resetAllViolations() {
        if (!CAN_ADMIN_RESET || !elements.resetButton) {
            return;
        }

        const approved = window.confirm("Сбросить все нарушения и флаги нарушений?");
        if (!approved) {
            return;
        }

        elements.resetButton.disabled = true;
        const previousLabel = elements.resetButton.textContent;
        elements.resetButton.textContent = "Сбрасываем...";

        try {
            const response = await fetch(RESET_API_URL, {
                method: "POST",
                headers: window.AppAuth?.getAuthHeaders?.({ includeJson: true }) || { "Content-Type": "application/json" },
                body: JSON.stringify({}),
                credentials: "same-origin",
            });

            if (!response.ok) {
                const message = await readErrorMessage(response);
                throw new Error(message || `HTTP ${response.status}`);
            }

            window.AppAuth?.showAlert?.("Нарушения успешно сброшены", "success");
            await loadViolations();
        } catch (error) {
            window.AppAuth?.showAlert?.(error?.message || "Не удалось сбросить нарушения", "danger");
        } finally {
            elements.resetButton.disabled = false;
            elements.resetButton.textContent = previousLabel;
        }
    }

    async function resetViolationById(violationId) {
        if (!CAN_ADMIN_RESET || !Number.isInteger(violationId) || violationId <= 0) {
            return;
        }

        const approved = window.confirm(`Удалить нарушение #${violationId}?`);
        if (!approved) {
            return;
        }

        try {
            const response = await fetch(`${API_URL}/${violationId}`, {
                method: "DELETE",
                headers: window.AppAuth?.getAuthHeaders?.() || {},
                credentials: "same-origin",
            });

            if (!response.ok) {
                const message = await readErrorMessage(response);
                throw new Error(message || `HTTP ${response.status}`);
            }

            window.AppAuth?.showAlert?.(`Нарушение #${violationId} удалено`, "success");
            await loadViolations();
        } catch (error) {
            window.AppAuth?.showAlert?.(error?.message || "Не удалось удалить нарушение", "danger");
        }
    }

    async function loadViolations() {
        if (elements.panelMeta) {
            elements.panelMeta.textContent = "Загрузка...";
        }

        if (elements.tableBody) {
            elements.tableBody.innerHTML = `
                <tr>
                    <td colspan="${getTableColumnSpan()}" class="violations-empty-state">Загрузка нарушений...</td>
                </tr>
            `;
        }

        try {
            const response = await fetch(buildApiUrl(), {
                headers: window.AppAuth?.getAuthHeaders?.() || {},
                credentials: "same-origin",
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const payload = await response.json();
            const itemsRaw = Array.isArray(payload)
                ? payload
                : Array.isArray(payload?.items)
                    ? payload.items
                    : Array.isArray(payload?.violations)
                        ? payload.violations
                        : [];

            state.items = itemsRaw.map(normalizeItem);
            state.summary = normalizeSummary(payload?.summary);
            state.lastError = "";
        } catch (error) {
            state.items = [];
            state.summary = normalizeSummary(null);
            state.lastError = error?.message || "Не удалось загрузить данные";
        }

        render();
    }

    function handleDateChange() {
        const fromDate = elements.fromDateFilter?.value || "";
        const toDate = elements.toDateFilter?.value || "";

        if (fromDate && toDate && fromDate > toDate) {
            window.AppAuth?.showAlert?.("Дата начала периода не может быть позже даты окончания.", "warning");
            syncDateInputs();
            return;
        }

        state.fromDate = fromDate;
        state.toDate = toDate;
        loadViolations();
    }

    function bindEvents() {
        elements.fromDateFilter?.addEventListener("change", handleDateChange);
        elements.toDateFilter?.addEventListener("change", handleDateChange);
        elements.scopeFilter?.addEventListener("change", loadViolations);

        [elements.typeFilter, elements.groupFilter, elements.componentFilter].forEach((control) => {
            control?.addEventListener("change", render);
        });

        elements.reloadButton?.addEventListener("click", loadViolations);
        elements.resetButton?.addEventListener("click", resetAllViolations);

        elements.tableBody?.addEventListener("click", (event) => {
            const button = event.target?.closest?.("[data-role='violation-reset-one']");
            if (!button) {
                return;
            }

            const violationId = Number.parseInt(button.getAttribute("data-violation-id") || "", 10);
            if (!Number.isInteger(violationId) || violationId <= 0) {
                return;
            }

            resetViolationById(violationId);
        });
    }

    function init() {
        setDefaultPeriod();
        syncDateInputs();
        if (elements.resetButton) {
            elements.resetButton.hidden = !CAN_ADMIN_RESET;
        }
        bindEvents();
        loadViolations();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();

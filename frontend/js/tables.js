$(document).ready(function () {
    const dateInput = document.getElementById("batchesDateFilter");
    const filterMeta = document.getElementById("batchesFilterMeta");
    const resetButton = document.getElementById("batchesResetButton");
    const BATCHES_RESET_API_URL = window.AppAuth?.getApiUrl?.("/api/batches/admin/truncate") || "/api/batches/admin/truncate";
    const CAN_ADMIN_RESET = window.AppAuth?.isAdmin?.() === true;
    const CAN_WRITE = window.AppAuth?.hasWriteAccess?.() === true;

    const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Asia/Barnaul",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    });

    const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Asia/Barnaul",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Asia/Barnaul",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const weightFormatter = new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
    });

    const initialUrl = new URL(window.location.href);
    const hasExplicitInitialDate = Boolean(normalizeDateValue(initialUrl.searchParams.get("date")));

    let lastSnapshotKey = "";
    let activeRequestId = 0;
    let lastAlertKey = "";
    let didUseLatestAvailableDate = false;
    const BATCH_COLUMN_LABELS = [
        "Время",
        "План",
        "Группа",
        "Итоговый вес",
        "Нарушения",
        "Компоненты",
        "Действия",
    ];

    const table = $("#batchesTable").DataTable({
        language: {
            url: "https://cdn.datatables.net/plug-ins/1.13.6/i18n/ru.json",
            emptyTable: "Нет замесов за выбранную дату",
            zeroRecords: "Нет замесов за выбранную дату",
        },
        searching: false,
        lengthChange: false,
        info: false,
        ordering: false,
        autoWidth: false,
        pageLength: 25,
        createdRow: function (row, data) {
            if (!data?.id) {
                return;
            }

            row.classList.add("batch-table-row");
            row.setAttribute("tabindex", "0");
            row.setAttribute("role", "link");
            row.setAttribute("aria-label", `Открыть детали замеса ${data.id}`);
            Array.from(row.cells).forEach((cell, index) => {
                cell.dataset.label = BATCH_COLUMN_LABELS[index] || "";
            });
        },
        columns: [
            {
                data: "startTime",
                className: "align-middle",
                render: function (data, type) {
                    if (type !== "display") {
                        return data || "";
                    }

                    return formatDateTime(data);
                },
            },
            {
                data: "rationName",
                className: "align-middle",
                render: function (data, type) {
                    if (type !== "display") {
                        return data || "";
                    }

                    return `<strong>${escapeHtml(data || "Без плана")}</strong>`;
                },
            },
            {
                data: "groupName",
                className: "align-middle",
                render: function (data, type) {
                    if (type !== "display") {
                        return data || "";
                    }

                    return escapeHtml(data || "Без группы");
                },
            },
            {
                data: "totalActualWeight",
                className: "align-middle batch-table-final-weight",
                render: function (data, type, row) {
                    const statusMarkup = renderPostprocessStatus(row);
                    if (statusMarkup) {
                        return type === "display" ? statusMarkup : "";
                    }

                    if (row?.hasIngredientFacts === false) {
                        return type === "display" ? '<span class="text-muted">Нет данных</span>' : "";
                    }

                    const formattedWeight = formatWeight(data);
                    if (type !== "display") {
                        return Number.isFinite(Number(data)) ? Number(data) : "";
                    }

                    return formattedWeight
                        ? `<strong class="batch-final-weight">${escapeHtml(formattedWeight)}</strong>`
                        : '<span class="text-muted">—</span>';
                },
            },
            {
                data: "hasViolations",
                className: "align-middle text-center",
                render: function (data, type, row) {
                    if (type !== "display") {
                        return data ? "1" : "0";
                    }

                    const statusMarkup = renderPostprocessStatus(row);
                    if (statusMarkup) {
                        return statusMarkup;
                    }

                    return renderBatchViolationBadge(row, data);
                },
            },
            {
                data: "ingredients",
                className: "batch-table-ingredients",
                render: function (data, type, row) {
                    const ingredients = Array.isArray(data) ? data : [];

                    if (type !== "display") {
                        return ingredients.length;
                    }

                    return renderIngredients(ingredients, row);
                },
            },
            {
                data: null,
                className: "align-middle text-center",
                orderable: false,
                render: function (data, type, row) {
                    if (type !== "display") {
                        return "";
                    }

                    const id = Number(row?.id);
                    if (!CAN_WRITE || !Number.isInteger(id)) {
                        return '<span class="text-muted small">--</span>';
                    }

                    return `
                        <button
                            type="button"
                            class="btn btn-sm btn-outline-danger"
                            data-role="delete-batch"
                            data-batch-id="${id}"
                            title="Удалить замес #${id}"
                        >
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    `;
                },
            },
        ],
    });

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function asBoolean(value) {
        if (typeof value === "boolean") {
            return value;
        }

        if (typeof value === "number") {
            return value !== 0;
        }

        if (typeof value === "string") {
            const normalized = value.trim().toLowerCase();
            return normalized === "true" || normalized === "1" || normalized === "yes";
        }

        return false;
    }

    function getTodayValue() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    function normalizeDateValue(value) {
        return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : "";
    }

    function getInitialDateValue() {
        return normalizeDateValue(initialUrl.searchParams.get("date")) || getTodayValue();
    }

    function getSelectedDateValue() {
        const value = normalizeDateValue(dateInput?.value);
        return value || getTodayValue();
    }

    function formatDateLabel(dateValue) {
        const parsedDate = new Date(`${dateValue}T00:00:00`);
        return Number.isNaN(parsedDate.getTime()) ? dateValue : dateFormatter.format(parsedDate);
    }

    function formatDateTime(value) {
        if (!value) {
            return '<span class="text-muted">-</span>';
        }

        const parsedDate = new Date(value);
        if (Number.isNaN(parsedDate.getTime())) {
            return '<span class="text-muted">-</span>';
        }

        return escapeHtml(dateTimeFormatter.format(parsedDate));
    }

    function formatIngredientTime(value) {
        if (!value) {
            return "";
        }

        const parsedDate = new Date(value);
        if (Number.isNaN(parsedDate.getTime())) {
            return "";
        }

        return timeFormatter.format(parsedDate);
    }

    function formatWeight(value) {
        if (value === null || value === undefined || value === "") {
            return "";
        }
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return "";
        }

        return `${weightFormatter.format(numericValue)} кг`;
    }

    function renderBooleanBadge(value) {
        const badgeClass = value ? "dashboard-bool-badge is-yes" : "dashboard-bool-badge is-no";
        const label = value ? "Да" : "Нет";
        return `<span class="${badgeClass}">${label}</span>`;
    }

    function renderBatchViolationBadge(row, value) {
        const verificationBadge = row?.hasUnverifiedTabletIngredient
            ? '<span class="dashboard-bool-badge is-warning">Проверить компоненты</span>' : '';
        const warningLabel = row?.violationLabel || null;
        if (String(row?.violationStatus || "").toLowerCase() === "warning") {
            return `<span class="batch-violation-badges"><span class="dashboard-bool-badge is-warning">${escapeHtml(warningLabel || "Сол.+Люц.")}</span>${verificationBadge}</span>`;
        }

        if (warningLabel && asBoolean(value)) {
            return `<span class="batch-violation-badges">${[
                `<span class="dashboard-bool-badge is-warning">${escapeHtml(warningLabel)}</span>`,
                renderBooleanBadge(true), verificationBadge
            ].join(" ")}</span>`;
        }

        return `<span class="batch-violation-badges">${renderBooleanBadge(asBoolean(value))}${verificationBadge}</span>`;
    }

    function getPostprocessStatus(row) {
        return String(row?.postprocess?.status || (row?.endTime ? "complete" : "in_progress")).toLowerCase();
    }

    function renderPostprocessStatus(row) {
        if (row?.processingMode === 'realtime-v1') return null;
        const status = getPostprocessStatus(row);
        if (status === "in_progress") {
            return '<span class="dashboard-bool-badge is-no">В процессе</span>';
        }
        if (status === "processing" || status === "pending") {
            return '<span class="dashboard-bool-badge is-no">Обрабатывается</span>';
        }
        return null;
    }

    function renderIngredientSignal(kind, icon, label) {
        const safeLabel = escapeHtml(label);
        return `<button type="button" class="ingredient-signal ingredient-signal--${kind}" data-role="ingredient-signal" data-tooltip="${safeLabel}" aria-label="${safeLabel}" aria-expanded="false" title="${safeLabel}"><i class="fas ${icon}" aria-hidden="true"></i></button>`;
    }

    function getLowConfidenceText(reason) {
        if (reason === "pair_tablet_hint") return "Солома/люцерна выбрана по планшету: погрузчик не подтвердил компонент";
        if (reason === "calibration_changed") return "В ходе загрузки изменилась калибровка";
        if (reason === "insufficient_telemetry") return "Недостаточно измерений веса";
        if (reason === "host_position_missing" || reason === "rtk_unavailable" || reason === "ingredient_unknown") return "Недостаточно данных GPS для уверенного определения компонента";
        return "Недостаточно данных для уверенного определения компонента";
    }

    function renderIngredientSignals(ingredient, verification) {
        const signals = [];
        if (verification.weightPlanViolation) {
            signals.push(renderIngredientSignal("danger", "fa-exclamation", verification.weightViolationMessage || verification.criticalMessage));
        }
        if (verification.orderViolation) {
            signals.push(renderIngredientSignal("danger", "fa-sort-amount-down", verification.orderMessage));
        }
        if (verification.weightConfirmed) {
            signals.push(renderIngredientSignal("success", "fa-check", `Вес принят по алгоритму: допуск меньше ${verification.weightTolerancePercent}% либо до ${verification.weightToleranceMinKg} кг включительно`));
        }
        if (verification.weightMismatch) {
            signals.push(renderIngredientSignal("warning", "fa-exclamation", `Вес алгоритма выходит за допуск: ${verification.weightTolerancePercent}% / минимум ${verification.weightToleranceMinKg} кг`));
        }
        if (verification.identityMismatch) {
            signals.push(renderIngredientSignal("warning", "fa-exclamation", "Алгоритм определил другой компонент"));
        } else if (verification.lowConfidence) {
            signals.push(renderIngredientSignal("warning", "fa-exclamation", getLowConfidenceText(verification.reason)));
        } else if (verification.algorithmWarning && !verification.weightMismatch) {
            signals.push(renderIngredientSignal("warning", "fa-exclamation", "Алгоритм видит отклонение, которого нет по данным планшета"));
        }
        if (verification.pending) {
            signals.push(renderIngredientSignal("info", "fa-clock", "Проверка ожидает следующее измерение HOST"));
        }
        if (!verification.hasTablet && ingredient?.verificationStatus === "confirmed") {
            signals.push(renderIngredientSignal("info", "fa-map-marker-alt", "Компонент определён алгоритмом по GPS"));
        }
        return signals.join("");
    }

    function renderIngredients(ingredients, row) {
        const statusMarkup = renderPostprocessStatus(row);
        if (statusMarkup) {
            return statusMarkup;
        }

        if (row?.hasIngredientFacts === false) {
            return '<span class="text-muted">Нет данных о компонентах</span>';
        }

        if (!ingredients.length) {
            return '<span class="text-muted">Нет компонентов</span>';
        }

        return `
            <div class="ingredient-summary-list">
                ${ingredients.map((ingredient, index) => {
                    const name = escapeHtml(ingredient?.name || "Без названия");
                    const ingredientTime = formatIngredientTime(ingredient?.time);
                    const plan = formatWeight(ingredient?.plan);
                    const fact = formatWeight(ingredient?.fact);
                    const verification = window.IngredientVerificationUi.inspect(ingredient);
                    const detailRows = [];
                    if (verification.weightMismatch) {
                        detailRows.push(`<span>Планшет: ${escapeHtml(formatWeight(verification.tabletWeight))}</span><span>Алгоритм: ${escapeHtml(formatWeight(verification.algorithmWeight))}</span>`);
                    }
                    if (verification.identityMismatch) {
                        detailRows.push(`<span class="ingredient-summary__note ingredient-summary__note--warning">Алгоритм считает, что загружен компонент «${escapeHtml(verification.algorithmName || "другой компонент")}»</span>`);
                    } else if (verification.algorithmWarning && !verification.weightMismatch) {
                        detailRows.push('<span class="ingredient-summary__note ingredient-summary__note--warning">Алгоритм видит отклонение от плана</span>');
                    }

                    return `
                        <div class="ingredient-summary${index < ingredients.length - 1 ? " ingredient-summary--divided" : ""}">
                            <div class="ingredient-summary__header">
                                <span class="ingredient-summary__name">${name}</span>
                                <span class="ingredient-summary__signals">${renderIngredientSignals(ingredient, verification)}</span>
                            </div>
                            <div class="ingredient-summary__metric${verification.weightPlanViolation ? " ingredient-summary__metric--danger" : ""}">
                                <span title="Фактический вес">${escapeHtml(fact || "Нет данных")}</span>${plan ? `<span class="ingredient-summary__slash">/</span><span title="Вес по плану">${escapeHtml(plan)}</span>` : ""}
                            </div>
                            ${detailRows.length ? `<div class="ingredient-summary__details">${detailRows.join("")}</div>` : ""}
                            ${ingredientTime ? `<div class="ingredient-summary__time">${escapeHtml(ingredientTime)}</div>` : ""}
                        </div>
                    `;
                }).join("")}
            </div>
        `;
    }

    function formatBatchWord(count) {
        const absoluteCount = Math.abs(Number(count) || 0);
        const lastTwoDigits = absoluteCount % 100;
        const lastDigit = absoluteCount % 10;

        if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
            return "замесов";
        }

        if (lastDigit === 1) {
            return "замес";
        }

        if (lastDigit >= 2 && lastDigit <= 4) {
            return "замеса";
        }

        return "замесов";
    }

    function updateFilterMeta(dateValue, options) {
        if (!filterMeta) {
            return;
        }
        
        filterMeta.textContent = "";
    }

    function updatePageUrl(dateValue) {
        const url = new URL(window.location.href);

        if (dateValue === getTodayValue()) {
            url.searchParams.delete("date");
        } else {
            url.searchParams.set("date", dateValue);
        }

        window.history.replaceState({}, "", url.toString());
    }

    function buildBatchesUrl(dateValue) {
        const baseUrl = window.AppAuth?.getApiUrl?.("/api/batches") || "/api/batches";
        const url = new URL(baseUrl, window.location.origin);

        if (dateValue !== getTodayValue()) {
            url.searchParams.set("date", dateValue);
        }

        return url.toString();
    }

    async function getLatestAvailableDate() {
        const baseUrl = window.AppAuth?.getApiUrl?.("/api/batches/latest-date") || "/api/batches/latest-date";
        const response = await fetch(baseUrl, {
            method: "GET",
            headers: window.AppAuth?.getAuthHeaders?.() || {},
        });

        if (!response.ok) {
            return "";
        }

        const payload = await response.json();
        return normalizeDateValue(payload?.date);
    }

    function buildBatchDetailsUrl(batchId) {
        const url = new URL("batch-details.html", window.location.href);
        const selectedDate = getSelectedDateValue();

        url.searchParams.set("id", String(batchId));
        if (selectedDate !== getTodayValue()) {
            url.searchParams.set("date", selectedDate);
        } else {
            url.searchParams.delete("date");
        }

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

    async function resetBatches() {
        if (!CAN_ADMIN_RESET || !resetButton) {
            return;
        }

        const confirmed = window.confirm("Очистить все замесы и связанные нарушения? Рационы и группы не будут удалены.");
        if (!confirmed) {
            return;
        }

        resetButton.disabled = true;
        const previousLabel = resetButton.innerHTML;
        resetButton.innerHTML = '<span class="spinner-border spinner-border-sm mr-2" role="status" aria-hidden="true"></span>Очищаем...';

        try {
            const response = await fetch(BATCHES_RESET_API_URL, {
                method: "DELETE",
                headers: window.AppAuth?.getAuthHeaders?.() || {},
            });

            if (!response.ok) {
                const message = await readErrorMessage(response);
                throw new Error(message || "Не удалось очистить замесы");
            }

            lastSnapshotKey = "";
            await loadBatches({ force: true });
            window.AppAuth?.showAlert?.("Замесы и связанные нарушения очищены", "success");
        } catch (error) {
            console.error("Ошибка очистки замесов:", error);
            window.AppAuth?.showAlert?.(error.message || "Не удалось очистить замесы", "danger");
        } finally {
            resetButton.disabled = false;
            resetButton.innerHTML = previousLabel;
        }
    }

    async function deleteBatch(batchId) {
        if (!CAN_WRITE || !Number.isInteger(batchId)) {
            return;
        }

        const confirmed = window.confirm(`Удалить замес #${batchId}? Это действие нельзя отменить.`);
        if (!confirmed) {
            return;
        }

        try {
            const deleteUrl = window.AppAuth?.getApiUrl?.(`/api/batches/${batchId}`) || `/api/batches/${batchId}`;
            const response = await fetch(deleteUrl, {
                method: "DELETE",
                headers: window.AppAuth?.getAuthHeaders?.() || {},
            });

            if (!response.ok) {
                const message = await readErrorMessage(response);
                throw new Error(message || "Не удалось удалить замес");
            }

            lastSnapshotKey = "";
            await loadBatches({ force: true });
            window.AppAuth?.showAlert?.(`Замес #${batchId} удалён`, "success");
        } catch (error) {
            console.error("Ошибка удаления замеса:", error);
            window.AppAuth?.showAlert?.(error.message || "Не удалось удалить замес", "danger");
        }
    }

    function showLoadError(message, dateValue) {
        const alertKey = `${dateValue}|${message}`;
        if (alertKey === lastAlertKey) {
            return;
        }

        lastAlertKey = alertKey;
        window.AppAuth?.showAlert?.(message, "danger");
    }

    function clearLoadError() {
        if (!lastAlertKey) {
            return;
        }

        lastAlertKey = "";
        window.AppAuth?.dismissAlerts?.();
    }

    async function loadBatches(options) {
        const settings = options || {};
        const dateValue = getSelectedDateValue();
        const requestId = ++activeRequestId;

        if (dateInput && dateInput.value !== dateValue) {
            dateInput.value = dateValue;
        }

        updateFilterMeta(dateValue, { loading: true });
        updatePageUrl(dateValue);

        try {
            const response = await fetch(buildBatchesUrl(dateValue), {
                method: "GET",
                headers: window.AppAuth?.getAuthHeaders?.() || {},
            });

            if (!response.ok) {
                const responseMessage = await readErrorMessage(response);
                throw new Error(responseMessage || "Не удалось получить список замесов");
            }

            const payload = await response.json();
            const rows = Array.isArray(payload) ? payload : [];

            if (requestId !== activeRequestId) {
                return;
            }

            if (!hasExplicitInitialDate && !didUseLatestAvailableDate && rows.length === 0) {
                didUseLatestAvailableDate = true;
                const latestDate = await getLatestAvailableDate();

                if (latestDate && latestDate !== dateValue) {
                    if (dateInput) {
                        dateInput.value = latestDate;
                    }
                    return loadBatches({ force: true });
                }
            }

            const nextSnapshotKey = `${dateValue}|${JSON.stringify(rows)}`;
            if (settings.force || nextSnapshotKey !== lastSnapshotKey) {
                table.clear().rows.add(rows).draw(false);
                lastSnapshotKey = nextSnapshotKey;
            }

            clearLoadError();
            updateFilterMeta(dateValue, { count: rows.length });
        } catch (error) {
            if (requestId !== activeRequestId) {
                return;
            }

            console.error("Ошибка загрузки замесов:", error);
            updateFilterMeta(dateValue, { error: true });
            showLoadError(error.message || "Не удалось загрузить замесы", dateValue);
        }
    }

    function openBatchDetails(batchId) {
        if (!batchId) {
            return;
        }

        window.location.href = buildBatchDetailsUrl(batchId);
    }

    $("#batchesTable tbody").on("click", "tr", function (event) {
        if ($(event.target).closest("a, button, input, select, textarea").length) {
            return;
        }

        const rowData = table.row(this).data();
        openBatchDetails(rowData?.id);
    });

    $("#batchesTable tbody").on("click", "button[data-role='ingredient-signal']", function (event) {
        event.preventDefault();
        event.stopPropagation();

        const signal = this;
        const willOpen = !signal.classList.contains("is-open");
        document.querySelectorAll("#batchesTable button[data-role='ingredient-signal'].is-open").forEach((openSignal) => {
            openSignal.classList.remove("is-open");
            openSignal.setAttribute("aria-expanded", "false");
        });

        if (willOpen) {
            signal.classList.add("is-open");
            signal.setAttribute("aria-expanded", "true");
        }
    });

    $("#batchesTable tbody").on("keydown", "tr", function (event) {
        if (event.key !== "Enter" && event.key !== " ") {
            return;
        }

        event.preventDefault();
        const rowData = table.row(this).data();
        openBatchDetails(rowData?.id);
    });

    $("#batchesTable tbody").on("click", "button[data-role='delete-batch']", function (event) {
        event.preventDefault();
        event.stopPropagation();

        const rawId = Number.parseInt(this.dataset.batchId, 10);
        if (!Number.isInteger(rawId)) {
            return;
        }

        deleteBatch(rawId);
    });

    if (dateInput) {
        dateInput.value = getInitialDateValue();
        dateInput.addEventListener("change", function () {
            lastSnapshotKey = "";
            loadBatches({ force: true });
        });
    }

    if (resetButton) {
        resetButton.hidden = !CAN_ADMIN_RESET;
        if (CAN_ADMIN_RESET) {
            resetButton.addEventListener("click", resetBatches);
        }
    }

    loadBatches({ force: true });

    window.setInterval(function () {
        loadBatches();
    }, 2000);
});

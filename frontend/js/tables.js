$(document).ready(function () {
    const dateInput = document.getElementById("batchesDateFilter");
    const filterMeta = document.getElementById("batchesFilterMeta");
    const resetButton = document.getElementById("batchesResetButton");
    const BATCHES_RESET_API_URL = window.AppAuth?.getApiUrl?.("/api/batches/admin/truncate") || "/api/batches/admin/truncate";
    const CAN_ADMIN_RESET = window.AppAuth?.isAdmin?.() === true;
    const CAN_WRITE = window.AppAuth?.hasWriteAccess?.() === true;

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
        second: "2-digit",
    });

    const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Asia/Novosibirsk",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const weightFormatter = new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
    });

    const initialUrl = new URL(window.location.href);

    let lastSnapshotKey = "";
    let activeRequestId = 0;
    let lastAlertKey = "";

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
        const warningLabel = row?.violationLabel || null;
        if (String(row?.violationStatus || "").toLowerCase() === "warning") {
            return `<span class="dashboard-bool-badge is-warning">${escapeHtml(warningLabel || "Сол.+Люц.")}</span>`;
        }

        if (warningLabel && asBoolean(value)) {
            return [
                `<span class="dashboard-bool-badge is-warning">${escapeHtml(warningLabel)}</span>`,
                renderBooleanBadge(true)
            ].join(" ");
        }

        return renderBooleanBadge(asBoolean(value));
    }

    function getPostprocessStatus(row) {
        return String(row?.postprocess?.status || (row?.endTime ? "complete" : "in_progress")).toLowerCase();
    }

    function renderPostprocessStatus(row) {
        const status = getPostprocessStatus(row);
        if (status === "in_progress") {
            return '<span class="dashboard-bool-badge is-no">В процессе</span>';
        }
        if (status === "processing" || status === "pending") {
            return '<span class="dashboard-bool-badge is-no">Обрабатывается</span>';
        }
        return null;
    }

    function renderIngredients(ingredients, row) {
        const statusMarkup = renderPostprocessStatus(row);
        if (statusMarkup) {
            return statusMarkup;
        }

        if (!ingredients.length) {
            return '<span class="text-muted">Нет компонентов</span>';
        }

        return `
            <div class="small">
                ${ingredients.map((ingredient, index) => {
                    const name = escapeHtml(ingredient?.name || "Без названия");
                    const ingredientTime = formatIngredientTime(ingredient?.time);
                    const plan = formatWeight(ingredient?.plan);
                    const fact = formatWeight(ingredient?.fact);
                    const metaParts = [];

                    if (ingredientTime) {
                        metaParts.push(`Время: ${escapeHtml(ingredientTime)}`);
                    }

                    if (plan) {
                        metaParts.push(`План: ${escapeHtml(plan)}`);
                    }

                    if (fact) {
                        metaParts.push(`Факт: ${escapeHtml(fact)}`);
                    }

                    return `
                        <div class="${index < ingredients.length - 1 ? "mb-2 pb-2 border-bottom" : ""}">
                            <div class="font-weight-bold text-gray-800">
                                ${name}
                                ${asBoolean(ingredient?.isViolation) ? '<span class="badge badge-danger ml-2">Отклонение</span>' : ""}
                            </div>
                            <div class="text-muted">${metaParts.length ? metaParts.join(" &middot; ") : "Без деталей по компоненту"}</div>
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

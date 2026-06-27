$(document).ready(function () {
    const rationsTableBody = document.getElementById("rationsTableBody");
    const rationsPanelMeta = document.getElementById("rationsPanelMeta");
    const reloadButton = document.getElementById("rationsReloadButton");

    const manualNewButton = document.getElementById("rationManualNewButton");
    const manualForm = document.getElementById("rationManualForm");
    const manualFormTitle = document.getElementById("rationManualFormTitle");
    const manualFormMeta = document.getElementById("rationManualFormMeta");
    const manualIdInput = document.getElementById("rationManualId");
    const manualNameInput = document.getElementById("rationManualName");
    const manualIsActiveInput = document.getElementById("rationManualIsActive");
    const manualFeedingsPerDayInput = document.getElementById("rationManualFeedingsPerDay");
    const manualGroupsSelect = document.getElementById("rationManualGroups");
    const manualIngredientsBody = document.getElementById("rationManualIngredientsBody");
    const manualAddIngredientButton = document.getElementById("rationManualAddIngredientButton");
    const manualAddCompoundIngredientButton = document.getElementById("rationManualAddCompoundIngredientButton");
    const manualGroupsPreview = document.getElementById("rationManualGroupsPreview");
    const manualSummary = document.getElementById("rationManualSummary");
    const manualCancelButton = document.getElementById("rationManualCancelButton");
    const manualSubmitButton = document.getElementById("rationManualSubmitButton");

    if (!rationsTableBody || !rationsPanelMeta) {
        return;
    }

    const RATIONS_API_URL = window.AppAuth?.getApiUrl?.("/api/rations") || "/api/rations";
    const GROUPS_API_URL = window.AppAuth?.getApiUrl?.("/api/groups") || "/api/groups";
    const canWrite = Boolean(window.AppAuth?.hasWriteAccess?.());

    const weightFormatter = new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });

    const state = {
        rations: [],
        groups: [],
        isLoading: false,
        isManualSaving: false,
        lastLoadError: "",
        activeLoadId: 0,
        manualSelectedGroupIds: [],
        manualIngredients: [],
        editingRationId: null,
        ingredientSeq: 0,
        highlightedIngredientId: null,
        toggleBusy: new Set(),
        deleteBusy: new Set(),
    };
    let ingredientHighlightTimer = null;

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function normalizeText(value) {
        return String(value || "").trim().replace(/\s+/g, " ");
    }

    function normalizeComparableName(value) {
        return normalizeText(value).toLowerCase();
    }

    function getHeaders(includeJson) {
        return window.AppAuth?.getAuthHeaders?.({ includeJson: Boolean(includeJson) }) || (
            includeJson ? { "Content-Type": "application/json" } : {}
        );
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

    function showAlert(message, type) {
        window.AppAuth?.showAlert?.(message, type);
    }

    function formatWeight(value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return '<span class="text-muted">-</span>';
        }

        return `${escapeHtml(weightFormatter.format(numericValue))} кг`;
    }

    function getWeightValue(value) {
        const numericValue = Number(value);
        return Number.isFinite(numericValue) ? numericValue : 0;
    }

    function parseFormNumber(value) {
        const normalized = String(value ?? "").trim().replace(",", ".");
        if (!normalized) {
            return null;
        }

        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function getManualFeedingsPerDay() {
        const parsed = parseInt(manualFeedingsPerDayInput?.value || "1", 10);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
    }

    function setPanelMeta(message) {
        if (rationsPanelMeta) {
            rationsPanelMeta.textContent = message;
        }
    }

    function makeIngredientRow(source) {
        const item = source || {};
        state.ingredientSeq += 1;

        return {
            localId: `ingredient-${state.ingredientSeq}`,
            name: item.name || "",
            sortOrder: item.sortOrder ?? "",
            plannedWeight: item.plannedWeight ?? "",
            isCompound: Boolean(item.isCompound),
            components: Array.isArray(item.components)
                ? item.components.map((component) => makeCompoundComponentRow(component))
                : [],
        };
    }

    function makeCompoundComponentRow(source) {
        const item = source || {};
        state.ingredientSeq += 1;

        return {
            localId: `component-${state.ingredientSeq}`,
            name: item.name || "",
            plannedWeight: item.plannedWeight ?? "",
        };
    }

    function getIngredientPlannedWeight(ingredient) {
        if (ingredient?.isCompound) {
            return (Array.isArray(ingredient.components) ? ingredient.components : [])
                .reduce((sum, component) => sum + (parseFormNumber(component.plannedWeight) || 0), 0);
        }

        return parseFormNumber(ingredient?.plannedWeight) || 0;
    }

    function normalizeManualIngredientOrder() {
        state.manualIngredients.forEach((ingredient, index) => {
            ingredient.sortOrder = index + 1;
        });
    }

    function moveManualIngredientToPosition(localId, targetPosition) {
        const currentIndex = state.manualIngredients.findIndex((ingredient) => ingredient.localId === localId);
        if (currentIndex < 0) {
            normalizeManualIngredientOrder();
            return;
        }

        const normalizedTargetIndex = Math.max(
            0,
            Math.min(
                state.manualIngredients.length - 1,
                Math.round(Number(targetPosition || 0)) - 1
            )
        );

        const [ingredient] = state.manualIngredients.splice(currentIndex, 1);
        state.manualIngredients.splice(normalizedTargetIndex, 0, ingredient);
        normalizeManualIngredientOrder();
    }

    function getGroupsByRationId() {
        return state.groups.reduce((acc, group) => {
            const rationId = Number(group?.rationId);
            if (!Number.isInteger(rationId) || rationId <= 0) {
                return acc;
            }

            if (!acc.has(rationId)) {
                acc.set(rationId, []);
            }

            acc.get(rationId).push(group);
            return acc;
        }, new Map());
    }

    function getRationGroups(ration, groupsByRationId) {
        const directGroups = Array.isArray(ration?.livestockGroups) ? ration.livestockGroups : [];
        if (directGroups.length) {
            return directGroups;
        }

        return groupsByRationId.get(Number(ration?.id)) || [];
    }

    function buildGroupOptions(selectedIds) {
        const normalizedSelectedIds = Array.isArray(selectedIds) ? selectedIds.map(Number) : [];

        if (!state.groups.length) {
            return '<option value="" disabled>Нет доступных групп</option>';
        }

        return state.groups.map((group) => {
            const groupId = Number(group?.id);
            const isSelected = normalizedSelectedIds.includes(groupId);
            const captionParts = [group?.name || `Группа #${groupId}`];

            if (Number.isFinite(Number(group?.headcount))) {
                captionParts.push(`${Number(group.headcount)} голов`);
            }

            if (group?.rationName) {
                captionParts.push(group.rationName);
            }

            return `<option value="${groupId}" ${isSelected ? "selected" : ""}>${escapeHtml(captionParts.join(" | "))}</option>`;
        }).join("");
    }

    function syncSelectedGroupIds(target) {
        const validGroupIds = new Set(state.groups.map((group) => Number(group?.id)).filter((id) => Number.isInteger(id) && id > 0));
        state[target] = state[target].filter((id) => validGroupIds.has(Number(id)));
    }

    function renderManualGroupsSelect() {
        if (!manualGroupsSelect) {
            return;
        }

        syncSelectedGroupIds("manualSelectedGroupIds");
        manualGroupsSelect.innerHTML = buildGroupOptions(state.manualSelectedGroupIds);
        manualGroupsSelect.disabled = !canWrite || state.isManualSaving || !state.groups.length;
    }

    function renderGroupsPreview(host, selectedIds) {
        if (!host) {
            return;
        }

        const selectedGroups = state.groups.filter((group) => selectedIds.includes(Number(group?.id)));
        if (!selectedGroups.length) {
            host.innerHTML = "";
            return;
        }

        host.innerHTML = selectedGroups.map((group) => (
            `<span class="ration-groups-preview__badge">${escapeHtml(group?.name || `Группа #${group?.id || "-"}`)}</span>`
        )).join("");
    }

    function renderCompoundComponentsEditor(ingredient) {
        if (!ingredient?.isCompound) {
            return "";
        }

        if (!Array.isArray(ingredient.components) || !ingredient.components.length) {
            ingredient.components = [makeCompoundComponentRow()];
        }

        const parentId = escapeHtml(ingredient.localId);
        const disabledAttr = state.isManualSaving ? "disabled" : "";

        return `
            <tr class="ration-manual-compound-row" data-compound-for="${parentId}">
                <td colspan="4">
                    <div class="ration-compound-editor">
                        <div class="ration-compound-editor__header">
                            <span>Состав</span>
                            <button
                                type="button"
                                class="btn btn-outline-primary btn-sm"
                                data-action="add-compound-component"
                                data-parent-id="${parentId}"
                                ${disabledAttr}
                            >
                                <i class="fas fa-plus mr-1" aria-hidden="true"></i>
                                Добавить компонент
                            </button>
                        </div>
                        <div class="ration-compound-editor__rows">
                            ${ingredient.components.map((component) => {
                                const componentId = escapeHtml(component.localId);
                                return `
                                    <div
                                        class="ration-compound-editor__row"
                                        data-compound-parent-id="${parentId}"
                                        data-component-id="${componentId}"
                                    >
                                        <input
                                            type="text"
                                            class="form-control form-control-sm"
                                            data-component-field="name"
                                            maxlength="120"
                                            value="${escapeHtml(component.name)}"
                                            placeholder="Сода пищевая"
                                            ${disabledAttr}
                                        >
                                        <input
                                            type="number"
                                            class="form-control form-control-sm ration-manual-number"
                                            data-component-field="plannedWeight"
                                            min="0.01"
                                            step="0.01"
                                            value="${escapeHtml(component.plannedWeight)}"
                                            placeholder="0.12"
                                            ${disabledAttr}
                                        >
                                        <button
                                            type="button"
                                            class="btn btn-outline-danger btn-sm ration-manual-remove"
                                            data-action="remove-compound-component"
                                            data-parent-id="${parentId}"
                                            data-component-id="${componentId}"
                                            ${ingredient.components.length <= 1 || state.isManualSaving ? "disabled" : ""}
                                            title="Удалить компонент"
                                            aria-label="Удалить компонент"
                                        >
                                            <i class="fas fa-trash-alt" aria-hidden="true"></i>
                                        </button>
                                    </div>
                                `;
                            }).join("")}
                        </div>
                    </div>
                </td>
            </tr>
        `;
    }

    function renderManualIngredientsEditor() {
        if (!manualIngredientsBody) {
            return;
        }

        if (!state.manualIngredients.length) {
            state.manualIngredients = [makeIngredientRow()];
        }
        normalizeManualIngredientOrder();

        manualIngredientsBody.innerHTML = state.manualIngredients.map((ingredient, index) => {
            const rowId = escapeHtml(ingredient.localId);
            const rowClass = ingredient.localId === state.highlightedIngredientId ? "ration-manual-row is-highlighted" : "ration-manual-row";
            const plannedWeightValue = ingredient.isCompound ? getIngredientPlannedWeight(ingredient) || "" : ingredient.plannedWeight;
            const compoundBadge = ingredient.isCompound ? '<span class="badge badge-secondary mb-2">Составной</span>' : "";
            const compoundAttributes = ingredient.isCompound ? 'readonly tabindex="-1"' : "";
            return `
                <tr class="${rowClass}" data-ingredient-id="${rowId}">
                    <td>
                        <div class="d-flex align-items-center">
                            <input
                                type="number"
                                class="form-control form-control-sm ration-manual-number mr-2"
                                data-ingredient-field="sortOrder"
                                min="1"
                                step="1"
                                value="${escapeHtml(ingredient.sortOrder || index + 1)}"
                                ${state.isManualSaving ? "disabled" : ""}
                            >
                            <div class="btn-group btn-group-sm" role="group">
                                <button
                                    type="button"
                                    class="btn btn-outline-secondary"
                                    data-action="move-ingredient-up"
                                    ${index <= 0 || state.isManualSaving ? "disabled" : ""}
                                    title="Выше"
                                    aria-label="Выше"
                                >
                                    <i class="fas fa-arrow-up" aria-hidden="true"></i>
                                </button>
                                <button
                                    type="button"
                                    class="btn btn-outline-secondary"
                                    data-action="move-ingredient-down"
                                    ${index >= state.manualIngredients.length - 1 || state.isManualSaving ? "disabled" : ""}
                                    title="Ниже"
                                    aria-label="Ниже"
                                >
                                    <i class="fas fa-arrow-down" aria-hidden="true"></i>
                                </button>
                            </div>
                        </div>
                    </td>
                    <td>
                        ${compoundBadge}
                        <input
                            type="text"
                            class="form-control form-control-sm"
                            data-ingredient-field="name"
                            maxlength="120"
                            value="${escapeHtml(ingredient.name)}"
                            placeholder="Силос"
                        >
                    </td>
                    <td>
                        <input
                            type="number"
                            class="form-control form-control-sm ration-manual-number"
                            data-ingredient-field="plannedWeight"
                            min="0.01"
                            step="0.01"
                            value="${escapeHtml(plannedWeightValue)}"
                            placeholder="1200"
                            ${compoundAttributes}
                        >
                    </td>
                    <td>
                        <button
                            type="button"
                            class="btn btn-outline-danger btn-sm ration-manual-remove"
                            data-action="remove-ingredient"
                            ${state.manualIngredients.length <= 1 || state.isManualSaving ? "disabled" : ""}
                            title="Удалить ингредиент"
                            aria-label="Удалить ингредиент"
                        >
                            <i class="fas fa-trash-alt" aria-hidden="true"></i>
                        </button>
                    </td>
                </tr>
                ${renderCompoundComponentsEditor(ingredient)}
            `;
        }).join("");
    }

    function updateManualSummary() {
        if (!manualSummary) {
            return;
        }

        const plannedTotal = state.manualIngredients.reduce((sum, ingredient) => sum + getIngredientPlannedWeight(ingredient), 0);
        const feedingsPerDay = getManualFeedingsPerDay();
        manualSummary.textContent = `Ингредиентов: ${state.manualIngredients.length} | День: ${weightFormatter.format(plannedTotal)} кг | 1 кормление: ${weightFormatter.format(plannedTotal / feedingsPerDay)} кг`;
    }

    function focusManualIngredientRow(localId) {
        window.requestAnimationFrame(() => {
            const row = Array.from(manualIngredientsBody?.querySelectorAll("tr[data-ingredient-id]") || [])
                .find((item) => item.getAttribute("data-ingredient-id") === localId);

            if (!row) {
                return;
            }

            row.scrollIntoView({ behavior: "smooth", block: "nearest" });
            row.querySelector("[data-ingredient-field='name']")?.focus?.();
        });
    }

    function clearIngredientHighlightLater(localId) {
        if (ingredientHighlightTimer) {
            window.clearTimeout(ingredientHighlightTimer);
        }

        ingredientHighlightTimer = window.setTimeout(() => {
            if (state.highlightedIngredientId === localId) {
                state.highlightedIngredientId = null;
                Array.from(manualIngredientsBody?.querySelectorAll("tr[data-ingredient-id]") || [])
                    .find((item) => item.getAttribute("data-ingredient-id") === localId)
                    ?.classList.remove("is-highlighted");
            }
        }, 1800);
    }

    function addManualIngredientRow() {
        syncManualRowsFromInputs();
        const ingredient = makeIngredientRow();
        state.manualIngredients.push(ingredient);
        state.highlightedIngredientId = ingredient.localId;
        updateManualState();
        focusManualIngredientRow(ingredient.localId);
        clearIngredientHighlightLater(ingredient.localId);
    }

    function addManualCompoundIngredientRow() {
        syncManualRowsFromInputs();
        const ingredient = makeIngredientRow({
            isCompound: true,
            components: [makeCompoundComponentRow()]
        });
        state.manualIngredients.push(ingredient);
        state.highlightedIngredientId = ingredient.localId;
        updateManualState();
        focusManualIngredientRow(ingredient.localId);
        clearIngredientHighlightLater(ingredient.localId);
    }

    function updateManualState() {
        const isEditing = Number.isInteger(state.editingRationId) && state.editingRationId > 0;
        const disabled = !canWrite || state.isManualSaving;

        if (manualFormTitle) {
            manualFormTitle.textContent = isEditing ? `Редактирование рациона #${state.editingRationId}` : "Ручное создание рациона";
        }

        if (manualFormMeta) {
            manualFormMeta.textContent = isEditing
                ? "Изменения состава и групп сохраняются полной заменой"
                : "Заполните состав рациона вручную";
        }

        if (manualIdInput) {
            manualIdInput.value = isEditing ? String(state.editingRationId) : "";
        }

        [manualNameInput, manualIsActiveInput, manualFeedingsPerDayInput, manualAddIngredientButton, manualAddCompoundIngredientButton].forEach((element) => {
            if (element) {
                element.disabled = disabled;
            }
        });

        renderManualGroupsSelect();
        renderManualIngredientsEditor();
        updateManualSummary();
        renderGroupsPreview(manualGroupsPreview, state.manualSelectedGroupIds);

        if (manualCancelButton) {
            manualCancelButton.classList.toggle("d-none", !isEditing);
            manualCancelButton.disabled = disabled;
        }

        if (manualSubmitButton) {
            manualSubmitButton.disabled = disabled;
            manualSubmitButton.innerHTML = state.isManualSaving
                ? '<span class="spinner-border spinner-border-sm mr-2" role="status" aria-hidden="true"></span>Сохранение...'
                : `<i class="fas fa-save mr-1"></i>${isEditing ? "Сохранить изменения" : "Сохранить рацион"}`;
        }

        if (manualNewButton) {
            manualNewButton.disabled = disabled;
        }

        if (reloadButton) {
            reloadButton.disabled = state.isLoading || state.isManualSaving;
        }
    }

    function renderStatusBadge(isActive) {
        const active = Boolean(isActive);
        const badgeClass = active ? "ration-status-badge is-active" : "ration-status-badge is-inactive";
        const label = active ? "Активен" : "Неактивен";
        return `<span class="${badgeClass}">${label}</span>`;
    }

    function renderListCell(values, formatter) {
        const items = Array.isArray(values) ? values : [];
        if (!items.length) {
            return '<span class="text-muted">-</span>';
        }

        return `
            <div class="ration-table-list">
                ${items.map((item) => `<div class="ration-table-list__item">${formatter(item)}</div>`).join("")}
            </div>
        `;
    }

    function renderIngredientNameWithComponents(ingredient) {
        const name = escapeHtml(ingredient?.name || "Без названия");
        const components = Array.isArray(ingredient?.components) ? ingredient.components : [];
        if (!ingredient?.isCompound || !components.length) {
            return name;
        }

        return `
            <div class="ration-ingredient-compound-name">
                <div>${name} <span class="badge badge-secondary">Составной</span></div>
                <div class="ration-ingredient-components-list">
                    ${components.map((component) => `
                        <div>${escapeHtml(component?.name || "Без названия")} - ${formatWeight(component?.plannedWeight)}</div>
                    `).join("")}
                </div>
            </div>
        `;
    }

    function renderIngredientsTable(ingredients, ration) {
        const items = Array.isArray(ingredients) ? ingredients : [];
        if (!items.length) {
            return '<span class="text-muted">-</span>';
        }

        const plannedTotal = items.reduce((sum, ingredient) => sum + getWeightValue(ingredient?.plannedWeight), 0);
        const feedingsPerDay = Math.max(1, parseInt(ration?.feedingsPerDay || 1, 10) || 1);

        return `
            <div class="ration-ingredients-table-wrap">
                <table class="ration-ingredients-table">
                    <thead>
                        <tr>
                            <th class="ration-ingredients-table__index">№</th>
                            <th>Ингредиент</th>
                            <th class="ration-ingredients-table__weight">Вес/голову/день</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.map((ingredient, index) => `
                            <tr>
                                <td class="ration-ingredients-table__index">${index + 1}</td>
                                <td class="ration-ingredients-table__name">${renderIngredientNameWithComponents(ingredient)}</td>
                                <td class="ration-ingredients-table__weight">${formatWeight(ingredient?.plannedWeight)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td colspan="2">Итого за день</td>
                            <td class="ration-ingredients-table__weight">${formatWeight(plannedTotal)}</td>
                        </tr>
                        <tr>
                            <td colspan="2">На 1 кормление</td>
                            <td class="ration-ingredients-table__weight">${formatWeight(plannedTotal / feedingsPerDay)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        `;
    }

    function getEditButtonMarkup(ration) {
        const rationId = Number(ration?.id);
        const isBusy = state.isLoading || state.isManualSaving || state.toggleBusy.has(rationId) || state.deleteBusy.has(rationId);

        return `
            <button
                type="button"
                class="btn btn-sm btn-outline-primary ration-action-button"
                data-action="edit"
                data-ration-id="${rationId}"
                ${isBusy ? "disabled" : ""}
            >
                <i class="fas fa-pen" aria-hidden="true"></i>
                <span>Изменить</span>
            </button>
        `;
    }

    function getToggleButtonMarkup(ration) {
        const rationId = Number(ration?.id);
        const isBusy = state.isLoading || state.isManualSaving || state.toggleBusy.has(rationId) || state.deleteBusy.has(rationId);
        const isActive = Boolean(ration?.isActive);
        const buttonClass = isActive ? "btn-outline-secondary" : "btn-outline-success";
        const label = isActive ? "Деактивировать" : "Активировать";
        const icon = isActive ? "fa-toggle-off" : "fa-toggle-on";

        return `
            <button
                type="button"
                class="btn btn-sm ${buttonClass} ration-action-button"
                data-action="toggle"
                data-ration-id="${rationId}"
                ${isBusy ? "disabled" : ""}
            >
                ${state.toggleBusy.has(rationId)
                    ? '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>'
                    : `<i class="fas ${icon}" aria-hidden="true"></i>`}
                <span>${label}</span>
            </button>
        `;
    }

    function getDeleteButtonMarkup(ration) {
        const rationId = Number(ration?.id);
        const isBusy = state.isLoading || state.isManualSaving || state.deleteBusy.has(rationId) || state.toggleBusy.has(rationId);

        return `
            <button
                type="button"
                class="btn btn-sm btn-outline-danger ration-action-button"
                data-action="delete"
                data-ration-id="${rationId}"
                ${isBusy ? "disabled" : ""}
            >
                ${state.deleteBusy.has(rationId)
                    ? '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>'
                    : '<i class="fas fa-trash-alt" aria-hidden="true"></i>'}
                <span>Удалить</span>
            </button>
        `;
    }

    function renderActionsCell(ration) {
        if (!canWrite) {
            return '<span class="text-muted small">Только просмотр</span>';
        }

        return `
            <div class="ration-actions">
                ${getEditButtonMarkup(ration)}
                ${getToggleButtonMarkup(ration)}
                ${getDeleteButtonMarkup(ration)}
            </div>
        `;
    }

    function renderTable() {
        const groupsByRationId = getGroupsByRationId();

        if (state.isLoading && !state.rations.length) {
            rationsTableBody.innerHTML = '<tr><td colspan="5" class="telemetry-empty-state">Загрузка рационов...</td></tr>';
            return;
        }

        if (state.lastLoadError && !state.rations.length) {
            rationsTableBody.innerHTML = `<tr><td colspan="5" class="telemetry-empty-state">${escapeHtml(state.lastLoadError)}</td></tr>`;
            return;
        }

        if (!state.rations.length) {
            rationsTableBody.innerHTML = '<tr><td colspan="5" class="telemetry-empty-state">Рационы пока не загружены.</td></tr>';
            return;
        }

        rationsTableBody.innerHTML = state.rations.map((ration) => {
            const ingredients = Array.isArray(ration?.ingredients) ? ration.ingredients : [];
            const linkedGroups = getRationGroups(ration, groupsByRationId);

            return `
                <tr>
                    <td class="align-middle">
                        <div class="font-weight-bold text-gray-800">#${escapeHtml(ration?.id ?? "-")} ${escapeHtml(ration?.name || "Без названия")}</div>
                        <div class="small text-muted">${ingredients.length ? `Ингредиентов: ${ingredients.length} | Кормлений/день: ${escapeHtml(ration?.feedingsPerDay || 1)}` : "Без ингредиентов"}</div>
                    </td>
                    <td class="align-middle">${renderStatusBadge(ration?.isActive)}</td>
                    <td class="align-middle ration-ingredients-cell">
                        ${renderIngredientsTable(ingredients, ration)}
                    </td>
                    <td class="align-middle">
                        ${renderListCell(linkedGroups, (group) => escapeHtml(group?.name || `Группа #${group?.id || "-"}`))}
                    </td>
                    <td class="align-middle">${renderActionsCell(ration)}</td>
                </tr>
            `;
        }).join("");
    }

    function syncUiState() {
        renderTable();
        updateManualState();
    }

    async function fetchJson(url) {
        const response = await fetch(url, {
            method: "GET",
            headers: getHeaders(false),
        });

        if (!response.ok) {
            const message = await readErrorMessage(response);
            throw new Error(message || "Не удалось загрузить данные");
        }

        return response.json();
    }

    async function loadPageData(options) {
        const settings = options || {};
        const requestId = ++state.activeLoadId;

        state.isLoading = true;
        state.lastLoadError = "";
        setPanelMeta(state.rations.length ? "Обновление списка рационов..." : "Загрузка рационов...");
        syncUiState();

        try {
            const [rationsPayload, groupsPayload] = await Promise.all([
                fetchJson(RATIONS_API_URL),
                fetchJson(GROUPS_API_URL),
            ]);

            if (requestId !== state.activeLoadId) {
                return;
            }

            state.rations = Array.isArray(rationsPayload) ? rationsPayload : [];
            state.groups = Array.isArray(groupsPayload) ? groupsPayload : [];
            state.lastLoadError = "";
            setPanelMeta(`Рационов: ${state.rations.length} | Групп: ${state.groups.length}`);
        } catch (error) {
            if (requestId !== state.activeLoadId) {
                return;
            }

            state.lastLoadError = error.message || "Не удалось загрузить список рационов";
            setPanelMeta("Не удалось загрузить данные");

            if (!settings.silentError) {
                showAlert(state.lastLoadError, "danger");
            }
        } finally {
            if (requestId === state.activeLoadId) {
                state.isLoading = false;
                syncUiState();
            }
        }
    }

    function validateManualPayload() {
        const rationName = normalizeText(manualNameInput?.value || "");
        if (!rationName) {
            return { ok: false, message: "Укажите название рациона", focus: manualNameInput };
        }

        const feedingsPerDay = parseInt(manualFeedingsPerDayInput?.value || "1", 10);
        if (!Number.isInteger(feedingsPerDay) || feedingsPerDay <= 0) {
            return { ok: false, message: "Укажите количество кормлений в день", focus: manualFeedingsPerDayInput };
        }

        const normalizedName = normalizeComparableName(rationName);
        const duplicate = state.rations.find((ration) => (
            normalizeComparableName(ration?.name) === normalizedName
            && Number(ration?.id) !== Number(state.editingRationId || 0)
        ));

        if (duplicate) {
            return { ok: false, message: `Рацион с названием "${rationName}" уже существует`, focus: manualNameInput };
        }

        normalizeManualIngredientOrder();

        const ingredients = [];
        const seenIngredients = new Set();

        for (let index = 0; index < state.manualIngredients.length; index += 1) {
            const row = state.manualIngredients[index];
            const name = normalizeText(row.name);

            if (!name) {
                return { ok: false, message: `Ингредиент #${index + 1}: укажите название` };
            }

            const normalizedIngredientName = normalizeComparableName(name);
            if (seenIngredients.has(normalizedIngredientName)) {
                return { ok: false, message: `Ингредиент "${name}" дублируется в рационе` };
            }
            seenIngredients.add(normalizedIngredientName);

            let plannedWeight = parseFormNumber(row.plannedWeight);
            let components = [];

            if (row.isCompound) {
                const seenComponents = new Set();
                components = Array.isArray(row.components) ? row.components : [];

                if (!components.length) {
                    return { ok: false, message: `Составной ингредиент "${name}": добавьте состав` };
                }

                for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
                    const component = components[componentIndex];
                    const componentName = normalizeText(component?.name);

                    if (!componentName) {
                        return { ok: false, message: `Составной ингредиент "${name}", строка #${componentIndex + 1}: укажите название` };
                    }

                    const normalizedComponentName = normalizeComparableName(componentName);
                    if (seenComponents.has(normalizedComponentName)) {
                        return { ok: false, message: `Составной ингредиент "${name}": компонент "${componentName}" дублируется` };
                    }
                    seenComponents.add(normalizedComponentName);

                    const componentWeight = parseFormNumber(component?.plannedWeight);
                    if (componentWeight === null || componentWeight <= 0) {
                        return { ok: false, message: `Составной ингредиент "${name}", "${componentName}": вес должен быть больше 0` };
                    }

                    components[componentIndex] = {
                        ...component,
                        name: componentName,
                        plannedWeight: componentWeight,
                    };
                }

                plannedWeight = components.reduce((sum, component) => sum + (parseFormNumber(component.plannedWeight) || 0), 0);
            }
            if (plannedWeight === null || plannedWeight <= 0) {
                return { ok: false, message: `Ингредиент "${name}": вес должен быть больше 0` };
            }

            ingredients.push({
                name,
                sortOrder: index + 1,
                plannedWeight,
                isCompound: Boolean(row.isCompound),
                components: row.isCompound ? components.map((component) => ({
                    name: component.name,
                    plannedWeight: parseFormNumber(component.plannedWeight) || 0,
                })) : [],
            });
        }

        if (!ingredients.length) {
            return { ok: false, message: "Добавьте хотя бы один ингредиент" };
        }

        return {
            ok: true,
            payload: {
                name: rationName,
                feedingsPerDay,
                isActive: Boolean(manualIsActiveInput?.checked),
                groups: state.manualSelectedGroupIds,
                ingredients,
            },
        };
    }

    function syncManualRowsFromInputs() {
        if (!manualIngredientsBody) {
            return;
        }

        manualIngredientsBody.querySelectorAll("tr[data-ingredient-id]").forEach((row) => {
            const localId = row.getAttribute("data-ingredient-id");
            const item = state.manualIngredients.find((ingredient) => ingredient.localId === localId);
            if (!item) {
                return;
            }

            row.querySelectorAll("[data-ingredient-field]").forEach((input) => {
                const field = input.getAttribute("data-ingredient-field");
                item[field] = input.value;
            });
        });

        manualIngredientsBody.querySelectorAll("[data-compound-parent-id][data-component-id]").forEach((row) => {
            const parentId = row.getAttribute("data-compound-parent-id");
            const componentId = row.getAttribute("data-component-id");
            const parent = state.manualIngredients.find((ingredient) => ingredient.localId === parentId);
            const component = parent?.components?.find((item) => item.localId === componentId);
            if (!component) {
                return;
            }

            row.querySelectorAll("[data-component-field]").forEach((input) => {
                const field = input.getAttribute("data-component-field");
                component[field] = input.value;
            });
        });

        updateManualSummary();
    }

    function resetManualForm() {
        state.editingRationId = null;
        state.manualSelectedGroupIds = [];
        state.manualIngredients = [makeIngredientRow()];
        state.highlightedIngredientId = null;

        if (manualForm) {
            manualForm.reset();
        }

        if (manualNameInput) {
            manualNameInput.value = "";
        }

        if (manualIsActiveInput) {
            manualIsActiveInput.checked = false;
        }

        if (manualFeedingsPerDayInput) {
            manualFeedingsPerDayInput.value = "1";
        }

        updateManualState();
    }

    async function saveManualRation() {
        if (!canWrite) {
            return;
        }

        syncManualRowsFromInputs();
        const validation = validateManualPayload();
        if (!validation.ok) {
            showAlert(validation.message, "danger");
            validation.focus?.focus?.();
            return;
        }

        const isEditing = Number.isInteger(state.editingRationId) && state.editingRationId > 0;
        const url = isEditing ? `${RATIONS_API_URL}/${state.editingRationId}` : RATIONS_API_URL;

        state.isManualSaving = true;
        syncUiState();

        try {
            const response = await fetch(url, {
                method: isEditing ? "PATCH" : "POST",
                headers: getHeaders(true),
                body: JSON.stringify(validation.payload),
            });

            if (!response.ok) {
                const message = await readErrorMessage(response);
                throw new Error(message || "Не удалось сохранить рацион");
            }

            showAlert(isEditing ? "Рацион обновлен" : "Рацион создан", "success");
            resetManualForm();
            await loadPageData({ silentError: false });
        } catch (error) {
            showAlert(error.message || "Не удалось сохранить рацион", "danger");
        } finally {
            state.isManualSaving = false;
            syncUiState();
        }
    }

    function startEditRation(rationId) {
        const ration = state.rations.find((item) => Number(item?.id) === Number(rationId));
        if (!ration || !canWrite) {
            return;
        }

        const groupsByRationId = getGroupsByRationId();
        const linkedGroups = getRationGroups(ration, groupsByRationId);

        state.editingRationId = Number(rationId);
        state.manualSelectedGroupIds = linkedGroups
            .map((group) => Number(group?.id))
            .filter((id) => Number.isInteger(id) && id > 0);
        state.manualIngredients = (Array.isArray(ration?.ingredients) ? ration.ingredients : [])
            .map((ingredient) => makeIngredientRow({
                name: ingredient?.name || "",
                sortOrder: ingredient?.sortOrder ?? "",
                plannedWeight: ingredient?.plannedWeight ?? "",
                isCompound: Boolean(ingredient?.isCompound),
                components: Array.isArray(ingredient?.components) ? ingredient.components : [],
            }));

        if (!state.manualIngredients.length) {
            state.manualIngredients = [makeIngredientRow()];
        }
        state.highlightedIngredientId = null;

        if (manualNameInput) {
            manualNameInput.value = ration?.name || "";
        }

        if (manualIsActiveInput) {
            manualIsActiveInput.checked = Boolean(ration?.isActive);
        }

        if (manualFeedingsPerDayInput) {
            manualFeedingsPerDayInput.value = String(ration?.feedingsPerDay || 1);
        }

        updateManualState();
        manualForm?.closest(".card")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        manualNameInput?.focus?.();
    }

    async function toggleRation(rationId) {
        const ration = state.rations.find((item) => Number(item?.id) === Number(rationId));
        if (!ration || !canWrite) {
            return;
        }

        state.toggleBusy.add(Number(rationId));
        syncUiState();

        try {
            const response = await fetch(`${RATIONS_API_URL}/${rationId}/toggle`, {
                method: "PATCH",
                headers: getHeaders(true),
                body: JSON.stringify({ isActive: !Boolean(ration?.isActive) }),
            });

            if (!response.ok) {
                const message = await readErrorMessage(response);
                throw new Error(message || "Не удалось изменить статус рациона");
            }

            showAlert(Boolean(ration?.isActive) ? "Рацион деактивирован" : "Рацион активирован", "success");
            await loadPageData({ silentError: false });
        } catch (error) {
            showAlert(error.message || "Не удалось изменить статус рациона", "danger");
        } finally {
            state.toggleBusy.delete(Number(rationId));
            syncUiState();
        }
    }

    async function deleteRation(rationId) {
        const ration = state.rations.find((item) => Number(item?.id) === Number(rationId));
        if (!ration || !canWrite) {
            return;
        }

        if (!window.confirm(`Удалить рацион "${ration.name || `#${rationId}`}"?`)) {
            return;
        }

        state.deleteBusy.add(Number(rationId));
        syncUiState();

        try {
            const response = await fetch(`${RATIONS_API_URL}/${rationId}`, {
                method: "DELETE",
                headers: getHeaders(false),
            });

            if (!response.ok) {
                const message = await readErrorMessage(response);
                throw new Error(message || "Не удалось удалить рацион");
            }

            showAlert("Рацион удален", "success");
            if (Number(state.editingRationId) === Number(rationId)) {
                resetManualForm();
            }
            await loadPageData({ silentError: false });
        } catch (error) {
            showAlert(error.message || "Не удалось удалить рацион", "danger");
        } finally {
            state.deleteBusy.delete(Number(rationId));
            syncUiState();
        }
    }

    manualForm?.addEventListener("submit", function (event) {
        event.preventDefault();
        saveManualRation();
    });

    manualNewButton?.addEventListener("click", function () {
        resetManualForm();
        manualNameInput?.focus?.();
    });

    manualCancelButton?.addEventListener("click", function () {
        resetManualForm();
    });

    manualAddIngredientButton?.addEventListener("click", function () {
        addManualIngredientRow();
    });

    manualAddCompoundIngredientButton?.addEventListener("click", function () {
        addManualCompoundIngredientRow();
    });

    manualGroupsSelect?.addEventListener("change", function () {
        state.manualSelectedGroupIds = Array.from(manualGroupsSelect.selectedOptions)
            .map((option) => Number(option.value))
            .filter((value) => Number.isInteger(value) && value > 0);
        renderGroupsPreview(manualGroupsPreview, state.manualSelectedGroupIds);
    });

    manualFeedingsPerDayInput?.addEventListener("input", function () {
        updateManualSummary();
    });

    manualIngredientsBody?.addEventListener("input", function (event) {
        const componentInput = event.target.closest("[data-component-field]");
        if (componentInput) {
            const row = componentInput.closest("[data-compound-parent-id][data-component-id]");
            const parentId = row?.getAttribute("data-compound-parent-id");
            const componentId = row?.getAttribute("data-component-id");
            const parent = state.manualIngredients.find((ingredient) => ingredient.localId === parentId);
            const component = parent?.components?.find((item) => item.localId === componentId);
            if (!component) {
                return;
            }

            component[componentInput.getAttribute("data-component-field")] = componentInput.value;
            const parentRow = Array.from(manualIngredientsBody.querySelectorAll("tr[data-ingredient-id]"))
                .find((item) => item.getAttribute("data-ingredient-id") === parentId);
            const parentWeightInput = parentRow?.querySelector("[data-ingredient-field='plannedWeight']");
            if (parentWeightInput) {
                parentWeightInput.value = getIngredientPlannedWeight(parent) || "";
            }
            updateManualSummary();
            return;
        }

        const input = event.target.closest("[data-ingredient-field]");
        if (!input) {
            return;
        }

        const row = input.closest("[data-ingredient-id]");
        const localId = row?.getAttribute("data-ingredient-id");
        const item = state.manualIngredients.find((ingredient) => ingredient.localId === localId);
        if (!item) {
            return;
        }

        item[input.getAttribute("data-ingredient-field")] = input.value;
        updateManualSummary();
    });

    manualIngredientsBody?.addEventListener("change", function (event) {
        const input = event.target.closest("[data-ingredient-field='sortOrder']");
        if (!input || state.isManualSaving) {
            return;
        }

        syncManualRowsFromInputs();
        const row = input.closest("[data-ingredient-id]");
        const localId = row?.getAttribute("data-ingredient-id");
        const targetPosition = parseFormNumber(input.value) || 1;
        moveManualIngredientToPosition(localId, targetPosition);
        updateManualState();
    });

    manualIngredientsBody?.addEventListener("click", function (event) {
        const addComponentButton = event.target.closest("[data-action='add-compound-component']");
        if (addComponentButton && !state.isManualSaving) {
            syncManualRowsFromInputs();
            const parentId = addComponentButton.getAttribute("data-parent-id");
            const parent = state.manualIngredients.find((ingredient) => ingredient.localId === parentId);
            if (parent?.isCompound) {
                parent.components = Array.isArray(parent.components) ? parent.components : [];
                parent.components.push(makeCompoundComponentRow());
                updateManualState();
            }
            return;
        }

        const removeComponentButton = event.target.closest("[data-action='remove-compound-component']");
        if (removeComponentButton && !state.isManualSaving) {
            syncManualRowsFromInputs();
            const parentId = removeComponentButton.getAttribute("data-parent-id");
            const componentId = removeComponentButton.getAttribute("data-component-id");
            const parent = state.manualIngredients.find((ingredient) => ingredient.localId === parentId);
            if (parent?.isCompound && Array.isArray(parent.components) && parent.components.length > 1) {
                parent.components = parent.components.filter((component) => component.localId !== componentId);
                updateManualState();
            }
            return;
        }

        const moveUpButton = event.target.closest("[data-action='move-ingredient-up']");
        const moveDownButton = event.target.closest("[data-action='move-ingredient-down']");
        if ((moveUpButton || moveDownButton) && !state.isManualSaving) {
            syncManualRowsFromInputs();
            const row = (moveUpButton || moveDownButton).closest("[data-ingredient-id]");
            const localId = row?.getAttribute("data-ingredient-id");
            const currentIndex = state.manualIngredients.findIndex((ingredient) => ingredient.localId === localId);
            const nextIndex = moveUpButton ? currentIndex - 1 : currentIndex + 1;

            if (currentIndex >= 0 && nextIndex >= 0 && nextIndex < state.manualIngredients.length) {
                const [ingredient] = state.manualIngredients.splice(currentIndex, 1);
                state.manualIngredients.splice(nextIndex, 0, ingredient);
                normalizeManualIngredientOrder();
                updateManualState();
            }
            return;
        }

        const actionButton = event.target.closest("[data-action='remove-ingredient']");
        if (!actionButton || state.manualIngredients.length <= 1 || state.isManualSaving) {
            return;
        }

        const row = actionButton.closest("[data-ingredient-id]");
        const localId = row?.getAttribute("data-ingredient-id");
        state.manualIngredients = state.manualIngredients.filter((ingredient) => ingredient.localId !== localId);
        if (state.highlightedIngredientId === localId) {
            state.highlightedIngredientId = null;
        }
        updateManualState();
    });

    reloadButton?.addEventListener("click", function () {
        loadPageData({ silentError: false });
    });

    rationsTableBody.addEventListener("click", function (event) {
        const actionButton = event.target.closest("[data-action][data-ration-id]");
        if (!actionButton) {
            return;
        }

        const rationId = Number(actionButton.getAttribute("data-ration-id"));
        if (!Number.isInteger(rationId) || rationId <= 0) {
            return;
        }

        const action = actionButton.getAttribute("data-action");
        if (action === "edit") {
            startEditRation(rationId);
            return;
        }

        if (action === "toggle") {
            toggleRation(rationId);
            return;
        }

        if (action === "delete") {
            deleteRation(rationId);
        }
    });

    resetManualForm();
    loadPageData({ silentError: true });
});

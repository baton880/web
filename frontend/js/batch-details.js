$(document).ready(function () {
    const query = new URLSearchParams(window.location.search);
    const batchId = parsePositiveInteger(query.get("id"));
    const returnDate = normalizeDateValue(query.get("date"));
    const canWrite = Boolean(window.AppAuth?.hasWriteAccess?.());
    const canAdmin = Boolean(window.AppAuth?.isAdmin?.());

    const detailsTitle = document.getElementById("batchDetailsTitle");
    const detailsPageTitle = document.getElementById("batchDetailsPageTitle");
    const rationName = document.getElementById("batchDetailsRationName");
    const startTime = document.getElementById("batchDetailsStartTime");
    const endTime = document.getElementById("batchDetailsEndTime");
    const barnName = document.getElementById("batchDetailsBarnName");
    const remainingWeight = document.getElementById("batchDetailsRemainingWeight");
    const unloadProgressMeta = document.getElementById("batchUnloadProgressMeta");
    const unloadProgressBar = document.getElementById("batchUnloadProgressBar");
    const backLink = document.getElementById("batchDetailsBackLink");
    const ingredientListBody = document.getElementById("batchIngredientsTableBody");
    const planFactBody = document.getElementById("batchPlanFactTableBody");
    const planTotal = document.getElementById("batchPlanTotal");
    const factTotal = document.getElementById("batchFactTotal");
    const deviationTotal = document.getElementById("batchDeviationTotal");
    const telemetryEmpty = document.getElementById("batchTelemetryEmpty");
    const telemetryCanvas = document.getElementById("batchTelemetryChart");
    const trackMapElement = document.getElementById("batchTrackMap");
    const trackEmpty = document.getElementById("batchTrackEmpty");
    const trackMeta = document.getElementById("batchTrackMeta");
    const editCard = document.getElementById("batchEditCard");
    const editMeta = document.getElementById("batchEditMeta");
    const editState = document.getElementById("batchEditState");
    const editRationSelect = document.getElementById("batchEditRationSelect");
    const editRationHint = document.getElementById("batchEditRationHint");
    const editGroupSelect = document.getElementById("batchEditGroupSelect");
    const editGroupHint = document.getElementById("batchEditGroupHint");
    const editSubmitButton = document.getElementById("batchEditSubmitButton");
    const stopButton = document.getElementById("batchStopButton");
    const deleteButton = document.getElementById("batchDeleteButton");

    const batchUrl = window.AppAuth?.getApiUrl?.(`/api/batches/${batchId}`) || `/api/batches/${batchId}`;
    const telemetryUrl = window.AppAuth?.getApiUrl?.(`/api/batches/${batchId}/telemetry?includeRtk=true&loaderLookbackSeconds=60`) || `/api/batches/${batchId}/telemetry?includeRtk=true&loaderLookbackSeconds=60`;
    const batchDeleteUrl = window.AppAuth?.getApiUrl?.(`/api/batches/${batchId}`) || `/api/batches/${batchId}`;
    const stopBatchUrl = window.AppAuth?.getApiUrl?.("/api/telemetry/host/manual-stop") || "/api/telemetry/host/manual-stop";
    const rationsUrl = window.AppAuth?.getApiUrl?.("/api/rations") || "/api/rations";
    const groupsUrl = window.AppAuth?.getApiUrl?.("/api/groups") || "/api/groups";
    const zonesUrl = window.AppAuth?.getApiUrl?.("/api/telemetry/zones") || "/api/telemetry/zones";

    const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const weightFormatter = new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
    });

    const state = {
        batch: null,
        isBatchLoading: false,
        isSaving: false,
        ingredientUpdateId: null,
        ingredientDeleteId: null,
        stopBatchInFlight: false,
        deleteBatchInFlight: false,
        batchError: "",
        editorMessage: null,
        rations: [],
        groups: [],
        storageZones: [],
        lookupStatus: {
            rations: {
                loading: false,
                loaded: false,
                error: "",
            },
            groups: {
                loading: false,
                loaded: false,
                error: "",
            },
        },
        loadRequestId: 0,
        lookupRequestId: 0,
    };

    let telemetryChart = null;
    let batchTrackMap = null;
    let ymapsReadyPromise = null;
    let batchTrackZoneObjects = [];
    const DEFAULT_ZONE_RADIUS = 20;
    const DEFAULT_SQUARE_SIDE = 40;
    const ZONE_TYPE_BARN = "BARN";
    const TRACK_MAX_GAP_MS = 45000;
    const TRACK_MAX_SPEED_MPS = 12;
    const TRACK_MIN_JUMP_DISTANCE_M = 30;
    const HOST_TRACK_COLOR = "#3F6FAE";
    const RTK_GPS_FIX_COLOR = "#B65F55";
    const RTK_FIX_COLOR = "#5F8A6B";

    function parsePositiveInteger(value) {
        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    function normalizeDateValue(value) {
        return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : "";
    }

    function normalizeNullableId(value) {
        if (value === null || value === undefined || value === "") {
            return null;
        }

        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    function buildBackLink() {
        const url = new URL("tables.html", window.location.href);

        if (returnDate) {
            url.searchParams.set("date", returnDate);
        }

        return url.toString();
    }

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

    function toNumber(value) {
        const numericValue = Number(value);
        return Number.isFinite(numericValue) ? numericValue : 0;
    }

    function formatDateTime(value) {
        if (!value) {
            return "--";
        }

        const parsedDate = new Date(value);
        if (Number.isNaN(parsedDate.getTime())) {
            return "--";
        }

        return dateTimeFormatter.format(parsedDate);
    }

    function formatTime(value) {
        if (!value) {
            return "--";
        }

        const parsedDate = new Date(value);
        if (Number.isNaN(parsedDate.getTime())) {
            return "--";
        }

        return timeFormatter.format(parsedDate);
    }

    function formatWeight(value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return "--";
        }

        return `${weightFormatter.format(numericValue)} кг`;
    }

    function hasValidCoordinates(lat, lon) {
        const numericLat = Number(lat);
        const numericLon = Number(lon);

        return Number.isFinite(numericLat)
            && Number.isFinite(numericLon)
            && Math.abs(numericLat) <= 90
            && Math.abs(numericLon) <= 180
            && !(numericLat === 0 && numericLon === 0);
    }

    function parseTimestampMs(value) {
        const timestamp = new Date(value).getTime();
        return Number.isFinite(timestamp) ? timestamp : null;
    }

    function normalizeShapeType(value) {
        return String(value || "CIRCLE").trim().toUpperCase() === "SQUARE" ? "SQUARE" : "CIRCLE";
    }

    function normalizeZoneType(value) {
        return String(value || "").trim().toUpperCase() === ZONE_TYPE_BARN ? "BARN" : "STORAGE";
    }

    function getZoneTypeLabel(zone) {
        return normalizeZoneType(zone?.zoneType) === "BARN" ? "Коровник" : "Зона хранения";
    }

    function getZoneTypeColors(zone) {
        return normalizeZoneType(zone?.zoneType) === "BARN"
            ? { fillColor: "#36b9cc44", strokeColor: "#138496" }
            : { fillColor: "#00c85355", strokeColor: "#1e88e5" };
    }

    function parseZoneNumber(value) {
        if (value === "" || value === null || value === undefined) {
            return null;
        }

        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function metersPerLonDegree(lat) {
        return Math.max(Math.cos(lat * Math.PI / 180) * 111320, 1);
    }

    function buildSquarePolygonFromBounds(minLat, minLon, maxLat, maxLon) {
        const normalizedMinLat = Math.min(minLat, maxLat);
        const normalizedMaxLat = Math.max(minLat, maxLat);
        const normalizedMinLon = Math.min(minLon, maxLon);
        const normalizedMaxLon = Math.max(minLon, maxLon);

        return [
            [normalizedMaxLat, normalizedMinLon],
            [normalizedMaxLat, normalizedMaxLon],
            [normalizedMinLat, normalizedMaxLon],
            [normalizedMinLat, normalizedMinLon],
        ];
    }

    function buildSquarePolygonFromCenter(lat, lon, sideMeters) {
        const halfSideMeters = sideMeters / 2;
        const latDelta = halfSideMeters / 111320;
        const lonDelta = halfSideMeters / metersPerLonDegree(lat);

        return buildSquarePolygonFromBounds(
            lat - latDelta,
            lon - lonDelta,
            lat + latDelta,
            lon + lonDelta
        );
    }

    function getZoneLabel(zone) {
        const ingredient = String(zone?.ingredient || "").trim();
        const name = String(zone?.name || "").trim();
        return ingredient || name || "Без названия";
    }

    function normalizeZone(zone) {
        let polygonCoords = null;

        if (zone?.polygonCoords) {
            try {
                const parsed = typeof zone.polygonCoords === "string"
                    ? JSON.parse(zone.polygonCoords)
                    : zone.polygonCoords;
                if (Array.isArray(parsed) && parsed.length >= 4) {
                    polygonCoords = parsed
                        .map((point) => [Number(point[0]), Number(point[1])])
                        .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
                }
            } catch {
                polygonCoords = null;
            }
        }

        const normalized = {
            ...zone,
            active: Boolean(zone?.active),
            zoneType: normalizeZoneType(zone?.zoneType),
            shapeType: normalizeShapeType(zone?.shapeType),
            lat: Number(zone?.lat),
            lon: Number(zone?.lon),
            radius: Number(zone?.radius ?? DEFAULT_ZONE_RADIUS),
            sideMeters: parseZoneNumber(zone?.sideMeters),
            squareMinLat: parseZoneNumber(zone?.squareMinLat),
            squareMinLon: parseZoneNumber(zone?.squareMinLon),
            squareMaxLat: parseZoneNumber(zone?.squareMaxLat),
            squareMaxLon: parseZoneNumber(zone?.squareMaxLon),
            polygonCoords,
        };

        if (normalized.shapeType === "SQUARE" && (!normalized.polygonCoords || normalized.polygonCoords.length < 4)) {
            const hasBounds = Number.isFinite(normalized.squareMinLat)
                && Number.isFinite(normalized.squareMinLon)
                && Number.isFinite(normalized.squareMaxLat)
                && Number.isFinite(normalized.squareMaxLon);

            if (hasBounds) {
                normalized.polygonCoords = buildSquarePolygonFromBounds(
                    normalized.squareMinLat,
                    normalized.squareMinLon,
                    normalized.squareMaxLat,
                    normalized.squareMaxLon
                );
            } else if (Number.isFinite(normalized.lat) && Number.isFinite(normalized.lon)) {
                normalized.polygonCoords = buildSquarePolygonFromCenter(
                    normalized.lat,
                    normalized.lon,
                    normalized.sideMeters || DEFAULT_SQUARE_SIDE
                );
            }
        }

        return normalized;
    }

    function formatSignedPercent(value) {
        if (value === null || value === undefined || value === "") {
            return "--";
        }

        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return "--";
        }

        const prefix = numericValue > 0 ? "+" : "";
        return `${prefix}${weightFormatter.format(numericValue)}%`;
    }

    function renderViolationBadge(value, customLabel) {
        const label = customLabel || (value ? "Да" : "Нет");
        return `
            <span class="dashboard-bool-badge ${value ? "is-yes" : "is-no"}">
                ${label}
            </span>
        `;
    }

    function isUnknownIngredientName(value) {
        const normalized = String(value ?? "").trim().toLowerCase();
        return !normalized || normalized === "unknown" || normalized === "неизвестный";
    }

    function getIngredientDisplayName(value) {
        const raw = String(value ?? "").trim();
        return isUnknownIngredientName(raw) ? "Неизвестный" : raw;
    }

    function normalizeIngredientKey(value) {
        const displayName = getIngredientDisplayName(value);
        return displayName.trim().toLowerCase().replace(/\s+/g, " ");
    }

    function getReplacementIngredientOptions() {
        const rationIngredients = Array.isArray(state.batch?.ration?.ingredients) ? state.batch.ration.ingredients : [];
        const seenNames = new Set();

        return rationIngredients.reduce((accumulator, ingredient) => {
            const ingredientName = getIngredientDisplayName(ingredient?.name);
            if (!ingredientName || seenNames.has(ingredientName)) {
                return accumulator;
            }

            seenNames.add(ingredientName);
            accumulator.push(ingredientName);
            return accumulator;
        }, []);
    }

    function setText(element, value) {
        if (!element) {
            return;
        }

        element.textContent = value ?? "--";
    }

    function buildAuthHeaders(includeJson) {
        const headers = window.AppAuth?.getAuthHeaders?.({ includeJson: Boolean(includeJson) }) || {};

        if (!includeJson) {
            return headers;
        }

        return {
            "Content-Type": "application/json",
            ...headers,
        };
    }

    function setLoadingState() {
        setText(detailsTitle, "Загрузка...");
        setText(detailsPageTitle, "Детали замеса");
        setText(rationName, "--");
        setText(startTime, "--");
        setText(endTime, "--");
        setText(barnName, "--");
        setText(remainingWeight, "--");
        setText(unloadProgressMeta, "--");
        setText(planTotal, "--");
        setText(factTotal, "--");
        setText(deviationTotal, "--");

        if (unloadProgressBar) {
            unloadProgressBar.style.width = "0%";
        }

        if (ingredientListBody) {
            ingredientListBody.innerHTML = '<tr><td colspan="5" class="batch-detail-empty">Загрузка...</td></tr>';
        }

        if (planFactBody) {
            planFactBody.innerHTML = '<tr><td colspan="5" class="dashboard-mini-table-empty">Загрузка...</td></tr>';
        }

        if (trackMeta) {
            setText(trackMeta, "Загрузка трека...");
        }

        if (trackEmpty) {
            trackEmpty.classList.add("d-none");
        }
    }

    function renderBatchSummary(batch) {
        const title = batch?.id ? `Замес #${batch.id}` : "Замес";
        document.title = `${title} | Детали`;

        setText(detailsTitle, title);
        setText(detailsPageTitle, title);
        setText(rationName, batch?.rationName || "Без рациона");
        setText(startTime, formatDateTime(batch?.startTime));
        setText(endTime, batch?.endTime ? formatDateTime(batch.endTime) : "В процессе");
        setText(barnName, batch?.unloadingInfo?.barnName || "Коровник не выбран");
        setText(remainingWeight, formatWeight(batch?.unloadingInfo?.remainingWeight));
        renderUnloadProgress(batch?.unloadingInfo?.progress || null);
        updateStopButtonState(batch);
        updateDeleteButtonState(batch);
    }

    function renderUnloadProgress(progress) {
        if (unloadProgressBar) {
            unloadProgressBar.style.width = "0%";
        }

        if (!progress) {
            setText(unloadProgressMeta, "--");
            return;
        }

        const targetWeight = Number(progress?.target_weight);
        const unloadedFact = Number(progress?.unloaded_fact);

        if (!Number.isFinite(targetWeight) || targetWeight <= 0 || !Number.isFinite(unloadedFact)) {
            setText(unloadProgressMeta, "--");
            return;
        }

        const rawPercent = Math.max((unloadedFact / targetWeight) * 100, 0);
        const progressWidth = Math.min(rawPercent, 100);

        if (unloadProgressBar) {
            unloadProgressBar.style.width = `${progressWidth}%`;
        }

        setText(
            unloadProgressMeta,
            `${formatWeight(unloadedFact)} / ${formatWeight(targetWeight)} (${weightFormatter.format(rawPercent)}%)`
        );
    }

    function renderIngredientList(rows) {
        if (!ingredientListBody) {
            return;
        }

        if (!rows.length) {
            ingredientListBody.innerHTML = '<tr><td colspan="5" class="batch-detail-empty">По этому замесу нет загруженных ингредиентов</td></tr>';
            return;
        }

        const replacementOptions = getReplacementIngredientOptions();
        const hasReplacementOptions = replacementOptions.length > 0;
        const hasRation = Boolean(normalizeNullableId(state.batch?.rationId) || normalizeNullableId(state.batch?.ration?.id));
        const summaryRows = Array.isArray(state.batch?.ingredients) ? state.batch.ingredients : [];
        const componentViolationByKey = new Map(
            summaryRows.map((item) => [
                normalizeIngredientKey(item?.name),
                asBoolean(item?.isViolation ?? item?.is_violation)
            ])
        );
        const seenComponentViolationBadge = new Set();

        ingredientListBody.innerHTML = rows.map((row) => `
            <tr>
                <td>${escapeHtml(formatTime(row?.time))}</td>
                <td>${renderIngredientCell(row, hasRation, hasReplacementOptions, replacementOptions)}</td>
                <td>${escapeHtml(formatWeight(row?.fact ?? row?.actualWeight))}</td>
                <td>${renderIngredientViolationCell(row, componentViolationByKey, seenComponentViolationBadge)}</td>
                <td class="text-center">${renderIngredientActionsCell(row)}</td>
            </tr>
        `).join("");
    }

    function renderIngredientActionsCell(row) {
        const ingredientId = normalizeNullableId(row?.id);
        if (!canWrite || ingredientId === null) {
            return '<span class="text-muted small">--</span>';
        }

        if (state.ingredientDeleteId === ingredientId) {
            return '<span class="text-muted small">Удаляем...</span>';
        }

        if (state.ingredientUpdateId === ingredientId) {
            return '<span class="text-muted small">Сохраняем...</span>';
        }

        const disabled = state.isBatchLoading || state.isSaving || state.stopBatchInFlight || state.deleteBatchInFlight;
        const isBusy = disabled || state.ingredientUpdateId !== null || state.ingredientDeleteId !== null;
        const disabledAttr = isBusy ? " disabled" : "";

        return `
            <button
                type="button"
                class="btn btn-sm btn-outline-danger"
                data-role="ingredient-delete"
                data-ingredient-id="${ingredientId}"${disabledAttr}
                title="Удалить компонент из замеса"
            >
                <i class="fas fa-trash-alt"></i>
            </button>
        `;
    }

    function renderIngredientViolationCell(row, componentViolationByKey, seenComponentViolationBadge) {
        const key = normalizeIngredientKey(row?.name);
        const isComponentViolation = asBoolean(componentViolationByKey.get(key));

        if (!isComponentViolation) {
            return renderViolationBadge(false);
        }

        if (seenComponentViolationBadge.has(key)) {
            return '<span class="text-muted small">По сумме компонента</span>';
        }

        seenComponentViolationBadge.add(key);
        return renderViolationBadge(true, "Да (итог)");
    }

    function renderIngredientCell(row, hasRation, hasReplacementOptions, replacementOptions) {
        const ingredientId = normalizeNullableId(row?.id);
        const ingredientName = getIngredientDisplayName(row?.name);
        const isUnknown = isUnknownIngredientName(ingredientName);
        const isDisabled = state.isBatchLoading
            || state.isSaving
            || state.stopBatchInFlight
            || state.deleteBatchInFlight
            || state.ingredientDeleteId !== null;
        const canEditFromRation = canWrite && ingredientId !== null && !isDisabled && hasReplacementOptions;
        const canEditManual = canWrite && ingredientId !== null && !isDisabled && !hasRation;
        const disabledAttribute = canEditFromRation ? "" : " disabled";
        const optionsMarkup = replacementOptions
            .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
            .join("");

        if (!canWrite || ingredientId === null) {
            return `<strong>${escapeHtml(ingredientName || "Без названия")}</strong>`;
        }

        if (state.ingredientUpdateId === ingredientId) {
            return `
                <div class="batch-ingredient-editor">
                    <strong class="d-block ${isUnknown ? "text-warning" : ""}">${escapeHtml(ingredientName || "Без названия")}</strong>
                    <small class="text-muted d-block mt-1">Сохраняем выбранный корм...</small>
                </div>
            `;
        }

        let hint = isUnknown
            ? "Выберите корм вместо «Неизвестного»."
            : "Можно заменить компонент вручную.";

        if (!hasRation) {
            hint = "Рацион не назначен: доступно ручное переименование компонента.";
        } else if (!hasReplacementOptions) {
            hint = "В привязанном рационе нет ингредиентов для выбора.";
        } else if (isDisabled) {
            hint = "Подождите завершения текущего сохранения/загрузки.";
        }

        if (canEditManual) {
            return `
                <div class="batch-ingredient-editor">
                    <div class="batch-ingredient-editor__controls">
                        <span class="batch-ingredient-editor__trigger ${isUnknown ? "text-warning" : ""}">${escapeHtml(ingredientName || "Без названия")}</span>
                        <button
                            type="button"
                            class="btn btn-sm btn-outline-primary"
                            data-role="ingredient-rename"
                            data-ingredient-id="${ingredientId}"
                            data-current-name="${escapeHtml(ingredientName || "")}"
                        >
                            Переименовать
                        </button>
                    </div>
                    <small class="text-muted d-block mt-1">${escapeHtml(hint)}</small>
                </div>
            `;
        }

        if (!canEditFromRation) {
            return `
                <div class="batch-ingredient-editor">
                    <strong class="${isUnknown ? "text-warning" : ""}">${escapeHtml(ingredientName || "Без названия")}</strong>
                    <small class="text-muted d-block mt-1">${escapeHtml(hint)}</small>
                </div>
            `;
        }

        return `
            <div class="batch-ingredient-editor">
                <div class="batch-ingredient-editor__controls">
                <label class="sr-only" for="batchIngredientSelect${ingredientId}">Выбор корма</label>
                <span class="batch-ingredient-editor__trigger ${isUnknown ? "text-warning" : ""}">${escapeHtml(ingredientName || "Без названия")}</span>
                <select
                    id="batchIngredientSelect${ingredientId}"
                    class="form-control form-control-sm batch-ingredient-editor__select"
                    data-role="ingredient-replacement"
                    data-ingredient-id="${ingredientId}"${disabledAttribute}
                >
                    <option value="">Выберите корм</option>
                    ${optionsMarkup}
                </select>
                </div>
                <small class="text-muted d-block mt-1">${escapeHtml(hint)}</small>
            </div>
        `;
    }

    function renderPlanFact(rows) {
        if (!planFactBody) {
            return;
        }

        if (!rows.length) {
            planFactBody.innerHTML = '<tr><td colspan="5" class="dashboard-mini-table-empty">Нет данных по плану и факту</td></tr>';
            setText(planTotal, "--");
            setText(factTotal, "--");
            setText(deviationTotal, "--");
            return;
        }

        const totals = rows.reduce((accumulator, row) => {
            accumulator.plan += toNumber(row?.plan);
            accumulator.fact += toNumber(row?.fact);
            return accumulator;
        }, { plan: 0, fact: 0 });

        const totalDeviationPercent = totals.plan > 0
            ? ((totals.fact - totals.plan) / totals.plan) * 100
            : null;

        setText(planTotal, formatWeight(totals.plan));
        setText(factTotal, formatWeight(totals.fact));
        setText(deviationTotal, formatSignedPercent(totalDeviationPercent));

        const visibleRows = rows.flatMap((row) => {
            const componentRows = row?.isCompound && Array.isArray(row?.components)
                ? row.components.map((component) => ({
                    name: `  - ${component?.name || "Без названия"}`,
                    plan: component?.plan,
                    fact: component?.fact,
                    deviation_percent: component?.deviation_percent ?? component?.deviationPercent,
                    isViolation: false,
                    is_violation: false
                }))
                : [];

            return [row, ...componentRows];
        });

        planFactBody.innerHTML = visibleRows.map((row) => `
            <tr>
                <td>${escapeHtml(row?.name || "Без названия")}</td>
                <td>${escapeHtml(formatWeight(row?.plan))}</td>
                <td>${escapeHtml(formatWeight(row?.fact))}</td>
                <td>${escapeHtml(formatSignedPercent(row?.deviation_percent ?? row?.deviationPercent))}</td>
                <td>${renderViolationBadge(asBoolean(row?.isViolation ?? row?.is_violation))}</td>
            </tr>
        `).join("");
    }

    function destroyTelemetryChart() {
        if (!telemetryChart) {
            return;
        }

        telemetryChart.destroy();
        telemetryChart = null;
    }

    function normalizeTrackPoints(points) {
        return (Array.isArray(points) ? points : [])
            .map((point) => ({
                lat: Number(point?.lat),
                lon: Number(point?.lon),
                timestamp: point?.timestamp || null,
                weight: point?.weight == null ? null : Number(point.weight),
                speed: point?.speed == null ? null : Number(point.speed),
                course: point?.course == null ? null : Number(point.course),
                heading: point?.heading == null ? null : Number(point.heading),
                relPosValid: point?.relPosValid,
                relPosHeadingValid: point?.relPosHeadingValid,
                deviceId: point?.deviceId || null,
                rtkQuality: point?.rtkQuality || point?.fixType || null,
                timestampMs: parseTimestampMs(point?.timestamp),
                source: point,
            }))
            .filter((point) => hasValidCoordinates(point.lat, point.lon) && point.timestampMs !== null)
            .sort((left, right) => left.timestampMs - right.timestampMs);
    }

    function normalizeTelemetryPayload(payload) {
        if (Array.isArray(payload)) {
            return {
                hostTrack: payload,
                loaderTrack: [],
                meta: null,
            };
        }

        return {
            hostTrack: Array.isArray(payload?.hostTrack) ? payload.hostTrack : [],
            loaderTrack: Array.isArray(payload?.loaderTrack) ? payload.loaderTrack : [],
            meta: payload?.meta || null,
        };
    }

    function findClosestTrackPointByTime(targetTimestampMs, trackPoints) {
        if (!Number.isFinite(targetTimestampMs) || !Array.isArray(trackPoints) || !trackPoints.length) {
            return null;
        }

        let bestPoint = trackPoints[0];
        let bestDelta = Math.abs(trackPoints[0].timestampMs - targetTimestampMs);

        for (let index = 1; index < trackPoints.length; index += 1) {
            const currentPoint = trackPoints[index];
            const currentDelta = Math.abs(currentPoint.timestampMs - targetTimestampMs);
            if (currentDelta < bestDelta) {
                bestPoint = currentPoint;
                bestDelta = currentDelta;
            }
        }

        return { point: bestPoint, deltaMs: bestDelta };
    }

    function ensureYmapsReady() {
        if (!window.ymaps || typeof window.ymaps.ready !== "function") {
            return Promise.reject(new Error("Yandex Maps API недоступен"));
        }

        if (!ymapsReadyPromise) {
            ymapsReadyPromise = new Promise((resolve) => {
                window.ymaps.ready(resolve);
            });
        }

        return ymapsReadyPromise;
    }

    async function ensureBatchTrackMap() {
        if (!trackMapElement) {
            return null;
        }

        await ensureYmapsReady();

        if (!batchTrackMap) {
            batchTrackMap = new window.ymaps.Map("batchTrackMap", {
                center: [55.1064, 82.8100],
                zoom: 12,
                controls: ["zoomControl", "typeSelector", "fullscreenControl"],
                type: "yandex#satellite",
            }, {
                suppressMapOpenBlock: true,
            });
        }

        return batchTrackMap;
    }

    function clearBatchTrackZones(map) {
        if (!map) {
            return;
        }

        batchTrackZoneObjects.forEach((zoneObject) => {
            map.geoObjects.remove(zoneObject);
        });
        batchTrackZoneObjects = [];
    }

    function renderBatchTrackZones(map, zones) {
        if (!map) {
            return;
        }

        clearBatchTrackZones(map);

        batchTrackZoneObjects = (Array.isArray(zones) ? zones : [])
            .filter((zone) => zone?.active)
            .map((zone) => {
                const shapeLabel = normalizeShapeType(zone.shapeType) === "SQUARE" ? "Квадрат" : "Круг";
                const zoneColors = getZoneTypeColors(zone);
                const sizeLabel = normalizeShapeType(zone.shapeType) === "SQUARE"
                    ? `${Math.max(1, Math.round(Number(zone.sideMeters || DEFAULT_SQUARE_SIDE)))} м`
                    : `${Math.max(1, Math.round(Number(zone.radius || DEFAULT_ZONE_RADIUS)))} м`;

                const latLabel = Number.isFinite(zone.lat) ? zone.lat.toFixed(6) : "--";
                const lonLabel = Number.isFinite(zone.lon) ? zone.lon.toFixed(6) : "--";
                const balloonContent = `
                    <strong>${escapeHtml(getZoneLabel(zone))}</strong><br>
                    Тип: ${escapeHtml(getZoneTypeLabel(zone))}<br>
                    Форма: ${escapeHtml(shapeLabel)}<br>
                    Центр: ${escapeHtml(latLabel)}, ${escapeHtml(lonLabel)}<br>
                    Размер: ${escapeHtml(sizeLabel)}
                `;

                const zoneObject = normalizeShapeType(zone.shapeType) === "SQUARE"
                    && Array.isArray(zone.polygonCoords)
                    && zone.polygonCoords.length >= 4
                    ? new window.ymaps.Polygon(
                        [zone.polygonCoords],
                        { balloonContent },
                        {
                            fillColor: zoneColors.fillColor,
                            strokeColor: zoneColors.strokeColor,
                            strokeOpacity: 0.85,
                            strokeWidth: 2,
                        }
                    )
                    : new window.ymaps.Circle(
                        [
                            [Number(zone.lat), Number(zone.lon)],
                            Number(zone.radius) || DEFAULT_ZONE_RADIUS,
                        ],
                        { balloonContent },
                        {
                            fillColor: zoneColors.fillColor,
                            strokeColor: zoneColors.strokeColor,
                            strokeOpacity: 0.85,
                            strokeWidth: 2,
                        }
                    );

                map.geoObjects.add(zoneObject);
                return zoneObject;
            });
    }

    function getBoundsFromCoordinates(coordinates) {
        if (!Array.isArray(coordinates) || !coordinates.length) {
            return null;
        }

        const lats = coordinates.map((point) => Number(point[0])).filter(Number.isFinite);
        const lons = coordinates.map((point) => Number(point[1])).filter(Number.isFinite);
        if (!lats.length || !lons.length) {
            return null;
        }

        return [
            [Math.min(...lats), Math.min(...lons)],
            [Math.max(...lats), Math.max(...lons)],
        ];
    }

    function calculateDistanceMeters(pointA, pointB) {
        const toRadians = (degrees) => degrees * Math.PI / 180;
        const earthRadiusMeters = 6371000;
        const lat1 = toRadians(pointA.lat);
        const lat2 = toRadians(pointB.lat);
        const deltaLat = toRadians(pointB.lat - pointA.lat);
        const deltaLon = toRadians(pointB.lon - pointA.lon);
        const sinLat = Math.sin(deltaLat / 2);
        const sinLon = Math.sin(deltaLon / 2);
        const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

        return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function shouldRenderDashedTrackGap(previousPoint, currentPoint) {
        if (!previousPoint || !currentPoint) {
            return false;
        }

        const distanceMeters = calculateDistanceMeters(previousPoint, currentPoint);
        const hasTimestamps = previousPoint.timestampMs !== null && currentPoint.timestampMs !== null;

        if (!hasTimestamps) {
            return distanceMeters > TRACK_MIN_JUMP_DISTANCE_M * 4;
        }

        const gapMs = Math.max(0, currentPoint.timestampMs - previousPoint.timestampMs);
        const gapSeconds = gapMs / 1000;
        const speedMps = gapSeconds > 0 ? distanceMeters / gapSeconds : 0;

        return (
            speedMps > TRACK_MAX_SPEED_MPS ||
            (gapMs > TRACK_MAX_GAP_MS && distanceMeters > TRACK_MIN_JUMP_DISTANCE_M)
        );
    }

    function hasRtkHeadingData(point) {
        if (!point || point.relPosValid === false || point.relPosHeadingValid === false) {
            return false;
        }

        const heading = point.heading ?? point.course;
        return Number.isFinite(Number(heading));
    }

    function buildHostTrackSegments(trackPoints) {
        const segments = [];
        let currentSegment = [];

        trackPoints.forEach((point) => {
            const previousPoint = currentSegment[currentSegment.length - 1];

            if (shouldRenderDashedTrackGap(previousPoint, point)) {
                if (currentSegment.length >= 2) {
                    segments.push({
                        coords: currentSegment.map((item) => [item.lat, item.lon]),
                        dashed: false,
                    });
                }

                segments.push({
                    coords: [
                        [previousPoint.lat, previousPoint.lon],
                        [point.lat, point.lon],
                    ],
                    dashed: true,
                });

                currentSegment = [point];
                return;
            }

            currentSegment.push(point);
        });

        if (currentSegment.length >= 2) {
            segments.push({
                coords: currentSegment.map((item) => [item.lat, item.lon]),
                dashed: false,
            });
        }

        return segments;
    }

    function buildRtkTrackSegments(trackPoints) {
        const segments = [];

        for (let index = 1; index < trackPoints.length; index += 1) {
            const previousPoint = trackPoints[index - 1];
            const currentPoint = trackPoints[index];

            segments.push({
                coords: [
                    [previousPoint.lat, previousPoint.lon],
                    [currentPoint.lat, currentPoint.lon],
                ],
                dashed: shouldRenderDashedTrackGap(previousPoint, currentPoint),
                strokeColor: hasRtkHeadingData(currentPoint) ? RTK_FIX_COLOR : RTK_GPS_FIX_COLOR,
            });
        }

        return segments;
    }

    function createTrackPolylines(map, segments, options = {}) {
        return segments.map((segment) => {
            const polyline = new window.ymaps.Polyline(
                segment.coords,
                {
                    balloonContent: options.balloonContent,
                },
                {
                    strokeColor: segment.strokeColor || options.strokeColor,
                    strokeWidth: options.strokeWidth,
                    strokeOpacity: options.strokeOpacity,
                    ...(segment.dashed ? { strokeStyle: "dash" } : {}),
                }
            );

            map.geoObjects.add(polyline);
            return polyline;
        });
    }

    function drawTrackLayer(map, trackPoints, options = {}) {
        if (!map || !Array.isArray(trackPoints) || !trackPoints.length) {
            return [];
        }

        const color = options.color || HOST_TRACK_COLOR;
        const title = options.title || "Трек";
        const objects = [];
        const segments = options.kind === "rtk"
            ? buildRtkTrackSegments(trackPoints)
            : buildHostTrackSegments(trackPoints);

        objects.push(...createTrackPolylines(map, segments, {
            balloonContent: title,
            strokeColor: color,
            strokeWidth: options.strokeWidth || 4,
            strokeOpacity: options.strokeOpacity || 0.9,
        }));

        const firstPoint = trackPoints[0];
        const lastPoint = trackPoints[trackPoints.length - 1];
        const formatPointDetails = (point) => {
            const rows = [
                `${escapeHtml(title)}<br>Время: ${escapeHtml(formatDateTime(point.timestamp))}`,
                point.weight == null || Number.isNaN(point.weight) ? null : `Вес: ${escapeHtml(formatWeight(point.weight))}`,
                point.speed == null || Number.isNaN(point.speed) ? null : `Скорость: ${escapeHtml(point.speed.toFixed(1))} км/ч`,
                point.course == null || Number.isNaN(point.course) ? null : `Heading: ${escapeHtml(point.course.toFixed(0))}°`,
                options.kind === "rtk" ? `Heading valid: ${hasRtkHeadingData(point) ? "да" : "нет"}` : null,
                point.deviceId ? `Устройство: ${escapeHtml(point.deviceId)}` : null,
                point.rtkQuality ? `RTK: ${escapeHtml(point.rtkQuality)}` : null,
            ].filter(Boolean);

            return rows.join("<br>");
        };

        const startPlacemark = new window.ymaps.Placemark(
            [firstPoint.lat, firstPoint.lon],
            {
                hintContent: `Старт: ${title} (${formatTime(firstPoint.timestamp)})`,
                balloonContent: `<strong>Старт</strong><br>${formatPointDetails(firstPoint)}`,
            },
            {
                preset: options.startPreset || "islands#greenCircleDotIcon",
            }
        );
        map.geoObjects.add(startPlacemark);
        objects.push(startPlacemark);

        const endPlacemark = new window.ymaps.Placemark(
            [lastPoint.lat, lastPoint.lon],
            {
                hintContent: `Финиш: ${title} (${formatTime(lastPoint.timestamp)})`,
                balloonContent: `<strong>Финиш</strong><br>${formatPointDetails(lastPoint)}`,
            },
            {
                preset: options.endPreset || "islands#redCircleDotIcon",
            }
        );
        map.geoObjects.add(endPlacemark);
        objects.push(endPlacemark);

        return objects;
    }

    async function renderBatchTrack(trackPayload, ingredientRows) {
        if (!trackMapElement) {
            return;
        }

        const normalizedPayload = normalizeTelemetryPayload(trackPayload);
        const hostTrackPoints = normalizeTrackPoints(normalizedPayload.hostTrack);
        const loaderTrackPoints = normalizeTrackPoints(normalizedPayload.loaderTrack);
        const allTrackPoints = [...hostTrackPoints, ...loaderTrackPoints]
            .sort((left, right) => left.timestampMs - right.timestampMs);
        let map;

        try {
            map = await ensureBatchTrackMap();
        } catch (error) {
            if (trackMeta) {
                setText(trackMeta, "Карта недоступна (не загрузился API Yandex Maps)");
            }
            if (trackEmpty) {
                trackEmpty.classList.remove("d-none");
            }
            return;
        }

        if (!map) {
            return;
        }

        if (!allTrackPoints.length) {
            map.geoObjects.removeAll();
            renderBatchTrackZones(map, state.storageZones);
            if (map.container && typeof map.container.fitToViewport === "function") {
                map.container.fitToViewport();
            }
            const zoneBounds = typeof map.geoObjects.getBounds === "function"
                ? map.geoObjects.getBounds()
                : null;
            if (zoneBounds) {
                map.setBounds(zoneBounds, {
                    checkZoomRange: true,
                    zoomMargin: 24,
                    duration: 120,
                });
            }

            const activeZonesCount = (Array.isArray(state.storageZones) ? state.storageZones : [])
                .filter((zone) => zone?.active)
                .length;

            if (trackMeta) {
                setText(
                    trackMeta,
                    activeZonesCount > 0
                        ? `Нет координат трека. Показаны активные зоны: ${activeZonesCount}`
                        : "Нет координат в телеметрии этого замеса"
                );
            }
            if (trackEmpty) {
                if (activeZonesCount > 0) {
                    trackEmpty.classList.add("d-none");
                } else {
                    trackEmpty.classList.remove("d-none");
                }
            }
            return;
        }

        map.geoObjects.removeAll();
        renderBatchTrackZones(map, state.storageZones);
        if (trackEmpty) {
            trackEmpty.classList.add("d-none");
        }
        if (map.container && typeof map.container.fitToViewport === "function") {
            map.container.fitToViewport();
        }

        drawTrackLayer(map, hostTrackPoints, {
            title: "Хозяин / кормораздатчик",
            color: HOST_TRACK_COLOR,
            strokeWidth: 4,
            startPreset: "islands#blueCircleDotIcon",
            endPreset: "islands#darkBlueCircleDotIcon",
        });
        drawTrackLayer(map, loaderTrackPoints, {
            title: "Погрузчик",
            kind: "rtk",
            color: RTK_GPS_FIX_COLOR,
            strokeWidth: 5,
            startPreset: "islands#greenCircleDotIcon",
            endPreset: "islands#redCircleDotIcon",
        });

        const rows = Array.isArray(ingredientRows) ? ingredientRows : [];
        let linkedIngredients = 0;
        const ingredientTrackPoints = loaderTrackPoints.length ? loaderTrackPoints : hostTrackPoints;

        rows.forEach((row) => {
            const ingredientTimestampMs = parseTimestampMs(row?.time);
            const closest = findClosestTrackPointByTime(ingredientTimestampMs, ingredientTrackPoints);
            if (!closest?.point || closest.deltaMs > (2 * 60 * 1000)) {
                return;
            }

            linkedIngredients += 1;
            const marker = new window.ymaps.Placemark(
                [closest.point.lat, closest.point.lon],
                {
                    hintContent: `${getIngredientDisplayName(row?.name)} (${formatTime(row?.time)})`,
                    balloonContent: `
                        <strong>${escapeHtml(getIngredientDisplayName(row?.name))}</strong><br>
                        Время добавления: ${escapeHtml(formatDateTime(row?.time))}<br>
                        Факт: ${escapeHtml(formatWeight(row?.fact ?? row?.actualWeight))}<br>
                        Координаты: ${closest.point.lat.toFixed(5)}, ${closest.point.lon.toFixed(5)}
                    `,
                },
                {
                    preset: "islands#blueCircleDotIcon",
                }
            );

            map.geoObjects.add(marker);
        });

        const coordinates = allTrackPoints.map((point) => [point.lat, point.lon]);
        const trackBounds = getBoundsFromCoordinates(coordinates);
        if (coordinates.length === 1) {
            map.setCenter(coordinates[0], 17, { duration: 120 });
        } else if (trackBounds) {
            map.setBounds(trackBounds, {
                checkZoomRange: true,
                zoomMargin: 32,
                duration: 120,
            });
        } else {
            const mapBounds = typeof map.geoObjects.getBounds === "function"
                ? map.geoObjects.getBounds()
                : null;
            if (mapBounds) {
                map.setBounds(mapBounds, {
                    checkZoomRange: true,
                    zoomMargin: 24,
                    duration: 120,
                });
            }
        }

        if (trackMeta) {
            const firstPoint = allTrackPoints[0];
            const lastPoint = allTrackPoints[allTrackPoints.length - 1];
            const startLabel = formatDateTime(firstPoint.timestamp);
            const endLabel = formatDateTime(lastPoint.timestamp);
            setText(
                trackMeta,
                `Хозяин: ${hostTrackPoints.length} точек • Погрузчик: ${loaderTrackPoints.length} точек • ${linkedIngredients} меток компонентов • ${startLabel} — ${endLabel}`
            );
        }
    }

    function renderTelemetry(points) {
        if (!telemetryCanvas || !telemetryEmpty) {
            return;
        }

        const rows = Array.isArray(points) ? points : [];

        if (!rows.length) {
            destroyTelemetryChart();
            telemetryCanvas.classList.add("d-none");
            telemetryEmpty.classList.remove("d-none");
            return;
        }

        telemetryCanvas.classList.remove("d-none");
        telemetryEmpty.classList.add("d-none");
        destroyTelemetryChart();

        const context = telemetryCanvas.getContext("2d");
        telemetryChart = new Chart(context, {
            type: "line",
            data: {
                labels: rows.map((point) => formatTime(point?.timestamp)),
                datasets: [
                    {
                        label: "Вес, кг",
                        data: rows.map((point) => toNumber(point?.weight)),
                        borderColor: "#4e73df",
                        backgroundColor: "rgba(78, 115, 223, 0.12)",
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        lineTension: 0.18,
                        fill: true,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                legend: {
                    display: false,
                },
                tooltips: {
                    callbacks: {
                        label: function (tooltipItem) {
                            return `Вес: ${weightFormatter.format(tooltipItem.yLabel)} кг`;
                        },
                    },
                },
                scales: {
                    xAxes: [
                        {
                            gridLines: {
                                display: false,
                            },
                            ticks: {
                                maxTicksLimit: 8,
                            },
                        },
                    ],
                    yAxes: [
                        {
                            ticks: {
                                callback: function (value) {
                                    return `${weightFormatter.format(value)} кг`;
                                },
                            },
                        },
                    ],
                },
            },
        });
    }

    function setEditCardVisible(visible) {
        if (!editCard) {
            return;
        }

        editCard.hidden = !visible;
    }

    function setEditState(message, tone) {
        if (!editState) {
            return;
        }

        const tones = ["info", "warning", "danger"];
        editState.classList.remove("d-none");
        editState.classList.remove("batch-edit-state--info", "batch-edit-state--warning", "batch-edit-state--danger");

        if (!message) {
            editState.textContent = "";
            editState.classList.add("d-none");
            return;
        }

        editState.textContent = message;
        editState.classList.add(`batch-edit-state--${tones.includes(tone) ? tone : "info"}`);
    }

    function getCurrentRationOption(batch) {
        const rationId = normalizeNullableId(batch?.rationId);
        if (rationId === null) {
            return null;
        }

        return {
            id: rationId,
            name: batch?.ration?.name || batch?.rationName || `Рацион #${rationId}`,
            isActive: batch?.ration?.isActive,
        };
    }

    function getCurrentGroupOption(batch) {
        const groupId = normalizeNullableId(batch?.groupId);
        if (groupId === null) {
            return null;
        }

        return {
            id: groupId,
            name: batch?.group?.name || batch?.groupName || `Группа #${groupId}`,
        };
    }

    function formatRationOptionLabel(ration) {
        if (!ration) {
            return "";
        }

        const name = ration?.name || `Рацион #${ration.id}`;
        return ration?.isActive === false ? `${name} (неактивен)` : name;
    }

    function formatGroupOptionLabel(group) {
        return group?.name || `Группа #${group?.id}`;
    }

    function renderSelectOptions(selectElement, items, emptyLabel, currentId, currentOption, getLabel) {
        if (!selectElement) {
            return;
        }

        const normalizedCurrentId = normalizeNullableId(currentId);
        const options = [`<option value="">${escapeHtml(emptyLabel)}</option>`];
        const seenIds = new Set();

        (Array.isArray(items) ? items : []).forEach((item) => {
            const id = normalizeNullableId(item?.id);
            if (id === null || seenIds.has(id)) {
                return;
            }

            seenIds.add(id);
            options.push(`<option value="${id}">${escapeHtml(getLabel(item))}</option>`);
        });

        if (normalizedCurrentId !== null && currentOption && !seenIds.has(normalizedCurrentId)) {
            options.push(`<option value="${normalizedCurrentId}">${escapeHtml(getLabel(currentOption))}</option>`);
        }

        selectElement.innerHTML = options.join("");
        selectElement.value = normalizedCurrentId === null ? "" : String(normalizedCurrentId);
    }

    function buildLookupHint(resourceName, status, items, currentOption) {
        if (status.loading) {
            return `Загружаем список ${resourceName}...`;
        }

        if (status.error) {
            const currentLabel = currentOption?.name ? ` Текущее значение: ${currentOption.name}.` : "";
            return `Не удалось загрузить список ${resourceName}.${currentLabel}`;
        }

        if (!items.length) {
            return `Список ${resourceName} пока пуст.`;
        }

        if (currentOption?.name) {
            return `Текущее значение: ${currentOption.name}.`;
        }

        return `Можно оставить поле пустым.`;
    }

    function getComputedEditorState() {
        if (!canWrite) {
            return null;
        }

        if (state.editorMessage?.message) {
            return state.editorMessage;
        }

        if (state.isSaving) {
            return {
                tone: "info",
                message: "Сохраняем изменения и пересчитываем замес...",
            };
        }

        if (state.isBatchLoading && !state.batch) {
            return {
                tone: "info",
                message: "Загружаем данные замеса...",
            };
        }

        if (state.batchError) {
            return {
                tone: "danger",
                message: state.batchError,
            };
        }

        const rationsLoading = state.lookupStatus.rations.loading;
        const groupsLoading = state.lookupStatus.groups.loading;
        if (rationsLoading || groupsLoading) {
            return {
                tone: "info",
                message: "Загружаем справочники рационов и групп...",
            };
        }

        const hasRationsError = Boolean(state.lookupStatus.rations.error);
        const hasGroupsError = Boolean(state.lookupStatus.groups.error);

        if (hasRationsError && hasGroupsError) {
            return {
                tone: "warning",
                message: "Не удалось загрузить списки рационов и групп. Редактирование временно недоступно.",
            };
        }

        if (hasRationsError) {
            return {
                tone: "warning",
                message: "Список рационов недоступен. Можно изменить только группу.",
            };
        }

        if (hasGroupsError) {
            return {
                tone: "warning",
                message: "Список групп недоступен. Можно изменить только рацион.",
            };
        }

        return null;
    }

    function getSelectedNullableId(selectElement, fallbackValue) {
        if (!selectElement) {
            return normalizeNullableId(fallbackValue);
        }

        return normalizeNullableId(selectElement.value);
    }

    function hasEditorChanges() {
        if (!state.batch) {
            return false;
        }

        const selectedRationId = getSelectedNullableId(editRationSelect, state.batch.rationId);
        const selectedGroupId = getSelectedNullableId(editGroupSelect, state.batch.groupId);

        return selectedRationId !== normalizeNullableId(state.batch.rationId)
            || selectedGroupId !== normalizeNullableId(state.batch.groupId);
    }

    function updateEditButtonState() {
        if (!editSubmitButton) {
            return;
        }

        editSubmitButton.disabled = !canWrite
            || !state.batch
            || Boolean(state.batchError)
            || state.isBatchLoading
            || state.isSaving
            || state.stopBatchInFlight
            || state.deleteBatchInFlight;

        editSubmitButton.textContent = state.isSaving ? "Сохраняем..." : "Пересчитать";
        updateStopButtonState(state.batch);
        updateDeleteButtonState(state.batch);
    }

    function renderBatchEditor(batch) {
        if (!editCard) {
            return;
        }

        setEditCardVisible(canWrite);
        if (!canWrite) {
            return;
        }

        const currentRation = getCurrentRationOption(batch);
        const currentGroup = getCurrentGroupOption(batch);

        renderSelectOptions(
            editRationSelect,
            state.rations,
            "Без рациона",
            batch?.rationId,
            currentRation,
            formatRationOptionLabel
        );

        renderSelectOptions(
            editGroupSelect,
            state.groups,
            "Без группы",
            batch?.groupId,
            currentGroup,
            formatGroupOptionLabel
        );

        if (editRationSelect) {
            editRationSelect.disabled = state.isSaving
                || state.isBatchLoading
                || Boolean(state.batchError)
                || !state.lookupStatus.rations.loaded
                || Boolean(state.lookupStatus.rations.error);
        }

        if (editGroupSelect) {
            editGroupSelect.disabled = state.isSaving
                || state.isBatchLoading
                || Boolean(state.batchError)
                || !state.lookupStatus.groups.loaded
                || Boolean(state.lookupStatus.groups.error);
        }

        setText(editRationHint, buildLookupHint("рационов", state.lookupStatus.rations, state.rations, currentRation));
        setText(editGroupHint, buildLookupHint("групп", state.lookupStatus.groups, state.groups, currentGroup));

        if (editMeta) {
            const currentGroupName = batch?.group?.name || batch?.groupName || "без группы";
            const currentRationName = batch?.ration?.name || batch?.rationName || "без рациона";
            setText(
                editMeta,
                batch
                    ? `Сейчас: ${currentGroupName}, ${currentRationName}. После сохранения данные перечитаются с сервера.`
                    : "После сохранения замес перечитается с сервера."
            );
        }

        const editorState = getComputedEditorState();
        setEditState(editorState?.message || "", editorState?.tone);
        updateEditButtonState();
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

    async function requestJson(url, options) {
        const requestOptions = options || {};
        const method = requestOptions.method || "GET";
        const includeJson = Boolean(requestOptions.includeJson);
        const response = await fetch(url, {
            ...requestOptions,
            method,
            headers: {
                ...buildAuthHeaders(includeJson),
                ...(requestOptions.headers || {}),
            },
        });

        if (!response.ok) {
            const message = await readErrorMessage(response);
            throw new Error(message || "Не удалось выполнить запрос");
        }

        if (response.status === 204) {
            return null;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            return null;
        }

        return response.json();
    }

    async function fetchJson(url) {
        return requestJson(url, { method: "GET" });
    }

    async function patchJson(url, payload) {
        return requestJson(url, {
            method: "PATCH",
            includeJson: true,
            body: JSON.stringify(payload),
        });
    }

    async function postJson(url, payload) {
        return requestJson(url, {
            method: "POST",
            includeJson: true,
            body: JSON.stringify(payload || {}),
        });
    }

    async function deleteJson(url) {
        return requestJson(url, {
            method: "DELETE",
        });
    }

    async function handleIngredientReplacementChange(event) {
        const selectElement = event?.target;
        if (!(selectElement instanceof HTMLSelectElement) || selectElement.dataset.role !== "ingredient-replacement") {
            return;
        }

        const ingredientId = normalizeNullableId(selectElement.dataset.ingredientId);
        const ingredientName = getIngredientDisplayName(selectElement.value);

        if (ingredientId === null || !ingredientName || state.ingredientUpdateId !== null || state.ingredientDeleteId !== null) {
            if (!ingredientName) {
                selectElement.value = "";
            }
            return;
        }

        state.ingredientUpdateId = ingredientId;
        renderIngredientList(Array.isArray(state.batch?.actualIngredients) ? state.batch.actualIngredients : []);

        try {
            await patchJson(`${batchUrl}/ingredients/${ingredientId}`, { ingredientName });
            const didReload = await loadBatchDetails();
            if (didReload) {
                window.AppAuth?.showAlert?.("Ингредиент обновлен", "success");
            }
        } catch (error) {
            window.AppAuth?.showAlert?.(error.message || "Не удалось обновить ингредиент", "danger");
        } finally {
            state.ingredientUpdateId = null;
            renderIngredientList(Array.isArray(state.batch?.actualIngredients) ? state.batch.actualIngredients : []);
        }
    }

    function updateStopButtonState(batch) {
        if (!stopButton) {
            return;
        }

        const canShow = canAdmin && !batch?.endTime && normalizeNullableId(batch?.id) !== null;
        if (!canShow) {
            stopButton.classList.add("d-none");
            stopButton.disabled = true;
            stopButton.textContent = "Остановить замес";
            return;
        }

        stopButton.classList.remove("d-none");
        stopButton.disabled = state.stopBatchInFlight || state.deleteBatchInFlight || state.isBatchLoading || state.isSaving;
        stopButton.textContent = state.stopBatchInFlight ? "Останавливаем..." : "Остановить замес";
    }

    function updateDeleteButtonState(batch) {
        if (!deleteButton) {
            return;
        }

        const canShow = canWrite && normalizeNullableId(batch?.id) !== null;
        if (!canShow) {
            deleteButton.classList.add("d-none");
            deleteButton.disabled = true;
            deleteButton.textContent = "Удалить замес";
            return;
        }

        deleteButton.classList.remove("d-none");
        deleteButton.disabled = state.stopBatchInFlight || state.deleteBatchInFlight || state.isBatchLoading || state.isSaving;
        deleteButton.textContent = state.deleteBatchInFlight ? "Удаляем..." : "Удалить замес";
    }

    async function handleStopBatchClick() {
        const currentBatchId = normalizeNullableId(state.batch?.id);
        if (!canAdmin || !currentBatchId || state.stopBatchInFlight || state.deleteBatchInFlight) {
            return;
        }

        const approved = window.confirm(`Остановить замес #${currentBatchId}?`);
        if (!approved) {
            return;
        }

        state.stopBatchInFlight = true;
        updateStopButtonState(state.batch);

        try {
            await postJson(stopBatchUrl, {
                batchId: currentBatchId,
                deviceId: state.batch?.deviceId || null,
            });
            window.AppAuth?.showAlert?.(`Замес #${currentBatchId} остановлен`, "success");
            await loadBatchDetails();
        } catch (error) {
            window.AppAuth?.showAlert?.(error.message || "Не удалось остановить замес", "danger");
        } finally {
            state.stopBatchInFlight = false;
            updateStopButtonState(state.batch);
            updateDeleteButtonState(state.batch);
        }
    }

    async function handleIngredientRenameClick(event) {
        const button = event?.target?.closest?.("[data-role='ingredient-rename']");
        if (!(button instanceof HTMLButtonElement)) {
            return;
        }

        if (state.ingredientUpdateId !== null || state.ingredientDeleteId !== null || state.isBatchLoading || state.isSaving || state.stopBatchInFlight || state.deleteBatchInFlight) {
            return;
        }

        const ingredientId = normalizeNullableId(button.dataset.ingredientId);
        if (ingredientId === null) {
            return;
        }

        const currentName = getIngredientDisplayName(button.dataset.currentName || "");
        const nextNameRaw = window.prompt("Введите новое название компонента", currentName);
        if (nextNameRaw === null) {
            return;
        }

        const nextName = String(nextNameRaw).trim().replace(/\s+/g, " ");
        if (!nextName) {
            window.AppAuth?.showAlert?.("Название компонента не может быть пустым", "warning");
            return;
        }

        state.ingredientUpdateId = ingredientId;
        renderIngredientList(Array.isArray(state.batch?.actualIngredients) ? state.batch.actualIngredients : []);

        try {
            await patchJson(`${batchUrl}/ingredients/${ingredientId}`, { ingredientName: nextName });
            const didReload = await loadBatchDetails();
            if (didReload) {
                window.AppAuth?.showAlert?.("Ингредиент обновлен", "success");
            }
        } catch (error) {
            window.AppAuth?.showAlert?.(error.message || "Не удалось обновить ингредиент", "danger");
        } finally {
            state.ingredientUpdateId = null;
            renderIngredientList(Array.isArray(state.batch?.actualIngredients) ? state.batch.actualIngredients : []);
        }
    }

    async function handleIngredientDeleteClick(event) {
        const button = event?.target?.closest?.("[data-role='ingredient-delete']");
        if (!(button instanceof HTMLButtonElement)) {
            return;
        }

        if (state.ingredientDeleteId !== null || state.ingredientUpdateId !== null || state.isBatchLoading || state.isSaving) {
            return;
        }

        const ingredientId = normalizeNullableId(button.dataset.ingredientId);
        if (ingredientId === null) {
            return;
        }

        const approved = window.confirm("Удалить этот компонент из замеса?");
        if (!approved) {
            return;
        }

        state.ingredientDeleteId = ingredientId;
        renderIngredientList(Array.isArray(state.batch?.actualIngredients) ? state.batch.actualIngredients : []);

        try {
            const payload = await deleteJson(`${batchUrl}/ingredients/${ingredientId}`);
            const updatedBatch = payload && typeof payload === "object" ? payload.batch : null;

            if (updatedBatch && typeof updatedBatch === "object") {
                state.batch = updatedBatch;
                const actualRows = Array.isArray(updatedBatch.actualIngredients) ? updatedBatch.actualIngredients : [];
                const summaryRows = Array.isArray(updatedBatch.ingredients) ? updatedBatch.ingredients : [];
                renderBatchSummary(updatedBatch);
                renderIngredientList(actualRows);
                renderPlanFact(summaryRows);
                renderBatchEditor(updatedBatch);
                window.AppAuth?.showAlert?.("Компонент удалён", "success");
            } else {
                const didReload = await loadBatchDetails();
                if (didReload) {
                    window.AppAuth?.showAlert?.("Компонент удалён", "success");
                }
            }
        } catch (error) {
            window.AppAuth?.showAlert?.(error.message || "Не удалось удалить компонент", "danger");
        } finally {
            state.ingredientDeleteId = null;
            renderIngredientList(Array.isArray(state.batch?.actualIngredients) ? state.batch.actualIngredients : []);
        }
    }

    async function handleDeleteBatchClick() {
        const currentBatchId = normalizeNullableId(state.batch?.id);
        if (!canWrite || !currentBatchId || state.deleteBatchInFlight || state.stopBatchInFlight) {
            return;
        }

        const approved = window.confirm(`Удалить замес #${currentBatchId}? Это действие нельзя отменить.`);
        if (!approved) {
            return;
        }

        state.deleteBatchInFlight = true;
        updateStopButtonState(state.batch);
        updateDeleteButtonState(state.batch);

        try {
            await deleteJson(batchDeleteUrl);
            window.AppAuth?.showAlert?.(`Замес #${currentBatchId} удалён`, "success");
            window.location.href = buildBackLink();
        } catch (error) {
            window.AppAuth?.showAlert?.(error.message || "Не удалось удалить замес", "danger");
        } finally {
            state.deleteBatchInFlight = false;
            updateStopButtonState(state.batch);
            updateDeleteButtonState(state.batch);
        }
    }

    async function loadLookupOptions() {
        if (!canWrite) {
            return;
        }

        const requestId = ++state.lookupRequestId;
        state.lookupStatus.rations.loading = true;
        state.lookupStatus.groups.loading = true;
        state.lookupStatus.rations.error = "";
        state.lookupStatus.groups.error = "";
        renderBatchEditor(state.batch);

        const [rationsResult, groupsResult] = await Promise.allSettled([
            fetchJson(rationsUrl),
            fetchJson(groupsUrl),
        ]);

        if (requestId !== state.lookupRequestId) {
            return;
        }

        state.lookupStatus.rations.loading = false;
        state.lookupStatus.groups.loading = false;

        if (rationsResult.status === "fulfilled") {
            state.rations = Array.isArray(rationsResult.value) ? rationsResult.value : [];
            state.lookupStatus.rations.loaded = true;
            state.lookupStatus.rations.error = "";
        } else {
            state.rations = [];
            state.lookupStatus.rations.loaded = false;
            state.lookupStatus.rations.error = rationsResult.reason?.message || "Не удалось загрузить рационы";
        }

        if (groupsResult.status === "fulfilled") {
            state.groups = Array.isArray(groupsResult.value) ? groupsResult.value : [];
            state.lookupStatus.groups.loaded = true;
            state.lookupStatus.groups.error = "";
        } else {
            state.groups = [];
            state.lookupStatus.groups.loaded = false;
            state.lookupStatus.groups.error = groupsResult.reason?.message || "Не удалось загрузить группы";
        }

        renderBatchEditor(state.batch);
    }

    async function loadBatchDetails() {
        if (!batchId) {
            setText(detailsTitle, "Замес не найден");
            setText(detailsPageTitle, "Детали замеса");
            state.batchError = "Не указан идентификатор замеса";
            renderBatchEditor(state.batch);
            window.AppAuth?.showAlert?.("Не указан идентификатор замеса", "danger");
            return false;
        }

        const requestId = ++state.loadRequestId;
        state.isBatchLoading = true;
        state.ingredientUpdateId = null;
        state.ingredientDeleteId = null;
        state.batchError = "";
        state.editorMessage = null;
        setLoadingState();
        renderBatchEditor(state.batch);

        try {
            const [batchResult, telemetryResult, zonesResult] = await Promise.allSettled([
                fetchJson(batchUrl),
                fetchJson(telemetryUrl),
                fetchJson(zonesUrl),
            ]);

            if (batchResult.status !== "fulfilled") {
                throw batchResult.reason || new Error("Не удалось загрузить замес");
            }

            if (telemetryResult.status !== "fulfilled") {
                throw telemetryResult.reason || new Error("Не удалось загрузить телеметрию замеса");
            }

            const batch = batchResult.value;
            const telemetryPayload = normalizeTelemetryPayload(telemetryResult.value);
            state.storageZones = zonesResult.status === "fulfilled"
                ? (Array.isArray(zonesResult.value) ? zonesResult.value : []).map(normalizeZone)
                : [];

            if (requestId !== state.loadRequestId) {
                return false;
            }

            const actualRows = Array.isArray(batch?.actualIngredients) ? batch.actualIngredients : [];
            const summaryRows = Array.isArray(batch?.ingredients) ? batch.ingredients : [];

            state.batch = batch;

            renderBatchSummary(batch);
            renderIngredientList(actualRows);
            renderPlanFact(summaryRows);
            renderTelemetry(telemetryPayload.hostTrack);
            await renderBatchTrack(telemetryPayload, actualRows);
            renderBatchEditor(batch);
            return true;
        } catch (error) {
            if (requestId !== state.loadRequestId) {
                return false;
            }

            console.error("Ошибка загрузки деталей замеса:", error);
            state.batchError = error.message || "Не удалось загрузить детали замеса";
            setText(detailsTitle, batchId ? `Замес #${batchId}` : "Замес");
            setText(detailsPageTitle, "Детали замеса");
            window.AppAuth?.showAlert?.(state.batchError, "danger");

            if (ingredientListBody) {
                ingredientListBody.innerHTML = '<tr><td colspan="5" class="batch-detail-empty">Не удалось загрузить данные</td></tr>';
            }

            if (planFactBody) {
                planFactBody.innerHTML = '<tr><td colspan="5" class="dashboard-mini-table-empty">Не удалось загрузить данные</td></tr>';
            }

            renderTelemetry([]);
            await renderBatchTrack([], []);
            renderBatchEditor(state.batch);
            return false;
        } finally {
            if (requestId === state.loadRequestId) {
                state.isBatchLoading = false;
                if (state.batch) {
                    renderIngredientList(Array.isArray(state.batch.actualIngredients) ? state.batch.actualIngredients : []);
                }
                renderBatchEditor(state.batch);
            }
        }
    }

    async function handleBatchEditSubmit() {
        if (!state.batch || state.isSaving) {
            return;
        }

        const payload = {
            rationId: getSelectedNullableId(editRationSelect, state.batch.rationId),
            groupId: getSelectedNullableId(editGroupSelect, state.batch.groupId),
        };

        state.isSaving = true;
        state.editorMessage = {
            tone: "info",
            message: "Сохраняем изменения и пересчитываем замес...",
        };
        renderBatchEditor(state.batch);

        try {
            await patchJson(batchUrl, payload);
            const didReload = await loadBatchDetails();
            if (didReload) {
                window.AppAuth?.showAlert?.("Замес пересчитан", "success");
            }
        } catch (error) {
            const message = error.message || "Не удалось пересчитать замес";
            state.editorMessage = {
                tone: "danger",
                message,
            };
            renderBatchEditor(state.batch);
            window.AppAuth?.showAlert?.(message, "danger");
        } finally {
            state.isSaving = false;
            if (!state.batchError) {
                state.editorMessage = null;
            }
            renderBatchEditor(state.batch);
        }
    }

    if (backLink) {
        backLink.href = buildBackLink();
    }

    if (editRationSelect) {
        editRationSelect.addEventListener("change", function () {
            state.editorMessage = null;
            updateEditButtonState();
        });
    }

    if (editGroupSelect) {
        editGroupSelect.addEventListener("change", function () {
            state.editorMessage = null;
            updateEditButtonState();
        });
    }

    if (editSubmitButton) {
        editSubmitButton.addEventListener("click", handleBatchEditSubmit);
    }

    if (ingredientListBody) {
        ingredientListBody.addEventListener("change", handleIngredientReplacementChange);
        ingredientListBody.addEventListener("click", handleIngredientRenameClick);
        ingredientListBody.addEventListener("click", handleIngredientDeleteClick);
    }

    if (stopButton) {
        stopButton.addEventListener("click", handleStopBatchClick);
    }

    if (deleteButton) {
        deleteButton.addEventListener("click", handleDeleteBatchClick);
    }

    if (canWrite) {
        loadLookupOptions();
    }

    loadBatchDetails();
});

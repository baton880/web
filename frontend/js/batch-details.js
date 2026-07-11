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
    const telemetryZoomControls = document.getElementById("batchTelemetryZoomControls");
    const telemetryZoomMeta = document.getElementById("batchTelemetryZoomMeta");
    const telemetryZoomInButton = document.getElementById("batchTelemetryZoomIn");
    const telemetryZoomOutButton = document.getElementById("batchTelemetryZoomOut");
    const telemetryZoomResetButton = document.getElementById("batchTelemetryZoomReset");
    const telemetryPanLeftButton = document.getElementById("batchTelemetryPanLeft");
    const telemetryPanRightButton = document.getElementById("batchTelemetryPanRight");
    const trackMapElement = document.getElementById("batchTrackMap");
    const trackMapWrap = document.getElementById("batchTrackMapWrap") || trackMapElement?.closest(".batch-track-map-wrap");
    const trackEmpty = document.getElementById("batchTrackEmpty");
    const trackMeta = document.getElementById("batchTrackMeta");
    const trackResetButton = document.getElementById("batchTrackResetButton");
    const trackFullscreenButton = document.getElementById("batchTrackFullscreenButton");
    const replayPanel = document.getElementById("batchReplayPanel");
    const replayPlayButton = document.getElementById("batchReplayPlay");
    const replaySlider = document.getElementById("batchReplaySlider");
    const replayTime = document.getElementById("batchReplayTime");
    const replaySpeed = document.getElementById("batchReplaySpeed");
    const replayStatus = document.getElementById("batchReplayStatus");
    const replayHostZone = document.getElementById("batchReplayHostZone");
    const replayLoaderZone = document.getElementById("batchReplayLoaderZone");
    const replayEffectiveZone = document.getElementById("batchReplayEffectiveZone");
    const replayScoreboard = document.getElementById("batchReplayScoreboard");
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
    const postprocessDebugCard = document.getElementById("batchPostprocessDebugCard");
    const postprocessDebugBody = document.getElementById("batchPostprocessDebugBody");
    const postprocessDebugCollapseButton = document.getElementById("postprocessDebugCollapse");
    const postprocessDebugState = document.getElementById("postprocessDebugState");
    const postprocessDebugSummary = document.getElementById("postprocessDebugSummary");
    const postprocessDebugFilterMeta = document.getElementById("postprocessDebugFilterMeta");
    const postprocessDebugGeneratedAt = document.getElementById("postprocessDebugGeneratedAt");
    const postprocessDebugMainOptions = document.getElementById("postprocessDebugMainOptions");
    const postprocessDebugAdvancedOptions = document.getElementById("postprocessDebugAdvancedOptions");
    const postprocessDebugApplyButton = document.getElementById("postprocessDebugApply");
    const postprocessDebugResetButton = document.getElementById("postprocessDebugReset");
    const postprocessDebugRefreshButton = document.getElementById("postprocessDebugRefresh");
    const postprocessDebugToggles = document.getElementById("postprocessDebugToggles");
    const postprocessDebugHostCanvas = document.getElementById("postprocessDebugHostChart");
    const postprocessDebugHostEmpty = document.getElementById("postprocessDebugHostEmpty");
    const postprocessDebugHostSpeedCanvas = document.getElementById("postprocessDebugHostSpeedChart");
    const postprocessDebugHostSpeedEmpty = document.getElementById("postprocessDebugHostSpeedEmpty");
    const postprocessDebugRtkSpeedCanvas = document.getElementById("postprocessDebugRtkSpeedChart");
    const postprocessDebugRtkSpeedEmpty = document.getElementById("postprocessDebugRtkSpeedEmpty");
    const postprocessDebugEventsBody = document.getElementById("postprocessDebugEventsBody");

    const batchUrl = window.AppAuth?.getApiUrl?.(`/api/batches/${batchId}`) || `/api/batches/${batchId}`;
    const telemetryUrl = window.AppAuth?.getApiUrl?.(`/api/batches/${batchId}/telemetry?includeRtk=true&loaderLookbackSeconds=180&hostLookbackSeconds=180`) || `/api/batches/${batchId}/telemetry?includeRtk=true&loaderLookbackSeconds=180&hostLookbackSeconds=180`;
    const postprocessDebugUrl = window.AppAuth?.getApiUrl?.(`/api/batches/${batchId}/postprocess-debug`) || `/api/batches/${batchId}/postprocess-debug`;
    const batchDeleteUrl = window.AppAuth?.getApiUrl?.(`/api/batches/${batchId}`) || `/api/batches/${batchId}`;
    const stopBatchUrl = window.AppAuth?.getApiUrl?.("/api/telemetry/host/manual-stop") || "/api/telemetry/host/manual-stop";
    const rationsUrl = window.AppAuth?.getApiUrl?.("/api/rations") || "/api/rations";
    const groupsUrl = window.AppAuth?.getApiUrl?.("/api/groups") || "/api/groups";
    const zonesUrl = window.AppAuth?.getApiUrl?.("/api/telemetry/zones") || "/api/telemetry/zones";
    const FARM_TIME_ZONE = "Asia/Novosibirsk";
    const POSTPROCESS_DEBUG_COLLAPSED_STORAGE_KEY = "vikorm:batch-postprocess-debug-collapsed";
    const INGREDIENT_CHART_COLORS = [
        "#4e73df",
        "#1cc88a",
        "#f6c23e",
        "#e74a3b",
        "#36b9cc",
        "#858796",
        "#fd7e14",
        "#6f42c1",
        "#20c997",
        "#2f855a",
    ];
    const POSTPROCESS_DEBUG_FIELDS = [
        { key: "minLoadStepKg", label: "Мин. загрузка, кг", min: 0, max: 500, step: 5, group: "main" },
        { key: "minUnloadStepKg", label: "Мин. выгрузка, кг", min: 0, max: 500, step: 5, group: "main" },
        { key: "stableRadius", label: "Стаб. окно", min: 1, max: 30, step: 1, group: "main" },
        { key: "stableRangeKg", label: "Шум плато, кг", min: 5, max: 150, step: 5, group: "main" },
        { key: "maxLoadTransitionSec", label: "Макс. загрузка, с", min: 5, max: 1000000, step: 5, group: "main" },
        { key: "maxUnloadTransitionSec", label: "Макс. выгрузка, с", min: 5, max: 1000000, step: 5, group: "main" },
        { key: "anchorSec", label: "Плато-якорь, с", min: 5, max: 90, step: 5, group: "main" },
        { key: "weightScale", label: "Калибр. вес", min: 0.1, max: 3, step: 0.001, group: "main" },
        { key: "loadDriftMaxKg", label: "Дрейф + до, кг", min: 5, max: 200, step: 5, group: "main" },
        { key: "loadForceKg", label: "Всегда загрузка, кг", min: 20, max: 500, step: 5, group: "main" },
        { key: "loadMovingSpeedKmh", label: "Загрузка v >", min: 0, max: 15, step: 0.1, group: "main" },
        { key: "loadMovingMaxPct", label: "Ход загрузки, %", min: 0, max: 100, step: 5, group: "main" },
        { key: "speedOffsetSec", label: "Сдвиг скорости host, с", min: -120, max: 120, step: 0.5, group: "main" },
        { key: "maxPlateauSec", label: "Макс. плато, с", min: 0, max: 900, step: 5, group: "advanced" },
        { key: "loadMergeGapSec", label: "Склейка загрузок, с", min: 0, max: 120, step: 1, group: "advanced" },
        { key: "stableMinPoints", label: "Мин. точек плато", min: 2, max: 30, step: 1, group: "advanced" },
        { key: "plateauMergeGapSec", label: "Склейка плато, с", min: 0, max: 120, step: 1, group: "advanced" },
        { key: "samePlateauKg", label: "Порог склейки, кг", min: 0, max: 100, step: 5, group: "advanced" },
        { key: "boundaryMinExtendMs", label: "Расширение, мин", min: 0, max: 20, step: 1, divisor: 60000, group: "advanced" },
        { key: "boundarySpeedKmh", label: "Движение host >", min: 0, max: 5, step: 0.1, group: "advanced" },
        { key: "bounceWindowSec", label: "Отскок окно, с", min: 0, max: 600, step: 5, group: "advanced" },
        { key: "bounceReturnKg", label: "Отскок возврат, кг", min: 0, max: 300, step: 5, group: "advanced" },
        { key: "movementDipKg", label: "Просадка до, кг", min: 0, max: 300, step: 5, group: "advanced" },
        { key: "movementDipSpeedKmh", label: "Просадка v avg", min: 0, max: 15, step: 0.1, group: "advanced" },
        { key: "edgePlateauMinSec", label: "Край плато мин, с", min: 0, max: 120, step: 1, group: "advanced" },
        { key: "edgePlateauMaxSec", label: "Край плато макс, с", min: 0, max: 300, step: 5, group: "advanced" },
        { key: "edgePlateauRangeKg", label: "Край плато шум, кг", min: 0, max: 150, step: 5, group: "advanced" },
        { key: "startSoftWindowMs", label: "Старт мягче, мин", min: 0, max: 15, step: 1, divisor: 60000, group: "advanced" },
        { key: "startSoftMinLoadKg", label: "Старт мин. загр, кг", min: 0, max: 150, step: 5, group: "advanced" },
        { key: "startSoftPlateauMinSec", label: "Старт мин. плато, с", min: 0, max: 120, step: 5, group: "advanced" },
        { key: "startSoftPlateauRangeKg", label: "Старт шум, кг", min: 0, max: 100, step: 5, group: "advanced" },
        { key: "rawCutoffKg", label: "Raw обрыв <, кг", min: -5000, max: 5000, step: 50, group: "advanced" },
        { key: "rawCutoffDropKg", label: "Raw обрыв падение, кг", min: 0, max: 5000, step: 50, group: "advanced" },
        { key: "excludeBounceDips", label: "Не считать дрейф/просадки на ходу", type: "checkbox", group: "advanced" },
    ];
    const POSTPROCESS_DEBUG_TOGGLES = [
        { key: "showFiltered", label: "filtered rawWeight", color: "#2563eb" },
        { key: "showRaw", label: "rawWeight", color: "#dc2626" },
        { key: "showTelemetryWeight", label: "Telemetry.weight", color: "#16a34a" },
        { key: "showPlateaus", label: "плато", color: "#111827" },
        { key: "showEvents", label: "ступеньки", color: "#168a4a" },
        { key: "showIngredients", label: "линии ингредиентов", color: "#64748b" },
    ];

    const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: FARM_TIME_ZONE,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
        timeZone: FARM_TIME_ZONE,
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
        telemetryPayload: null,
        postprocessDebug: null,
        postprocessDebugLoading: false,
        postprocessDebugRequestId: 0,
        postprocessDebugView: {
            showFiltered: true,
            showRaw: false,
            showTelemetryWeight: false,
            showPlateaus: true,
            showEvents: true,
            showIngredients: false,
        },
        telemetryZoom: {
            startIndex: 0,
            endIndex: null,
            total: 0,
        },
        selectedIngredientId: null,
        replayIndex: 0,
        replayPlaying: false,
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
    let postprocessDebugHostChart = null;
    let postprocessDebugHostSpeedChart = null;
    let postprocessDebugRtkSpeedChart = null;
    let batchTrackMap = null;
    let ymapsReadyPromise = null;
    let batchTrackZoneObjects = [];
    let trackMapFitTimer = null;
    let replayTimer = null;
    let batchReplayObjects = [];
    const DEFAULT_ZONE_RADIUS = 20;
    const DEFAULT_SQUARE_SIDE = 40;
    const ZONE_TYPE_BARN = "BARN";
    const TRACK_MAX_GAP_MS = 45000;
    const TRACK_MAX_SPEED_MPS = 12;
    const TRACK_MIN_JUMP_DISTANCE_M = 30;
    const INGREDIENT_TRACK_DEFAULT_LOOKBACK_MS = 3 * 60 * 1000;
    const INGREDIENT_TRACK_AFTER_MS = 15 * 1000;
    const INGREDIENT_TRACK_EDGE_TOLERANCE_MS = 30 * 1000;
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

    function getPostprocessDebugCollapsedPreference() {
        try {
            return window.localStorage.getItem(POSTPROCESS_DEBUG_COLLAPSED_STORAGE_KEY) === "true";
        } catch (_error) {
            return false;
        }
    }

    function setPostprocessDebugCollapsed(collapsed, { persist = true } = {}) {
        if (!canAdmin || !postprocessDebugBody || !postprocessDebugCollapseButton) {
            return;
        }

        postprocessDebugBody.classList.toggle("d-none", collapsed);
        postprocessDebugCollapseButton.setAttribute("aria-expanded", String(!collapsed));
        postprocessDebugCollapseButton.innerHTML = collapsed
            ? '<i class="fas fa-chevron-down mr-1"></i>Развернуть'
            : '<i class="fas fa-chevron-up mr-1"></i>Свернуть';

        if (persist) {
            try {
                window.localStorage.setItem(POSTPROCESS_DEBUG_COLLAPSED_STORAGE_KEY, String(collapsed));
            } catch (_error) {
                // Отладка остаётся рабочей, даже если браузер запретил localStorage.
            }
        }

        if (!collapsed && state.postprocessDebug) {
            window.requestAnimationFrame(() => renderPostprocessDebug());
        }
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

    function getPostprocessStatus(batch) {
        return String(batch?.postprocess?.status || (batch?.endTime ? "complete" : "in_progress")).toLowerCase();
    }

    function isPostprocessProcessing(batch) {
        const status = getPostprocessStatus(batch);
        return status === "processing" || status === "pending";
    }

    function isPostprocessInProgress(batch) {
        return getPostprocessStatus(batch) === "in_progress";
    }

    function renderStatusBadge(label) {
        return `<span class="dashboard-bool-badge is-no">${escapeHtml(label)}</span>`;
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
        setText(endTime, isPostprocessProcessing(batch) ? "Обрабатывается" : (batch?.endTime ? formatDateTime(batch.endTime) : "В процессе"));
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

    function findIngredientDetermination(row) {
        if (!canAdmin) return null;
        const decisions = Array.isArray(state.postprocessDebug?.debug?.ingredients)
            ? state.postprocessDebug.debug.ingredients
            : [];
        const rowStartMs = parseTimestampMs(row?.startTime || row?.startedAt || row?.time);
        if (!Number.isFinite(rowStartMs)) return null;
        return decisions
            .map((item) => ({ item, distance: Math.abs(parseTimestampMs(item?.startedAt) - rowStartMs) }))
            .filter((entry) => Number.isFinite(entry.distance) && entry.distance <= 5000)
            .sort((left, right) => left.distance - right.distance)[0]?.item?.determination || null;
    }

    function getDeterminationSourceLabel(source) {
        return ({
            forced_current_zone: "Принудительно по текущей зоне",
            loader_current_zone: "По текущей зоне погрузчика",
            host_current_zone: "По текущей зоне host",
            loader_scoreboard: "По scoreboard погрузчика",
            confirmed_current_zone: "По подтверждённой зоне",
            unknown: "Контекст не определён",
        })[source] || source || "Неизвестно";
    }

    function renderIngredientDetermination(row) {
        const decision = findIngredientDetermination(row);
        if (!decision) return "";
        const scoreboard = Array.isArray(decision.scoreboard) ? decision.scoreboard : [];
        const scoreboardRows = scoreboard.length
            ? scoreboard.map((candidate) => `
                <tr>
                    <td>${escapeHtml(candidate.ingredient || candidate.name || "—")}</td>
                    <td>${escapeHtml(String(candidate.score ?? "—"))}</td>
                    <td>${escapeHtml(String(candidate.dwellScore ?? "—"))}</td>
                    <td>${escapeHtml(String(candidate.entryScore ?? "—"))}</td>
                    <td>${escapeHtml(String(candidate.squareHeadingScore ?? "—"))}</td>
                </tr>`).join("")
            : '<tr><td colspan="5" class="text-muted">Scoreboard пуст</td></tr>';
        return `
            <span class="ingredient-determination-badge"><i class="fas fa-info-circle"></i> как определён</span>
            <div class="ingredient-determination-popover" role="tooltip">
                <strong>${escapeHtml(getDeterminationSourceLabel(decision.source))}</strong>
                <div>Результат: ${escapeHtml(decision.ingredientName || "Unknown")}</div>
                <div>Effective: ${escapeHtml(decision.effectivePositionSource || "host")}</div>
                <div>Активная зона: ${escapeHtml(decision.activeZone?.name || "—")}</div>
                ${Number.isFinite(Number(decision.currentZoneEvidenceAgeMs))
                    ? `<div>Возраст RTK: ${escapeHtml((Number(decision.currentZoneEvidenceAgeMs) / 1000).toFixed(1))} с</div>`
                    : ""}
                <div>Время: ${escapeHtml(formatDateTime(decision.timestamp))}</div>
                <table><thead><tr><th>Кандидат</th><th>Score</th><th>Dwell</th><th>Въезд</th><th>Heading</th></tr></thead><tbody>${scoreboardRows}</tbody></table>
            </div>`;
    }

    function renderIngredientList(rows) {
        if (!ingredientListBody) {
            return;
        }

        if (isPostprocessProcessing(state.batch)) {
            ingredientListBody.innerHTML = '<tr><td colspan="5" class="batch-detail-empty">Обрабатывается postprocess по rawWeight</td></tr>';
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

        ingredientListBody.innerHTML = rows.map((row) => {
            const ingredientId = normalizeNullableId(row?.id);
            const isSelected = ingredientId !== null && ingredientId === state.selectedIngredientId;

            return `
            <tr
                class="batch-ingredient-row${isSelected ? " batch-ingredient-row--selected" : ""}"
                data-role="ingredient-track-row"
                data-ingredient-id="${ingredientId === null ? "" : ingredientId}"
                tabindex="0"
            >
                <td>${escapeHtml(formatTime(row?.startTime || row?.time))}</td>
                <td class="batch-ingredient-component-cell">${renderIngredientCell(row, hasRation, hasReplacementOptions, replacementOptions)}${renderIngredientDetermination(row)}</td>
                <td>${escapeHtml(formatWeight(row?.fact ?? row?.actualWeight))}</td>
                <td>${renderIngredientViolationCell(row, componentViolationByKey, seenComponentViolationBadge)}</td>
                <td class="text-center">${renderIngredientActionsCell(row)}</td>
            </tr>
        `;
        }).join("");
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
        if (isPostprocessProcessing(state.batch)) {
            return renderStatusBadge("Обрабатывается");
        }

        if (isPostprocessInProgress(state.batch)) {
            return renderStatusBadge("В процессе");
        }

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

        if (isPostprocessProcessing(state.batch)) {
            planFactBody.innerHTML = '<tr><td colspan="5" class="dashboard-mini-table-empty">Обрабатывается postprocess по rawWeight</td></tr>';
            setText(planTotal, "--");
            setText(factTotal, "Обрабатывается");
            setText(deviationTotal, "--");
            return;
        }

        if (isPostprocessInProgress(state.batch)) {
            planFactBody.innerHTML = '<tr><td colspan="5" class="dashboard-mini-table-empty">Замес в процессе</td></tr>';
            setText(planTotal, "--");
            setText(factTotal, "В процессе");
            setText(deviationTotal, "--");
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
                    isViolation: component?.isViolation ?? component?.is_violation ?? row?.isViolation ?? row?.is_violation,
                    is_violation: component?.is_violation ?? component?.isViolation ?? row?.is_violation ?? row?.isViolation
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

    function resetTelemetryZoom(total = 0) {
        state.telemetryZoom = {
            startIndex: 0,
            endIndex: Math.max(0, Number(total) - 1),
            total: Math.max(0, Number(total) || 0),
        };
    }

    function normalizeTelemetryZoom(total) {
        const count = Math.max(0, Number(total) || 0);
        if (!canAdmin || count <= 0) {
            resetTelemetryZoom(count);
            return state.telemetryZoom;
        }

        const current = state.telemetryZoom || {};
        const fallbackEnd = count - 1;
        let startIndex = Number.isInteger(current.startIndex) ? current.startIndex : 0;
        let endIndex = Number.isInteger(current.endIndex) ? current.endIndex : fallbackEnd;

        startIndex = Math.max(0, Math.min(startIndex, fallbackEnd));
        endIndex = Math.max(startIndex, Math.min(endIndex, fallbackEnd));

        state.telemetryZoom = { startIndex, endIndex, total: count };
        return state.telemetryZoom;
    }

    function getTelemetryZoomRows(rows) {
        const zoom = normalizeTelemetryZoom(rows.length);
        return rows.slice(zoom.startIndex, zoom.endIndex + 1);
    }

    function getTelemetryZoomWindowSize() {
        const zoom = state.telemetryZoom || {};
        return Math.max(1, (zoom.endIndex ?? 0) - (zoom.startIndex ?? 0) + 1);
    }

    function setTelemetryZoomWindow(startIndex, windowSize) {
        const total = state.telemetryZoom?.total || 0;
        if (!canAdmin || total <= 0) {
            return;
        }

        const size = Math.max(8, Math.min(Math.round(windowSize), total));
        const start = Math.max(0, Math.min(Math.round(startIndex), total - size));
        state.telemetryZoom = {
            startIndex: start,
            endIndex: start + size - 1,
            total,
        };
        renderTelemetry(state.telemetryPayload?.hostTrack || []);
    }

    function updateTelemetryZoomControls(sourceRows, visibleRows) {
        if (!telemetryZoomControls) {
            return;
        }

        const total = Array.isArray(sourceRows) ? sourceRows.length : 0;
        const canZoom = canAdmin && total > 8;
        telemetryZoomControls.classList.toggle("d-none", !canZoom);
        telemetryZoomControls.hidden = !canZoom;

        if (!canZoom) {
            return;
        }

        const zoom = normalizeTelemetryZoom(total);
        const isFull = zoom.startIndex === 0 && zoom.endIndex >= total - 1;
        const visibleCount = Array.isArray(visibleRows) ? visibleRows.length : 0;
        const firstPoint = visibleRows?.[0];
        const lastPoint = visibleRows?.[visibleRows.length - 1];

        if (telemetryZoomMeta) {
            const timeLabel = firstPoint && lastPoint
                ? `${formatTime(firstPoint.timestamp)} - ${formatTime(lastPoint.timestamp)}`
                : "Весь график";
            telemetryZoomMeta.textContent = isFull
                ? `Весь график, ${total} точек`
                : `${zoom.startIndex + 1}-${zoom.endIndex + 1} из ${total} точек, ${timeLabel}`;
        }

        if (telemetryZoomInButton) telemetryZoomInButton.disabled = visibleCount <= 8;
        if (telemetryZoomOutButton) telemetryZoomOutButton.disabled = isFull;
        if (telemetryZoomResetButton) telemetryZoomResetButton.disabled = isFull;
        if (telemetryPanLeftButton) telemetryPanLeftButton.disabled = zoom.startIndex <= 0;
        if (telemetryPanRightButton) telemetryPanRightButton.disabled = zoom.endIndex >= total - 1;
    }

    function zoomTelemetryChart(factor) {
        const zoom = normalizeTelemetryZoom(state.telemetryZoom?.total || 0);
        const currentSize = getTelemetryZoomWindowSize();
        const nextSize = Math.max(8, Math.min(zoom.total, Math.round(currentSize * factor)));
        const center = (zoom.startIndex + zoom.endIndex) / 2;
        setTelemetryZoomWindow(Math.round(center - nextSize / 2), nextSize);
    }

    function panTelemetryChart(direction) {
        const zoom = normalizeTelemetryZoom(state.telemetryZoom?.total || 0);
        const size = getTelemetryZoomWindowSize();
        const step = Math.max(1, Math.round(size * 0.35));
        setTelemetryZoomWindow(zoom.startIndex + direction * step, size);
    }

    function normalizeTrackPoints(points) {
        return (Array.isArray(points) ? points : [])
            .map((point) => ({
                id: point?.id == null ? null : Number(point.id),
                lat: Number(point?.lat),
                lon: Number(point?.lon),
                timestamp: point?.timestamp || null,
                receivedAtMs: parseTimestampMs(point?.receivedAt),
                weight: point?.weight == null ? null : Number(point.weight),
                weightValid: point?.weightValid,
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
            .sort((left, right) => {
                const timestampDiff = left.timestampMs - right.timestampMs;
                if (timestampDiff !== 0) return timestampDiff;

                const leftInvalidWeight = left.weightValid === false || left.weightValid === 0;
                const rightInvalidWeight = right.weightValid === false || right.weightValid === 0;
                if (leftInvalidWeight !== rightInvalidWeight) {
                    return leftInvalidWeight ? 1 : -1;
                }

                const receivedDiff = (left.receivedAtMs ?? 0) - (right.receivedAtMs ?? 0);
                if (receivedDiff !== 0) return receivedDiff;

                return Number(left.id || 0) - Number(right.id || 0);
            });
    }

    function normalizeTelemetryPayload(payload) {
        if (Array.isArray(payload)) {
            return {
                hostTrack: payload,
                hostContextTrack: payload,
                loaderTrack: [],
                events: [],
                plateaus: [],
                postprocessIngredients: [],
                postprocess: null,
                meta: null,
            };
        }

        return {
            hostTrack: Array.isArray(payload?.hostTrack) ? payload.hostTrack : [],
            hostContextTrack: Array.isArray(payload?.hostContextTrack) ? payload.hostContextTrack : [],
            loaderTrack: Array.isArray(payload?.loaderTrack) ? payload.loaderTrack : [],
            events: Array.isArray(payload?.events) ? payload.events : [],
            plateaus: Array.isArray(payload?.plateaus) ? payload.plateaus : [],
            postprocessIngredients: Array.isArray(payload?.postprocessIngredients)
                ? payload.postprocessIngredients
                : (Array.isArray(payload?.ingredients) ? payload.ingredients : []),
            postprocess: payload?.postprocess || payload?.meta?.postprocess || null,
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

    function resolveIngredientMapSegment(row, fallbackTrackPoints) {
        const startLat = Number(row?.startLat);
        const startLon = Number(row?.startLon);
        const endLat = Number(row?.endLat);
        const endLon = Number(row?.endLon);
        const hasStoredStart = hasValidCoordinates(startLat, startLon);
        const hasStoredEnd = hasValidCoordinates(endLat, endLon);

        if (hasStoredStart || hasStoredEnd) {
            return {
                startPoint: hasStoredStart ? {
                    lat: startLat,
                    lon: startLon,
                    timestamp: row?.startTime || row?.time || null,
                } : null,
                endPoint: hasStoredEnd ? {
                    lat: endLat,
                    lon: endLon,
                    timestamp: row?.endTime || row?.time || null,
                } : null,
                source: "stored",
            };
        }

        const ingredientTimestampMs = parseTimestampMs(row?.time);
        const closest = findClosestTrackPointByTime(ingredientTimestampMs, fallbackTrackPoints);
        if (!closest?.point || closest.deltaMs > (2 * 60 * 1000)) {
            return null;
        }

        return {
            startPoint: closest.point,
            endPoint: null,
            source: "fallback",
        };
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

    function scheduleBatchTrackMapFit() {
        window.clearTimeout(trackMapFitTimer);
        trackMapFitTimer = window.setTimeout(() => {
            if (batchTrackMap?.container && typeof batchTrackMap.container.fitToViewport === "function") {
                batchTrackMap.container.fitToViewport();
            }
        }, 160);
    }

    function isBatchTrackFullscreen() {
        return Boolean(trackMapWrap?.classList.contains("batch-track-map-wrap--fullscreen"));
    }

    function syncBatchTrackFullscreenButton() {
        if (!trackFullscreenButton) {
            return;
        }

        const isFullscreen = isBatchTrackFullscreen();
        const icon = trackFullscreenButton.querySelector("i");
        const label = trackFullscreenButton.querySelector("span");
        trackFullscreenButton.classList.toggle("is-active", isFullscreen);
        trackFullscreenButton.setAttribute("aria-pressed", String(isFullscreen));
        trackFullscreenButton.setAttribute(
            "title",
            isFullscreen ? "Закрыть полноэкранную карту" : "Открыть карту на весь экран"
        );

        if (icon) {
            icon.className = isFullscreen ? "fas fa-times mr-1" : "fas fa-expand-arrows-alt mr-1";
        }
        if (label) {
            label.textContent = isFullscreen ? "Закрыть" : "На весь экран";
        }
    }

    function setBatchTrackFullscreen(nextState) {
        if (!trackMapWrap) {
            return;
        }

        trackMapWrap.classList.toggle("batch-track-map-wrap--fullscreen", Boolean(nextState));
        document.body.classList.toggle("batch-track-map-fullscreen", Boolean(nextState));
        syncBatchTrackFullscreenButton();
        scheduleBatchTrackMapFit();
    }

    function handleBatchTrackFullscreenClick() {
        setBatchTrackFullscreen(!isBatchTrackFullscreen());
    }

    function handleBatchTrackFullscreenKeydown(event) {
        if (event.key === "Escape" && isBatchTrackFullscreen()) {
            setBatchTrackFullscreen(false);
        }
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
                        points: currentSegment.slice(),
                        dashed: false,
                    });
                }

                segments.push({
                    coords: [
                        [previousPoint.lat, previousPoint.lon],
                        [point.lat, point.lon],
                    ],
                    points: [previousPoint, point],
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
                points: currentSegment.slice(),
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
                points: [previousPoint, currentPoint],
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
            if (typeof options.pointBalloonContent === "function" && Array.isArray(segment.points) && segment.points.length) {
                polyline.events.add("click", (event) => {
                    const coords = event.get("coords");
                    const closestPoint = findClosestTrackPointByCoords(coords, segment.points);
                    if (!closestPoint) {
                        return;
                    }
                    polyline.properties.set("balloonContent", options.pointBalloonContent(closestPoint));
                    polyline.balloon.open(coords || [closestPoint.lat, closestPoint.lon]);
                });
            }
            return polyline;
        });
    }

    function findClosestTrackPointByCoords(coords, points) {
        if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(points) || !points.length) {
            return null;
        }

        const lat = Number(coords[0]);
        const lon = Number(coords[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return null;
        }

        let bestPoint = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        points.forEach((point) => {
            const pointLat = Number(point?.lat);
            const pointLon = Number(point?.lon);
            if (!Number.isFinite(pointLat) || !Number.isFinite(pointLon)) {
                return;
            }
            const latDelta = pointLat - lat;
            const lonDelta = pointLon - lon;
            const distance = latDelta * latDelta + lonDelta * lonDelta;
            if (distance < bestDistance) {
                bestDistance = distance;
                bestPoint = point;
            }
        });

        return bestPoint;
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
            pointBalloonContent: formatPointDetails,
            strokeColor: color,
            strokeWidth: options.strokeWidth || 4,
            strokeOpacity: options.strokeOpacity || 0.9,
        }));

        const firstPoint = trackPoints[0];
        const lastPoint = trackPoints[trackPoints.length - 1];
        function formatPointDetails(point) {
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
        }

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

    function findSelectedIngredientRow(rows) {
        const selectedId = normalizeNullableId(state.selectedIngredientId);
        if (selectedId === null) {
            return null;
        }

        return (Array.isArray(rows) ? rows : []).find((row) => normalizeNullableId(row?.id) === selectedId) || null;
    }

    function buildIngredientTrackWindow(row, rows, options = {}) {
        const ingredientId = normalizeNullableId(row?.id);
        const requireId = options.requireId !== false;
        const endTimestampMs = parseTimestampMs(row?.endTime || row?.time || row?.addedAt);
        if ((requireId && ingredientId === null) || !Number.isFinite(endTimestampMs)) {
            return null;
        }

        const storedStartTimestampMs = parseTimestampMs(row?.startTime || row?.startedAt);
        let startTimestampMs = Number.isFinite(storedStartTimestampMs) && storedStartTimestampMs < endTimestampMs
            ? storedStartTimestampMs
            : null;

        if (!Number.isFinite(startTimestampMs) || startTimestampMs >= endTimestampMs - 1000) {
            startTimestampMs = endTimestampMs - INGREDIENT_TRACK_DEFAULT_LOOKBACK_MS;
        }

        return {
            startMs: startTimestampMs,
            endMs: endTimestampMs + INGREDIENT_TRACK_AFTER_MS,
            ingredientEndMs: endTimestampMs,
        };
    }

    function sliceTrackPointsByWindow(trackPoints, windowRange) {
        if (!windowRange || !Array.isArray(trackPoints) || !trackPoints.length) {
            return [];
        }

        const inside = trackPoints.filter((point) =>
            point.timestampMs >= windowRange.startMs &&
            point.timestampMs <= windowRange.endMs
        );
        const before = [...trackPoints]
            .reverse()
            .find((point) =>
                point.timestampMs < windowRange.startMs &&
                windowRange.startMs - point.timestampMs <= INGREDIENT_TRACK_EDGE_TOLERANCE_MS
            );
        const after = trackPoints.find((point) =>
            point.timestampMs > windowRange.endMs &&
            point.timestampMs - windowRange.endMs <= INGREDIENT_TRACK_EDGE_TOLERANCE_MS
        );

        const byKey = new Map();
        [before, ...inside, after].filter(Boolean).forEach((point) => {
            byKey.set(`${point.timestampMs}:${point.lat}:${point.lon}:${point.deviceId || ""}`, point);
        });

        return [...byKey.values()].sort((left, right) => left.timestampMs - right.timestampMs);
    }

    async function renderBatchTrack(trackPayload, ingredientRows) {
        if (!trackMapElement) {
            return;
        }

        const normalizedPayload = normalizeTelemetryPayload(trackPayload);
        const hostTrackPoints = normalizeTrackPoints(normalizedPayload.hostTrack);
        const hostContextTrackPoints = normalizeTrackPoints(normalizedPayload.hostContextTrack);
        const loaderTrackPoints = normalizeTrackPoints(normalizedPayload.loaderTrack);
        const rows = Array.isArray(ingredientRows) ? ingredientRows : [];
        const selectedIngredientRow = findSelectedIngredientRow(rows);
        const selectedTrackWindow = selectedIngredientRow
            ? buildIngredientTrackWindow(selectedIngredientRow, rows)
            : null;
        const visibleHostTrackPoints = selectedTrackWindow
            ? sliceTrackPointsByWindow(hostContextTrackPoints.length ? hostContextTrackPoints : hostTrackPoints, selectedTrackWindow)
            : hostTrackPoints;
        const visibleLoaderTrackPoints = selectedTrackWindow
            ? sliceTrackPointsByWindow(loaderTrackPoints, selectedTrackWindow)
            : loaderTrackPoints;
        const allTrackPoints = [...visibleHostTrackPoints, ...visibleLoaderTrackPoints]
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
            batchReplayObjects = [];
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
                    selectedIngredientRow
                        ? `Нет координат для выбранного ковша: ${getIngredientDisplayName(selectedIngredientRow?.name)} ${formatWeight(selectedIngredientRow?.fact ?? selectedIngredientRow?.actualWeight)}`
                        : activeZonesCount > 0
                        ? `Нет координат трека. Показаны активные зоны: ${activeZonesCount}`
                        : "Нет координат в телеметрии этого замеса"
                );
            }
            if (trackEmpty) {
                if (activeZonesCount > 0 && !selectedIngredientRow) {
                    trackEmpty.classList.add("d-none");
                } else {
                    trackEmpty.classList.remove("d-none");
                }
            }
            if (trackResetButton) {
                trackResetButton.classList.toggle("d-none", !selectedIngredientRow);
            }
            return;
        }

        map.geoObjects.removeAll();
        batchReplayObjects = [];
        renderBatchTrackZones(map, state.storageZones);
        if (trackEmpty) {
            trackEmpty.classList.add("d-none");
        }
        if (map.container && typeof map.container.fitToViewport === "function") {
            map.container.fitToViewport();
        }

        drawTrackLayer(map, visibleHostTrackPoints, {
            title: "Хозяин / кормораздатчик",
            color: HOST_TRACK_COLOR,
            strokeWidth: 4,
            startPreset: "islands#blueCircleDotIcon",
            endPreset: "islands#darkBlueCircleDotIcon",
        });
        drawTrackLayer(map, visibleLoaderTrackPoints, {
            title: "Погрузчик",
            kind: "rtk",
            color: RTK_GPS_FIX_COLOR,
            strokeWidth: 5,
            startPreset: "islands#greenCircleDotIcon",
            endPreset: "islands#redCircleDotIcon",
        });

        const markerRows = selectedIngredientRow ? [selectedIngredientRow] : rows;
        let linkedIngredients = 0;
        const ingredientTrackPoints = selectedIngredientRow
            ? (visibleHostTrackPoints.length ? visibleHostTrackPoints : visibleLoaderTrackPoints)
            : (loaderTrackPoints.length ? loaderTrackPoints : hostTrackPoints);

        markerRows.forEach((row) => {
            const segment = resolveIngredientMapSegment(row, ingredientTrackPoints);
            const startPoint = segment?.startPoint || null;
            const endPoint = segment?.endPoint || null;
            const anchorPoint = startPoint || endPoint;
            if (!anchorPoint) {
                return;
            }

            linkedIngredients += 1;

            const startTimeLabel = formatDateTime(row?.startTime || row?.time);
            const endTimeLabel = formatDateTime(row?.endTime || row?.time);
            const startCoordsLabel = startPoint
                ? `${startPoint.lat.toFixed(5)}, ${startPoint.lon.toFixed(5)}`
                : "-";
            const endCoordsLabel = endPoint
                ? `${endPoint.lat.toFixed(5)}, ${endPoint.lon.toFixed(5)}`
                : startCoordsLabel;

            const marker = new window.ymaps.Placemark(
                [anchorPoint.lat, anchorPoint.lon],
                {
                    hintContent: `${getIngredientDisplayName(row?.name)} (${formatTime(row?.time)})`,
                    balloonContent: `
                        <strong>${escapeHtml(getIngredientDisplayName(row?.name))}</strong><br>
                        Начало загрузки: ${escapeHtml(startTimeLabel)}<br>
                        Конец загрузки: ${escapeHtml(endTimeLabel)}<br>
                        Факт: ${escapeHtml(formatWeight(row?.fact ?? row?.actualWeight))}<br>
                        Старт: ${escapeHtml(startCoordsLabel)}<br>
                        Финиш: ${escapeHtml(endCoordsLabel)}
                    `,
                },
                {
                    preset: "islands#blueCircleDotIcon",
                }
            );

            map.geoObjects.add(marker);

            if (startPoint && endPoint) {
                const isSamePoint = Math.abs(startPoint.lat - endPoint.lat) < 1e-6
                    && Math.abs(startPoint.lon - endPoint.lon) < 1e-6;

                if (!isSamePoint) {
                    const segmentLine = new window.ymaps.Polyline(
                        [
                            [startPoint.lat, startPoint.lon],
                            [endPoint.lat, endPoint.lon],
                        ],
                        {
                            hintContent: `${getIngredientDisplayName(row?.name)}: участок загрузки`,
                        },
                        {
                            strokeColor: "#3c6df0",
                            strokeWidth: 3,
                            strokeOpacity: 0.65,
                            strokeStyle: "dash",
                        }
                    );
                    map.geoObjects.add(segmentLine);
                }
            }
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
            if (selectedIngredientRow) {
                const ingredientName = getIngredientDisplayName(selectedIngredientRow?.name) || "Компонент";
                setText(
                    trackMeta,
                    `${ingredientName}: ${formatWeight(selectedIngredientRow?.fact ?? selectedIngredientRow?.actualWeight)} • Хозяин: ${visibleHostTrackPoints.length} точек • Погрузчик: ${visibleLoaderTrackPoints.length} точек • ${startLabel} — ${endLabel}`
                );
            } else {
                setText(
                    trackMeta,
                    `Хозяин: ${hostTrackPoints.length} точек • Погрузчик: ${loaderTrackPoints.length} точек • ${linkedIngredients} меток компонентов • ${startLabel} — ${endLabel}`
                );
            }
        }

        if (trackResetButton) {
            trackResetButton.classList.toggle("d-none", !selectedIngredientRow);
        }
        if (canAdmin && getReplayFrames().length) {
            renderReplayFrame(state.replayIndex);
        }
    }

    function getFiniteNumber(value) {
        if (value === null || value === undefined || value === "") {
            return null;
        }
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }

    function getReplayFrames() {
        return Array.isArray(state.postprocessDebug?.debug?.replayFrames)
            ? state.postprocessDebug.debug.replayFrames
            : [];
    }

    function clearReplayMapObjects() {
        if (!batchTrackMap) return;
        batchReplayObjects.forEach((object) => batchTrackMap.geoObjects.remove(object));
        batchReplayObjects = [];
    }

    function replayZoneLabel(point) {
        return point?.zone?.name || "вне зоны";
    }

    function renderReplayScoreboard(rows) {
        if (!replayScoreboard) return;
        const candidates = Array.isArray(rows) ? rows : [];
        replayScoreboard.innerHTML = candidates.length
            ? candidates.map((candidate) => `
                <tr>
                    <td>${escapeHtml(candidate.ingredient || candidate.name || "—")}</td>
                    <td>${escapeHtml(String(candidate.score ?? "—"))}</td>
                    <td>${escapeHtml(String(candidate.dwellScore ?? "—"))}</td>
                    <td>${escapeHtml(String(candidate.entryScore ?? "—"))}</td>
                    <td>${escapeHtml(String(candidate.squareHeadingScore ?? "—"))}</td>
                    <td>${escapeHtml(String(candidate.samples ?? "—"))}</td>
                </tr>`).join("")
            : '<tr><td colspan="6" class="text-muted">Нет кандидатов</td></tr>';
    }

    function renderReplayFrame(index = state.replayIndex) {
        if (!canAdmin) return;
        const frames = getReplayFrames();
        if (!frames.length) {
            if (replayPanel) replayPanel.classList.add("d-none");
            return;
        }
        if (replayPanel) replayPanel.classList.remove("d-none");
        const safeIndex = Math.max(0, Math.min(Number(index) || 0, frames.length - 1));
        state.replayIndex = safeIndex;
        const frame = frames[safeIndex];
        if (replaySlider) {
            replaySlider.max = String(frames.length - 1);
            replaySlider.value = String(safeIndex);
        }
        setText(replayTime, formatTime(frame.timestamp));
        setText(replayHostZone, replayZoneLabel(frame.host));
        setText(replayLoaderZone, frame.loader ? replayZoneLabel(frame.loader) : "нет RTK");
        setText(replayEffectiveZone, `${frame.effective?.source || "host"}: ${replayZoneLabel(frame.effective)}`);
        setText(replayStatus, `Кадр ${safeIndex + 1} / ${frames.length} · host ${formatDebugSpeed(frame.filteredSpeedKmh)}`);
        renderReplayScoreboard(frame.scoreboard);

        if (!batchTrackMap || !window.ymaps) return;
        clearReplayMapObjects();
        const markerSpecs = [
            { point: frame.host, title: "Host", preset: "islands#blueCircleDotIcon" },
            { point: frame.loader, title: "Погрузчик", preset: "islands#redCircleDotIcon" },
        ];
        markerSpecs.forEach(({ point, title, preset }) => {
            const lat = Number(point?.lat);
            const lon = Number(point?.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const marker = new window.ymaps.Placemark([lat, lon], {
                hintContent: `${title}: ${formatTime(frame.timestamp)}`,
                balloonContent: `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(formatDateTime(frame.timestamp))}<br>Зона: ${escapeHtml(replayZoneLabel(point))}`,
            }, { preset });
            batchTrackMap.geoObjects.add(marker);
            batchReplayObjects.push(marker);
        });
    }

    function stopReplay() {
        state.replayPlaying = false;
        window.clearInterval(replayTimer);
        replayTimer = null;
        if (replayPlayButton) {
            replayPlayButton.setAttribute("aria-pressed", "false");
            replayPlayButton.innerHTML = '<i class="fas fa-play mr-1"></i><span>Пуск</span>';
        }
    }

    function startReplay() {
        const frames = getReplayFrames();
        if (!frames.length) return;
        if (state.replayIndex >= frames.length - 1) state.replayIndex = 0;
        state.replayPlaying = true;
        if (replayPlayButton) {
            replayPlayButton.setAttribute("aria-pressed", "true");
            replayPlayButton.innerHTML = '<i class="fas fa-pause mr-1"></i><span>Пауза</span>';
        }
        window.clearInterval(replayTimer);
        replayTimer = window.setInterval(() => {
            const step = Math.max(1, Number(replaySpeed?.value || 5));
            const nextIndex = Math.min(state.replayIndex + step, frames.length - 1);
            renderReplayFrame(nextIndex);
            if (nextIndex >= frames.length - 1) stopReplay();
        }, 250);
    }

    function initializeReplay() {
        stopReplay();
        state.replayIndex = 0;
        renderReplayFrame(0);
    }

    function formatDebugWeight(value) {
        const numeric = getFiniteNumber(value);
        return numeric === null ? "—" : `${weightFormatter.format(numeric)} кг`;
    }

    function formatDebugSignedWeight(value) {
        const numeric = getFiniteNumber(value);
        if (numeric === null) return "—";
        return `${numeric > 0 ? "+" : ""}${weightFormatter.format(numeric)} кг`;
    }

    function formatDebugDuration(value) {
        const milliseconds = getFiniteNumber(value);
        return milliseconds === null ? "—" : weightFormatter.format(Math.round(milliseconds / 1000));
    }

    function formatDebugPercent(value) {
        const numeric = getFiniteNumber(value);
        return numeric === null ? "—" : `${weightFormatter.format(Math.round(numeric))}%`;
    }

    function formatDebugSpeed(value) {
        const numeric = getFiniteNumber(value);
        return numeric === null ? "—" : `${numeric.toFixed(1)} км/ч`;
    }

    function getPostprocessDebugFieldInput(field) {
        return document.getElementById(`postprocessDebugOption-${field.key}`);
    }

    function renderPostprocessDebugFields() {
        if (!postprocessDebugMainOptions || !postprocessDebugAdvancedOptions) {
            return;
        }

        const renderField = (field) => {
            const inputId = `postprocessDebugOption-${field.key}`;
            if (field.type === "checkbox") {
                return `
                    <div class="col-xl-3 col-lg-4 col-md-6 postprocess-debug-option postprocess-debug-option--switch">
                        <div class="custom-control custom-switch">
                            <input id="${inputId}" class="custom-control-input" type="checkbox" data-postprocess-debug-option="${field.key}">
                            <label class="custom-control-label" for="${inputId}">${escapeHtml(field.label)}</label>
                        </div>
                    </div>
                `;
            }

            return `
                <div class="col-xl-3 col-lg-4 col-md-6 postprocess-debug-option">
                    <label for="${inputId}">${escapeHtml(field.label)}</label>
                    <input id="${inputId}" class="form-control" type="number" min="${field.min}" max="${field.max}" step="${field.step}" data-postprocess-debug-option="${field.key}">
                </div>
            `;
        };

        postprocessDebugMainOptions.innerHTML = POSTPROCESS_DEBUG_FIELDS
            .filter((field) => field.group === "main")
            .map(renderField)
            .join("");
        postprocessDebugAdvancedOptions.innerHTML = POSTPROCESS_DEBUG_FIELDS
            .filter((field) => field.group === "advanced")
            .map(renderField)
            .join("");
    }

    function syncPostprocessDebugFields(options) {
        const source = options && typeof options === "object" ? options : {};

        POSTPROCESS_DEBUG_FIELDS.forEach((field) => {
            const input = getPostprocessDebugFieldInput(field);
            if (!input || source[field.key] === undefined || source[field.key] === null) {
                return;
            }

            if (field.type === "checkbox") {
                input.checked = asBoolean(source[field.key]);
                return;
            }

            const numeric = getFiniteNumber(source[field.key]);
            if (numeric === null) {
                return;
            }

            input.value = String(field.divisor ? numeric / field.divisor : numeric);
        });
    }

    function collectPostprocessDebugOptions() {
        return POSTPROCESS_DEBUG_FIELDS.reduce((result, field) => {
            const input = getPostprocessDebugFieldInput(field);
            if (!input) {
                return result;
            }

            if (field.type === "checkbox") {
                result[field.key] = input.checked;
                return result;
            }

            const numeric = getFiniteNumber(input.value);
            if (numeric !== null) {
                result[field.key] = field.divisor ? numeric * field.divisor : numeric;
            }
            return result;
        }, {});
    }

    function setPostprocessDebugState(message, tone = "info") {
        if (!postprocessDebugState) {
            return;
        }

        postprocessDebugState.textContent = message || "";
        postprocessDebugState.classList.remove("d-none", "postprocess-debug-state--info", "postprocess-debug-state--danger");
        if (!message) {
            postprocessDebugState.classList.add("d-none");
            return;
        }

        postprocessDebugState.classList.add(tone === "danger" ? "postprocess-debug-state--danger" : "postprocess-debug-state--info");
    }

    function setPostprocessDebugControlsDisabled(disabled) {
        if (postprocessDebugCard) {
            postprocessDebugCard.querySelectorAll("button, input").forEach((element) => {
                element.disabled = Boolean(disabled);
            });
        }
    }

    function buildPostprocessDebugRequestUrl(options = {}) {
        const url = new URL(postprocessDebugUrl, window.location.href);
        url.searchParams.set("loaderLookbackSeconds", "180");

        Object.entries(options).forEach(([key, value]) => {
            if (value === undefined || value === null || value === "") {
                return;
            }
            url.searchParams.set(key, String(value));
        });

        return url.toString();
    }

    function renderPostprocessDebugToggles() {
        if (!postprocessDebugToggles) {
            return;
        }

        postprocessDebugToggles.innerHTML = POSTPROCESS_DEBUG_TOGGLES.map((toggle) => `
            <label class="postprocess-debug-toggle">
                <input type="checkbox" data-postprocess-debug-toggle="${toggle.key}" ${state.postprocessDebugView[toggle.key] ? "checked" : ""}>
                <span class="postprocess-debug-toggle__swatch" style="background:${toggle.color}"></span>
                ${escapeHtml(toggle.label)}
            </label>
        `).join("");
    }

    function renderPostprocessDebugSummary(debug) {
        if (!postprocessDebugSummary) {
            return;
        }

        const summary = debug?.summary || {};
        const metrics = [
            ["Загружено ступеньками", formatDebugWeight(summary.loaded)],
            ["Выгружено ступеньками", formatDebugWeight(summary.unloaded)],
            ["Загрузка − выгрузка", formatDebugSignedWeight(summary.net)],
            ["Конец − старт графика", formatDebugSignedWeight(summary.observedNet)],
            ["Ступенек зачтено", String(Number(summary.eventCount || 0))],
            ["Размах графика", formatDebugWeight(summary.range)],
        ];

        postprocessDebugSummary.innerHTML = metrics.map(([label, value]) => `
            <div class="col-xl-2 col-lg-3 col-md-4 col-sm-6">
                <div class="postprocess-debug-kpi">
                    <div class="postprocess-debug-kpi__label">${escapeHtml(label)}</div>
                    <div class="postprocess-debug-kpi__value">${escapeHtml(value)}</div>
                </div>
            </div>
        `).join("");
    }

    function getPostprocessArtifactLabel(event) {
        if (!event?.artifact) {
            return event?.kind === "load" ? "загрузка" : "выгрузка";
        }

        const labels = {
            "moving-load-percent": "ход%?",
            "moving-load-drift": "дрейф?",
            "moving-dip": "просадка?",
            rebound: "отскок?",
            "before-first-load": "до загрузки?",
            "after-last-unload": "после выгрузки?",
            "small-load-after-unload": "мелк. после выгрузки?",
            "small-load-before-unload": "мелк. перед выгрузкой?",
        };

        return labels[event.artifactReason] || "исключено?";
    }

    function renderPostprocessDebugEvents(events) {
        if (!postprocessDebugEventsBody) {
            return;
        }

        const rows = Array.isArray(events) ? events : [];
        if (!rows.length) {
            postprocessDebugEventsBody.innerHTML = '<tr><td colspan="10" class="batch-detail-empty">Ступеньки не определились</td></tr>';
            return;
        }

        postprocessDebugEventsBody.innerHTML = rows.map((event) => {
            const type = `${getPostprocessArtifactLabel(event)}${Number(event?.mergedCount || 1) > 1 ? ` ×${Number(event.mergedCount)}` : ""}${event?.edgeTrimmed ? " · trim" : ""}`;
            const rowClass = event?.artifact ? "is-artifact" : "";
            return `
                <tr class="${rowClass}">
                    <td>${escapeHtml(event?.id ?? "—")}</td>
                    <td>${escapeHtml(type)}</td>
                    <td>${escapeHtml(`${formatTime(event?.startTime)} — ${formatTime(event?.endTime)}`)}</td>
                    <td class="text-right">${escapeHtml(formatDebugSignedWeight(event?.delta))}</td>
                    <td class="text-right">${escapeHtml(formatDebugWeight(event?.beforeLevel))}</td>
                    <td class="text-right">${escapeHtml(formatDebugWeight(event?.afterLevel))}</td>
                    <td class="text-right">${escapeHtml(formatDebugDuration(event?.transitionMs))}</td>
                    <td class="text-right">${escapeHtml(formatDebugPercent(event?.movingPct))}</td>
                    <td class="text-right">${escapeHtml(formatDebugSpeed(event?.speedAvg))}</td>
                    <td class="text-right">${escapeHtml(formatDebugSpeed(event?.speedMax))}</td>
                </tr>
            `;
        }).join("");
    }

    function destroyPostprocessDebugCharts() {
        if (postprocessDebugHostChart) {
            postprocessDebugHostChart.destroy();
            postprocessDebugHostChart = null;
        }
        if (postprocessDebugHostSpeedChart) {
            postprocessDebugHostSpeedChart.destroy();
            postprocessDebugHostSpeedChart = null;
        }
        if (postprocessDebugRtkSpeedChart) {
            postprocessDebugRtkSpeedChart.destroy();
            postprocessDebugRtkSpeedChart = null;
        }
    }

    function getClosestDebugPointIndex(points, value) {
        const target = parseTimestampMs(value);
        if (!Number.isFinite(target) || !Array.isArray(points) || !points.length) {
            return null;
        }

        let closestIndex = 0;
        let closestDistance = Number.POSITIVE_INFINITY;
        points.forEach((point, index) => {
            const timestamp = parseTimestampMs(point?.timestamp);
            const distance = Number.isFinite(timestamp) ? Math.abs(timestamp - target) : Number.POSITIVE_INFINITY;
            if (distance < closestDistance) {
                closestDistance = distance;
                closestIndex = index;
            }
        });
        return closestIndex;
    }

    function buildPostprocessDebugOverlayPlugin(points, events, bounds, options = {}) {
        const rows = Array.isArray(points) ? points : [];
        const debugEvents = Array.isArray(events) ? events : [];
        const debugBounds = bounds && typeof bounds === "object" ? bounds : null;
        const showEventLabels = options.showEventLabels !== false;

        const getX = (scale, value) => {
            const index = getClosestDebugPointIndex(rows, value);
            return index === null ? null : (scale.getPixelForTick ? scale.getPixelForTick(index) : scale.getPixelForValue(null, index));
        };

        return {
            beforeDatasetsDraw: function (chart) {
                const xScale = chart.scales?.["x-axis-0"];
                const chartArea = chart.chartArea;
                const context = chart.chart?.ctx;
                if (!xScale || !chartArea || !context) {
                    return;
                }

                context.save();
                if (debugBounds) {
                    const start = getX(xScale, debugBounds.startTime);
                    const end = getX(xScale, debugBounds.endTime);
                    if (start !== null && end !== null) {
                        context.fillStyle = "rgba(100, 116, 139, 0.05)";
                        context.fillRect(Math.min(start, end), chartArea.top, Math.max(1, Math.abs(end - start)), chartArea.bottom - chartArea.top);
                    }
                }

                if (!state.postprocessDebugView.showEvents) {
                    context.restore();
                    return;
                }

                debugEvents.forEach((event) => {
                    const start = getX(xScale, event?.startTime);
                    const end = getX(xScale, event?.endTime);
                    if (start === null || end === null) {
                        return;
                    }
                    const left = Math.min(start, end);
                    const width = Math.max(3, Math.abs(end - start));
                    context.fillStyle = event?.artifact
                        ? "rgba(124, 135, 151, 0.13)"
                        : event?.kind === "load"
                            ? "rgba(22, 138, 74, 0.14)"
                            : "rgba(220, 38, 38, 0.13)";
                    context.fillRect(left, chartArea.top, width, chartArea.bottom - chartArea.top);
                });
                context.restore();
            },
            afterDatasetsDraw: function (chart) {
                if (!state.postprocessDebugView.showEvents || !showEventLabels) {
                    return;
                }

                const xScale = chart.scales?.["x-axis-0"];
                const yScale = chart.scales?.["y-axis-0"];
                const chartArea = chart.chartArea;
                const context = chart.chart?.ctx;
                if (!xScale || !yScale || !chartArea || !context) {
                    return;
                }

                context.save();
                debugEvents.forEach((event, index) => {
                    const start = getX(xScale, event?.startTime);
                    const end = getX(xScale, event?.endTime);
                    if (start === null || end === null) {
                        return;
                    }

                    const color = event?.artifact ? "#7c8797" : event?.kind === "load" ? "#168a4a" : "#dc2626";
                    const center = (start + end) / 2;
                    context.strokeStyle = color;
                    context.lineWidth = event?.artifact ? 1 : 1.5;
                    context.setLineDash(event?.artifact ? [4, 4] : []);
                    context.beginPath();
                    context.moveTo(center, chartArea.top);
                    context.lineTo(center, chartArea.bottom);
                    context.stroke();
                    context.setLineDash([]);

                    const beforeLevel = getFiniteNumber(event?.beforeLevel);
                    const afterLevel = getFiniteNumber(event?.afterLevel);
                    if (beforeLevel !== null && afterLevel !== null) {
                        context.beginPath();
                        context.moveTo(getX(xScale, event?.beforePlateauStartTime) ?? start, yScale.getPixelForValue(beforeLevel));
                        context.lineTo(getX(xScale, event?.beforePlateauEndTime) ?? start, yScale.getPixelForValue(beforeLevel));
                        context.moveTo(getX(xScale, event?.afterPlateauStartTime) ?? end, yScale.getPixelForValue(afterLevel));
                        context.lineTo(getX(xScale, event?.afterPlateauEndTime) ?? end, yScale.getPixelForValue(afterLevel));
                        context.stroke();

                        const label = formatDebugSignedWeight(event?.delta);
                        const labelX = Math.max(chartArea.left + 3, Math.min(chartArea.right - 60, center - 24));
                        const labelY = Math.max(chartArea.top + 13, Math.min(chartArea.bottom - 4, yScale.getPixelForValue(afterLevel) - 8 - (index % 3) * 14));
                        context.fillStyle = color;
                        context.font = event?.artifact ? "11px Arial" : "bold 12px Arial";
                        context.fillText(label, labelX, labelY);
                    }
                });
                context.restore();
            },
        };
    }

    function buildPostprocessDebugTimeline(hostPoints, rtkPoints) {
        const byTimestamp = new Map();
        const ensure = (timestamp) => {
            const milliseconds = parseTimestampMs(timestamp);
            if (!Number.isFinite(milliseconds)) return null;
            if (!byTimestamp.has(milliseconds)) {
                byTimestamp.set(milliseconds, { timestamp: milliseconds, hostPoint: null, hostSpeedPoint: null, rtkPoint: null });
            }
            return byTimestamp.get(milliseconds);
        };

        (Array.isArray(hostPoints) ? hostPoints : []).forEach((point) => {
            const row = ensure(point?.timestamp);
            if (row) row.hostPoint = point;
            const speedRow = ensure(point?.speedTimestamp || point?.timestamp);
            if (speedRow) speedRow.hostSpeedPoint = point;
        });
        (Array.isArray(rtkPoints) ? rtkPoints : []).forEach((point) => {
            const row = ensure(point?.timestamp);
            if (row) row.rtkPoint = point;
        });

        return Array.from(byTimestamp.values()).sort((left, right) => left.timestamp - right.timestamp);
    }

    function buildPostprocessDebugContinuousDatasets({ timeline, label, valueForRow, color, backgroundColor = "transparent", borderWidth = 1.5, fill = false }) {
        const segments = [];
        let currentSegment = null;
        let previousPointTime = null;

        timeline.forEach((row, index) => {
            const value = getFiniteNumber(valueForRow(row));
            if (value === null) {
                return;
            }

            if (
                !currentSegment ||
                (previousPointTime !== null && row.timestamp - previousPointTime > TRACK_MAX_GAP_MS)
            ) {
                currentSegment = new Map();
                segments.push(currentSegment);
            }

            currentSegment.set(index, value);
            previousPointTime = row.timestamp;
        });

        return segments.map((segment, segmentIndex) => ({
            label,
            data: timeline.map((_, index) => segment.has(index) ? segment.get(index) : null),
            borderColor: color,
            backgroundColor,
            borderWidth,
            pointRadius: 0,
            pointHoverRadius: 3,
            fill,
            spanGaps: true,
            lineTension: 0.12,
            order: segmentIndex,
        }));
    }

    function buildPostprocessDebugSparseDatasets({ timeline, label, valueForRow, xValueForRow = (_row, index) => index, color, backgroundColor = "transparent", borderWidth = 1.5, fill = false }) {
        const segments = [];
        let currentSegment = null;
        let previousPointTime = null;

        timeline.forEach((row, index) => {
            const value = getFiniteNumber(valueForRow(row));
            if (value === null) {
                return;
            }

            if (
                !currentSegment ||
                (previousPointTime !== null && row.timestamp - previousPointTime > TRACK_MAX_GAP_MS)
            ) {
                currentSegment = { points: [], timestamps: [] };
                segments.push(currentSegment);
            }

            currentSegment.points.push({ x: xValueForRow(row, index), y: value });
            currentSegment.timestamps.push(row.timestamp);
            previousPointTime = row.timestamp;
        });

        return segments.map((segment, segmentIndex) => ({
            label,
            data: segment.points,
            tooltipTimestamps: segment.timestamps,
            borderColor: color,
            backgroundColor,
            borderWidth,
            pointRadius: 0,
            pointHoverRadius: 3,
            fill,
            spanGaps: false,
            lineTension: 0.12,
            order: segmentIndex,
        }));
    }

    function buildPostprocessDebugComponentDatasets(timeline, ingredientRows) {
        const ingredients = (Array.isArray(ingredientRows) ? ingredientRows : [])
            .map((row, index) => {
                const windowRange = buildIngredientTrackWindow(row, ingredientRows, { requireId: false });
                if (!windowRange) return null;
                return {
                    name: getIngredientDisplayName(row?.ingredientName || row?.name),
                    startMs: windowRange.startMs,
                    endMs: windowRange.ingredientEndMs || windowRange.endMs,
                    actualWeight: getFiniteNumber(row?.actualWeight ?? row?.fact),
                    color: INGREDIENT_CHART_COLORS[index % INGREDIENT_CHART_COLORS.length],
                };
            })
            .filter(Boolean);

        return ingredients.map((ingredient) => ({
            label: ingredient.name,
            ingredientName: ingredient.name,
            componentStartMs: ingredient.startMs,
            componentEndMs: ingredient.endMs,
            actualWeight: ingredient.actualWeight,
            backgroundColor: ingredient.color,
            borderColor: "rgba(0, 0, 0, 0)",
            borderWidth: 0,
            showLine: false,
            pointRadius: 0,
            pointHoverRadius: 0,
            pointHitRadius: 18,
            fill: false,
            spanGaps: true,
            order: 0,
            data: timeline.map((row) => {
                if (!row.hostPoint || row.timestamp < ingredient.startMs || row.timestamp > ingredient.endMs) {
                    return null;
                }
                return getFiniteNumber(row.hostPoint.filteredWeight ?? row.hostPoint.weight);
            }),
        })).filter((dataset) => dataset.data.some((value) => value !== null));
    }

    function renderPostprocessDebugHostChart(timeline) {
        if (!postprocessDebugHostCanvas || !postprocessDebugHostEmpty) {
            return;
        }

        const debug = state.postprocessDebug?.debug;
        if (!timeline.length || !timeline.some((row) => row.hostPoint)) {
            if (postprocessDebugHostChart) {
                postprocessDebugHostChart.destroy();
                postprocessDebugHostChart = null;
            }
            postprocessDebugHostCanvas.classList.add("d-none");
            postprocessDebugHostEmpty.classList.remove("d-none");
            return;
        }

        postprocessDebugHostCanvas.classList.remove("d-none");
        postprocessDebugHostEmpty.classList.add("d-none");
        if (postprocessDebugHostChart) {
            postprocessDebugHostChart.destroy();
            postprocessDebugHostChart = null;
        }

        const timelinePoints = timeline.map((row) => ({
            ...(row.hostPoint || {}),
            timestamp: new Date(row.timestamp).toISOString(),
            weight: row.hostPoint ? getFiniteNumber(row.hostPoint.filteredWeight ?? row.hostPoint.weight) : null,
        }));
        const view = state.postprocessDebugView;
        const datasets = [];
        if (view.showRaw) {
            datasets.push(...buildPostprocessDebugContinuousDatasets({
                label: "rawWeight",
                timeline,
                valueForRow: (row) => row.hostPoint?.rawWeight,
                color: "#dc2626",
                borderWidth: 1,
            }));
        }
        if (view.showTelemetryWeight) {
            datasets.push(...buildPostprocessDebugContinuousDatasets({
                label: "Telemetry.weight",
                timeline,
                valueForRow: (row) => row.hostPoint?.telemetryWeight,
                color: "#16a34a",
                borderWidth: 1,
            }));
        }
        if (view.showFiltered) {
            datasets.push(...buildPostprocessDebugContinuousDatasets({
                label: "filtered rawWeight",
                timeline,
                valueForRow: (row) => row.hostPoint?.filteredWeight ?? row.hostPoint?.weight,
                color: "#2563eb",
                backgroundColor: "rgba(37, 99, 235, 0.1)",
                borderWidth: 2,
                fill: true,
            }));
        }
        if (view.showPlateaus) {
            const plateauDataset = buildPlateauTelemetryDataset(timelinePoints, debug?.plateaus);
            if (plateauDataset) {
                plateauDataset.label = "Плато";
                datasets.push(plateauDataset);
            }
        }
        if (view.showIngredients) {
            datasets.push(...buildPostprocessDebugComponentDatasets(timeline, state.batch?.actualIngredients || []));
        }

        postprocessDebugHostChart = new Chart(postprocessDebugHostCanvas.getContext("2d"), {
            type: "line",
            data: {
                labels: timeline.map((row) => formatTime(row.timestamp)),
                datasets,
            },
            plugins: [
                buildPostprocessDebugOverlayPlugin(timelinePoints, debug?.events, debug?.bounds),
                buildComponentZonePlugin(),
            ],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                legend: { display: false },
                tooltips: {
                    mode: "nearest",
                    intersect: false,
                    callbacks: {
                        label: function (tooltipItem, data) {
                            const dataset = data.datasets?.[tooltipItem.datasetIndex] || {};
                            if (dataset.isPlateauDataset) return `Плато: ${weightFormatter.format(tooltipItem.yLabel)} кг`;
                            if (dataset.ingredientName) return `${dataset.ingredientName}: ${weightFormatter.format(dataset.actualWeight)} кг`;
                            return `${dataset.label || "Вес"}: ${weightFormatter.format(tooltipItem.yLabel)} кг`;
                        },
                    },
                },
                scales: {
                    xAxes: [{ gridLines: { display: false }, ticks: { maxTicksLimit: 8 } }],
                    yAxes: [{ ticks: { callback: (value) => `${weightFormatter.format(value)} кг` } }],
                },
            },
        });
    }

    function renderPostprocessDebugSpeedChart({ canvas, empty, previousChart, timeline, debug, label, color, valueForRow }) {
        if (!canvas || !empty) {
            return null;
        }

        if (previousChart) {
            previousChart.destroy();
        }

        const values = timeline.map(valueForRow);
        if (!values.some((value) => value !== null)) {
            canvas.classList.add("d-none");
            empty.classList.remove("d-none");
            return null;
        }

        canvas.classList.remove("d-none");
        empty.classList.add("d-none");
        const timelinePoints = timeline.map((row) => ({ timestamp: new Date(row.timestamp).toISOString() }));
        const timelineLabels = timeline.map((row) => new Date(row.timestamp).toISOString());
        return new Chart(canvas.getContext("2d"), {
            type: "line",
            data: {
                labels: timelineLabels,
                datasets: buildPostprocessDebugSparseDatasets({
                    timeline,
                    label,
                    valueForRow,
                    xValueForRow: (row) => new Date(row.timestamp).toISOString(),
                    color,
                    backgroundColor: `${color}14`,
                    borderWidth: 1.8,
                }),
            },
            plugins: [buildPostprocessDebugOverlayPlugin(timelinePoints, debug?.events, debug?.bounds, { showEventLabels: false })],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                legend: { display: false },
                tooltips: {
                    mode: "nearest",
                    intersect: false,
                    callbacks: {
                        title: function (tooltipItems, data) {
                            const item = tooltipItems?.[0];
                            const dataset = data.datasets?.[item?.datasetIndex] || {};
                            const timestamp = dataset.tooltipTimestamps?.[item?.index];
                            return timestamp ? formatTime(timestamp) : "";
                        },
                    },
                },
                scales: {
                    xAxes: [{
                        gridLines: { display: false },
                        ticks: {
                            maxTicksLimit: 8,
                            callback: (value) => formatTime(value),
                        },
                    }],
                    yAxes: [{ ticks: { beginAtZero: true, callback: (value) => `${weightFormatter.format(value)} км/ч` } }],
                },
            },
        });
    }

    function renderPostprocessDebugSpeedCharts(timeline, debug) {
        postprocessDebugHostSpeedChart = renderPostprocessDebugSpeedChart({
            canvas: postprocessDebugHostSpeedCanvas,
            empty: postprocessDebugHostSpeedEmpty,
            previousChart: postprocessDebugHostSpeedChart,
            timeline,
            debug,
            label: `Скорость host · Hampel r${debug?.speedFilter?.hampelRadius ?? 32}, σ${debug?.speedFilter?.hampelSigma ?? 10} → median r${debug?.speedFilter?.rollingMedianRadius ?? 6}`,
            color: "#6f42c1",
            valueForRow: (row) => getFiniteNumber(row.hostSpeedPoint?.speedKmh),
        });
        postprocessDebugRtkSpeedChart = renderPostprocessDebugSpeedChart({
            canvas: postprocessDebugRtkSpeedCanvas,
            empty: postprocessDebugRtkSpeedEmpty,
            previousChart: postprocessDebugRtkSpeedChart,
            timeline,
            debug,
            label: "Скорость RTK",
            color: "#f59e0b",
            valueForRow: (row) => getFiniteNumber(row.rtkPoint?.speed),
        });
    }

    function renderPostprocessDebug() {
        if (!canAdmin || !postprocessDebugCard) {
            return;
        }

        const payload = state.postprocessDebug;
        const debug = payload?.debug;
        if (!debug) {
            renderPostprocessDebugSummary(null);
            renderPostprocessDebugEvents([]);
            destroyPostprocessDebugCharts();
            return;
        }

        const filter = debug.filter || {};
        const speedFilter = debug.speedFilter || {};
        if (postprocessDebugFilterMeta) {
            postprocessDebugFilterMeta.textContent = `Вес: rawWeight → Hampel r${filter.hampelRadius ?? "—"}, σ${filter.hampelSigma ?? "—"} → median r${filter.rollingMedianRadius ?? "—"} → ${filter.roundToKg ?? "—"} кг · Скорость host: Hampel r${speedFilter.hampelRadius ?? "—"}, σ${speedFilter.hampelSigma ?? "—"} → median r${speedFilter.rollingMedianRadius ?? "—"}`;
        }
        if (postprocessDebugGeneratedAt) {
            postprocessDebugGeneratedAt.textContent = debug.generatedAt ? `Обновлено: ${formatDateTime(debug.generatedAt)}` : "";
        }

        renderPostprocessDebugSummary(debug);
        renderPostprocessDebugEvents(debug.events);
        const timeline = buildPostprocessDebugTimeline(debug.points, payload?.rtkTrack);
        renderPostprocessDebugHostChart(timeline);
        renderPostprocessDebugSpeedCharts(timeline, debug);
    }

    async function loadPostprocessDebug(useFormOptions = false) {
        if (!canAdmin || !batchId || state.postprocessDebugLoading) {
            return;
        }

        const requestId = ++state.postprocessDebugRequestId;
        state.postprocessDebugLoading = true;
        setPostprocessDebugControlsDisabled(true);
        setPostprocessDebugState("Считаем отладочный предпросмотр без сохранения…");

        try {
            const options = useFormOptions ? collectPostprocessDebugOptions() : {};
            const payload = await fetchJson(buildPostprocessDebugRequestUrl(options));
            if (requestId !== state.postprocessDebugRequestId) {
                return;
            }

            state.postprocessDebug = payload;
            syncPostprocessDebugFields(payload?.debug?.options);
            setPostprocessDebugState("", "info");
            renderPostprocessDebug();
            initializeReplay();
            renderIngredientList(Array.isArray(state.batch?.actualIngredients) ? state.batch.actualIngredients : []);
        } catch (error) {
            if (requestId !== state.postprocessDebugRequestId) {
                return;
            }
            setPostprocessDebugState(error?.message || "Не удалось получить отладку постпроцессинга", "danger");
        } finally {
            if (requestId === state.postprocessDebugRequestId) {
                state.postprocessDebugLoading = false;
                setPostprocessDebugControlsDisabled(false);
            }
        }
    }

    function renderTelemetry(points) {
        if (!telemetryCanvas || !telemetryEmpty) {
            return;
        }

        const rows = Array.isArray(points) ? points : [];
        const actualRows = Array.isArray(state.batch?.actualIngredients) ? state.batch.actualIngredients : [];
        const chartIngredientRows = actualRows.length
            ? actualRows
            : (Array.isArray(state.telemetryPayload?.postprocessIngredients) ? state.telemetryPayload.postprocessIngredients : []);

        if (!rows.length) {
            destroyTelemetryChart();
            telemetryCanvas.classList.add("d-none");
            telemetryEmpty.classList.remove("d-none");
            updateTelemetryZoomControls([], []);
            return;
        }

        telemetryCanvas.classList.remove("d-none");
        telemetryEmpty.classList.add("d-none");
        destroyTelemetryChart();

        normalizeTelemetryZoom(rows.length);
        const visibleRows = canAdmin ? getTelemetryZoomRows(rows) : rows;
        updateTelemetryZoomControls(rows, visibleRows);

        const componentDatasets = buildComponentTelemetryDatasets(visibleRows, chartIngredientRows);
        const plateauDataset = canAdmin
            ? buildPlateauTelemetryDataset(visibleRows, state.telemetryPayload?.plateaus)
            : null;
        const componentZonePlugin = buildComponentZonePlugin();
        const isInvalidWeightPoint = (point) =>
            point?.invalidWeight === true || point?.weightValid === false || point?.weightValid === 0;
        const context = telemetryCanvas.getContext("2d");
        telemetryChart = new Chart(context, {
            type: "line",
            data: {
                labels: visibleRows.map((point) => formatTime(point?.timestamp)),
                datasets: [
                    {
                        label: "Вес, кг",
                        data: visibleRows.map((point) => isInvalidWeightPoint(point) ? null : toNumber(point?.weight)),
                        borderColor: "#4e73df",
                        backgroundColor: "rgba(78, 115, 223, 0.12)",
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        lineTension: 0.18,
                        fill: true,
                        order: 1,
                    },
                    {
                        label: "weightValid=false",
                        invalidWeightDataset: true,
                        data: visibleRows.map((point) => isInvalidWeightPoint(point) ? 0 : null),
                        borderColor: "#e74a3b",
                        backgroundColor: "rgba(231, 74, 59, 0.14)",
                        borderWidth: 2,
                        pointRadius: visibleRows.map((point) => isInvalidWeightPoint(point) ? 2 : 0),
                        pointHoverRadius: 5,
                        lineTension: 0,
                        fill: false,
                        spanGaps: false,
                        order: 1,
                    },
                    ...(plateauDataset ? [plateauDataset] : []),
                    ...componentDatasets,
                ],
            },
            plugins: [componentZonePlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                legend: {
                    display: false,
                },
                tooltips: {
                    mode: "nearest",
                    intersect: false,
                    callbacks: {
                        label: function (tooltipItem, data) {
                            const dataset = data.datasets?.[tooltipItem.datasetIndex] || {};
                            if (dataset.invalidWeightDataset) {
                                return "weightValid=false";
                            }
                            if (dataset.isPlateauDataset) {
                                return `Плато: ${weightFormatter.format(tooltipItem.yLabel)} кг`;
                            }

                            if (dataset.ingredientName) {
                                const startLabel = dataset.componentStartMs ? formatTime(new Date(dataset.componentStartMs)) : "";
                                const endLabel = dataset.componentEndMs ? formatTime(new Date(dataset.componentEndMs)) : "";
                                const windowLabel = startLabel && endLabel ? ` (${startLabel} - ${endLabel})` : "";
                                const actualWeight = Number(dataset.actualWeight);
                                const weightLabel = Number.isFinite(actualWeight)
                                    ? weightFormatter.format(actualWeight)
                                    : weightFormatter.format(tooltipItem.yLabel);
                                return `${dataset.ingredientName}${windowLabel}: ${weightLabel} \u043a\u0433`;
                            }

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

    function buildPlateauTelemetryDataset(points, plateaus) {
        const rows = Array.isArray(points) ? points : [];
        const plateauRows = (Array.isArray(plateaus) ? plateaus : [])
            .map((plateau) => ({
                startMs: parseTimestampMs(plateau?.startTime),
                endMs: parseTimestampMs(plateau?.endTime),
                level: Number(plateau?.level),
            }))
            .filter((plateau) =>
                Number.isFinite(plateau.startMs) &&
                Number.isFinite(plateau.endMs) &&
                plateau.endMs >= plateau.startMs &&
                Number.isFinite(plateau.level)
            );

        if (!rows.length || !plateauRows.length) {
            return null;
        }

        const data = rows.map((point) => {
            const timestampMs = parseTimestampMs(point?.timestamp);
            if (!Number.isFinite(timestampMs)) {
                return null;
            }

            const plateau = plateauRows.find((item) => timestampMs >= item.startMs && timestampMs <= item.endMs);
            return plateau ? plateau.level : null;
        });

        if (!data.some((value) => value !== null)) {
            return null;
        }

        return {
            label: "Плато",
            isPlateauDataset: true,
            data,
            borderColor: "#111827",
            backgroundColor: "rgba(17, 24, 39, 0.08)",
            borderWidth: 2,
            borderDash: [6, 4],
            pointRadius: 0,
            pointHoverRadius: 3,
            lineTension: 0,
            steppedLine: true,
            fill: false,
            spanGaps: false,
            order: 2,
        };
    }

    function buildComponentTelemetryDatasets(points, ingredientRows) {
        const rows = Array.isArray(points) ? points : [];
        const ingredients = (Array.isArray(ingredientRows) ? ingredientRows : [])
            .map((row, index) => {
                const windowRange = buildIngredientTrackWindow(row, ingredientRows, { requireId: false });
                if (!windowRange) {
                    return null;
                }

                return {
                    name: getIngredientDisplayName(row?.ingredientName || row?.name),
                    startMs: windowRange.startMs,
                    endMs: windowRange.ingredientEndMs || windowRange.endMs,
                    actualWeight: toNumber(row?.actualWeight ?? row?.fact),
                    color: INGREDIENT_CHART_COLORS[index % INGREDIENT_CHART_COLORS.length],
                };
            })
            .filter(Boolean);

        if (!rows.length || !ingredients.length) {
            return [];
        }

        return ingredients
            .map((ingredient) => {
                const startIndex = findNearestTelemetryIndex(rows, ingredient.startMs);
                const endIndex = findNearestTelemetryIndex(rows, ingredient.endMs);
                if (startIndex === null || endIndex === null || endIndex < startIndex) {
                    return null;
                }

                return {
                label: ingredient.name,
                ingredientName: ingredient.name,
                componentStartMs: ingredient.startMs,
                componentEndMs: ingredient.endMs,
                componentStartIndex: startIndex,
                componentEndIndex: endIndex,
                actualWeight: ingredient.actualWeight,
                data: rows.map((point) => {
                    const timestampMs = parseTimestampMs(point?.timestamp);
                    if (!Number.isFinite(timestampMs) || timestampMs < ingredient.startMs || timestampMs > ingredient.endMs) {
                        return null;
                    }

                    return toNumber(point?.weight);
                }),
                backgroundColor: ingredient.color,
                borderColor: "rgba(0, 0, 0, 0)",
                borderWidth: 0,
                showLine: false,
                pointRadius: 0,
                pointHoverRadius: 0,
                pointHitRadius: 18,
                lineTension: 0.18,
                fill: false,
                spanGaps: false,
                order: 0,
                };
            })
            .filter(Boolean)
            .filter((dataset) => dataset.data.some((value) => value !== null));
    }

    function findNearestTelemetryIndex(rows, targetMs) {
        if (!Array.isArray(rows) || !rows.length || !Number.isFinite(targetMs)) {
            return null;
        }

        let bestIndex = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        rows.forEach((point, index) => {
            const timestampMs = parseTimestampMs(point?.timestamp);
            if (!Number.isFinite(timestampMs)) {
                return;
            }

            const distance = Math.abs(timestampMs - targetMs);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = index;
            }
        });

        return bestIndex;
    }

    function buildComponentZonePlugin() {
        return {
            beforeDatasetsDraw: function (chart) {
                const xScale = chart.scales?.["x-axis-0"];
                const chartArea = chart.chartArea;
                const context = chart.chart?.ctx;
                const datasets = chart.data?.datasets || [];

                if (!xScale || !chartArea || !context) {
                    return;
                }

                datasets.forEach((dataset) => {
                    if (!dataset?.ingredientName || !Array.isArray(dataset.data)) {
                        return;
                    }

                    const ranges = getDatasetValueRanges(dataset.data);
                    context.save();
                    context.fillStyle = toRgba(dataset.backgroundColor || dataset.borderColor, 0.18);

                    ranges.forEach((range) => {
                        const bounds = getCategoryRangeBounds(xScale, range.start, range.end, dataset.data.length);
                        context.fillRect(
                            bounds.left,
                            chartArea.top,
                            Math.max(bounds.right - bounds.left, 1),
                            chartArea.bottom - chartArea.top
                        );
                    });

                    context.restore();
                });
            },
        };
    }

    function getDatasetValueRanges(values) {
        const ranges = [];
        let currentRange = null;

        values.forEach((value, index) => {
            if (value === null || value === undefined || Number.isNaN(Number(value))) {
                if (currentRange) {
                    ranges.push(currentRange);
                    currentRange = null;
                }
                return;
            }

            if (!currentRange) {
                currentRange = { start: index, end: index };
            } else {
                currentRange.end = index;
            }
        });

        if (currentRange) {
            ranges.push(currentRange);
        }

        return ranges;
    }

    function getCategoryRangeBounds(xScale, startIndex, endIndex, count) {
        const centerAt = (index) => xScale.getPixelForTick
            ? xScale.getPixelForTick(index)
            : xScale.getPixelForValue(null, index);
        const startCenter = centerAt(startIndex);
        const endCenter = centerAt(endIndex);
        const prevCenter = startIndex > 0 ? centerAt(startIndex - 1) : startCenter;
        const nextCenter = endIndex < count - 1 ? centerAt(endIndex + 1) : endCenter;
        const leftPadding = startIndex > 0 ? (startCenter - prevCenter) / 2 : 0;
        const rightPadding = endIndex < count - 1 ? (nextCenter - endCenter) / 2 : leftPadding;

        return {
            left: startCenter - Math.max(leftPadding, 0),
            right: endCenter + Math.max(rightPadding, 0),
        };
    }

    function toRgba(color, alpha) {
        const text = String(color || "").trim();
        const hexMatch = text.match(/^#([0-9a-f]{6})$/i);

        if (hexMatch) {
            const value = Number.parseInt(hexMatch[1], 16);
            const red = (value >> 16) & 255;
            const green = (value >> 8) & 255;
            const blue = value & 255;
            return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
        }

        return text.startsWith("rgba(") || text.startsWith("rgb(")
            ? text
            : `rgba(78, 115, 223, ${alpha})`;
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

    function shouldIgnoreIngredientTrackClick(target) {
        return Boolean(target?.closest?.("button, select, input, textarea, a, label, [data-role='ingredient-replacement'], [data-role='ingredient-rename'], [data-role='ingredient-delete']"));
    }

    async function refreshTrackSelection() {
        const actualRows = Array.isArray(state.batch?.actualIngredients) ? state.batch.actualIngredients : [];
        const selectedId = normalizeNullableId(state.selectedIngredientId);

        if (selectedId !== null && !actualRows.some((row) => normalizeNullableId(row?.id) === selectedId)) {
            state.selectedIngredientId = null;
        }

        renderIngredientList(actualRows);
        await renderBatchTrack(state.telemetryPayload || { hostTrack: [], loaderTrack: [] }, actualRows);
    }

    async function selectIngredientTrack(ingredientId) {
        const normalizedIngredientId = normalizeNullableId(ingredientId);
        if (normalizedIngredientId === null || state.isBatchLoading) {
            return;
        }

        state.selectedIngredientId = state.selectedIngredientId === normalizedIngredientId
            ? null
            : normalizedIngredientId;

        try {
            await refreshTrackSelection();
        } catch (error) {
            console.error("Ошибка отображения трека ковша:", error);
        }
    }

    function handleIngredientTrackRowClick(event) {
        if (shouldIgnoreIngredientTrackClick(event.target)) {
            return;
        }

        const row = event.target?.closest?.("[data-role='ingredient-track-row']");
        if (!row) {
            return;
        }

        selectIngredientTrack(row.dataset.ingredientId);
    }

    function handleIngredientTrackRowKeydown(event) {
        if (event.key !== "Enter" && event.key !== " ") {
            return;
        }

        if (shouldIgnoreIngredientTrackClick(event.target)) {
            return;
        }

        const row = event.target?.closest?.("[data-role='ingredient-track-row']");
        if (!row) {
            return;
        }

        event.preventDefault();
        selectIngredientTrack(row.dataset.ingredientId);
    }

    async function handleTrackResetClick() {
        state.selectedIngredientId = null;
        try {
            await refreshTrackSelection();
        } catch (error) {
            console.error("Ошибка сброса фильтра трека:", error);
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
            if (batch && telemetryPayload.postprocess && !batch.postprocess) {
                batch.postprocess = telemetryPayload.postprocess;
            }
            state.storageZones = zonesResult.status === "fulfilled"
                ? (Array.isArray(zonesResult.value) ? zonesResult.value : []).map(normalizeZone)
                : [];

            if (requestId !== state.loadRequestId) {
                return false;
            }

            const actualRows = Array.isArray(batch?.actualIngredients) ? batch.actualIngredients : [];
            const summaryRows = Array.isArray(batch?.ingredients) ? batch.ingredients : [];

            state.batch = batch;
            state.telemetryPayload = telemetryPayload;
            resetTelemetryZoom(Array.isArray(telemetryPayload.hostTrack) ? telemetryPayload.hostTrack.length : 0);
            if (
                state.selectedIngredientId !== null &&
                !actualRows.some((row) => normalizeNullableId(row?.id) === state.selectedIngredientId)
            ) {
                state.selectedIngredientId = null;
            }

            renderBatchSummary(batch);
            renderIngredientList(actualRows);
            renderPlanFact(summaryRows);
            renderTelemetry(telemetryPayload.hostTrack);
            await renderBatchTrack(telemetryPayload, actualRows);
            renderBatchEditor(batch);
            if (canAdmin) {
                loadPostprocessDebug();
            }
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
        ingredientListBody.addEventListener("click", handleIngredientTrackRowClick);
        ingredientListBody.addEventListener("keydown", handleIngredientTrackRowKeydown);
        ingredientListBody.addEventListener("change", handleIngredientReplacementChange);
        ingredientListBody.addEventListener("click", handleIngredientRenameClick);
        ingredientListBody.addEventListener("click", handleIngredientDeleteClick);
    }

    if (trackResetButton) {
        trackResetButton.addEventListener("click", handleTrackResetClick);
    }

    if (trackFullscreenButton) {
        trackFullscreenButton.addEventListener("click", handleBatchTrackFullscreenClick);
        syncBatchTrackFullscreenButton();
    }

    document.addEventListener("keydown", handleBatchTrackFullscreenKeydown);
    window.addEventListener("resize", scheduleBatchTrackMapFit);
    window.addEventListener("orientationchange", scheduleBatchTrackMapFit);

    if (stopButton) {
        stopButton.addEventListener("click", handleStopBatchClick);
    }

    if (deleteButton) {
        deleteButton.addEventListener("click", handleDeleteBatchClick);
    }

    if (telemetryZoomInButton) {
        telemetryZoomInButton.addEventListener("click", () => zoomTelemetryChart(0.5));
    }

    if (telemetryZoomOutButton) {
        telemetryZoomOutButton.addEventListener("click", () => zoomTelemetryChart(2));
    }

    if (telemetryZoomResetButton) {
        telemetryZoomResetButton.addEventListener("click", () => {
            resetTelemetryZoom(Array.isArray(state.telemetryPayload?.hostTrack) ? state.telemetryPayload.hostTrack.length : 0);
            renderTelemetry(state.telemetryPayload?.hostTrack || []);
        });
    }

    if (telemetryPanLeftButton) {
        telemetryPanLeftButton.addEventListener("click", () => panTelemetryChart(-1));
    }

    if (telemetryPanRightButton) {
        telemetryPanRightButton.addEventListener("click", () => panTelemetryChart(1));
    }

    if (canAdmin) {
        setPostprocessDebugCollapsed(getPostprocessDebugCollapsedPreference(), { persist: false });
        renderPostprocessDebugFields();
        renderPostprocessDebugToggles();
    }

    if (postprocessDebugCollapseButton) {
        postprocessDebugCollapseButton.addEventListener("click", () => {
            setPostprocessDebugCollapsed(!postprocessDebugBody?.classList.contains("d-none"));
        });
    }

    if (postprocessDebugApplyButton) {
        postprocessDebugApplyButton.addEventListener("click", () => loadPostprocessDebug(true));
    }

    if (postprocessDebugResetButton) {
        postprocessDebugResetButton.addEventListener("click", () => loadPostprocessDebug(false));
    }

    if (postprocessDebugRefreshButton) {
        postprocessDebugRefreshButton.addEventListener("click", () => loadPostprocessDebug(true));
    }

    if (postprocessDebugToggles) {
        postprocessDebugToggles.addEventListener("change", (event) => {
            const input = event.target?.closest?.("[data-postprocess-debug-toggle]");
            if (!(input instanceof HTMLInputElement)) {
                return;
            }
            const key = input.dataset.postprocessDebugToggle;
            if (!Object.prototype.hasOwnProperty.call(state.postprocessDebugView, key)) {
                return;
            }
            state.postprocessDebugView[key] = input.checked;
            renderPostprocessDebug();
        });
    }

    if (replaySlider) {
        replaySlider.addEventListener("input", () => {
            stopReplay();
            renderReplayFrame(Number(replaySlider.value));
        });
    }

    if (replayPlayButton) {
        replayPlayButton.addEventListener("click", () => {
            if (state.replayPlaying) stopReplay();
            else startReplay();
        });
    }

    if (canWrite) {
        loadLookupOptions();
    }

    loadBatchDetails();
});

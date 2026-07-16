const API_BASE = window.AppAuth?.getApiUrl?.("/api/telemetry/host") || "/api/telemetry/host";
const RTK_API_BASE = window.AppAuth?.getApiUrl?.("/api/telemetry/rtk") || "/api/telemetry/rtk";
const ZONES_API = window.AppAuth?.getApiUrl?.("/api/telemetry/zones") || "/api/telemetry/zones";
const CLEAR_HOST_HISTORY_API = `${API_BASE}/admin/truncate`;
const CLEAR_RTK_HISTORY_API = `${RTK_API_BASE}/admin/truncate`;
const HISTORY_LIMIT = 20000;
const DEFAULT_COORDS = [54.84, 83.09];
const POLL_TICK_INTERVAL_MS = 1000;
const LATEST_POLL_VISIBLE_MS = 2000;
const LATEST_POLL_HIDDEN_MS = 7000;
const HISTORY_POLL_VISIBLE_MS = 12000;
const HISTORY_POLL_HIDDEN_MS = 30000;
const ZONES_POLL_VISIBLE_MS = 20000;
const ZONES_POLL_HIDDEN_MS = 60000;
const OFFLINE_THRESHOLD_MS = 15000;
const TRACK_MAX_GAP_MS = 45000;
const TRACK_MAX_SPEED_MPS = 12;
const TRACK_MIN_JUMP_DISTANCE_M = 30;
const DEFAULT_MAP_TYPE = "yandex#satellite";
const ZONE_BANNER_DISPLAY_MS = 4500;
const DEFAULT_ZONE_RADIUS = 20;
const DEFAULT_SQUARE_SIDE = 40;
const ZONE_TYPE_BARN = "BARN";
const HOST_TRACK_COLOR = "#3F6FAE";
const RTK_GPS_FIX_COLOR = "#B65F55";
const RTK_FIX_COLOR = "#5F8A6B";
const OFFLINE_MARKER_COLOR = "#8A8F93";
const HOST_MARKER_IMAGE_URL = "img/host.svg";
const RTK_MARKER_IMAGE_URL = "img/rtk.svg";
const DASHED_TRACK_PREFERENCE_KEYS = {
    host: "korovki.showDashedHostTrackGaps",
    rtk: "korovki.showDashedLoaderTrackGaps",
};

let map;
let placemark;
let rtkPlacemark = null;
let routePolylines = [];
let rtkRoutePolylines = [];
let latestTelemetry = null;
let latestRtkTelemetry = null;
let storageZones = [];
let zoneCircles = [];
let hasLiveCoordinates = false;
let isPlacemarkVisible = false;
let isRtkPlacemarkVisible = false;
let isFetchingZones = false;
let mapTypeButtons = [];
let idleCursorAccessor = null;
let dragCursorAccessor = null;
let lastShownZone = null;
let currentBannerElement = null;
let currentBannerType = null;
let currentZoneBannerElements = { host: null, rtk: null };
let lastShownZoneBannerKeys = { host: null, rtk: null };
let bannerDismissTimerId = null;
let pendingTelemetryUndo = null;
let currentUndoAlert = null;
let undoAlertTimerId = null;
let lastTelemetryChangeAt = 0;
let lastTelemetrySnapshotKey = null;
let isFetchingHistory = false;
let trackHistoryVersion = { host: 0, rtk: 0 };
let visibleTrackClearedThroughMs = { host: null, rtk: null };
let lastTrackHistoryMaxTimestampMs = { host: null, rtk: null };
let retainedTrackMarkerTelemetry = { host: null, rtk: null };
let isMarkerTrackingEnabled = false;
let markerTrackingTarget = "all";
let mapTrackToggleButton = null;
let mapCenterOnMarkerButton = null;
let mapFullscreenButton = null;
let mapWrapElement = null;
let hasTelemetryAutoFocus = false;
let pinnedMapActionMenu = null;
let lastLatestFetchStartedAt = 0;
let lastHistoryFetchStartedAt = 0;
let lastZonesFetchStartedAt = 0;
let latestTrackHistory = { host: [], rtk: [] };
let dashedTrackPreferences = { host: true, rtk: true };

function isAdmin() {
    return Boolean(window.AppAuth?.isAdmin && window.AppAuth.isAdmin());
}

function getDashedTrackPreference(track) {
    try {
        return window.localStorage.getItem(DASHED_TRACK_PREFERENCE_KEYS[track]) !== "false";
    } catch (error) {
        return true;
    }
}

function setDashedTrackPreference(track, enabled) {
    dashedTrackPreferences[track] = Boolean(enabled);
    try {
        window.localStorage.setItem(DASHED_TRACK_PREFERENCE_KEYS[track], String(dashedTrackPreferences[track]));
    } catch (error) {
        // The preference is optional; rendering must still work when storage is unavailable.
    }
}

function canShowDashedTrackGap(track) {
    return isAdmin() && dashedTrackPreferences[track] === true;
}

function initDashedTrackControls() {
    dashedTrackPreferences = {
        host: getDashedTrackPreference("host"),
        rtk: getDashedTrackPreference("rtk"),
    };

    [
        ["host", document.getElementById("dashboardHostDashedTrackToggle")],
        ["rtk", document.getElementById("dashboardLoaderDashedTrackToggle")],
    ].forEach(([track, input]) => {
        if (!(input instanceof HTMLInputElement)) {
            return;
        }

        input.checked = dashedTrackPreferences[track];
        input.disabled = !isAdmin();
        input.addEventListener("change", () => {
            setDashedTrackPreference(track, input.checked);
            if (track === "host") {
                renderRoute(latestTrackHistory.host);
            } else {
                renderRtkRoute(latestTrackHistory.rtk);
            }
        });
    });
}

function hasWriteAccess() {
    return Boolean(window.AppAuth?.hasWriteAccess && window.AppAuth.hasWriteAccess());
}

function isEmptyTelemetry(data) {
    return !data || (
        data.id == null &&
        data.timestamp == null &&
        data.lat == null &&
        data.lon == null
    );
}

function getLatestApiUrl() {
    return `${API_BASE}/current`;
}

function getRtkLatestApiUrl() {
    return `${RTK_API_BASE}/current`;
}

function getHistoryApiUrl() {
    return isAdmin()
        ? `${API_BASE}/admin/history?limit=${HISTORY_LIMIT}`
        : `${API_BASE}/recent?limit=${HISTORY_LIMIT}`;
}

function getRtkHistoryApiUrl() {
    return isAdmin()
        ? `${RTK_API_BASE}/admin/history?limit=${HISTORY_LIMIT}`
        : `${RTK_API_BASE}/history?limit=${HISTORY_LIMIT}`;
}

function getHeaders() {
    return window.AppAuth?.getAuthHeaders?.({ includeJson: true }) || {
        "Content-Type": "application/json",
    };
}

function isPageVisible() {
    return document.visibilityState === "visible";
}

function getPollInterval(visibleMs, hiddenMs) {
    return isPageVisible() ? visibleMs : hiddenMs;
}

function shouldPoll(lastStartedAt, visibleMs, hiddenMs, force = false) {
    if (force) {
        return true;
    }

    const now = Date.now();
    const interval = getPollInterval(visibleMs, hiddenMs);
    return now - Number(lastStartedAt || 0) >= interval;
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

function formatDateTime(value) {
    if (!value) return "--";

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("ru-RU", { timeZone: "Asia/Novosibirsk" });
}

function formatTrackPointBalloon(label, point) {
    const timestamp = point?.source?.timestamp || point?.timestamp || null;
    const weight = point?.source?.weight;
    const speed = point?.source?.speedKmh ?? point?.source?.speed;
    const details = [
        `<strong>${label}</strong>`,
        `Время: ${formatDateTime(timestamp)}`,
    ];

    if (weight !== undefined && weight !== null) {
        details.push(`Вес: ${formatMetric(weight, 0)} кг`);
    }

    if (speed !== undefined && speed !== null) {
        details.push(`Скорость: ${formatMetric(speed, 1)} км/ч`);
    }

    return details.join("<br>");
}

function formatMetric(value, digits = 1) {
    if (value === null || value === undefined || value === "") return "--";

    const number = Number(value);
    return Number.isNaN(number) ? "--" : number.toFixed(digits);
}

function parseNumber(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    const parsed = Number.parseFloat(String(value).replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
}

function formatSignedPercent(value, digits = 1) {
    const number = parseNumber(value);
    if (number === null) return "--";

    const sign = number > 0 ? "+" : "";
    return `${sign}${number.toFixed(digits)}%`;
}

function formatSignedMetric(value, unit = "", digits = 1) {
    const number = parseNumber(value);
    if (number === null) return "--";

    const sign = number > 0 ? "+" : "";
    const suffix = unit ? ` ${unit}` : "";
    return `${sign}${number.toFixed(digits)}${suffix}`;
}

function asBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "да";
    }

    return Boolean(value);
}

function setSectionVisible(id, isVisible) {
    const element = document.getElementById(id);
    if (!element) {
        return;
    }

    element.classList.toggle("d-none", !isVisible);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildMapBalloonContent({ title, accentColor, rows }) {
    const safeAccent = /^#[0-9a-f]{6}$/i.test(accentColor) ? accentColor : HOST_TRACK_COLOR;
    const safeRows = Array.isArray(rows) ? rows : [];
    const rowMarkup = safeRows
        .filter((row) => row && row.label)
        .map((row) => {
            const value = row.value === null || row.value === undefined || row.value === "" ? "--" : row.value;

            return `
                <div style="display:grid;grid-template-columns:92px minmax(0,1fr);gap:10px;align-items:start;">
                    <div style="color:#7a8699;font-size:12px;line-height:1.25;">${escapeHtml(row.label)}</div>
                    <div style="color:#1f2937;font-size:13px;font-weight:600;line-height:1.25;word-break:break-word;">${escapeHtml(value)}</div>
                </div>
            `;
        })
        .join("");

    return `
        <div style="min-width:250px;max-width:310px;padding:2px 0 1px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
            <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px;padding-bottom:9px;border-bottom:1px solid #eef1f6;">
                <span style="width:10px;height:10px;border-radius:999px;background:${safeAccent};box-shadow:0 0 0 4px ${safeAccent}22;flex:0 0 auto;"></span>
                <div style="color:#111827;font-size:15px;font-weight:800;line-height:1.2;">${escapeHtml(title)}</div>
            </div>
            <div style="display:grid;gap:7px;">
                ${rowMarkup}
            </div>
        </div>
    `.trim();
}

const latestFetchState = {
    hasLoadedAtLeastOnce: false,
    status: "loading",
    errorMessage: "",
};

function setCurrentStateNotice(tone, message) {
    const element = document.getElementById("dashboardCurrentStateNotice");
    if (!element) {
        return;
    }

    if (!tone || !message) {
        element.textContent = "";
        element.className = "dashboard-inline-state d-none";
        return;
    }

    element.textContent = message;
    element.className = `dashboard-inline-state dashboard-inline-state--${tone}`;
}

function updateCurrentStateNotice(data) {
    if (latestFetchState.status === "loading" && !latestFetchState.hasLoadedAtLeastOnce) {
        setCurrentStateNotice("info", "Загрузка текущего состояния...");
        return;
    }

    if (latestFetchState.status === "error") {
        setCurrentStateNotice(
            "danger",
            latestFetchState.errorMessage || "Не удалось загрузить текущее состояние."
        );
        return;
    }

    if (latestFetchState.status === "stale" && !isEmptyTelemetry(data)) {
        const packetTime = formatDateTime(data?.timestamp);
        const packetInfo = packetTime !== "--" ? ` Последний пакет: ${packetTime}.` : "";
        setCurrentStateNotice(
            "warning",
            `Данные временно не обновляются. Показано последнее доступное состояние.${packetInfo}`
        );
        return;
    }

    if (isEmptyTelemetry(data)) {
        setCurrentStateNotice("info", "Телеметрия ещё не поступила.");
        return;
    }

    setCurrentStateNotice("", "");
}

function getModeLabel(mode) {
    return (typeof mode === "string" && mode.trim()) ? mode.trim() : "Ожидание";
}

function normalizeModeKey(mode) {
    const normalized = getModeLabel(mode).toLowerCase();

    if (normalized.includes("выгруз") || normalized.includes("unload")) {
        return "unloading";
    }

    if (
        normalized.includes("загруз") ||
        normalized.includes("смеш") ||
        normalized.includes("микс") ||
        normalized.includes("load") ||
        normalized.includes("mix")
    ) {
        return "loading";
    }

    if (
        normalized.includes("ожид") ||
        normalized.includes("простой") ||
        normalized.includes("пауза") ||
        normalized.includes("idle") ||
        normalized.includes("wait")
    ) {
        return "idle";
    }

    return "unknown";
}

function renderModeBadge(mode) {
    const element = document.getElementById("dashboardCurrentMode");
    if (!element) {
        return;
    }

    const modeKey = normalizeModeKey(mode);
    element.textContent = getModeLabel(mode);
    element.classList.remove(
        "dashboard-mode-badge--idle",
        "dashboard-mode-badge--loading",
        "dashboard-mode-badge--unloading",
        "dashboard-mode-badge--unknown",
        "is-stale"
    );
    element.classList.add("dashboard-mode-badge", `dashboard-mode-badge--${modeKey}`);
    element.classList.toggle("is-stale", latestFetchState.status === "stale");
}

function isUnloadMode(mode) {
    return normalizeModeKey(mode) === "unloading";
}

function renderUnloadProgress(mode, unloadProgress) {
    const isVisible = getModeLabel(mode) === "Выгрузка";
    const bar = document.getElementById("dashboardUnloadProgressBar");
    const targetValue = parseNumber(unloadProgress?.target_weight);
    const factValue = parseNumber(unloadProgress?.unloaded_fact);
    const hasProgressData = targetValue !== null || factValue !== null;

    setSectionVisible("dashboardUnloadProgressCard", Boolean(isVisible));

    if (!bar) {
        return;
    }

    if (!isVisible) {
        bar.style.width = "0%";
        bar.classList.remove("is-over");
        setText("dashboardUnloadProgressMeta", "--");
        return;
    }

    if (!hasProgressData) {
        bar.style.width = "0%";
        bar.classList.remove("is-over");
        setText("dashboardUnloadProgressMeta", "--");
        return;
    }

    const target = Math.max(targetValue ?? 0, 0);
    const fact = Math.max(factValue ?? 0, 0);
    const progress = target > 0 ? (fact / target) * 100 : 0;
    const fillPercent = Math.max(Math.min(progress, 100), 0);

    bar.style.width = `${fillPercent}%`;
    bar.classList.toggle("is-over", progress > 100);
    setText(
        "dashboardUnloadProgressMeta",
        `${formatMetric(fact, 1)} / ${formatMetric(target, 1)} кг (${progress.toFixed(0)}%)`
    );
}

function renderActiveBatch(batch) {
    const tbody = document.getElementById("dashboardActiveBatchTableBody");
    if (!tbody) {
        return;
    }

    const rows = Array.isArray(batch?.ingredients) ? batch.ingredients : [];
    const isVisible = rows.length > 0;

    setSectionVisible("dashboardActiveBatchCard", isVisible);

    if (!isVisible) {
        setText("dashboardActiveBatchMeta", "--");
        tbody.innerHTML = '<tr><td colspan="5" class="dashboard-mini-table-empty">--</td></tr>';
        return;
    }

    const metaParts = [];
    if (batch?.id != null) {
        metaParts.push(`Замес #${batch.id}`);
    }
    metaParts.push(`Компонентов: ${rows.length}`);
    setText("dashboardActiveBatchMeta", metaParts.join(" | "));

    tbody.innerHTML = rows.map((row) => {
        const name = escapeHtml(row?.name ?? "--");
        const plan = formatMetric(row?.plan, 1);
        const fact = formatMetric(row?.fact, 1);
        const deviation = formatSignedPercent(row?.deviation_percent, 1);
        const isViolation = asBoolean(row?.is_violation);

        return `
            <tr>
                <td>${name}</td>
                <td>${plan}</td>
                <td>${fact}</td>
                <td>${deviation}</td>
                <td>
                    <span class="dashboard-bool-badge ${isViolation ? "is-yes" : "is-no"}">
                        ${isViolation ? "Да" : "Нет"}
                    </span>
                </td>
            </tr>
        `;
    }).join("");
}

function getTelemetrySnapshotKey(data) {
    if (isEmptyTelemetry(data)) {
        return null;
    }

    return [
        data.id ?? "",
        data.deviceId ?? "",
        data.timestamp ?? "",
        data.lat ?? "",
        data.lon ?? "",
        data.weight ?? "",
    ].join("|");
}

function noteTelemetryActivity(data) {
    const snapshotKey = getTelemetrySnapshotKey(data);
    if (!snapshotKey) {
        return;
    }

    if (snapshotKey !== lastTelemetrySnapshotKey) {
        lastTelemetrySnapshotKey = snapshotKey;
        lastTelemetryChangeAt = Date.now();
    }
}

function resetTelemetryActivity() {
    lastTelemetrySnapshotKey = null;
    lastTelemetryChangeAt = 0;
}

function setVehicleStatus(isOnline) {
    const element = document.getElementById("dashboardVehicleStatus");
    if (!element) return;

    element.textContent = isOnline ? "Онлайн" : "Оффлайн";
    element.classList.toggle("online", isOnline);
    element.classList.toggle("offline", !isOnline);
}

function getImageMarkerLayout(color, imageUrl) {
    const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : OFFLINE_MARKER_COLOR;
    const safeImageUrl = String(imageUrl || "").replace(/"/g, "&quot;");

    return ymaps.templateLayoutFactory.createClass(`
        <div style="position:relative;left:-22px;top:-22px;width:44px;height:44px;">
            <div style="position:absolute;left:4px;top:5px;width:36px;height:36px;border-radius:8px;background:rgba(0,0,0,0.16);"></div>
            <div style="position:absolute;left:2px;top:2px;width:36px;height:36px;border-radius:8px;background:${safeColor};display:flex;align-items:center;justify-content:center;">
                <div style="width:25.6px;height:25.6px;border-radius:5px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;">
                    <img src="${safeImageUrl}" alt="" style="display:block;width:22px;height:22px;object-fit:contain;">
                </div>
            </div>
        </div>
    `);
}

function getNavigationMarkerLayout(color, heading) {
    const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : RTK_FIX_COLOR;
    const rotation = ((Number(heading) % 360) + 360) % 360;

    return ymaps.templateLayoutFactory.createClass(`
        <div style="position:relative;left:-27px;top:-27px;width:54px;height:54px;filter:drop-shadow(0 3px 5px rgba(0,0,0,0.35));">
            <svg width="54" height="54" viewBox="0 0 54 54" style="display:block;transform:rotate(${rotation}deg);transform-origin:27px 27px;">
                <polygon points="27,2 27,37 4,50" fill="#0b5f9f"></polygon>
                <polygon points="27,2 50,50 27,37" fill="${safeColor}"></polygon>
                <polyline points="27,2 50,50 27,37 4,50 27,2" fill="none" stroke="rgba(255,255,255,0.72)" stroke-width="1.25" stroke-linejoin="round"></polyline>
            </svg>
        </div>
    `);
}

function getRtkFixColor(data, isOnline = true) {
    if (!isOnline) {
        return OFFLINE_MARKER_COLOR;
    }

    return isRtkFixed(data) ? RTK_FIX_COLOR : RTK_GPS_FIX_COLOR;
}

function getRtkHeading(data) {
    if (data?.relPosValid === false || data?.relPosHeadingValid === false) {
        return null;
    }

    const heading = data?.heading ?? data?.course;
    const parsedHeading = Number(heading);
    return Number.isFinite(parsedHeading) ? parsedHeading : null;
}

function getMarkerOptions(kind, isOnline, data = null) {
    const color = kind === "rtk"
        ? getRtkFixColor(data, isOnline)
        : HOST_TRACK_COLOR;
    const imageUrl = kind === "rtk" ? RTK_MARKER_IMAGE_URL : HOST_MARKER_IMAGE_URL;
    const heading = kind === "rtk" ? getRtkHeading(data) : null;

    return {
        iconLayout: heading == null
            ? getImageMarkerLayout(color, imageUrl)
            : getNavigationMarkerLayout(color, heading),
        iconShape: {
            type: "Rectangle",
            coordinates: heading == null ? [[-22, -22], [22, 22]] : [[-27, -27], [27, 27]],
        },
    };
}

function updatePlacemarkStatus(isOnline) {
    if (!placemark) return;
    placemark.options.set(getMarkerOptions("host", isOnline));
}

function ensurePlacemarkVisible() {
    if (!map || !placemark || isPlacemarkVisible) {
        return;
    }

    map.geoObjects.add(placemark);
    isPlacemarkVisible = true;
}

function hidePlacemark() {
    if (!map || !placemark || !isPlacemarkVisible) {
        return;
    }

    map.geoObjects.remove(placemark);
    isPlacemarkVisible = false;
}

function ensureRtkPlacemarkVisible() {
    if (!map || !rtkPlacemark || isRtkPlacemarkVisible) {
        return;
    }

    map.geoObjects.add(rtkPlacemark);
    isRtkPlacemarkVisible = true;
}

function hideRtkPlacemark() {
    if (!map || !rtkPlacemark || !isRtkPlacemarkVisible) {
        return;
    }

    map.geoObjects.remove(rtkPlacemark);
    isRtkPlacemarkVisible = false;
}

function isPacketOnline(timestamp) {
    if (!timestamp) return false;

    const packetTime = new Date(timestamp).getTime();
    if (Number.isNaN(packetTime)) return false;

    return (Date.now() - packetTime) < OFFLINE_THRESHOLD_MS;
}

function isTelemetryOnline(data) {
    if (latestFetchState.status === "stale" || latestFetchState.status === "error") {
        return false;
    }

    return isPacketOnline(data?.timestamp);
}

function hasValidCoordinates(lat, lon) {
    const parsedLat = Number(lat);
    const parsedLon = Number(lon);

    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) {
        return false;
    }

    return parsedLat !== 0 && parsedLon !== 0;
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
        ? { fillColor: "rgba(63,111,174,0.34)", strokeColor: "#3F6FAE" }
        : { fillColor: "rgba(47,159,85,0.36)", strokeColor: "#18B35B" };
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

function normalizeZone(zone) {
    let polygonCoords = null;

    if (zone?.polygonCoords) {
        try {
            const parsed = typeof zone.polygonCoords === "string" ? JSON.parse(zone.polygonCoords) : zone.polygonCoords;
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
        const hasBounds = Number.isFinite(normalized.squareMinLat) &&
            Number.isFinite(normalized.squareMinLon) &&
            Number.isFinite(normalized.squareMaxLat) &&
            Number.isFinite(normalized.squareMaxLon);

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

function getZoneLabel(zone) {
    const ingredient = String(zone?.ingredient || "").trim();
    const name = String(zone?.name || "").trim();

    return ingredient || name || "Без названия";
}

function isPointInPolygon(lat, lon, polygonCoords) {
    if (!Array.isArray(polygonCoords) || polygonCoords.length < 3) {
        return false;
    }

    let isInside = false;

    for (let i = 0, j = polygonCoords.length - 1; i < polygonCoords.length; j = i++) {
        const yi = Number(polygonCoords[i][0]);
        const xi = Number(polygonCoords[i][1]);
        const yj = Number(polygonCoords[j][0]);
        const xj = Number(polygonCoords[j][1]);

        const intersects = ((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / ((yj - yi) || Number.EPSILON) + xi);

        if (intersects) {
            isInside = !isInside;
        }
    }

    return isInside;
}

function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
    const earthRadius = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadius * c;
}

function getCurrentZoneName(lat, lon) {
    for (const zone of storageZones) {
        if (!zone?.active) {
            continue;
        }

        if (normalizeShapeType(zone.shapeType) === "SQUARE") {
            if (isPointInPolygon(lat, lon, zone.polygonCoords)) {
                return getZoneLabel(zone);
            }

            continue;
        }

        const zoneLat = Number(zone.lat);
        const zoneLon = Number(zone.lon);
        const zoneRadius = Number(zone.radius) || DEFAULT_ZONE_RADIUS;

        if (!Number.isFinite(zoneLat) || !Number.isFinite(zoneLon)) {
            continue;
        }

        const distance = getDistanceFromLatLonInMeters(lat, lon, zoneLat, zoneLon);
        if (distance <= zoneRadius) {
            return getZoneLabel(zone);
        }
    }

    return null;
}

function smoothMove(newCoords) {
    const startCoords = placemark.geometry.getCoordinates();
    const duration = 1000;
    const startTime = performance.now();

    function animate(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        const currentLat = startCoords[0] + (newCoords[0] - startCoords[0]) * progress;
        const currentLon = startCoords[1] + (newCoords[1] - startCoords[1]) * progress;

        placemark.geometry.setCoordinates([currentLat, currentLon]);

        if (progress < 1) {
            requestAnimationFrame(animate);
        }
    }

    requestAnimationFrame(animate);
}

function getCurrentMarkerCoords() {
    return getTelemetryCoordsByTarget("host") || getTelemetryCoordsByTarget("rtk");
}

function getTelemetryCoordsByTarget(target) {
    if (target === "host" && hasValidCoordinates(latestTelemetry?.lat, latestTelemetry?.lon)) {
        return [Number(latestTelemetry.lat), Number(latestTelemetry.lon)];
    }

    if (target === "rtk" && hasValidCoordinates(latestRtkTelemetry?.lat, latestRtkTelemetry?.lon)) {
        return [Number(latestRtkTelemetry.lat), Number(latestRtkTelemetry.lon)];
    }

    return null;
}

function getVisibleTelemetryCoords(target = "all") {
    if (target === "host" || target === "rtk") {
        const coords = getTelemetryCoordsByTarget(target);
        return coords ? [coords] : [];
    }

    const coords = [];

    if (hasValidCoordinates(latestTelemetry?.lat, latestTelemetry?.lon)) {
        coords.push([Number(latestTelemetry.lat), Number(latestTelemetry.lon)]);
    }

    if (hasValidCoordinates(latestRtkTelemetry?.lat, latestRtkTelemetry?.lon)) {
        coords.push([Number(latestRtkTelemetry.lat), Number(latestRtkTelemetry.lon)]);
    }

    return coords;
}

function isMapCenteredOnCoords(coords, toleranceMeters = 4) {
    if (!map || !Array.isArray(coords)) {
        return false;
    }

    const currentCenter = map.getCenter();
    if (!Array.isArray(currentCenter) || currentCenter.length < 2) {
        return false;
    }

    return getDistanceFromLatLonInMeters(
        Number(currentCenter[0]),
        Number(currentCenter[1]),
        Number(coords[0]),
        Number(coords[1])
    ) <= toleranceMeters;
}

function moveMapCenterToCoords(coords, options = {}) {
    if (!map || !Array.isArray(coords)) {
        return false;
    }

    const targetZoom = map.getZoom();

    map.setCenter(coords, targetZoom, {
        checkZoomRange: true,
        duration: options.duration ?? 250,
    });

    return true;
}

function centerMapOnMarker(options = {}) {
    if (!map) {
        return false;
    }

    const coordsList = getVisibleTelemetryCoords(options.target || "all");
    if (!coordsList.length) {
        return false;
    }

    if (coordsList.length === 1) {
        const coords = coordsList[0];

        if (!options.force && isMapCenteredOnCoords(coords)) {
            return true;
        }

        return moveMapCenterToCoords(coords, options);
    }

    const lats = coordsList.map((coords) => coords[0]);
    const lons = coordsList.map((coords) => coords[1]);

    map.setBounds(
        [
            [Math.min(...lats), Math.min(...lons)],
            [Math.max(...lats), Math.max(...lons)],
        ],
        {
            checkZoomRange: true,
            zoomMargin: 60,
            duration: options.duration ?? 280,
        }
    );

    return true;
}

function syncMapActionButtons() {
    const hasMarkerCoords = Boolean(getCurrentMarkerCoords());
    const hasTrackingCoords = Boolean(markerTrackingTarget === "all"
        ? getVisibleTelemetryCoords().length
        : getTelemetryCoordsByTarget(markerTrackingTarget));

    if (isMarkerTrackingEnabled && !hasTrackingCoords) {
        isMarkerTrackingEnabled = false;
        markerTrackingTarget = "all";
    }

    if (mapTrackToggleButton) {
        mapTrackToggleButton.disabled = !hasMarkerCoords;
        mapTrackToggleButton.classList.toggle("is-active", isMarkerTrackingEnabled);
        mapTrackToggleButton.setAttribute("aria-pressed", String(isMarkerTrackingEnabled));
    }

    if (mapCenterOnMarkerButton) {
        mapCenterOnMarkerButton.disabled = !hasMarkerCoords;
    }

    document.querySelectorAll(".map-action-dropdown__item[data-marker-target]").forEach((item) => {
        const target = item.dataset.markerTarget;
        const hasTargetCoords = Boolean(getTelemetryCoordsByTarget(target));
        item.disabled = !hasTargetCoords;
        item.classList.toggle(
            "is-active",
            item.dataset.mapAction === "track" &&
                isMarkerTrackingEnabled &&
                markerTrackingTarget === target
        );
    });

    if (mapFullscreenButton) {
        const isFullscreen = document.fullscreenElement === mapWrapElement;
        const icon = mapFullscreenButton.querySelector("i");
        mapFullscreenButton.classList.toggle("is-active", isFullscreen);
        mapFullscreenButton.setAttribute("aria-pressed", String(isFullscreen));

        if (icon) {
            icon.className = isFullscreen ? "fas fa-compress-arrows-alt" : "fas fa-expand-arrows-alt";
        }
    }
}

function setMarkerTrackingEnabled(isEnabled, target = "all") {
    markerTrackingTarget = target;
    isMarkerTrackingEnabled = Boolean(isEnabled);
    syncMapActionButtons();

    if (isMarkerTrackingEnabled) {
        centerMapOnMarker({ force: true, duration: 300, target: markerTrackingTarget });
    }
}

function stopMarkerTracking() {
    markerTrackingTarget = "all";
    isMarkerTrackingEnabled = false;
    syncMapActionButtons();
}

function closePinnedMapActionMenu() {
    if (!pinnedMapActionMenu) {
        return;
    }

    pinnedMapActionMenu.classList.remove("is-pinned");
    const button = pinnedMapActionMenu.querySelector(".map-action-button");
    button?.setAttribute("aria-expanded", "false");
    pinnedMapActionMenu = null;
}

function togglePinnedMapActionMenu(button) {
    const menu = button?.closest(".map-action-menu");
    if (!menu || button.disabled) {
        return;
    }

    if (button === mapTrackToggleButton && isMarkerTrackingEnabled) {
        stopMarkerTracking();
        closePinnedMapActionMenu();
        menu.classList.add("is-suppressed");
        button.blur();
        return;
    }

    const shouldClose = pinnedMapActionMenu === menu;
    closePinnedMapActionMenu();

    if (shouldClose) {
        menu.classList.add("is-suppressed");
        button.blur();
        return;
    }

    menu.classList.remove("is-suppressed");
    menu.classList.add("is-pinned");
    button.setAttribute("aria-expanded", "true");
    pinnedMapActionMenu = menu;
}

function suppressMapActionMenu(menu) {
    if (!menu) {
        return;
    }

    if (pinnedMapActionMenu === menu) {
        pinnedMapActionMenu = null;
    }

    menu.classList.remove("is-pinned");
    menu.classList.add("is-suppressed");
    const button = menu.querySelector(".map-action-button");
    button?.setAttribute("aria-expanded", "false");
}

function handleMapActionDropdownClick(event) {
    const item = event.target.closest(".map-action-dropdown__item");
    if (!item || item.disabled) {
        return;
    }

    const target = item.dataset.markerTarget;
    const action = item.dataset.mapAction;

    if (action === "track") {
        setMarkerTrackingEnabled(true, target);
        suppressMapActionMenu(item.closest(".map-action-menu"));
        return;
    }

    if (action === "center") {
        centerMapOnMarker({ force: true, duration: 280, target });
        suppressMapActionMenu(item.closest(".map-action-menu"));
    }
}

function handleMapActionMenuLeave(event) {
    event.currentTarget.classList.remove("is-suppressed");
}

async function toggleMapFullscreen() {
    if (!mapWrapElement) {
        return;
    }

    try {
        if (document.fullscreenElement === mapWrapElement) {
            await document.exitFullscreen();
        } else {
            await mapWrapElement.requestFullscreen();
        }
    } catch (error) {
        console.error("Error toggling fullscreen:", error);
    }
}

function handleFullscreenChange() {
    syncMapActionButtons();

    window.setTimeout(() => {
        map?.container.fitToViewport();
    }, 50);
}

function handleMapActionEnd() {
    applyIdleMapCursor();

    if (isMarkerTrackingEnabled) {
        centerMapOnMarker({ duration: 220, target: markerTrackingTarget });
    }
}

function initMapActionControls() {
    mapWrapElement = document.querySelector(".dashboard-map-wrap");
    mapTrackToggleButton = document.getElementById("mapTrackToggleButton");
    mapCenterOnMarkerButton = document.getElementById("mapCenterOnMarkerButton");
    mapFullscreenButton = document.getElementById("mapFullscreenButton");

    if (mapTrackToggleButton) {
        mapTrackToggleButton.setAttribute("aria-haspopup", "menu");
        mapTrackToggleButton.setAttribute("aria-expanded", "false");
        mapTrackToggleButton.addEventListener("click", (event) => {
            event.preventDefault();
            togglePinnedMapActionMenu(mapTrackToggleButton);
        });
    }

    if (mapCenterOnMarkerButton) {
        mapCenterOnMarkerButton.setAttribute("aria-haspopup", "menu");
        mapCenterOnMarkerButton.setAttribute("aria-expanded", "false");
        mapCenterOnMarkerButton.addEventListener("click", (event) => {
            event.preventDefault();
            togglePinnedMapActionMenu(mapCenterOnMarkerButton);
        });
    }

    if (mapFullscreenButton) {
        mapFullscreenButton.addEventListener("click", toggleMapFullscreen);
    }

    document.querySelectorAll(".map-action-dropdown").forEach((dropdown) => {
        dropdown.addEventListener("click", handleMapActionDropdownClick);
    });

    document.querySelectorAll(".map-action-menu").forEach((menu) => {
        menu.addEventListener("mouseleave", handleMapActionMenuLeave);
    });

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    syncMapActionButtons();
}

function updateMapPosition(data, isOnline) {
    if (!hasValidCoordinates(data?.lat, data?.lon)) {
        hidePlacemark();
        hasLiveCoordinates = false;
        syncMapActionButtons();
        return;
    }

    const newCoords = [Number(data.lat), Number(data.lon)];
    const zoneName = getCurrentZoneName(newCoords[0], newCoords[1]) || data?.banner?.zoneName || data?.zone?.name || "Вне зоны";
    const packetState = isOnline ? "Свежий пакет" : "Нет свежих пакетов";
    const gpsValid = data?.gpsValid == null ? null : asBoolean(data.gpsValid);
    const gpsLabel = gpsValid === null
        ? (data?.gpsQuality != null ? `Q${data.gpsQuality}` : "--")
        : `${gpsValid ? "GPS fix" : "Нет GPS fix"}${data?.gpsQuality != null ? ` • Q${data.gpsQuality}` : ""}`;
    const balloonContent = buildMapBalloonContent({
        title: "Хозяин",
        accentColor: HOST_TRACK_COLOR,
        rows: [
            { label: "Устройство", value: data?.deviceId || "--" },
            { label: "Статус", value: packetState },
            { label: "Режим", value: data?.mode || "Ожидание" },
            { label: "GPS", value: gpsLabel },
            { label: "Спутники", value: data?.gpsSatellites ?? "--" },
            { label: "Вес", value: data?.weight != null ? `${formatMetric(data.weight, 1)} кг` : "--" },
            { label: "Координаты", value: `${newCoords[0].toFixed(6)}, ${newCoords[1].toFixed(6)}` },
            { label: "Зона", value: zoneName },
        ],
    });

    ensurePlacemarkVisible();
    updatePlacemarkStatus(isOnline);
    placemark.properties.set({
        balloonContent,
        hintContent: `Хозяин - ${packetState}`,
    });
    syncMapActionButtons();

    if (!hasLiveCoordinates) {
        placemark.geometry.setCoordinates(newCoords);
        hasLiveCoordinates = true;
        if (!hasTelemetryAutoFocus) {
            centerMapOnMarker({ force: true, duration: 300 });
            hasTelemetryAutoFocus = true;
        }
        return;
    }

    smoothMove(newCoords);

    if (isMarkerTrackingEnabled) {
        centerMapOnMarker({ duration: 220, target: markerTrackingTarget });
    }
}

function getRtkQualityLabel(data) {
    if (!data) {
        return "--";
    }

    return data.qualityLabel || data.rtkQuality || (data.quality != null ? `Q${data.quality}` : "--");
}

function isRtkFixed(data) {
    const label = String(data?.qualityLabel || data?.rtkQuality || "").toLowerCase();
    const quality = Number(data?.quality);

    return label.includes("fixed") || quality >= 4;
}

function getRtkQualityTone(data) {
    if (!isPacketOnline(data?.timestamp)) {
        return "stale";
    }

    const label = String(data?.qualityLabel || data?.rtkQuality || "").toLowerCase();
    const quality = Number(data?.quality);

    if (isRtkFixed(data)) {
        return "fixed";
    }

    if (label.includes("float") || quality >= 2) {
        return "float";
    }

    return "poor";
}

function updateRtkMapChip(data) {
    const chip = document.getElementById("dashboardRtkMapChip");
    const stateElement = document.getElementById("dashboardRtkMapChipState");
    const qualityElement = document.getElementById("dashboardRtkMapChipQuality");

    if (!chip || !stateElement || !qualityElement) {
        return;
    }

    chip.classList.remove(
        "map-telemetry-chip--fixed",
        "map-telemetry-chip--float",
        "map-telemetry-chip--poor",
        "map-telemetry-chip--stale",
        "map-telemetry-chip--unknown"
    );

    if (!hasValidCoordinates(data?.lat, data?.lon)) {
        chip.classList.add("map-telemetry-chip--unknown");
        stateElement.textContent = "Нет данных";
        qualityElement.textContent = "Quality: --";
        return;
    }

    const tone = getRtkQualityTone(data);
    const qualityLabel = getRtkQualityLabel(data);
    const packetState = isPacketOnline(data?.timestamp) ? "Свежий пакет" : "Нет свежих пакетов";
    const coordsText = `${Number(data.lat).toFixed(6)}, ${Number(data.lon).toFixed(6)}`;

    chip.classList.add(`map-telemetry-chip--${tone}`);
    stateElement.textContent = packetState;
    qualityElement.textContent = `${qualityLabel} • ${coordsText}`;
}

function updateRtkMapPosition(data) {
    if (!hasValidCoordinates(data?.lat, data?.lon)) {
        hideRtkPlacemark();
        updateRtkMapChip(null);
        syncMapActionButtons();
        return;
    }

    const coords = [Number(data.lat), Number(data.lon)];
    const qualityLabel = getRtkQualityLabel(data);
    const zoneName = getCurrentZoneName(coords[0], coords[1]) || data?.zone?.name || "Вне зоны";
    const isOnline = isPacketOnline(data?.timestamp);
    const packetState = isOnline ? "Свежий пакет" : "Нет свежих пакетов";
    const heading = getRtkHeading(data);
    const balloonContent = buildMapBalloonContent({
        title: "Погрузчик",
        accentColor: getRtkFixColor(data, isOnline),
        rows: [
            { label: "Устройство", value: data?.deviceId || "--" },
            { label: "Статус", value: packetState },
            { label: "Fix", value: qualityLabel },
            { label: "Heading", value: heading == null ? "--" : `${heading.toFixed(1)}°` },
            { label: "Координаты", value: `${coords[0].toFixed(6)}, ${coords[1].toFixed(6)}` },
            { label: "Зона", value: zoneName },
        ],
    });

    if (!rtkPlacemark) {
        rtkPlacemark = new ymaps.Placemark(
            coords,
            {
                balloonContent,
                hintContent: `Погрузчик - ${qualityLabel}`,
            },
            {
                ...getMarkerOptions("rtk", isOnline, data),
            }
        );
    } else {
        rtkPlacemark.geometry.setCoordinates(coords);
        rtkPlacemark.properties.set({
            balloonContent,
            hintContent: `Погрузчик - ${qualityLabel}`,
        });
        rtkPlacemark.options.set(getMarkerOptions("rtk", isOnline, data));
    }

    ensureRtkPlacemarkVisible();
    updateRtkMapChip(data);
    syncMapActionButtons();

    if (!hasTelemetryAutoFocus) {
        centerMapOnMarker({ force: true, duration: 300 });
        hasTelemetryAutoFocus = true;
    }

    if (isMarkerTrackingEnabled) {
        centerMapOnMarker({ duration: 220, target: markerTrackingTarget });
    }
}

function renderDashboard(data) {
    if (isEmptyTelemetry(data)) {
        resetTelemetryActivity();
        setVehicleStatus(false);
        setText("dashboardCurrentZone", "--");
        setText("dashboardCurrentMode", data?.mode || "Ожидание");
        setText("dashboardCurrentWeight", "--");
        setText("dashboardLastPacketTime", "--");
        renderUnloadProgress(data?.mode, data?.unload_progress);
        renderActiveBatch(data?.active_batch);
        hidePlacemark();
        hasLiveCoordinates = false;
        syncMapActionButtons();
        return;
    }

    const isOnline = isTelemetryOnline(data);
    const hasCoordinates = hasValidCoordinates(data.lat, data.lon);
    const parsedLat = Number(data.lat);
    const parsedLon = Number(data.lon);
    const zoneName = hasCoordinates
        ? (getCurrentZoneName(parsedLat, parsedLon) || data?.banner?.zoneName || "Вне зоны")
        : "--";

    setVehicleStatus(isOnline);
    setText("dashboardCurrentZone", zoneName);
    setText("dashboardCurrentMode", data?.mode || "Ожидание");
    setText("dashboardCurrentWeight", data.weight != null ? `${formatMetric(data.weight, 1)} кг` : "--");
    setText("dashboardLastPacketTime", formatDateTime(data.timestamp));
    renderUnloadProgress(data?.mode, data?.unload_progress);
    renderActiveBatch(data?.active_batch);

    updateMapPosition(data, isOnline);
}

function clearZoneCircles() {
    zoneCircles.forEach((circle) => map.geoObjects.remove(circle));
    zoneCircles = [];
}

function renderZones() {
    if (!map) return;

    clearZoneCircles();

    zoneCircles = storageZones.filter((zone) => Boolean(zone.active)).map((zone) => {
        const shapeLabel = normalizeShapeType(zone.shapeType) === "SQUARE" ? "Квадрат" : "Кружок";
        const zoneColors = getZoneTypeColors(zone);
        const sizeLabel = normalizeShapeType(zone.shapeType) === "SQUARE"
            ? `${Math.max(1, Math.round(Number(zone.sideMeters || DEFAULT_SQUARE_SIDE)))} м`
            : `${Math.max(1, Math.round(Number(zone.radius || DEFAULT_ZONE_RADIUS)))} м`;
        const balloonContent = `
            <strong>${escapeHtml(getZoneLabel(zone))}</strong><br>
            Тип: ${getZoneTypeLabel(zone)}<br>
            Форма: ${shapeLabel}<br>
            Lat: ${Number(zone.lat).toFixed(6)}<br>
            Lon: ${Number(zone.lon).toFixed(6)}<br>
            Размер: ${sizeLabel}
        `;
        const zoneObject = normalizeShapeType(zone.shapeType) === "SQUARE" &&
            Array.isArray(zone.polygonCoords) &&
            zone.polygonCoords.length >= 4
            ? new ymaps.Polygon(
                [zone.polygonCoords],
                { balloonContent },
                {
                    fillColor: zoneColors.fillColor,
                    strokeColor: zoneColors.strokeColor,
                    strokeOpacity: 0.9,
                    strokeWidth: 4,
                }
            )
            : new ymaps.Circle([
                [Number(zone.lat), Number(zone.lon)],
                Number(zone.radius) || DEFAULT_ZONE_RADIUS,
            ], {
                balloonContent,
            }, {
                fillColor: zoneColors.fillColor,
                strokeColor: zoneColors.strokeColor,
                strokeOpacity: 0.9,
                strokeWidth: 4,
            });

        map.geoObjects.add(zoneObject);
        return zoneObject;
    });
}

function clearRoutePolyline() {
    if (!routePolylines.length) return;

    routePolylines.forEach((polyline) => map.geoObjects.remove(polyline));
    routePolylines = [];
}

function clearRtkRoutePolyline() {
    if (!rtkRoutePolylines.length) return;

    rtkRoutePolylines.forEach((polyline) => map.geoObjects.remove(polyline));
    rtkRoutePolylines = [];
}

function parseRouteTimestampMs(value) {
    if (!value) {
        return null;
    }

    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function getHistoryMaxTimestampMs(historyRows) {
    if (!Array.isArray(historyRows)) {
        return null;
    }

    return historyRows.reduce((maxTimestamp, row) => {
        const timestampMs = parseRouteTimestampMs(row?.timestamp);
        if (timestampMs === null) {
            return maxTimestamp;
        }
        return maxTimestamp === null ? timestampMs : Math.max(maxTimestamp, timestampMs);
    }, null);
}

function rememberTrackHistoryMaxTimestamp(track, historyRows) {
    const maxTimestampMs = getHistoryMaxTimestampMs(historyRows);
    if (maxTimestampMs === null) {
        return;
    }

    lastTrackHistoryMaxTimestampMs[track] = Math.max(
        Number(lastTrackHistoryMaxTimestampMs[track] || 0),
        maxTimestampMs
    );
}

function filterVisibleTrackRows(track, historyRows) {
    if (!Array.isArray(historyRows)) {
        return [];
    }

    const clearedThroughMs = Number(visibleTrackClearedThroughMs[track]);
    if (!Number.isFinite(clearedThroughMs) || clearedThroughMs <= 0) {
        return historyRows;
    }

    return historyRows.filter((row) => {
        const timestampMs = parseRouteTimestampMs(row?.timestamp);
        return timestampMs !== null && timestampMs > clearedThroughMs;
    });
}

function buildRoutePoints(historyRows) {
    if (!Array.isArray(historyRows)) {
        return [];
    }

    return historyRows
        .filter((row) => hasValidCoordinates(row?.lat, row?.lon))
        .map((row) => ({
            lat: Number(row.lat),
            lon: Number(row.lon),
            timestampMs: parseRouteTimestampMs(row.timestamp),
            source: row,
        }))
        .filter((point) => point.timestampMs !== null)
        .sort((left, right) => left.timestampMs - right.timestampMs);
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

function buildTrackSegments(historyRows) {
    const points = buildRoutePoints(historyRows);
    const segments = [];
    let currentSegment = [];

    points.forEach((point) => {
        const previousPoint = currentSegment[currentSegment.length - 1];

        if (shouldRenderDashedTrackGap(previousPoint, point)) {
            if (currentSegment.length >= 2) {
                segments.push({
                    coords: currentSegment.map((item) => [item.lat, item.lon]),
                    points: currentSegment.slice(),
                    dashed: false,
                });
            }

            if (canShowDashedTrackGap("host")) {
                segments.push({
                    coords: [
                        [previousPoint.lat, previousPoint.lon],
                        [point.lat, point.lon],
                    ],
                    points: [previousPoint, point],
                    dashed: true,
                });
            }

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

function hasRtkHeadingData(row) {
    if (!row || row.relPosValid === false || row.relPosHeadingValid === false) {
        return false;
    }

    const heading = row.heading ?? row.course;
    return Number.isFinite(Number(heading));
}

function buildRtkTrackSegments(historyRows) {
    const points = buildRoutePoints(historyRows).map((point) => ({
        ...point,
        hasHeading: hasRtkHeadingData(point.source),
    }));
    const segments = [];

    for (let index = 1; index < points.length; index += 1) {
        const previousPoint = points[index - 1];
        const currentPoint = points[index];
        const currentHasHeading = currentPoint.hasHeading;
        const isDashedGap = shouldRenderDashedTrackGap(previousPoint, currentPoint);

        if (isDashedGap && !canShowDashedTrackGap("rtk")) {
            continue;
        }

        segments.push({
            coords: [
                [previousPoint.lat, previousPoint.lon],
                [currentPoint.lat, currentPoint.lon],
            ],
            points: [previousPoint, currentPoint],
            dashed: isDashedGap,
            strokeColor: currentHasHeading ? RTK_FIX_COLOR : RTK_GPS_FIX_COLOR,
        });
    }

    return segments;
}

function createTrackPolylines(segments, options) {
    return segments.map((segment) => {
        const polyline = new ymaps.Polyline(segment.coords, {
            balloonContent: options.balloonContent,
        }, {
            strokeColor: segment.strokeColor || options.strokeColor,
            strokeWidth: options.strokeWidth,
            strokeOpacity: options.strokeOpacity,
            ...(segment.dashed ? { strokeStyle: "dash" } : {}),
        });

        polyline.events.add("click", (event) => {
            const clickedCoords = event.get("coords");
            const points = Array.isArray(segment.points) ? segment.points : [];
            if (!Array.isArray(clickedCoords) || clickedCoords.length < 2 || !points.length) {
                return;
            }

            const closestPoint = points.reduce((bestPoint, point) => {
                const distance = calculateDistanceMeters(
                    { lat: clickedCoords[0], lon: clickedCoords[1] },
                    point
                );
                const bestDistance = bestPoint
                    ? calculateDistanceMeters({ lat: clickedCoords[0], lon: clickedCoords[1] }, bestPoint)
                    : Number.POSITIVE_INFINITY;
                return distance < bestDistance ? point : bestPoint;
            }, null);

            if (closestPoint) {
                polyline.properties.set("balloonContent", formatTrackPointBalloon(options.label || options.balloonContent, closestPoint));
            }
        });

        map.geoObjects.add(polyline);
        return polyline;
    });
}

function renderRoute(historyRows) {
    if (!map) return;

    latestTrackHistory.host = Array.isArray(historyRows) ? historyRows : [];
    rememberTrackHistoryMaxTimestamp("host", historyRows);
    const routeSegments = buildTrackSegments(filterVisibleTrackRows("host", historyRows));

    if (!routeSegments.length) {
        clearRoutePolyline();
        return;
    }

    clearRoutePolyline();
    routePolylines = createTrackPolylines(routeSegments, {
        label: "Маршрут хозяина",
        balloonContent: "Маршрут хозяина",
        strokeColor: HOST_TRACK_COLOR,
        strokeWidth: 4,
        strokeOpacity: 0.75,
    });
}

function renderRtkRoute(historyRows) {
    if (!map) return;

    latestTrackHistory.rtk = Array.isArray(historyRows) ? historyRows : [];
    rememberTrackHistoryMaxTimestamp("rtk", historyRows);
    const routeSegments = buildRtkTrackSegments(filterVisibleTrackRows("rtk", historyRows));

    if (!routeSegments.length) {
        clearRtkRoutePolyline();
        return;
    }

    clearRtkRoutePolyline();
    rtkRoutePolylines = createTrackPolylines(routeSegments, {
        label: "Маршрут погрузчика",
        balloonContent: "Маршрут погрузчика",
        strokeColor: RTK_GPS_FIX_COLOR,
        strokeWidth: 4,
        strokeOpacity: 0.8,
    });
}

function getRetainableTelemetry(track, snapshotRows = []) {
    const currentTelemetry = track === "rtk" ? latestRtkTelemetry : latestTelemetry;

    if (hasValidCoordinates(currentTelemetry?.lat, currentTelemetry?.lon)) {
        return currentTelemetry;
    }

    return Array.isArray(snapshotRows)
        ? snapshotRows.find((row) => hasValidCoordinates(row?.lat, row?.lon)) || null
        : null;
}

async function fetchLatest(options = {}) {
    if (!shouldPoll(lastLatestFetchStartedAt, LATEST_POLL_VISIBLE_MS, LATEST_POLL_HIDDEN_MS, Boolean(options?.force))) {
        return;
    }

    lastLatestFetchStartedAt = Date.now();

    try {
        const [hostResponse, rtkResponse] = await Promise.all([
            fetch(getLatestApiUrl(), { headers: getHeaders() }),
            fetch(getRtkLatestApiUrl(), { headers: getHeaders() }).catch(() => null),
        ]);

        if (!hostResponse.ok) {
            renderDashboard(latestTelemetry);
            return;
        }

        const hostTelemetry = await hostResponse.json();
        if (isEmptyTelemetry(hostTelemetry) && retainedTrackMarkerTelemetry.host) {
            latestTelemetry = retainedTrackMarkerTelemetry.host;
        } else {
            latestTelemetry = hostTelemetry;
            if (!isEmptyTelemetry(hostTelemetry)) {
                retainedTrackMarkerTelemetry.host = null;
            }
        }
        noteTelemetryActivity(latestTelemetry);

        if (rtkResponse && rtkResponse.ok) {
            const rtkTelemetry = await rtkResponse.json();
            if (isEmptyTelemetry(rtkTelemetry) && retainedTrackMarkerTelemetry.rtk) {
                latestRtkTelemetry = retainedTrackMarkerTelemetry.rtk;
            } else {
                latestRtkTelemetry = rtkTelemetry;
                if (!isEmptyTelemetry(rtkTelemetry)) {
                    retainedTrackMarkerTelemetry.rtk = null;
                }
            }
        } else if (rtkResponse && rtkResponse.status === 404) {
            latestRtkTelemetry = retainedTrackMarkerTelemetry.rtk;
            if (!latestRtkTelemetry) {
                hideRtkPlacemark();
            }
        }

        syncTelemetryZoneBanners();
        renderDashboard(latestTelemetry);
        updateRtkMapPosition(latestRtkTelemetry);
    } catch (error) {
        console.error("Error fetching latest:", error);
        renderDashboard(latestTelemetry);
    }
}

async function fetchHistory(options = {}) {
    if (!shouldPoll(lastHistoryFetchStartedAt, HISTORY_POLL_VISIBLE_MS, HISTORY_POLL_HIDDEN_MS, Boolean(options?.force))) {
        return;
    }

    if (isFetchingHistory) {
        return;
    }

    lastHistoryFetchStartedAt = Date.now();
    isFetchingHistory = true;
    const requestedTrackHistoryVersion = { ...trackHistoryVersion };

    try {
        const [hostResponse, rtkResponse] = await Promise.all([
            fetch(getHistoryApiUrl(), { headers: getHeaders() }),
            fetch(getRtkHistoryApiUrl(), { headers: getHeaders() }).catch(() => null),
        ]);

        if (!hostResponse.ok) {
            return;
        }

        const hostHistoryRows = await hostResponse.json();
        if (requestedTrackHistoryVersion.host === trackHistoryVersion.host) {
            renderRoute(hostHistoryRows);
        }

        if (rtkResponse && rtkResponse.ok) {
            const rtkHistoryRows = await rtkResponse.json();
            if (requestedTrackHistoryVersion.rtk === trackHistoryVersion.rtk) {
                renderRtkRoute(rtkHistoryRows);
            }
        }
    } catch (error) {
        console.error("Error fetching history:", error);
    } finally {
        isFetchingHistory = false;
    }
}

function parseWifiClients(value) {
    if (Array.isArray(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    return [];
}

function buildTelemetryRestorePayload(row) {
    return {
        device_id: row.deviceId || "host_01",
        timestamp: row.timestamp,
        lat: row.lat == null ? 0 : Number(row.lat),
        lon: row.lon == null ? 0 : Number(row.lon),
        gps_valid: Boolean(row.gpsValid),
        gps_satellites: Number(row.gpsSatellites) || 0,
        weight: row.weight == null ? 0 : Number(row.weight),
        raw: row.rawWeight == null ? 0 : Number(row.rawWeight),
        weight_valid: Boolean(row.weightValid),
        gps_quality: Number(row.gpsQuality) || 0,
        wifi_clients: parseWifiClients(row.wifiClients),
        cpu_temp_c: row.cpuTempC ?? null,
        lte_rssi_dbm: row.lteRssiDbm ?? null,
        lte_access_tech: row.lteAccessTech ?? null,
        events_reader_ok: Boolean(row.eventsReaderOk),
    };
}

function parseRawPayload(value) {
    if (typeof value !== "string" || !value.trim()) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
}

function buildRtkTelemetryRestorePayload(row) {
    const rawPayload = parseRawPayload(row.rawPayload) || {};

    return {
        ...rawPayload,
        deviceId: row.deviceId || rawPayload.deviceId || rawPayload.device_id || "host_01",
        timestamp: row.timestamp || rawPayload.timestamp,
        lat: row.lat == null ? rawPayload.lat : Number(row.lat),
        lon: row.lon == null ? rawPayload.lon : Number(row.lon),
        quality: row.quality ?? rawPayload.quality ?? rawPayload.fixQuality ?? null,
        rtkQuality: row.rtkQuality ?? row.qualityLabel ?? rawPayload.rtkQuality ?? null,
        rtkAge: row.rtkAge ?? row.corrAgeS ?? rawPayload.rtkAge ?? null,
        speed: row.speed ?? rawPayload.speed ?? null,
        course: row.course ?? rawPayload.course ?? null,
        supplyVoltage: row.supplyVoltage ?? rawPayload.supplyVoltage ?? null,
        satellites: row.satellites ?? rawPayload.satellites ?? null,
        fixType: row.fixType ?? rawPayload.fixType ?? null,
    };
}

function getTrackConfig(track) {
    if (track === "rtk") {
        return {
            apiBase: RTK_API_BASE,
            clearApi: CLEAR_RTK_HISTORY_API,
            historyApi: getRtkHistoryApiUrl(),
            buttonId: "clearRtkTelemetryButton",
            label: "Погрузчик",
            buildRestorePayload: buildRtkTelemetryRestorePayload,
            afterClear: (snapshotRows = []) => {
                clearRtkRoutePolyline();
                retainedTrackMarkerTelemetry.rtk = getRetainableTelemetry("rtk", snapshotRows);
                latestRtkTelemetry = retainedTrackMarkerTelemetry.rtk || latestRtkTelemetry;
                updateRtkMapPosition(latestRtkTelemetry);
                syncTelemetryZoneBanners();
                syncMapActionButtons();
            },
        };
    }

    return {
        apiBase: API_BASE,
        clearApi: CLEAR_HOST_HISTORY_API,
        historyApi: getHistoryApiUrl(),
        buttonId: "clearHostTelemetryButton",
        label: "Хозяин",
        enableUndo: false,
        buildRestorePayload: buildTelemetryRestorePayload,
        afterClear: (snapshotRows = []) => {
            clearRoutePolyline();
            retainedTrackMarkerTelemetry.host = getRetainableTelemetry("host", snapshotRows);
            latestTelemetry = retainedTrackMarkerTelemetry.host || latestTelemetry;
            renderDashboard(latestTelemetry);
            syncTelemetryZoneBanners();
            syncMapActionButtons();
        },
    };
}

async function fetchTelemetrySnapshot(track) {
    const config = getTrackConfig(track);
    const response = await fetch(config.historyApi, { headers: getHeaders() });
    if (!response.ok) {
        let errorMessage = `Не удалось получить историю трека (${config.label}) перед очисткой`;

        try {
            const payload = await response.json();
            if (payload?.error) {
                errorMessage = payload.error;
            }
        } catch (error) {
            // keep generic message when response body is not JSON
        }

        throw new Error(errorMessage);
    }

    const historyRows = await response.json();
    return Array.isArray(historyRows) ? historyRows : [];
}

async function restoreTelemetryHistory(context) {
    if (!pendingTelemetryUndo) {
        return;
    }

    const snapshot = pendingTelemetryUndo;
    const alertElement = context?.alert || currentUndoAlert || null;
    const actionButton = context?.button || null;

    if (actionButton) {
        actionButton.disabled = true;
        actionButton.textContent = "Восстановление...";
    }

    if (undoAlertTimerId) {
        clearTimeout(undoAlertTimerId);
        undoAlertTimerId = null;
    }

    pendingTelemetryUndo = null;

    try {
        const rowsToRestore = Array.isArray(snapshot.rows) ? snapshot.rows.slice().reverse() : [];
        const config = getTrackConfig(snapshot.track);

        if (!rowsToRestore.length) {
            removeUndoAlert();
            window.AppAuth?.showAlert?.(`Трек (${config.label}) уже был пустой`, "warning");
            return;
        }

        for (const row of rowsToRestore) {
            const response = await fetch(config.apiBase, {
                method: "POST",
                headers: getHeaders(),
                body: JSON.stringify(config.buildRestorePayload(row)),
            });

            if (!response.ok) {
                let errorMessage = `Не удалось отменить очистку трека (${config.label})`;

                try {
                    const payload = await response.json();
                    if (payload?.error) {
                        errorMessage = payload.error;
                    }
                } catch (error) {
                    // keep generic message when response body is not JSON
                }

                throw new Error(errorMessage);
            }
        }

        removeUndoAlert();

        await Promise.all([fetchLatest({ force: true }), fetchHistory({ force: true }), fetchZones({ force: true })]);
        window.AppAuth?.showAlert?.(`Очистка трека (${config.label}) отменена`, "success");
    } catch (error) {
        pendingTelemetryUndo = snapshot;

        if (actionButton) {
            actionButton.disabled = false;
            actionButton.textContent = "Отменить";
        }

        window.AppAuth?.showAlert?.(error.message || "Не удалось отменить очистку трека", "danger");
    }
}

function resolveAlertHost() {
    return (
        document.querySelector("[data-page-alerts]") ||
        document.querySelector(".container-fluid") ||
        document.querySelector(".page-wrapper") ||
        document.querySelector(".container") ||
        document.body
    );
}

function removeUndoAlert() {
    if (undoAlertTimerId) {
        clearTimeout(undoAlertTimerId);
        undoAlertTimerId = null;
    }

    if (currentUndoAlert?.isConnected) {
        currentUndoAlert.remove();
    }

    currentUndoAlert = null;
}

function showTelemetryUndoAlert(trackLabel) {
    removeUndoAlert();
    const alert = window.AppAuth?.showAlert?.(`Трек (${trackLabel}) очищен`, "success", {
        actionLabel: "Отменить",
        actionClassName: "btn btn-sm font-weight-bold mt-2 mt-sm-0 px-3 flex-shrink-0",
        onAction: ({ alert: alertElement, button, text }) => {
            restoreTelemetryHistory({ alert: alertElement, button, text });
        },
    });

    const actionButton = alert?.querySelector("button");
    if (actionButton) {
        actionButton.style.backgroundColor = "#ffffff";
        actionButton.style.color = "#157347";
        actionButton.style.border = "1px solid #157347";
    }

    currentUndoAlert = alert || null;
    undoAlertTimerId = window.setTimeout(() => {
        removeUndoAlert();
    }, 10000);
}

async function clearTelemetryHistory(track = "host") {
    if (!hasWriteAccess()) {
        return;
    }

    const config = getTrackConfig(track);
    pendingTelemetryUndo = null;

    const button = document.getElementById(config.buttonId);
    if (button) {
        button.disabled = true;
    }

    try {
        const latestTimestampMs = parseRouteTimestampMs(track === "rtk"
            ? latestRtkTelemetry?.timestamp
            : latestTelemetry?.timestamp);
        const historyMaxTimestampMs = Number(lastTrackHistoryMaxTimestampMs[track]);
        const knownTrackTimestampMs = Math.max(
            Number.isFinite(latestTimestampMs) ? latestTimestampMs : 0,
            Number.isFinite(historyMaxTimestampMs) ? historyMaxTimestampMs : 0
        );
        const clearedThroughMs = knownTrackTimestampMs > 0 ? knownTrackTimestampMs : Date.now();

        visibleTrackClearedThroughMs[track] = clearedThroughMs;
        trackHistoryVersion[track] += 1;
        if (track === "rtk") {
            clearRtkRoutePolyline();
        } else {
            clearRoutePolyline();
        }
        syncMapActionButtons();
        removeUndoAlert();
        pendingTelemetryUndo = null;
        window.AppAuth?.showAlert?.(`Трек (${config.label}) убран с главной карты`, "success");
    } catch (error) {
        console.error("Error clearing telemetry history:", error);
        window.AppAuth?.showAlert?.(error.message || `Не удалось очистить трек (${config.label})`, "danger");
    } finally {
        if (button) {
            button.disabled = false;
        }
    }
}

async function fetchZones(options = {}) {
    if (!shouldPoll(lastZonesFetchStartedAt, ZONES_POLL_VISIBLE_MS, ZONES_POLL_HIDDEN_MS, Boolean(options?.force))) {
        return;
    }

    if (isFetchingZones) {
        return;
    }

    lastZonesFetchStartedAt = Date.now();
    isFetchingZones = true;

    try {
        const response = await fetch(ZONES_API, {
            headers: getHeaders(),
            cache: "no-store",
        });
        if (!response.ok) return;

        const zonesPayload = await response.json();
        storageZones = Array.isArray(zonesPayload) ? zonesPayload.map(normalizeZone) : [];
        renderZones();
        renderDashboard(latestTelemetry);
    } catch (error) {
        console.error("Error fetching zones:", error);
    } finally {
        isFetchingZones = false;
    }
}

function handleVisibilityChange() {
    if (document.visibilityState !== "visible") {
        return;
    }

    fetchZones({ force: true });
    fetchLatest({ force: true });
    fetchHistory({ force: true });
}

function getBannerOffsetTop() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) {
        return 15;
    }

    const topbarRect = topbar.getBoundingClientRect();
    return Math.max(15, Math.round(topbarRect.bottom + 12));
}

function updateBannerContainerPosition(container) {
    if (!container) {
        return;
    }

    container.style.top = `${getBannerOffsetTop()}px`;
}

function ensureBannerStyles() {
    if (document.getElementById("dashboardBannerStyles")) {
        return;
    }

    const style = document.createElement("style");
    style.id = "dashboardBannerStyles";
    style.textContent = `
        @keyframes bannerInFinal { from { opacity: 0; transform: translateY(-15px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes bannerOutFinal { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.9); } }
        #banner-container {
            position: fixed;
            right: 20px;
            z-index: 99999;
            display: flex;
            flex-direction: row;
            justify-content: flex-end;
            align-items: flex-start;
            gap: 10px;
            max-width: calc(100vw - 40px);
            pointer-events: none;
        }
        .dashboard-zone-banner {
            color: white;
            padding: 10px 18px;
            border-radius: 20px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px;
            font-weight: 700;
            line-height: 1.4;
            opacity: 0;
            animation: bannerInFinal 0.4s ease-out forwards;
            cursor: default;
            pointer-events: none;
            white-space: nowrap;
        }
        .dashboard-zone-banner--host {
            background-color: #3F6FAE;
            box-shadow: 0 5px 12px rgba(63, 111, 174, 0.28);
        }
        .dashboard-zone-banner--rtk {
            background-color: #5F8A6B;
            box-shadow: 0 5px 12px rgba(95, 138, 107, 0.28);
        }
        @media (max-width: 576px) {
            #banner-container {
                left: 16px;
                right: 16px !important;
                width: auto !important;
                max-width: none !important;
                flex-direction: column;
                align-items: stretch !important;
            }
            .dashboard-zone-banner {
                white-space: normal;
                text-align: center;
            }
        }
    `;
    document.head.appendChild(style);
}

function ensureBannerContainer() {
    let container = document.getElementById("banner-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "banner-container";
        document.body.appendChild(container);
    }

    ensureBannerStyles();
    updateBannerContainerPosition(container);
    return container;
}

function clearBannerDismissTimer() {
    if (!bannerDismissTimerId) {
        return;
    }

    window.clearTimeout(bannerDismissTimerId);
    bannerDismissTimerId = null;
}

function scheduleZoneBannerDismiss() {
    clearBannerDismissTimer();
    bannerDismissTimerId = window.setTimeout(() => {
        dismissCurrentBanner();
    }, ZONE_BANNER_DISPLAY_MS);
}

function dismissCurrentBanner() {
    clearBannerDismissTimer();

    if (!currentBannerElement) {
        currentBannerType = null;
        lastShownZone = null;
        dismissZoneBanner("host");
        dismissZoneBanner("rtk");
        return;
    }

    currentBannerElement.style.animation = "bannerOutFinal 0.5s ease-in forwards";
    const elementToRemove = currentBannerElement;

    setTimeout(() => {
        if (elementToRemove?.isConnected) {
            elementToRemove.remove();
        }
    }, 500);

    currentBannerElement = null;
    currentBannerType = null;
    lastShownZone = null;
    dismissZoneBanner("host");
    dismissZoneBanner("rtk");
}

function dismissZoneBanner(source) {
    const elementToRemove = currentZoneBannerElements[source];
    if (!elementToRemove) {
        lastShownZoneBannerKeys[source] = null;
        return;
    }

    elementToRemove.style.animation = "bannerOutFinal 0.35s ease-in forwards";
    setTimeout(() => {
        if (elementToRemove?.isConnected) {
            elementToRemove.remove();
        }
    }, 350);

    currentZoneBannerElements[source] = null;
    lastShownZoneBannerKeys[source] = null;
}

function parseZoneNameFromBanner(banner) {
    if (!banner) {
        return "";
    }

    const explicitName = banner.zoneName || banner.name;
    if (explicitName) {
        return String(explicitName).trim();
    }

    const message = typeof banner.message === "string" ? banner.message.trim() : "";
    const zoneMatch = message.match(/^Зона:\s*(.+)$/i);
    if (zoneMatch) {
        return zoneMatch[1].trim();
    }

    return "";
}

function getTelemetryZoneBannerName(data) {
    const bannerZoneName = parseZoneNameFromBanner(data?.banner);
    if (bannerZoneName) {
        return bannerZoneName;
    }

    if (data?.zone?.name) {
        return String(data.zone.name).trim();
    }

    if (hasValidCoordinates(data?.lat, data?.lon)) {
        return getCurrentZoneName(Number(data.lat), Number(data.lon)) || "";
    }

    return "";
}

function buildZoneBanner(source, data) {
    const zoneName = getTelemetryZoneBannerName(data);
    if (!zoneName || zoneName === "Вне зоны") {
        return null;
    }

    return {
        source,
        text: `Зона: ${zoneName}`,
    };
}

function renderZoneBanner(container, source, banner) {
    if (!banner) {
        dismissZoneBanner(source);
        return;
    }

    const bannerKey = `${source}:${banner.text}`;
    if (lastShownZoneBannerKeys[source] === bannerKey && currentZoneBannerElements[source]) {
        return;
    }

    dismissZoneBanner(source);

    const alert = document.createElement("div");
    alert.className = `dashboard-zone-banner dashboard-zone-banner--${source}`;
    alert.textContent = banner.text;
    alert.dataset.bannerSource = source;

    container.appendChild(alert);
    currentZoneBannerElements[source] = alert;
    lastShownZoneBannerKeys[source] = bannerKey;
}

function showZoneBanners(banners = {}) {
    clearBannerDismissTimer();
    removeUndoAlert();

    const hasAnyBanner = Boolean(banners.host || banners.rtk);
    if (!hasAnyBanner) {
        dismissZoneBanner("host");
        dismissZoneBanner("rtk");
        return;
    }

    const container = ensureBannerContainer();
    renderZoneBanner(container, "host", banners.host || null);
    renderZoneBanner(container, "rtk", banners.rtk || null);
}

function syncTelemetryZoneBanners() {
    showZoneBanners({
        host: buildZoneBanner("host", latestTelemetry),
        rtk: buildZoneBanner("rtk", latestRtkTelemetry),
    });
}

function showBanner(banner) {
    if (!banner) {
        showZoneBanners({});
        return;
    }

    showZoneBanners({
        host: {
            source: "host",
            text: banner.message || `Зона: ${parseZoneNameFromBanner(banner) || "без названия"}`,
        },
    });
}

function updateMapTypeButtons() {
    if (!mapTypeButtons.length || !map) {
        return;
    }

    const activeType = map.getType();

    mapTypeButtons.forEach((button) => {
        const isActive = button.dataset.mapType === activeType;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-pressed", String(isActive));
    });
}

function setMapType(mapType) {
    if (!map || !mapType || map.getType() === mapType) {
        return;
    }

    map.setType(mapType);
    updateMapTypeButtons();
}

function initMapTypeSwitch() {
    mapTypeButtons = Array.from(document.querySelectorAll(".map-view-switch__button[data-map-type]"));

    mapTypeButtons.forEach((button) => {
        button.addEventListener("click", () => {
            setMapType(button.dataset.mapType);
        });
    });

    updateMapTypeButtons();
    map.events.add("typechange", updateMapTypeButtons);
}

function removeCursorAccessor(accessor) {
    if (accessor) {
        accessor.remove();
    }

    return null;
}

function applyIdleMapCursor() {
    dragCursorAccessor = removeCursorAccessor(dragCursorAccessor);

    if (!idleCursorAccessor) {
        idleCursorAccessor = map.cursors.push("arrow");
    }
}

function applyDragMapCursor() {
    idleCursorAccessor = removeCursorAccessor(idleCursorAccessor);

    if (!dragCursorAccessor) {
        dragCursorAccessor = map.cursors.push("grabbing");
    }
}

function init() {
    map = new ymaps.Map("map", {
        center: DEFAULT_COORDS,
        zoom: 12,
        type: DEFAULT_MAP_TYPE,
        controls: ["zoomControl"],
    }, {
        geoObjectCursor: "arrow",
        suppressMapOpenBlock: true,
        yandexMapDisablePoiInteractivity: true,
    });

    placemark = new ymaps.Placemark(DEFAULT_COORDS, {}, getMarkerOptions("host", false));

    initMapTypeSwitch();
    initMapActionControls();
    initDashedTrackControls();
    applyIdleMapCursor();
    map.events.add("actionbegin", applyDragMapCursor);
    map.events.add("actionend", handleMapActionEnd);
    map.events.add("actionbreak", handleMapActionEnd);

    renderDashboard(null);
    fetchZones({ force: true });
    fetchLatest({ force: true });
    fetchHistory({ force: true });
    setInterval(() => {
        void fetchLatest();
        void fetchHistory();
        void fetchZones();
    }, POLL_TICK_INTERVAL_MS);

    const clearHostTelemetryButton = document.getElementById("clearHostTelemetryButton");
    if (clearHostTelemetryButton) {
        clearHostTelemetryButton.addEventListener("click", () => clearTelemetryHistory("host"));
    }

    const clearRtkTelemetryButton = document.getElementById("clearRtkTelemetryButton");
    if (clearRtkTelemetryButton) {
        clearRtkTelemetryButton.addEventListener("click", () => clearTelemetryHistory("rtk"));
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
}

ymaps.ready(init);

const API_HOST = window.AppAuth?.getApiUrl?.("") || "";

const ZONES_API = API_HOST + "/api/telemetry/zones";
const TELEMETRY_API = API_HOST + "/api/telemetry/host/current";
const RTK_TELEMETRY_API = API_HOST + "/api/telemetry/rtk/current";

const CREATE_MODE_TITLE = "Добавление зоны";
const EDIT_MODE_TITLE = "Редактирование зоны";
const CREATE_SUBMIT_LABEL = "Добавить зону";
const EDIT_SUBMIT_LABEL = "Сохранить зону";
const DEFAULT_ZONE_RADIUS = 20;
const DEFAULT_SQUARE_SIDE = 40;
const DEFAULT_STATUS_MESSAGE = "Готово к работе";
const DEFAULT_MAP_CENTER = [52.428863, 85.706438];
const DEFAULT_MAP_ZOOM = 15;
const DEFAULT_MAP_TYPE = "yandex#satellite";
const TELEMETRY_FRESHNESS_MS = 15000;
const ZONE_TYPE_STORAGE = "STORAGE";
const ZONE_TYPE_BARN = "BARN";
const HOST_TRACK_COLOR = "#3F6FAE";
const RTK_GPS_FIX_COLOR = "#B65F55";
const RTK_FIX_COLOR = "#5F8A6B";
const OFFLINE_MARKER_COLOR = "#8A8F93";
const HOST_MARKER_IMAGE_URL = "img/host.svg";
const RTK_MARKER_IMAGE_URL = "img/rtk.svg";

let map;
let deviceMarker = null;
let rtkMarker = null;

let zones = [];
let zoneCircles = [];
let selectedZoneId = null;
let lastTelemetry = null;
let lastRtkTelemetry = null;
let suppressNextMapClick = false;
let mapTypeButtons = [];
let idleCursorAccessor = null;
let dragCursorAccessor = null;
let mapFullscreenButton = null;
let mapWrapElement = null;
let hasTelemetryAutoFocus = false;
let previewShape = null;
let previewCornerMarkers = [];
let previewLoadingWallLine = null;
let previewCircleCenterMarker = null;
let previewCircleRadiusMarker = null;
let mapViewportFitTimer = null;

const shapeTypeInput = document.getElementById("shapeType");
const zoneTypeInput = document.getElementById("zoneType");
const circleFields = document.getElementById("circleFields");
const squareFields = document.getElementById("squareFields");
const sideMetersInput = document.getElementById("sideMeters");
const loadingWallSideInput = document.getElementById("loadingWallSide");
const squareCornerInputs = [
    {
        lat: document.getElementById("squareCorner1Lat"),
        lon: document.getElementById("squareCorner1Lon"),
    },
    {
        lat: document.getElementById("squareCorner2Lat"),
        lon: document.getElementById("squareCorner2Lon"),
    },
    {
        lat: document.getElementById("squareCorner3Lat"),
        lon: document.getElementById("squareCorner3Lon"),
    },
    {
        lat: document.getElementById("squareCorner4Lat"),
        lon: document.getElementById("squareCorner4Lon"),
    },
];

ymaps.ready(init);

function canWrite() {
    return window.AppAuth?.hasWriteAccess?.() ?? false;
}

function getHeaders(includeJson = false) {
    return window.AppAuth?.getAuthHeaders?.({ includeJson }) || {};
}

function normalizeZoneText(value) {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value).trim();
}

function looksBrokenZoneText(value) {
    if (!value) {
        return true;
    }

    return /^[?]+$/.test(value) || /^[\uFFFD]+$/u.test(value);
}

function getZoneLabel(zone) {
    const ingredient = normalizeZoneText(zone?.ingredient);
    const name = normalizeZoneText(zone?.name);

    if (ingredient && !looksBrokenZoneText(ingredient)) {
        return ingredient;
    }

    if (name && !looksBrokenZoneText(name)) {
        return name;
    }

    return ingredient || name || "Без названия";
}

function parseNumberValue(value) {
    if (value === "" || value === null || value === undefined) {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeShapeType(value) {
    return String(value || "CIRCLE").trim().toUpperCase() === "SQUARE" ? "SQUARE" : "CIRCLE";
}

function normalizeZoneType(value) {
    return String(value || "").trim().toUpperCase() === ZONE_TYPE_BARN ? ZONE_TYPE_BARN : ZONE_TYPE_STORAGE;
}

function parseLoadingWallSide(value) {
    if (value === "" || value === null || value === undefined) {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 3 ? parsed : null;
}

function getLoadingWallLabel(value) {
    const side = parseLoadingWallSide(value);
    if (side === null) {
        return "Не выбрана";
    }

    return `Угол ${side + 1} - угол ${side === 3 ? 1 : side + 2}`;
}

function getLoadingWallCoords(polygonCoords, loadingWallSide) {
    const side = parseLoadingWallSide(loadingWallSide);
    if (side === null || !Array.isArray(polygonCoords) || polygonCoords.length < 4) {
        return null;
    }

    return [
        polygonCoords[side],
        polygonCoords[(side + 1) % 4],
    ];
}

function getZoneTypeLabel(zoneOrType) {
    const zoneType = typeof zoneOrType === "string" ? normalizeZoneType(zoneOrType) : normalizeZoneType(zoneOrType?.zoneType);
    return zoneType === ZONE_TYPE_BARN ? "Коровник" : "Зона хранения";
}

function getZoneTypeColor(zone, isSelected) {
    if (isSelected) {
        return {
            fillColor: "rgba(232,185,0,0.40)",
            strokeColor: "#F3C21D",
        };
    }

    return normalizeZoneType(zone?.zoneType) === ZONE_TYPE_BARN
        ? { fillColor: "rgba(63,111,174,0.34)", strokeColor: "#3F6FAE" }
        : { fillColor: "rgba(47,159,85,0.36)", strokeColor: "#18B35B" };
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

function isRtkFixed(data) {
    const label = String(data?.qualityLabel || data?.rtkQuality || "").toLowerCase();
    const quality = Number(data?.quality);
    return label.includes("fixed") || quality >= 4;
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
    const color = !isOnline
        ? OFFLINE_MARKER_COLOR
        : kind === "rtk"
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

function isValidLat(value) {
    return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLon(value) {
    return Number.isFinite(value) && value >= -180 && value <= 180;
}

function metersPerLonDegree(lat) {
    return Math.max(Math.cos(lat * Math.PI / 180) * 111320, 1);
}

function getDistanceMeters(firstCoords, secondCoords) {
    if (ymaps?.coordSystem?.geo?.getDistance) {
        return ymaps.coordSystem.geo.getDistance(firstCoords, secondCoords);
    }

    const earthRadiusMeters = 6371000;
    const firstLat = Number(firstCoords[0]) * Math.PI / 180;
    const secondLat = Number(secondCoords[0]) * Math.PI / 180;
    const latDelta = secondLat - firstLat;
    const lonDelta = (Number(secondCoords[1]) - Number(firstCoords[1])) * Math.PI / 180;
    const halfChord = Math.sin(latDelta / 2) ** 2
        + Math.cos(firstLat) * Math.cos(secondLat) * Math.sin(lonDelta / 2) ** 2;

    return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(halfChord), Math.sqrt(1 - halfChord));
}

function getCircleRadiusHandleCoords(centerCoords, radiusMeters) {
    const lat = Number(centerCoords[0]);
    const lon = Number(centerCoords[1]);
    const radius = Number(radiusMeters);

    return [lat, lon + (radius / metersPerLonDegree(lat))];
}

function buildSquareBoundsFromCenter(lat, lon, sideMeters) {
    const halfSideMeters = sideMeters / 2;
    const latDelta = halfSideMeters / 111320;
    const lonDelta = halfSideMeters / metersPerLonDegree(lat);

    return {
        lat,
        lon,
        sideMeters,
        squareMinLat: lat - latDelta,
        squareMinLon: lon - lonDelta,
        squareMaxLat: lat + latDelta,
        squareMaxLon: lon + lonDelta,
    };
}

function buildSquarePolygonFromCenter(lat, lon, sideMeters) {
    const bounds = buildSquareBoundsFromCenter(lat, lon, sideMeters);
    return [
        [bounds.squareMaxLat, bounds.squareMinLon],
        [bounds.squareMaxLat, bounds.squareMaxLon],
        [bounds.squareMinLat, bounds.squareMaxLon],
        [bounds.squareMinLat, bounds.squareMinLon],
    ];
}

function buildSquareMetaFromBounds(minLat, minLon, maxLat, maxLon) {
    const normalizedMinLat = Math.min(minLat, maxLat);
    const normalizedMaxLat = Math.max(minLat, maxLat);
    const normalizedMinLon = Math.min(minLon, maxLon);
    const normalizedMaxLon = Math.max(minLon, maxLon);
    const lat = (normalizedMinLat + normalizedMaxLat) / 2;
    const lon = (normalizedMinLon + normalizedMaxLon) / 2;
    const latMeters = (normalizedMaxLat - normalizedMinLat) * 111320;
    const lonMeters = (normalizedMaxLon - normalizedMinLon) * metersPerLonDegree(lat);

    return {
        lat,
        lon,
        sideMeters: Math.max(latMeters, lonMeters),
        squareMinLat: normalizedMinLat,
        squareMinLon: normalizedMinLon,
        squareMaxLat: normalizedMaxLat,
        squareMaxLon: normalizedMaxLon,
    };
}

function getSquarePolygonCoords(zone) {
    if (Array.isArray(zone.polygonCoords) && zone.polygonCoords.length >= 4) {
        return [zone.polygonCoords.map((point) => [Number(point[0]), Number(point[1])])];
    }

    return [buildSquarePolygonFromCenter(
        Number(zone.lat),
        Number(zone.lon),
        Number(zone.sideMeters || DEFAULT_SQUARE_SIDE)
    )];
}

function getSquareCornerCoords(zone) {
    return getSquarePolygonCoords(zone)[0];
}

function normalizeZone(zone) {
    let polygonCoords = null;

    if (zone.polygonCoords) {
        try {
            const parsed = typeof zone.polygonCoords === "string" ? JSON.parse(zone.polygonCoords) : zone.polygonCoords;
            if (Array.isArray(parsed) && parsed.length >= 4) {
                polygonCoords = parsed.map((point) => [Number(point[0]), Number(point[1])]);
            }
        } catch {
            polygonCoords = null;
        }
    }

    const normalized = {
        ...zone,
        zoneType: normalizeZoneType(zone.zoneType),
        shapeType: normalizeShapeType(zone.shapeType),
        lat: Number(zone.lat),
        lon: Number(zone.lon),
        radius: Number(zone.radius ?? DEFAULT_ZONE_RADIUS),
        sideMeters: parseNumberValue(zone.sideMeters),
        polygonCoords,
        squareMinLat: parseNumberValue(zone.squareMinLat),
        squareMinLon: parseNumberValue(zone.squareMinLon),
        squareMaxLat: parseNumberValue(zone.squareMaxLat),
        squareMaxLon: parseNumberValue(zone.squareMaxLon),
        loadingWallSide: parseLoadingWallSide(zone.loadingWallSide),
        loadingNormalDeg: parseNumberValue(zone.loadingNormalDeg),
    };

    if (normalized.shapeType === "SQUARE" && Array.isArray(normalized.polygonCoords) && normalized.polygonCoords.length >= 4) {
        const lats = normalized.polygonCoords.map((point) => Number(point[0]));
        const lons = normalized.polygonCoords.map((point) => Number(point[1]));
        Object.assign(
            normalized,
            buildSquareMetaFromBounds(
                Math.min(...lats),
                Math.min(...lons),
                Math.max(...lats),
                Math.max(...lons)
            )
        );
    } else if (
        normalized.shapeType === "SQUARE" &&
        isValidLat(normalized.squareMinLat) &&
        isValidLon(normalized.squareMinLon) &&
        isValidLat(normalized.squareMaxLat) &&
        isValidLon(normalized.squareMaxLon)
    ) {
        normalized.polygonCoords = buildSquarePolygonFromCenter(
            normalized.lat,
            normalized.lon,
            normalized.sideMeters || DEFAULT_SQUARE_SIDE
        );
        Object.assign(
            normalized,
            buildSquareMetaFromBounds(
                normalized.squareMinLat,
                normalized.squareMinLon,
                normalized.squareMaxLat,
                normalized.squareMaxLon
            )
        );
    }

    return normalized;
}

function hasTelemetryTimestamp(value) {
    if (!value) {
        return false;
    }

    const timestamp = new Date(value).getTime();
    return !Number.isNaN(timestamp);
}

function isFreshTelemetry(value, thresholdMs = TELEMETRY_FRESHNESS_MS) {
    if (!hasTelemetryTimestamp(value)) {
        return false;
    }

    return (Date.now() - new Date(value).getTime()) < thresholdMs;
}

function getRtkFreshnessMs(data) {
    const timeoutMinutes = Number(data?.loaderOfflineTimeoutMinutes);
    return Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
        ? timeoutMinutes * 60 * 1000
        : TELEMETRY_FRESHNESS_MS;
}

function isFreshRtkTelemetry(data) {
    return isFreshTelemetry(data?.timestamp, getRtkFreshnessMs(data));
}

function getSelectedZone() {
    return zones.find((item) => String(item.id) === String(selectedZoneId)) || null;
}

function isCreateMode() {
    return !selectedZoneId;
}

function getCurrentShapeType() {
    return normalizeShapeType(shapeTypeInput?.value);
}

function updateShapeSections() {
    const shapeType = getCurrentShapeType();
    circleFields?.classList.toggle("is-active", shapeType === "CIRCLE");
    squareFields?.classList.toggle("is-active", shapeType === "SQUARE");
}

function setSquareCornerInputs(polygonCoords) {
    if (!Array.isArray(polygonCoords) || polygonCoords.length < 4) {
        return;
    }

    squareCornerInputs.forEach((inputs, index) => {
        const point = polygonCoords[index];
        if (!inputs?.lat || !inputs?.lon || !point) {
            return;
        }

        inputs.lat.value = Number(point[0]).toFixed(7);
        inputs.lon.value = Number(point[1]).toFixed(7);
    });
}

function readSquareCornerInputs() {
    const coords = squareCornerInputs.map((inputs) => {
        const lat = parseNumberValue(inputs?.lat?.value);
        const lon = parseNumberValue(inputs?.lon?.value);
        return isValidLat(lat) && isValidLon(lon) ? [lat, lon] : null;
    });

    return coords.every(Boolean) ? coords : null;
}

function computeMetaFromPolygon(polygonCoords) {
    if (!Array.isArray(polygonCoords) || polygonCoords.length < 4) {
        return null;
    }

    const lats = polygonCoords.map((point) => Number(point[0]));
    const lons = polygonCoords.map((point) => Number(point[1]));
    const boundsMeta = buildSquareMetaFromBounds(
        Math.min(...lats),
        Math.min(...lons),
        Math.max(...lats),
        Math.max(...lons)
    );

    return {
        ...boundsMeta,
        polygonCoords,
    };
}

function syncSquareInputsFromCenterAndSide() {
    const lat = parseNumberValue(document.getElementById("lat")?.value);
    const lon = parseNumberValue(document.getElementById("lon")?.value);
    const sideMeters = parseNumberValue(sideMetersInput?.value) ?? DEFAULT_SQUARE_SIDE;

    if (!isValidLat(lat) || !isValidLon(lon) || sideMeters <= 0) {
        return null;
    }

    const polygonCoords = buildSquarePolygonFromCenter(lat, lon, sideMeters);
    const meta = computeMetaFromPolygon(polygonCoords);
    setSquareCornerInputs(polygonCoords);
    return meta;
}

function syncSquareDerivedFieldsFromBounds() {
    const polygonCoords = readSquareCornerInputs();
    if (!polygonCoords) {
        return null;
    }

    const meta = computeMetaFromPolygon(polygonCoords);
    const latInput = document.getElementById("lat");
    const lonInput = document.getElementById("lon");

    if (latInput) latInput.value = Number(meta.lat).toFixed(7);
    if (lonInput) lonInput.value = Number(meta.lon).toFixed(7);
    if (sideMetersInput) sideMetersInput.value = String(Math.max(1, Math.round(meta.sideMeters)));

    return meta;
}

function init() {
    map = new ymaps.Map("map", {
        center: DEFAULT_MAP_CENTER,
        zoom: DEFAULT_MAP_ZOOM,
        type: DEFAULT_MAP_TYPE,
        controls: ["zoomControl"],
    }, {
        geoObjectCursor: "arrow",
        suppressMapOpenBlock: true,
        yandexMapDisablePoiInteractivity: true,
    });

    initMapTypeSwitch();
    initMapActionControls();
    applyIdleMapCursor();
    map.events.add("actionbegin", applyDragMapCursor);
    map.events.add("actionend", handleMapActionEnd);
    map.events.add("actionbreak", handleMapActionEnd);

    bindUI();
    bindMapClick();
    bindOutsideSelectionReset();
    resetZoneEditor();

    loadZones();
    refreshTelemetryLayers();

    setInterval(refreshTelemetryLayers, 5000);
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

function suppressMapClickBriefly() {
    suppressNextMapClick = true;
    window.setTimeout(() => {
        suppressNextMapClick = false;
    }, 150);
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

function syncMapActionButtons() {
    if (!mapFullscreenButton) {
        return;
    }

    const isFullscreen = document.fullscreenElement === mapWrapElement;
    const icon = mapFullscreenButton.querySelector("i");
    mapFullscreenButton.classList.toggle("is-active", isFullscreen);
    mapFullscreenButton.setAttribute("aria-pressed", String(isFullscreen));

    if (icon) {
        icon.className = isFullscreen ? "fas fa-compress-arrows-alt" : "fas fa-expand-arrows-alt";
    }
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

function scheduleMapViewportFit() {
    if (!map) {
        return;
    }

    window.clearTimeout(mapViewportFitTimer);
    mapViewportFitTimer = window.setTimeout(() => {
        map?.container.fitToViewport();
    }, 120);
}

function handleMapActionEnd() {
    applyIdleMapCursor();
}

function initMapActionControls() {
    mapWrapElement = document.querySelector(".dashboard-map-wrap");
    mapFullscreenButton = document.getElementById("mapFullscreenButton");

    if (mapFullscreenButton) {
        mapFullscreenButton.addEventListener("click", toggleMapFullscreen);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    window.addEventListener("resize", scheduleMapViewportFit);
    window.addEventListener("orientationchange", scheduleMapViewportFit);
    syncMapActionButtons();
}

function bindUI() {
    const zoneForm = document.getElementById("zone-form");
    const deleteZoneBtn = document.getElementById("delete-zone-btn");
    const goToDeviceBtn = document.getElementById("go-to-device-btn");

    if (zoneForm) {
        zoneForm.addEventListener("submit", onZoneFormSubmit);
    }

    if (deleteZoneBtn) {
        deleteZoneBtn.addEventListener("click", onDeleteZoneClick);
    }

    if (goToDeviceBtn) {
        goToDeviceBtn.addEventListener("click", goToCurrentPoint);
    }

    shapeTypeInput?.addEventListener("change", () => {
        updateShapeSections();

        if (getCurrentShapeType() === "SQUARE") {
            syncSquareInputsFromCenterAndSide();
        }

        renderZonePreview();
    });

    ["zoneType", "ingredient", "lat", "lon", "radius", "active", "loadingWallSide"].forEach((id) => {
        const input = document.getElementById(id);
        input?.addEventListener("input", () => {
            if ((id === "lat" || id === "lon") && getCurrentShapeType() === "SQUARE") {
                syncSquareInputsFromCenterAndSide();
            }
            renderZonePreview();
        });
        input?.addEventListener("change", () => {
            if ((id === "lat" || id === "lon") && getCurrentShapeType() === "SQUARE") {
                syncSquareInputsFromCenterAndSide();
            }
            renderZonePreview();
        });
    });

    sideMetersInput?.addEventListener("input", () => {
        syncSquareInputsFromCenterAndSide();
        renderZonePreview();
    });

    sideMetersInput?.addEventListener("change", () => {
        const value = parseNumberValue(sideMetersInput.value) ?? DEFAULT_SQUARE_SIDE;
        sideMetersInput.value = String(Math.max(1, Math.round(value)));
        syncSquareInputsFromCenterAndSide();
        renderZonePreview();
    });

    sideMetersInput?.addEventListener("blur", () => {
        const value = parseNumberValue(sideMetersInput.value) ?? DEFAULT_SQUARE_SIDE;
        sideMetersInput.value = String(Math.max(1, Math.round(value)));
        syncSquareInputsFromCenterAndSide();
        renderZonePreview();
    });

    squareCornerInputs.forEach((inputs) => {
        [inputs?.lat, inputs?.lon].forEach((input) => input?.addEventListener("input", () => {
            syncSquareDerivedFieldsFromBounds();
            renderZonePreview();
        }));
    });
}

function bindOutsideSelectionReset() {
    document.addEventListener("click", function (event) {
        if (!selectedZoneId) {
            return;
        }

        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        if (
            target.closest(".map-card") ||
            target.closest(".panel-card") ||
            target.closest(".table-card") ||
            target.closest(".ymaps-2-1-79-map")
        ) {
            return;
        }

        resetZoneEditor();
    });
}

function bindMapClick() {
    map.events.add("click", function (event) {
        if (suppressNextMapClick) {
            suppressNextMapClick = false;
            return;
        }

        if (!canWrite()) {
            return;
        }

        const coords = event.get("coords");
        setFormCoordinates(coords);
        if (getCurrentShapeType() === "SQUARE") {
            syncSquareInputsFromCenterAndSide();
        }
        renderZonePreview();

        const selectedZone = getSelectedZone();
        if (selectedZone) {
            setStatus(`Координаты зоны "${getZoneLabel(selectedZone)}" обновлены: ${coords[0].toFixed(6)}, ${coords[1].toFixed(6)}`);
            return;
        }

        setStatus(`Координаты выбраны: ${coords[0].toFixed(6)}, ${coords[1].toFixed(6)}`);
    });
}

function setFormCoordinates(coords) {
    const latInput = document.getElementById("lat");
    const lonInput = document.getElementById("lon");

    if (!latInput || !lonInput) {
        return;
    }

    latInput.value = Number(coords[0]).toFixed(6);
    lonInput.value = Number(coords[1]).toFixed(6);
}

function clearZonePreview() {
    if (previewShape) {
        map.geoObjects.remove(previewShape);
        previewShape = null;
    }

    previewCornerMarkers.forEach((marker) => map.geoObjects.remove(marker));
    previewCornerMarkers = [];

    if (previewLoadingWallLine) {
        map.geoObjects.remove(previewLoadingWallLine);
        previewLoadingWallLine = null;
    }

    if (previewCircleCenterMarker) {
        map.geoObjects.remove(previewCircleCenterMarker);
        previewCircleCenterMarker = null;
    }

    if (previewCircleRadiusMarker) {
        map.geoObjects.remove(previewCircleRadiusMarker);
        previewCircleRadiusMarker = null;
    }
}

function handleSquareCornerDrag(cornerIndex, coords) {
    const polygonCoords = readSquareCornerInputs();
    if (!polygonCoords || !polygonCoords[cornerIndex]) {
        return;
    }

    polygonCoords[cornerIndex] = [Number(coords[0]), Number(coords[1])];
    setSquareCornerInputs(polygonCoords);
    const meta = syncSquareDerivedFieldsFromBounds();
    if (meta && previewShape) {
        previewShape.geometry.setCoordinates([polygonCoords]);
    }
}

function handleCircleCenterDrag(coords) {
    const centerCoords = [Number(coords[0]), Number(coords[1])];
    const radius = Math.max(1, Math.round(parseNumberValue(document.getElementById("radius")?.value) ?? DEFAULT_ZONE_RADIUS));

    setFormCoordinates(centerCoords);

    if (previewShape) {
        previewShape.geometry.setCoordinates(centerCoords);
    }

    if (previewCircleRadiusMarker) {
        previewCircleRadiusMarker.geometry.setCoordinates(getCircleRadiusHandleCoords(centerCoords, radius));
    }
}

function handleCircleRadiusDrag(coords) {
    const lat = parseNumberValue(document.getElementById("lat")?.value);
    const lon = parseNumberValue(document.getElementById("lon")?.value);
    const radiusInput = document.getElementById("radius");

    if (!isValidLat(lat) || !isValidLon(lon) || !radiusInput) {
        return;
    }

    const radius = Math.max(1, Math.round(getDistanceMeters([lat, lon], [Number(coords[0]), Number(coords[1])])));
    radiusInput.value = String(radius);

    if (previewShape) {
        previewShape.geometry.setRadius(radius);
    }
}

function renderZonePreview() {
    clearZonePreview();

    if (!canWrite()) {
        return;
    }

    const zoneData = readZoneFormValues();
    if (!validateZoneForm(zoneData)) {
        return;
    }

    if (zoneData.shapeType === "SQUARE") {
        const polygonCoords = zoneData.polygonCoords || getSquareCornerCoords(zoneData);
        previewShape = new ymaps.Polygon(
            [polygonCoords],
            {},
            {
                fillColor: "rgba(232,185,0,0.40)",
                strokeColor: "#F3C21D",
                strokeWidth: 4,
                strokeStyle: "dash",
            }
        );

        map.geoObjects.add(previewShape);

        polygonCoords.forEach((coords, index) => {
            const marker = new ymaps.Placemark(coords, {}, {
                preset: "islands#circleDotIcon",
                iconColor: "#F3C21D",
                draggable: true,
            });

            marker.events.add("drag", () => {
                handleSquareCornerDrag(index, marker.geometry.getCoordinates());
            });

            marker.events.add("dragend", () => {
                handleSquareCornerDrag(index, marker.geometry.getCoordinates());
                renderZonePreview();
            });

            previewCornerMarkers.push(marker);
            map.geoObjects.add(marker);
        });

        const loadingWallCoords = getLoadingWallCoords(polygonCoords, zoneData.loadingWallSide);
        if (loadingWallCoords) {
            previewLoadingWallLine = new ymaps.Polyline(
                loadingWallCoords,
                {},
                {
                    strokeColor: "#E84B3C",
                    strokeWidth: 7,
                    strokeOpacity: 0.95,
                }
            );
            map.geoObjects.add(previewLoadingWallLine);
        }

        return;
    }

    previewShape = new ymaps.Circle(
        [[Number(zoneData.lat), Number(zoneData.lon)], Number(zoneData.radius)],
        {},
        {
            fillColor: "rgba(232,185,0,0.40)",
            strokeColor: "#F3C21D",
            strokeWidth: 4,
            strokeStyle: "dash",
        }
    );

    map.geoObjects.add(previewShape);

    const centerCoords = [Number(zoneData.lat), Number(zoneData.lon)];
    const radiusHandleCoords = getCircleRadiusHandleCoords(centerCoords, Number(zoneData.radius));

    previewCircleCenterMarker = new ymaps.Placemark(centerCoords, {}, {
        preset: "islands#circleDotIcon",
        iconColor: "#F3C21D",
        draggable: true,
    });

    previewCircleRadiusMarker = new ymaps.Placemark(radiusHandleCoords, {}, {
        preset: "islands#redCircleDotIcon",
        draggable: true,
    });

    previewCircleCenterMarker.events.add("dragstart", () => {
        suppressMapClickBriefly();
    });
    previewCircleCenterMarker.events.add("drag", () => {
        handleCircleCenterDrag(previewCircleCenterMarker.geometry.getCoordinates());
    });
    previewCircleCenterMarker.events.add("dragend", () => {
        suppressMapClickBriefly();
        handleCircleCenterDrag(previewCircleCenterMarker.geometry.getCoordinates());
        renderZonePreview();
        setStatus("Центр круга изменен. Нажмите \"Сохранить зону\", чтобы записать изменения");
    });
    previewCircleCenterMarker.events.add("click", () => {
        suppressMapClickBriefly();
    });

    previewCircleRadiusMarker.events.add("dragstart", () => {
        suppressMapClickBriefly();
    });
    previewCircleRadiusMarker.events.add("drag", () => {
        handleCircleRadiusDrag(previewCircleRadiusMarker.geometry.getCoordinates());
    });
    previewCircleRadiusMarker.events.add("dragend", () => {
        suppressMapClickBriefly();
        handleCircleRadiusDrag(previewCircleRadiusMarker.geometry.getCoordinates());
        renderZonePreview();
        setStatus("Радиус круга изменен. Нажмите \"Сохранить зону\", чтобы записать изменения");
    });
    previewCircleRadiusMarker.events.add("click", () => {
        suppressMapClickBriefly();
    });

    map.geoObjects.add(previewCircleCenterMarker);
    map.geoObjects.add(previewCircleRadiusMarker);
}

async function loadZones() {
    try {
        const response = await fetch(ZONES_API, {
            headers: getHeaders(),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ошибка загрузки зон: ${response.status} ${errorText}`);
        }

        zones = (await response.json()).map(normalizeZone);
        syncSelectedZoneAfterReload();
    } catch (error) {
        console.error(error);
        setStatus("Не удалось загрузить зоны");
    }
}

function syncSelectedZoneAfterReload() {
    const zone = getSelectedZone();

    if (!zone) {
        selectedZoneId = null;
        refreshSelectionUI();
        return;
    }

    refreshSelectionUI();
    if (canWrite()) {
        fillZoneForm(zone);
    }
}

function refreshSelectionUI() {
    drawZones();
    renderTable();
    renderZonePreview();
    updateFormMode();
}

function drawZones() {
    zoneCircles.forEach((circle) => map.geoObjects.remove(circle));
    zoneCircles = [];

    zones.filter((zone) => Boolean(zone.active)).forEach((zone) => {
        const isSelected = String(zone.id) === String(selectedZoneId);
        const zoneColors = getZoneTypeColor(zone, isSelected);

        const shapeLabel = zone.shapeType === "SQUARE" ? "Квадрат" : "Кружок";
        const sizeLabel = zone.shapeType === "SQUARE"
            ? `${Math.max(1, Math.round(Number(zone.sideMeters || DEFAULT_SQUARE_SIDE)))} м`
            : `${zone.radius} м`;
        const loadingWallLabel = zone.shapeType === "SQUARE"
            ? `<br>Сторона компонента: ${escapeHtml(getLoadingWallLabel(zone.loadingWallSide))}`
            : "";

        const zoneObject = zone.shapeType === "SQUARE" &&
            Array.isArray(zone.polygonCoords) &&
            zone.polygonCoords.length >= 4
            ? new ymaps.Polygon(
                getSquarePolygonCoords(zone),
                {
                    balloonContent: `
                        <strong>${escapeHtml(getZoneLabel(zone))}</strong><br>
                        Тип: ${getZoneTypeLabel(zone)}<br>
                        Форма: ${shapeLabel}<br>
                        Lat: ${zone.lat}<br>
                        Lon: ${zone.lon}<br>
                        Размер: ${sizeLabel}${loadingWallLabel}
                    `,
                },
                {
                    fillColor: zoneColors.fillColor,
                    strokeColor: zoneColors.strokeColor,
                    strokeWidth: isSelected ? 5 : 4,
                }
            )
            : new ymaps.Circle(
                [[Number(zone.lat), Number(zone.lon)], Number(zone.radius)],
                {
                    balloonContent: `
                        <strong>${escapeHtml(getZoneLabel(zone))}</strong><br>
                        Тип: ${getZoneTypeLabel(zone)}<br>
                        Форма: ${shapeLabel}<br>
                        Lat: ${zone.lat}<br>
                        Lon: ${zone.lon}<br>
                        Размер: ${sizeLabel}
                    `,
                },
                {
                    fillColor: zoneColors.fillColor,
                    strokeColor: zoneColors.strokeColor,
                    strokeWidth: isSelected ? 5 : 4,
                }
            );

        zoneObject.events.add("click", function () {
            suppressNextMapClick = true;
            selectZone(zone.id, { focusMap: false });
        });

        map.geoObjects.add(zoneObject);
        zoneCircles.push(zoneObject);

        const loadingWallCoords = zone.shapeType === "SQUARE"
            ? getLoadingWallCoords(zone.polygonCoords, zone.loadingWallSide)
            : null;
        if (loadingWallCoords) {
            const loadingWallLine = new ymaps.Polyline(
                loadingWallCoords,
                {},
                {
                    strokeColor: isSelected ? "#E84B3C" : "#B23A30",
                    strokeWidth: isSelected ? 7 : 5,
                    strokeOpacity: isSelected ? 0.95 : 0.75,
                }
            );
            loadingWallLine.events.add("click", function () {
                suppressNextMapClick = true;
                selectZone(zone.id, { focusMap: false });
            });
            map.geoObjects.add(loadingWallLine);
            zoneCircles.push(loadingWallLine);
        }
    });
}

function renderTable() {
    const storageTable = document.getElementById("storage-zones-table");
    const barnTable = document.getElementById("barn-zones-table");
    if (!storageTable || !barnTable) {
        return;
    }

    const renderRows = (table, zoneType, emptyMessage) => {
        const typeZones = zones.filter((zone) => normalizeZoneType(zone.zoneType) === zoneType);
        table.innerHTML = "";

        if (!typeZones.length) {
            table.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center text-muted">
                        ${emptyMessage}
                    </td>
                </tr>
            `;
            return;
        }

        const sortedZones = [...typeZones].sort((left, right) => {
            if (Boolean(left.active) === Boolean(right.active)) {
                return 0;
            }

            return left.active ? -1 : 1;
        });

        const hasActiveZones = sortedZones.some((zone) => Boolean(zone.active));
        const hasInactiveZones = sortedZones.some((zone) => !zone.active);
        let separatorInserted = false;

        sortedZones.forEach((zone) => {
            if (!zone.active && hasActiveZones && hasInactiveZones && !separatorInserted) {
                const separatorRow = document.createElement("tr");
                separatorRow.className = "zones-separator-row";
                separatorRow.innerHTML = `
                    <td colspan="6" class="zones-separator-cell">
                        Неактивные зоны
                    </td>
                `;
                table.appendChild(separatorRow);
                separatorInserted = true;
            }

            const row = document.createElement("tr");
            row.className = "zone-row";
            row.dataset.zoneId = zone.id;

            if (String(zone.id) === String(selectedZoneId)) {
                row.classList.add("selected");
            }

            row.innerHTML = `
                <td>${escapeHtml(getZoneLabel(zone))}</td>
                <td>${zone.shapeType === "SQUARE" ? "Квадрат" : "Кружок"}</td>
                <td>${Number(zone.lat).toFixed(6)}</td>
                <td>${Number(zone.lon).toFixed(6)}</td>
                <td>${zone.shapeType === "SQUARE" ? (Math.max(1, Math.round(Number(zone.sideMeters || DEFAULT_SQUARE_SIDE))) + " м") : zone.radius + " м"}</td>
                <td>
                    <span class="badge-soft ${zone.active ? "active" : "inactive"}">
                        ${zone.active ? "Да" : "Нет"}
                    </span>
                </td>
            `;

            row.addEventListener("click", function (event) {
                event.preventDefault();
                event.stopPropagation();
                selectZone(zone.id, { focusMap: Boolean(zone.active) });
            });

            table.appendChild(row);
        });
    };

    renderRows(storageTable, ZONE_TYPE_STORAGE, "Зоны хранения пока не добавлены");
    renderRows(barnTable, ZONE_TYPE_BARN, "Коровники пока не добавлены");
}

function selectZone(zoneId, options = {}) {
    selectedZoneId = zoneId;

    const zone = getSelectedZone();
    if (!zone) {
        resetZoneEditor();
        return;
    }

    if (canWrite()) {
        fillZoneForm(zone);
    }

    refreshSelectionUI();

    if (options.focusMap) {
        focusZone(zone);
    }

    setStatus(`Выбрана зона "${getZoneLabel(zone)}"`);
}

function updateFormMode() {
    const title = document.getElementById("zone-form-title");
    const submitButton = document.getElementById("submit-zone-btn");
    const deleteButton = document.getElementById("delete-zone-btn");
    const goToDeviceButton = document.getElementById("go-to-device-btn");

    const createMode = isCreateMode();

    if (title) {
        title.textContent = createMode ? CREATE_MODE_TITLE : EDIT_MODE_TITLE;
    }

    if (submitButton) {
        submitButton.textContent = createMode ? CREATE_SUBMIT_LABEL : EDIT_SUBMIT_LABEL;
        submitButton.classList.toggle("btn-success", createMode);
        submitButton.classList.toggle("btn-primary", !createMode);
    }

    if (deleteButton) {
        deleteButton.disabled = !canWrite() || createMode;
    }

    if (goToDeviceButton) {
        goToDeviceButton.disabled = !canWrite();
    }
}

function fillZoneForm(zone) {
    const zoneTypeSelect = document.getElementById("zoneType");
    const ingredientInput = document.getElementById("ingredient");
    const latInput = document.getElementById("lat");
    const lonInput = document.getElementById("lon");
    const radiusInput = document.getElementById("radius");
    const activeInput = document.getElementById("active");

    if (zoneTypeSelect) zoneTypeSelect.value = normalizeZoneType(zone.zoneType);
    if (ingredientInput) ingredientInput.value = getZoneLabel(zone);
    if (latInput) latInput.value = Number(zone.lat).toFixed(6);
    if (lonInput) lonInput.value = Number(zone.lon).toFixed(6);
    if (radiusInput) radiusInput.value = zone.radius;
    if (activeInput) activeInput.value = String(Boolean(zone.active));
    if (shapeTypeInput) shapeTypeInput.value = normalizeShapeType(zone.shapeType);
    if (sideMetersInput) sideMetersInput.value = String(Math.max(1, Math.round(Number(zone.sideMeters || DEFAULT_SQUARE_SIDE))));
    if (loadingWallSideInput) loadingWallSideInput.value = parseLoadingWallSide(zone.loadingWallSide) === null ? "" : String(zone.loadingWallSide);

    if (normalizeShapeType(zone.shapeType) === "SQUARE") {
        setSquareCornerInputs(zone.polygonCoords || getSquareCornerCoords(zone));
    } else {
        setSquareCornerInputs(buildSquarePolygonFromCenter(Number(zone.lat), Number(zone.lon), DEFAULT_SQUARE_SIDE));
    }

    updateShapeSections();
}

function resetZoneFormFields() {
    const zoneForm = document.getElementById("zone-form");
    if (zoneForm) {
        zoneForm.reset();
    }

    const zoneTypeSelect = document.getElementById("zoneType");
    const ingredientInput = document.getElementById("ingredient");
    const latInput = document.getElementById("lat");
    const lonInput = document.getElementById("lon");
    const radiusInput = document.getElementById("radius");
    const activeInput = document.getElementById("active");

    if (zoneTypeSelect) {
        zoneTypeSelect.value = "";
    }

    if (ingredientInput) {
        ingredientInput.value = "";
    }

    if (latInput) {
        latInput.value = "";
    }

    if (lonInput) {
        lonInput.value = "";
    }

    if (radiusInput) {
        radiusInput.value = String(DEFAULT_ZONE_RADIUS);
    }

    if (activeInput) {
        activeInput.value = "true";
    }

    if (shapeTypeInput) {
        shapeTypeInput.value = "CIRCLE";
    }

    if (sideMetersInput) {
        sideMetersInput.value = String(DEFAULT_SQUARE_SIDE);
    }

    if (loadingWallSideInput) {
        loadingWallSideInput.value = "";
    }

    setSquareCornerInputs(buildSquarePolygonFromCenter(DEFAULT_MAP_CENTER[0], DEFAULT_MAP_CENTER[1], DEFAULT_SQUARE_SIDE));
    updateShapeSections();
}

function resetZoneEditor() {
    selectedZoneId = null;

    if (canWrite()) {
        resetZoneFormFields();
    }

    refreshSelectionUI();
    setStatus(DEFAULT_STATUS_MESSAGE);
}

function focusZone(zone) {
    if (!zone) {
        return;
    }

    if (zone.shapeType === "SQUARE" && Array.isArray(zone.polygonCoords) && zone.polygonCoords.length >= 4) {
        const lats = zone.polygonCoords.map((point) => Number(point[0]));
        const lons = zone.polygonCoords.map((point) => Number(point[1]));
        map.setBounds([
            [Math.min(...lats), Math.min(...lons)],
            [Math.max(...lats), Math.max(...lons)],
        ], {
            checkZoomRange: true,
            duration: 300,
            zoomMargin: 40,
        });
        return;
    }

    map.setCenter([Number(zone.lat), Number(zone.lon)], 15, {
        checkZoomRange: true,
        duration: 300,
    });
}

function readZoneFormValues() {
    const radiusValue = document.getElementById("radius")?.value.trim() || "";
    const rawZoneType = document.getElementById("zoneType")?.value.trim() || "";
    const shapeType = getCurrentShapeType();
    const lat = parseNumberValue(document.getElementById("lat")?.value);
    const lon = parseNumberValue(document.getElementById("lon")?.value);
    const sideMeters = parseNumberValue(sideMetersInput?.value) ?? DEFAULT_SQUARE_SIDE;
    const squareMeta = shapeType === "SQUARE"
        ? (syncSquareDerivedFieldsFromBounds() || (isValidLat(lat) && isValidLon(lon) ? buildSquareBoundsFromCenter(lat, lon, sideMeters) : null))
        : null;

    return {
        zoneType: rawZoneType,
        ingredient: document.getElementById("ingredient")?.value.trim() || "",
        shapeType,
        lat: squareMeta?.lat ?? lat,
        lon: squareMeta?.lon ?? lon,
        radius: radiusValue ? Number(radiusValue) : DEFAULT_ZONE_RADIUS,
        sideMeters: squareMeta?.sideMeters ?? sideMeters,
        polygonCoords: squareMeta?.polygonCoords ?? readSquareCornerInputs(),
        squareMinLat: squareMeta?.squareMinLat ?? null,
        squareMinLon: squareMeta?.squareMinLon ?? null,
        squareMaxLat: squareMeta?.squareMaxLat ?? null,
        squareMaxLon: squareMeta?.squareMaxLon ?? null,
        loadingWallSide: shapeType === "SQUARE" ? parseLoadingWallSide(loadingWallSideInput?.value) : null,
        active: document.getElementById("active")?.value === "true",
    };
}

function validateZoneForm(zoneData) {
    if (![ZONE_TYPE_STORAGE, ZONE_TYPE_BARN].includes(zoneData.zoneType)) {
        return false;
    }

    if (!(
        zoneData.ingredient &&
        Number.isFinite(zoneData.lat) &&
        Number.isFinite(zoneData.lon) &&
        isValidLat(zoneData.lat) &&
        isValidLon(zoneData.lon)
    )) {
        return false;
    }

    if (zoneData.shapeType === "SQUARE") {
        return Boolean(
            Number.isFinite(zoneData.sideMeters) &&
            zoneData.sideMeters > 0 &&
            Array.isArray(zoneData.polygonCoords) &&
            zoneData.polygonCoords.length >= 4
        );
    }

    return Boolean(!Number.isNaN(zoneData.radius) && zoneData.radius > 0);
}

async function onZoneFormSubmit(event) {
    event.preventDefault();

    if (!canWrite()) {
        setStatus("Режим просмотра: изменение зон недоступно");
        return;
    }

    const zoneData = readZoneFormValues();
    if (!validateZoneForm(zoneData)) {
        setStatus("Заполните все поля корректно");
        return;
    }

    const submitButton = document.getElementById("submit-zone-btn");
    if (submitButton) {
        submitButton.disabled = true;
    }

    try {
        if (selectedZoneId) {
            await updateZone(zoneData);
        } else {
            await createZone(zoneData);
        }
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
        }
    }
}

async function createZone(zoneData) {
    try {
        const response = await fetch(ZONES_API, {
            method: "POST",
            headers: getHeaders(true),
            body: JSON.stringify({
                name: zoneData.ingredient,
                ingredient: zoneData.ingredient,
                zoneType: zoneData.zoneType,
                shapeType: zoneData.shapeType,
                lat: zoneData.lat,
                lon: zoneData.lon,
                radius: zoneData.radius,
                sideMeters: zoneData.sideMeters,
                polygonCoords: zoneData.polygonCoords,
                squareMinLat: zoneData.squareMinLat,
                squareMinLon: zoneData.squareMinLon,
                squareMaxLat: zoneData.squareMaxLat,
                squareMaxLon: zoneData.squareMaxLon,
                loadingWallSide: zoneData.loadingWallSide,
                active: zoneData.active,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ошибка создания зоны: ${response.status} ${errorText}`);
        }

        setStatus(`Зона "${zoneData.ingredient}" добавлена`);
        resetZoneEditor();
        await loadZones();

        const createdZone = findBestMatchingZone(zoneData);
        if (createdZone) {
            focusZone(createdZone);
        }
    } catch (error) {
        console.error(error);
        setStatus(error?.message || "Не удалось добавить зону");
    }
}

async function updateZone(zoneData) {
    const currentZoneId = selectedZoneId;

    try {
        const response = await fetch(`${ZONES_API}/${currentZoneId}`, {
            method: "PUT",
            headers: getHeaders(true),
            body: JSON.stringify({
                name: zoneData.ingredient,
                ingredient: zoneData.ingredient,
                zoneType: zoneData.zoneType,
                shapeType: zoneData.shapeType,
                lat: zoneData.lat,
                lon: zoneData.lon,
                radius: zoneData.radius,
                sideMeters: zoneData.sideMeters,
                polygonCoords: zoneData.polygonCoords,
                squareMinLat: zoneData.squareMinLat,
                squareMinLon: zoneData.squareMinLon,
                squareMaxLat: zoneData.squareMaxLat,
                squareMaxLon: zoneData.squareMaxLon,
                loadingWallSide: zoneData.loadingWallSide,
                active: zoneData.active,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ошибка обновления зоны: ${response.status} ${errorText}`);
        }

        setStatus(`Зона "${zoneData.ingredient}" сохранена`);
        selectedZoneId = currentZoneId;
        await loadZones();
    } catch (error) {
        console.error(error);
        selectedZoneId = currentZoneId;
        refreshSelectionUI();
        setStatus(error?.message || "Не удалось сохранить изменения зоны");
    }
}

async function onDeleteZoneClick() {
    if (!canWrite()) {
        setStatus("Режим просмотра: удаление зон недоступно");
        return;
    }

    const zone = getSelectedZone();
    if (!zone) {
        setStatus("Сначала выберите зону");
        return;
    }

    const deleteZoneBtn = document.getElementById("delete-zone-btn");
    if (deleteZoneBtn) {
        deleteZoneBtn.disabled = true;
    }

    try {
        const response = await fetch(`${ZONES_API}/${zone.id}`, {
            method: "DELETE",
            headers: getHeaders(),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ошибка удаления зоны: ${response.status} ${errorText}`);
        }

        setStatus(`Зона "${getZoneLabel(zone)}" удалена`);
        resetZoneEditor();
        await loadZones();
    } catch (error) {
        console.error(error);
        refreshSelectionUI();
        setStatus("Не удалось удалить зону");
    }
}

async function loadTelemetry() {
    try {
        const [hostResponse, rtkResponse] = await Promise.allSettled([
            fetch(TELEMETRY_API, { headers: getHeaders() }),
            fetch(RTK_TELEMETRY_API, { headers: getHeaders() }),
        ]);

        await handleHostTelemetryResponse(hostResponse);
        await handleRtkTelemetryResponse(rtkResponse);
    } catch (error) {
        console.error(error);
        setStatus("Не удалось получить текущую телеметрию");
    }
}

function getVisibleTelemetryCoords() {
    const coords = [];

    if (lastTelemetry && Number.isFinite(Number(lastTelemetry.lat)) && Number.isFinite(Number(lastTelemetry.lon))) {
        coords.push([Number(lastTelemetry.lat), Number(lastTelemetry.lon)]);
    }

    if (lastRtkTelemetry && Number.isFinite(Number(lastRtkTelemetry.lat)) && Number.isFinite(Number(lastRtkTelemetry.lon))) {
        coords.push([Number(lastRtkTelemetry.lat), Number(lastRtkTelemetry.lon)]);
    }

    return coords;
}

function focusMapOnTelemetry(options = {}) {
    if (!map) {
        return false;
    }

    const coordsList = getVisibleTelemetryCoords();
    if (!coordsList.length) {
        return false;
    }

    if (coordsList.length === 1) {
        map.setCenter(coordsList[0], options.zoom ?? 15, {
            checkZoomRange: true,
            duration: options.duration ?? 300,
        });
        return true;
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
            duration: options.duration ?? 300,
        }
    );

    return true;
}

async function handleHostTelemetryResponse(result) {
    if (result.status !== "fulfilled") {
        console.error(result.reason);
        updateHostSummary(null);
        return;
    }

    const response = result.value;
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`Ошибка host телеметрии: ${response.status} ${errorText}`);
        updateHostSummary(null);
        return;
    }

    const data = await response.json();
    lastTelemetry = data;
    updateDeviceMarker(data);
    updateHostSummary(data);
}

async function handleRtkTelemetryResponse(result) {
    if (result.status !== "fulfilled") {
        console.error(result.reason);
        updateRtkSummary(null);
        return;
    }

    const response = result.value;
    if (response.status === 404) {
        updateRtkSummary(null);
        return;
    }

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`Ошибка RTK телеметрии: ${response.status} ${errorText}`);
        updateRtkSummary(null);
        return;
    }

    const data = await response.json();
    lastRtkTelemetry = data;
    updateRtkMarker(data);
    updateRtkSummary(data);
}

async function refreshTelemetryLayers() {
    try {
        await loadTelemetry();
    } catch (error) {
        console.error(error);
        setStatus("Не удалось получить текущие точки");
    }
}

function updateDeviceMarker(data) {
    if (!data || data.lat == null || data.lon == null) {
        if (deviceMarker) {
            map.geoObjects.remove(deviceMarker);
            deviceMarker = null;
        }
        return;
    }

    const coords = [Number(data.lat), Number(data.lon)];

    if (deviceMarker === null) {
        deviceMarker = new ymaps.Placemark(
            coords,
            {
                balloonContent: `
                    <strong>Хозяин</strong><br>
                    Режим: ${escapeHtml(data.mode || "Ожидание")}<br>
                    Координаты: ${coords[0].toFixed(6)}, ${coords[1].toFixed(6)}<br>
                    Пакет: ${isFreshTelemetry(data.timestamp) ? "свежий" : "устаревший"}
                `,
                hintContent: `Хозяин • ${isFreshTelemetry(data.timestamp) ? "свежий пакет" : "нет свежих пакетов"}`,
            },
            {
                ...getMarkerOptions("host", isFreshTelemetry(data.timestamp)),
            }
        );

        map.geoObjects.add(deviceMarker);
    } else {
        deviceMarker.geometry.setCoordinates(coords);
        deviceMarker.properties.set({
            balloonContent: `
                <strong>Хозяин</strong><br>
                Режим: ${escapeHtml(data.mode || "Ожидание")}<br>
                Координаты: ${coords[0].toFixed(6)}, ${coords[1].toFixed(6)}<br>
                Пакет: ${isFreshTelemetry(data.timestamp) ? "свежий" : "устаревший"}
            `,
            hintContent: `Хозяин • ${isFreshTelemetry(data.timestamp) ? "свежий пакет" : "нет свежих пакетов"}`,
        });
        deviceMarker.options.set(getMarkerOptions("host", isFreshTelemetry(data.timestamp)));
    }

    if (!hasTelemetryAutoFocus) {
        focusMapOnTelemetry({ duration: 300 });
        hasTelemetryAutoFocus = true;
    }
}

function getRtkQualityLabel(data) {
    if (!data) {
        return "--";
    }

    return data.qualityLabel || data.rtkQuality || (data.quality != null ? `Q${data.quality}` : "--");
}

function updateRtkMarker(data) {
    if (!data || data.lat == null || data.lon == null || !isFreshRtkTelemetry(data)) {
        if (rtkMarker) {
            map.geoObjects.remove(rtkMarker);
            rtkMarker = null;
        }
        return;
    }

    const coords = [Number(data.lat), Number(data.lon)];
    const qualityLabel = getRtkQualityLabel(data);
    const zoneName = data?.zone?.name || "Вне зоны";
    const isFresh = isFreshRtkTelemetry(data);
    const packetState = isFresh ? "свежий" : "устаревший";
    const heading = getRtkHeading(data);
    const balloonContent = `
        <strong>Погрузчик</strong><br>
        Устройство: ${escapeHtml(data.deviceId || "--")}<br>
        Пакет: ${packetState}<br>
        Quality: ${escapeHtml(qualityLabel)}<br>
        Heading: ${heading == null ? "--" : `${heading.toFixed(1)}°`}<br>
        Координаты: ${coords[0].toFixed(6)}, ${coords[1].toFixed(6)}<br>
        Зона: ${escapeHtml(zoneName)}
    `;

    if (rtkMarker === null) {
        rtkMarker = new ymaps.Placemark(
            coords,
            {
                balloonContent,
                hintContent: `Погрузчик • ${qualityLabel} • ${packetState}`,
            },
            {
                ...getMarkerOptions("rtk", isFresh, data),
            }
        );

        map.geoObjects.add(rtkMarker);
    } else {
        rtkMarker.geometry.setCoordinates(coords);
        rtkMarker.properties.set({
            balloonContent,
            hintContent: `Погрузчик • ${qualityLabel} • ${packetState}`,
        });
        rtkMarker.options.set(getMarkerOptions("rtk", isFresh, data));
    }

    if (!hasTelemetryAutoFocus) {
        focusMapOnTelemetry({ duration: 300 });
        hasTelemetryAutoFocus = true;
    }
}

function updateHostSummary(data) {
    const statusElement = document.getElementById("hostMapStatus");
    const metaElement = document.getElementById("hostMapMeta");

    if (!statusElement || !metaElement) {
        return;
    }

    if (!data || data.lat == null || data.lon == null) {
        statusElement.textContent = "Нет данных";
        metaElement.textContent = "Координаты: --";
        return;
    }

    const isFresh = isFreshRtkTelemetry(data);
    statusElement.textContent = isFresh ? "Онлайн" : "Нет свежих пакетов";
    metaElement.textContent = `${data.mode || "Ожидание"} • ${Number(data.lat).toFixed(6)}, ${Number(data.lon).toFixed(6)}`;
}

function updateRtkSummary(data) {
    const statusElement = document.getElementById("rtkMapStatus");
    const metaElement = document.getElementById("rtkMapMeta");
    const qualityElement = document.getElementById("rtkMapQuality");
    const deviceElement = document.getElementById("rtkMapDevice");
    const zoneElement = document.getElementById("rtkMapZone");
    const updatedElement = document.getElementById("rtkMapUpdated");

    if (!statusElement || !metaElement || !qualityElement || !deviceElement || !zoneElement || !updatedElement) {
        return;
    }

    if (!data || data.lat == null || data.lon == null) {
        statusElement.textContent = "Нет данных";
        metaElement.textContent = "Координаты: --";
        qualityElement.textContent = "--";
        deviceElement.textContent = "Устройство: --";
        zoneElement.textContent = "--";
        updatedElement.textContent = "Последний пакет: --";
        return;
    }

    const isFresh = isFreshTelemetry(data.timestamp);
    statusElement.textContent = !isFresh ? "Нет свежих пакетов" : (data.valid === false ? "Невалидный пакет" : "Онлайн");
    metaElement.textContent = `Координаты: ${Number(data.lat).toFixed(6)}, ${Number(data.lon).toFixed(6)}`;
    qualityElement.textContent = getRtkQualityLabel(data);
    deviceElement.textContent = `Устройство: ${data.deviceId || "--"}`;
    zoneElement.textContent = data?.zone?.name || "Вне зоны";
    updatedElement.textContent = `Последний пакет: ${formatDateTime(data.timestamp)}`;
}

function formatDateTime(value) {
    if (!value) {
        return "--";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("ru-RU", { timeZone: "Asia/Novosibirsk" });
}

function goToCurrentPoint() {
    if (!canWrite()) {
        setStatus("Режим просмотра: изменение зон недоступно");
        return;
    }

    if (!isCreateMode()) {
        setStatus("К текущей точке можно перейти только при создании новой зоны");
        return;
    }

    if (!lastTelemetry || lastTelemetry.lat == null || lastTelemetry.lon == null) {
        setStatus("Текущая точка пока недоступна");
        return;
    }

    const lat = Number(lastTelemetry.lat);
    const lon = Number(lastTelemetry.lon);

    setFormCoordinates([lat, lon]);
    if (getCurrentShapeType() === "SQUARE") {
        syncSquareInputsFromCenterAndSide();
    }
    renderZonePreview();

    map.setCenter([lat, lon], 16, {
        checkZoomRange: true,
        duration: 300,
    });

    setStatus("Координаты текущей точки подставлены в форму новой зоны");
}

function findBestMatchingZone(newZone) {
    return zones.find((zone) =>
        getZoneLabel(zone) === newZone.ingredient &&
        normalizeShapeType(zone.shapeType) === normalizeShapeType(newZone.shapeType) &&
        Number(zone.lat) === Number(newZone.lat) &&
        Number(zone.lon) === Number(newZone.lon) &&
        (
            normalizeShapeType(newZone.shapeType) === "SQUARE"
                ? Number(zone.sideMeters || 0) === Number(newZone.sideMeters || 0)
                : Number(zone.radius) === Number(newZone.radius)
        )
    );
}

function setStatus(message) {
    const statusBox = document.getElementById("status-box");
    if (statusBox) {
        statusBox.textContent = message;
    }
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

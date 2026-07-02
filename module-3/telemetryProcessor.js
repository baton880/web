import { calculateHaversine, detectZoneObject } from '../module-1/geo.js';
import { isValidLocation } from '../module-1/validator.js';
import {
  BATCH_START_THRESHOLD_KG,
  LEFTOVER_THRESHOLD_KG,
  UNLOAD_DROP_THRESHOLD_KG,
  UNLOAD_MIN_PEAK_KG,
  UNLOAD_UPDATE_DELTA_KG,
  UNLOAD_WEIGHT_BUFFER_KG,
  EMPTY_VEHICLE_THRESHOLD_KG,
  ANOMALY_THRESHOLD_KG,
  ANOMALY_CONFIRM_DELTA_KG,
  ANOMALY_CONFIRM_PACKETS,
  MOVEMENT_SPEED_THRESHOLD_KMH,
  MOVEMENT_CONFIRM_PACKETS,
  DEFAULT_ZONE_DEBOUNCE_MS,
  NULL_ZONE_CONFIRM_SECONDS,
  ZONE_CHANGE_CONFIRM_PACKETS,
  ZONE_DWELL_SCORE_CAP_SECONDS,
  ZONE_ENTRY_FRONT_BONUS,
  ZONE_ENTRY_REAR_PENALTY,
  ZONE_ENTRY_FRONT_ANGLE_DEG,
  ZONE_ENTRY_REAR_ANGLE_DEG,
  SQUARE_HEADING_SCORE_PER_SECOND,
  SQUARE_HEADING_SCORE_CAP,
  SQUARE_HEADING_MAX_ANGLE_DEG,
  HOST_ZONE_OVERRIDE_NEAR_METERS,
  HOST_ZONE_OVERRIDE_MIN_DWELL_SECONDS,
  HOST_ZONE_OVERRIDE_MIN_RTK_DISTANCE_METERS
} from './config.js';

function normalizeDegrees(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = parsed % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function angleDiffDeg(first, second) {
  const normalizedFirst = normalizeDegrees(first);
  const normalizedSecond = normalizeDegrees(second);
  if (normalizedFirst === null || normalizedSecond === null) return null;

  const diff = Math.abs(normalizedFirst - normalizedSecond) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function calculateBearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => deg * Math.PI / 180;
  const toDeg = (rad) => rad * 180 / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const lambdaDelta = toRad(lon2 - lon1);
  const y = Math.sin(lambdaDelta) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambdaDelta);

  return normalizeDegrees(toDeg(Math.atan2(y, x)));
}

function parsePolygonCoords(value) {
  if (!value) return null;

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(parsed) || parsed.length < 4) return null;

  const coords = parsed.slice(0, 4).map((point) => {
    if (!Array.isArray(point) || point.length < 2) return null;
    const lat = Number(point[0]);
    const lon = Number(point[1]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
  });

  return coords.every(Boolean) ? coords : null;
}

function normalizeIngredientKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isPointInsidePolygon(lat, lon, polygonCoords = []) {
  let isInside = false;

  for (let i = 0, j = polygonCoords.length - 1; i < polygonCoords.length; j = i++) {
    const yi = Number(polygonCoords[i]?.[0]);
    const xi = Number(polygonCoords[i]?.[1]);
    const yj = Number(polygonCoords[j]?.[0]);
    const xj = Number(polygonCoords[j]?.[1]);

    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);

    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
}

function distanceToSegmentMeters(lat, lon, start, end) {
  const lat1 = Number(start?.[0]);
  const lon1 = Number(start?.[1]);
  const lat2 = Number(end?.[0]);
  const lon2 = Number(end?.[1]);

  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const metersPerLat = 111320;
  const metersPerLon = Math.max(Math.cos(lat * Math.PI / 180) * 111320, 1);
  const px = 0;
  const py = 0;
  const ax = (lon1 - lon) * metersPerLon;
  const ay = (lat1 - lat) * metersPerLat;
  const bx = (lon2 - lon) * metersPerLon;
  const by = (lat2 - lat) * metersPerLat;
  const abx = bx - ax;
  const aby = by - ay;
  const abLengthSq = abx * abx + aby * aby;

  if (abLengthSq <= Number.EPSILON) {
    return Math.hypot(ax - px, ay - py);
  }

  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / abLengthSq));
  return Math.hypot(ax + abx * t - px, ay + aby * t - py);
}

function distanceToZoneMeters(lat, lon, zoneObject) {
  const numericLat = Number(lat);
  const numericLon = Number(lon);

  if (!Number.isFinite(numericLat) || !Number.isFinite(numericLon) || !zoneObject) {
    return Number.POSITIVE_INFINITY;
  }

  const shapeType = String(zoneObject?.shapeType || 'CIRCLE').trim().toUpperCase();
  const polygonCoords = shapeType === 'SQUARE' ? parsePolygonCoords(zoneObject?.polygonCoords) : null;

  if (polygonCoords && polygonCoords.length >= 3) {
    if (isPointInsidePolygon(numericLat, numericLon, polygonCoords)) {
      return 0;
    }

    return polygonCoords.reduce((minDistance, point, index) => {
      const nextPoint = polygonCoords[(index + 1) % polygonCoords.length];
      return Math.min(minDistance, distanceToSegmentMeters(numericLat, numericLon, point, nextPoint));
    }, Number.POSITIVE_INFINITY);
  }

  if (
    shapeType === 'SQUARE' &&
    Number.isFinite(Number(zoneObject.squareMinLat)) &&
    Number.isFinite(Number(zoneObject.squareMinLon)) &&
    Number.isFinite(Number(zoneObject.squareMaxLat)) &&
    Number.isFinite(Number(zoneObject.squareMaxLon))
  ) {
    const minLat = Math.min(Number(zoneObject.squareMinLat), Number(zoneObject.squareMaxLat));
    const maxLat = Math.max(Number(zoneObject.squareMinLat), Number(zoneObject.squareMaxLat));
    const minLon = Math.min(Number(zoneObject.squareMinLon), Number(zoneObject.squareMaxLon));
    const maxLon = Math.max(Number(zoneObject.squareMinLon), Number(zoneObject.squareMaxLon));

    if (numericLat >= minLat && numericLat <= maxLat && numericLon >= minLon && numericLon <= maxLon) {
      return 0;
    }

    const closestLat = Math.min(Math.max(numericLat, minLat), maxLat);
    const closestLon = Math.min(Math.max(numericLon, minLon), maxLon);
    return calculateHaversine(numericLat, numericLon, closestLat, closestLon);
  }

  const radius = Number(zoneObject?.radius || 0);
  return Math.max(
    0,
    calculateHaversine(numericLat, numericLon, Number(zoneObject?.lat), Number(zoneObject?.lon)) - radius
  );
}

function calculateLoadingNormalDeg(zoneObject) {
  const storedNormal = normalizeDegrees(zoneObject?.loadingNormalDeg);
  if (storedNormal !== null) return storedNormal;

  const wallSide = Number.parseInt(zoneObject?.loadingWallSide, 10);
  const polygonCoords = parsePolygonCoords(zoneObject?.polygonCoords);
  if (!Number.isInteger(wallSide) || wallSide < 0 || wallSide > 3 || !polygonCoords) {
    return null;
  }

  const first = polygonCoords[wallSide];
  const second = polygonCoords[(wallSide + 1) % 4];
  const centerLat = polygonCoords.reduce((sum, point) => sum + Number(point[0]), 0) / polygonCoords.length;
  const centerLon = polygonCoords.reduce((sum, point) => sum + Number(point[1]), 0) / polygonCoords.length;
  const midpointLat = (Number(first[0]) + Number(second[0])) / 2;
  const midpointLon = (Number(first[1]) + Number(second[1])) / 2;

  return calculateBearingDeg(centerLat, centerLon, midpointLat, midpointLon);
}

function parseHeadingDeg(packet) {
  return normalizeDegrees(
    packet?.headingDeg ??
    packet?.heading_deg ??
    packet?.heading ??
    packet?.courseDeg ??
    packet?.course
  );
}

function isHeadingUsable(packet) {
  if (packet?.relPosValid === false || packet?.rel_pos_valid === false) return false;
  if (packet?.relPosHeadingValid === false || packet?.rel_pos_heading_valid === false || packet?.headingValid === false) return false;
  return parseHeadingDeg(packet) !== null;
}

function resolveNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveBoundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export class TelemetryProcessor {
  constructor() {
    this.deviceStates = new Map();
  }

  getInitialState(weight = 0) {
    return {
      lastZoneName: null,           // для мгновенных баннеров UI
      currentZone: null,            // ПОДТВЕРЖДЁННАЯ зона (используется в бизнес-логике)
      confirmedZoneName: null,      // имя подтверждённой зоны для сравнения
      zoneStartWeight: weight,
      peakWeight: weight,
      isMixing: false,
      isUnloading: false,
      lastUnloadWeight: null,
      lastIngredientName: null,
      isBatchStarted: false,
      hasWeightBaseline: true,
      lastAcceptedWeight: null,
      anomalyCandidateWeight: null,
      anomalyCandidateCount: 0,
      lastStationaryWeight: weight,
      isMoving: false,
      movingSpeedStreak: 0,
      stationarySpeedStreak: 0,
      visitedZones: [],
      lastActiveZoneKey: null,
      lastZoneDwellAtMs: null,
      currentZoneDwellMs: 0,
      lastZoneTrackPoint: null,
      lastRealZoneSeenAtMs: null,
      hostZoneCandidates: [],
      lastHostZoneKey: null,
      lastHostZoneDwellAtMs: null,
      hostCurrentZoneDwellMs: 0,
      // Дебаунс смены зоны
      pendingZoneName: null,
      pendingZoneEnteredAtMs: null,
      pendingZoneCount: 0
    };
  }

  _getCurrentMode(state) {
    if (state.isUnloading) return 'unloading';
    if (state.isMixing) return 'loading';
    return 'idle';
  }

  _resolveThresholds(settings = {}) {
    return {
      batchStartThresholdKg: Number(settings.batchStartThresholdKg) > 0 ? Number(settings.batchStartThresholdKg) : BATCH_START_THRESHOLD_KG,
      leftoverThresholdKg: Number(settings.leftoverThresholdKg) > 0 ? Number(settings.leftoverThresholdKg) : LEFTOVER_THRESHOLD_KG,
      unloadDropThresholdKg: Number(settings.unloadDropThresholdKg) > 0 ? Number(settings.unloadDropThresholdKg) : UNLOAD_DROP_THRESHOLD_KG,
      unloadMinPeakKg: Number(settings.unloadMinPeakKg) > 0 ? Number(settings.unloadMinPeakKg) : UNLOAD_MIN_PEAK_KG,
      unloadUpdateDeltaKg: Number(settings.unloadUpdateDeltaKg) > 0 ? Number(settings.unloadUpdateDeltaKg) : UNLOAD_UPDATE_DELTA_KG,
      unloadWeightBufferKg: Number(settings.unloadWeightBufferKg) > 0 ? Number(settings.unloadWeightBufferKg) : UNLOAD_WEIGHT_BUFFER_KG,
      emptyVehicleThresholdKg: Number(settings.emptyVehicleThresholdKg) > 0 ? Number(settings.emptyVehicleThresholdKg) : EMPTY_VEHICLE_THRESHOLD_KG,
      anomalyThresholdKg: Number(settings.anomalyThresholdKg) > 0 ? Number(settings.anomalyThresholdKg) : ANOMALY_THRESHOLD_KG,
      anomalyConfirmDeltaKg: Number(settings.anomalyConfirmDeltaKg) > 0 ? Number(settings.anomalyConfirmDeltaKg) : ANOMALY_CONFIRM_DELTA_KG,
      anomalyConfirmPackets: Number(settings.anomalyConfirmPackets) > 0 ? Number(settings.anomalyConfirmPackets) : ANOMALY_CONFIRM_PACKETS,
      movementSpeedThresholdKmh: Number(settings.movementSpeedThresholdKmh) > 0
        ? Number(settings.movementSpeedThresholdKmh)
        : MOVEMENT_SPEED_THRESHOLD_KMH,
      movementConfirmPackets: Number(settings.movementConfirmPackets) > 0
        ? Number(settings.movementConfirmPackets)
        : MOVEMENT_CONFIRM_PACKETS,
      zoneChangeDebounceMs: Number(settings.zoneChangeDebounceMs) > 0 ? Number(settings.zoneChangeDebounceMs) : DEFAULT_ZONE_DEBOUNCE_MS,
      nullZoneConfirmMs: Number(settings.nullZoneConfirmSeconds) > 0
        ? Number(settings.nullZoneConfirmSeconds) * 1000
        : (Number(settings.nullZoneConfirmMs) > 0 ? Number(settings.nullZoneConfirmMs) : NULL_ZONE_CONFIRM_SECONDS * 1000),
      zoneChangeConfirmPackets: Number(settings.zoneChangeConfirmPackets) > 0 ? Number(settings.zoneChangeConfirmPackets) : ZONE_CHANGE_CONFIRM_PACKETS,
      zoneDwellScoreCapSeconds: Number(settings.zoneDwellScoreCapSeconds) > 0 ? Number(settings.zoneDwellScoreCapSeconds) : ZONE_DWELL_SCORE_CAP_SECONDS,
      zoneEntryFrontBonus: resolveNonNegativeNumber(settings.zoneEntryFrontBonus, ZONE_ENTRY_FRONT_BONUS),
      zoneEntryRearPenalty: resolveNonNegativeNumber(settings.zoneEntryRearPenalty, ZONE_ENTRY_REAR_PENALTY),
      zoneEntryFrontAngleDeg: resolveBoundedNumber(settings.zoneEntryFrontAngleDeg, ZONE_ENTRY_FRONT_ANGLE_DEG, 1, 180),
      zoneEntryRearAngleDeg: resolveBoundedNumber(settings.zoneEntryRearAngleDeg, ZONE_ENTRY_REAR_ANGLE_DEG, 1, 180),
      squareHeadingScorePerSecond: resolveNonNegativeNumber(settings.squareHeadingScorePerSecond, SQUARE_HEADING_SCORE_PER_SECOND),
      squareHeadingScoreCap: resolveNonNegativeNumber(settings.squareHeadingScoreCap, SQUARE_HEADING_SCORE_CAP),
      squareHeadingMaxAngleDeg: resolveBoundedNumber(settings.squareHeadingMaxAngleDeg, SQUARE_HEADING_MAX_ANGLE_DEG, 1, 180),
      hostZoneOverrideNearMeters: resolveNonNegativeNumber(settings.hostZoneOverrideNearMeters, HOST_ZONE_OVERRIDE_NEAR_METERS),
      hostZoneOverrideMinDwellMs: resolveNonNegativeNumber(
        Number(settings.hostZoneOverrideMinDwellSeconds) * 1000,
        HOST_ZONE_OVERRIDE_MIN_DWELL_SECONDS * 1000
      ),
      hostZoneOverrideMinRtkDistanceMeters: resolveNonNegativeNumber(
        settings.hostZoneOverrideMinRtkDistanceMeters,
        HOST_ZONE_OVERRIDE_MIN_RTK_DISTANCE_METERS
      )
    };
  }

  _updateMovementState(state, speedKmh, thresholds) {
    const speed = Number.isFinite(Number(speedKmh)) ? Math.max(0, Number(speedKmh)) : 0;
    const isAboveThreshold = speed > thresholds.movementSpeedThresholdKmh;

    if (isAboveThreshold) {
      state.movingSpeedStreak = Number(state.movingSpeedStreak || 0) + 1;
      state.stationarySpeedStreak = 0;
    } else {
      state.stationarySpeedStreak = Number(state.stationarySpeedStreak || 0) + 1;
      state.movingSpeedStreak = 0;
    }

    const wasMoving = Boolean(state.isMoving);

    if (!wasMoving && state.movingSpeedStreak >= thresholds.movementConfirmPackets) {
      state.isMoving = true;
      state.stationarySpeedStreak = 0;
    } else if (wasMoving && !isAboveThreshold) {
      state.isMoving = false;
      state.movingSpeedStreak = 0;
    }

    return {
      speed,
      speedAboveThreshold: isAboveThreshold,
      suppressMotion: isAboveThreshold || Boolean(state.isMoving),
      isMoving: Boolean(state.isMoving),
      enteredMoving: !wasMoving && Boolean(state.isMoving),
      exitedMoving: wasMoving && !state.isMoving
    };
  }

  _parsePacketTimestampMs(packet) {
    const raw = packet?.timestamp;
    if (raw instanceof Date) {
      const ts = raw.getTime();
      return Number.isFinite(ts) ? ts : Date.now();
    }
    const ts = new Date(raw || Date.now()).getTime();
    return Number.isFinite(ts) ? ts : Date.now();
  }

  _zoneVisitKey(zoneObject, zoneName) {
    if (zoneObject?.id !== undefined && zoneObject?.id !== null) {
      return `zone:${zoneObject.id}`;
    }
    return zoneName ? `name:${zoneName}` : null;
  }

  _getOrCreateZoneVisit(state, zoneKey, zoneObject, ingredientName, packetTimeMs) {
    if (!Array.isArray(state.visitedZones)) {
      state.visitedZones = [];
    }

    let visit = state.visitedZones.find((item) => item.key === zoneKey);
    if (!visit) {
      visit = {
        key: zoneKey,
        zoneId: zoneObject?.id ?? null,
        name: zoneObject?.name || ingredientName || null,
        ingredient: ingredientName || zoneObject?.ingredient || zoneObject?.name || null,
        shapeType: String(zoneObject?.shapeType || 'CIRCLE').trim().toUpperCase(),
        loadingWallSide: zoneObject?.loadingWallSide ?? null,
        loadingNormalDeg: calculateLoadingNormalDeg(zoneObject),
        firstSeenAtMs: packetTimeMs,
        lastSeenAtMs: packetTimeMs,
        dwellMs: 0,
        maxContinuousDwellMs: 0,
        samples: 0,
        score: 0,
        dwellScore: 0,
        entryScore: 0,
        squareHeadingScore: 0,
        entryAngleDeg: null,
        entryKind: 'unknown',
        goodHeadingMs: 0,
        headingDwellMs: 0,
        headingSamples: 0,
        headingWeightedAngleSum: 0
      };
      state.visitedZones.push(visit);
    }

    visit.lastSeenAtMs = packetTimeMs;
    visit.name = visit.name || zoneObject?.name || ingredientName || null;
    visit.ingredient = visit.ingredient || ingredientName || zoneObject?.ingredient || zoneObject?.name || null;
    visit.shapeType = visit.shapeType || String(zoneObject?.shapeType || 'CIRCLE').trim().toUpperCase();
    visit.loadingWallSide = visit.loadingWallSide ?? zoneObject?.loadingWallSide ?? null;
    visit.loadingNormalDeg = visit.loadingNormalDeg ?? calculateLoadingNormalDeg(zoneObject);
    return visit;
  }

  _updateVisitScore(visit, thresholds) {
    if (!visit) return;

    const dwellSeconds = Number(visit.dwellMs || 0) / 1000;
    const dwellScore = Math.min(dwellSeconds, thresholds.zoneDwellScoreCapSeconds);
    const squareHeadingScore = Math.min(
      Number(visit.squareHeadingScore || 0),
      thresholds.squareHeadingScoreCap
    );

    visit.dwellScore = dwellScore;
    visit.score = dwellScore + Number(visit.entryScore || 0) + squareHeadingScore;
  }

  _applyEntryScore(visit, previousPoint, currentPoint, thresholds) {
    if (!visit || visit.entryKind !== 'unknown') return;
    if (!previousPoint || !currentPoint?.headingUsable) return;

    const prevLat = Number(previousPoint.lat);
    const prevLon = Number(previousPoint.lon);
    const lat = Number(currentPoint.lat);
    const lon = Number(currentPoint.lon);

    if (
      !Number.isFinite(prevLat) ||
      !Number.isFinite(prevLon) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return;
    }

    if (calculateHaversine(prevLat, prevLon, lat, lon) < 0.5) {
      return;
    }

    const movementBearing = calculateBearingDeg(prevLat, prevLon, lat, lon);
    const entryAngleDeg = angleDiffDeg(currentPoint.headingDeg, movementBearing);
    if (entryAngleDeg === null) return;

    visit.entryAngleDeg = entryAngleDeg;
    if (entryAngleDeg <= thresholds.zoneEntryFrontAngleDeg) {
      visit.entryKind = 'front';
      visit.entryScore = Number(thresholds.zoneEntryFrontBonus || 0);
      visit.frontEntry = true;
      visit.reverseEntry = false;
    } else if (entryAngleDeg >= thresholds.zoneEntryRearAngleDeg) {
      visit.entryKind = 'rear';
      visit.entryScore = -Number(thresholds.zoneEntryRearPenalty || 0);
      visit.frontEntry = false;
      visit.reverseEntry = true;
    } else {
      visit.entryKind = 'side';
      visit.entryScore = 0;
      visit.frontEntry = false;
      visit.reverseEntry = false;
    }
  }

  _applySquareHeadingScore(visit, point, elapsedMs, thresholds) {
    if (!visit || elapsedMs <= 0) return;
    if (String(visit.shapeType || '').trim().toUpperCase() !== 'SQUARE') return;
    if (!point?.headingUsable) return;

    const loadingNormalDeg = normalizeDegrees(visit.loadingNormalDeg);
    if (loadingNormalDeg === null) return;

    const headingDiffDeg = angleDiffDeg(point.headingDeg, loadingNormalDeg);
    if (headingDiffDeg === null) return;

    const elapsedSeconds = elapsedMs / 1000;
    visit.headingSamples = Number(visit.headingSamples || 0) + 1;
    visit.headingDwellMs = Number(visit.headingDwellMs || 0) + elapsedMs;
    visit.headingWeightedAngleSum = Number(visit.headingWeightedAngleSum || 0) + headingDiffDeg * elapsedMs;

    if (headingDiffDeg <= thresholds.squareHeadingMaxAngleDeg) {
      const factor = Math.cos(headingDiffDeg * Math.PI / 180) ** 2;
      visit.squareHeadingScore = Number(visit.squareHeadingScore || 0) +
        elapsedSeconds * Number(thresholds.squareHeadingScorePerSecond || 0) * factor;

      if (headingDiffDeg <= 45) {
        visit.goodHeadingMs = Number(visit.goodHeadingMs || 0) + elapsedMs;
      }
    }
  }

  _recordZoneVisit(state, activeZone, activeZoneName, activeIngredientName, packetTimeMs, thresholds, packet = {}) {
    if (!Array.isArray(state.visitedZones)) {
      state.visitedZones = [];
    }

    const activeZoneKey = this._zoneVisitKey(activeZone, activeZoneName);
    const previousZoneKey = state.lastActiveZoneKey || null;
    const previousPoint = state.lastZoneTrackPoint || null;
    const currentPoint = {
      lat: Number(packet?.lat),
      lon: Number(packet?.lon),
      headingDeg: parseHeadingDeg(packet),
      headingUsable: isHeadingUsable(packet)
    };
    const previousTimeMs = Number(state.lastZoneDwellAtMs);
    const elapsedMs = Number.isFinite(previousTimeMs)
      ? Math.max(0, Math.min(30000, packetTimeMs - previousTimeMs))
      : 0;

    if (previousZoneKey && elapsedMs > 0) {
      const previousVisit = state.visitedZones.find((item) => item.key === previousZoneKey);
      if (previousVisit) {
        previousVisit.dwellMs = Number(previousVisit.dwellMs || 0) + elapsedMs;
        this._applySquareHeadingScore(previousVisit, previousPoint, elapsedMs, thresholds);
        const continuousDwellMs = previousZoneKey === activeZoneKey
          ? Number(state.currentZoneDwellMs || 0) + elapsedMs
          : elapsedMs;
        previousVisit.maxContinuousDwellMs = Math.max(
          Number(previousVisit.maxContinuousDwellMs || 0),
          continuousDwellMs
        );
        this._updateVisitScore(previousVisit, thresholds);
      }
    }

    if (previousZoneKey && previousZoneKey === activeZoneKey) {
      state.currentZoneDwellMs = Number(state.currentZoneDwellMs || 0) + elapsedMs;
    } else {
      state.currentZoneDwellMs = 0;
    }

    if (activeZoneKey) {
      const activeVisit = this._getOrCreateZoneVisit(
        state,
        activeZoneKey,
        activeZone,
        activeIngredientName,
        packetTimeMs
      );
      if (previousZoneKey !== activeZoneKey) {
        this._applyEntryScore(activeVisit, previousPoint, currentPoint, thresholds);
      }
      activeVisit.samples = Number(activeVisit.samples || 0) + 1;
      this._updateVisitScore(activeVisit, thresholds);
    }

    state.lastActiveZoneKey = activeZoneKey;
    state.lastZoneDwellAtMs = packetTimeMs;
    state.lastZoneTrackPoint = Number.isFinite(currentPoint.lat) && Number.isFinite(currentPoint.lon)
      ? currentPoint
      : null;
  }

  _findHostZoneCandidate(zonesConfig, hostPosition, thresholds) {
    const lat = Number(hostPosition?.lat);
    const lon = Number(hostPosition?.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Array.isArray(zonesConfig)) {
      return null;
    }

    const nearMeters = Number(thresholds.hostZoneOverrideNearMeters || 0);
    const nearby = zonesConfig
      .map((zone) => {
        const distanceMeters = distanceToZoneMeters(lat, lon, zone);
        return {
          zone,
          distanceMeters,
          ingredient: zone?.ingredient || zone?.name || null,
          key: this._zoneVisitKey(zone, zone?.name || null)
        };
      })
      .filter((candidate) =>
        candidate.key &&
        candidate.ingredient &&
        Number.isFinite(candidate.distanceMeters) &&
        candidate.distanceMeters <= nearMeters
      )
      .sort((left, right) => left.distanceMeters - right.distanceMeters);

    if (!nearby.length) return null;

    const best = nearby[0];
    const bestIngredientKey = normalizeIngredientKey(best.ingredient);
    const hasAmbiguousNeighbor = nearby.slice(1).some((candidate) =>
      normalizeIngredientKey(candidate.ingredient) !== bestIngredientKey &&
      candidate.distanceMeters <= nearMeters
    );

    if (hasAmbiguousNeighbor) {
      return null;
    }

    return best;
  }

  _getOrCreateHostZoneCandidate(state, candidate, packetTimeMs, currentWeight) {
    if (!Array.isArray(state.hostZoneCandidates)) {
      state.hostZoneCandidates = [];
    }

    let hostCandidate = state.hostZoneCandidates.find((item) => item.key === candidate.key);
    if (!hostCandidate) {
      hostCandidate = {
        key: candidate.key,
        zoneId: candidate.zone?.id ?? null,
        name: candidate.zone?.name || candidate.ingredient || null,
        ingredient: candidate.ingredient || candidate.zone?.ingredient || candidate.zone?.name || null,
        firstSeenAtMs: packetTimeMs,
        lastSeenAtMs: packetTimeMs,
        dwellMs: 0,
        maxContinuousDwellMs: 0,
        samples: 0,
        minDistanceMeters: candidate.distanceMeters,
        maxDistanceMeters: candidate.distanceMeters,
        minWeight: currentWeight,
        maxWeight: currentWeight,
        rtkFreshSamples: 0,
        rtkFarSamples: 0,
        minRtkDistanceMeters: null,
        maxRtkDistanceMeters: null
      };
      state.hostZoneCandidates.push(hostCandidate);
    }

    hostCandidate.lastSeenAtMs = packetTimeMs;
    hostCandidate.name = hostCandidate.name || candidate.zone?.name || candidate.ingredient || null;
    hostCandidate.ingredient = hostCandidate.ingredient || candidate.ingredient || candidate.zone?.ingredient || candidate.zone?.name || null;
    hostCandidate.samples = Number(hostCandidate.samples || 0) + 1;
    hostCandidate.minDistanceMeters = Math.min(
      Number(hostCandidate.minDistanceMeters ?? candidate.distanceMeters),
      candidate.distanceMeters
    );
    hostCandidate.maxDistanceMeters = Math.max(
      Number(hostCandidate.maxDistanceMeters ?? candidate.distanceMeters),
      candidate.distanceMeters
    );
    hostCandidate.minWeight = Math.min(Number(hostCandidate.minWeight ?? currentWeight), currentWeight);
    hostCandidate.maxWeight = Math.max(Number(hostCandidate.maxWeight ?? currentWeight), currentWeight);
    return hostCandidate;
  }

  _recordHostZoneCandidate(state, zonesConfig, packetTimeMs, currentWeight, thresholds, options = {}) {
    const candidate = this._findHostZoneCandidate(zonesConfig, options.hostPosition, thresholds);
    const activeHostKey = candidate?.key || null;
    const previousHostKey = state.lastHostZoneKey || null;
    const previousTimeMs = Number(state.lastHostZoneDwellAtMs);
    const elapsedMs = Number.isFinite(previousTimeMs)
      ? Math.max(0, Math.min(30000, packetTimeMs - previousTimeMs))
      : 0;

    if (previousHostKey && elapsedMs > 0) {
      const previousCandidate = (state.hostZoneCandidates || []).find((item) => item.key === previousHostKey);
      if (previousCandidate) {
        previousCandidate.dwellMs = Number(previousCandidate.dwellMs || 0) + elapsedMs;
        const continuousDwellMs = previousHostKey === activeHostKey
          ? Number(state.hostCurrentZoneDwellMs || 0) + elapsedMs
          : elapsedMs;
        previousCandidate.maxContinuousDwellMs = Math.max(
          Number(previousCandidate.maxContinuousDwellMs || 0),
          continuousDwellMs
        );
      }
    }

    if (previousHostKey && previousHostKey === activeHostKey) {
      state.hostCurrentZoneDwellMs = Number(state.hostCurrentZoneDwellMs || 0) + elapsedMs;
    } else {
      state.hostCurrentZoneDwellMs = 0;
    }

    if (candidate) {
      const hostCandidate = this._getOrCreateHostZoneCandidate(state, candidate, packetTimeMs, currentWeight);
      const rtkPosition = options.rtkPosition || null;
      const rtkFresh = Boolean(options.rtkFresh);
      if (rtkFresh && Number.isFinite(Number(rtkPosition?.lat)) && Number.isFinite(Number(rtkPosition?.lon))) {
        const rtkDistanceMeters = distanceToZoneMeters(Number(rtkPosition.lat), Number(rtkPosition.lon), candidate.zone);
        hostCandidate.rtkFreshSamples = Number(hostCandidate.rtkFreshSamples || 0) + 1;
        hostCandidate.minRtkDistanceMeters = hostCandidate.minRtkDistanceMeters === null
          ? rtkDistanceMeters
          : Math.min(Number(hostCandidate.minRtkDistanceMeters), rtkDistanceMeters);
        hostCandidate.maxRtkDistanceMeters = hostCandidate.maxRtkDistanceMeters === null
          ? rtkDistanceMeters
          : Math.max(Number(hostCandidate.maxRtkDistanceMeters), rtkDistanceMeters);

        if (rtkDistanceMeters >= thresholds.hostZoneOverrideMinRtkDistanceMeters) {
          hostCandidate.rtkFarSamples = Number(hostCandidate.rtkFarSamples || 0) + 1;
        }
      }
    }

    state.lastHostZoneKey = activeHostKey;
    state.lastHostZoneDwellAtMs = packetTimeMs;
  }

  _pickHostZoneOverride(state, thresholds) {
    if (!Array.isArray(state?.hostZoneCandidates)) return null;

    const minDwellMs = Number(thresholds.hostZoneOverrideMinDwellMs || 0);
    const minDeltaKg = Number(thresholds.batchStartThresholdKg || 0);

    const candidates = state.hostZoneCandidates
      .map((candidate) => ({
        ...candidate,
        weightDeltaKg: Number(candidate.maxWeight || 0) - Number(candidate.minWeight || 0)
      }))
      .filter((candidate) => {
        const hasEnoughDwell = Number(candidate.maxContinuousDwellMs || 0) >= minDwellMs;
        const hasEnoughWeight = Number(candidate.weightDeltaKg || 0) > minDeltaKg;
        const hasNoFreshRtk = Number(candidate.rtkFreshSamples || 0) <= 0;
        const hasMostlyFarRtk = Number(candidate.rtkFreshSamples || 0) > 0 &&
          Number(candidate.rtkFarSamples || 0) / Number(candidate.rtkFreshSamples || 1) >= 0.8;

        return hasEnoughDwell && hasEnoughWeight && (hasNoFreshRtk || hasMostlyFarRtk);
      })
      .sort((left, right) => {
        const weightDiff = Number(right.weightDeltaKg || 0) - Number(left.weightDeltaKg || 0);
        if (weightDiff !== 0) return weightDiff;
        const dwellDiff = Number(right.maxContinuousDwellMs || 0) - Number(left.maxContinuousDwellMs || 0);
        if (dwellDiff !== 0) return dwellDiff;
        return Number(right.lastSeenAtMs || 0) - Number(left.lastSeenAtMs || 0);
      });

    return candidates[0]?.ingredient || candidates[0]?.name || null;
  }

  _pickVisitedZoneIngredient(state) {
    if (!Array.isArray(state?.visitedZones)) return null;

    const candidates = state.visitedZones
      .filter((visit) => Number(visit.dwellMs || 0) > 0 && (visit.ingredient || visit.name))
      .sort((a, b) => {
        const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        const headingScoreDiff = Number(b.squareHeadingScore || 0) - Number(a.squareHeadingScore || 0);
        if (headingScoreDiff !== 0) return headingScoreDiff;
        const dwellDiff = Number(b.dwellMs || 0) - Number(a.dwellMs || 0);
        if (dwellDiff !== 0) return dwellDiff;
        return Number(b.lastSeenAtMs || 0) - Number(a.lastSeenAtMs || 0);
      });

    return candidates[0]?.ingredient || candidates[0]?.name || null;
  }

  _resetVisitedZones(state, packetTimeMs = Date.now()) {
    state.visitedZones = [];
    state.lastActiveZoneKey = null;
    state.lastZoneDwellAtMs = packetTimeMs;
    state.currentZoneDwellMs = 0;
    state.lastZoneTrackPoint = null;
    state.hostZoneCandidates = [];
    state.lastHostZoneKey = null;
    state.lastHostZoneDwellAtMs = packetTimeMs;
    state.hostCurrentZoneDwellMs = 0;
  }

  _serializeZoneCandidates(state) {
    if (!Array.isArray(state?.visitedZones)) return [];

    return state.visitedZones.map((visit) => ({
      name: visit.name,
      ingredient: visit.ingredient,
      score: Math.round(Number(visit.score || 0) * 10) / 10,
      dwellScore: Math.round(Number(visit.dwellScore || 0) * 10) / 10,
      entryScore: Math.round(Number(visit.entryScore || 0) * 10) / 10,
      squareHeadingScore: Math.round(Number(visit.squareHeadingScore || 0) * 10) / 10,
      entryAngleDeg: visit.entryAngleDeg !== null &&
        visit.entryAngleDeg !== undefined &&
        Number.isFinite(Number(visit.entryAngleDeg))
        ? Math.round(Number(visit.entryAngleDeg) * 10) / 10
        : null,
      entryKind: visit.entryKind || 'unknown',
      avgPileAngleDeg: Number(visit.headingDwellMs || 0) > 0
        ? Math.round((Number(visit.headingWeightedAngleSum || 0) / Number(visit.headingDwellMs || 1)) * 10) / 10
        : null,
      goodHeadingSeconds: Math.round(Number(visit.goodHeadingMs || 0) / 100) / 10,
      headingSamples: Number(visit.headingSamples || 0),
      dwellSeconds: Math.round(Number(visit.dwellMs || 0) / 100) / 10,
      maxContinuousSeconds: Math.round(Number(visit.maxContinuousDwellMs || 0) / 100) / 10,
      samples: Number(visit.samples || 0)
    }));
  }

  _buildSkippedResult(deviceId) {
    return {
      isValid: true,
      skipped: true,
      error: null,
      banner: null,
      dbActions: [],
      state: this.getState(deviceId)
    };
  }

  _serializeHostZoneCandidates(state) {
    if (!Array.isArray(state?.hostZoneCandidates)) return [];

    return state.hostZoneCandidates.map((candidate) => ({
      name: candidate.name,
      ingredient: candidate.ingredient,
      dwellSeconds: Math.round(Number(candidate.dwellMs || 0) / 100) / 10,
      maxContinuousSeconds: Math.round(Number(candidate.maxContinuousDwellMs || 0) / 100) / 10,
      weightDeltaKg: Math.round((Number(candidate.maxWeight || 0) - Number(candidate.minWeight || 0)) * 10) / 10,
      minDistanceMeters: Number.isFinite(Number(candidate.minDistanceMeters))
        ? Math.round(Number(candidate.minDistanceMeters) * 10) / 10
        : null,
      maxDistanceMeters: Number.isFinite(Number(candidate.maxDistanceMeters))
        ? Math.round(Number(candidate.maxDistanceMeters) * 10) / 10
        : null,
      rtkFreshSamples: Number(candidate.rtkFreshSamples || 0),
      rtkFarSamples: Number(candidate.rtkFarSamples || 0),
      minRtkDistanceMeters: candidate.minRtkDistanceMeters !== null &&
        Number.isFinite(Number(candidate.minRtkDistanceMeters))
        ? Math.round(Number(candidate.minRtkDistanceMeters) * 10) / 10
        : null,
      samples: Number(candidate.samples || 0)
    }));
  }

  processLoaderPacket(packet, zonesConfig, settings = {}, options = {}) {
    const deviceId = options.deviceId || packet.deviceId || packet.hostDeviceId || packet.host_device_id || 'host_01';
    const lat = Number(packet.lat);
    const lon = Number(packet.lon);
    const packetTimeMs = this._parsePacketTimestampMs(packet);
    const thresholds = this._resolveThresholds(settings);

    if (!isValidLocation(lat, lon)) {
      return {
        isValid: false,
        error: 'Invalid GPS coordinates',
        state: this.getState(deviceId)
      };
    }

    let state = this.deviceStates.get(deviceId);
    if (!state) {
      state = this.getInitialState(Number(packet.weight || 0));
      state.hasWeightBaseline = false;
      this.deviceStates.set(deviceId, state);
    }

    const activeZone = detectZoneObject(lat, lon, zonesConfig);
    const activeZoneName = activeZone?.name || null;
    const activeIngredientName = activeZone?.ingredient || activeZoneName;

    this._recordZoneVisit(
      state,
      activeZone,
      activeZoneName,
      activeIngredientName,
      packetTimeMs,
      thresholds,
      packet
    );

    if (activeZoneName) {
      state.lastRealZoneSeenAtMs = packetTimeMs;
    }

    return {
      isValid: true,
      error: null,
      state: this.getState(deviceId)
    };
  }

  _resolveSegmentIngredient(state, thresholds) {
    return this._pickHostZoneOverride(state, thresholds) ||
      this._pickVisitedZoneIngredient(state) ||
      state.currentZone?.ingredient ||
      state.lastIngredientName ||
      'Unknown';
  }

  _flushCurrentSegment(state, currentWeight, thresholds, result, options = {}) {
    if (options.suppressLoading && !state.currentZone) {
      return false;
    }

    const segmentEndWeight = Number(options.segmentEndWeight ?? currentWeight);
    const delta = segmentEndWeight - Number(state.zoneStartWeight || 0);

    if (!(delta > thresholds.batchStartThresholdKg)) {
      return false;
    }

    if (!state.isBatchStarted) {
      state.isBatchStarted = true;
      result.dbActions.push({
        type: 'START_BATCH',
        startWeight: Math.round(state.zoneStartWeight)
      });
    }

    const ingredientName = this._resolveSegmentIngredient(state, thresholds);
    state.isMixing = true;
    state.lastIngredientName = ingredientName;

    result.dbActions.push({
      type: 'ADD_INGREDIENT',
      ingredientName,
      actualWeight: Math.round(delta)
    });

    this._resetVisitedZones(state, Number(options.packetTimeMs || Date.now()));

    return true;
  }

  _confirmZoneChange(state, zoneName, zoneObject, ingredientName, currentWeight, thresholds, result, options = {}) {
    // Флешим сегмент ПРЕДЫДУЩЕЙ подтверждённой зоны
    this._flushCurrentSegment(state, currentWeight, thresholds, result, {
      suppressLoading: options.suppressLoading,
      packetTimeMs: options.packetTimeMs
    });

    // Обновляем состояние на НОВУЮ подтверждённую зону
    state.currentZone = zoneObject ? { ...zoneObject, ingredient: ingredientName } : null;
    state.confirmedZoneName = zoneName;
    state.zoneStartWeight = currentWeight;
  }

  processPacket(packet, zonesConfig, settings = {}, options = {}) {
    const result = {
      isValid: true,
      error: null,
      banner: null,
      dbActions: []
    };

    const deviceId = packet.deviceId || packet.device_id || 'host_01';
    const lat = Number(packet.lat);
    const lon = Number(packet.lon);
    const currentWeightRaw = Number(packet.weight || 0);
    const currentWeight = Number.isFinite(currentWeightRaw)
      ? Math.max(0, currentWeightRaw)
      : 0;
    const thresholds = this._resolveThresholds(settings);
    const suppressLoading = Boolean(options.suppressLoading);
    const packetTimeMs = this._parsePacketTimestampMs(packet);

    if (!isValidLocation(lat, lon)) {
      result.isValid = false;
      result.error = 'Invalid GPS coordinates';
      return result;
    }

    let state = this.deviceStates.get(deviceId);
    if (!state) {
      state = this.getInitialState(currentWeight);
      this.deviceStates.set(deviceId, state);
    } else if (state.hasWeightBaseline === false) {
      state.zoneStartWeight = currentWeight;
      state.peakWeight = currentWeight;
      state.lastStationaryWeight = currentWeight;
      state.lastAcceptedWeight = null;
      state.hasWeightBaseline = true;
    }

    const movement = this._updateMovementState(state, packet.speedKmh, thresholds);
    const isMotionSuppressed = Boolean(movement.suppressMotion);

    if (state.lastAcceptedWeight === null) {
      state.lastAcceptedWeight = currentWeight;
    }

    // Фильтр аномалий веса
    if (movement.enteredMoving) {
      const departureWeight = Number(state.lastStationaryWeight ?? state.lastAcceptedWeight ?? currentWeight);
      this._flushCurrentSegment(
        state,
        departureWeight,
        thresholds,
        result,
        { suppressLoading, packetTimeMs }
      );
      state.zoneStartWeight = departureWeight;
      this._resetVisitedZones(state, packetTimeMs);
      state.pendingZoneName = null;
      state.pendingZoneEnteredAtMs = null;
      state.pendingZoneCount = 0;
    }

    if (isMotionSuppressed) {
      state.lastAcceptedWeight = currentWeight;
      state.anomalyCandidateWeight = null;
      state.anomalyCandidateCount = 0;
    } else {
      const deltaFromAccepted = Math.abs(currentWeight - state.lastAcceptedWeight);
      if (deltaFromAccepted > thresholds.anomalyThresholdKg) {
        if (
          state.anomalyCandidateWeight !== null &&
          Math.abs(currentWeight - state.anomalyCandidateWeight) <= thresholds.anomalyConfirmDeltaKg
        ) {
          state.anomalyCandidateCount += 1;
        } else {
          state.anomalyCandidateWeight = currentWeight;
          state.anomalyCandidateCount = 1;
        }

        if (state.anomalyCandidateCount < thresholds.anomalyConfirmPackets) {
          return this._buildSkippedResult(deviceId);
        }

        state.lastAcceptedWeight = state.anomalyCandidateWeight;
        state.anomalyCandidateWeight = null;
        state.anomalyCandidateCount = 0;
      } else if (state.anomalyCandidateWeight !== null || state.anomalyCandidateCount > 0) {
        state.anomalyCandidateWeight = null;
        state.anomalyCandidateCount = 0;
      }
    }

    const activeZone = detectZoneObject(lat, lon, zonesConfig);
    const activeZoneName = activeZone?.name || null;
    const activeIngredientName = activeZone?.ingredient || activeZoneName;
    if (!isMotionSuppressed) {
      if (!options.skipZoneVisit) {
        this._recordZoneVisit(
          state,
          activeZone,
          activeZoneName,
          activeIngredientName,
          packetTimeMs,
          thresholds,
          packet
        );
      }
      this._recordHostZoneCandidate(
        state,
        zonesConfig,
        packetTimeMs,
        currentWeight,
        thresholds,
        {
          ...options,
          hostPosition: options.hostPosition || { lat, lon }
        }
      );
      if (activeZoneName) {
        state.lastRealZoneSeenAtMs = packetTimeMs;
      }
    }

    // БАННЕР: показываем сразу при первом детектировании (для отзывчивости UI)
    if (activeZoneName && activeZoneName !== state.lastZoneName) {
      result.banner = {
        type: 'zone_enter',
        message: `Въезд в зону ${activeZoneName}`
      };
      state.lastZoneName = activeZoneName;
    }

    // ДЕБАУНС/ПОДТВЕРЖДЕНИЕ смены зоны (бизнес-логика)
    const confirmedZoneName = state.confirmedZoneName || null;
    const lastRealZoneSeenAtMs = Number(state.lastRealZoneSeenAtMs);
    const shouldConfirmNullZone = !activeZoneName &&
      confirmedZoneName !== null &&
      Number.isFinite(lastRealZoneSeenAtMs) &&
      packetTimeMs - lastRealZoneSeenAtMs >= thresholds.nullZoneConfirmMs;
    const looksLikeUnloadDrop = state.isMixing &&
      state.peakWeight > thresholds.unloadMinPeakKg &&
      currentWeight < state.peakWeight - thresholds.unloadDropThresholdKg;

    if (!isMotionSuppressed && shouldConfirmNullZone && !looksLikeUnloadDrop) {
      this._confirmZoneChange(
        state,
        null,
        null,
        null,
        currentWeight,
        thresholds,
        result,
        { suppressLoading, packetTimeMs }
      );
      state.pendingZoneName = null;
      state.pendingZoneEnteredAtMs = null;
      state.pendingZoneCount = 0;
    } else if (isMotionSuppressed) {
      // Speed-filtered packets must not affect zone confirmation.
    } else if (!activeZoneName) {
      state.pendingZoneName = null;
      state.pendingZoneEnteredAtMs = null;
      state.pendingZoneCount = 0;
    } else if (activeZoneName !== confirmedZoneName) {
      if (activeZoneName === state.pendingZoneName) {
        state.pendingZoneCount = Number(state.pendingZoneCount || 0) + 1;
        const timeInPending = packetTimeMs - Number(state.pendingZoneEnteredAtMs || packetTimeMs);

        if (
          !isMotionSuppressed &&
          state.pendingZoneCount >= thresholds.zoneChangeConfirmPackets &&
          timeInPending >= thresholds.zoneChangeDebounceMs
        ) {
          this._confirmZoneChange(
            state,
            activeZoneName,
            activeZone,
            activeIngredientName,
            currentWeight,
            thresholds,
            result,
            { suppressLoading, packetTimeMs }
          );
          state.pendingZoneName = null;
          state.pendingZoneEnteredAtMs = null;
          state.pendingZoneCount = 0;
        }
      } else {
        state.pendingZoneName = activeZoneName;
        state.pendingZoneEnteredAtMs = packetTimeMs;
        state.pendingZoneCount = 1;
      }
    } else {
      state.pendingZoneName = null;
      state.pendingZoneEnteredAtMs = null;
      state.pendingZoneCount = 0;
    }

    // Базовый вес обновляется только в спокойном режиме
    if (!isMotionSuppressed && !state.isMixing && !state.isUnloading) {
      if (currentWeight < state.zoneStartWeight) {
        state.zoneStartWeight = currentWeight;
      }
    }

    if (!isMotionSuppressed && currentWeight > state.peakWeight) {
      state.peakWeight = currentWeight;
    }

    // ЯВНАЯ ДЕТЕКЦИЯ UNKNOWN ВНЕ ЗОН
    if (
      !state.currentZone &&
      !suppressLoading &&
      !isMotionSuppressed &&
      !state.isUnloading &&
      !state.isBatchStarted &&
      (currentWeight - Number(state.zoneStartWeight || 0)) > thresholds.batchStartThresholdKg
    ) {
      state.isBatchStarted = true;
      state.isMixing = true;
      state.lastIngredientName = this._resolveSegmentIngredient(state, thresholds);

      result.dbActions.push({
        type: 'START_BATCH',
        startWeight: Math.round(state.zoneStartWeight)
      });
    }

    // Защита от недовыгрузки
    if (
      !isMotionSuppressed &&
      state.isUnloading &&
      Number.isFinite(state.lastUnloadWeight) &&
      currentWeight > state.lastUnloadWeight + thresholds.unloadWeightBufferKg
    ) {
      const leftoverWeight = state.lastUnloadWeight;
  
      if (leftoverWeight > thresholds.leftoverThresholdKg) {
        result.dbActions.push({
          type: 'LEFTOVER_VIOLATION',
          leftoverWeight: Math.round(leftoverWeight),
        });
      }

      result.dbActions.push({
        type: 'FORCE_CLOSE_BATCH',
        closeWeight: Math.round(leftoverWeight),
        nextStartWeight: Math.round(currentWeight)
      });

      state.zoneStartWeight = state.lastUnloadWeight;
      state.isMixing = false;
      state.isUnloading = false;
      state.isBatchStarted = false;
      state.peakWeight = currentWeight;
      state.lastUnloadWeight = null;
    }

    // Детекция выгрузки
    if (
      !isMotionSuppressed &&
      !state.isUnloading &&
      (
        state.isMixing ||
        (!suppressLoading && (currentWeight - Number(state.zoneStartWeight || 0)) > thresholds.batchStartThresholdKg)
      ) &&
      state.peakWeight > thresholds.unloadMinPeakKg &&
      currentWeight < state.peakWeight - thresholds.unloadDropThresholdKg
    ) {
      this._flushCurrentSegment(state, currentWeight, thresholds, result, {
        segmentEndWeight: state.peakWeight,
        packetTimeMs
      });
      state.isUnloading = true;
      state.lastUnloadWeight = currentWeight;

      result.dbActions.push({
        type: 'START_UNLOAD',
        startUnloadWeight: Math.round(currentWeight),
        peakWeight: state.peakWeight
      });

      result.dbActions.push({
        type: 'UPDATE_UNLOAD',
        endWeight: Math.round(currentWeight)
      });
    } else if (
      !isMotionSuppressed &&
      state.isUnloading &&
      Number.isFinite(state.lastUnloadWeight) &&
      Math.abs(currentWeight - state.lastUnloadWeight) >= thresholds.unloadUpdateDeltaKg
    ) {
      state.lastUnloadWeight = currentWeight;
      result.dbActions.push({
        type: 'UPDATE_UNLOAD',
        endWeight: Math.round(currentWeight)
      });
    }

    // Окончание: если кузов пуст
    if (!isMotionSuppressed && state.isUnloading && currentWeight < thresholds.emptyVehicleThresholdKg) {
      result.dbActions.push({
        type: 'COMPLETE_BATCH',
        endWeight: Math.round(currentWeight)
      });

      this.deviceStates.delete(deviceId);
    }

    // Вывод состояния (на основе подтверждённой зоны)
    if (!isMotionSuppressed) {
      state.lastStationaryWeight = currentWeight;
    }

    result.state = {
      currentZone: state.confirmedZoneName,
      currentIngredient: state.currentZone?.ingredient || (state.isMixing ? state.lastIngredientName : null),
      isMixing: state.isMixing,
      isUnloading: state.isUnloading,
      isMoving: movement.isMoving,
      peakWeight: state.peakWeight,
      lastIngredientName: state.lastIngredientName,
      isBatchStarted: state.isBatchStarted,
      currentMode: this._getCurrentMode(state),
      zoneCandidates: this._serializeZoneCandidates(state),
      hostZoneCandidates: this._serializeHostZoneCandidates(state)
    };

    state.lastAcceptedWeight = currentWeight;
    return result;
  }

  getState(deviceId) {
    const state = this.deviceStates.get(deviceId) || this.getInitialState();
    return {
      ...state,
      currentZone: state.confirmedZoneName || null,
      currentIngredient: state.currentZone?.ingredient || state.lastIngredientName || null,
      isMoving: state.isMoving,
      currentMode: this._getCurrentMode(state),
      zoneCandidates: this._serializeZoneCandidates(state),
      hostZoneCandidates: this._serializeHostZoneCandidates(state)
    };
  }

  getDeviceState(deviceId) {
    return this.getState(deviceId);
  }

  clearDeviceState(deviceId) {
    if (!deviceId) return;
    this.deviceStates.delete(deviceId);
  }

  clearStates() {
    this.deviceStates.clear();
  }
}

export default new TelemetryProcessor();

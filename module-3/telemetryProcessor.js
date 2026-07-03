import { calculateHaversine, detectZoneObject } from '../module-1/geo.js';
import { isValidLocation } from '../module-1/validator.js';
import { normalizeIngredientName } from '../module-2/rationManager.js';
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
  SQUARE_HEADING_MAX_ANGLE_DEG
} from './config.js';

const LOADING_START_CONFIRM_PACKETS = 2;
const MIN_LOADING_IDLE_CLOSE_MS = 15000;
const FIRST_BATCH_START_MARGIN_MIN_KG = 5;
const FIRST_BATCH_START_MARGIN_RATIO = 0.15;
const LOADING_SCORE_FREEZE_LOOKBACK_MS = 3000;
const ZONE_VISIT_SNAPSHOT_RETENTION_MS = 10 * 60 * 1000;
const ZONE_VISIT_SNAPSHOT_LIMIT = 1000;
const FORCE_CURRENT_ZONE_INGREDIENT_KEYS = new Set([
  normalizeIngredientName('Комбикорм')
]);

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

function detectZoneWithRadiusFallback(lat, lon, zonesConfig = []) {
  const exactZone = detectZoneObject(lat, lon, zonesConfig);
  if (exactZone) return exactZone;

  let closestZone = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const zone of zonesConfig) {
    const zoneLat = Number(zone?.lat);
    const zoneLon = Number(zone?.lon);
    const radius = Number(zone?.radius);

    if (
      !Number.isFinite(zoneLat) ||
      !Number.isFinite(zoneLon) ||
      !Number.isFinite(radius) ||
      radius <= 0
    ) {
      continue;
    }

    const distance = calculateHaversine(lat, lon, zoneLat, zoneLon);
    if (distance <= radius && distance < closestDistance) {
      closestZone = zone;
      closestDistance = distance;
    }
  }

  return closestZone;
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
      zoneStartTimeMs: null,
      zoneStartLat: null,
      zoneStartLon: null,
      segmentPeakWeight: weight,
      segmentPeakTimeMs: null,
      segmentPeakLat: null,
      segmentPeakLon: null,
      loadingStartTimeMs: null,
      loadingStartLat: null,
      loadingStartLon: null,
      loadingForcedIngredientName: null,
      loadingCandidateCount: 0,
      loadingCandidateTimeMs: null,
      loadingCandidateLat: null,
      loadingCandidateLon: null,
      loadingCandidateWeight: null,
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
      lastKnownNormalWeight: Math.max(0, Number(weight || 0)),
      lastKnownNormalTimeMs: null,
      lastKnownNormalLat: null,
      lastKnownNormalLon: null,
      recoveryBaselineWeight: null,
      recoveryBaselineTimeMs: null,
      recoveryBaselineLat: null,
      recoveryBaselineLon: null,
      recoveryMassRecorded: false,
      recoveringFromInvalidWeight: false,
      recoveredOutsideLoadingContext: false,
      isMoving: false,
      movingSpeedStreak: 0,
      stationarySpeedStreak: 0,
      visitedZones: [],
      zoneVisitSnapshots: [],
      frozenVisitedZones: null,
      frozenZoneScoreCutoffMs: null,
      lastActiveZoneKey: null,
      lastZoneDwellAtMs: null,
      currentZoneDwellMs: 0,
      lastZoneTrackPoint: null,
      lastRealZoneSeenAtMs: null,
      loadedIngredientKeys: [],
      // Дебаунс смены зоны
      pendingZoneName: null,
      pendingZoneEnteredAtMs: null,
      pendingZoneCount: 0
    };
  }

  _setZoneBaseline(state, weight, packetTimeMs = null, lat = null, lon = null) {
    state.zoneStartWeight = weight;
    if (Number.isFinite(Number(packetTimeMs))) {
      state.zoneStartTimeMs = Number(packetTimeMs);
    }
    if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
      state.zoneStartLat = Number(lat);
      state.zoneStartLon = Number(lon);
    }
    state.segmentPeakWeight = weight;
    state.segmentPeakTimeMs = Number.isFinite(Number(packetTimeMs)) ? Number(packetTimeMs) : null;
    state.segmentPeakLat = Number.isFinite(Number(lat)) ? Number(lat) : null;
    state.segmentPeakLon = Number.isFinite(Number(lon)) ? Number(lon) : null;
    state.loadingStartTimeMs = null;
    state.loadingStartLat = null;
    state.loadingStartLon = null;
    state.loadingForcedIngredientName = null;
    this._clearLoadingCandidate(state);
  }

  _clearLoadingCandidate(state) {
    state.loadingCandidateCount = 0;
    state.loadingCandidateTimeMs = null;
    state.loadingCandidateLat = null;
    state.loadingCandidateLon = null;
    state.loadingCandidateWeight = null;
  }

  _rememberSegmentPeak(state, weight, packetTimeMs = null, lat = null, lon = null) {
    const parsedWeight = Number(weight);
    if (!Number.isFinite(parsedWeight)) {
      return;
    }

    if (
      !Number.isFinite(Number(state.segmentPeakWeight)) ||
      parsedWeight > Number(state.segmentPeakWeight)
    ) {
      state.segmentPeakWeight = parsedWeight;
      state.segmentPeakTimeMs = Number.isFinite(Number(packetTimeMs)) ? Number(packetTimeMs) : null;
      state.segmentPeakLat = Number.isFinite(Number(lat)) ? Number(lat) : null;
      state.segmentPeakLon = Number.isFinite(Number(lon)) ? Number(lon) : null;
    }
  }

  _rememberLoadingStart(state, packetTimeMs = null, lat = null, lon = null) {
    if (state.loadingStartTimeMs === null && Number.isFinite(Number(packetTimeMs))) {
      state.loadingStartTimeMs = Number(packetTimeMs);
    }
    if (
      state.loadingStartLat === null &&
      state.loadingStartLon === null &&
      Number.isFinite(Number(lat)) &&
      Number.isFinite(Number(lon))
    ) {
      state.loadingStartLat = Number(lat);
      state.loadingStartLon = Number(lon);
    }
  }

  _getEffectiveBatchStartThreshold(state, thresholds) {
    const baseThreshold = Number(thresholds.batchStartThresholdKg || 0);
    if (state.isBatchStarted || state.isMixing) {
      return baseThreshold;
    }

    return baseThreshold + Math.max(FIRST_BATCH_START_MARGIN_MIN_KG, baseThreshold * FIRST_BATCH_START_MARGIN_RATIO);
  }

  _updateLoadingStartCandidate(state, currentWeight, thresholds, packetTimeMs = null, lat = null, lon = null) {
    if (state.loadingStartTimeMs !== null) {
      return true;
    }

    const delta = Number(currentWeight) - Number(state.zoneStartWeight || 0);
    if (!(delta > this._getEffectiveBatchStartThreshold(state, thresholds))) {
      this._clearLoadingCandidate(state);
      return false;
    }

    if (state.loadingCandidateTimeMs === null) {
      state.loadingCandidateCount = 1;
      state.loadingCandidateTimeMs = Number.isFinite(Number(packetTimeMs)) ? Number(packetTimeMs) : null;
      state.loadingCandidateLat = Number.isFinite(Number(lat)) ? Number(lat) : null;
      state.loadingCandidateLon = Number.isFinite(Number(lon)) ? Number(lon) : null;
      state.loadingCandidateWeight = Number.isFinite(Number(currentWeight)) ? Number(currentWeight) : null;
    } else {
      state.loadingCandidateCount = Number(state.loadingCandidateCount || 0) + 1;
      if (
        Number.isFinite(Number(currentWeight)) &&
        (
          state.loadingCandidateWeight === null ||
          Number(currentWeight) > Number(state.loadingCandidateWeight)
        )
      ) {
        state.loadingCandidateWeight = Number(currentWeight);
      }
    }

    if (Number(state.loadingCandidateCount || 0) < LOADING_START_CONFIRM_PACKETS) {
      return false;
    }

    this._rememberLoadingStart(
      state,
      state.loadingCandidateTimeMs ?? packetTimeMs,
      state.loadingCandidateLat ?? lat,
      state.loadingCandidateLon ?? lon
    );
    return true;
  }

  _getBatchStartWeight(state) {
    if (state.recoveredOutsideLoadingContext) {
      return Math.round(Number(state.recoveryBaselineWeight ?? state.lastKnownNormalWeight ?? 0));
    }
    return Math.round(Number(state.zoneStartWeight || 0));
  }

  _rememberNormalWeight(state, weight) {
    const normalWeight = Number(weight);
    if (
      !Number.isFinite(normalWeight) ||
      normalWeight < 0 ||
      state.recoveringFromInvalidWeight ||
      state.recoveredOutsideLoadingContext
    ) {
      return;
    }
    state.lastKnownNormalWeight = normalWeight;
  }

  _emitRecoveryMassIfNeeded(state, result, thresholds) {
    if (!state.recoveredOutsideLoadingContext || state.recoveryMassRecorded) {
      return false;
    }

    const recoveryBaselineWeight = Number(state.recoveryBaselineWeight ?? state.lastKnownNormalWeight ?? 0);
    const recoveredWeight = Number(state.zoneStartWeight || 0);
    const recoveryDelta = recoveredWeight - recoveryBaselineWeight;

    if (!(recoveryDelta > thresholds.batchStartThresholdKg)) {
      state.recoveryMassRecorded = true;
      return false;
    }

    result.dbActions.push({
      type: 'ADD_INGREDIENT',
      ingredientName: 'Восстановление терминала',
      actualWeight: Math.round(recoveryDelta),
      startTime: Number.isFinite(Number(state.zoneStartTimeMs))
        ? new Date(Number(state.zoneStartTimeMs)).toISOString()
        : null,
      startLat: state.zoneStartLat !== null && Number.isFinite(Number(state.zoneStartLat)) ? Number(state.zoneStartLat) : null,
      startLon: state.zoneStartLon !== null && Number.isFinite(Number(state.zoneStartLon)) ? Number(state.zoneStartLon) : null,
      endTime: Number.isFinite(Number(state.zoneStartTimeMs))
        ? new Date(Number(state.zoneStartTimeMs)).toISOString()
        : null,
      endLat: state.zoneStartLat !== null && Number.isFinite(Number(state.zoneStartLat)) ? Number(state.zoneStartLat) : null,
      endLon: state.zoneStartLon !== null && Number.isFinite(Number(state.zoneStartLon)) ? Number(state.zoneStartLon) : null
    });
    state.recoveryMassRecorded = true;
    state.lastIngredientName = 'Восстановление терминала';
    return true;
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
      squareHeadingMaxAngleDeg: resolveBoundedNumber(settings.squareHeadingMaxAngleDeg, SQUARE_HEADING_MAX_ANGLE_DEG, 1, 180)
    };
  }

  _updateMovementState(state, speedKmh, thresholds) {
    const speed = Number.isFinite(Number(speedKmh)) ? Math.max(0, Number(speedKmh)) : 0;
    const isAboveThreshold = speed >= thresholds.movementSpeedThresholdKmh;
    const isStopped = speed === 0;

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
    } else if (wasMoving && isStopped) {
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

  _cloneZoneVisit(visit) {
    return visit ? { ...visit } : null;
  }

  _cloneZoneVisits(visits = []) {
    return (Array.isArray(visits) ? visits : [])
      .map((visit) => this._cloneZoneVisit(visit))
      .filter(Boolean);
  }

  _rememberZoneVisitSnapshot(state, packetTimeMs) {
    if (!Number.isFinite(Number(packetTimeMs))) return;
    if (!Array.isArray(state.zoneVisitSnapshots)) {
      state.zoneVisitSnapshots = [];
    }

    const timestampMs = Number(packetTimeMs);
    state.zoneVisitSnapshots.push({
      timestampMs,
      visitedZones: this._cloneZoneVisits(state.visitedZones)
    });

    const minTimestampMs = timestampMs - ZONE_VISIT_SNAPSHOT_RETENTION_MS;
    while (
      state.zoneVisitSnapshots.length > ZONE_VISIT_SNAPSHOT_LIMIT ||
      (
        state.zoneVisitSnapshots.length > 1 &&
        Number(state.zoneVisitSnapshots[0]?.timestampMs || 0) < minTimestampMs
      )
    ) {
      state.zoneVisitSnapshots.shift();
    }
  }

  _freezeZoneScoreboardForLoading(state) {
    if (!state || state.frozenVisitedZones || !Number.isFinite(Number(state.loadingStartTimeMs))) {
      return;
    }

    const cutoffMs = Number(state.loadingStartTimeMs) - LOADING_SCORE_FREEZE_LOOKBACK_MS;
    const snapshots = Array.isArray(state.zoneVisitSnapshots) ? state.zoneVisitSnapshots : [];
    let selectedSnapshot = null;

    for (const snapshot of snapshots) {
      const snapshotTimeMs = Number(snapshot?.timestampMs);
      if (!Number.isFinite(snapshotTimeMs)) continue;
      if (snapshotTimeMs <= cutoffMs) {
        selectedSnapshot = snapshot;
      } else {
        break;
      }
    }

    state.frozenVisitedZones = this._cloneZoneVisits(
      selectedSnapshot?.visitedZones?.length ? selectedSnapshot.visitedZones : state.visitedZones
    );
    state.frozenZoneScoreCutoffMs = cutoffMs;
  }

  _getIngredientZoneVisits(state) {
    if (Array.isArray(state?.frozenVisitedZones)) {
      return state.frozenVisitedZones;
    }

    return Array.isArray(state?.visitedZones) ? state.visitedZones : [];
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
    this._rememberZoneVisitSnapshot(state, packetTimeMs);
  }

  _normalizeExpectedIngredients(expectedIngredients = []) {
    return (Array.isArray(expectedIngredients) ? expectedIngredients : [])
      .map((item, index) => {
        const name = typeof item === 'string' ? item : item?.name;
        const key = normalizeIngredientName(name);
        const sortOrder = Number(item?.sortOrder ?? item?.loadOrder ?? index + 1);
        return key ? {
          key,
          name,
          sortOrder: Number.isFinite(sortOrder) && sortOrder > 0 ? sortOrder : index + 1
        } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }

  _getExpectedNextIngredientKey(state, expectedIngredients = []) {
    const expected = this._normalizeExpectedIngredients(expectedIngredients);
    if (!expected.length) return null;

    const loadedKeys = new Set(
      (Array.isArray(state.loadedIngredientKeys) ? state.loadedIngredientKeys : [])
        .map((key) => normalizeIngredientName(key))
        .filter(Boolean)
    );

    return expected.find((ingredient) => !loadedKeys.has(ingredient.key))?.key || null;
  }

  _pickVisitedZoneIngredient(state, expectedIngredients = []) {
    const zoneVisits = this._getIngredientZoneVisits(state);
    if (!zoneVisits.length) return null;

    const candidates = zoneVisits
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

    const expectedNextKey = this._getExpectedNextIngredientKey(state, expectedIngredients);
    if (expectedNextKey && candidates.length > 1) {
      const topScore = Number(candidates[0]?.score || 0);
      const expectedCandidate = candidates.find((visit) => (
        normalizeIngredientName(visit.ingredient || visit.name) === expectedNextKey
      ));

      if (expectedCandidate && topScore - Number(expectedCandidate.score || 0) <= ZONE_ENTRY_FRONT_BONUS) {
        return expectedCandidate.ingredient || expectedCandidate.name || null;
      }
    }

    return candidates[0]?.ingredient || candidates[0]?.name || null;
  }

  _resetVisitedZones(state, packetTimeMs = Date.now()) {
    state.visitedZones = [];
    state.zoneVisitSnapshots = [];
    state.frozenVisitedZones = null;
    state.frozenZoneScoreCutoffMs = null;
    state.lastActiveZoneKey = null;
    state.lastZoneDwellAtMs = packetTimeMs;
    state.currentZoneDwellMs = 0;
    state.lastZoneTrackPoint = null;
  }

  _isForceCurrentZoneIngredientName(ingredientName) {
    return FORCE_CURRENT_ZONE_INGREDIENT_KEYS.has(normalizeIngredientName(ingredientName));
  }

  _isForceCurrentZoneIngredient(zoneName, zoneObject) {
    return this._isForceCurrentZoneIngredientName(zoneObject?.ingredient || zoneName);
  }

  _resolveForcedLoadingStartIngredient(state, zonesConfig = []) {
    if (
      !Number.isFinite(Number(state?.loadingStartLat)) ||
      !Number.isFinite(Number(state?.loadingStartLon))
    ) {
      return null;
    }

    const loadingStartZone = detectZoneWithRadiusFallback(
      Number(state.loadingStartLat),
      Number(state.loadingStartLon),
      zonesConfig
    );
    const ingredientName = loadingStartZone?.ingredient || loadingStartZone?.name || null;
    return this._isForceCurrentZoneIngredientName(ingredientName) ? ingredientName : null;
  }

  _serializeZoneCandidates(state) {
    const zoneVisits = this._getIngredientZoneVisits(state);
    if (!zoneVisits.length) return [];

    return zoneVisits.map((visit) => ({
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

    const activeZone = detectZoneWithRadiusFallback(lat, lon, zonesConfig);
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

  _resolveSegmentIngredient(state, expectedIngredients = [], options = {}) {
    if (state.loadingForcedIngredientName) {
      return state.loadingForcedIngredientName;
    }

    if (options.overrideIngredientName) {
      return options.overrideIngredientName;
    }

    if (options.preferCurrentZoneIngredient && state.currentZone?.ingredient) {
      return state.currentZone.ingredient;
    }

    const visitedIngredient = options.allowVisitedZoneIngredient === false
      ? null
      : this._pickVisitedZoneIngredient(state, expectedIngredients);
    return visitedIngredient || state.currentZone?.ingredient || state.lastIngredientName || 'Unknown';
  }

  _hasLoadingContext(state, options = {}) {
    return Boolean(
      state.currentZone?.ingredient ||
      (options.allowVisitedZoneIngredient !== false && this._pickVisitedZoneIngredient(state, options.expectedIngredients))
    );
  }

  _isTerminalRecoveryContext(state, options = {}) {
    return !this._hasLoadingContext(state, options) && (
      state.recoveredOutsideLoadingContext ||
      normalizeIngredientName(state.lastIngredientName) === normalizeIngredientName('Восстановление терминала')
    );
  }

  _flushCurrentSegment(state, currentWeight, thresholds, result, options = {}) {
    if (options.suppressLoading && !state.currentZone) {
      return false;
    }

    if (options.requireLoadingContext && !this._hasLoadingContext(state, options)) {
      return false;
    }

    if (!state.loadingStartTimeMs && !options.allowUnconfirmedLoadingStart) {
      return false;
    }

    const hasExplicitSegmentEnd = options.segmentEndWeight !== undefined && options.segmentEndWeight !== null;
    const segmentEndWeight = Number(
      hasExplicitSegmentEnd
        ? options.segmentEndWeight
        : (Number.isFinite(Number(state.segmentPeakWeight)) ? state.segmentPeakWeight : currentWeight)
    );
    const delta = segmentEndWeight - Number(state.zoneStartWeight || 0);

    if (!(delta > this._getEffectiveBatchStartThreshold(state, thresholds))) {
      return false;
    }

    if (!state.isBatchStarted) {
      state.isBatchStarted = true;
      result.dbActions.push({
        type: 'START_BATCH',
        startWeight: this._getBatchStartWeight(state),
        startTime: state.loadingStartTimeMs !== null && Number.isFinite(Number(state.loadingStartTimeMs))
          ? new Date(Number(state.loadingStartTimeMs)).toISOString()
          : Number.isFinite(Number(state.zoneStartTimeMs))
            ? new Date(Number(state.zoneStartTimeMs)).toISOString()
            : null
      });
      this._emitRecoveryMassIfNeeded(state, result, thresholds);
      state.recoveredOutsideLoadingContext = false;
    }

    const ingredientName = this._isTerminalRecoveryContext(state, options)
      ? 'Восстановление терминала'
      : this._resolveSegmentIngredient(state, options.expectedIngredients, {
        allowVisitedZoneIngredient: options.allowVisitedZoneIngredient,
        preferCurrentZoneIngredient: options.preferCurrentZoneIngredient,
        overrideIngredientName: options.overrideIngredientName
      });
    if (normalizeIngredientName(ingredientName) === 'unknown') {
      return false;
    }
    state.isMixing = true;
    state.lastIngredientName = ingredientName;
    const ingredientKey = normalizeIngredientName(ingredientName);
    if (ingredientKey) {
      if (!Array.isArray(state.loadedIngredientKeys)) {
        state.loadedIngredientKeys = [];
      }
      if (!state.loadedIngredientKeys.includes(ingredientKey)) {
        state.loadedIngredientKeys.push(ingredientKey);
      }
    }

    result.dbActions.push({
      type: 'ADD_INGREDIENT',
      ingredientName,
      actualWeight: Math.round(delta),
      startTime: state.loadingStartTimeMs !== null && Number.isFinite(Number(state.loadingStartTimeMs))
        ? new Date(Number(state.loadingStartTimeMs)).toISOString()
        : state.zoneStartTimeMs !== null && Number.isFinite(Number(state.zoneStartTimeMs))
          ? new Date(Number(state.zoneStartTimeMs)).toISOString()
          : null,
      startLat: state.loadingStartLat !== null && Number.isFinite(Number(state.loadingStartLat))
        ? Number(state.loadingStartLat)
        : state.zoneStartLat !== null && Number.isFinite(Number(state.zoneStartLat))
          ? Number(state.zoneStartLat)
          : null,
      startLon: state.loadingStartLon !== null && Number.isFinite(Number(state.loadingStartLon))
        ? Number(state.loadingStartLon)
        : state.zoneStartLon !== null && Number.isFinite(Number(state.zoneStartLon))
          ? Number(state.zoneStartLon)
          : null,
      endTime: Number.isFinite(Number(options.segmentEndTimeMs))
        ? new Date(Number(options.segmentEndTimeMs)).toISOString()
        : !hasExplicitSegmentEnd && Number.isFinite(Number(state.segmentPeakTimeMs))
          ? new Date(Number(state.segmentPeakTimeMs)).toISOString()
          : Number.isFinite(Number(options.packetTimeMs))
            ? new Date(Number(options.packetTimeMs)).toISOString()
            : null,
      endLat: Number.isFinite(Number(options.segmentEndLat))
        ? Number(options.segmentEndLat)
        : !hasExplicitSegmentEnd && state.segmentPeakLat !== null && Number.isFinite(Number(state.segmentPeakLat))
          ? Number(state.segmentPeakLat)
          : Number.isFinite(Number(options.lat))
            ? Number(options.lat)
            : null,
      endLon: Number.isFinite(Number(options.segmentEndLon))
        ? Number(options.segmentEndLon)
        : !hasExplicitSegmentEnd && state.segmentPeakLon !== null && Number.isFinite(Number(state.segmentPeakLon))
          ? Number(state.segmentPeakLon)
          : Number.isFinite(Number(options.lon))
            ? Number(options.lon)
            : null
    });

    this._resetVisitedZones(state, Number(options.packetTimeMs || Date.now()));

    return true;
  }

  _confirmZoneChange(state, zoneName, zoneObject, ingredientName, currentWeight, thresholds, result, options = {}) {
    // Флешим сегмент ПРЕДЫДУЩЕЙ подтверждённой зоны
    const previousSegmentPeakWeight = Number(state.segmentPeakWeight);
    const previousSegmentPeakTimeMs = Number(state.segmentPeakTimeMs);
    const previousSegmentPeakLat = Number(state.segmentPeakLat);
    const previousSegmentPeakLon = Number(state.segmentPeakLon);
    const flushed = this._flushCurrentSegment(state, currentWeight, thresholds, result, {
      suppressLoading: options.suppressLoading,
      packetTimeMs: options.packetTimeMs,
      expectedIngredients: options.expectedIngredients,
      allowVisitedZoneIngredient: options.allowVisitedZoneIngredient,
      preferCurrentZoneIngredient: options.preferCurrentZoneIngredient,
      overrideIngredientName: options.preferCurrentZoneIngredient ? ingredientName : null
    });
    const nextBaselineWeight = flushed && Number.isFinite(previousSegmentPeakWeight)
      ? previousSegmentPeakWeight
      : currentWeight;
    const nextBaselineTimeMs = flushed && Number.isFinite(previousSegmentPeakTimeMs)
      ? previousSegmentPeakTimeMs
      : options.packetTimeMs;
    const nextBaselineLat = flushed && Number.isFinite(previousSegmentPeakLat)
      ? previousSegmentPeakLat
      : options.lat;
    const nextBaselineLon = flushed && Number.isFinite(previousSegmentPeakLon)
      ? previousSegmentPeakLon
      : options.lon;

    // Обновляем состояние на НОВУЮ подтверждённую зону
    state.currentZone = zoneObject ? { ...zoneObject, ingredient: ingredientName } : null;
    state.confirmedZoneName = zoneName;
    this._setZoneBaseline(state, nextBaselineWeight, nextBaselineTimeMs, nextBaselineLat, nextBaselineLon);
    state.recoveringFromInvalidWeight = false;
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
    const requestedSuppressLoading = Boolean(options.suppressLoading);
    const packetTimeMs = this._parsePacketTimestampMs(packet);

    if (!isValidLocation(lat, lon)) {
      result.isValid = false;
      result.error = 'Invalid GPS coordinates';
      return result;
    }

    let state = this.deviceStates.get(deviceId);
    if (!state) {
      state = this.getInitialState(currentWeight);
      this._setZoneBaseline(state, currentWeight, packetTimeMs, lat, lon);
      this.deviceStates.set(deviceId, state);
    } else if (state.hasWeightBaseline === false) {
      this._setZoneBaseline(state, currentWeight, packetTimeMs, lat, lon);
      state.peakWeight = currentWeight;
      state.lastStationaryWeight = currentWeight;
      state.lastAcceptedWeight = null;
      state.hasWeightBaseline = true;
    }

    let suppressLoading = requestedSuppressLoading && (
      state.isMixing ||
      state.isUnloading ||
      state.isBatchStarted
    );
    const expectedIngredients = Array.isArray(options.expectedIngredients) ? options.expectedIngredients : [];
    const allowVisitedZoneIngredient = options.allowVisitedZoneIngredient !== false;
    const preferCurrentZoneIngredient = Boolean(options.preferCurrentZoneIngredient);

    if (!Number.isFinite(currentWeightRaw) || currentWeightRaw < 0) {
      if (!state.recoveringFromInvalidWeight) {
        state.recoveryBaselineWeight = Number.isFinite(Number(state.lastKnownNormalWeight))
          ? Number(state.lastKnownNormalWeight)
          : Math.max(0, Number(state.lastAcceptedWeight ?? state.lastStationaryWeight ?? 0));
        state.recoveryBaselineTimeMs = state.lastKnownNormalTimeMs;
        state.recoveryBaselineLat = state.lastKnownNormalLat;
        state.recoveryBaselineLon = state.lastKnownNormalLon;
      }
      state.hasWeightBaseline = false;
      state.recoveringFromInvalidWeight = true;
      state.recoveredOutsideLoadingContext = false;
      state.lastAcceptedWeight = null;
      state.anomalyCandidateWeight = null;
      state.anomalyCandidateCount = 0;
      return this._buildSkippedResult(deviceId);
    }

    const movement = this._updateMovementState(state, packet.speedKmh, thresholds);
    const isMotionSuppressed = Boolean(movement.suppressMotion);

    if (!isMotionSuppressed && state.lastAcceptedWeight === null) {
      state.lastAcceptedWeight = currentWeight;
    }

    // Фильтр аномалий веса
    if (movement.enteredMoving) {
      state.pendingZoneName = null;
      state.pendingZoneEnteredAtMs = null;
      state.pendingZoneCount = 0;
    }

    if (movement.exitedMoving && state.loadingStartTimeMs !== null && !state.isUnloading) {
      const motionActiveZone = detectZoneWithRadiusFallback(lat, lon, zonesConfig);
      const motionActiveZoneName = motionActiveZone?.name || null;
      const confirmedLoadingZoneName = state.confirmedZoneName || null;
      const segmentPeakWeight = Number(state.segmentPeakWeight);
      const usePreviousZonePeak = Boolean(
        motionActiveZoneName &&
        confirmedLoadingZoneName &&
        motionActiveZoneName !== confirmedLoadingZoneName &&
        Number.isFinite(segmentPeakWeight) &&
        currentWeight - segmentPeakWeight > thresholds.batchStartThresholdKg
      );
      const segmentEndWeight = usePreviousZonePeak ? segmentPeakWeight : currentWeight;
      const segmentEndTimeMs = usePreviousZonePeak && Number.isFinite(Number(state.segmentPeakTimeMs))
        ? Number(state.segmentPeakTimeMs)
        : packetTimeMs;
      const segmentEndLat = usePreviousZonePeak && Number.isFinite(Number(state.segmentPeakLat))
        ? Number(state.segmentPeakLat)
        : lat;
      const segmentEndLon = usePreviousZonePeak && Number.isFinite(Number(state.segmentPeakLon))
        ? Number(state.segmentPeakLon)
        : lon;
      const shouldPreferMotionZoneIngredient = preferCurrentZoneIngredient;
      const flushed = this._flushCurrentSegment(
        state,
        segmentEndWeight,
        thresholds,
        result,
        {
          suppressLoading,
          packetTimeMs,
          requireLoadingContext: true,
          lat,
          lon,
          expectedIngredients,
          allowVisitedZoneIngredient,
          preferCurrentZoneIngredient: shouldPreferMotionZoneIngredient,
          overrideIngredientName: shouldPreferMotionZoneIngredient
            ? (motionActiveZone?.ingredient || motionActiveZoneName || null)
            : null,
          segmentEndWeight,
          segmentEndTimeMs,
          segmentEndLat,
          segmentEndLon
        }
      );
      if (flushed) {
        this._setZoneBaseline(state, segmentEndWeight, segmentEndTimeMs, segmentEndLat, segmentEndLon);
      }
    }

    if (isMotionSuppressed) {
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

    const nearbyLoadingZone = detectZoneWithRadiusFallback(lat, lon, zonesConfig);
    if (suppressLoading && nearbyLoadingZone && !state.isUnloading) {
      suppressLoading = false;
    }

    const activeZone = (suppressLoading || state.isUnloading)
      ? null
      : nearbyLoadingZone;
    const activeZoneName = activeZone?.name || null;
    const activeIngredientName = activeZone?.ingredient || activeZoneName;
    const forcedHostIngredientName = this._isForceCurrentZoneIngredientName(options.hostForceIngredientName)
      ? options.hostForceIngredientName
      : null;
    const shouldPreferCurrentZoneIngredient = preferCurrentZoneIngredient;

    if (!isMotionSuppressed && forcedHostIngredientName) {
      this._resetVisitedZones(state, packetTimeMs);
    }

    if (
      state.recoveringFromInvalidWeight &&
      !isMotionSuppressed &&
      !activeZoneName &&
      !state.currentZone &&
      !state.isMixing &&
      !state.isUnloading
    ) {
      this._setZoneBaseline(state, currentWeight, packetTimeMs, lat, lon);
      state.peakWeight = currentWeight;
      state.lastStationaryWeight = currentWeight;
      state.lastAcceptedWeight = currentWeight;
      state.recoveringFromInvalidWeight = false;
      state.recoveredOutsideLoadingContext = true;
      state.recoveryMassRecorded = false;
      state.lastKnownNormalWeight = Number.isFinite(Number(state.recoveryBaselineWeight))
        ? Number(state.recoveryBaselineWeight)
        : state.lastKnownNormalWeight;
      if (state.recoveryBaselineTimeMs === null && Number.isFinite(Number(packetTimeMs))) {
        state.recoveryBaselineTimeMs = Number(packetTimeMs);
      }
      if (
        state.recoveryBaselineLat === null &&
        state.recoveryBaselineLon === null &&
        Number.isFinite(Number(lat)) &&
        Number.isFinite(Number(lon))
      ) {
        state.recoveryBaselineLat = Number(lat);
        state.recoveryBaselineLon = Number(lon);
      }
      return this._buildSkippedResult(deviceId);
    }

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
            { suppressLoading, packetTimeMs, lat, lon, expectedIngredients, allowVisitedZoneIngredient, preferCurrentZoneIngredient: shouldPreferCurrentZoneIngredient }
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
            { suppressLoading, packetTimeMs, lat, lon, expectedIngredients, allowVisitedZoneIngredient, preferCurrentZoneIngredient: shouldPreferCurrentZoneIngredient }
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

    const hasConfirmedLoadingStart = (
      !isMotionSuppressed &&
      !state.isUnloading &&
      this._updateLoadingStartCandidate(state, currentWeight, thresholds, packetTimeMs, lat, lon)
    );
    if (hasConfirmedLoadingStart) {
      const loadingStartForcedIngredientName = this._resolveForcedLoadingStartIngredient(state, zonesConfig);
      if (loadingStartForcedIngredientName) {
        state.loadingForcedIngredientName = loadingStartForcedIngredientName;
      }
      this._freezeZoneScoreboardForLoading(state);
    }

    // Базовый вес обновляется только в спокойном режиме
    if (
      !isMotionSuppressed &&
      !state.isUnloading &&
      (!state.isMixing || state.loadingStartTimeMs === null)
    ) {
      if (currentWeight < state.zoneStartWeight) {
        this._setZoneBaseline(state, currentWeight, packetTimeMs, lat, lon);
      }
    }

    const recentCurrentZoneSeen = state.currentZone &&
      !activeZoneName &&
      Number.isFinite(lastRealZoneSeenAtMs) &&
      packetTimeMs - lastRealZoneSeenAtMs <= Math.max(10000, thresholds.zoneChangeDebounceMs * 2);
    const isInCurrentLoadingZone = Boolean(
      state.currentZone
        ? (activeZoneName === confirmedZoneName || recentCurrentZoneSeen)
        : activeZoneName
    );

    if (
      !isMotionSuppressed &&
      !suppressLoading &&
      !state.isUnloading &&
      isInCurrentLoadingZone &&
      hasConfirmedLoadingStart
    ) {
      this._rememberSegmentPeak(state, currentWeight, packetTimeMs, lat, lon);
    }

    if (
      !isMotionSuppressed &&
      !suppressLoading &&
      !state.isUnloading &&
      state.loadingStartTimeMs !== null &&
      Number.isFinite(Number(state.segmentPeakTimeMs)) &&
      packetTimeMs - Number(state.segmentPeakTimeMs) >= Math.max(MIN_LOADING_IDLE_CLOSE_MS, thresholds.zoneChangeDebounceMs * 3) &&
      currentWeight >= Number(state.segmentPeakWeight || 0) - thresholds.batchStartThresholdKg
    ) {
      const segmentEndWeight = Number(state.segmentPeakWeight);
      const segmentEndTimeMs = Number(state.segmentPeakTimeMs);
      const flushed = this._flushCurrentSegment(state, currentWeight, thresholds, result, {
        suppressLoading,
        packetTimeMs,
        segmentEndWeight,
        segmentEndTimeMs,
        segmentEndLat: state.segmentPeakLat,
        segmentEndLon: state.segmentPeakLon,
        expectedIngredients,
        allowVisitedZoneIngredient,
        preferCurrentZoneIngredient: shouldPreferCurrentZoneIngredient
      });

      if (flushed) {
        this._setZoneBaseline(
          state,
          segmentEndWeight,
          segmentEndTimeMs,
          state.segmentPeakLat,
          state.segmentPeakLon
        );
      }
    }

    if (!isMotionSuppressed && currentWeight > state.peakWeight) {
      state.peakWeight = currentWeight;
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

      this._setZoneBaseline(state, state.lastUnloadWeight, packetTimeMs, lat, lon);
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
        packetTimeMs,
        expectedIngredients,
        allowVisitedZoneIngredient,
        preferCurrentZoneIngredient: shouldPreferCurrentZoneIngredient
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
      zoneCandidates: this._serializeZoneCandidates(state)
    };

    if (!isMotionSuppressed) {
      state.lastAcceptedWeight = currentWeight;
      if (!state.isMixing && !state.isUnloading) {
        this._rememberNormalWeight(state, currentWeight);
        if (Number.isFinite(Number(packetTimeMs))) {
          state.lastKnownNormalTimeMs = Number(packetTimeMs);
        }
        if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
          state.lastKnownNormalLat = Number(lat);
          state.lastKnownNormalLon = Number(lon);
        }
      }
    }
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
      zoneCandidates: this._serializeZoneCandidates(state)
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

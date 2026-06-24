import { detectZoneObject } from '../module-1/geo.js';
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
  DEFAULT_ZONE_DEBOUNCE_MS,
  NULL_ZONE_CONFIRM_SECONDS,
  ZONE_CHANGE_CONFIRM_PACKETS
} from './config.js';

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
      lastAcceptedWeight: null,
      anomalyCandidateWeight: null,
      anomalyCandidateCount: 0,
      visitedZones: [],
      lastActiveZoneKey: null,
      lastZoneDwellAtMs: null,
      currentZoneDwellMs: 0,
      lastRealZoneSeenAtMs: null,
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
      zoneChangeDebounceMs: Number(settings.zoneChangeDebounceMs) > 0 ? Number(settings.zoneChangeDebounceMs) : DEFAULT_ZONE_DEBOUNCE_MS,
      nullZoneConfirmMs: Number(settings.nullZoneConfirmSeconds) > 0
        ? Number(settings.nullZoneConfirmSeconds) * 1000
        : (Number(settings.nullZoneConfirmMs) > 0 ? Number(settings.nullZoneConfirmMs) : NULL_ZONE_CONFIRM_SECONDS * 1000),
      zoneChangeConfirmPackets: Number(settings.zoneChangeConfirmPackets) > 0 ? Number(settings.zoneChangeConfirmPackets) : ZONE_CHANGE_CONFIRM_PACKETS
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
        firstSeenAtMs: packetTimeMs,
        lastSeenAtMs: packetTimeMs,
        dwellMs: 0,
        maxContinuousDwellMs: 0,
        samples: 0
      };
      state.visitedZones.push(visit);
    }

    visit.lastSeenAtMs = packetTimeMs;
    visit.name = visit.name || zoneObject?.name || ingredientName || null;
    visit.ingredient = visit.ingredient || ingredientName || zoneObject?.ingredient || zoneObject?.name || null;
    return visit;
  }

  _recordZoneVisit(state, activeZone, activeZoneName, activeIngredientName, packetTimeMs) {
    if (!Array.isArray(state.visitedZones)) {
      state.visitedZones = [];
    }

    const activeZoneKey = this._zoneVisitKey(activeZone, activeZoneName);
    const previousZoneKey = state.lastActiveZoneKey || null;
    const previousTimeMs = Number(state.lastZoneDwellAtMs);
    const elapsedMs = Number.isFinite(previousTimeMs)
      ? Math.max(0, Math.min(30000, packetTimeMs - previousTimeMs))
      : 0;

    if (previousZoneKey && elapsedMs > 0) {
      const previousVisit = state.visitedZones.find((item) => item.key === previousZoneKey);
      if (previousVisit) {
        previousVisit.dwellMs = Number(previousVisit.dwellMs || 0) + elapsedMs;
        const continuousDwellMs = previousZoneKey === activeZoneKey
          ? Number(state.currentZoneDwellMs || 0) + elapsedMs
          : elapsedMs;
        previousVisit.maxContinuousDwellMs = Math.max(
          Number(previousVisit.maxContinuousDwellMs || 0),
          continuousDwellMs
        );
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
      activeVisit.samples = Number(activeVisit.samples || 0) + 1;
    }

    state.lastActiveZoneKey = activeZoneKey;
    state.lastZoneDwellAtMs = packetTimeMs;
  }

  _pickVisitedZoneIngredient(state) {
    if (!Array.isArray(state?.visitedZones)) return null;

    const candidates = state.visitedZones
      .filter((visit) => Number(visit.dwellMs || 0) > 0 && (visit.ingredient || visit.name))
      .sort((a, b) => {
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
  }

  _serializeZoneCandidates(state) {
    if (!Array.isArray(state?.visitedZones)) return [];

    return state.visitedZones.map((visit) => ({
      name: visit.name,
      ingredient: visit.ingredient,
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

  _resolveSegmentIngredient(state) {
    return this._pickVisitedZoneIngredient(state) || 'Unknown';
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

    const ingredientName = this._resolveSegmentIngredient(state);
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
    }

    if (state.lastAcceptedWeight === null) {
      state.lastAcceptedWeight = currentWeight;
    }

    // Фильтр аномалий веса
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

    const activeZone = detectZoneObject(lat, lon, zonesConfig);
    const activeZoneName = activeZone?.name || null;
    const activeIngredientName = activeZone?.ingredient || activeZoneName;
    this._recordZoneVisit(state, activeZone, activeZoneName, activeIngredientName, packetTimeMs);
    if (activeZoneName) {
      state.lastRealZoneSeenAtMs = packetTimeMs;
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

    if (shouldConfirmNullZone) {
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
    } else if (!activeZoneName) {
      state.pendingZoneName = null;
      state.pendingZoneEnteredAtMs = null;
      state.pendingZoneCount = 0;
    } else if (activeZoneName !== confirmedZoneName) {
      if (activeZoneName === state.pendingZoneName) {
        state.pendingZoneCount = Number(state.pendingZoneCount || 0) + 1;
        const timeInPending = packetTimeMs - Number(state.pendingZoneEnteredAtMs || packetTimeMs);

        if (
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
    if (!state.isMixing && !state.isUnloading) {
      if (currentWeight < state.zoneStartWeight) {
        state.zoneStartWeight = currentWeight;
      }
    }

    if (currentWeight > state.peakWeight) {
      state.peakWeight = currentWeight;
    }

    // ЯВНАЯ ДЕТЕКЦИЯ UNKNOWN ВНЕ ЗОН
    if (
      !state.currentZone &&
      !suppressLoading &&
      !state.isUnloading &&
      !state.isBatchStarted &&
      (currentWeight - Number(state.zoneStartWeight || 0)) > thresholds.batchStartThresholdKg
    ) {
      state.isBatchStarted = true;
      state.isMixing = true;
      state.lastIngredientName = this._resolveSegmentIngredient(state);

      result.dbActions.push({
        type: 'START_BATCH',
        startWeight: Math.round(state.zoneStartWeight)
      });
    }

    // Защита от недовыгрузки
    if (
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
    if (state.isUnloading && currentWeight < thresholds.emptyVehicleThresholdKg) {
      result.dbActions.push({
        type: 'COMPLETE_BATCH',
        endWeight: Math.round(currentWeight)
      });

      this.deviceStates.delete(deviceId);
    }

    // Вывод состояния (на основе подтверждённой зоны)
    result.state = {
      currentZone: state.confirmedZoneName,
      currentIngredient: state.currentZone?.ingredient || (state.isMixing ? state.lastIngredientName : null),
      isMixing: state.isMixing,
      isUnloading: state.isUnloading,
      peakWeight: state.peakWeight,
      lastIngredientName: state.lastIngredientName,
      isBatchStarted: state.isBatchStarted,
      currentMode: this._getCurrentMode(state),
      zoneCandidates: this._serializeZoneCandidates(state)
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

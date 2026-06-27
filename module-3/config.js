// config.js
export const BATCH_START_THRESHOLD_KG = 30;
export const LEFTOVER_THRESHOLD_KG = 50;
export const UNLOAD_DROP_THRESHOLD_KG = 200;
export const UNLOAD_MIN_PEAK_KG = 400;
export const UNLOAD_UPDATE_DELTA_KG = 1;
export const UNLOAD_WEIGHT_BUFFER_KG = 50;
export const EMPTY_VEHICLE_THRESHOLD_KG = 50;
export const ANOMALY_THRESHOLD_KG = 200;
export const ANOMALY_CONFIRM_DELTA_KG = 40;
export const ANOMALY_CONFIRM_PACKETS = 3;
export const MOVEMENT_SPEED_THRESHOLD_KMH = 3;
export const MOVEMENT_CONFIRM_PACKETS = 3;
export const DEFAULT_ZONE_DEBOUNCE_MS = 3000;
// Null zone is confirmed only after this many seconds since the last real loading zone hit.
export const NULL_ZONE_CONFIRM_SECONDS = 120;
export const ZONE_CHANGE_CONFIRM_PACKETS = 2;

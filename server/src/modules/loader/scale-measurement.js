// Preserve the Pi measurement verbatim: site-specific realtime filters must not
// introduce a different zero/weight when a tablet changes transport.
export function scaleMeasurement(row) {
  let raw
  try { raw = typeof row.rawPayload === 'string' ? JSON.parse(row.rawPayload) : row.rawPayload } catch { return null }
  const value = raw?.scale_measurement
  if (!value || value.version !== 1 || value.deviceId !== row.deviceId ||
      typeof value.packetId !== 'string' || value.packetId.length > 160 ||
      typeof value.calibrationId !== 'string' || value.calibrationId.length > 128 ||
      !Number.isSafeInteger(value.timestampMs) || value.timestampMs <= 0) return null
  return { version: 1, deviceId: value.deviceId, packetId: value.packetId,
    calibrationId: value.calibrationId, timestampMs: value.timestampMs,
    weightKg: Number.isFinite(value.weightKg) ? value.weightKg : null,
    valid: value.valid === true && Number.isFinite(value.weightKg) }
}

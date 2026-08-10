function latestTimestampForPacket(packet, latestStoredTimestamp) {
  if (latestStoredTimestamp instanceof Map) {
    return latestStoredTimestamp.get(packet?.deviceId) ?? latestStoredTimestamp.get(packet?.device_id) ?? null
  }
  return latestStoredTimestamp
}

export function findHistoricalRtkRange(packets = [], latestStoredTimestamp = null) {
  const historicalMs = (Array.isArray(packets) ? packets : [])
    .flatMap((packet) => {
      const timestampMs = new Date(packet?.timestamp).getTime()
      const latestStoredMs = new Date(latestTimestampForPacket(packet, latestStoredTimestamp)).getTime()
      return Number.isFinite(timestampMs) && Number.isFinite(latestStoredMs) && timestampMs < latestStoredMs
        ? [timestampMs]
        : []
    })
  if (!historicalMs.length) return null
  return {
    from: new Date(Math.min(...historicalMs)),
    to: new Date(Math.max(...historicalMs))
  }
}

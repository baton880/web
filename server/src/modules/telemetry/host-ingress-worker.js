import { getHostIngressStore } from './host-ingress-store.js'
import { getTelemetryWriteCoordinator } from './telemetry-write-coordinator.js'

const DEFAULT_POLL_MS = 100
const MAX_BACKOFF_MS = 60 * 1000

function retryDelayMs(attempts) {
  return Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(6, Math.max(0, attempts - 1))))
}

export function startHostIngressWorker(processPacket, options = {}) {
  if (typeof processPacket !== 'function') throw new TypeError('Host ingress worker requires processPacket')
  const store = options.store || getHostIngressStore()
  const coordinator = options.writeCoordinator || getTelemetryWriteCoordinator()
  const pollMs = Math.max(25, Number(options.pollMs) || DEFAULT_POLL_MS)
  let stopped = false
  let running = false
  let timer = null
  let cleanupAt = Date.now() + 60 * 60 * 1000

  async function tick() {
    if (stopped || running) return
    const lease = coordinator.tryAcquire('host-ingress')
    if (!lease) {
      timer = setTimeout(tick, pollMs)
      return
    }
    running = true
    try {
      if (Date.now() >= cleanupAt) {
        store.cleanup()
        cleanupAt = Date.now() + 60 * 60 * 1000
      }
      const row = store.claimNext()
      if (!row) return
      try {
        const payload = JSON.parse(row.raw_body)
        const result = await processPacket(payload, new Date(row.received_at), {
          deviceId: row.device_id,
          streamId: row.stream_id,
          packetId: row.packet_id
        })
        if (result?.outOfOrder && result?.timestamp) store.markHistoryDirty(result.timestamp)
        store.markProcessed(row.id)
      } catch (error) {
        if (error?.permanent) {
          store.markPermanent(row.id, error?.stack || error?.message || error)
        } else {
          if (row.attempts === 1 || (row.attempts & (row.attempts - 1)) === 0) {
            console.warn('[Host ingress worker] Main database write will be retried', {
              inboxId: row.id,
              attempts: row.attempts,
              error: error?.message || String(error)
            })
          }
          store.markRetry(row.id, error?.stack || error?.message || error, retryDelayMs(row.attempts))
        }
      }
    } catch (error) {
      console.warn('[Host ingress worker] Queue operation will be retried', {
        error: error?.message || String(error)
      })
    } finally {
      lease.release()
      running = false
      if (!stopped) timer = setTimeout(tick, pollMs)
    }
  }

  timer = setTimeout(tick, 0)
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    tick
  }
}

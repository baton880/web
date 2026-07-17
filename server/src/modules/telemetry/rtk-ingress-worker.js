import {
  getRtkIngressStore
} from './rtk-ingress-store.js'
import {
  recordRtkIngestResult,
  recordRtkMalformedRequest
} from './rtk-ingest-monitor.js'
import { getTelemetryWriteCoordinator } from './telemetry-write-coordinator.js'

const DEFAULT_POLL_MS = 200
const MAX_BACKOFF_MS = 60 * 1000

function retryDelayMs(attempts) {
  return Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(6, Math.max(0, attempts - 1))))
}

export function startRtkIngressWorker(processBody, options = {}) {
  if (typeof processBody !== 'function') {
    throw new TypeError('RTK ingress worker requires processBody')
  }

  const store = options.store || getRtkIngressStore()
  const writeCoordinator = options.writeCoordinator || getTelemetryWriteCoordinator()
  const recordResult = options.recordResult || recordRtkIngestResult
  const recordMalformed = options.recordMalformed || recordRtkMalformedRequest
  const pollMs = Math.max(25, Number(options.pollMs) || DEFAULT_POLL_MS)
  let stopped = false
  let running = false
  let timer = null
  let cleanupAt = Date.now() + 60 * 60 * 1000

  async function tick() {
    if (stopped || running) return
    const writeLease = writeCoordinator.tryAcquire('rtk')
    if (!writeLease) {
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

      let body
      try {
        body = JSON.parse(row.raw_body)
      } catch (error) {
        await recordMalformed(row.raw_body, error, new Date(row.received_at), { alreadyAcknowledged: true })
        store.markPermanent(row.id, `malformed JSON: ${error.message}`)
        return
      }

      try {
        const receivedAt = new Date(row.received_at)
        const result = await processBody(body, receivedAt)
        await recordResult(body, result, receivedAt)
        if (result.received > 0 && result.accepted === 0 && result.dropped === result.received) {
          const summary = result.validationErrors?.map((entry) => entry.error).join('; ') || 'all packets invalid'
          store.markPermanent(row.id, summary)
        } else {
          store.markProcessed(row.id)
        }
      } catch (error) {
        if (row.attempts === 1 || (row.attempts & (row.attempts - 1)) === 0) {
          console.warn('[RTK ingress worker] Main database write will be retried', {
            inboxId: row.id,
            attempts: row.attempts,
            error: error?.message || String(error)
          })
        }
        store.markRetry(row.id, error?.stack || error?.message || error, retryDelayMs(row.attempts))
      }
    } catch (error) {
      console.warn('[RTK ingress worker] Queue operation will be retried', {
        error: error?.message || String(error)
      })
    } finally {
      writeLease.release()
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

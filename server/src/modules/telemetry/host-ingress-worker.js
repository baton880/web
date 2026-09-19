import { getHostIngressStore } from './host-ingress-store.js'
import { maintainLease } from './ingress-lease-heartbeat.js'
import { scheduleReplayAfterBufferedTelemetry } from './replay-scheduler.js'
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
  const scheduleReplay = options.scheduleReplay || scheduleReplayAfterBufferedTelemetry
  const pollMs = Math.max(25, Number(options.pollMs) || DEFAULT_POLL_MS)
  let stopped = false
  let running = false
  let timer = null
  let cleanupAt = Date.now() + 60 * 60 * 1000
  let lastScheduledDirtyKey = null

  async function scheduleNextDirtyReplay() {
    if (typeof store.replayDrainThroughId === 'function' && await store.replayDrainThroughId()) return
    const dirty = typeof store.nextReplayDirty === 'function' ? await store.nextReplayDirty() : null
    if (!dirty) {
      lastScheduledDirtyKey = null
      return
    }
    const dirtyKey = `${dirty.farmDay}:${dirty.version}`
    if (dirtyKey === lastScheduledDirtyKey) return
    await scheduleReplay('host-ingress-history', dirty, { bufferDrained: false })
    lastScheduledDirtyKey = dirtyKey
  }

  async function tick() {
    if (stopped || running) return
    const lease = coordinator.tryAcquire('host-ingress')
    if (!lease) {
      timer = setTimeout(tick, pollMs)
      return
    }
    running = true
    let claimedRow = false
    let heartbeat = null
    try {
      if (Date.now() >= cleanupAt) {
        await store.cleanup()
        cleanupAt = Date.now() + 60 * 60 * 1000
      }
      const row = await store.claimNext()
      if (!row) {
        await scheduleNextDirtyReplay()
        return
      }
      claimedRow = true
      heartbeat = maintainLease(store, row)
      try {
        const payload = JSON.parse(row.raw_body)
        const result = await processPacket(payload, new Date(row.received_at), {
          deviceId: row.device_id,
          streamId: row.stream_id,
          packetId: row.packet_id,
          isLive: Boolean(row.is_live)
        })
        await heartbeat.stop(true)
        if (typeof store.completeProcessed === 'function') {
          await store.completeProcessed(row, result)
        } else {
          if (result?.timestamp) await store.noteProcessedTimestamp?.(result.timestamp)
          if (result?.outOfOrder && result?.timestamp) {
            await store.markHistoryDirty(result.timestamp)
            await store.beginReplayDrain?.()
          }
          await store.markProcessed(row.id, row.lease_token)
        }
      } catch (error) {
        await heartbeat.stop(true)
        if (error?.permanent) {
          await store.markPermanent(row.id, error?.stack || error?.message || error, row.lease_token)
        } else {
          if (row.attempts === 1 || (row.attempts & (row.attempts - 1)) === 0) {
            console.warn('[Host ingress worker] Main database write will be retried', {
              inboxId: row.id,
              attempts: row.attempts,
              error: error?.message || String(error)
            })
          }
          await store.markRetry(row.id, error?.stack || error?.message || error, retryDelayMs(row.attempts), row.lease_token)
        }
      }
    } catch (error) {
      console.warn('[Host ingress worker] Queue operation will be retried', {
        error: error?.message || String(error)
      })
    } finally {
      await heartbeat?.stop()
      lease.release()
      running = false
      // Drain continuously while work exists, but keep the normal polling
      // delay when the durable inbox is empty or temporarily unavailable.
      if (!stopped) timer = setTimeout(tick, claimedRow ? 0 : pollMs)
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

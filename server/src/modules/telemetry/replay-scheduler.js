import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import telemetryProcessor from '../../../../module-3/telemetryProcessor.js'
import { getTelemetryWriteCoordinator } from './telemetry-write-coordinator.js'
import { getHostIngressStore } from './host-ingress-store.js'
import { farmDateRange } from '../../utils/farm-date.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SERVER_ROOT = resolve(__dirname, '../../..')
const REPLAY_SCRIPT = resolve(SERVER_ROOT, 'scripts/replay-batches-from-telemetry.mjs')

const DEFAULT_REPLAY_DEBOUNCE_MS = 30 * 60 * 1000
const DEFAULT_BUFFER_QUIET_DEBOUNCE_MS = 30 * 60 * 1000
const DEFAULT_BUFFER_DRAINED_DEBOUNCE_MS = 30 * 1000
const DEFAULT_DRAIN_TIMEOUT_MS = 60 * 1000
const DEFAULT_FAILURE_BACKOFF_MS = 60 * 1000
const DEFAULT_MAX_QUEUE_WAIT_MS = 2 * 60 * 1000
const MAX_FAILURE_BACKOFF_MS = 30 * 60 * 1000
const MIN_REPLAY_DEBOUNCE_MS = 1000
const MAX_REPLAY_DEBOUNCE_MS = 30 * 60 * 1000

function normalizeDelayMs(value, fallback, minimum = MIN_REPLAY_DEBOUNCE_MS) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(MAX_REPLAY_DEBOUNCE_MS, Math.max(minimum, parsed))
}

function isoTimestamp(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null
}

function summarizeMeta(meta = {}) {
  return Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])
  )
}

export class CalculatedReplayScheduler {
  constructor(options = {}) {
    this.enabled = options.enabled ?? true
    this.coordinator = options.coordinator || getTelemetryWriteCoordinator()
    this.spawnProcess = options.spawnProcess || spawn
    this.serverRoot = options.serverRoot || SERVER_ROOT
    this.replayScript = options.replayScript || REPLAY_SCRIPT
    this.now = options.now || Date.now
    this.setTimer = options.setTimer || setTimeout
    this.clearTimer = options.clearTimer || clearTimeout
    this.replayDebounceMs = normalizeDelayMs(options.replayDebounceMs, DEFAULT_REPLAY_DEBOUNCE_MS, 1)
    this.bufferQuietDebounceMs = normalizeDelayMs(options.bufferQuietDebounceMs, DEFAULT_BUFFER_QUIET_DEBOUNCE_MS, 1)
    this.bufferDrainedDebounceMs = normalizeDelayMs(options.bufferDrainedDebounceMs, DEFAULT_BUFFER_DRAINED_DEBOUNCE_MS, 1)
    this.drainTimeoutMs = normalizeDelayMs(options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, 1)
    this.failureBackoffMs = normalizeDelayMs(options.failureBackoffMs, DEFAULT_FAILURE_BACKOFF_MS, 1)
    this.maxQueueWaitMs = normalizeDelayMs(options.maxQueueWaitMs, DEFAULT_MAX_QUEUE_WAIT_MS, 1)
    this.replayReady = options.replayReady || (() => true)
    this.onReplayStart = options.onReplayStart || (() => {})
    this.onReplayState = options.onReplayState || null
    this.onReplaySuccess = options.onReplaySuccess || (() => {})
    this.onReplayFailure = options.onReplayFailure || (() => {})

    this.timer = null
    this.state = 'idle'
    this.queued = false
    this.queuedSinceMs = null
    this.pendingReason = null
    this.pendingMeta = null
    this.nextRunAtMs = null
    this.backoffUntilMs = null
    this.failureCount = 0
    this.lastRequestedAtMs = null
    this.lastStartedAtMs = null
    this.lastCompletedAtMs = null
    this.lastError = null
  }

  isBlockingWrites() {
    return this.state === 'draining' || this.state === 'running'
  }

  getStatus() {
    return {
      enabled: this.enabled,
      state: this.state,
      queued: this.queued,
      pendingReason: this.pendingReason,
      nextRunAt: isoTimestamp(this.nextRunAtMs),
      backoffUntil: isoTimestamp(this.backoffUntilMs),
      failureCount: this.failureCount,
      lastRequestedAt: isoTimestamp(this.lastRequestedAtMs),
      lastStartedAt: isoTimestamp(this.lastStartedAtMs),
      lastCompletedAt: isoTimestamp(this.lastCompletedAtMs),
      lastError: this.lastError
    }
  }

  schedule(reason, meta, delayMs) {
    if (!this.enabled) return { scheduled: false, disabled: true }
    if (!farmDateRange(meta?.farmDay)) {
      return {
        scheduled: false,
        invalidScope: true,
        error: 'Automatic calculated replay requires a valid farmDay'
      }
    }

    const wasQueued = this.queued
    this.queued = true
    if (!wasQueued || !Number.isFinite(this.queuedSinceMs)) this.queuedSinceMs = this.now()
    this.pendingReason = reason || this.pendingReason || 'telemetry-buffer'
    this.pendingMeta = meta || this.pendingMeta || {}
    this.lastRequestedAtMs = this.now()

    const requestedDelayMs = normalizeDelayMs(delayMs, this.replayDebounceMs, 1)
    if (this.isBlockingWrites()) {
      return { scheduled: true, queued: true, delayMs: requestedDelayMs }
    }

    const effectiveDelayMs = this.queuedDelayMs(requestedDelayMs)
    this.armTimer(effectiveDelayMs)
    return { scheduled: true, delayMs: effectiveDelayMs }
  }

  queuedDelayMs(preferredDelayMs) {
    const backoffDelayMs = Number.isFinite(this.backoffUntilMs)
      ? Math.max(0, this.backoffUntilMs - this.now())
      : 0
    const maxWaitDelayMs = Number.isFinite(this.queuedSinceMs)
      ? Math.max(1, this.queuedSinceMs + this.maxQueueWaitMs - this.now())
      : this.maxQueueWaitMs
    return Math.max(backoffDelayMs, Math.min(preferredDelayMs, maxWaitDelayMs))
  }

  armTimer(delayMs) {
    if (this.timer) this.clearTimer(this.timer)
    const normalizedDelayMs = Math.max(1, Number(delayMs) || 1)
    this.nextRunAtMs = this.now() + normalizedDelayMs
    this.timer = this.setTimer(() => {
      this.timer = null
      this.nextRunAtMs = null
      void this.startQueuedReplay()
    }, normalizedDelayMs)
    this.timer?.unref?.()
  }

  async startQueuedReplay() {
    if (!this.enabled || !this.queued || this.isBlockingWrites()) return

    let reason = this.pendingReason || 'telemetry-buffer'
    let meta = this.pendingMeta || {}
    let ready = false
    try {
      ready = this.replayReady({ reason, meta })
    } catch (error) {
      this.lastError = `Replay readiness check failed: ${error?.message || String(error)}`
      console.error('[Calculated replay] readiness check failed', {
        error: error?.message || String(error)
      })
    }
    if (!ready) {
      this.armTimer(Math.min(1000, this.bufferDrainedDebounceMs))
      return
    }
    this.queued = false
    this.queuedSinceMs = null
    this.pendingReason = null
    this.pendingMeta = null
    this.state = 'draining'
    this.lastError = null
    this.coordinator.pause(`calculated-replay:${reason}`)

    const drained = await this.coordinator.waitForIdle(this.drainTimeoutMs)
    if (!drained) {
      this.coordinator.resume()
      this.state = 'backoff'
      this.lastError = `Timed out waiting ${this.drainTimeoutMs}ms for telemetry writers to drain`
      this.queueRetry(reason, meta)
      console.error('[Calculated replay] writer drain timed out', {
        reason,
        drainTimeoutMs: this.drainTimeoutMs,
        writers: this.coordinator.snapshot()
      })
      return
    }

    // A writer that was already active when pause() ran may publish a newer
    // dirty generation before releasing its lease. That write is in SQLite and
    // therefore covered by the replay we are about to start. Fold the newer
    // generation into this run when it belongs to the same farm day; work for a
    // different day must remain queued separately.
    if (this.queued && this.pendingMeta?.farmDay === meta?.farmDay) {
      reason = this.pendingReason || reason
      meta = this.pendingMeta || meta
      this.queued = false
      this.queuedSinceMs = null
      this.pendingReason = null
      this.pendingMeta = null
    }

    this.state = 'running'
    this.lastStartedAtMs = this.now()
    try {
      const startResult = this.onReplayStart({ reason, meta })
      if (startResult?.meta) meta = startResult.meta
    } catch (error) {
      this.coordinator.resume()
      this.state = 'backoff'
      this.lastError = `Replay start hook failed: ${error?.message || String(error)}`
      this.queueRetry(reason, meta)
      console.error('[Calculated replay] start hook failed', { error: this.lastError })
      return
    }
    console.log('[Calculated replay] starting calculated batch replay', {
      reason,
      ...summarizeMeta(meta)
    })

    let result
    try {
      result = await this.runReplayProcess(reason, meta)
    } catch (error) {
      result = {
        ok: false,
        code: null,
        signal: null,
        error: error?.message || String(error)
      }
    }
    this.lastCompletedAtMs = this.now()

    if (result.ok && this.onReplayState) {
      try {
        this.onReplayState(result.stateSnapshot)
      } catch (error) {
        console.error('[Calculated replay] processor state sync failed', {
          error: error?.message || String(error)
        })
        result = {
          ok: false,
          code: result.code,
          signal: result.signal,
          error: `Processor state sync failed: ${error?.message || String(error)}`
        }
      }
    }

    if (result.ok) {
      try {
        this.onReplaySuccess({ reason, meta })
      } catch (error) {
        console.error('[Calculated replay] post-replay cleanup failed', {
          error: error?.message || String(error)
        })
        result = {
          ok: false,
          code: result.code,
          signal: result.signal,
          error: `Post-replay cleanup failed: ${error?.message || String(error)}`
        }
      }
    }

    if (result.ok) {
      this.coordinator.resume()
      this.state = 'idle'
      this.failureCount = 0
      this.backoffUntilMs = null
      this.lastError = null
      console.log('[Calculated replay] completed')
      if (this.queued) this.armTimer(this.queuedDelayMs(this.bufferQuietDebounceMs))
      return
    }

    try {
      this.onReplayFailure({ reason, meta, result })
    } catch (error) {
      console.error('[Calculated replay] failure cleanup failed', {
        error: error?.message || String(error)
      })
    }
    this.coordinator.resume()
    this.state = 'backoff'
    this.lastError = result.error
    this.queueRetry(reason, meta)
    console.error('[Calculated replay] failed', {
      code: result.code,
      signal: result.signal,
      error: result.error
    })
  }

  queueRetry(reason, meta) {
    this.failureCount += 1
    const backoffMs = Math.min(
      MAX_FAILURE_BACKOFF_MS,
      this.failureBackoffMs * (2 ** Math.min(5, Math.max(0, this.failureCount - 1)))
    )
    this.backoffUntilMs = this.now() + backoffMs
    this.queued = true
    if (!Number.isFinite(this.queuedSinceMs)) this.queuedSinceMs = this.now()
    this.pendingReason = this.pendingReason || reason || 'rtk-buffer-replay-retry'
    this.pendingMeta = this.pendingMeta || meta || {}
    this.armTimer(backoffMs)
  }

  runReplayProcess(reason, meta = {}) {
    return new Promise((resolveResult) => {
      let settled = false
      const replayStatePath = this.onReplayState
        ? resolve(tmpdir(), `farm-replay-state-${process.pid}-${randomUUID()}.json`)
        : null
      const child = this.spawnProcess(process.execPath, [this.replayScript], {
        cwd: this.serverRoot,
        env: {
          ...process.env,
          REPLAY_TRIGGER: reason || 'rtk-buffer',
          ...(meta?.farmDay ? { REPLAY_DAY: String(meta.farmDay) } : {}),
          ...(meta?.dirtyFrom ? { REPLAY_DIRTY_FROM: String(meta.dirtyFrom) } : {}),
          ...(meta?.dirtyTo ? { REPLAY_DIRTY_TO: String(meta.dirtyTo) } : {}),
          ...(replayStatePath ? { REPLAY_STATE_OUTPUT: replayStatePath } : {})
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })

      child.stdout?.on('data', (chunk) => {
        String(chunk).trimEnd().split(/\r?\n/).filter(Boolean).forEach((line) => {
          console.log(`[Calculated replay] ${line}`)
        })
      })
      child.stderr?.on('data', (chunk) => {
        String(chunk).trimEnd().split(/\r?\n/).filter(Boolean).forEach((line) => {
          console.error(`[Calculated replay] ${line}`)
        })
      })

      const finish = (result) => {
        if (settled) return
        settled = true
        if (result.ok && replayStatePath) {
          try {
            result.stateSnapshot = JSON.parse(readFileSync(replayStatePath, 'utf8'))
          } catch (error) {
            result.ok = false
            result.error = `Replay state output unavailable: ${error?.message || String(error)}`
          }
        }
        if (replayStatePath) rmSync(replayStatePath, { force: true })
        resolveResult(result)
      }
      child.once('error', (error) => finish({ ok: false, code: null, signal: null, error: error.message }))
      child.once('close', (code, signal) => finish({
        ok: code === 0,
        code,
        signal,
        error: code === 0 ? null : `Replay exited with code ${code}${signal ? ` (${signal})` : ''}`
      }))
    })
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer)
    this.timer = null
    this.nextRunAtMs = null
    if (this.isBlockingWrites()) this.coordinator.resume()
    this.state = 'idle'
  }
}

const replayScheduler = new CalculatedReplayScheduler({
  enabled: String(process.env.RTK_BUFFER_REPLAY_ENABLED || '1').trim() !== '0',
  replayDebounceMs: process.env.RTK_BUFFER_REPLAY_DEBOUNCE_MS,
  bufferQuietDebounceMs: process.env.TELEMETRY_BUFFER_REPLAY_DEBOUNCE_MS,
  bufferDrainedDebounceMs: process.env.RTK_BUFFER_DRAINED_REPLAY_DEBOUNCE_MS,
  drainTimeoutMs: process.env.REPLAY_WRITER_DRAIN_TIMEOUT_MS,
  failureBackoffMs: process.env.REPLAY_FAILURE_BACKOFF_MS,
  maxQueueWaitMs: process.env.REPLAY_MAX_QUEUE_WAIT_MS,
  replayReady: () => {
    const store = getHostIngressStore()
    return !store.replayDrainThroughId() && store.isReplayWindowReady()
  },
  onReplayStart: ({ meta }) => {
    const store = getHostIngressStore()
    const latestDirty = store.nextReplayDirty()
    const effectiveMeta = latestDirty?.farmDay === meta?.farmDay ? latestDirty : meta
    store.beginCalculatedReplay(effectiveMeta)
    return { meta: effectiveMeta }
  },
  onReplayState: (snapshot) => telemetryProcessor.replaceStates(snapshot),
  onReplaySuccess: ({ meta }) => getHostIngressStore().finishCalculatedReplay({
    clearHistoryDirty: true,
    farmDay: meta?.farmDay || null,
    throughVersion: meta?.version ?? meta?.dirtyVersion ?? null
  }),
  onReplayFailure: () => getHostIngressStore().finishCalculatedReplay({ clearHistoryDirty: false })
})

export function isCalculatedBatchReplayRunning() {
  return replayScheduler.isBlockingWrites()
}

export function getCalculatedReplayStatus() {
  return replayScheduler.getStatus()
}

export function scheduleReplayAfterRtkBuffer(reason = 'rtk-buffer', meta = {}) {
  return replayScheduler.schedule(reason, meta, replayScheduler.replayDebounceMs)
}

export function scheduleReplayAfterBufferedTelemetry(reason = 'telemetry-buffer', meta = {}, options = {}) {
  const delayMs = options.bufferDrained
    ? replayScheduler.bufferDrainedDebounceMs
    : replayScheduler.bufferQuietDebounceMs
  return replayScheduler.schedule(reason, meta, delayMs)
}

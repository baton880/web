import { spawn } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SERVER_ROOT = resolve(__dirname, '../../..')
const REPLAY_SCRIPT = resolve(SERVER_ROOT, 'scripts/replay-batches-from-telemetry.mjs')

const DEFAULT_REPLAY_DEBOUNCE_MS = 90 * 1000
const MIN_REPLAY_DEBOUNCE_MS = 10 * 1000
const MAX_REPLAY_DEBOUNCE_MS = 30 * 60 * 1000

function normalizeDebounceMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REPLAY_DEBOUNCE_MS
  }

  return Math.min(MAX_REPLAY_DEBOUNCE_MS, Math.max(MIN_REPLAY_DEBOUNCE_MS, parsed))
}

const REPLAY_DEBOUNCE_MS = normalizeDebounceMs(process.env.RTK_BUFFER_REPLAY_DEBOUNCE_MS)
const REPLAY_ENABLED = String(process.env.RTK_BUFFER_REPLAY_ENABLED || '1').trim() !== '0'

let replayTimer = null
let replayRunning = false
let replayQueued = false
let pendingReason = null
let pendingMeta = null

function summarizeMeta(meta = {}) {
  return Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])
  )
}

function runReplayProcess(reason, meta) {
  replayRunning = true
  console.log('[RTK buffer replay] starting calculated batch replay', {
    reason,
    ...summarizeMeta(meta)
  })

  const child = spawn(process.execPath, [REPLAY_SCRIPT], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      REPLAY_TRIGGER: reason || 'rtk-buffer'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.on('data', (chunk) => {
    String(chunk).trimEnd().split(/\r?\n/).filter(Boolean).forEach((line) => {
      console.log(`[RTK buffer replay] ${line}`)
    })
  })

  child.stderr.on('data', (chunk) => {
    String(chunk).trimEnd().split(/\r?\n/).filter(Boolean).forEach((line) => {
      console.error(`[RTK buffer replay] ${line}`)
    })
  })

  child.on('error', (error) => {
    replayRunning = false
    console.error('[RTK buffer replay] failed to start:', error)
    scheduleQueuedReplay('rtk-buffer-replay-retry', meta, MIN_REPLAY_DEBOUNCE_MS)
  })

  child.on('close', (code, signal) => {
    replayRunning = false
    if (code === 0) {
      console.log('[RTK buffer replay] completed')
    } else {
      console.error('[RTK buffer replay] failed', { code, signal })
    }

    if (replayQueued) {
      scheduleQueuedReplay('rtk-buffer-replay-followup', pendingMeta, REPLAY_DEBOUNCE_MS)
    }
  })
}

function scheduleQueuedReplay(reason, meta, delayMs) {
  if (!REPLAY_ENABLED) {
    return { scheduled: false, disabled: true }
  }

  replayQueued = true
  pendingReason = reason || pendingReason || 'rtk-buffer'
  pendingMeta = meta || pendingMeta || {}

  if (replayTimer) {
    clearTimeout(replayTimer)
  }

  replayTimer = setTimeout(() => {
    replayTimer = null
    if (replayRunning) {
      scheduleQueuedReplay(pendingReason, pendingMeta, delayMs)
      return
    }

    const replayReason = pendingReason || 'rtk-buffer'
    const replayMeta = pendingMeta || {}
    replayQueued = false
    pendingReason = null
    pendingMeta = null
    runReplayProcess(replayReason, replayMeta)
  }, delayMs)

  return { scheduled: true, delayMs }
}

export function scheduleReplayAfterRtkBuffer(reason = 'rtk-buffer', meta = {}) {
  return scheduleQueuedReplay(reason, meta, REPLAY_DEBOUNCE_MS)
}

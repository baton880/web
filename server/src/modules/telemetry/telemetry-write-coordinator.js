const DEFAULT_DRAIN_TIMEOUT_MS = 60 * 1000

function normalizeTimeoutMs(value, fallback = DEFAULT_DRAIN_TIMEOUT_MS) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export class TelemetryWriteCoordinator {
  constructor() {
    this.accepting = true
    this.pauseReason = null
    this.activeWriters = 0
    this.activeBySource = new Map()
    this.waiters = new Set()
  }

  tryAcquire(source = 'unknown') {
    // SQLite permits several readers, but concurrent long-lived write
    // transactions are exactly what caused the production timeout storm.
    // Admission is therefore a real process-local mutex, not just a replay
    // gate. Host and RTK ingress workers retry when the lease is unavailable.
    if (!this.accepting || this.activeWriters >= 1) return null

    const normalizedSource = String(source || 'unknown')
    this.activeWriters += 1
    this.activeBySource.set(normalizedSource, (this.activeBySource.get(normalizedSource) || 0) + 1)
    let released = false

    return {
      release: () => {
        if (released) return
        released = true
        this.activeWriters = Math.max(0, this.activeWriters - 1)
        const nextCount = Math.max(0, (this.activeBySource.get(normalizedSource) || 1) - 1)
        if (nextCount === 0) this.activeBySource.delete(normalizedSource)
        else this.activeBySource.set(normalizedSource, nextCount)
        this.flushWaitersIfIdle()
      }
    }
  }

  pause(reason = 'calculated-replay') {
    this.accepting = false
    this.pauseReason = String(reason || 'calculated-replay')
    return this.snapshot()
  }

  resume() {
    this.accepting = true
    this.pauseReason = null
    return this.snapshot()
  }

  async waitForIdle(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
    if (this.activeWriters === 0) return true

    const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs)
    if (normalizedTimeoutMs === 0) return false

    return new Promise((resolve) => {
      const waiter = { resolve, timer: null }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(false)
      }, normalizedTimeoutMs)
      waiter.timer.unref?.()
      this.waiters.add(waiter)
    })
  }

  flushWaitersIfIdle() {
    if (this.activeWriters !== 0) return
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(true)
    }
    this.waiters.clear()
  }

  snapshot() {
    return {
      accepting: this.accepting,
      pauseReason: this.pauseReason,
      activeWriters: this.activeWriters,
      activeBySource: Object.fromEntries(this.activeBySource)
    }
  }
}

const telemetryWriteCoordinator = new TelemetryWriteCoordinator()

export function getTelemetryWriteCoordinator() {
  return telemetryWriteCoordinator
}

export function getTelemetryWriteCoordinatorStatus() {
  return telemetryWriteCoordinator.snapshot()
}

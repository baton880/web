import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { farmDateRange, getFarmDateString } from '../../utils/farm-date.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SERVER_ROOT = path.resolve(__dirname, '../../..')
const DEFAULT_DATABASE_PATH = path.join(SERVER_ROOT, 'runtime', 'host-ingress.sqlite3')
const PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CATCHUP_THROUGH_ID_KEY = 'replay_catchup_through_id'
const REPLAY_ACTIVE_KEY = 'calculated_replay_active'
const PROCESSED_HIGH_WATER_KEY = 'processed_high_water_timestamp'
const DIRTY_PADDING_MS = 10 * 60 * 1000
const REPLAY_BOUNDARY_SETTLE_MS = 10 * 60 * 1000
const DEFAULT_REPLAY_BOUNDARY_MAX_WAIT_MS = 30 * 60 * 1000

function isoNow() {
  return new Date().toISOString()
}

function resolveDatabasePath(value) {
  const resolved = path.resolve(value || DEFAULT_DATABASE_PATH)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  return resolved
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function legacyDedupeKey(payload) {
  return `legacy:${crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex')}`
}

export class HostIngressStore {
  constructor(databasePath = process.env.HOST_INGRESS_DATABASE_PATH) {
    this.databasePath = resolveDatabasePath(databasePath)
    this.replayBoundaryMaxWaitMs = Math.max(
      60 * 1000,
      Number(process.env.HOST_REPLAY_BOUNDARY_MAX_WAIT_MS) || DEFAULT_REPLAY_BOUNDARY_MAX_WAIT_MS
    )
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_ingress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        device_id TEXT,
        stream_id TEXT,
        packet_id INTEGER,
        is_live INTEGER NOT NULL DEFAULT 0,
        raw_body TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        processed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS host_ingress_ready_idx
        ON host_ingress(status, next_attempt_at, is_live DESC, id);
      CREATE TABLE IF NOT EXISTS host_ingress_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calculated_replay_dirty (
        farm_day TEXT PRIMARY KEY,
        dirty_from TEXT NOT NULL,
        dirty_to TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
    `)
    const now = isoNow()
    this.db.prepare(`
      UPDATE host_ingress
      SET status = 'retry', next_attempt_at = ?, updated_at = ?,
          last_error = COALESCE(last_error, 'worker restarted while processing')
      WHERE status = 'processing'
    `).run(now, now)
    this.db.prepare(`
      UPDATE host_ingress AS older
      SET is_live = 0, updated_at = ?
      WHERE older.status IN ('pending', 'retry')
        AND older.is_live = 1
        AND EXISTS (
          SELECT 1
          FROM host_ingress AS newer
          WHERE newer.device_id = older.device_id
            AND newer.status IN ('pending', 'retry')
            AND newer.is_live = 1
            AND newer.id > older.id
      )
    `).run(now)
    this.recoverInterruptedReplay(now)

    this.insertPacket = this.db.prepare(`
      INSERT INTO host_ingress (
        dedupe_key, device_id, stream_id, packet_id, is_live, raw_body,
        received_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        is_live = excluded.is_live,
        updated_at = excluded.updated_at
    `)
    this.demoteReadyLivePackets = this.db.prepare(`
      UPDATE host_ingress
      SET is_live = 0, updated_at = ?
      WHERE device_id = ?
        AND status IN ('pending', 'retry')
        AND is_live = 1
    `)
    this.maxPacketIdForStream = this.db.prepare(`
      SELECT MAX(packet_id) max_packet_id
      FROM host_ingress
      WHERE device_id = ? AND stream_id = ?
    `)
    this.enqueueTransaction = this.db.transaction((entries, receivedAt) => {
      const nowIso = isoNow()
      const liveCandidates = entries.filter((entry) => entry.isLive)
      const acceptedLiveKeys = new Set()
      for (const candidate of liveCandidates) {
        const previousMax = this.maxPacketIdForStream.get(candidate.deviceId, candidate.streamId)?.max_packet_id
        if (previousMax == null || candidate.packetId >= Number(previousMax)) {
          this.demoteReadyLivePackets.run(nowIso, candidate.deviceId)
          acceptedLiveKeys.add(candidate.dedupeKey)
        }
      }
      for (const entry of entries) {
        this.insertPacket.run(
          entry.dedupeKey,
          entry.deviceId || null,
          entry.streamId || null,
          Number.isInteger(entry.packetId) ? entry.packetId : null,
          entry.isLive && acceptedLiveKeys.has(entry.dedupeKey) ? 1 : 0,
          JSON.stringify(entry.payload),
          receivedAt,
          nowIso,
          nowIso
        )
      }
    })
    this.claimTransaction = this.db.transaction((nowIso) => {
      const catchupThroughId = Number(this.getMetaValue(CATCHUP_THROUGH_ID_KEY))
      let row = null

      if (Number.isInteger(catchupThroughId) && catchupThroughId > 0) {
        row = this.db.prepare(`
          SELECT * FROM host_ingress
          WHERE id <= ?
            AND status IN ('pending', 'retry')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY id ASC
          LIMIT 1
        `).get(catchupThroughId, nowIso)

        if (!row) {
          const remaining = this.db.prepare(`
            SELECT 1
            FROM host_ingress
            WHERE id <= ? AND status IN ('pending', 'retry', 'processing')
            LIMIT 1
          `).get(catchupThroughId)
          if (remaining) return null
          this.deleteMetaValue(CATCHUP_THROUGH_ID_KEY)
          // Yield at the finite fence boundary so the worker can schedule the
          // replay before it starts consuming packets that arrived later.
          return null
        }
      }

      row ||= this.db.prepare(`
        SELECT * FROM host_ingress
        WHERE status IN ('pending', 'retry')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY
          is_live DESC,
          CASE WHEN is_live = 1 THEN id END DESC,
          id ASC
        LIMIT 1
      `).get(nowIso)
      if (!row) return null
      const result = this.db.prepare(`
        UPDATE host_ingress
        SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'retry')
      `).run(nowIso, row.id)
      return result.changes === 1 ? { ...row, status: 'processing', attempts: row.attempts + 1 } : null
    })
  }

  getMetaValue(key) {
    return this.db.prepare('SELECT value FROM host_ingress_meta WHERE key = ?').get(String(key))?.value ?? null
  }

  setMetaValue(key, value, updatedAt = isoNow()) {
    this.db.prepare(`
      INSERT INTO host_ingress_meta(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(String(key), String(value), updatedAt)
  }

  deleteMetaValue(key) {
    return this.db.prepare('DELETE FROM host_ingress_meta WHERE key = ?').run(String(key)).changes
  }

  maxUnprocessedIngressId() {
    const value = this.db.prepare(`
      SELECT MAX(id) max_id
      FROM host_ingress
      WHERE status IN ('pending', 'retry', 'processing')
    `).get()?.max_id
    return Number.isInteger(value) ? value : null
  }

  beginReplayDrain(now = isoNow()) {
    const existing = Number(this.getMetaValue(CATCHUP_THROUGH_ID_KEY))
    const maxId = this.maxUnprocessedIngressId()
    const throughId = Math.max(
      Number.isInteger(existing) && existing > 0 ? existing : 0,
      Number.isInteger(maxId) && maxId > 0 ? maxId : 0
    ) || null
    if (Number.isInteger(throughId)) this.setMetaValue(CATCHUP_THROUGH_ID_KEY, throughId, now)
    return throughId
  }

  replayDrainThroughId() {
    const value = Number(this.getMetaValue(CATCHUP_THROUGH_ID_KEY))
    return Number.isInteger(value) && value > 0 ? value : null
  }

  noteProcessedTimestamp(timestamp, now = isoNow()) {
    const timestampMs = new Date(timestamp).getTime()
    if (!Number.isFinite(timestampMs)) return this.processedHighWaterTimestamp()
    const previous = this.processedHighWaterTimestamp()
    if (!previous || timestampMs > new Date(previous).getTime()) {
      const next = new Date(timestampMs).toISOString()
      this.setMetaValue(PROCESSED_HIGH_WATER_KEY, next, now)
      return next
    }
    return previous
  }

  processedHighWaterTimestamp() {
    return this.getMetaValue(PROCESSED_HIGH_WATER_KEY)
  }

  isReplayWindowReady(dirty = this.nextReplayDirty(), nowMs = Date.now()) {
    if (!dirty) return true
    const dirtyToMs = new Date(dirty.dirtyTo).getTime()
    const highWaterMs = new Date(this.processedHighWaterTimestamp() || 0).getTime()
    if (
      Number.isFinite(dirtyToMs) &&
      Number.isFinite(highWaterMs) &&
      highWaterMs >= dirtyToMs + REPLAY_BOUNDARY_SETTLE_MS
    ) return true
    const updatedAtMs = new Date(dirty.updatedAt || 0).getTime()
    return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= this.replayBoundaryMaxWaitMs
  }

  recoverInterruptedReplay(now = isoNow()) {
    const replayWasActive = this.getMetaValue(REPLAY_ACTIVE_KEY)
    if (!replayWasActive) return false
    const maxId = this.maxUnprocessedIngressId()
    if (Number.isInteger(maxId)) this.setMetaValue(CATCHUP_THROUGH_ID_KEY, maxId, now)
    this.deleteMetaValue(REPLAY_ACTIVE_KEY)
    return true
  }

  enqueueLegacy(payload, receivedAt = new Date()) {
    const receivedIso = new Date(receivedAt).toISOString()
    const dedupeKey = legacyDedupeKey(payload)
    const duplicate = Boolean(this.getByDedupeKey(dedupeKey))
    this.enqueueTransaction.immediate([{
      dedupeKey,
      deviceId: payload?.device_id || payload?.deviceId || null,
      streamId: dedupeKey,
      packetId: 0,
      payload,
      isLive: true
    }], receivedIso)
    return { receiptId: dedupeKey, duplicate }
  }

  enqueueBatch({ deviceId, streamId, livePacketId, packets }, receivedAt = new Date()) {
    const receivedIso = new Date(receivedAt).toISOString()
    const entries = packets.map(({ packetId, payload }) => ({
      dedupeKey: `v1:${deviceId}:${streamId}:${packetId}`,
      deviceId,
      streamId,
      packetId,
      payload,
      isLive: packetId === livePacketId
    }))
    this.enqueueTransaction.immediate(entries, receivedIso)
    return {
      receiptId: crypto.createHash('sha256').update(entries.map((entry) => entry.dedupeKey).join('|')).digest('hex'),
      ackedPacketIds: entries.map((entry) => entry.packetId)
    }
  }

  getByDedupeKey(dedupeKey) {
    return this.db.prepare('SELECT * FROM host_ingress WHERE dedupe_key = ?').get(dedupeKey)
  }

  latestAccepted(deviceId = null) {
    const row = this.db.prepare(`
      SELECT id, device_id, stream_id, packet_id, raw_body, received_at, status
      FROM host_ingress
      WHERE is_live = 1
        AND (? IS NULL OR device_id = ?)
      ORDER BY id DESC
      LIMIT 1
    `).get(deviceId || null, deviceId || null)
    if (!row) return null
    try {
      return {
        inboxId: row.id,
        deviceId: row.device_id,
        streamId: row.stream_id,
        packetId: row.packet_id,
        payload: JSON.parse(row.raw_body),
        receivedAt: row.received_at,
        status: row.status
      }
    } catch {
      return null
    }
  }

  recentAccepted(limit = 20, deviceId = null) {
    const take = Math.min(500, Math.max(1, Number(limit) || 20))
    const rows = this.db.prepare(`
      SELECT id, device_id, stream_id, packet_id, is_live, raw_body, received_at, status
      FROM host_ingress
      WHERE status != 'permanent'
        AND (? IS NULL OR device_id = ?)
      ORDER BY id DESC
      LIMIT ?
    `).all(deviceId || null, deviceId || null, take)

    return rows.flatMap((row) => {
      try {
        return [{
          inboxId: row.id,
          deviceId: row.device_id,
          streamId: row.stream_id,
          packetId: row.packet_id,
          isLive: Boolean(row.is_live),
          payload: JSON.parse(row.raw_body),
          receivedAt: row.received_at,
          status: row.status
        }]
      } catch {
        return []
      }
    })
  }

  claimNext() {
    return this.claimTransaction.immediate(isoNow())
  }

  markProcessed(id) {
    const now = isoNow()
    this.db.prepare(`UPDATE host_ingress SET status='processed', processed_at=?, updated_at=?, next_attempt_at=NULL, last_error=NULL WHERE id=?`).run(now, now, id)
  }

  markRetry(id, error, delayMs) {
    const now = new Date()
    const next = new Date(now.getTime() + Math.max(1000, Number(delayMs) || 1000)).toISOString()
    this.db.prepare(`UPDATE host_ingress SET status='retry', next_attempt_at=?, last_error=?, updated_at=? WHERE id=?`)
      .run(next, String(error || '').slice(0, 4000), now.toISOString(), id)
  }

  markPermanent(id, error) {
    this.db.prepare(`UPDATE host_ingress SET status='permanent', next_attempt_at=NULL, last_error=?, updated_at=? WHERE id=?`)
      .run(String(error || '').slice(0, 4000), isoNow(), id)
  }

  markHistoryDirty(timestamp) {
    return this.markReplayDirtyRange(timestamp, timestamp, 'host')
  }

  markReplayDirtyRange(from, to = from, source = 'host') {
    const fromMs = new Date(from).getTime()
    const toMs = new Date(to).getTime()
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new TypeError('Replay dirty range requires valid timestamps')
    }

    const rangeStartMs = Math.min(fromMs, toMs) - DIRTY_PADDING_MS
    const rangeEndMs = Math.max(fromMs, toMs) + DIRTY_PADDING_MS
    const firstDay = getFarmDateString(new Date(rangeStartMs))
    const lastDay = getFarmDateString(new Date(rangeEndMs))
    const days = []
    let cursorDay = firstDay
    while (cursorDay) {
      days.push(cursorDay)
      if (cursorDay === lastDay) break
      const cursorRange = farmDateRange(cursorDay)
      if (!cursorRange) break
      cursorDay = getFarmDateString(new Date(cursorRange.end.getTime() + 1))
    }
    const normalizedSource = String(source || 'unknown').trim() || 'unknown'
    const updated = []

    const transaction = this.db.transaction(() => {
      for (const farmDay of days) {
        const dayRange = farmDateRange(farmDay)
        if (!dayRange) continue
        const clippedFrom = new Date(Math.max(rangeStartMs, dayRange.start.getTime())).toISOString()
        const clippedTo = new Date(Math.min(rangeEndMs, dayRange.end.getTime())).toISOString()
        if (clippedFrom > clippedTo) continue

        const existing = this.db.prepare(`
          SELECT farm_day, dirty_from, dirty_to, sources, version
          FROM calculated_replay_dirty
          WHERE farm_day = ?
        `).get(farmDay)
        const sources = new Set(String(existing?.sources || '').split(',').map((item) => item.trim()).filter(Boolean))
        sources.add(normalizedSource)
        const dirtyFrom = existing && existing.dirty_from < clippedFrom ? existing.dirty_from : clippedFrom
        const dirtyTo = existing && existing.dirty_to > clippedTo ? existing.dirty_to : clippedTo
        const version = Number(existing?.version || 0) + 1
        const now = isoNow()
        this.db.prepare(`
          INSERT INTO calculated_replay_dirty(farm_day, dirty_from, dirty_to, sources, version, updated_at)
          VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(farm_day) DO UPDATE SET
            dirty_from=excluded.dirty_from,
            dirty_to=excluded.dirty_to,
            sources=excluded.sources,
            version=excluded.version,
            updated_at=excluded.updated_at
        `).run(farmDay, dirtyFrom, dirtyTo, [...sources].sort().join(','), version, now)
        updated.push({ farmDay, dirtyFrom, dirtyTo, sources: [...sources].sort(), version, updatedAt: now })
      }

      const earliest = this.db.prepare(`
        SELECT dirty_from FROM calculated_replay_dirty ORDER BY dirty_from ASC LIMIT 1
      `).get()?.dirty_from
      if (earliest) this.setMetaValue('history_dirty_from', earliest)
    })
    transaction.immediate()
    return updated
  }

  nextReplayDirty() {
    const row = this.db.prepare(`
      SELECT farm_day, dirty_from, dirty_to, sources, version, updated_at
      FROM calculated_replay_dirty
      ORDER BY dirty_from ASC, farm_day ASC
      LIMIT 1
    `).get()
    return row ? {
      farmDay: row.farm_day,
      dirtyFrom: row.dirty_from,
      dirtyTo: row.dirty_to,
      sources: String(row.sources || '').split(',').filter(Boolean),
      version: Number(row.version),
      updatedAt: row.updated_at
    } : null
  }

  listReplayDirty(limit = 31) {
    const take = Math.min(366, Math.max(1, Number(limit) || 31))
    return this.db.prepare(`
      SELECT farm_day, dirty_from, dirty_to, sources, version, updated_at
      FROM calculated_replay_dirty
      ORDER BY dirty_from ASC, farm_day ASC
      LIMIT ?
    `).all(take).map((row) => ({
      farmDay: row.farm_day,
      dirtyFrom: row.dirty_from,
      dirtyTo: row.dirty_to,
      sources: String(row.sources || '').split(',').filter(Boolean),
      version: Number(row.version),
      updatedAt: row.updated_at
    }))
  }

  clearReplayDirty(farmDay, throughVersion = Number.MAX_SAFE_INTEGER) {
    const result = this.db.prepare(`
      DELETE FROM calculated_replay_dirty
      WHERE farm_day = ? AND version <= ?
    `).run(String(farmDay), Number(throughVersion))
    const earliest = this.db.prepare(`
      SELECT dirty_from FROM calculated_replay_dirty ORDER BY dirty_from ASC LIMIT 1
    `).get()?.dirty_from
    if (earliest) this.setMetaValue('history_dirty_from', earliest)
    else this.deleteMetaValue('history_dirty_from')
    return result.changes
  }

  clearHistoryDirty() {
    return this.db.transaction(() => {
      const dirtyChanges = this.db.prepare('DELETE FROM calculated_replay_dirty').run().changes
      const metaChanges = this.deleteMetaValue('history_dirty_from')
      return dirtyChanges + metaChanges
    }).immediate()
  }

  beginCalculatedReplay(meta = {}) {
    this.setMetaValue(REPLAY_ACTIVE_KEY, JSON.stringify({
      startedAt: isoNow(),
      farmDay: meta?.farmDay || null,
      version: Number(meta?.version || meta?.dirtyVersion) || null
    }))
  }

  finishCalculatedReplay({ clearHistoryDirty = false, farmDay = null, throughVersion = null } = {}) {
    return this.db.transaction(() => {
      const maxId = this.maxUnprocessedIngressId()
      if (Number.isInteger(maxId)) this.setMetaValue(CATCHUP_THROUGH_ID_KEY, maxId)
      else this.deleteMetaValue(CATCHUP_THROUGH_ID_KEY)
      this.deleteMetaValue(REPLAY_ACTIVE_KEY)
      const clearedHistoryDirty = clearHistoryDirty
        ? (farmDay
            ? this.clearReplayDirty(farmDay, throughVersion ?? Number.MAX_SAFE_INTEGER)
            : this.db.prepare('DELETE FROM calculated_replay_dirty').run().changes + this.deleteMetaValue('history_dirty_from'))
        : 0
      return { catchupThroughId: maxId, clearedHistoryDirty }
    }).immediate()
  }

  cleanup() {
    const cutoff = new Date(Date.now() - PROCESSED_RETENTION_MS).toISOString()
    return this.db.prepare(`DELETE FROM host_ingress WHERE status='processed' AND processed_at < ?`).run(cutoff).changes
  }

  stats() {
    const counts = Object.fromEntries(this.db.prepare(`SELECT status, COUNT(*) count FROM host_ingress GROUP BY status`).all().map((row) => [row.status, Number(row.count)]))
    const readyCounts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN is_live = 1 THEN 1 ELSE 0 END) live,
        SUM(CASE WHEN is_live = 0 THEN 1 ELSE 0 END) history
      FROM host_ingress
      WHERE status IN ('pending','retry','processing')
    `).get() || {}
    const oldest = this.db.prepare(`SELECT received_at FROM host_ingress WHERE status IN ('pending','retry','processing') ORDER BY id LIMIT 1`).get()
    const newestLive = this.db.prepare(`
      SELECT received_at
      FROM host_ingress
      WHERE status IN ('pending','retry','processing') AND is_live = 1
      ORDER BY id DESC
      LIMIT 1
    `).get()
    const lastError = this.db.prepare(`SELECT id,status,attempts,last_error,updated_at FROM host_ingress WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1`).get()
    const historyDirtyFrom = this.db.prepare(`SELECT value FROM host_ingress_meta WHERE key='history_dirty_from'`).get()?.value || null
    const catchupThroughId = Number(this.getMetaValue(CATCHUP_THROUGH_ID_KEY)) || null
    const replayDirty = this.nextReplayDirty()
    const replayDirtyDayCount = Number(this.db.prepare('SELECT COUNT(*) count FROM calculated_replay_dirty').get()?.count || 0)
    const processedHighWaterTimestamp = this.processedHighWaterTimestamp()
    const oldestMs = oldest ? new Date(oldest.received_at).getTime() : NaN
    const newestLiveMs = newestLive ? new Date(newestLive.received_at).getTime() : NaN
    return {
      databasePath: this.databasePath,
      pending: counts.pending || 0,
      retry: counts.retry || 0,
      processing: counts.processing || 0,
      processed: counts.processed || 0,
      permanent: counts.permanent || 0,
      pendingLive: Number(readyCounts.live) || 0,
      pendingHistory: Number(readyCounts.history) || 0,
      oldestPendingAgeSeconds: Number.isFinite(oldestMs) ? Math.max(0, Math.round((Date.now() - oldestMs) / 1000)) : null,
      newestLiveAgeSeconds: Number.isFinite(newestLiveMs) ? Math.max(0, Math.round((Date.now() - newestLiveMs) / 1000)) : null,
      historyDirtyFrom,
      replayDirty,
      replayDirtyDayCount,
      catchupThroughId,
      processedHighWaterTimestamp,
      replayWindowReady: this.isReplayWindowReady(replayDirty),
      lastError: lastError || null
    }
  }

  close() {
    this.db.close()
  }
}

let defaultStore = null

export function getHostIngressStore() {
  if (!defaultStore) defaultStore = new HostIngressStore()
  return defaultStore
}

export function getHostIngressStats() {
  return getHostIngressStore().stats()
}

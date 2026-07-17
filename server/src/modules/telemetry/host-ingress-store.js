import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SERVER_ROOT = path.resolve(__dirname, '../../..')
const DEFAULT_DATABASE_PATH = path.join(SERVER_ROOT, 'runtime', 'host-ingress.sqlite3')
const PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

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
    `)
    const now = isoNow()
    this.db.prepare(`
      UPDATE host_ingress
      SET status = 'retry', next_attempt_at = ?, updated_at = ?,
          last_error = COALESCE(last_error, 'worker restarted while processing')
      WHERE status = 'processing'
    `).run(now, now)

    this.insertPacket = this.db.prepare(`
      INSERT INTO host_ingress (
        dedupe_key, device_id, stream_id, packet_id, is_live, raw_body,
        received_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        is_live = MAX(host_ingress.is_live, excluded.is_live),
        updated_at = excluded.updated_at
    `)
    this.enqueueTransaction = this.db.transaction((entries, receivedAt) => {
      const nowIso = isoNow()
      for (const entry of entries) {
        this.insertPacket.run(
          entry.dedupeKey,
          entry.deviceId || null,
          entry.streamId || null,
          Number.isInteger(entry.packetId) ? entry.packetId : null,
          entry.isLive ? 1 : 0,
          JSON.stringify(entry.payload),
          receivedAt,
          nowIso,
          nowIso
        )
      }
    })
    this.claimTransaction = this.db.transaction((nowIso) => {
      const row = this.db.prepare(`
        SELECT * FROM host_ingress
        WHERE status IN ('pending', 'retry')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY is_live DESC, id ASC
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
    const candidate = new Date(timestamp).toISOString()
    const current = this.db.prepare(`SELECT value FROM host_ingress_meta WHERE key='history_dirty_from'`).get()?.value
    const value = !current || candidate < current ? candidate : current
    this.db.prepare(`
      INSERT INTO host_ingress_meta(key, value, updated_at) VALUES('history_dirty_from', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(value, isoNow())
  }

  clearHistoryDirty() {
    return this.db.prepare(`DELETE FROM host_ingress_meta WHERE key='history_dirty_from'`).run().changes
  }

  cleanup() {
    const cutoff = new Date(Date.now() - PROCESSED_RETENTION_MS).toISOString()
    return this.db.prepare(`DELETE FROM host_ingress WHERE status='processed' AND processed_at < ?`).run(cutoff).changes
  }

  stats() {
    const counts = Object.fromEntries(this.db.prepare(`SELECT status, COUNT(*) count FROM host_ingress GROUP BY status`).all().map((row) => [row.status, Number(row.count)]))
    const oldest = this.db.prepare(`SELECT received_at FROM host_ingress WHERE status IN ('pending','retry','processing') ORDER BY id LIMIT 1`).get()
    const lastError = this.db.prepare(`SELECT id,status,attempts,last_error,updated_at FROM host_ingress WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1`).get()
    const historyDirtyFrom = this.db.prepare(`SELECT value FROM host_ingress_meta WHERE key='history_dirty_from'`).get()?.value || null
    const oldestMs = oldest ? new Date(oldest.received_at).getTime() : NaN
    return {
      databasePath: this.databasePath,
      pending: counts.pending || 0,
      retry: counts.retry || 0,
      processing: counts.processing || 0,
      processed: counts.processed || 0,
      permanent: counts.permanent || 0,
      oldestPendingAgeSeconds: Number.isFinite(oldestMs) ? Math.max(0, Math.round((Date.now() - oldestMs) / 1000)) : null,
      historyDirtyFrom,
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

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SERVER_ROOT = path.resolve(__dirname, '../../..')
const DEFAULT_DATABASE_PATH = path.join(SERVER_ROOT, 'runtime', 'rtk-ingress.sqlite3')
const MAX_ATTEMPTS = 1000000
const PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function isoNow() {
  return new Date().toISOString()
}

function normalizeDatabasePath(value) {
  const resolved = path.resolve(value || DEFAULT_DATABASE_PATH)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  return resolved
}

export class RtkIngressStore {
  constructor(databasePath = process.env.RTK_INGRESS_DATABASE_PATH) {
    this.databasePath = normalizeDatabasePath(databasePath)
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rtk_ingress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_hash TEXT NOT NULL UNIQUE,
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
      CREATE INDEX IF NOT EXISTS rtk_ingress_status_next_idx
        ON rtk_ingress(status, next_attempt_at, id);
    `)
    this.db.prepare(`
      UPDATE rtk_ingress
      SET status = 'retry', next_attempt_at = ?, updated_at = ?,
          last_error = COALESCE(last_error, 'worker restarted while processing')
      WHERE status = 'processing'
    `).run(isoNow(), isoNow())

    this.insertRequest = this.db.prepare(`
      INSERT INTO rtk_ingress (
        request_hash, raw_body, received_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(request_hash) DO NOTHING
    `)
    this.findByHash = this.db.prepare('SELECT * FROM rtk_ingress WHERE request_hash = ?')
    this.findReady = this.db.prepare(`
      SELECT * FROM rtk_ingress
      WHERE status IN ('pending', 'retry')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY id ASC
      LIMIT 1
    `)
    this.markProcessing = this.db.prepare(`
      UPDATE rtk_ingress
      SET status = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retry') AND attempts < ?
    `)
    this.markProcessedStatement = this.db.prepare(`
      UPDATE rtk_ingress
      SET status = 'processed', processed_at = ?, updated_at = ?,
          next_attempt_at = NULL, last_error = NULL
      WHERE id = ?
    `)
    this.markRetryStatement = this.db.prepare(`
      UPDATE rtk_ingress
      SET status = 'retry', next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `)
    this.markPermanentStatement = this.db.prepare(`
      UPDATE rtk_ingress
      SET status = 'permanent', next_attempt_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ?
    `)
    this.claimTransaction = this.db.transaction((now) => {
      const row = this.findReady.get(now)
      if (!row) return null
      const updated = this.markProcessing.run(now, row.id, MAX_ATTEMPTS)
      return updated.changes === 1 ? { ...row, status: 'processing', attempts: row.attempts + 1 } : null
    })
  }

  enqueue(rawBody, receivedAt = new Date()) {
    const body = typeof rawBody === 'string' ? rawBody : String(rawBody ?? '')
    const requestHash = crypto.createHash('sha256').update(body).digest('hex')
    const receivedIso = receivedAt instanceof Date ? receivedAt.toISOString() : new Date(receivedAt).toISOString()
    const now = isoNow()
    const result = this.insertRequest.run(requestHash, body, receivedIso, now, now)
    const row = this.findByHash.get(requestHash)
    return { inserted: result.changes === 1, requestHash, row }
  }

  claimNext() {
    return this.claimTransaction(isoNow())
  }

  markProcessed(id) {
    const now = isoNow()
    this.markProcessedStatement.run(now, now, id)
  }

  markRetry(id, error, delayMs) {
    const now = new Date()
    const next = new Date(now.getTime() + Math.max(1000, Number(delayMs) || 1000)).toISOString()
    this.markRetryStatement.run(next, String(error || '').slice(0, 4000), now.toISOString(), id)
  }

  markPermanent(id, error) {
    this.markPermanentStatement.run(String(error || '').slice(0, 4000), isoNow(), id)
  }

  cleanup() {
    const cutoff = new Date(Date.now() - PROCESSED_RETENTION_MS).toISOString()
    return this.db.prepare(`
      DELETE FROM rtk_ingress WHERE status = 'processed' AND processed_at < ?
    `).run(cutoff).changes
  }

  stats() {
    const counts = Object.fromEntries(
      this.db.prepare('SELECT status, COUNT(*) AS count FROM rtk_ingress GROUP BY status')
        .all()
        .map((row) => [row.status, Number(row.count) || 0])
    )
    const oldest = this.db.prepare(`
      SELECT received_at FROM rtk_ingress
      WHERE status IN ('pending', 'retry', 'processing')
      ORDER BY id ASC LIMIT 1
    `).get()
    const lastError = this.db.prepare(`
      SELECT id, status, attempts, last_error, updated_at
      FROM rtk_ingress WHERE last_error IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get()
    const oldestMs = oldest ? new Date(oldest.received_at).getTime() : NaN

    return {
      databasePath: this.databasePath,
      pending: counts.pending || 0,
      retry: counts.retry || 0,
      processing: counts.processing || 0,
      processed: counts.processed || 0,
      permanent: counts.permanent || 0,
      oldestPendingAgeSeconds: Number.isFinite(oldestMs)
        ? Math.max(0, Math.round((Date.now() - oldestMs) / 1000))
        : null,
      lastError: lastError || null
    }
  }

  close() {
    this.db.close()
  }
}

let defaultStore = null

export function getRtkIngressStore() {
  if (!defaultStore) defaultStore = new RtkIngressStore()
  return defaultStore
}

export function enqueueRtkIngress(rawBody, receivedAt) {
  return getRtkIngressStore().enqueue(rawBody, receivedAt)
}

export function getRtkIngressStats() {
  return getRtkIngressStore().stats()
}

import { createHash, randomUUID } from 'node:crypto'

const MAX_ATTEMPTS = 1000000
const RETENTION_DAYS = 7
const dateFields = ['received_at', 'next_attempt_at', 'created_at', 'updated_at', 'processed_at', 'lease_until']
function decode(row) {
  if (!row) return null
  const result = { ...row, id: Number(row.id) }
  if (!Number.isSafeInteger(result.id)) throw Error('Ingress ID exceeds the numeric API range')
  for (const field of dateFields) if (result[field] instanceof Date) result[field] = result[field].toISOString()
  return result
}
function accepted(row) {
  if (!row) return null
  try { return { inboxId: row.id, requestHash: row.request_hash, body: JSON.parse(row.raw_body), receivedAt: row.received_at, status: row.status } }
  catch { return null }
}
function duration(value) { return Math.min(300000, Math.max(1000, Number(value) || 60000)) }
export class IngressLeaseLostError extends Error {
  constructor() { super('Ingress lease expired or belongs to another claim'); this.name = 'IngressLeaseLostError' }
}

// Stage 2: explicitly constructed with a pg Pool. Not selected by production yet.
// Fences queue transitions; business writes also need transaction-level fencing
// before multiple calculation workers may run against a farm.
export class PostgresRtkIngressStore {
  constructor(pool, { owner = randomUUID(), leaseMs = 60000 } = {}) {
    this.pool = pool
    this.owner = owner
    this.leaseMs = duration(leaseMs)
  }
  async enqueue(rawBody, receivedAt = new Date()) {
    const body = typeof rawBody === 'string' ? rawBody : String(rawBody ?? '')
    const requestHash = createHash('sha256').update(body).digest('hex')
    const result = await this.pool.query(`INSERT INTO rtk_ingress(request_hash,raw_body,received_at)
      VALUES($1,$2,$3) ON CONFLICT(request_hash) DO NOTHING RETURNING id`, [requestHash, body, new Date(receivedAt)])
    // A separate READ COMMITTED statement sees the winner of a concurrent insert.
    const { rows } = await this.pool.query('SELECT * FROM rtk_ingress WHERE request_hash=$1', [requestHash])
    if (!rows.length) throw Error('Accepted inbox row unavailable')
    return { inserted: result.rowCount === 1, requestHash, row: decode(rows[0]) }
  }
  async latestAccepted() {
    const { rows } = await this.pool.query('SELECT * FROM rtk_ingress ORDER BY id DESC LIMIT 1')
    return accepted(decode(rows[0]))
  }
  async recentAccepted(limit = 100) {
    const take = Math.trunc(Math.min(500, Math.max(1, Number(limit) || 100)))
    const { rows } = await this.pool.query("SELECT * FROM rtk_ingress WHERE status <> 'permanent' ORDER BY id DESC LIMIT $1", [take])
    return rows.map(row => accepted(decode(row))).filter(Boolean)
  }
  async claimNext() {
    const token = randomUUID()
    const { rows } = await this.pool.query(`WITH candidate AS (
      SELECT id FROM rtk_ingress WHERE attempts < $4 AND (
        (status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
        OR (status='processing' AND lease_until <= clock_timestamp())
      ) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE rtk_ingress AS q SET status='processing', attempts=q.attempts+1,
      lease_owner=$1::uuid, lease_token=$2::uuid,
      lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',
      updated_at=clock_timestamp()
      FROM candidate WHERE q.id=candidate.id RETURNING q.*`, [this.owner, token, this.leaseMs, MAX_ATTEMPTS])
    return decode(rows[0])
  }
  async renewLease(id, token) {
    const result = await this.pool.query(`UPDATE rtk_ingress
      SET lease_until=clock_timestamp()+$4::double precision*interval '1 millisecond', updated_at=clock_timestamp()
      WHERE id=$1 AND status='processing' AND lease_owner=$2::uuid AND lease_token=$3::uuid AND lease_until>clock_timestamp()`,
    [id, this.owner, token, this.leaseMs])
    if (result.rowCount !== 1) throw new IngressLeaseLostError()
  }
  async finish(id, token, status, error, delayMs) {
    if (!['processed', 'retry', 'permanent'].includes(status)) throw Error('Invalid completion state')
    const result = await this.pool.query(`UPDATE rtk_ingress SET status=$4,
      processed_at=CASE WHEN $4='processed' THEN clock_timestamp() ELSE processed_at END,
      next_attempt_at=CASE WHEN $4='retry' THEN clock_timestamp()+$6::double precision*interval '1 millisecond' ELSE NULL END,
      last_error=$5, updated_at=clock_timestamp(), lease_owner=NULL,lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND status='processing' AND lease_owner=$2::uuid AND lease_token=$3::uuid AND lease_until>clock_timestamp()`,
    [id, this.owner, token, status, status === 'processed' ? null : String(error || '').slice(0, 4000), Math.max(1000, Number(delayMs) || 1000)])
    if (result.rowCount !== 1) throw new IngressLeaseLostError()
  }
  markProcessed(id, token) { return this.finish(id, token, 'processed') }
  markRetry(id, error, delayMs, token) { return this.finish(id, token, 'retry', error, delayMs) }
  markPermanent(id, error, token) { return this.finish(id, token, 'permanent', error) }
  async cleanup() {
    return (await this.pool.query("DELETE FROM rtk_ingress WHERE status='processed' AND processed_at < clock_timestamp()-$1::int*interval '1 day'", [RETENTION_DAYS])).rowCount
  }
  async stats() {
    const counts = Object.fromEntries((await this.pool.query('SELECT status,count(*)::int AS n FROM rtk_ingress GROUP BY status')).rows.map(row => [row.status, row.n]))
    const oldest = (await this.pool.query("SELECT received_at FROM rtk_ingress WHERE status IN ('pending','retry','processing') ORDER BY id LIMIT 1")).rows[0]
    const lastError = decode((await this.pool.query('SELECT id,status,attempts,last_error,updated_at FROM rtk_ingress WHERE last_error IS NOT NULL ORDER BY updated_at DESC,id DESC LIMIT 1')).rows[0])
    return { databasePath: 'postgresql:rtk_ingress', pending: counts.pending || 0, retry: counts.retry || 0,
      processing: counts.processing || 0, processed: counts.processed || 0, permanent: counts.permanent || 0,
      oldestPendingAgeSeconds: oldest ? Math.max(0, Math.round((Date.now() - new Date(oldest.received_at).getTime()) / 1000)) : null, lastError }
  }
  close() {} // Pool lifetime belongs to the application.
}

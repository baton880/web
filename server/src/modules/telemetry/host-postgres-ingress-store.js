import { createHash, randomUUID } from 'node:crypto'
import { farmDateRange, getFarmDateString } from '../../utils/farm-date.js'
import { IngressLeaseLostError } from './rtk-postgres-ingress-store.js'
const FENCE = 'replay_catchup_through_id',
  MODE = 'replay_catchup_mode',
  ACTIVE = 'calculated_replay_active',
  HIGH = 'processed_high_water_timestamp'
const isoNow = () => new Date().toISOString()
function number(value) {
  if (value == null) return null
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw Error('HOST integer exceeds numeric API range')
  return n
}
function decode(row) {
  if (!row) return null
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v instanceof Date
        ? v.toISOString()
        : ['id', 'packet_id', 'version'].includes(k)
          ? number(v)
          : v,
    ]),
  )
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function accepted(row, withLive = true) {
  if (!row) return null
  try {
    return {
      inboxId: row.id,
      deviceId: row.device_id,
      streamId: row.stream_id,
      packetId: row.packet_id,
      ...(withLive ? { isLive: Boolean(row.is_live) } : {}),
      payload: JSON.parse(row.raw_body),
      receivedAt: row.received_at,
      status: row.status,
    }
  } catch {
    return null
  }
}
function dirty(row) {
  return row
    ? {
        farmDay: row.farm_day,
        dirtyFrom: row.dirty_from,
        dirtyTo: row.dirty_to,
        sources: row.sources.split(',').filter(Boolean),
        version: row.version,
        updatedAt: row.updated_at,
      }
    : null
}

// Short state transactions serialize per database, preserving
// SQLite's atomic live-demotion and replay fence semantics across API processes.
// This does not authorize parallel business-calculation workers.
export class PostgresHostIngressStore {
  constructor(
    pool,
    {
      owner = randomUUID(),
      leaseMs = 60000,
      inTransaction = false,
      replayBoundaryMaxWaitMs = Number(process.env.HOST_REPLAY_BOUNDARY_MAX_WAIT_MS) || 1800000,
    } = {},
  ) {
    this.pool = pool
    this.owner = owner
    this.leaseMs = Math.max(1000, Number(leaseMs) || 60000)
    this.inTransaction = inTransaction
    this.replayBoundaryMaxWaitMs = Math.max(60000, replayBoundaryMaxWaitMs)
  }
  async rows(sql, args = []) {
    return (await this.pool.query(sql, args)).rows.map(decode)
  }
  async one(sql, args = []) {
    return (await this.rows(sql, args))[0] || null
  }
  async tx(action, deviceIds = null) {
    if (this.inTransaction) return action(this)
    const client = await this.pool.connect()
    try {
      // Ingestion for different machines may commit concurrently. Shared state
      // lock still excludes replay/claim transitions; the device lock preserves
      // live demotion and duplicate ordering within each machine.
      await client.query(deviceIds
        ? "BEGIN; SELECT pg_advisory_xact_lock_shared(hashtextextended('host-ingress-state',0))"
        : "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('host-ingress-state',0))")
      for (const id of [...new Set(deviceIds || [])].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('host-ingress-device:' || $1,0))", [String(id || '')])
      }
      const store = new PostgresHostIngressStore(client, {
        owner: this.owner,
        leaseMs: this.leaseMs,
        inTransaction: true,
        replayBoundaryMaxWaitMs: this.replayBoundaryMaxWaitMs,
      })
      const result = await action(store)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
  async getMetaValue(key) {
    return (
      (await this.one('SELECT value FROM host_ingress_meta WHERE key=$1', [String(key)]))?.value ??
      null
    )
  }
  async setMetaValue(key, value, at = isoNow()) {
    if (!this.inTransaction) return this.tx((store) => store.setMetaValue(key, value, at))
    await this.pool.query(
      'INSERT INTO host_ingress_meta(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
      [String(key), String(value), at],
    )
  }
  async deleteMetaValue(key) {
    if (!this.inTransaction) return this.tx((store) => store.deleteMetaValue(key))
    return (await this.pool.query('DELETE FROM host_ingress_meta WHERE key=$1', [String(key)]))
      .rowCount
  }
  async maxUnprocessedIngressId() {
    return number(
      (
        await this.one(
          "SELECT max(id) AS n FROM host_ingress WHERE status IN ('pending','retry','processing')",
        )
      )?.n,
    )
  }
  async replayDrainThroughId() {
    const n = Number(await this.getMetaValue(FENCE))
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  replayCatchupMode() {
    return this.getMetaValue(MODE)
  }
  processedHighWaterTimestamp() {
    return this.getMetaValue(HIGH)
  }
  async noteProcessedTimestamp(timestamp, at = isoNow()) {
    return this.tx(async (s) => {
      const old = await s.processedHighWaterTimestamp(),
        ms = new Date(timestamp).getTime()
      if (!Number.isFinite(ms)) return old
      if (!old || ms > new Date(old).getTime()) {
        const next = new Date(ms).toISOString()
        await s.setMetaValue(HIGH, next, at)
        return next
      }
      return old
    })
  }
  async beginReplayDrain(at = isoNow()) {
    return this.tx(async (s) => {
      const fence =
        Math.max((await s.replayDrainThroughId()) || 0, (await s.maxUnprocessedIngressId()) || 0) ||
        null
      if (fence) {
        await s.setMetaValue(FENCE, fence, at)
        if ((await s.replayCatchupMode()) !== 'post-replay')
          await s.setMetaValue(MODE, 'pre-replay', at)
      }
      return fence
    })
  }
  async recoverInterruptedReplay() {
    return this.tx(async (s) => {
      if (!(await s.getMetaValue(ACTIVE))) return false
      await s.finishCalculatedReplay()
      return true
    })
  }
  async enqueueEntries(entries, receivedAt) {
    return this.tx(async (s) => {
      const liveKeys = new Set()
      for (const entry of entries.filter((e) => e.isLive)) {
        const previous = number(
          (
            await s.one(
              'SELECT max(packet_id) AS n FROM host_ingress WHERE device_id=$1 AND stream_id=$2',
              [entry.deviceId, entry.streamId],
            )
          )?.n,
        )
        if (previous == null || entry.packetId >= previous) {
          await s.pool.query(
            "UPDATE host_ingress SET is_live=0,updated_at=clock_timestamp() WHERE device_id=$1 AND status IN ('pending','retry') AND is_live=1",
            [entry.deviceId],
          )
          liveKeys.add(entry.dedupeKey)
        }
      }
      for (const entry of entries)
        await s.pool.query(
          `INSERT INTO host_ingress(dedupe_key,device_id,stream_id,packet_id,is_live,raw_body,received_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO UPDATE SET is_live=excluded.is_live,updated_at=clock_timestamp()`,
          [
            entry.dedupeKey,
            entry.deviceId || null,
            entry.streamId || null,
            Number.isInteger(entry.packetId) ? entry.packetId : null,
            entry.isLive && liveKeys.has(entry.dedupeKey) ? 1 : 0,
            JSON.stringify(entry.payload),
            receivedAt,
          ],
        )
    }, entries.map(entry => entry.deviceId || ''))
  }
  async enqueueLegacy(payload, receivedAt = new Date()) {
    const dedupeKey = `legacy:${createHash('sha256').update(canonical(payload)).digest('hex')}`
    return this.tx(async (s) => {
      const duplicate = Boolean(await s.getByDedupeKey(dedupeKey))
      await s.enqueueEntries(
        [
          {
            dedupeKey,
            deviceId: payload?.device_id || payload?.deviceId || null,
            streamId: dedupeKey,
            packetId: 0,
            payload,
            isLive: true,
          },
        ],
        new Date(receivedAt).toISOString(),
      )
      return { receiptId: dedupeKey, duplicate }
    }, [payload?.device_id || payload?.deviceId || ''])
  }
  async enqueueBatch({ deviceId, streamId, livePacketId, packets }, receivedAt = new Date()) {
    const entries = packets.map(({ packetId, payload }) => ({
      dedupeKey: `v1:${deviceId}:${streamId}:${packetId}`,
      deviceId,
      streamId,
      packetId,
      payload,
      isLive: packetId === livePacketId,
    }))
    await this.enqueueEntries(entries, new Date(receivedAt).toISOString())
    return {
      receiptId: createHash('sha256')
        .update(entries.map((e) => e.dedupeKey).join('|'))
        .digest('hex'),
      ackedPacketIds: entries.map((e) => e.packetId),
    }
  }
  getByDedupeKey(key) {
    return this.one('SELECT * FROM host_ingress WHERE dedupe_key=$1', [key])
  }
  async latestAccepted(deviceId = null) {
    return accepted(
      await this.one(
        `SELECT * FROM host_ingress WHERE is_live=1 ${deviceId ? 'AND device_id=$1' : ''} ORDER BY id DESC LIMIT 1`,
        deviceId ? [deviceId] : [],
      ),
      false,
    )
  }
  async recent(limit, deviceId, liveOnly) {
    const take = Math.trunc(
      Math.min(liveOnly ? 100 : 500, Math.max(1, Number(limit) || (liveOnly ? 40 : 20))),
    )
    const rows = await this.rows(
      `SELECT * FROM host_ingress WHERE status<>'permanent' ${liveOnly ? 'AND is_live=1' : ''} ${deviceId ? 'AND device_id=$2' : ''} ORDER BY id DESC LIMIT $1`,
      deviceId ? [take, deviceId] : [take],
    )
    return rows.map((r) => accepted(r)).filter(Boolean)
  }
  recentLiveAccepted(limit = 40, deviceId = null) {
    return this.recent(limit, deviceId, true)
  }
  recentAccepted(limit = 20, deviceId = null) {
    return this.recent(limit, deviceId, false)
  }
  async claimNext() {
    return this.tx(async (s) => {
      const meta = new Map((await s.rows('SELECT key,value FROM host_ingress_meta WHERE key=ANY($1::text[])', [[FENCE,MODE]])).map(r=>[r.key,r.value]))
      const numberFence = Number(meta.get(FENCE))
      const fence = Number.isSafeInteger(numberFence) && numberFence > 0 ? numberFence : null
      const mode = meta.get(MODE)
      const ready = "status IN ('pending','retry','processing') AND ((status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp())) OR (status='processing' AND lease_until<=clock_timestamp()))"
      const order = fence ? 'id' : 'is_live DESC,CASE WHEN is_live=1 THEN id END DESC,id ASC'
      const row = await s.one(`WITH candidate AS (
        SELECT id FROM host_ingress WHERE ${ready} ${fence ? 'AND id<=$4' : ''}
        ORDER BY ${order} LIMIT 1 FOR UPDATE
      ) UPDATE host_ingress AS q SET status='processing',attempts=q.attempts+1,
        lease_owner=$1::uuid,lease_token=$2::uuid,
        lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',updated_at=clock_timestamp()
        FROM candidate WHERE q.id=candidate.id RETURNING q.*`,
        fence ? [s.owner,randomUUID(),s.leaseMs,fence] : [s.owner,randomUUID(),s.leaseMs])
      if (row || !fence) return row
      if (await s.one("SELECT id FROM host_ingress WHERE id<=$1 AND status IN ('pending','retry','processing') LIMIT 1", [fence])) return null
      if (mode === 'post-replay') {
        const expanded = await s.maxUnprocessedIngressId()
        if (expanded && expanded > fence) { await s.setMetaValue(FENCE, expanded); return null }
      }
      await s.deleteMetaValue(FENCE)
      await s.deleteMetaValue(MODE)
      return null
    })
  }
  async renewLease(id, token) {
    const result = await this.pool.query(
      `UPDATE host_ingress SET lease_until=clock_timestamp()+$4::double precision*interval '1 millisecond',updated_at=clock_timestamp()
   WHERE id=$1 AND status='processing' AND lease_owner=$2::uuid AND lease_token=$3::uuid AND lease_until>clock_timestamp()`,
      [id, this.owner, token, this.leaseMs],
    )
    if (result.rowCount !== 1) throw new IngressLeaseLostError()
  }
  async finish(id, token, status, error, delayMs) {
    if (!['processed', 'retry', 'permanent'].includes(status))
      throw Error('Invalid completion state')
    const result = await this.pool.query(
      `UPDATE host_ingress SET status=$4,processed_at=CASE WHEN $4='processed' THEN clock_timestamp() ELSE processed_at END,
   next_attempt_at=CASE WHEN $4='retry' THEN clock_timestamp()+$6::double precision*interval '1 millisecond' ELSE NULL END,
   last_error=$5,updated_at=clock_timestamp(),lease_owner=NULL,lease_token=NULL,lease_until=NULL
   WHERE id=$1 AND status='processing' AND lease_owner=$2::uuid AND lease_token=$3::uuid AND lease_until>clock_timestamp()`,
      [
        id,
        this.owner,
        token,
        status,
        status === 'processed' ? null : String(error || '').slice(0, 4000),
        Math.max(1000, Number(delayMs) || 1000),
      ],
    )
    if (result.rowCount !== 1) throw new IngressLeaseLostError()
  }
  markProcessed(id, token) {
    return this.finish(id, token, 'processed')
  }
  async completeProcessed(row, result) {
    return this.tx(async (store) => {
      if (!result?.outOfOrder) {
        const ms = new Date(result?.timestamp).getTime()
        const timestamp = result?.timestamp && Number.isFinite(ms) ? new Date(ms).toISOString() : null
        const completed = await store.one(`WITH finished AS (
          UPDATE host_ingress SET status='processed',processed_at=clock_timestamp(),updated_at=clock_timestamp(),
            next_attempt_at=NULL,last_error=NULL,lease_owner=NULL,lease_token=NULL,lease_until=NULL
          WHERE id=$1 AND status='processing' AND lease_owner=$2::uuid AND lease_token=$3::uuid AND lease_until>clock_timestamp()
          RETURNING id
        ), high_water AS (
          INSERT INTO host_ingress_meta(key,value,updated_at)
          SELECT $5,$4,clock_timestamp() WHERE $4::text IS NOT NULL AND EXISTS(SELECT 1 FROM finished)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
          WHERE host_ingress_meta.value::timestamptz < excluded.value::timestamptz
          RETURNING key
        ) SELECT id FROM finished`, [row.id,store.owner,row.lease_token,timestamp,HIGH])
        if (!completed) throw new IngressLeaseLostError()
        return
      }
      const owned = await store.one(
        `SELECT id FROM host_ingress WHERE id=$1 AND status='processing'
        AND lease_owner=$2::uuid AND lease_token=$3::uuid AND lease_until>clock_timestamp() FOR UPDATE`,
        [row.id, store.owner, row.lease_token],
      )
      if (!owned) throw new IngressLeaseLostError()
      if (result?.timestamp) await store.noteProcessedTimestamp(result.timestamp)
      if (result?.outOfOrder && result?.timestamp) {
        await store.markHistoryDirty(result.timestamp)
        await store.beginReplayDrain()
      }
      await store.markProcessed(row.id, row.lease_token)
    })
  }
  markRetry(id, error, delayMs, token) {
    return this.finish(id, token, 'retry', error, delayMs)
  }
  markPermanent(id, error, token) {
    return this.finish(id, token, 'permanent', error)
  }
  async isReplayWindowReady(range, nowMs = Date.now()) {
    const d = range === undefined ? await this.nextReplayDirty() : range
    if (!d) return true
    const high = new Date((await this.processedHighWaterTimestamp()) || 0).getTime(),
      end = new Date(d.dirtyTo).getTime()
    if (Number.isFinite(high) && Number.isFinite(end) && high >= end + 600000) return true
    const updated = new Date(d.updatedAt || 0).getTime()
    return Number.isFinite(updated) && nowMs - updated >= this.replayBoundaryMaxWaitMs
  }
  markHistoryDirty(timestamp) {
    return this.markReplayDirtyRange(timestamp, timestamp, 'host')
  }
  async markReplayDirtyRange(from, to = from, source = 'host') {
    const a = new Date(from).getTime(),
      b = new Date(to).getTime()
    if (!Number.isFinite(a) || !Number.isFinite(b))
      throw new TypeError('Replay dirty range requires valid timestamps')
    const start = Math.min(a, b) - 600000,
      end = Math.max(a, b) + 600000
    const days = [],
      last = getFarmDateString(new Date(end))
    let day = getFarmDateString(new Date(start))
    while (day) {
      days.push(day)
      if (day === last) break
      const range = farmDateRange(day)
      if (!range) break
      day = getFarmDateString(new Date(range.end.getTime() + 1))
    }
    const normalized = String(source || 'unknown').trim() || 'unknown'
    return this.tx(async (s) => {
      const updated = []
      for (const farmDay of days) {
        const range = farmDateRange(farmDay)
        if (!range) continue
        const clippedFrom = new Date(Math.max(start, range.start.getTime())).toISOString(),
          clippedTo = new Date(Math.min(end, range.end.getTime())).toISOString()
        if (clippedFrom > clippedTo) continue
        const old = await s.one('SELECT * FROM calculated_replay_dirty WHERE farm_day=$1', [
          farmDay,
        ])
        const sources = new Set(
          String(old?.sources || '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        )
        sources.add(normalized)
        const row = await s.one(
          `INSERT INTO calculated_replay_dirty(farm_day,dirty_from,dirty_to,sources,version)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(farm_day) DO UPDATE SET dirty_from=excluded.dirty_from,dirty_to=excluded.dirty_to,
     sources=excluded.sources,version=excluded.version,updated_at=clock_timestamp() RETURNING *`,
          [
            farmDay,
            old && old.dirty_from < clippedFrom ? old.dirty_from : clippedFrom,
            old && old.dirty_to > clippedTo ? old.dirty_to : clippedTo,
            [...sources].sort().join(','),
            (old?.version || 0) + 1,
          ],
        )
        updated.push(dirty(row))
      }
      await s.refreshHistoryDirty()
      return updated
    })
  }
  async refreshHistoryDirty() {
    const first = await this.one(
      'SELECT dirty_from FROM calculated_replay_dirty ORDER BY dirty_from LIMIT 1',
    )
    if (first) await this.setMetaValue('history_dirty_from', first.dirty_from)
    else await this.deleteMetaValue('history_dirty_from')
  }
  async nextReplayDirty() {
    return dirty(
      await this.one('SELECT * FROM calculated_replay_dirty ORDER BY dirty_from,farm_day LIMIT 1'),
    )
  }
  async listReplayDirty(limit = 31) {
    return (
      await this.rows(
        'SELECT * FROM calculated_replay_dirty ORDER BY dirty_from,farm_day LIMIT $1',
        [Math.trunc(Math.min(366, Math.max(1, Number(limit) || 31)))],
      )
    ).map(dirty)
  }
  async clearReplayDirty(farmDay, throughVersion = Number.MAX_SAFE_INTEGER) {
    return this.tx(async (s) => {
      const r = await s.pool.query(
        'DELETE FROM calculated_replay_dirty WHERE farm_day=$1 AND version<=$2',
        [String(farmDay), throughVersion],
      )
      await s.refreshHistoryDirty()
      return r.rowCount
    })
  }
  async clearHistoryDirty() {
    return this.tx(async (s) => {
      const r = await s.pool.query('DELETE FROM calculated_replay_dirty')
      return r.rowCount + (await s.deleteMetaValue('history_dirty_from'))
    })
  }
  async beginCalculatedReplay(meta = {}) {
    return this.tx((s) =>
      s.setMetaValue(
        ACTIVE,
        JSON.stringify({
          startedAt: isoNow(),
          farmDay: meta?.farmDay || null,
          version: Number(meta?.version || meta?.dirtyVersion) || null,
        }),
      ),
    )
  }
  async finishCalculatedReplay({
    clearHistoryDirty = false,
    farmDay = null,
    throughVersion = null,
  } = {}) {
    return this.tx(async (s) => {
      const max = await s.maxUnprocessedIngressId()
      if (max) {
        await s.setMetaValue(FENCE, max)
        await s.setMetaValue(MODE, 'post-replay')
      } else {
        await s.deleteMetaValue(FENCE)
        await s.deleteMetaValue(MODE)
      }
      await s.deleteMetaValue(ACTIVE)
      const cleared = clearHistoryDirty
        ? farmDay
          ? await s.clearReplayDirty(farmDay, throughVersion ?? Number.MAX_SAFE_INTEGER)
          : await s.clearHistoryDirty()
        : 0
      return { catchupThroughId: max, clearedHistoryDirty: cleared }
    })
  }
  async stats() {
    const counts = Object.fromEntries(
      (await this.rows('SELECT status,count(*)::int AS n FROM host_ingress GROUP BY status')).map(
        (r) => [r.status, r.n],
      ),
    )
    const ready = await this.one(
      "SELECT count(*) FILTER(WHERE is_live=1)::int AS live,count(*) FILTER(WHERE is_live=0)::int AS history FROM host_ingress WHERE status IN ('pending','retry','processing')",
    )
    const oldest = await this.one(
      "SELECT received_at FROM host_ingress WHERE status IN ('pending','retry','processing') ORDER BY id LIMIT 1",
    )
    const newest = await this.one(
      "SELECT received_at FROM host_ingress WHERE status IN ('pending','retry','processing') AND is_live=1 ORDER BY id DESC LIMIT 1",
    )
    const lastError = await this.one(
      'SELECT id,status,attempts,last_error,updated_at FROM host_ingress WHERE last_error IS NOT NULL ORDER BY updated_at DESC,id DESC LIMIT 1',
    )
    const d = await this.nextReplayDirty(),
      days = (await this.one('SELECT count(*)::int AS n FROM calculated_replay_dirty')).n
    const age = (row) =>
      row
        ? Math.max(0, Math.round((Date.now() - new Date(row.received_at).getTime()) / 1000))
        : null
    return {
      databasePath: 'postgresql:host_ingress',
      pending: counts.pending || 0,
      retry: counts.retry || 0,
      processing: counts.processing || 0,
      processed: counts.processed || 0,
      permanent: counts.permanent || 0,
      pendingLive: ready.live,
      pendingHistory: ready.history,
      oldestPendingAgeSeconds: age(oldest),
      newestLiveAgeSeconds: age(newest),
      historyDirtyFrom: await this.getMetaValue('history_dirty_from'),
      replayDirty: d,
      replayDirtyDayCount: days,
      catchupThroughId: await this.replayDrainThroughId(),
      catchupMode: await this.replayCatchupMode(),
      processedHighWaterTimestamp: await this.processedHighWaterTimestamp(),
      replayWindowReady: await this.isReplayWindowReady(d),
      lastError,
    }
  }
  async cleanup() {
    return (
      await this.pool.query(
        "DELETE FROM host_ingress WHERE status='processed' AND processed_at<clock_timestamp()-interval '7 days'",
      )
    ).rowCount
  }
  close() {}
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HostIngressStore } from '../src/modules/telemetry/host-ingress-store.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-ingress-'))
const databasePath = path.join(tempDir, 'inbox.sqlite3')

try {
  let store = new HostIngressStore(databasePath)
  const envelope = {
    deviceId: 'Hozain_01',
    streamId: 'stream-test',
    livePacketId: 3,
    packets: [
      { packetId: 1, payload: { timestamp: '2026-07-17T10:00:00Z' } },
      { packetId: 2, payload: { timestamp: '2026-07-17T10:00:01Z' } },
      { packetId: 3, payload: { timestamp: '2026-07-17T10:00:02Z' } }
    ]
  }
  const accepted = store.enqueueBatch(envelope)
  assert.deepEqual(accepted.ackedPacketIds, [1, 2, 3])
  store.enqueueBatch(envelope)
  assert.equal(store.stats().pending, 3, 'repeated batch must not duplicate rows')

  const live = store.claimNext()
  assert.equal(live.packet_id, 3, 'live packet must be processed before backlog')
  store.markProcessed(live.id)
  const oldest = store.claimNext()
  assert.equal(oldest.packet_id, 1)
  store.markHistoryDirty('2026-07-17T10:00:00Z')
  store.markHistoryDirty('2026-07-17T10:00:01Z')
  assert.equal(store.stats().historyDirtyFrom, '2026-07-17T10:00:00.000Z')
  store.markRetry(oldest.id, 'database busy', 1000)
  const legacy = { device_id: 'Hozain_01', timestamp: '2026-07-17T10:00:03Z' }
  assert.equal(store.enqueueLegacy(legacy).duplicate, false)
  assert.equal(store.enqueueLegacy({ timestamp: '2026-07-17T10:00:03Z', device_id: 'Hozain_01' }).duplicate, true)
  const legacyRow = store.db.prepare(`SELECT stream_id, packet_id FROM host_ingress WHERE dedupe_key LIKE 'legacy:%'`).get()
  assert.match(legacyRow.stream_id, /^legacy:/)
  assert.equal(legacyRow.packet_id, 0)
  store.close()

  store = new HostIngressStore(databasePath)
  assert.equal(store.stats().retry, 1)
  store.close()
  console.log('Host ingress store test passed')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

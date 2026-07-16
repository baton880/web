import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RtkIngressStore } from '../src/modules/telemetry/rtk-ingress-store.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-ingress-'))
const databasePath = path.join(tempDir, 'inbox.sqlite3')

try {
  let store = new RtkIngressStore(databasePath)
  const first = store.enqueue('{"deviceId":"test","timestamp":"2026-07-15T00:00:00Z"}')
  const duplicate = store.enqueue('{"deviceId":"test","timestamp":"2026-07-15T00:00:00Z"}')
  assert.equal(first.inserted, true)
  assert.equal(duplicate.inserted, false)
  store.close()

  store = new RtkIngressStore(databasePath)
  const claimed = store.claimNext()
  assert.equal(claimed.id, first.row.id)
  assert.equal(claimed.status, 'processing')
  store.markRetry(claimed.id, 'database busy', 1000)
  assert.equal(store.stats().retry, 1)
  store.db.prepare("UPDATE rtk_ingress SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run()
  const retried = store.claimNext()
  assert.equal(retried.attempts, 2)
  store.markProcessed(retried.id)
  assert.equal(store.stats().processed, 1)

  const malformed = store.enqueue('{broken')
  const malformedRow = store.claimNext()
  assert.equal(malformedRow.id, malformed.row.id)
  store.markPermanent(malformedRow.id, 'malformed JSON')
  assert.equal(store.stats().permanent, 1)
  store.close()
  console.log('RTK ingress store test passed')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

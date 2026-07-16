import fs from 'node:fs'
import path from 'node:path'
import { RtkIngressStore } from '../src/modules/telemetry/rtk-ingress-store.js'

function argument(name) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null
}

const sourcePath = path.resolve(argument('file') || 'runtime/rtk-ingest-dead-letter.jsonl')
const inboxPath = path.resolve(argument('inbox') || 'runtime/rtk-ingress.sqlite3')
const apply = process.argv.includes('--apply')

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Dead-letter file not found: ${sourcePath}`)
}

const candidates = []
let unreadable = 0
let truncated = 0

for (const line of fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  try {
    const entry = JSON.parse(line)
    if (entry.payloadTruncated) {
      truncated += 1
      continue
    }
    if (typeof entry.payload !== 'string' || !entry.payload.trim()) continue
    candidates.push({ rawBody: entry.payload, receivedAt: entry.receivedAt || entry.failedAt })
  } catch (error) {
    unreadable += 1
  }
}

let inserted = 0
let duplicates = 0
if (apply) {
  const store = new RtkIngressStore(inboxPath)
  try {
    for (const candidate of candidates) {
      const result = store.enqueue(candidate.rawBody, new Date(candidate.receivedAt))
      if (result.inserted) inserted += 1
      else duplicates += 1
    }
  } finally {
    store.close()
  }
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  sourcePath,
  inboxPath,
  candidates: candidates.length,
  inserted,
  duplicates,
  truncated,
  unreadable
}, null, 2))

if (!apply) {
  console.log('Dry-run only. Add --apply to enqueue these payloads.')
}

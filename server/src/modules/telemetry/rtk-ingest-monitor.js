import { createReadStream } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SERVER_ROOT = path.resolve(__dirname, '../../..')
const DEAD_LETTER_FILE = path.resolve(
  process.env.RTK_INGEST_DEAD_LETTER_FILE || path.join(SERVER_ROOT, 'runtime', 'rtk-ingest-dead-letter.jsonl')
)
const MAX_STORED_PAYLOAD_CHARS = 1024 * 1024
const startedAt = new Date()

const runtime = {
  acknowledgedRequests: 0,
  acknowledgedPackets: 0,
  storedPackets: 0,
  rejectedPackets: 0,
  processingFailedRequests: 0,
  processingFailedPackets: 0,
  malformedRequests: 0,
  deadLetterWriteFailures: 0,
  lastFailureAt: null,
  lastFailureType: null,
  lastFailureMessage: null
}

function extractPayloads(body) {
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.packets)) return body.packets
  if (Array.isArray(body?.items)) return body.items
  if (Array.isArray(body?.data)) return body.data
  return [body || {}]
}

function packetCount(body) {
  return Math.max(1, extractPayloads(body).length)
}

function serializePayload(payload) {
  let serialized
  try {
    serialized = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch (error) {
    serialized = String(payload)
  }

  if (serialized.length <= MAX_STORED_PAYLOAD_CHARS) {
    return { value: serialized, truncated: false }
  }

  return {
    value: serialized.slice(0, MAX_STORED_PAYLOAD_CHARS),
    truncated: true
  }
}

function noteFailure(type, message) {
  runtime.lastFailureAt = new Date().toISOString()
  runtime.lastFailureType = type
  runtime.lastFailureMessage = String(message || '').slice(0, 1000) || null
}

async function appendDeadLetter(entry) {
  try {
    await mkdir(path.dirname(DEAD_LETTER_FILE), { recursive: true })
    await appendFile(DEAD_LETTER_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
    return true
  } catch (error) {
    runtime.deadLetterWriteFailures += 1
    noteFailure('dead_letter_write_error', error?.message || error)
    console.error('[RTK ingest monitor] Failed to append dead letter:', error)
    return false
  }
}

function buildDeadLetter(type, body, details = {}) {
  const payload = serializePayload(body)
  return {
    version: 1,
    type,
    failedAt: new Date().toISOString(),
    receivedAt: details.receivedAt instanceof Date
      ? details.receivedAt.toISOString()
      : (details.receivedAt || null),
    packetCount: Number(details.packetCount) || packetCount(body),
    error: details.error ? String(details.error).slice(0, 4000) : null,
    validationErrors: Array.isArray(details.validationErrors) ? details.validationErrors : [],
    payload: payload.value,
    payloadTruncated: payload.truncated
  }
}

export function noteRtkRequestAcknowledged(body) {
  runtime.acknowledgedRequests += 1
  runtime.acknowledgedPackets += packetCount(body)
}

export async function recordRtkIngestResult(body, result, receivedAt) {
  runtime.storedPackets += Number(result?.accepted) || 0

  const rejected = Number(result?.dropped) || 0
  if (rejected <= 0) return

  runtime.rejectedPackets += rejected
  noteFailure('validation_rejected', `${rejected} RTK packet(s) rejected by validation`)
  await appendDeadLetter(buildDeadLetter('validation_rejected', body, {
    receivedAt,
    packetCount: rejected,
    validationErrors: result?.validationErrors
  }))
}

export async function recordRtkIngestFailure(body, error, receivedAt) {
  const failedPackets = packetCount(body)
  runtime.processingFailedRequests += 1
  runtime.processingFailedPackets += failedPackets
  noteFailure('processing_error', error?.message || error)
  await appendDeadLetter(buildDeadLetter('processing_error', body, {
    receivedAt,
    packetCount: failedPackets,
    error: error?.stack || error?.message || error
  }))
}

export async function recordRtkMalformedRequest(rawBody, error, receivedAt = new Date()) {
  runtime.acknowledgedRequests += 1
  runtime.acknowledgedPackets += 1
  runtime.malformedRequests += 1
  runtime.rejectedPackets += 1
  noteFailure('malformed_json', error?.message || error)
  await appendDeadLetter(buildDeadLetter('malformed_json', rawBody || '', {
    receivedAt,
    packetCount: 1,
    error: error?.stack || error?.message || error
  }))
}

async function summarizeDeadLetters() {
  const summary = {
    events: 0,
    packets: 0,
    processingErrors: 0,
    validationRejected: 0,
    malformedJson: 0,
    unreadableLines: 0
  }

  try {
    const input = createReadStream(DEAD_LETTER_FILE, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })

    for await (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        summary.events += 1
        summary.packets += Number(entry.packetCount) || 0
        if (entry.type === 'processing_error') summary.processingErrors += 1
        if (entry.type === 'validation_rejected') summary.validationRejected += 1
        if (entry.type === 'malformed_json') summary.malformedJson += 1
      } catch (error) {
        summary.unreadableLines += 1
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  return summary
}

export async function getRtkIngestStatus() {
  const notStoredPackets = runtime.rejectedPackets + runtime.processingFailedPackets
  const finalizedPackets = runtime.storedPackets + notStoredPackets

  return {
    responsePolicy: 'always_201_immediate',
    runtime: {
      since: startedAt.toISOString(),
      ...runtime,
      notStoredPackets,
      inFlightPackets: Math.max(0, runtime.acknowledgedPackets - finalizedPackets)
    },
    persistedDeadLetters: await summarizeDeadLetters()
  }
}

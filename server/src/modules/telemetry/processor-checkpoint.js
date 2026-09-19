import { serialize, deserialize } from 'node:v8'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import telemetryProcessor from '../../../../module-3/telemetryProcessor.js'
import { usePostgresIngress } from './ingress-postgres-pool.js'
export const unloadGroupEvidenceByBatch = new Map()
export const lastBarnPositionByDevice = new Map()
const KEY = 'processor-checkpoint:v1'
let loaded
export function captureProcessorState() {
  return serialize({ version: 1, processor: telemetryProcessor.exportStates(), unloadEvidence: [...unloadGroupEvidenceByBatch], barnPositions: [...lastBarnPositionByDevice] }).toString('base64')
}
export function restoreProcessorState(value) {
  const bytes = value.startsWith('z1:') ? inflateRawSync(Buffer.from(value.slice(3), 'base64'), { maxOutputLength: 32 * 1024 * 1024 }) : Buffer.from(value, 'base64')
  const snapshot = deserialize(bytes)
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.unloadEvidence) || !Array.isArray(snapshot.barnPositions)) throw Error('Unsupported processor checkpoint')
  telemetryProcessor.replaceStates(snapshot.processor)
  unloadGroupEvidenceByBatch.clear(); for (const [key, entry] of snapshot.unloadEvidence) unloadGroupEvidenceByBatch.set(key, entry)
  lastBarnPositionByDevice.clear(); for (const [key, entry] of snapshot.barnPositions) lastBarnPositionByDevice.set(key, entry)
}
export async function reloadProcessorCheckpoint(db, fallback) {
  if (!usePostgresIngress) { if (fallback) restoreProcessorState(fallback); return }
  let row
  try { row = await db.appState.findUnique({ where: { key: KEY } }) }
  catch (error) { loaded = undefined; if (fallback) restoreProcessorState(fallback); throw error }
  if (row) restoreProcessorState(row.value)
  else if (fallback) restoreProcessorState(fallback)
}
export async function ensureProcessorCheckpointLoaded(db) {
  if (!usePostgresIngress) return
  loaded ||= reloadProcessorCheckpoint(db).catch(error => { loaded = undefined; throw error })
  await loaded
}
export async function persistProcessorCheckpoint(db) {
  if (!usePostgresIngress) return
  // Compress the durable copy to limit WAL/write amplification as devices accumulate.
  const value = 'z1:' + deflateRawSync(Buffer.from(captureProcessorState(), 'base64'), { level: 1 }).toString('base64')
  const updatedAt = new Date().toISOString()
  await db.appState.upsert({ where: { key: KEY }, create: { key: KEY, value, updatedAt }, update: { value, updatedAt } })
}

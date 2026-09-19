import '../../load-env.js'
import pg from 'pg'
export const usePostgresIngress = process.env.INGRESS_BACKEND === 'postgres'
if (process.env.INGRESS_BACKEND && !['postgres', 'sqlite'].includes(process.env.INGRESS_BACKEND)) throw Error('Unsupported INGRESS_BACKEND')
let pool
export function getIngressPool() {
  if (!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL || '')) throw Error('PostgreSQL ingress requires PostgreSQL DATABASE_URL')
  const size = Number(process.env.INGRESS_POOL_SIZE || 10)
  if (!Number.isInteger(size) || size < 2 || size > 20) throw Error('INGRESS_POOL_SIZE must be between 2 and 20')
  pool ||= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: size, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 })
  return pool
}
let ownerConnection
export async function closeIngressPool() {
  if (ownerConnection) { ownerConnection.release(true); ownerConnection = undefined }
  if (pool) { await pool.end(); pool = undefined }
}
export async function acquireCalculationOwner() {
  if (!usePostgresIngress || ownerConnection) return
  const connection = await getIngressPool().connect()
  try {
    const { rows } = await connection.query("SELECT pg_try_advisory_lock(hashtextextended('farm-calculation-owner',0)) AS acquired")
    if (!rows[0].acquired) throw Error('Another calculation/scheduler process already owns this farm')
    ownerConnection = connection
    connection.on('error', () => { console.error('Calculation ownership connection lost; stopping process'); process.exit(1) })
  } catch (error) { connection.release(); throw error }
}

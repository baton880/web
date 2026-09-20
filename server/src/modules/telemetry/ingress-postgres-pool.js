import '../../load-env.js'
import pg from 'pg'
import { inCalculationContext } from '../../calculation-context.js'
export const usePostgresIngress = process.env.INGRESS_BACKEND === 'postgres'
if (process.env.INGRESS_BACKEND && !['postgres', 'sqlite'].includes(process.env.INGRESS_BACKEND)) throw Error('Unsupported INGRESS_BACKEND')
let apiPool, calculationPool
function activePool() {
  if (!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL || '')) throw Error('PostgreSQL ingress requires PostgreSQL DATABASE_URL')
  if (inCalculationContext()) {
    return calculationPool ||= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 })
  }
  const size = Number(process.env.INGRESS_POOL_SIZE || 6)
  if (!Number.isInteger(size) || size < 2 || size > 20) throw Error('INGRESS_POOL_SIZE must be between 2 and 20')
  return apiPool ||= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: size, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 })
}
// Stores keep this facade; each transaction gets a concrete client from the
// calling async context. API reads cannot consume the two worker slots.
const pool = {
  query: (...args) => activePool().query(...args),
  connect: (...args) => activePool().connect(...args)
}
export function getIngressPool() { return pool }
let ownerConnection
export async function closeIngressPool() {
  if (ownerConnection) { ownerConnection.release(true); ownerConnection = undefined }
  await Promise.all([apiPool?.end(), calculationPool?.end()])
  apiPool = calculationPool = undefined
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

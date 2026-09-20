import { PrismaClient, isPostgresDatabase } from './prisma-client.js'
import { inCalculationContext, withCalculationContext } from './calculation-context.js'

// Стандартная инициализация. Prisma сама возьмет DATABASE_URL из .env
const apiClient = new PrismaClient()
let calculationClient
function getCalculationClient() {
  if (!calculationClient) {
    const url = new URL(process.env.DATABASE_URL)
    url.searchParams.set('connection_limit', '4')
    calculationClient = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  }
  return calculationClient
}
// Keep tablet bursts from consuming every connection needed to drain inboxes.
// Async context selects a pool, not another database; transactions stay on the
// selected client and the existing calculation coordinator still serializes FSM.
export function withCalculationDatabase(action) {
  return isPostgresDatabase ? withCalculationContext(action) : action()
}
const prisma = new Proxy(apiClient, {
  get(target, property) {
    if (property === '$disconnect') return async () => {
      await Promise.all([apiClient.$disconnect(), calculationClient?.$disconnect()])
    }
    const client = isPostgresDatabase && inCalculationContext() ? getCalculationClient() : target
    const value = Reflect.get(client, property)
    return typeof value === 'function' ? value.bind(client) : value
  }
})

export const databaseReady = prisma.$connect()
  .then(async () => {
    if (isPostgresDatabase) {
      console.log('Prisma connected to PostgreSQL')
      return
    }
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=10000')
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL')
    await prisma.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
    console.log('✅ Prisma connected to SQLite (WAL, busy_timeout=10000)')
  })
  .catch((error) => {
    console.error('❌ Prisma connection error:', error)
    throw error
  })

export default prisma

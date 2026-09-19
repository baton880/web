import { PrismaClient, isPostgresDatabase } from './prisma-client.js'

// Стандартная инициализация. Prisma сама возьмет DATABASE_URL из .env
const prisma = new PrismaClient()

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

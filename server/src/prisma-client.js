import './load-env.js'

// Both clients are kept during the staged migration so SQLite fixtures and the
// pre-cutover recovery path remain usable. Each process owns exactly one DB.
export const isPostgresDatabase = /^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL || '')
const module = isPostgresDatabase
  ? await import('../generated/postgresql-client/index.js')
  : await import('@prisma/client')
export const PrismaClient = module.PrismaClient || module.default.PrismaClient

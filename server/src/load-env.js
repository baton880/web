import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const envPath = path.resolve(__dirname, '../.env')

function normalizeEnvValue(key, value) {
  if (key === 'DATABASE_URL' && value === 'file:./dev.db') {
    const dbPath = path.resolve(__dirname, '../prisma/dev.db').replace(/\\/g, '/')
    return `file:${dbPath}`
  }

  return value
}

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    let value = trimmed.slice(separatorIndex + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = normalizeEnvValue(key, value)
    }
  }
}

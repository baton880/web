import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const serverRoot = path.resolve(path.dirname(__filename), '..')
const projectTempRoot = path.resolve(serverRoot, '..', '..', 'tmp')
fs.mkdirSync(projectTempRoot, { recursive: true })
const tempDir = fs.mkdtempSync(path.join(projectTempRoot, 'rtk-current-test-'))
const databasePath = path.join(tempDir, 'current.sqlite3')
const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`
const prismaCli = path.join(serverRoot, 'node_modules', 'prisma', 'build', 'index.js')

process.env.DATABASE_URL = databaseUrl
process.env.RTK_INGRESS_DATABASE_PATH = path.join(tempDir, 'rtk-ingress.sqlite3')
process.env.HOST_INGRESS_DATABASE_PATH = path.join(tempDir, 'host-ingress.sqlite3')
process.env.RTK_BUFFER_REPLAY_ENABLED = '0'
process.env.DATA_RETENTION_ENABLED = 'false'

let prisma = null
let rtkStore = null
let hostStore = null

try {
  fs.closeSync(fs.openSync(databasePath, 'w'))
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit'
  })

  const [databaseModule, routesModule, rtkStoreModule, hostStoreModule] = await Promise.all([
    import('../src/database.js'),
    import('../src/modules/telemetry/rtk.routes.js'),
    import('../src/modules/telemetry/rtk-ingress-store.js'),
    import('../src/modules/telemetry/host-ingress-store.js')
  ])
  prisma = databaseModule.default
  rtkStore = rtkStoreModule.getRtkIngressStore()
  hostStore = hostStoreModule.getHostIngressStore()

  rtkStore.enqueue(JSON.stringify({
    device_id: 'loader-current-test',
    timestamp: '2026-07-18T07:00:00Z',
    lat: 52.42,
    lon: 85.70,
    speed: 4.5,
    quality: 4,
    fix_type: 'RTK_FIXED'
  }), new Date('2026-07-18T07:00:01Z'))

  rtkStore.enqueue(JSON.stringify({
    device_id: 'another-loader',
    timestamp: '2026-07-18T07:00:02Z',
    lat: 51.0,
    lon: 84.0,
    speed: 1,
    quality: 4,
    fix_type: 'RTK_FIXED'
  }), new Date('2026-07-18T07:00:03Z'))

  const current = await routesModule.buildLatestResponse('loader-current-test')
  assert.equal(current.id, null)
  assert.equal(current.deviceId, 'loader-current-test')
  assert.equal(current.lat, 52.42)
  assert.equal(current.lon, 85.70)
  assert.equal(current.pipelineStatus, 'accepted')
  assert.equal(current.processed, false)
  assert.equal(current.sdReady, null)

  const compatibilityTestNow = Date.now()
  const newFormatResult = await routesModule.processRtkTelemetryBody({
    device_id: 'loader-sd-ok-test',
    timestamp: new Date(compatibilityTestNow - 2000).toISOString(),
    lat: 52.421,
    lon: 85.701,
    speed: 0,
    quality: 4,
    fix_type: 'RTK_FIXED',
    sd_ok: 0
  }, new Date(compatibilityTestNow - 1000))
  assert.equal(newFormatResult.count, 1)
  const newFormatCurrent = await routesModule.buildLatestResponse('loader-sd-ok-test')
  assert.equal(newFormatCurrent.sdReady, false)

  const oldFormatResult = await routesModule.processRtkTelemetryBody({
    device_id: 'loader-sd-ready-test',
    timestamp: new Date(compatibilityTestNow).toISOString(),
    lat: 52.422,
    lon: 85.702,
    speed: 0,
    quality: 4,
    fix_type: 'RTK_FIXED',
    sd_ready: 1
  }, new Date(compatibilityTestNow + 1000))
  assert.equal(oldFormatResult.count, 1)
  const oldFormatCurrent = await routesModule.buildLatestResponse('loader-sd-ready-test')
  assert.equal(oldFormatCurrent.sdReady, true)
  console.log('RTK ingress current test passed')
} finally {
  try { rtkStore?.close() } catch {}
  try { hostStore?.close() } catch {}
  try { await prisma?.$disconnect() } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true })
}

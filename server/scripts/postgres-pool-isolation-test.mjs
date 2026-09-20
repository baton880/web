import assert from 'node:assert/strict'
const url = new URL(process.env.TEST_POSTGRES_DATABASE_URL || 'postgresql://invalid')
if (!/^\/farm_test_[a-z0-9_]+$/.test(url.pathname)) throw Error('Isolated test database required')
url.searchParams.set('connection_limit', '2')
process.env.DATABASE_URL = url.toString()
process.env.INGRESS_BACKEND = 'postgres'
process.env.INGRESS_POOL_SIZE = '2'
const {default:db,withCalculationDatabase} = await import('../src/database.js')
const {withCalculationContext} = await import('../src/calculation-context.js')
const {getIngressPool,closeIngressPool} = await import('../src/modules/telemetry/ingress-postgres-pool.js')
async function bounded(promise) {
 let timer
 try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Worker starved by API pool')),1500)})]) }
 finally { clearTimeout(timer) }
}
try {
let releaseApi
const held = new Promise(resolve=>{releaseApi=resolve}), apiPids=[]
const busy = Promise.all([1,2].map(()=>db.$transaction(async tx=>{
 apiPids.push((await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid)
 await held
},{timeout:10000})))
try {
 await bounded((async()=>{while(apiPids.length<2)await new Promise(r=>setTimeout(r,10))})())
 const pid = await bounded(withCalculationDatabase(async()=>(await db.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid))
 assert.ok(!apiPids.includes(pid))
} finally { releaseApi();await busy }
assert.ok(apiPids.includes((await db.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid), 'Context must return to API pool')
const pool=getIngressPool(),clients=[await pool.connect(),await pool.connect()]
try {
 const pids=await Promise.all(clients.map(async c=>(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid))
 const pid=await bounded(withCalculationContext(async()=>(await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid))
 assert.ok(!pids.includes(pid))
 console.log('PASS saturated API pools cannot occupy Prisma or inbox worker connections; async context restored')
}finally{for(const client of clients)client.release()}
} finally { await db.$disconnect(); await closeIngressPool() }

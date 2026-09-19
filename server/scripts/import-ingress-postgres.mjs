import fs from 'node:fs'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import Database from 'better-sqlite3'
import pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
const url = process.env.DATABASE_URL
const name = new URL(url).pathname.slice(1)
if (!/^farm_[a-z0-9_]+$/.test(name) || process.env.IMPORT_POSTGRES_CONFIRM !== name) throw Error('Explicit farm database confirmation required')
const paths = [process.env.IMPORT_SQLITE_HOST, process.env.IMPORT_SQLITE_RTK]
if (paths.some(p => !p)) throw Error('Both consistent SQLite inbox snapshots required')
const sources = paths.map(p => new Database(p, { readonly: true, fileMustExist: true }))
const target = new pg.Client({ connectionString: url })
const tables = [['host_ingress',0,'id'],['host_ingress_meta',0,'key'],['calculated_replay_dirty',0,'farm_day'],['rtk_ingress',1,'id']]
const quote = s => '"'+s.replaceAll('"','""')+'"'
const csv = v => v == null ? '\\N' : '"'+String(v).replaceAll('"','""')+'"'
const report = { database:name,startedAt:new Date().toISOString(),tables:[],recoveredProcessing:0,demotedLive:0 }
const latestLive = new Map(sources[0].prepare("SELECT device_id,max(id) AS id FROM host_ingress WHERE is_live=1 AND status IN ('pending','retry','processing') AND device_id IS NOT NULL GROUP BY device_id").all().map(r=>[r.device_id,r.id]))
function normalize(row,table,count=false) {
 const out={...row}
 for (const [key,value] of Object.entries(out)) {
  if (value != null && (value instanceof Date || ['received_at','created_at','updated_at','processed_at','next_attempt_at','dirty_from','dirty_to'].includes(key))) out[key]=new Date(value).toISOString()
  else if (['id','packet_id','version'].includes(key) && value!=null) out[key]=String(value)
 }
 if (out.status==='processing') {
  out.status='retry';out.next_attempt_at=report.startedAt;out.updated_at=report.startedAt
  out.last_error ||= 'worker interrupted during inbox migration'
  if(count)report.recoveredProcessing++
 }
 if (table==='host_ingress' && out.is_live===1 && ['pending','retry'].includes(out.status) && out.device_id!=null && Number(out.id)<latestLive.get(out.device_id)) {
  out.is_live=0;out.updated_at=report.startedAt;if(count)report.demotedLive++
 }
 return out
}
try {
 for (const [index,source] of sources.entries()) {
  const allowed=tables.filter(t=>t[1]===index).map(t=>t[0])
  const actual=source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t=>t.name)
  if(actual.some(t=>!allowed.includes(t)) || allowed.some(t=>!actual.includes(t)))throw Error('Unmapped source inbox tables')
  if(source.pragma('integrity_check',{simple:true})!=='ok')throw Error('Corrupt SQLite source');if(source.pragma('foreign_key_check').length)throw Error('SQLite foreign key violations') }
 await target.connect();await target.query('BEGIN')
 await target.query("SELECT pg_advisory_xact_lock(hashtextextended('host-ingress-state',0))")
 for (const [table] of tables) if((await target.query(`SELECT count(*)::text AS n FROM ${quote(table)}`)).rows[0].n!=='0')throw Error(`Destination inbox is not empty: ${table}`)
 for(const [table,index,key] of tables){
  const source=sources[index], columns=source.prepare(`PRAGMA table_info(${quote(table)})`).all().map(c=>c.name)
  const targetColumns=(await target.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows.map(r=>r.column_name)
  if(!columns.length || columns.some(c=>!targetColumns.includes(c)) || targetColumns.some(c=>!columns.includes(c)&&!['lease_owner','lease_token','lease_until'].includes(c)))throw Error(`Column mismatch: ${table}`)
  const select=`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${quote(key)}`
  const hash=crypto.createHash('sha256');let count=0
  function* rows(){for(const row of source.prepare(select).iterate()){const normalized=normalize(row,table,true),values=columns.map(c=>normalized[c]);hash.update(JSON.stringify(values)+'\n');count++;yield values.map(csv).join(',')+'\n'}}
  await pipeline(Readable.from(rows()),target.query(copyFrom(`COPY ${quote(table)}(${columns.map(quote).join(',')}) FROM STDIN WITH(FORMAT csv,NULL '\\N')`)))
  const expected=hash.digest('hex'),actual=crypto.createHash('sha256');let actualCount=0
  await target.query(`DECLARE inbox_verify NO SCROLL CURSOR FOR ${select}`)
  while(true){const chunk=await target.query('FETCH 1000 FROM inbox_verify');if(!chunk.rows.length)break;for(const row of chunk.rows){const normalized=normalize(row,table);actual.update(JSON.stringify(columns.map(c=>normalized[c]))+'\n');actualCount++}}
  await target.query('CLOSE inbox_verify')
  const checksum=actual.digest('hex');if(count!==actualCount || expected!==checksum)throw Error(`Verification failed: ${table}`)
  if(key==='id'){
   const maximum=Number((await target.query(`SELECT max(id) AS n FROM ${quote(table)}`)).rows[0].n||0)
   const old=Number(source.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq||0)
   const high=Math.max(maximum,old)
   await target.query('SELECT setval(pg_get_serial_sequence($1,\'id\'),$2,$3)',[table,high||1,high>0])
  }
  report.tables.push({table,count,sha256:checksum});console.log(JSON.stringify(report.tables.at(-1)))
 }
 await target.query('COMMIT');report.completedAt=new Date().toISOString()
 if(process.env.IMPORT_REPORT_PATH)fs.writeFileSync(process.env.IMPORT_REPORT_PATH,JSON.stringify(report,null,2))
 console.log('INBOX IMPORT VERIFIED AND COMMITTED')
}catch(error){await target.query('ROLLBACK').catch(()=>{});console.error(error.message);process.exitCode=1}
finally{for(const source of sources)source.close();await target.end()}

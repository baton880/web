import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import jwt from 'jsonwebtoken'
import { LoaderTaskStore } from '../src/modules/loader/loader-task-store.js'
import { LoaderTerminalStore, createLoaderAuthentication, createTerminalManagementRouter } from '../src/modules/loader/loader-terminals.js'
import { createLoaderRouter } from '../src/modules/loader/loader.routes.js'
import { buildLoaderPlan } from '../src/modules/loader/loader-plan.js'
const filename=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'loader-terminal-test-')),'journal.sqlite3')
let tasks=new LoaderTaskStore(filename),terminals=new LoaderTerminalStore(tasks.db)
const users=new Map([[1,{id:1,role:'DIRECTOR',password:'password-hash-v1'}],[2,{id:2,role:'ADMIN',password:'another-password-hash'}]])
const group={id:1,name:'Group',headcount:10,ration:{id:1,name:'Ration',isActive:true,feedingsPerDay:1,ingredients:[{id:1,name:'Silage',plannedWeight:10,sortOrder:1}]}}
const prisma={user:{findUnique:async({where})=>users.get(where.id)||null},livestockGroup:{findMany:async()=>[group],findUnique:async()=>group}}
function candidate(deviceId='host'){const id=randomUUID();return{id,key:`vkt1_${id}_${randomBytes(32).toString('base64url')}`,deviceId,name:'Test tablet'}}
const registration=candidate(),actor=users.get(1),admin=users.get(2)
const first=terminals.register(registration,actor)
assert.deepEqual(terminals.register(registration,actor),first)
assert.equal(terminals.list(actor).length,1)
assert.ok(!JSON.stringify(terminals.list(admin)).includes(registration.key))
assert.ok(!JSON.stringify(terminals.list(admin)).includes('keyHash'))
assert.throws(()=>terminals.register({...registration,deviceId:'other'},actor),/изменена/)
assert.throws(()=>terminals.revoke(first.id,{id:3,role:'DIRECTOR'}),/не найден/)
tasks.close();tasks=new LoaderTaskStore(filename);terminals=new LoaderTerminalStore(tasks.db)
const originalNow=Date.now
Date.now=()=>originalNow()+365*86400000
assert.equal((await terminals.authenticate(registration.key,prisma)).id,1,'No 24-hour expiry')
Date.now=originalNow
const webSecret='isolated-test-secret-with-no-production-use'
const authenticate=(req,res,next)=>{try{req.user=jwt.verify((req.headers.authorization||'').slice(7),webSecret);next()}catch{res.status(401).json({error:'Site login required'})}}
const app=express().use(express.json())
app.use('/api/loader/terminals',authenticate,createTerminalManagementRouter({prisma,terminals}))
app.use('/api/loader',createLoaderAuthentication({authenticate,prisma,terminals}),createLoaderRouter({prisma,store:tasks,weightHandler:(req,res)=>res.json({deviceId:req.query.deviceId,weight:500})}))
app.get('/api/users',authenticate,(req,res)=>res.json({ok:true}))
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port
const web=jwt.sign({id:1,role:'DIRECTOR'},webSecret,{expiresIn:'1h'})
async function request(route,token=registration.key,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()}}
try{
 assert.equal((await request('/api/loader/groups')).status,200)
 assert.equal((await request('/api/loader/weight?deviceId=host')).status,200)
 assert.equal((await request('/api/loader/weight?deviceId=other')).status,403)
 assert.equal((await request('/api/loader/WEIGHT/?deviceId=other')).status,403)
 assert.equal((await request('/api/loader/TASKS/?deviceId=other')).status,403)
 assert.equal((await request('/api/loader/TASKS/ACTIVE/?deviceId=other')).status,403)
 assert.equal((await request('/api/loader/groups',registration.key.slice(0,-1)+'!')).status,401)
 const wrongKey=candidate();assert.equal((await request('/api/loader/groups',wrongKey.key)).status,401)
 assert.equal((await request('/api/loader/weight')).status,403)
 assert.equal((await request('/api/loader/tasks?deviceId=other')).status,403)
 assert.equal((await request('/api/loader/session')).data.userId,1)
 assert.equal((await request('/api/loader/terminals')).status,401)
 assert.equal((await request('/api/loader/terminals',registration.key,candidate())).status,401)
 assert.equal((await request('/api/users')).status,401)
 const issued=await request('/api/loader/tasks',registration.key,{id:randomUUID(),deviceId:'host',groupId:1,planRevision:buildLoaderPlan(group).planRevision})
 assert.equal(issued.status,201)
 const adminTablet=candidate();terminals.register(adminTablet,admin)
 assert.equal((await request('/api/loader/tasks/'+issued.data.task.id,adminTablet.key)).status,403,'Admin terminal cannot act as another operator')
 assert.deepEqual((await request('/api/loader/tasks?deviceId=host',adminTablet.key)).data.tasks,[])
 const other=tasks.create({id:randomUUID(),deviceId:'other',groupId:1,planRevision:buildLoaderPlan(group).planRevision},buildLoaderPlan(group),actor)
 assert.equal((await request('/api/loader/tasks/'+other.id)).status,403)
 assert.equal((await request('/api/loader/tasks',registration.key,{id:randomUUID(),deviceId:'other',groupId:1,planRevision:buildLoaderPlan(group).planRevision})).status,403)
 const expired=jwt.sign({id:1,role:'DIRECTOR'},webSecret,{expiresIn:-1})
 assert.equal((await request('/api/loader/groups',expired)).status,401)
 assert.equal((await request('/api/loader/groups')).status,200)
 assert.equal((await request('/api/loader/terminals',web,registration)).status,201,'Lost registration response can retry')
 assert.equal((await request('/api/loader/terminals/'+first.id+'/revoke',web,{})).status,200)
 assert.equal((await request('/api/loader/groups')).status,401)
 assert.equal((await request('/api/loader/terminals',web,registration)).status,409,'Revocation cannot be undone by replay')
 const changed=candidate();terminals.register(changed,actor);users.set(1,{...actor,password:'password-hash-v2'})
 assert.equal((await request('/api/loader/groups',changed.key)).status,401,'Password change revokes')
 users.set(1,actor);const removed=candidate();terminals.register(removed,actor);users.delete(1)
 assert.equal((await request('/api/loader/groups',removed.key)).status,401,'Deleted user revokes')
 users.set(1,actor);const demoted=candidate();terminals.register(demoted,actor);users.set(1,{...actor,role:'GUEST'})
 assert.equal((await request('/api/loader/groups',demoted.key)).status,401,'Role downgrade revokes')
 console.log('PASS: registration retries, hash-only storage, persistent key after one year/reopen, expired JWT independence, device/API scope, revoke, password/role/user changes')
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));tasks.close()}

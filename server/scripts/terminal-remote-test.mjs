import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import express from 'express'
import {TerminalRemote} from '../src/modules/loader/terminal-remote.js'
import {createTerminalManagementRouter} from '../src/modules/loader/loader-terminals.js'
import {createLoaderRouter} from '../src/modules/loader/loader.routes.js'
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'remote-test-')),id=randomUUID(),other=randomUUID()
const remote=new TerminalRemote(directory),actor={id:1,role:'ADMIN'}
const terminals={list:async u=>u.id===1?[{id,ownerId:1}]:[]}
const app=express().use(express.json()).use((req,res,next)=>{req.user=req.headers['x-actor']==='terminal'?{...actor,terminalId:id}:req.headers['x-actor']==='other'?{id:2,role:'DIRECTOR'}:actor;next()})
app.use('/manage',createTerminalManagementRouter({prisma:{},terminals,remote}))
app.use('/loader',createLoaderRouter({prisma:{},store:{},remote}))
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port
const call=(url,body,actor='owner')=>fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-actor':actor},body:body?JSON.stringify(body):undefined})
try{
 assert.equal((await call('/manage/'+id+'/remote',{type:'update'},'other')).status,403)
 assert.equal((await call('/manage/'+id+'/remote',{type:'update'},'terminal')).status,403)
 assert.equal((await call('/loader/remote/poll',{})).status,403)
 const c=(await (await call('/manage/'+id+'/remote',{type:'screenshot'})).json()).command
 assert.equal((await call('/manage/'+id+'/remote',{type:'update'})).status,409)
 assert.equal((await (await call('/loader/remote/poll',{version:'test'},'terminal')).json()).command.id,c.id)
 assert.equal((await call('/loader/remote/result',{id:c.id,status:'done',image:'broken'},'terminal')).status,400)
 const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII='
 assert.equal((await call('/loader/remote/result',{id:c.id,status:'done',image},'terminal')).status,200)
 assert.equal((await call('/manage/'+id+'/screenshot',null,'other')).status,403)
 assert.equal((await call('/manage/'+id+'/screenshot')).status,200)
 assert.equal(new TerminalRemote(directory).status(id).command.status,'done')
 const update=remote.enqueue(id,'update',actor);remote.result(id,{id:update.id,status:'waiting'});assert.equal(remote.heartbeat(id,{busy:true}).id,update.id)
 remote.result(id,{id:update.id,status:'installing'});assert.equal(remote.heartbeat(id,{}),null)
 remote.result(id,{id:update.id,status:'done'});assert.equal(remote.status(id).command.status,'done')
 assert.throws(()=>remote.result(other,{id:update.id,status:'done'}))
 assert.throws(()=>remote.file('../../etc/passwd'))
 console.log('PASS remote: ownership, terminal/site separation, PNG validation, persistence, waiting/installing/completion, isolation')
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true})}

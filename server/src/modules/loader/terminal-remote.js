import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TaskError } from './loader-task-store.js'

// One durable command per terminal; private files are included with server config backups.
export class TerminalRemote {
  constructor(directory = process.env.LOADER_REMOTE_DIR || path.resolve('private-terminal-remote')) {
    this.directory = directory
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  file(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TaskError(400, 'Некорректный терминал')
    return path.join(this.directory, id + '.json')
  }
  read(id) { try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) } catch(e) { if(e.code==='ENOENT')return {}; throw e } }
  save(id, state) { const file=this.file(id);fs.writeFileSync(file+'.tmp',JSON.stringify(state),{mode:0o600});fs.renameSync(file+'.tmp',file) }
  enqueue(id, type, actor) {
    if (!['screenshot','update'].includes(type)) throw new TaskError(400,'Неизвестная команда')
    const s=this.read(id),now=Date.now()
    if(s.command && ['pending','waiting','installing'].includes(s.command.status) && s.command.expiresAt>now)throw new TaskError(409,'Предыдущая команда ещё выполняется')
    s.command={id:randomUUID(),type,status:'pending',createdAt:now,expiresAt:now+86400000,requestedBy:actor.id}
    this.save(id,s);return s.command
  }
  heartbeat(id, body) {
    const s=this.read(id),now=Date.now();s.lastSeenAt=now
    s.version=String(body.version||'').slice(0,40);s.versionCode=Number(body.versionCode)||0;s.busy=body.busy===true
    s.kiosk=body.kiosk===true;s.local=body.local===true;s.internet=body.internet===true
    if(s.command && s.command.expiresAt<now && ['pending','waiting','installing'].includes(s.command.status))s.command.status='expired'
    this.save(id,s)
    return s.command && ['pending','waiting'].includes(s.command.status) ? s.command : null
  }
  result(id, body) {
    const s=this.read(id),c=s.command
    if(!c || c.id!==body.id)throw new TaskError(409,'Команда уже заменена')
    if(!['pending','waiting','installing'].includes(c.status))return
    if(!['waiting','installing','done','failed'].includes(body.status))throw new TaskError(400,'Некорректный статус')
    if(body.image) {
      if(c.type!=='screenshot' || body.status!=='done' || typeof body.image!=='string' || body.image.length>2000000)throw new TaskError(400,'Некорректный снимок')
      const image=Buffer.from(body.image,'base64')
      if(image.length<8 || !image.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw new TaskError(400,'Ожидается PNG')
      s.image=body.image;s.capturedAt=Date.now()
    }
    c.status=body.status;c.message=String(body.message||'').slice(0,240);c.updatedAt=Date.now();this.save(id,s)
  }
  status(id) { const {image,...s}=this.read(id);return {...s,hasScreenshot:!!image} }
  screenshot(id) { const s=this.read(id);if(!s.image)throw new TaskError(404,'Снимок ещё не получен');return Buffer.from(s.image,'base64') }
}

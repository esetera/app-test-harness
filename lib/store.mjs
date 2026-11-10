import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'

export function workspacePath(input) {
  if (typeof input !== 'string' || input.includes('\0') || input.includes('\\') || input.split('/').includes('..')) {
    throw new Error('Use a path inside /Workspace.')
  }
  const path = posix.normalize(input)
  if (path !== '/Workspace' && !path.startsWith('/Workspace/')) throw new Error('Use a path inside /Workspace.')
  return path
}
const version = value => createHash('sha256').update(value).digest('hex')
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, content BLOB, directory INTEGER NOT NULL, modified INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(app TEXT, kind TEXT, value TEXT NOT NULL, PRIMARY KEY(app,kind));
      CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, browser TEXT NOT NULL, app TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, time TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_browser ON activity(browser,id);
      CREATE TABLE IF NOT EXISTS records(app TEXT, collection TEXT, key TEXT, id TEXT, value TEXT, created TEXT, updated TEXT, PRIMARY KEY(app,collection,key));
    `)
    for (const path of ['/Workspace','/Workspace/Documents','/Workspace/Drafts','/Workspace/.appdata']) this.mkdir(path)
  }
  close() { this.db.close() }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = action(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  entry(input) {
    const path = workspacePath(input)
    const row = this.db.prepare('SELECT * FROM files WHERE path=?').get(path)
    if (!row) throw new Error('No such file: ' + path)
    return { path, name: posix.basename(path), extension: posix.extname(path), isDirectory: !!row.directory, kind: row.directory ? 'folder' : 'file',
      size: row.content?.length ?? 0, byteLength: row.content?.length ?? 0, modifiedAt: new Date(row.modified).toISOString(),
      mtimeMs: row.modified, mimeType: mime(path) }
  }
  mkdir(input) {
    const path = workspacePath(input)
    const existing = this.db.prepare('SELECT directory FROM files WHERE path=?').get(path)
    if (existing && !existing.directory) throw new Error('A file already exists at ' + path)
    if (path !== '/Workspace') this.mkdir(posix.dirname(path))
    this.db.prepare('INSERT OR IGNORE INTO files VALUES (?,NULL,1,?)').run(path, Date.now())
    return path
  }
  write(input, bytes) {
    const path = workspacePath(input)
    if (path === '/Workspace') throw new Error('Choose a file name.')
    const existing = this.db.prepare('SELECT directory FROM files WHERE path=?').get(path)
    if (existing?.directory) throw new Error('Path is a folder.')
    this.mkdir(posix.dirname(path))
    this.db.prepare('INSERT INTO files VALUES (?,?,0,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content,modified=excluded.modified').run(path, Buffer.from(bytes), Date.now())
    return { ok:true, ...this.entry(path) }
  }
  read(input) {
    const path = workspacePath(input)
    const row = this.db.prepare('SELECT content,directory FROM files WHERE path=?').get(path)
    if (!row || row.directory) throw new Error('No such file: ' + path)
    return Buffer.from(row.content)
  }
  exists(input) { return !!this.db.prepare('SELECT path FROM files WHERE path=?').get(workspacePath(input)) }
  list(input = '/Workspace') {
    const path = workspacePath(input)
    if (!this.entry(path).isDirectory) throw new Error('Not a folder.')
    return this.all().filter(row => row.path !== path && posix.dirname(row.path) === path)
  }
  all() { return this.db.prepare('SELECT path FROM files ORDER BY path').all().map(row => this.entry(row.path)) }
  remove(input, recursive = false) {
    const path = workspacePath(input)
    if (path === '/Workspace') throw new Error('The workspace root cannot be removed.')
    const descendants = this.all().filter(row => row.path === path || row.path.startsWith(path + '/'))
    if (!recursive && descendants.length > 1) throw new Error('Folder has files. Set recursive to remove it.')
    for (const row of descendants) this.db.prepare('DELETE FROM files WHERE path=?').run(row.path)
    return {ok:true,path}
  }
  move(input, target, copy = false) {
    const from = workspacePath(input), to = workspacePath(target)
    if (from === '/Workspace' || to.startsWith(from + '/') || this.exists(to)) throw new Error('Choose a new destination outside the source.')
    const entries = this.all().filter(row => row.path === from || row.path.startsWith(from + '/'))
    if (!entries.length) throw new Error('No such file: ' + from)
    return this.transaction(() => {
      for (const row of entries) {
        const destination = to + row.path.slice(from.length)
        if (row.isDirectory) this.mkdir(destination)
        else this.write(destination,this.read(row.path))
      }
      if (!copy) this.remove(from,true)
      return {path:to,entry:this.entry(to)}
    })
  }
  settings(app, kind, patch) {
    const value = JSON.parse(this.db.prepare('SELECT value FROM settings WHERE app=? AND kind=?').get(app,kind)?.value ?? '{}')
    if (patch === undefined) return value
    const next = {...value,...object(patch)}
    this.db.prepare('INSERT INTO settings VALUES (?,?,?) ON CONFLICT(app,kind) DO UPDATE SET value=excluded.value').run(app,kind,JSON.stringify(next))
    return next
  }
  storage(app, request, write = false) {
    const file = request?.fileName
    if (typeof file !== 'string' || !/^[\w.-]+\.json$/i.test(file)) throw new Error('Use a plain JSON store file name.')
    const path = '/Workspace/.appdata/' + file
    const old = this.exists(path) ? this.read(path).toString() : null
    const hash = old === null ? null : version(old)
    if (!write) return {path,value:old === null ? null : JSON.parse(old),version:hash}
    if (request.ifMatch !== undefined && request.ifMatch !== hash) return {path,ok:false,conflict:true,value:old === null ? null : JSON.parse(old),version:hash}
    const raw = JSON.stringify(request.value ?? null)
    this.write(path,raw)
    return {path,ok:true,version:version(raw)}
  }
  documents(app, method, request) {
    if (method === 'list') return this.all().filter(row =>
      (request.suffixes ?? []).some(suffix=>row.path.toLowerCase().endsWith(suffix.toLowerCase())))
      .map(row=>({...row,isDraft:row.path.startsWith('/Workspace/Drafts/'),kind:row.isDirectory?'package':'file'}))
    if (method === 'createDraft') {
      if (!/^\.[a-z0-9.-]+$/i.test(request.suffix)) throw new Error('Give a document suffix.')
      const title = String(request.title || 'Untitled').replace(/[\/\\]/g,'-')
      let path = '/Workspace/Drafts/' + title + request.suffix
      if (this.exists(path)) path = '/Workspace/Drafts/' + title + '-' + randomUUID().slice(0,8) + request.suffix
      return this.transaction(()=> {
        if (request.kind === 'package') this.mkdir(path)
        this.writeDocument(path, request.files ?? [])
        return {path}
      })
    }
    if (method === 'autosave') return this.transaction(()=>{
      const path = workspacePath(request.path)
      const revision = request.revision
      if (revision && this.exists(path + '/' + revision.file)) {
        const saved = JSON.parse(this.read(path + '/' + revision.file).toString())
        if (saved[revision.field] !== revision.expected) throw new Error('Document changed. Read it again before saving.')
      }
      this.writeDocument(path,request.files ?? [])
      return {ok:true,path}
    })
    throw new Error('Unknown document operation.')
  }
  writeDocument(path, files) {
    for (const file of files) {
      const relative = file.path ?? file.name ?? ''
      if (typeof relative !== 'string' || relative.startsWith('/') || relative.split('/').includes('..')) throw new Error('Invalid document file name.')
      const target = relative ? path + '/' + relative : path
      this.write(target, file.encoding === 'base64' || file.base64 !== undefined ? Buffer.from(file.base64 ?? file.content,'base64') : String(file.content ?? ''))
    }
  }
  addActivity(browser, app, type, payload) {
    const event = this.db.prepare('INSERT INTO activity(browser,app,type,payload,time) VALUES (?,?,?,?,?)')
      .run(browser,app ?? null,type,JSON.stringify(payload),new Date().toISOString())
    this.db.prepare('DELETE FROM activity WHERE id <= ?').run(Number(event.lastInsertRowid)-10_000)
    return Number(event.lastInsertRowid)
  }
  activityEvent(browser,id) {
    const event=this.db.prepare('SELECT * FROM activity WHERE browser=? AND id=?').get(browser,id)
    return event && {...event,payload:JSON.parse(event.payload)}
  }
  activity(browser, after) {
    const entries = after === undefined
      ? this.db.prepare('SELECT * FROM activity WHERE browser=? ORDER BY id DESC LIMIT 40').all(browser).reverse()
      : this.db.prepare('SELECT * FROM activity WHERE browser=? AND id>? ORDER BY id LIMIT 40').all(browser,after)
    const events = entries.map(event=>({...event,payload:JSON.parse(event.payload)}))
    return {events,nextCursor:events.at(-1)?.id ?? after ?? 0}
  }
  data(app, operation, request) {
    const collection = String(request.collection ?? ''), key = String(request.key ?? '')
    const row = value=>value ? {id:value.id,key:value.key,collection:value.collection,appId:app,value:JSON.parse(value.value),createdAt:value.created,updatedAt:value.updated} : null
    if (operation === 'collections') return this.db.prepare('SELECT DISTINCT collection FROM records WHERE app=?').all(app).map(r=>r.collection)
    if (operation === 'list') return this.db.prepare('SELECT * FROM records WHERE app=? AND collection=? ORDER BY created,id LIMIT ? OFFSET ?').all(app,collection,request.limit ?? -1,request.offset ?? 0).map(row)
    const existing = this.db.prepare('SELECT * FROM records WHERE app=? AND collection=? AND key=?').get(app,collection,key)
    if (operation === 'get') return row(existing)
    if (operation === 'delete') { this.db.prepare('DELETE FROM records WHERE app=? AND collection=? AND key=?').run(app,collection,key); return row(existing) }
    if (operation === 'set') {
      const now = new Date().toISOString()
      this.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?) ON CONFLICT(app,collection,key) DO UPDATE SET value=excluded.value,updated=excluded.updated')
        .run(app,collection,key,existing?.id ?? randomUUID(),JSON.stringify(request.value ?? null),existing?.created ?? now,now)
      return row(this.db.prepare('SELECT * FROM records WHERE app=? AND collection=? AND key=?').get(app,collection,key))
    }
    throw new Error('Unknown data operation.')
  }
}
export function mime(path) {
  return ({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.mp4':'video/mp4','.pdf':'application/pdf'})[posix.extname(path).toLowerCase()] ?? 'application/octet-stream'
}

import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalog } from './catalog.mjs'
import { bridgeHandlers } from './bridge.mjs'
import { conversations } from './conversations.mjs'
import { mime, Store } from './store.mjs'

const web = resolve(fileURLToPath(new URL('../web/',import.meta.url)))
const sessionAge = 40_000
const timeout = 43_000
const expires = 30 * 60_000
const writes = new Set([
  'fs.write','fs.writeBinary','fs.createFolder','fs.rename','fs.delete',
  'documents.createDraft','documents.autosave','documents.rename','documents.promote','documents.duplicate',
  'storage.writeJson','apps.data.set','apps.data.delete',
])
const failure = (message, status=400) => Object.assign(new Error(message),{status})
const json = (res, body, status=200) => {
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
  res.end(JSON.stringify(body))
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw failure('Send a JSON body.',415)
  let size=0
  const parts=[]
  for await (const part of req) {
    size+=part.length
    if (size > 64*1024*1024) throw failure('The request is larger than 64 MB.',413)
    parts.push(part)
  }
  return JSON.parse(Buffer.concat(parts).toString() || '{}')
}
function pathWithin(root,url) {
  try {
    const requested = resolve(root,'.'+decodeURIComponent(url === '/' ? '/index.html' : url))
    if (!requested.startsWith(root+sep)) return
    const file = realpathSync(requested)
    if (file.startsWith(root+sep) && statSync(file).isFile()) return file
  } catch { /* Absent or invalid path. */ }
}
function sendFile(res,file,headers={}) {
  res.writeHead(200,{'Content-Type':mime(file),'X-Content-Type-Options':'nosniff',...headers})
  const stream=createReadStream(file)
  stream.on('error',()=>res.destroy())
  stream.pipe(res)
}
function bind(server, port) {
  return new Promise((accept,reject)=>{
    server.once('error',reject)
    server.listen(port,'127.0.0.1',()=>{
      server.off('error',reject)
      accept(server.address().port)
    })
  })
}

export async function serve({port,appsRoot,stateDir,themePath,apps:included,sourceBase,labels}) {
  const apps = catalog(appsRoot,{apps:included,sourceBase,labels})
  if (!apps.length) throw new Error('No built configured apps found in ' + appsRoot)
  mkdirSync(stateDir,{recursive:true,mode:0o700})
  const store = new Store(join(stateDir,'workspace.sqlite'))
  const token = randomBytes(32).toString('hex')
  const previews = new Map()
  const sessions = new Map()
  const assetServers = new Map()
  const calls = new Map()
  const activitySignal = new EventEmitter()
  activitySignal.setMaxListeners(0)
  function record(session,type,payload,app=session.app) {
    const id=store.addActivity(session.id,app,type,payload)
    activitySignal.emit(session.id)
    return {id}
  }
  async function activity(session, request, response) {
    const {after,waitSeconds=0}=request
    if (after!==undefined && (!Number.isSafeInteger(after) || after<0)) throw failure('Use a nonnegative activity cursor.')
    if (!Number.isFinite(waitSeconds) || waitSeconds<0 || waitSeconds>20) throw failure('Wait up to 20 seconds.')
    let batch=store.activity(session.id,after)
    if (!batch.events.length && waitSeconds>0) {
      await new Promise(accept=>{
        const finish=()=>{
          clearTimeout(timer)
          activitySignal.off(session.id,finish)
          response.off('close',finish)
          accept()
        }
        const timer=setTimeout(finish,waitSeconds*1000)
        activitySignal.once(session.id,finish)
        response.once('close',finish)
      })
      batch=store.activity(session.id,after)
    }
    return batch
  }
  function recordWrite(session, method, args, result) {
    if (result?.ok===false) return
    const value=args[0]
    const candidate=result?.path ?? (typeof value==='string'?value:value?.path)
    const path=typeof candidate==='string' && candidate.startsWith('/Workspace/') ? candidate : undefined
    record(session,'workspace_change',{method,...(path?{path}:{} )})
  }
  const theme = themePath && existsSync(themePath) ? JSON.parse(readFileSync(themePath,'utf8')).light : null
  let origin
  const assistant = conversations(store,record)
  const methods = {...assistant.methods,...bridgeHandlers(store,apps,path=>{
    const id = randomUUID()
    previews.set(id,{path,until:Date.now()+expires})
    return origin + '/preview/' + id
  })}
  const lookup = id => {
    const app = apps.find(app=>app.id===id || app.slug===id)
    if (!app) throw failure('Unknown app. Use the catalog to choose an available app.',404)
    return app
  }
  const sessionById = id => {
    const session = sessions.get(id)
    if (!session || Date.now()-session.seen > sessionAge) throw failure('Open the harness in the agent’s browser first.',409)
    return session
  }
  const liveSessions = () => [...sessions.values()].filter(session=>Date.now()-session.seen < sessionAge)

  function selectSession(id) {
    if (id) return sessionById(id)
    const open = liveSessions()
    if (open.length === 1) return open[0]
    if (!open.length) throw failure('Open the harness in the agent’s browser first.',409)
    throw failure('Several browser views are open. Use a browser ID from status.',409)
  }
  function runInBrowser(session,request) {
    const id = randomUUID()
    return new Promise((accept,reject)=>{
      const timer=setTimeout(()=>{
        calls.delete(id)
        reject(failure('The browser did not answer. Check the open app before retrying.',504))
      },timeout)
      calls.set(id,{id,session:session.id,request,delivered:false,accept,reject,timer})
      session.wake?.()
    })
  }

  function appOrigin(app) {
    if (!assetServers.has(app.id)) assetServers.set(app.id,(async()=>{
      const assets = createServer((req,res)=>{
        const host = '127.0.0.1:' + assets.address().port
        if (req.headers.host !== host || !['GET','HEAD'].includes(req.method)) return json(res,{error:'Invalid asset request.'},403)
        const path = new URL(req.url,'http://'+host).pathname
        const file = pathWithin(app.root,path)
        if (!file) return json(res,{error:'Asset not found.'},404)
        sendFile(res,file,{'Content-Security-Policy':`frame-ancestors ${origin} http://localhost:${port}`})
      })
      const bound = await bind(assets,0)
      return {assets,origin:'http://127.0.0.1:'+bound}
    })())
    return assetServers.get(app.id)
  }

  const summary = ({id,slug,name,description,source})=>({id,slug,name,description,source})
  const server = createServer(async (req,res)=>{
    try {
      if (![new URL(origin).host,'localhost:'+port].includes(req.headers.host)) throw failure('Use the local harness address.',403)
      const url = new URL(req.url,origin)
      const path = url.pathname
      const requestingOrigin = 'http://' + req.headers.host
      if (path === '/api/browser-token' && req.method === 'GET') {
        if (req.headers['x-app-harness'] !== 'browser' || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') ||
          (req.headers.origin && req.headers.origin !== requestingOrigin)) throw failure('Open the local harness page.',403)
        return json(res,{token})
      }
      if (path.startsWith('/preview/') && req.method === 'GET') {
        const preview = previews.get(path.slice(9))
        if (!preview || preview.until < Date.now()) throw failure('File link expired.',404)
        const content = store.read(preview.path)
        res.writeHead(200,{'Content-Type':mime(preview.path),'Content-Security-Policy':"sandbox; default-src 'none'",
          'X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'})
        return res.end(content)
      }
      if (!path.startsWith('/api/')) {
        if (!['GET','HEAD'].includes(req.method)) throw failure('Use GET.',405)
        const file = pathWithin(web,path)
        if (!file) throw failure('Page not found.',404)
        return sendFile(res,file,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
          'X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; frame-src http://127.0.0.1:*; style-src 'self'; frame-ancestors 'none'"})
      }
      if (req.headers.authorization !== 'Bearer '+token) throw failure('Open the local harness or start it from the project.',401)
      if (req.headers.origin && req.headers.origin !== requestingOrigin) throw failure('Open the local harness page.',403)
      if (path==='/api/apps' && req.method==='GET') return json(res,apps.map(summary))
      if (path==='/api/status' && req.method==='GET') return json(res,{url:origin,apps:apps.length,browsers:liveSessions().map(({id,app,ready,label})=>({id,app,ready,label}))})
      if (req.method !== 'POST') throw failure('Use POST.',405)
      const request = await body(req)
      if (path==='/api/browser') {
        const {id,label} = request
        if (typeof id !== 'string' || !/^[a-z0-9-]{8,40}$/.test(id)) throw failure('Invalid browser ID.')
        const existing=sessions.get(id) ?? {id}
        Object.assign(existing,{label:String(label ?? 'Browser').slice(0,48),seen:Date.now()})
        sessions.set(id,existing)
        return json(res,{id})
      }
      if (path==='/api/next') {
        const session=sessionById(request.session)
        session.seen=Date.now()
        if (session.wake) throw failure('This browser already has a request waiting.',409)
        const available=()=>[...calls.values()].find(call=>call.session===session.id && !call.delivered)
        if (!available()) await new Promise(accept=>{
          const finish=()=>{clearTimeout(timer);delete session.wake;res.off('close',finish);accept()}
          const timer=setTimeout(finish,10_000)
          session.wake=finish
          res.once('close',finish)
        })
        if (res.destroyed) return
        const call=available()
        if (call) call.delivered=true
        return json(res,call?{id:call.id,...call.request}:null)
      }
      if (path==='/api/complete') {
        const call=calls.get(request.id)
        if (call?.session===request.session) {
          clearTimeout(call.timer)
          calls.delete(call.id)
          if (request.ok) call.accept(request.result)
          else call.reject(failure(String(request.error ?? 'The app could not complete the request.'),422))
        }
        return json(res,{ok:true})
      }
      if (path==='/api/activity') {
        const session=selectSession(request.session)
        const batch=await activity(session,request,res)
        if (!res.destroyed) return json(res,batch)
        return
      }
      if (path==='/api/user-request' || path==='/api/agent-reply') {
        const session=selectSession(request.session)
        const message=typeof request.message==='string'?request.message.trim():''
        if (!message || message.length>4000) throw failure('Write between 1 and 4,000 characters.')
        if (path==='/api/user-request') return json(res,record(session,'user_request',{message}))
        const {inReplyTo}=request
        if (inReplyTo!==undefined && (!Number.isSafeInteger(inReplyTo) || inReplyTo<1)) throw failure('Use the request event ID.')
        const original=inReplyTo && store.activityEvent(session.id,inReplyTo)
        if (inReplyTo && !['user_request','app_request'].includes(original?.type)) throw failure('No matching request in this browser.',404)
        if (original?.type==='app_request') assistant.reply(lookup(original.app),session,original.payload.thread,message)
        return json(res,record(session,'agent_reply',{message,inReplyTo},original?.app ?? session.app))
      }
      if (path==='/api/launch') {
        const session=sessionById(request.session)
        const app=lookup(request.app)
        const asset=await appOrigin(app)
        session.app=app.id
        session.ready=false
        return json(res,{...summary(app),origin:asset.origin,manifest:app.manifest,theme,methods:Object.keys(methods),
          settings:store.settings(app.slug,'app')})
      }
      if (path==='/api/ready') {
        const session=sessionById(request.session)
        if (session.app===request.app && !session.ready && request.ready===true) {
          session.ready=true
          record(session,'app_opened',{name:lookup(session.app).name})
        }
        return json(res,{ok:true})
      }
      if (path==='/api/bridge') {
        const session=sessionById(request.session)
        if (request.app!==session.app) throw failure('The active app changed.',409)
        const method=Object.hasOwn(methods,request.method) && methods[request.method]
        if (!method) throw failure('This browser workspace does not provide '+request.method+'.',422)
        const args=Array.isArray(request.args)?request.args:[]
        const result=await method(lookup(session.app),args,session)
        if (writes.has(request.method)) recordWrite(session,request.method,args,result)
        if (request.method==='context.publish' || request.method==='context.clear') {
          record(session,'app_context',{method:request.method,attachments:Array.isArray(args[0]?.attachments)?args[0].attachments.length:0})
        }
        return json(res,{result})
      }
      if (path==='/api/control') {
        if (!['open','tools','call'].includes(request.action)) throw failure('Choose open, tools, or call.')
        if (request.app) lookup(request.app)
        const session=selectSession(request.session)
        const result=await runInBrowser(session,{action:request.action,app:request.app,name:request.name,args:request.args})
        if (request.action==='call') record(session,'tool_completed',{name:request.name,ok:!result?.isError})
        return json(res,result)
      }
      throw failure('Unknown endpoint.',404)
    } catch(error) {
      if (!res.headersSent && !res.destroyed) json(res,{error:error.message},error.status ?? 400)
      else if (!res.writableEnded) res.end()
    }
  })
  port=await bind(server,port)
  origin='http://127.0.0.1:'+port
  writeFileSync(join(stateDir,'server.json'),JSON.stringify({url:origin,token,pid:process.pid}),{mode:0o600})
  const sweep=setInterval(()=>{
    const now=Date.now()
    for (const [id,session] of sessions) if (now-session.seen > sessionAge) sessions.delete(id)
    for (const [id,preview] of previews) if (preview.until < now) previews.delete(id)
  },30_000).unref()
  return {origin, count:apps.length, async close(){
    clearInterval(sweep)
    for (const call of calls.values()) {clearTimeout(call.timer);call.reject(failure('Harness stopped.',503))}
    server.closeAllConnections()
    server.close()
    for (const pending of assetServers.values()) {
      const {assets}=await pending
      assets.closeAllConnections()
      assets.close()
    }
    store.close()
  }}
}

const $ = id => document.getElementById(id)
const browserId = sessionStorage.getItem('harness-browser') ?? crypto.randomUUID()
sessionStorage.setItem('harness-browser',browserId)
const tabs = new Map()
let current, apps, token, opening
let noticeTimer
function notice(message) {
  clearTimeout(noticeTimer)
  $('notice').textContent = message
  $('notice').hidden = !message
  if (message) noticeTimer = setTimeout(()=>{$('notice').hidden=true},8500)
}
async function api(path, data) {
  const response = await fetch('/api/'+path,{
    method:data===undefined?'GET':'POST',
    headers:{authorization:'Bearer '+token,...(data===undefined?{}:{'Content-Type':'application/json'})},
    ...(data===undefined?{}:{body:JSON.stringify(data)}),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}
const session = (path,data={})=>api(path,{...data,session:browserId})
const methods = (tab,method,...args)=>session('bridge',{app:tab.app.id,method,args}).then(result=>result.result)
const post = (tab,message)=>tab.frame.contentWindow?.postMessage({channel:tab.channel,...message},tab.app.origin)
const event = (tab,name,payload)=>post(tab,{type:'event',name,payload})
const snapshot = tab=>({root:'/Workspace',manifest:tab.app.manifest,settings:tab.app.settings,config:{enabled:true},devUrl:null,logo:null})
const viewport = tab=>({tabId:tab.id,sessionId:browserId,resource:tab.resource ?? null})
const baseTools = tab=>tab.app.manifest.app?.agents?.tools ?? []

function register(tab, request) {
  tab.tools = new Set((request?.tools ?? []).map(tool=>typeof tool==='string'?tool:tool?.name).filter(Boolean))
  return {ok:true}
}
function chooseApp(id) { return apps.find(app=>app.id===id || app.slug===id) }

async function openApp(id) {
  const job=(opening ?? Promise.resolve()).catch(()=>{}).then(()=>mountApp(id))
  opening=job
  try { return await job }
  finally { if (opening===job) opening=null }
}

async function mountApp(id) {
  const chosen=chooseApp(id)
  if (!chosen) throw new Error('Choose an app from the catalog.')
  if (current?.app.id === chosen.id && current.frame.isConnected && !current.failed) {
    showStage(current)
    await current.ready
    return current
  }
  if (current?.activeCalls.size) throw new Error('Wait for the active app tool to finish before switching.')
  if (current) {
    event(current,'workspace.willClose',{requestId:current.id})
    await Promise.race([new Promise(resolve=>{current.onClose=resolve}),new Promise(resolve=>setTimeout(resolve,350))])
    current.frame.remove()
    tabs.delete(current.app.origin)
  }
  const app=await session('launch',{app:chosen.id})
  const frame=document.createElement('iframe')
  frame.title=app.name
  frame.allow='clipboard-read; clipboard-write; fullscreen'
  frame.sandbox='allow-scripts allow-same-origin allow-forms allow-downloads allow-popups'
  frame.src=app.origin+'/'
  const tab={app,frame,id:crypto.randomUUID(),tools:new Set(),activeCalls:new Map(),handshake:false}
  tab.ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(app.name+' did not connect to the browser host.')),15_000)
    tab.onReady=()=>{clearTimeout(timer);resolve()}
  })
  current=tab
  tabs.set(app.origin,tab)
  showStage(tab)
  $('frame').replaceChildren(frame)
  try { await tab.ready }
  catch(error) { tab.failed=true; $('app-status').textContent='Connection failed'; throw error }
  return tab
}

function showStage(tab) {
  $('catalog').hidden=true
  $('stage').hidden=false
  $('app-name').textContent=tab.app.name
  $('source').hidden=!tab.app.source
  if (tab.app.source) $('source').href=tab.app.source
  $('app-status').textContent=tab.handshake?'Connected':'Connecting…'
  history.replaceState(null,'','?app='+encodeURIComponent(tab.app.id))
}
function showCatalog() {
  $('stage').hidden=true
  $('catalog').hidden=false
  history.replaceState(null,'','/')
}
function setResource(tab,path) {
  tab.resource=path?{path,name:path.split('/').at(-1),kind:'file'}:null
  event(tab,'viewport.changed',viewport(tab))
  if (tab.resource) event(tab,'resource.open',tab.resource)
}

async function approve(tab,name,args) {
  const dialog=$('approval')
  $('approval-message').textContent=name+' in '+tab.app.name
  $('approval-args').textContent=JSON.stringify(args ?? {},null,2).slice(0,4000)
  dialog.returnValue='deny'
  dialog.showModal()
  const timer=setTimeout(()=>dialog.close('deny'),19_000)
  await new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}))
  clearTimeout(timer)
  return dialog.returnValue==='allow'
}
async function invoke(tab, name, args) {
  const declared=baseTools(tab).find(tool=>tool.name===name)
  if (!declared) throw new Error('This app does not declare '+name+'.')
  for (let i=0;i<30&&!tab.tools.has(name);i++) await new Promise(resolve=>setTimeout(resolve,100))
  if (!tab.tools.has(name)) throw new Error(name+' is not registered in the current app view.')
  if (declared.requiresApproval || declared.risk==='release') {
    if (!await approve(tab,name,args)) throw new Error('The browser user declined '+name+'.')
  }
  const invokeId=crypto.randomUUID()
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      tab.activeCalls.delete(invokeId)
      reject(new Error(name+' did not answer. Check the app before retrying.'))
    },19_000)
    tab.activeCalls.set(invokeId,result=>{clearTimeout(timer);resolve(result)})
    event(tab,'agents.tool.invoke',{invokeId,toolCallId:invokeId,shortName:name,name:tab.app.slug+'.'+name,
      arguments:args ?? {},agent:'Browser agent',session:browserId,work:'watch'})
  })
}

let picking=false
async function choose(tab, mode, options={}) {
  if (picking) throw new Error('Finish the open file picker first.')
  picking=true
  const dialog=$('picker')
  $('picker-title').textContent=options.title ?? (mode==='files'?'Workspace files':mode==='folder'?'Choose a folder':mode==='save'?'Save to workspace':'Choose a file')
  $('filename-label').hidden=mode!=='save'
  $('filename').value=String(options.defaultName ?? options.defaultPath ?? 'Untitled').split('/').at(-1)
  $('pick-confirm').hidden=mode==='files'
  const selection=new Set()
  let folder='/Workspace'
  const filters=(options.filters ?? []).flatMap(filter=>filter.extensions ?? []).map(ext=>ext.toLowerCase())
  const refresh=async()=>{
    const listing=await methods(tab,'fs.list',{rootPath:folder})
    $('picker-path').textContent=listing.rootPath
    $('picker-list').replaceChildren()
    function button(label,action) {
      const item=document.createElement('button')
      item.type='button'
      item.textContent=label
      item.onclick=()=>Promise.resolve(action(item)).catch(error=>notice(error.message))
      $('picker-list').append(item)
    }
    if (listing.parentPath) button('‹ Parent folder',()=>{folder=listing.parentPath;return refresh()})
    for (const item of listing.entries) {
      if (item.isDirectory) button('▸ '+item.name,()=>{folder=item.path;return refresh()})
      else if (mode==='files') button('Download '+item.name,async()=>{
        const file=await methods(tab,'fs.previewUrl',{path:item.path})
        Object.assign(document.createElement('a'),{href:file.url,download:item.name}).click()
      })
      else if (mode==='open' && (!filters.length || filters.includes('*') || filters.includes(item.extension.toLowerCase().slice(1)))) {
        button(item.name,button=>{
          if (options.multiple) {
            if (selection.has(item.path)) selection.delete(item.path)
            else selection.add(item.path)
            button.setAttribute('aria-pressed',String(selection.has(item.path)))
          } else {
            selection.add(item.path)
            dialog.close('confirm')
          }
        })
      }
    }
  }
  try {
    await refresh()
    $('import').value=''
    $('import').onchange=async()=>{
      try {
        for (const file of $('import').files) {
          if (file.size>40*1024*1024) throw new Error(file.name+' is larger than 40 MB.')
          const base64=await new Promise((resolve,reject)=>{
            const reader=new FileReader()
            reader.onload=()=>resolve(String(reader.result).split(',')[1])
            reader.onerror=()=>reject(reader.error)
            reader.readAsDataURL(file)
          })
          const path=folder+'/'+file.name
          if (await methods(tab,'fs.exists',path) && !window.confirm('Replace '+file.name+'?')) continue
          await methods(tab,'fs.writeBinary',{path,base64})
        }
        await refresh()
      } catch(error) { notice(error.message) }
    }
    dialog.returnValue='cancel'
    dialog.showModal()
    await new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}))
    const name=$('filename').value.trim()
    if (mode==='save' && (!name || /[/\\]/.test(name))) throw new Error('Give a plain file name.')
    const paths=dialog.returnValue!=='confirm'?[]:mode==='folder'?[folder]:mode==='save'?[folder+'/'+name]:[...selection]
    return {path:paths[0] ?? null,...(options.multiple?{paths}:{})}
  } finally { picking=false }
}
const local={
  'agents.tools.register':register,
  'agents.tools.unregister':tab=>register(tab,{}),
  'agents.tools.complete':(tab,result)=>{
    const done=tab.activeCalls.get(result?.invokeId)
    if (done) {tab.activeCalls.delete(result.invokeId);done(result)}
    return {ok:true}
  },
  'catalog.open':async(tab,request)=>{
    const path=typeof request==='string'?request:request?.path
    if (!path?.startsWith('/Workspace/')) throw new Error('Open a file inside this workspace.')
    const entry=await methods(tab,'fs.stat',path)
    tab.resource={path,name:entry.name,kind:entry.kind}
    event(tab,'viewport.changed',viewport(tab))
    event(tab,'resource.open',tab.resource)
    return {ok:true,path,appSlug:tab.app.slug}
  },
  'workspace.toggleAgentDrawer':(_,options={})=>{
    if (options.open!==false) showActivity()
    else if ($('agent-dialog').open) $('agent-dialog').close()
    return {ok:true}
  },
  'workspace.updateCurrentTab':()=>({ok:true,updated:true}),
  'workspace.closeReady':tab=>{tab.onClose?.();return {ok:true}},
  'workspace.goHome':tab=>{setResource(tab,null);return {ok:true}},
  'dialog.openFile':(tab,options)=>choose(tab,'open',options),
  'dialog.openImage':tab=>choose(tab,'open',{title:'Choose an image',filters:[{extensions:['png','jpg','jpeg','gif','webp','svg']}]}),
  'dialog.openFolder':(tab,options)=>choose(tab,'folder',options),
  'dialog.saveFolder':(tab,options)=>choose(tab,'folder',options),
  'dialog.saveFile':(tab,options)=>choose(tab,'save',options),
  'clipboard.write':async(_,value)=>{await navigator.clipboard.writeText(typeof value==='string'?value:value?.text ?? '');return {ok:true}},
  'clipboard.read':async()=>({text:await navigator.clipboard.readText()}),
  'assets.setSelected':()=>true,
}
window.addEventListener('message',async message=>{
  const tab=tabs.get(message.origin)
  const data=message.data
  if (!tab || message.source!==tab.frame.contentWindow || !data) return
  if (!tab.channel && data.type==='handshake' && /^[a-z][a-z0-9-]*-plugin-bridge$/.test(data.channel)) {
    tab.channel=data.channel
  }
  if (!tab.channel || data.channel!==tab.channel) return
  if (data.type==='handshake') {
    post(tab,{type:'ready',version:1,pluginId:tab.app.manifest.id,appSlug:tab.app.slug,
      app:snapshot(tab),viewport:viewport(tab),theme:tab.app.theme,
      methods:[...tab.app.methods,...Object.keys(local)]})
    tab.handshake=true
    tab.onReady()
    $('app-status').textContent='Connected'
    void session('ready',{app:tab.app.id,ready:true}).catch(()=>{})
    return
  }
  if (data.type!=='request' || typeof data.id!=='string') return
  const args=Array.isArray(data.args)?data.args:[]
  try {
    const result=Object.hasOwn(local,data.method)?await local[data.method](tab,...args):await methods(tab,data.method,...args)
    post(tab,{type:'response',id:data.id,ok:true,result})
    if (data.method==='settings.app.update') {
      tab.app.settings=result
      event(tab,'app.changed',snapshot(tab))
    }
  } catch(error) {
    post(tab,{type:'response',id:data.id,ok:false,error:error.message})
  }
})

async function control(command) {
  const tab=command.app?await openApp(command.app):current
  if (!tab) throw new Error('Open an app first.')
  if (command.action==='open') return {app:tab.app.id,name:tab.app.name,browserId}
  if (command.action==='tools') {
    if (!tab.tools.size && baseTools(tab).length) for (let i=0;i<20&&!tab.tools.size;i++) await new Promise(resolve=>setTimeout(resolve,100))
    return {app:tab.app.id,tools:baseTools(tab).map(tool=>({...tool,registered:tab.tools.has(tool.name)}))}
  }
  return invoke(tab,command.name,command.args)
}

function renderApps() {
  const query=$('search').value.trim().toLowerCase()
  const visible=apps.filter(app=>(app.name+' '+app.description).toLowerCase().includes(query))
  $('app-count').textContent=visible.length+' '+(visible.length===1?'app':'apps')
  $('apps').replaceChildren(...visible.map(app=>{
    const button=document.createElement('button')
    button.type='button'
    const number=document.createElement('span')
    number.className='app-number'
    number.setAttribute('aria-hidden','true')
    number.textContent=String(apps.indexOf(app)+1).padStart(2,'0')
    const title=document.createElement('strong')
    title.textContent=app.name
    const details=document.createElement('span')
    details.textContent=app.description
    const arrow=document.createElement('span')
    arrow.className='app-arrow'
    arrow.setAttribute('aria-hidden','true')
    arrow.textContent='↗'
    button.append(number,title,arrow,details)
    button.onclick=()=>openApp(app.id).catch(error=>notice(error.message))
    return button
  }))
  if (!visible.length) $('apps').textContent='No apps match your search.'
}

let activityCursor, pendingRequest, activityBusy=false
function activityTitle(entry) {
  return ({
    app_opened:'App opened',workspace_change:'Workspace changed',app_context:'App context',
    tool_completed:'Agent tool',user_request:'You',app_request:'App request',agent_reply:'Agent reply',
  })[entry.type] ?? 'Activity'
}
function renderActivity(entries) {
  const log=$('activity-log')
  for (const entry of entries) {
    const item=document.createElement('li')
    item.dataset.type=entry.type
    const heading=document.createElement('strong')
    const time=new Date(entry.time).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
    heading.textContent=activityTitle(entry)+' · '+time
    const body=document.createElement('div')
    const app=chooseApp(entry.app)?.name
    const {message,name,method,path,inReplyTo}=entry.payload
    if (entry.type==='agent_reply' && inReplyTo===pendingRequest) {
      $('request-status').textContent='Reply received'
      pendingRequest=undefined
    }
    body.textContent=message ?? [app,name === app ? null : name,method,path].filter(Boolean).join(' · ')
    item.append(heading,body)
    log.append(item)
  }
  while (log.children.length>40) log.firstElementChild.remove()
  $('activity-empty').hidden=log.children.length>0
  if (entries.length) log.scrollTop=log.scrollHeight
}
async function watchActivity() {
  if (activityBusy) return
  activityBusy=true
  try {
    while ($('agent-dialog').open) {
      const batch=await session('activity',{after:activityCursor,waitSeconds:activityCursor===undefined?0:15})
      renderActivity(batch.events)
      activityCursor=batch.nextCursor
    }
  } catch(error) {
    $('request-status').textContent=error.message
  } finally { activityBusy=false }
}

async function listen() {
  for (;;) {
    try {
      const command=await session('next')
      if (!command) continue
      let reply
      try {reply={ok:true,result:await control(command)}}
      catch(error) {reply={ok:false,error:error.message}}
      await session('complete',{id:command.id,...reply})
    } catch(error) {
      $('app-status').textContent='Reconnecting…'
      await new Promise(resolve=>setTimeout(resolve,1500))
      try {await connect()} catch { /* The next pass retries. */ }
    }
  }
}
async function connect() {
  const response=await fetch('/api/browser-token',{headers:{'X-App-Harness':'browser'}})
  if (!response.ok) throw new Error('Could not connect to the local harness.')
  token=(await response.json()).token
  await api('browser',{id:browserId,label:navigator.userAgent.includes('Claude')?'Claude':navigator.userAgent.includes('Codex')?'Codex':'Browser'})
}
function showActivity() {
  if ($('agent-dialog').open) return
  $('tool-summary').textContent=current?current.app.name+' has '+current.tools.size+' tools registered.':'Open an app to see its registered tools.'
  $('agent-dialog').show()
  void watchActivity()
}
async function start() {
  await connect()
  apps=await api('apps')
  $('browser-id').textContent=browserId
  renderApps()
  $('search').oninput=renderApps
  $('home').onclick=$('back').onclick=showCatalog
  $('connection').onclick=()=> $('agent-dialog').open ? $('agent-dialog').close() : showActivity()
  $('agent-request').onsubmit=async event=>{
    event.preventDefault()
    const message=$('agent-message').value.trim()
    const submit=event.submitter
    submit.disabled=true
    try {
      const queued=await session('user-request',{message})
      pendingRequest=queued.id
      $('agent-message').value=''
      $('request-status').textContent='Request queued'
      void watchActivity()
    } catch(error) { $('request-status').textContent=error.message }
    finally { submit.disabled=false }
  }
  $('files').onclick=async()=>{
    try {
      if (!current) throw new Error('Open an app first to work with workspace files.')
      await choose(current,'files')
    } catch(error) { notice(error.message) }
  }
  void listen()
  const app=new URL(location.href).searchParams.get('app')
  if (app) await openApp(app)
}
start().catch(error=>notice(error.message))

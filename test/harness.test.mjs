import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { serve } from '../lib/server.mjs'
import { Store, workspacePath } from '../lib/store.mjs'

test('workspace persists binary content and rejects a conflicting save atomically', () => {
  const root = mkdtempSync(join(tmpdir(),'harness-store-'))
  const file = join(root,'workspace.sqlite')
  let store = new Store(file)
  try {
    assert.throws(()=>workspacePath('/Workspace/../outside'),/inside/)
    const binary = Buffer.from([0,127,255])
    const draft = store.documents('drawing','createDraft',{title:'Demo',suffix:'.demo',kind:'package',files:[
      {name:'scene.json',content:'{"revision":2}'},{name:'asset.bin',base64:binary.toString('base64')},
    ]})
    assert.throws(()=>store.documents('drawing','autosave',{
      path:draft.path,revision:{file:'scene.json',field:'revision',expected:1},
      files:[{name:'asset.bin',content:'overwrite'}],
    }),/Document changed/)
    const first = store.storage('drawing',{fileName:'drawing.json',value:{shapes:[]},ifMatch:null},true)
    assert.equal(store.storage('drawing',{fileName:'drawing.json',value:{shapes:['bad']},ifMatch:null},true).conflict,true)
    store.close()
    store = new Store(file)
    assert.deepEqual(store.read(draft.path+'/asset.bin'),binary)
    assert.equal(store.storage('drawing',{fileName:'drawing.json'}).version,first.version)
  } finally {
    store.close()
    rmSync(root,{recursive:true,force:true})
  }
})

test('browser can load original app bytes, exchange commands, and return activity', async () => {
  const root=mkdtempSync(join(tmpdir(),'harness-server-'))
  const appsRoot=join(root,'apps')
  const stateDir=join(root,'state')
  const home=join(appsRoot,'sketch')
  const dist=join(home,'dist')
  mkdirSync(dist,{recursive:true})
  writeFileSync(join(home,'plugin.json'),JSON.stringify({id:'sketch',app:{name:'Fixture',slug:'sketch'}}))
  const html='<p>Original fixture</p>'
  writeFileSync(join(dist,'index.html'),html)
  const server=await serve({port:0,appsRoot,stateDir,apps:['sketch'],labels:{sketch:['Drawing','Draw shapes.']}})
  const {token}=JSON.parse(readFileSync(join(stateDir,'server.json'),'utf8'))
  const browser='test-browser'
  const api=async(path,data)=>{
    const response=await fetch(server.origin+'/api/'+path,{
      method:data===undefined?'GET':'POST',
      headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(data===undefined?{}:{body:JSON.stringify(data)}),
    })
    assert.equal(response.status,200)
    return response.json()
  }
  try {
    const blocked=await fetch(server.origin+'/api/browser-token',{
      headers:{'x-app-harness':'browser','sec-fetch-site':'same-site'},
    })
    assert.equal(blocked.status,403)
    assert.equal((await api('apps'))[0].name,'Drawing')
    await api('browser',{id:browser})
    const launch=await api('launch',{session:browser,app:'sketch'})
    assert.equal(await (await fetch(launch.origin)).text(),html)
    await api('ready',{session:browser,app:'sketch',ready:true})
    const command=api('control',{session:browser,app:'sketch',action:'call',name:'draw',args:{shape:'circle'}})
    const next=await api('next',{session:browser})
    assert.deepEqual(next.args,{shape:'circle'})
    await api('complete',{session:browser,id:next.id,ok:true,result:{drawn:true}})
    assert.deepEqual(await command,{drawn:true})

    await api('bridge',{session:browser,app:'sketch',method:'fs.write',args:['/Workspace/Drafts/demo','stroke']})
    const initial=await api('activity',{session:browser})
    assert.deepEqual(initial.events.map(event=>event.type),['app_opened','tool_completed','workspace_change'])
    const waiting=api('activity',{session:browser,after:initial.nextCursor,waitSeconds:2})
    const request=await api('user-request',{session:browser,message:'Make the line thicker.'})
    const result=await waiting
    assert.equal(result.events[0].payload.message,'Make the line thicker.')
    await api('agent-reply',{session:browser,message:'Done.',inReplyTo:request.id})
    const reply=await api('activity',{session:browser,after:result.nextCursor})
    assert.equal(reply.events[0].payload.inReplyTo,request.id)

    const bridge = (method,...args) => api('bridge',{session:browser,app:'sketch',method,args})
    const {result:thread}=await bridge('assistants.sessions.create',{title:'App thread'})
    await bridge('assistants.messages.send',{id:thread.id,input:{content:'Try a rectangle.'}})
    const native=(await api('activity',{session:browser,after:reply.nextCursor})).events[0]
    assert.equal(native.type,'app_request')
    await api('agent-reply',{session:browser,message:'Added one.',inReplyTo:native.id})
    const {result:messages}=await bridge('assistants.messages.list',thread.id)
    assert.deepEqual(messages.map(message=>message.content),['Try a rectangle.','Added one.'])
  } finally {
    await server.close()
    rmSync(root,{recursive:true,force:true})
  }
})

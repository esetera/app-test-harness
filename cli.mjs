import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'

const project = fileURLToPath(new URL('./',import.meta.url))
const dataDir = () => resolve(process.env.HARNESS_STATE ?? join(project,'.state'))
const state = () => JSON.parse(readFileSync(join(dataDir(),'server.json'),'utf8'))

export async function request(endpoint,data) {
  let server
  try { server=state() } catch { throw new Error('Start the harness with node cli.mjs start.') }
  let response
  try {
    response=await fetch(server.url+'/api/'+endpoint,{
      method:data===undefined?'GET':'POST',
      headers:{Authorization:'Bearer '+server.token,...(data===undefined?{}:{'Content-Type':'application/json'})},
      ...(data===undefined?{}:{body:JSON.stringify(data)}),
      signal:AbortSignal.timeout(46_000),
    })
  } catch { throw new Error('The harness did not respond. Check node cli.mjs status.') }
  const result=await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}

async function start(options) {
  const existing=await request('status').catch(()=>null)
  if (existing) {
    console.log(existing.url)
    if (options.foreground) {
      while (await request('status').catch(()=>null)) await sleep(3000)
    }
    return
  }
  const port=Number(options.port ?? process.env.PORT ?? 54916)
  if (!Number.isSafeInteger(port) || port<1024 || port>65535) throw new Error('Choose a port from 1024 to 65535.')
  const stateDir=dataDir()
  const configPath=resolve(project,'harness.config.json')
  let config={}
  try {config=JSON.parse(readFileSync(configPath,'utf8'))}
  catch(error) {if (error.code!=='ENOENT') throw error}
  const appsRoot=options['apps-root'] ?? process.env.HARNESS_APPS_ROOT ?? config.appsRoot
  if (!appsRoot) throw new Error('Set appsRoot in harness.config.json or pass --apps-root. See README.md.')
  const sourceBase=config.sourceBase
  if (sourceBase && new URL(sourceBase).protocol!=='https:') throw new Error('Use an HTTPS sourceBase.')
  if (!Array.isArray(config.apps) || !config.apps.length || !config.apps.every(app=>typeof app==='string')) {
    throw new Error('List app folder names in the apps array.')
  }
  if (options.foreground) {
    const {serve}=await import('./lib/server.mjs')
    const server=await serve({port,appsRoot:resolve(appsRoot),stateDir,themePath:process.env.HARNESS_THEME ?? config.themePath,apps:config.apps,labels:config.labels,builds:config.builds,sourceBase})
    console.log(server.origin)
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>server.close().finally(()=>process.exit(0)))
    return
  }
  mkdirSync(stateDir,{recursive:true,mode:0o700})
  const log=createWriteStream(join(stateDir,'server.log'),{flags:'a',mode:0o600})
  await new Promise((accept,reject)=>{log.once('open',accept);log.once('error',reject)})
  const command=['start','--foreground','--port',String(port),...(appsRoot?['--apps-root',resolve(appsRoot)]:[])]
  const processHandle=spawn(process.execPath,[fileURLToPath(import.meta.url),...command],
    {cwd:project,detached:true,stdio:['ignore',log.fd,log.fd]})
  const stopped=new Promise(resolve=>processHandle.once('exit',resolve))
  processHandle.unref()
  log.end()
  for (let i=0;i<40;i++) {
    const running=await request('status').catch(()=>null)
    if (running) { console.log(running.url); return }
    const exited=await Promise.race([stopped.then(()=>true),sleep(125).then(()=>false)])
    if (exited) break
  }
  throw new Error('The harness did not start. See '+join(stateDir,'server.log'))
}
async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{
    foreground:{type:'boolean'},port:{type:'string'},'apps-root':{type:'string'},browser:{type:'string'},
  }})
  const [action,app,name,args]=positionals
  if (action==='start') return start(values)
  let result
  if (action==='status') result=await request('status')
  else if (action==='apps') result=await request('apps')
  else if (action==='activity') result=await request('activity',{session:values.browser,...(app?{after:Number(app)}:{}),...(name?{waitSeconds:Number(name)}:{})})
  else if (action==='reply') result=await request('agent-reply',{session:values.browser,message:app,...(name?{inReplyTo:Number(name)}:{})})
  else if (['open','tools','call'].includes(action)) {
    if (action==='call' && !name) throw new Error('Give the app ID, tool name, and optional JSON arguments.')
    result=await request('control',{action,app,name,session:values.browser,args:args?JSON.parse(args):{}})
  } else {
    console.log('node cli.mjs start [--foreground] [--apps-root PATH] [--port PORT]\nnode cli.mjs status | apps\nnode cli.mjs activity [CURSOR] [WAIT_SECONDS] [--browser ID]\nnode cli.mjs reply MESSAGE [REQUEST_ID] [--browser ID]\nnode cli.mjs open | tools APP [--browser ID]\nnode cli.mjs call APP TOOL \'{"argument":"value"}\' [--browser ID]')
    return
  }
  console.log(JSON.stringify(result,null,2))
  if (result?.isError) process.exitCode=1
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{
  console.error(error.message)
  process.exitCode=1
})

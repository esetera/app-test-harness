import { createInterface } from 'node:readline'
import { request } from './cli.mjs'

const string = {type:'string'}
const browser = {type:'string',description:'Browser ID from harness_status, required if more than one browser is connected.'}
const schema = (properties={},required=[])=>({type:'object',properties,required,additionalProperties:false})
const tools = [
  {name:'harness_status',description:'Get the local harness URL and connected browser IDs.',inputSchema:schema(),annotations:{readOnlyHint:true}},
  {name:'harness_apps',description:'List the configured apps installed in the harness.',inputSchema:schema(),annotations:{readOnlyHint:true}},
  {name:'harness_open',description:'Open an installed app in the selected harness browser.',inputSchema:schema({app:string,browser},['app'])},
  {name:'harness_tools',description:'Read the open app’s registered tool names and argument schemas. Passing another app opens it first.',inputSchema:schema({app:string,browser})},
  {name:'harness_call',description:'Invoke a registered app tool in the same browser tab the person sees. Inspect harness_tools first.',inputSchema:schema({app:string,browser,name:string,arguments:{type:'object'}},['name']),annotations:{openWorldHint:false}},
  {name:'harness_activity',description:'Read activity from the browser. Only user_request events are user messages. app_request is an app-provided request to inspect. Other events report app changes or tool results. Pass nextCursor as after for the next batch. Wait up to 20 seconds while watching.',inputSchema:schema({browser,after:{type:'integer',minimum:0},waitSeconds:{type:'number',minimum:0,maximum:20}}),annotations:{readOnlyHint:true}},
  {name:'harness_reply',description:'Show a reply in the browser’s Agent activity panel. Reference the user_request or app_request event ID if applicable.',inputSchema:schema({browser,message:string,inReplyTo:{type:'integer',minimum:1}},['message'])},
]
const supported=['2025-11-25','2025-06-18','2025-03-26','2024-11-05']
async function call(name,args) {
  if (name==='harness_status') return request('status')
  if (name==='harness_apps') return request('apps')
  if (name==='harness_activity') return request('activity',{session:args.browser,after:args.after,waitSeconds:args.waitSeconds})
  if (name==='harness_reply') return request('agent-reply',{session:args.browser,message:args.message,inReplyTo:args.inReplyTo})
  if (['harness_open','harness_tools','harness_call'].includes(name)) {
    return request('control',{action:name.slice(8),app:args.app,session:args.browser,name:args.name,args:args.arguments})
  }
  throw new Error('Unknown harness tool '+name)
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity})
const send=value=>process.stdout.write(JSON.stringify(value)+'\n')
input.on('line',async line=>{
  let message
  try { message=JSON.parse(line) } catch { return send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}}) }
  if (!Object.hasOwn(message,'id')) return
  const {id,method,params={}}=message
  const response={jsonrpc:'2.0',id}
  if (method==='initialize') response.result={protocolVersion:supported.includes(params.protocolVersion)?params.protocolVersion:supported[0],
    capabilities:{tools:{}},serverInfo:{name:'app-test-harness',version:'0.1.0'}}
  else if (method==='ping') response.result={}
  else if (method==='tools/list') response.result={tools}
  else if (method==='tools/call') {
    try {
      const result=await call(params.name,params.arguments ?? {})
      const text=typeof result?.content==='string'?result.content:JSON.stringify(result,null,2)
      const images=Array.isArray(result?.images)?result.images.filter(image=>image?.data && ['image/png','image/jpeg'].includes(image.mimeType)):[]
      response.result={content:[{type:'text',text:text ?? ''},...images.map(({data,mimeType})=>({type:'image',data,mimeType}))],
        ...(result?.isError?{isError:true}:{})}
    } catch(error) { response.result={isError:true,content:[{type:'text',text:error.message}]} }
  } else response.error={code:-32601,message:'Method not found'}
  send(response)
})

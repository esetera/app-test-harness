import { randomUUID } from 'node:crypto'

export function conversations(store, record) {
  const key = (app, session) => session.id + '/' + app.slug
  const all = (app,session) => store.settings(key(app,session),'conversations')
  const get = (app,session,id) => {
    const threads = all(app,session)
    return Object.hasOwn(threads,id) ? threads[id] : null
  }
  const snapshot = (thread) => {
    if (!thread) return null
    const {messages, ...summary} = thread
    return summary
  }
  const update = (app,session,thread) => store.settings(key(app,session),'conversations',{[thread.id]:thread})
  const create = (app,session,options={}) => {
    const now = new Date().toISOString()
    const thread = {
      id:randomUUID(),appId:app.slug,parentSessionId:null,title:String(options.title || app.name).slice(0,120),
      context:null,createdAt:now,updatedAt:now,state:'idle',active:false,messages:[],
    }
    update(app,session,thread)
    return snapshot(thread)
  }
  function addMessage(app,session,id,content,role) {
    const thread = get(app,session,id)
    if (!thread) throw new Error('The app conversation is not open in this browser.')
    const createdAt = new Date().toISOString()
    const message = {id:randomUUID(),sessionId:id,role,content,createdAt,attachments:[],
      modelId:null,resultForToolCallId:null,toolCallIds:[],reasoning:null}
    thread.updatedAt = createdAt
    thread.state = role==='user' ? 'pendingCall' : 'idle'
    thread.messages = [...thread.messages,message].slice(-40)
    update(app,session,thread)
    return snapshot(thread)
  }
  return {
    methods:{
      'assistants.sessions.get': (app,[id],session)=>snapshot(get(app,session,id)),
      'assistants.sessions.list': (app,_,session)=>Object.values(all(app,session)).map(snapshot),
      'assistants.sessions.create': (app,[options],session)=>create(app,session,options),
      'assistants.sessions.open': (app,_,session)=>snapshot(Object.values(all(app,session)).at(-1)) ?? create(app,session),
      'assistants.messages.list': (app,[id],session)=>get(app,session,id)?.messages ?? [],
      'assistants.messages.send': (app,[request],session)=>{
        const content = typeof request?.input?.content==='string' ? request.input.content.trim() : ''
        if (!content || content.length>4000) throw new Error('Write between 1 and 4,000 characters.')
        const thread=addMessage(app,session,request.id,content,'user')
        record(session,'app_request',{message:content,thread:thread.id,attachments:Array.isArray(request.input.attachments)?request.input.attachments.length:0})
        return thread
      },
    },
    reply(app,session,id,content) {
      addMessage(app,session,id,content,'assistant')
    },
  }
}

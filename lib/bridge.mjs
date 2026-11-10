import { posix } from 'node:path'
import { mime, workspacePath } from './store.mjs'

export function bridgeHandlers(store, apps, preview) {
  const empty = () => []
  const nullable = () => null
  const ok = () => ({ok:true})
  const pathOf = value => typeof value === 'string' ? value : value?.path
  const appKey = (app, value) => apps.find(other => [other.id,other.slug,other.manifest.id,other.manifest.app?.id].includes(value))?.slug ?? app.slug
  const fileName = name => {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error('Give a plain file name.')
    return name
  }
  const destination = (path, name) => posix.dirname(workspacePath(path)) + '/' + fileName(name)
  const documents = (app, method, request = {}) => store.documents(app.slug, method, request)
  const bytes = (path, limit, text = false) => {
    const file = store.read(path)
    const part = file.subarray(0, Number.isFinite(limit) && limit > 0 ? limit : file.length)
    return {path,mimeType:mime(path),byteLength:file.length,truncated:part.length < file.length,
      ...(text ? {content:part.toString()} : {base64:part.toString('base64')})}
  }
  const renameDocument = (request, folder, copy = false) => {
    const path = workspacePath(request.path)
    const suffix = request.suffix ?? posix.extname(path)
    const title = request.title ? fileName(request.title) : posix.basename(path, suffix) + (copy ? ' copy' : '')
    const target = workspacePath(folder) + '/' + (title.endsWith(suffix) ? title : title + suffix)
    return target === path ? {path} : store.move(path,target,copy)
  }
  return {
    'runtime.platform': ()=>'web',
    'runtime.version': ()=>'0.1.0',
    'apps.list': ()=>apps.map(app=>({manifest:app.manifest,settings:store.settings(app.slug,'app'),config:{enabled:true},root:'/Workspace',devUrl:null})),
    'apps.get': (app, [id])=> {
      const item = apps.find(other=>other.slug===appKey(app,id))
      return item ? {manifest:item.manifest,settings:store.settings(item.slug,'app'),config:{enabled:true},root:'/Workspace',devUrl:null} : null
    },
    'settings.app.get': (app,[id])=>({platformAppearance:'white',...store.settings(appKey(app,id),'app')}),
    'settings.app.update': (app,[request={}])=>store.settings(app.slug,'app',request.patch ?? request),
    'settings.prefs.get': (app)=>({...store.settings(app.slug,'prefs'),workingDirectory:'/Workspace',workspaceRoot:'/Workspace'}),
    'settings.prefs.set': (app,[patch])=>store.settings(app.slug,'prefs',patch),
    'storage.readJson': (app,[request])=>store.storage(app.slug,request),
    'storage.writeJson': (app,[request])=>store.storage(app.slug,request,true),
    'fs.list': (_,[input])=> {
      const rootPath = workspacePath(input?.rootPath ?? pathOf(input) ?? '/Workspace')
      return {rootPath,parentPath:rootPath==='/Workspace'?null:posix.dirname(rootPath),entries:store.list(rootPath)}
    },
    'fs.stat': (_,[path])=>store.entry(pathOf(path)),
    'fs.exists': (_,[path])=>store.exists(pathOf(path)),
    'fs.read': (_,[path])=>store.read(pathOf(path)).toString(),
    'fs.write': (_,[path,content])=>store.write(pathOf(path),content ?? path?.content ?? ''),
    'fs.readPreview': (_,[request])=>bytes(pathOf(request),request?.maxBytes ?? 65_536,true),
    'fs.readBinary': (_,[request])=>bytes(pathOf(request),request?.maxBytes),
    'fs.writeBinary': (_,[request])=>store.write(request.path,Buffer.from(request.base64,'base64')),
    'fs.previewUrl': (_,[request])=>({...store.entry(pathOf(request)),url:preview(pathOf(request))}),
    'fs.createFolder': (_,[request])=> {
      const path = store.mkdir(workspacePath(request.parentPath) + '/' + fileName(request.name))
      return {path,entry:store.entry(path)}
    },
    'fs.rename': (_,[request])=>store.move(request.path,destination(request.path,request.name)),
    'fs.delete': (_,[request])=>store.transaction(()=>store.remove(request.path,!!request.recursive)),
    'documents.createDraft': (app,[request])=>documents(app,'createDraft',request),
    'documents.autosave': (app,[request])=>documents(app,'autosave',request),
    'documents.list': (app,[request])=>documents(app,'list',request),
    'documents.rename': (_,[request])=>renameDocument(request,posix.dirname(workspacePath(request.path))),
    'documents.promote': (_,[request])=>renameDocument(request,request.targetDir ?? '/Workspace/Documents'),
    'documents.duplicate': (_,[request])=>renameDocument(request,posix.dirname(workspacePath(request.path)),true),
    'documents.suggestLocation': ()=>({dir:'/Workspace/Documents'}),
    'documents.objects.list': (app,[request={}])=> {
      const requested = apps.find(item=>item.slug===appKey(app,request.appSlug))
      return documents(app,'list',{suffixes:requested?.manifest.app?.openableNameSuffixes ?? []}).map(row=>row.path)
    },
    'documents.objects.register': nullable,
    'documents.recents.touch': (app,[request])=> {
      const recents = store.settings(app.slug,'recents').items ?? []
      store.settings(app.slug,'recents',{items:[{...request,touchedAt:new Date().toISOString()},...recents.filter(item=>item.path!==request.path)].slice(0,50)})
      return ok()
    },
    'documents.recents.list': (app,[request={}])=>(store.settings(app.slug,'recents').items ?? []).slice(0,request.limit ?? 20),
    ...Object.fromEntries(['collections','list','get','set','delete'].map(name=>['apps.data.'+name,(app,[request={}])=>store.data(app.slug,name,request)])),
    'catalog.manifest': ()=>({apps:apps.map(app=>app.manifest.app)}),
    'catalog.consumePendingOpen': nullable,
    'workspace.adjacentApp': nullable,
    'workspace.settings.opened': ok,
    'theme.setSurfacePalette': ok,
    'agents.llm.menuOptions': empty,
    'agents.activity.present': ()=>({hosted:false}),
    'credentials.status': (_,[request={}])=>({id:request.id,configured:false,connected:false,scopes:[],needsReconnect:false}),
    'assistants.config.tools': app=>app.manifest.app?.agents?.tools ?? [],
    'assistants.vision.models.list': empty,
    'context.publish': ok,
    'context.clear': ok,
    'assets.list': empty,
    'assets.listScoped': empty,
    'assets.getSelected': nullable,
    'mytools.list': empty,
    'shared.list': empty,
    'shared.status': nullable,
    'managed.get': nullable,
    'collab.active': empty,
    'collab.people': empty,
    'people.providers.list': empty,
    'teamCalendar.list': empty,
  }
}

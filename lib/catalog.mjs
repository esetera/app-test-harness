import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export function catalog(root, {apps: included, sourceBase, labels = {}} = {}) {
  const apps = []
  for (const folder of readdirSync(root)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(folder) || (included && !included.includes(folder))) continue
    const home = realpathSync(resolve(root, folder))
    const file = join(home, 'plugin.json')
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const entry = manifest.entrypoint
    const built = entry?.kind === 'built-static' && typeof entry.dir === 'string'
      ? resolve(home, entry.dir) : join(home, 'dist')
    if (!built.startsWith(home + sep) || !existsSync(join(built, 'index.html'))) continue
    const builtRoot = realpathSync(built)
    if (!builtRoot.startsWith(home + sep)) continue
    const [label, description] = labels[folder] ?? []
    apps.push({
      id: folder, slug: manifest.app?.slug ?? manifest.id, name: label ?? manifest.app?.navigationLabel ?? manifest.app?.name ?? manifest.name ?? folder,
      description: description ?? manifest.app?.description ?? '', root: builtRoot, manifest,
      source: sourceBase ? new URL(encodeURIComponent(folder), sourceBase.replace(/\/?$/, '/')).href : null,
    })
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name))
}

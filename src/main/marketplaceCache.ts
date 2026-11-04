// Marketplace templates' files on this machine: one folder per server, template and version, so the
// files an install reads are always the version it was listed as, whatever is fetched or listed meanwhile.
// A version's folder is written once, whole (it is swapped in from a .part folder), and never changed.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LIMITS, safePath, type TemplateBundle } from '@shared/marketplaceApi'

export interface BundleCache {
  /** Where a version's files are, fetched or not. */
  readonly dirOf: (id: string, version: number) => string
  /** That version's folder, with its files: fetched when missing. Asking twice while one fetch is on its way waits for it; another version never does. */
  readonly ensure: (item: { id: string; version: number; name: string }) => Promise<string>
  /** Drop every version but the listed ones. Only when nothing can be reading them: at start-up. */
  readonly prune: (listed: { id: string; version: number }[]) => void
}

export function bundleCache(opts: { root: string; api: string; fetch: (id: string, version: number) => Promise<TemplateBundle> }): BundleCache {
  const dirOf = (id: string, version: number) => join(opts.root, id, `v${version}`)
  const marker = (version: number) => `${opts.api}@${version}`
  const fetching = new Map<string, Promise<string>>()

  const download = async (item: { id: string; version: number; name: string }) => {
    const dir = dirOf(item.id, item.version)
    const bundle = await opts.fetch(item.id, item.version)
    if (bundle.version !== item.version) throw new Error(`${item.name}: the marketplace sent version ${bundle.version} for version ${item.version}; refresh the marketplace and try again`)
    if (!Array.isArray(bundle.files) || bundle.files.length > LIMITS.files) throw new Error(`${item.name}: the marketplace sent ${bundle.files?.length ?? 'no'} files`)
    const part = `${dir}.part-${process.pid}-${Date.now()}`
    await rm(part, { recursive: true, force: true })
    try {
      let bytes = 0
      for (const f of bundle.files) {
        // Paths are the server's word: only plain relative ones, so nothing lands outside the folder.
        if (!safePath(f.path)) throw new Error(`${item.name} has a file the app will not write: ${JSON.stringify(f.path)}`)
        const data = 'text' in f ? Buffer.from(f.text, 'utf8') : Buffer.from(f.base64, 'base64')
        if ((bytes += data.length) > LIMITS.bytes) throw new Error(`${item.name} is over ${LIMITS.bytes / 1e6} MB`)
        await mkdir(dirname(join(part, f.path)), { recursive: true })
        await writeFile(join(part, f.path), data)
      }
      if (!existsSync(join(part, 'manifest.json'))) throw new Error(`${item.name} came without its manifest.json`)
      await writeFile(join(part, '.version'), marker(bundle.version))
      await rm(dir, { recursive: true, force: true })
      await rename(part, dir)
      return dir
    } catch (e) {
      await rm(part, { recursive: true, force: true })
      throw e
    }
  }

  const ensure: BundleCache['ensure'] = async (item) => {
    const dir = dirOf(item.id, item.version)
    const stamp = join(dir, '.version')
    if (existsSync(stamp) && readFileSync(stamp, 'utf8') === marker(item.version)) return dir
    // Keyed by version too: a fetch of another version is no answer to this one.
    const key = `${item.id}@${item.version}`
    let p = fetching.get(key)
    if (!p) {
      p = download(item).finally(() => fetching.delete(key))
      fetching.set(key, p)
    }
    return p
  }

  const prune: BundleCache['prune'] = (listed) => {
    if (!existsSync(opts.root)) return
    const keep = new Map(listed.map((t) => [t.id, `v${t.version}`]))
    for (const id of readdirSync(opts.root)) {
      const want = keep.get(id)
      if (!want) {
        rmSync(join(opts.root, id), { recursive: true, force: true })
        continue
      }
      for (const v of readdirSync(join(opts.root, id))) if (v !== want) rmSync(join(opts.root, id, v), { recursive: true, force: true })
    }
  }

  return { dirOf, ensure, prune }
}

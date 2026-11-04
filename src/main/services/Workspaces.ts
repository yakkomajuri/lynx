// A workspace is a folder: workspace.json (name, connector bindings) and App.jsx (the whole UI).
// The folder is bundled with esbuild on every save; a good build replaces what is on screen, a bad
// one leaves the last good bundle running and reports the errors.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { Context, Effect, Layer } from 'effect'
import * as esbuild from 'esbuild'
import { NATIVE_AGENTS, NATIVE_APP, type BuildState, type Uses, type WorkspaceConfig, type WorkspaceInfo } from '@shared/types'
import { Config } from './Config'
import { Events } from './Events'
import { confine } from './confine'
import { follow, type Following } from '../watch'
import { freeName as freeNameAmong, sameName } from '@shared/workspaceNames'

export interface CreateInput {
  name: string
  icon?: string
  color?: string
  description?: string
  connectors?: Record<string, string>
  /** The manifest. Left out, the workspace may use every tool of the connectors it is bound to, and nothing else. */
  uses?: Uses
  /** Text, or bytes for anything else (images, fonts). */
  files?: Record<string, string | Uint8Array>
  origin?: string
}

export interface WorkspacesShape {
  readonly list: () => WorkspaceInfo[]
  readonly get: (id: string) => WorkspaceInfo | undefined
  readonly create: (input: CreateInput) => Effect.Effect<WorkspaceInfo, Error>
  readonly update: (id: string, patch: Partial<Pick<WorkspaceConfig, 'name' | 'icon' | 'color' | 'description' | 'connectors' | 'uses' | 'archived' | 'home' | 'onboarding'>>) => Effect.Effect<WorkspaceInfo, Error>
  /** Put the workspaces in this order. Ones left out keep their place after the ones named. */
  readonly reorder: (ids: string[]) => Effect.Effect<string[], Error>
  readonly remove: (id: string) => Effect.Effect<boolean, Error>
  /** Copy a workspace. Without a name, the copy is called "<name> copy" (or "<name> copy 2", ...). */
  readonly fork: (id: string, name?: string) => Effect.Effect<WorkspaceInfo, Error>
  /** The name itself if no workspace has it yet, else the name with the first free number after it. */
  readonly freeName: (name: string) => string
  /** Why this name cannot be given to a workspace (`except` is the one being renamed), or undefined if it can. */
  readonly nameTaken: (name: string, except?: string) => string | undefined
  /**
   * Run f with no other name change in flight, so a name checked inside it is still free when it is
   * written. Whatever writes a workspace.json elsewhere (publishing a draft, reverting) does it in here,
   * then calls reload.
   */
  readonly naming: <A>(f: () => Promise<A>) => Promise<A>
  /** Read a workspace's workspace.json again now, rather than when the folder watcher notices. Call it inside naming. */
  readonly reload: (id: string) => Promise<void>
  /** The last good bundle. Builds (and starts watching) on first use. */
  readonly bundle: (id: string) => Effect.Effect<{ js: string; css: string; version: number }, Error>
  /** Resolves when no build is in flight, with the result of the latest one. */
  readonly settled: (id: string) => Effect.Effect<BuildState, Error>
  /** Build a folder of workspace code once, as a workspace would be, without putting it on screen: a draft, before it is published. */
  readonly check: (dir: string) => Effect.Effect<{ status: 'ok' | 'error'; errors: string[] }, Error>
  readonly files: (id: string) => Effect.Effect<Record<string, string>, Error>
  /** Every file in the folder, for reading on screen: one that is binary or over 2 MB comes without text. */
  readonly source: (id: string) => Effect.Effect<{ files: { path: string; text: string | null; size: number }[] }, Error>
  /** Rewrite a piece of visible text in the source, only when exactly one place in the code can be meant. */
  readonly editText: (id: string, before: string, after: string) => Effect.Effect<{ applied: true; file: string; line: number } | { applied: false; reason: string }, Error>
  readonly reportRuntimeError: (id: string, error: string | null) => void
  /** The window holds a new version off screen while the user is busy in the workspace (its number), or holds none (null). */
  readonly reportHeld: (id: string, version: number | null) => void
}

export class Workspaces extends Context.Service<Workspaces, WorkspacesShape>()('Workspaces') {}

export const BLANK_APP = `import { Page, Card, Button, askAgent } from 'lynx'

export default function App() {
  return (
    <Page title="New workspace" subtitle="This page is App.jsx in the workspace folder.">
      <Card title="Start here">
        <p>Open the agent (⌘T) and describe what this workspace should show. It can use any connector you have added.</p>
        <Button onClick={() => askAgent('Build this workspace: ')}>Ask the agent</Button>
      </Card>
    </Page>
  )
}
`

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'workspace'
/** A manifest as written by hand or by an agent, made safe to read: connector name -> "*" or a list of tool names. */
export const cleanUses = (raw: unknown): Uses => {
  const out: Uses = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [connector, tools] of Object.entries(raw)) {
    if (tools === '*') out[connector] = '*'
    else if (Array.isArray(tools)) out[connector] = tools.includes('*') ? '*' : tools.filter((t): t is string => typeof t === 'string')
  }
  return out
}
const everyToolOf = (connectors: string[]): Uses => Object.fromEntries(connectors.map((c) => [c, '*' as const]))

// .agent-attachments holds the files a user gave the workspace's agent (agentd puts them there).
const IGNORED = /^(\.data|\.git|\.agent-attachments|node_modules)(\/|$)|(^|\/)\.DS_Store$/
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: asError })

interface Builder {
  state: BuildState
  good?: { js: string; css: string; version: number }
  ctx?: esbuild.BuildContext
  watcher?: Following
  running: Promise<void>
  timer?: NodeJS.Timeout
}

export const WorkspacesLive = Layer.effect(Workspaces)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const events = yield* Events
    const root = cfg.workspacesDir
    const kit = join(cfg.appRoot, 'src', 'kit', 'index.tsx')
    const guide = () => readFileSync(join(cfg.appRoot, 'resources', 'KIT.md'), 'utf8')
    const configs = new Map<string, WorkspaceConfig>()
    const builders = new Map<string, Builder>()
    const changed = () => Effect.runSync(events.changed)
    const writeConfig = (id: string, c: WorkspaceConfig) => writeFile(join(root, id, 'workspace.json'), JSON.stringify(c, null, 2) + '\n')

    // Archived workspaces count: bringing one back must not make two of a name.
    const holder = (name: string, except?: string) => [...configs].find(([id, c]) => id !== except && sameName(c.name ?? '', name))
    const nameTaken: WorkspacesShape['nameTaken'] = (name, except) => {
      const h = holder(name, except)
      return h && `There is already a workspace named “${h[1].name}”${h[1].archived ? ' (archived)' : ''} (${h[0]}). Pick another name.`
    }
    // Name changes take turns: between checking a name and writing it, no other can claim it.
    let names: Promise<unknown> = Promise.resolve()
    const naming: WorkspacesShape['naming'] = (f) => {
      const run = names.then(f)
      names = run.catch(() => undefined)
      return run
    }

    /** Read a workspace.json into configs. Resolves once any rewrite of the file it makes is on disk. */
    const load = (id: string): Promise<void> => {
      const before = configs.get(id)
      let read: WorkspaceConfig
      try {
        read = JSON.parse(readFileSync(join(root, id, 'workspace.json'), 'utf8')) as WorkspaceConfig
      } catch {
        // A file caught half-saved, or unreadable for a moment, does not drop the workspace: it keeps
        // the config it had (and its name with it) until the file reads again. Only a folder that
        // is gone takes the workspace with it.
        if (!before || !existsSync(join(root, id))) configs.delete(id)
        return Promise.resolve()
      }
      try {
        // A name changed on disk (by hand, by a draft) onto one another workspace has does not take:
        // the workspace keeps the name it had, and its file says so again. Names that were shared
        // before the rule are left alone.
        const clash = before && !sameName(before.name ?? '', read.name ?? '') && holder(read.name ?? '', id)
        const c = clash ? { ...read, name: before.name } : read
        const connectors = c.connectors ?? {}
        // A workspace from before manifests keeps working: it is given one that allows what it
        // could already do, written into its workspace.json where it can be narrowed.
        const migrated = c.uses === undefined
        const next = { ...c, connectors, uses: migrated ? everyToolOf([...Object.keys(connectors), NATIVE_APP, NATIVE_AGENTS]) : cleanUses(c.uses) }
        configs.set(id, next)
        // Both corrections go back to the file in one write: two at once could interleave into broken JSON.
        return clash || migrated ? writeConfig(id, migrated ? next : c).catch(() => undefined) : Promise.resolve()
      } catch {
        if (!before) configs.delete(id)
        return Promise.resolve()
      }
    }
    for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) load(e.name)
    // The guide travels with every workspace so an agent working in the folder always has the current one.
    for (const id of configs.keys()) void writeFile(join(root, id, 'KIT.md'), guide()).catch(() => undefined)

    const info = (id: string): WorkspaceInfo | undefined => {
      const c = configs.get(id)
      return c && { ...c, id, dir: join(root, id), build: builders.get(id)?.state ?? { version: 0, status: 'building', errors: [] } }
    }
    // The order the user dragged them into. It is theirs, not the workspace's, so it is kept beside
    // the folders, not in each workspace.json. A workspace it does not name comes after, oldest first.
    const orderFile = join(cfg.dataDir, 'workspace-order.json')
    let order: string[] = []
    try {
      const saved = JSON.parse(readFileSync(orderFile, 'utf8'))
      if (Array.isArray(saved)) order = saved.filter((id): id is string => typeof id === 'string')
    } catch {
      /* never rearranged */
    }
    // A workspace that is gone leaves the order, so one made later under the same id goes to the end, not to its place.
    const forget = (id: string) => {
      if (!order.includes(id)) return
      order = order.filter((x) => x !== id)
      writeFileSync(orderFile, JSON.stringify(order, null, 2) + '\n')
    }
    const list = () => {
      const place = new Map(order.map((id, i) => [id, i]))
      return [...configs.keys()]
        .map((id) => info(id)!)
        .sort((a, b) => (place.get(a.id) ?? Infinity) - (place.get(b.id) ?? Infinity) || a.createdAt.localeCompare(b.createdAt))
    }
    const need = (id: string) => {
      const i = info(id)
      if (!i) throw new Error(`No workspace named ${id}`)
      return i
    }

    const options = (dir: string): esbuild.BuildOptions => ({
      stdin: { contents: `import App from './App'\nimport { mount } from 'lynx'\nmount(App)\n`, resolveDir: dir, loader: 'jsx', sourcefile: 'lynx-entry.jsx' },
      bundle: true,
      write: false,
      outdir: join(dir, '.out'),
      format: 'iife',
      platform: 'browser',
      target: 'chrome130',
      jsx: 'automatic',
      alias: { lynx: kit },
      nodePaths: [join(cfg.appRoot, 'node_modules')],
      define: { 'process.env.NODE_ENV': '"development"' },
      loader: { '.js': 'jsx', '.png': 'dataurl', '.jpg': 'dataurl', '.gif': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.md': 'text', '.txt': 'text' },
      logLevel: 'silent',
      plugins: [confine(dir, cfg.appRoot, 'workspace')],
    })
    const failure = async (e: unknown, dir: string) => {
      const errors = (e as esbuild.BuildFailure).errors
      const text = errors?.length ? await esbuild.formatMessages(errors, { kind: 'error', color: false }) : [asError(e).message]
      return text.map((t) => t.trim().replaceAll(dir + sep, ''))
    }

    const build = async (id: string, b: Builder) => {
      const dir = join(root, id)
      b.state = { ...b.state, status: 'building' }
      try {
        b.ctx ??= await esbuild.context(options(dir))
        const result = await b.ctx.rebuild()
        const out = (ext: string) => result.outputFiles?.find((f) => f.path.endsWith(ext))?.text ?? ''
        const version = b.state.version + 1
        b.good = { js: out('.js'), css: out('.css'), version }
        // A version the window holds off screen still does until it says otherwise.
        b.state = { version, status: 'ok', errors: [], builtAt: new Date().toISOString(), held: b.state.held }
      } catch (e) {
        b.state = { ...b.state, status: 'error', errors: await failure(e, dir) }
      }
      // Not `changed`: the window pushes the new state for this, marked as only a build.
      Effect.runSync(events.publish({ t: 'built', workspace: id, build: b.state }))
    }

    const builder = (id: string): Builder => {
      need(id)
      let b = builders.get(id)
      if (b) return b
      b = { state: { version: 0, status: 'building', errors: [] }, running: Promise.resolve() }
      builders.set(id, b)
      const self = b
      const kick = () => (self.running = self.running.then(() => build(id, self)))
      kick()
      // A change with no file name may have been anything: workspace.json read again, and a build.
      self.watcher = follow(join(root, id), { recursive: true, label: `workspace ${id}` }, (file) => {
        if (file !== null && (IGNORED.test(file.split(sep).join('/')) || file === 'KIT.md')) return
        // A reload can change the name, so it waits its turn behind a create or rename half done.
        if (file === null || file === 'workspace.json')
          void naming(async () => {
            await load(id)
            changed()
          })
        clearTimeout(self.timer)
        self.timer = setTimeout(kick, 120)
      })
      return b
    }
    const stop = async (id: string) => {
      const b = builders.get(id)
      builders.delete(id)
      clearTimeout(b?.timer)
      b?.watcher?.close()
      await b?.ctx?.dispose().catch(() => undefined)
    }

    const mustBeFree = (name: string, except?: string) => {
      const why = nameTaken(name, except)
      if (why) throw new Error(why)
    }
    const freeName: WorkspacesShape['freeName'] = (name) => freeNameAmong(name, [...configs.values()].map((c) => c.name ?? ''))

    const create: WorkspacesShape['create'] = (input) =>
      attempt(() => naming(async () => {
        if (!input.name?.trim()) throw new Error('A workspace needs a name')
        mustBeFree(input.name)
        let id = slug(input.name)
        for (let n = 2; existsSync(join(root, id)); n++) id = `${slug(input.name)}-${n}`
        const dir = join(root, id)
        // The blank starter only when no entry point was given: App.jsx would win over a template's App.js.
        const entry = Object.keys(input.files ?? {}).some((p) => /^App\.(jsx|tsx|js|ts)$/.test(p))
        const files = { ...(entry ? {} : { 'App.jsx': BLANK_APP }), ...input.files, 'KIT.md': guide() }
        for (const [path, text] of Object.entries(files)) {
          if (path.split(/[\\/]/).includes('..') || path.startsWith('/') || path.startsWith('.data')) throw new Error(`Bad file path ${path}`)
          await mkdir(dirname(join(dir, path)), { recursive: true })
          await writeFile(join(dir, path), text)
        }
        const c: WorkspaceConfig = { name: input.name.trim(), icon: input.icon, color: input.color, description: input.description, connectors: input.connectors ?? {}, uses: input.uses ? cleanUses(input.uses) : everyToolOf(Object.keys(input.connectors ?? {})), origin: input.origin, createdAt: new Date().toISOString() }
        await writeConfig(id, c)
        forget(id)
        configs.set(id, c)
        builder(id)
        changed()
        return info(id)!
      }))

    const update: WorkspacesShape['update'] = (id, patch) =>
      attempt(() => naming(async () => {
        const { id: _i, dir: _d, build: _b, ...c } = need(id)
        if (patch.name !== undefined && !String(patch.name).trim()) throw new Error('A workspace needs a name')
        if (patch.name !== undefined) mustBeFree(String(patch.name), id)
        const next: WorkspaceConfig = { ...c, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), ...(patch.name === undefined ? {} : { name: String(patch.name).trim() }), ...(patch.uses === undefined ? {} : { uses: cleanUses(patch.uses) }), ...(patch.archived === undefined ? {} : { archived: patch.archived ? true : undefined }) }
        await writeConfig(id, next)
        configs.set(id, next)
        changed()
        return info(id)!
      }))

    const reorder: WorkspacesShape['reorder'] = (ids) =>
      attempt(async () => {
        const named = [...new Set(ids)]
        const unknown = named.find((id) => !configs.has(id))
        if (unknown !== undefined) throw new Error(`No workspace named ${unknown}`)
        order = [...named, ...list().map((w) => w.id).filter((id) => !named.includes(id))]
        writeFileSync(orderFile, JSON.stringify(order, null, 2) + '\n')
        changed()
        return order
      })

    const remove: WorkspacesShape['remove'] = (id) =>
      attempt(async () => {
        const c = configs.get(id)
        if (!c) return false
        if (c.home) throw new Error(`${c.name} is the home workspace: it can be renamed, changed or archived, but not deleted`)
        await stop(id)
        configs.delete(id)
        forget(id)
        await rm(join(root, id), { recursive: true, force: true })
        // Its drafts are worktrees of the repository just removed.
        await rm(join(cfg.dataDir, 'drafts', id), { recursive: true, force: true })
        changed()
        return true
      })

    const fork: WorkspacesShape['fork'] = (id, wanted) =>
      attempt(() => naming(async () => {
        const from = need(id)
        if (wanted !== undefined && !wanted.trim()) throw new Error('A workspace needs a name')
        const name = wanted === undefined ? freeName(`${from.name} copy`) : wanted.trim()
        mustBeFree(name)
        let next = slug(name)
        for (let n = 2; existsSync(join(root, next)); n++) next = `${slug(name)}-${n}`
        await cp(from.dir, join(root, next), { recursive: true, verbatimSymlinks: true, filter: (src) => !IGNORED.test(relative(from.dir, src).split(sep).join('/')) })
        const c: WorkspaceConfig = { name, icon: from.icon, color: from.color, description: from.description, connectors: { ...from.connectors }, uses: structuredClone(from.uses), origin: from.origin, createdAt: new Date().toISOString() }
        await writeConfig(next, c)
        forget(next)
        configs.set(next, c)
        builder(next)
        changed()
        return info(next)!
      }))

    const walk = async (dir: string, base = dir): Promise<string[]> => {
      const out: string[] = []
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const rel = relative(base, join(dir, e.name)).split(sep).join('/')
        if (IGNORED.test(rel) || e.name === '.out') continue
        // Regular files only: a symlink here must not become a way to read files elsewhere.
        if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), base)))
        else if (e.isFile()) out.push(rel)
      }
      return out.sort()
    }

    // Build everything once at startup so build status is real for workspaces not on screen yet.
    setTimeout(() => {
      for (const id of configs.keys()) builder(id)
    }, 500)

    yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all([...builders.keys()].map(stop))))

    return Workspaces.of({
      list,
      get: info,
      create,
      update,
      reorder,
      remove,
      fork,
      freeName,
      nameTaken,
      naming,
      reload: async (id) => {
        await load(id)
        changed()
      },
      bundle: (id) =>
        attempt(async () => {
          const b = builder(id)
          await b.running
          if (!b.good) throw new Error(b.state.errors.join('\n\n') || 'The workspace has not built yet')
          return b.good
        }),
      settled: (id) =>
        attempt(async () => {
          const b = builder(id)
          // A save lands a moment before the watcher fires; give the debounce time to queue its build.
          await new Promise((r) => setTimeout(r, 350))
          await b.running
          return b.state
        }),
      check: (dir) =>
        attempt(async () => {
          try {
            await esbuild.build(options(dir))
            return { status: 'ok' as const, errors: [] }
          } catch (e) {
            return { status: 'error' as const, errors: await failure(e, dir) }
          }
        }),
      files: (id) =>
        attempt(async () => {
          const dir = need(id).dir
          const out: Record<string, string> = {}
          for (const f of await walk(dir)) if (/\.(jsx?|tsx?|css|json|md)$/.test(f) && f !== 'KIT.md') out[f] = await readFile(join(dir, f), 'utf8')
          return out
        }),
      source: (id) =>
        attempt(async () => {
          const dir = need(id).dir
          const files: { path: string; text: string | null; size: number }[] = []
          for (const path of await walk(dir)) {
            if (path === 'KIT.md' || path.split('/').some((s) => s.startsWith('.'))) continue
            const buf = await readFile(join(dir, path))
            files.push({ path, text: buf.length > 2_000_000 || buf.includes(0) ? null : buf.toString('utf8'), size: buf.length })
          }
          return { files }
        }),
      editText: (id, before, after) =>
        attempt(async () => {
          const dir = need(id).dir
          const no = (reason: string) => ({ applied: false as const, reason })
          if (!before.trim() || !after.trim()) throw new Error('before and after must both have text')
          if (/[{}<>`\\$\n]/.test(after)) return no('the new text has characters that mean something in code')
          // Text as written in code: inside a tag or a string, with any line wrapping.
          const body = before.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
          const re = new RegExp(`(?<=[>}'"\`]\\s*)${body}(?=\\s*[<{'"\`])`, 'g')
          const hits: { file: string; text: string; at: number; length: number }[] = []
          for (const file of await walk(dir)) {
            if (!/\.(jsx?|tsx?)$/.test(file)) continue
            const text = await readFile(join(dir, file), 'utf8')
            for (const m of text.matchAll(re)) hits.push({ file, text, at: m.index, length: m[0].length })
          }
          if (!hits.length) return no('that text is not written in the code, so it probably comes from data')
          if (hits.length > 1) return no(`that text is written in ${hits.length} places in the code`)
          const h = hits[0]!
          const loader = h.file.endsWith('.tsx') ? 'tsx' : h.file.endsWith('.ts') ? 'ts' : 'jsx'
          // As typed first; with quotes escaped second, for text that sits in a string.
          for (const text of [after.trim(), after.trim().replace(/['"]/g, '\\$&')]) {
            const next = h.text.slice(0, h.at) + text + h.text.slice(h.at + h.length)
            if (!(await esbuild.transform(next, { loader, jsx: 'automatic' }).catch(() => null))) continue
            await writeFile(join(dir, h.file), next)
            return { applied: true as const, file: h.file, line: h.text.slice(0, h.at).split('\n').length }
          }
          return no('the new text would not compile where it stands')
        }),
      reportRuntimeError: (id, error) => {
        const b = builders.get(id)
        if (!b || b.state.runtimeError === (error ?? undefined)) return
        b.state = { ...b.state, runtimeError: error ?? undefined }
        changed()
      },
      reportHeld: (id, version) => {
        const b = builders.get(id)
        if (!b || b.state.held === (version ?? undefined)) return
        b.state = { ...b.state, held: version ?? undefined }
        // Like a build: the window shows it, and workspace code has nothing to refetch for it.
        Effect.runSync(events.publish({ t: 'built', workspace: id, build: b.state }))
      },
    })
  }),
)

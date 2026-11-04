// The marketplace is a shelf of UIs. An item is a folder of UI code plus the connector URLs it was
// written against. It is never installed: forking copies the code into a new workspace of yours and
// binds each alias to one of your connectors with a matching URL. An item can also ship custom tools
// (tools/<name>.js) and schedules for them: a fork installs any you do not have yet. With
// preview/mock.js it can be shown running on made-up data before anything is connected.
//
// Your own shelf (published from your workspaces, private to this machine), and the remote
// marketplace (marketplaceRemote.ts), whose official and community items are listed from the
// server and fetched into a folder of their own the first time one is shown, read or forked. Anyone
// can pull from it; publishing to it takes an account. A workspace goes there through a stage: a copy
// an agent reviews and cleans up, which the user then sees and publishes, or not.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import * as esbuild from 'esbuild'
import { Context, Effect, Layer } from 'effect'
import { checkExactUses, checkRequires, checkTools, LIMITS, normTags, safePath, validSummary, type Account, type BundleFile, type TemplateSummary } from '@shared/marketplaceApi'
import type { MarketplaceItem, MarketplaceRequirement, MarketplaceSchedule, PublishStage, RemoteMarketplaceState, WorkspaceInfo } from '@shared/types'
import { bundleCache } from '../marketplaceCache'
import { httpRemote, marketplaceApi, SignedOut, toBundleFile, type RemoteMarketplace } from '../marketplaceRemote'
import { reviewOf, reviewOutcome, type TemplateReview } from '@shared/templateReview'
import { parseOrigin, remoteOrigin, templateForOrigin } from '@shared/templates'
import { Config } from './Config'
import { Connectors } from './Connectors'
import { Events } from './Events'
import { confine } from './confine'
import { Tools } from './Tools'
import { Workspaces } from './Workspaces'

export interface ForkInput {
  item: string
  /** Which shelf, when an id is on both. Without it: yours, then the remote marketplace's. */
  source?: MarketplaceItem['source']
  name?: string
  /** alias -> connector id. Only needed when more than one of your connectors matches the URL. */
  connectors?: Record<string, string>
}

/** Thrown when a fork cannot pick connectors by itself; carries what the caller needs to finish the choice. */
export class BindingNeeded extends Error {
  constructor(readonly needs: { requirement: MarketplaceRequirement; candidates: string[] }[]) {
    super(
      needs
        .map((n) => (n.candidates.length ? `"${n.requirement.alias}" matches several connectors (${n.candidates.join(', ')}): pass connectors: { ${n.requirement.alias}: "<one of them>" }` : n.requirement.url ? `"${n.requirement.alias}" needs a connector for ${n.requirement.url}: add it first (connector_add), then fork again` : `"${n.requirement.alias}" needs one of your connectors (${n.requirement.name}): pass connectors: { ${n.requirement.alias}: "<connector id>" }`))
        .join('; '),
    )
  }
}

/** Hash the actual approved bytes, independent of filesystem enumeration order. */
const contentHash = (files: { path: string; data: Uint8Array }[]) => createHash('sha256').update(JSON.stringify(files.map((f) => [f.path, createHash('sha256').update(f.data).digest('hex')]).sort((a, b) => a[0]!.localeCompare(b[0]!)))).digest('hex')

export interface MarketplaceShape {
  readonly list: () => MarketplaceItem[]
  /** The remote marketplace: whether there is one, whether it answered, who is signed in, what is on its way there. */
  readonly remote: () => RemoteMarketplaceState
  /** Ask the remote marketplace for its list again. */
  readonly refresh: () => Effect.Effect<RemoteMarketplaceState, Error>
  /** Mails a one-time code to the address, to sign in with. */
  readonly startLogin: (email: string) => Effect.Effect<{ sent: true; devCode?: string }, Error>
  readonly login: (input: { email: string; code: string }) => Effect.Effect<Account, Error>
  readonly claimHandle: (handle: string) => Effect.Effect<Account, Error>
  readonly logout: () => Effect.Effect<void, Error>
  /** Copy a workspace into a stage, to be reviewed, cleaned up and published. The workspace is not changed. */
  readonly stage: (workspace: string, template?: string) => Effect.Effect<PublishStage, Error>
  /** The stage is ready: checked (it builds, nothing odd in it) and put to the user, with what the agent says about it. */
  readonly submit: (input: { stage: string; report?: string }) => Effect.Effect<PublishStage, Error>
  /** Send a ready stage to the marketplace. The user's word only: the window calls it from their click. */
  readonly upload: (stage: string) => Effect.Effect<PublishStage, Error>
  readonly discard: (stage: string) => Effect.Effect<void, Error>
  readonly startReview: (input: { item: string; source: string; harness: string; model?: string; effort?: string; conversation?: string }) => Effect.Effect<{ session: { id: string } }, Error>
  readonly reviewStatus: (source: string, id: string) => Effect.Effect<TemplateReview, Error>
  readonly fork: (input: ForkInput) => Effect.Effect<WorkspaceInfo, Error>
  /** Overwrite a forked workspace's code with the current marketplace version it came from. Bindings are kept. */
  readonly restore: (workspace: string) => Effect.Effect<WorkspaceInfo, Error>
  readonly publish: (input: { workspace: string; name?: string; description?: string }) => Effect.Effect<MarketplaceItem, Error>
  /** Every file of the item as text, manifest, tools and preview included: what its page shows to inspect. */
  readonly files: (source: string, id: string) => Effect.Effect<{ files: { path: string; text: string | null; size: number }[] }, Error>
  /** The item's UI bundled with its mock data, for the marketplace to show. */
  readonly preview: (source: string, id: string) => Effect.Effect<{ js: string; css: string }, Error>
}

export class Marketplace extends Context.Service<Marketplace, MarketplaceShape>()('Marketplace') {}

type Item = MarketplaceItem & { dir: string }

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item'

export const MarketplaceLive = Layer.effect(Marketplace)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const connectors = yield* Connectors
    const workspaces = yield* Workspaces
    const events = yield* Events
    const tools = yield* Tools
    const shelves = [
      { dir: join(cfg.dataDir, 'marketplace'), source: 'local' as const },
    ]
    const changed = () => Effect.runSync(events.changed)
    const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
    const readJson = (file: string) => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return undefined
      }
    }

    // A tool's `export const description = '…'`, read as text: the marketplace never runs a tool to list it.
    const toolDescription = (file: string) => {
      try {
        const m = /export\s+const\s+description\s*=\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(readFileSync(file, 'utf8'))
        return m ? m[2]!.replace(/\\(.)/g, '$1') : ''
      } catch {
        return ''
      }
    }

    const shelved = (): Item[] =>
      shelves.flatMap(({ dir, source }) =>
        existsSync(dir)
          ? readdirSync(dir, { withFileTypes: true })
              .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'manifest.json')))
              .map((e) => {
                const m = JSON.parse(readFileSync(join(dir, e.name, 'manifest.json'), 'utf8'))
                return { id: e.name, name: m.name ?? e.name, description: m.description ?? '', icon: m.icon, color: m.color, author: m.author, source, creator: 'you' as const, tags: normTags(m.tags), requires: m.requires ?? [], uses: m.uses, preview: existsSync(join(dir, e.name, 'preview', 'mock.js')) ? { path: m.preview?.path ?? '/' } : undefined, tools: m.tools as string[] | undefined, toolDescriptions: Array.isArray(m.tools) ? Object.fromEntries((m.tools as string[]).map((t) => [t, toolDescription(join(dir, e.name, 'tools', `${t}.js`))])) : undefined, schedules: m.schedules as MarketplaceSchedule[] | undefined, group: typeof m.group === 'string' ? m.group : undefined, order: m.order ?? 100, dir: join(dir, e.name) }
              })
              .sort((a, b) => a.order - b.order)
              .map(({ order: _o, ...item }) => item)
          : [],
      )

    // ── the remote marketplace: its list (kept on disk, so it shows offline), and its items' files, fetched when first needed
    const api = marketplaceApi({ appRoot: cfg.appRoot, dataDir: cfg.dataDir })
    const server: RemoteMarketplace | null = api ? httpRemote(api) : null
    const remoteDir = join(cfg.dataDir, 'marketplace-remote')
    const indexFile = join(remoteDir, 'index.json')
    // Downloaded files belong to the server they came from: another server's template of the same id and
    // version is other code. Switching servers leaves the old one's files behind, and they are cleared.
    const serverKey = api ? createHash('sha256').update(api).digest('hex').slice(0, 16) : 'none'
    const itemsDir = join(remoteDir, 'items', serverKey)
    if (existsSync(join(remoteDir, 'items')))
      for (const e of readdirSync(join(remoteDir, 'items'))) if (e !== serverKey) rmSync(join(remoteDir, 'items', e), { recursive: true, force: true })
    const saved = readJson(indexFile)
    // Whatever the server sends, only well-formed templates are listed: one bad entry must not break the page.
    const wellFormed = (list: unknown[]) => list.filter((t): t is TemplateSummary => validSummary(t))
    let templates: TemplateSummary[] = saved?.api === api && Array.isArray(saved.templates) ? wellFormed(saved.templates) : []
    // Each version in a folder of its own, read-only once written; versions no longer listed go at start-up, when nothing reads them.
    const cache = server ? bundleCache({ root: itemsDir, api: api!, fetch: (id, version) => server.bundle(id, version) }) : null
    cache?.prune(templates)
    let status: RemoteMarketplaceState['status'] = server ? 'loading' : 'off'
    let lastError: string | undefined
    let checkedAt: string | undefined = saved?.api === api ? saved.checkedAt : undefined
    // An id is a folder name and part of a preview's address: anything else from the server is left out.
    const ID = /^[a-z0-9][a-z0-9-]{0,59}$/
    const fromServer = (t: TemplateSummary): Item => ({
      id: t.id,
      name: String(t.name),
      description: String(t.description ?? ''),
      icon: t.icon,
      color: t.color,
      author: t.publisher?.name,
      source: 'remote',
      creator: t.creator === 'official' ? 'official' : 'community',
      verified: !!t.verified,
      publisher: t.publisher,
      tags: normTags(t.tags),
      installs: t.installs,
      version: t.version,
      requires: Array.isArray(t.requires) ? t.requires : [],
      uses: t.uses,
      tools: t.tools,
      toolDescriptions: t.toolDescriptions,
      schedules: t.schedules,
      preview: t.preview,
      dir: cache ? cache.dirOf(t.id, t.version) : join(itemsDir, t.id),
    })
    const list = (): Item[] => {
      return [...shelved(), ...templates.filter((t) => ID.test(t.id)).map(fromServer)]
    }
    /** An item by shelf, or by id alone: yours, then the remote marketplace's. */
    const find = (id: string, source?: string): Item | undefined => (source ? list().find((i) => i.id === id && i.source === source) : list().find((i) => i.id === id))

    let refreshing: Promise<void> | null = null
    const refreshNow = () =>
      (refreshing ??= (async () => {
        if (!server) return
        status = 'loading'
        changed()
        try {
          templates = wellFormed(await server.list())
          status = 'ok'
          lastError = undefined
          checkedAt = new Date().toISOString()
          await mkdir(remoteDir, { recursive: true })
          await writeFile(indexFile, JSON.stringify({ api, checkedAt, templates }))
        } catch (e) {
          status = 'error'
          lastError = asError(e).message
        }
        changed()
      })().finally(() => (refreshing = null)))
    if (server) {
      void refreshNow()
      setInterval(() => void refreshNow(), 30 * 60_000).unref()
    }

    /** The item's folder, with its files: a marketplace item's, for the version listed, are fetched when missing. */
    const ensure = async (item: Item) => {
      if (item.source !== 'remote') return
      if (!cache) throw new Error('No marketplace server is set up')
      if (item.version === undefined) throw new Error(`${item.name} has no version; refresh the marketplace and try again`)
      await cache.ensure({ id: item.id, version: item.version, name: item.name })
    }
    const locate = async (source: string | undefined, id: string) => {
      const item = find(id, source)
      if (!item) throw new Error(`No marketplace item named ${id}`)
      await ensure(item)
      return item
    }

    // ── signing in: only to publish. The token stays in this process, for the server it came from.
    const accountFile = join(cfg.dataDir, 'marketplace-account.json')
    const savedAccount = readJson(accountFile)
    // A cached email-derived label is not a claimed handle. Validate the profile with the server.
    let account: { token: string; account: Account } | null = server && savedAccount?.api === api && savedAccount.token ? { token: savedAccount.token, account: { ...savedAccount.account, handle: null, name: '' } } : null
    const signOut = async () => {
      account = null
      await rm(accountFile, { force: true })
      changed()
    }
    const startLogin: MarketplaceShape['startLogin'] = (email) =>
      Effect.tryPromise({
        try: async () => {
          if (!server) throw new Error('No marketplace server is set up')
          return server.startLogin(String(email ?? '').trim())
        },
        catch: asError,
      })
    const login: MarketplaceShape['login'] = (input) =>
      Effect.tryPromise({
        try: async () => {
          if (!server) throw new Error('No marketplace server is set up')
          const r = await server.login({ email: String(input.email ?? '').trim(), code: String(input.code ?? '').trim() })
          account = { token: r.token, account: r.account }
          await writeFile(accountFile, JSON.stringify({ api, token: r.token, account: r.account }), { mode: 0o600 })
          changed()
          return r.account
        },
        catch: asError,
      })

    const claimHandle: MarketplaceShape['claimHandle'] = (handle) =>
      Effect.tryPromise({
        try: async () => {
          if (!server || !account) throw new Error('Sign in to the marketplace first')
          const session = account
          try {
            const profile = await server.claimHandle(session.token, handle)
            if (account?.token !== session.token) throw new Error('Your sign-in changed; try again')
            account = { token: session.token, account: profile }
            await writeFile(accountFile, JSON.stringify({ api, ...account }), { mode: 0o600 })
            changed()
            void refreshNow()
            return profile
          } catch (e) {
            if (e instanceof SignedOut && account?.token === session.token) await signOut()
            throw e
          }
        },
        catch: asError,
      })
    if (server && account) {
      const session = account
      void server.me(session.token).then((profile) => {
        if (account !== session) return
        account = { token: session.token, account: profile }
        changed()
      }).catch(async (e) => {
        if (e instanceof SignedOut && account === session) await signOut()
      })
    }

    // ── stages: a workspace on its way to the marketplace. Each is a folder (the copy) and <id>.json beside it.
    const stagesDir = join(cfg.dataDir, 'publishing')
    const stages = new Map<string, PublishStage>()
    if (existsSync(stagesDir))
      for (const f of readdirSync(stagesDir).filter((f) => f.endsWith('.json'))) {
        const s = readJson(join(stagesDir, f)) as PublishStage | undefined
        // An upload cut short by a restart may or may not have arrived: say so, and let the user try again.
        if (s?.id && existsSync(s.dir)) stages.set(s.id, s.status === 'publishing' ? { ...s, status: 'failed', error: 'Lynx stopped while this was being published. Try again.' } : s)
      }
    const keep = async (s: PublishStage) => {
      stages.set(s.id, s)
      await mkdir(stagesDir, { recursive: true })
      await writeFile(join(stagesDir, `${s.id}.json`), JSON.stringify(s, null, 2))
      changed()
      return s
    }
    const stageOf = (id: string) => {
      const s = stages.get(String(id))
      if (!s) throw new Error(`No stage named ${id}: start again with marketplace_stage`)
      return s
    }

    const remote = (): RemoteMarketplaceState => ({
      api,
      status,
      ...(lastError ? { error: lastError } : {}),
      ...(checkedAt ? { checkedAt } : {}),
      account: account?.account ?? null,
      publishing: [...stages.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
    })

    // `skip` holds paths that are not workspace code: an item's tools/<name>.js.
    // Bytes, not text: a template's images and fonts must reach the workspace as they are.
    const readTree = async (dir: string, base = dir, skip = new Set<string>()): Promise<Record<string, Buffer>> => {
      const out: Record<string, Buffer> = {}
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        const path = relative(base, p).split(sep).join('/')
        if (e.name.startsWith('.') || e.name === 'manifest.json' || e.name === 'KIT.md' || e.name === 'workspace.json' || e.name === 'node_modules' || skip.has(path)) continue
        if (e.isDirectory()) Object.assign(out, await readTree(p, base, skip))
        else out[path] = await readFile(p)
      }
      return out
    }
    // For reading, not forking: everything but dotfiles and node_modules. A file that is not text, or too
    // big to read on screen, is listed without its text.
    const walkFiles = async (root: string) => {
      const out: { path: string; data: Buffer }[] = []
      const walk = async (dir: string) => {
        for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue
          const p = join(dir, e.name)
          if (e.isDirectory()) await walk(p)
          else if (e.isFile()) out.push({ path: relative(root, p).split(sep).join('/'), data: await readFile(p) })
        }
      }
      await walk(root)
      return out
    }
    // For reading on screen: what is text as it is, and not too big to show.
    const isText = (b: Buffer) => b.length <= 2_000_000 && 'text' in toBundleFile('', b)
    const files: MarketplaceShape['files'] = (source, id) =>
      Effect.tryPromise({
        try: async () => {
          const item = await locate(source, id)
          return { files: (await walkFiles(item.dir)).map((f) => ({ path: f.path, text: isText(f.data) ? f.data.toString('utf8') : null, size: f.data.length })) }
        },
        catch: asError,
      })
    // What a fork does not copy: the tools it installs instead, and the preview's mock data.
    const toolPaths = (item: { tools?: string[] }) => new Set(['preview', ...(item.tools ?? []).map((t) => `tools/${t}.js`)])

    // Tools you already have are yours (you may have changed them), so only missing ones are written,
    // unless `replace` asks for the item's version, as restoring does.
    const installTools = (item: Item, replace: boolean) =>
      Effect.gen(function* () {
        for (const name of item.tools ?? []) {
          if (!replace && tools.list().some((t) => t.name === name)) continue
          const source = yield* Effect.tryPromise({ try: () => readFile(join(item.dir, 'tools', `${name}.js`), 'utf8'), catch: () => new Error(`${item.name} lists the tool ${name} but has no tools/${name}.js`) })
          yield* tools.save(name, source)
        }
        for (const s of item.schedules ?? []) {
          if (tools.schedules().some((x) => x.id === s.id)) continue
          yield* Effect.try({ try: () => tools.saveSchedule(s), catch: asError })
        }
      })

    // Callers may request a review; only the host creates its instructions and receipt, bound to the
    // bytes actually reviewed. A session label or a client-supplied "reviewed" flag is not proof.
    type Receipt = { session: string; run: string; hash: string; version?: number }
    const reviewsFile = join(cfg.dataDir, 'marketplace-reviews.json')
    const receipts: Record<string, Receipt> = readJson(reviewsFile) ?? {}
    const reviewKey = (item: Item) => JSON.stringify([item.source === 'remote' ? api : item.source, item.id])
    const saveReceipts = () => writeFile(reviewsFile, JSON.stringify(receipts), { mode: 0o600 })
    const startReview: MarketplaceShape['startReview'] = (input) => Effect.tryPromise({
      try: async () => {
        const item = find(input.item, input.source)
        if (!item) throw new Error('This template is no longer available')
        await ensure(item)
        const all = await walkFiles(item.dir)
        const hash = contentHash(all)
        const plan = reviewOf(item, { harness: input.harness, model: input.model ?? '', effort: input.effort ?? '', access: 'read' }, all.map((f) => ({ path: f.path, size: f.data.length })))
        const result = await Effect.runPromise(connectors.call('agents', 'session_start', {
          harness: input.harness, cwd: item.dir, prompt: plan.prompt, connection_ids: [],
          labels: { kind: 'agent', title: plan.title, ...(input.conversation ? { conversation: input.conversation } : {}), ...plan.labels },
          config: { permission_mode: 'deny', instructions: plan.instructions, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) },
        })) as { session: { id: string }; run: { id: string } }
        receipts[reviewKey(item)] = { session: result.session.id, run: result.run.id, hash, version: item.version }
        await saveReceipts()
        return { session: result.session }
      }, catch: asError,
    })
    const reviewStatus: MarketplaceShape['reviewStatus'] = (source, id) => Effect.tryPromise({
      try: async (): Promise<TemplateReview> => {
        const item = find(id, source)
        if (!item) throw new Error('This template is no longer available')
        const receipt = receipts[reviewKey(item)]
        if (!receipt || receipt.version !== item.version) return { status: 'required' }
        await ensure(item)
        if (contentHash(await walkFiles(item.dir)) !== receipt.hash) return { status: 'required', report: 'The template changed. Review this version before creating a workspace.' }
        const run = await Effect.runPromise(connectors.call('agents', 'run_get', { id: receipt.run })) as { status: string; output?: string; output_truncated?: boolean; session_id: string }
        if (run.session_id !== receipt.session) return { status: 'required' }
        return { ...reviewOutcome(run), session: receipt.session }
      }, catch: asError,
    })
    const requireReview = (item: Item) => Effect.gen(function* () {
      if (item.creator !== 'community') return
      const result = yield* reviewStatus(item.source, item.id)
      if (result.status !== 'passed') return yield* Effect.fail(new Error('A successful security review of this template version is required. Open the template in New Workspace and run its security review.'))
    })

    // A marketplace item's workspace remembers the shelf too, so updating it finds the same item again.
    const originOf = (item: Item) => (item.source === 'remote' ? remoteOrigin(api!, item.id) : item.id)
    const fork: MarketplaceShape['fork'] = (input) =>
      Effect.gen(function* () {
        const item = find(input.item, input.source)
        if (!item) return yield* Effect.fail(new Error(`No marketplace item named ${input.item}`))
        yield* requireReview(item)
        const bound: Record<string, string> = {}
        const needs: BindingNeeded['needs'] = []
        for (const r of item.requires) {
          const chosen = input.connectors?.[r.alias]
          if (chosen) {
            if (!connectors.get(chosen)) return yield* Effect.fail(new Error(`No connector named ${chosen}`))
            bound[r.alias] = chosen
            continue
          }
          const candidates = r.url ? connectors.findByUrl(r.url).map((c) => c.id) : []
          if (candidates.length === 1) bound[r.alias] = candidates[0]!
          else if (candidates.length || !r.optional) needs.push({ requirement: r, candidates })
        }
        if (needs.length) return yield* Effect.fail(new BindingNeeded(needs))
        yield* Effect.tryPromise({ try: () => ensure(item), catch: asError })
        const files = yield* Effect.tryPromise({ try: () => readTree(item.dir, item.dir, toolPaths(item)), catch: asError })
        yield* installTools(item, false)
        const ws = yield* workspaces.create({ name: input.name?.trim() || workspaces.freeName(item.name), icon: item.icon, color: item.color, description: item.description, connectors: bound, uses: exactUses(item), files, origin: originOf(item) })
        if (item.source === 'remote') void server?.installed(item.id)
        return ws
      })

    /**
     * What an install may call. A template from the remote marketplace says so in full,
     * and one that says nothing gets nothing, never the default of every tool on each bound connector. Only
     * your own shelf (templates saved before manifests listed tools) keeps that default.
     */
    const exactUses = (item: MarketplaceItem) => item.uses ?? (item.source === 'local' ? undefined : {})

    const restore: MarketplaceShape['restore'] = (workspace) =>
      Effect.tryPromise({
        try: async () => {
          const ws = workspaces.get(workspace)
          if (!ws) throw new Error(`No workspace named ${workspace}`)
          if (!ws.origin) throw new Error(`${ws.name} was not forked from a marketplace item`)
          const origin = parseOrigin(ws.origin)
          // Only from the server it came from: another server's template of the same id is other code.
          if (origin.remote && origin.api !== api) throw new Error(`${ws.name} came from ${origin.api ? `the marketplace at ${origin.api}` : 'a marketplace this app no longer knows'}${api ? `, not the one set up now (${api})` : ', and no marketplace is set up now'}, so it cannot be updated from here`)
          const item = templateForOrigin(ws.origin, api, list())
          if (!item) throw new Error(`${ws.name} was not forked from a marketplace item that still exists`)
          await Effect.runPromise(requireReview(item))
          await ensure(item)
          await Effect.runPromise(installTools(item, true))
          for (const [path, data] of Object.entries(await readTree(item.dir, item.dir, toolPaths(item)))) {
            await mkdir(dirname(join(ws.dir, path)), { recursive: true })
            await writeFile(join(ws.dir, path), data)
          }
          // The code is the item's again, so the manifest that describes it is too.
          const uses = exactUses(item)
          if (uses) await Effect.runPromise(workspaces.update(workspace, { uses }))
          return workspaces.get(workspace)!
        },
        catch: asError,
      })

    /** A workspace as an item: its code, the custom tools it calls with their schedules, and a manifest that needs URLs, not this machine's connector names. */
    const writeItem = async (ws: WorkspaceInfo, dir: string, manifest: Record<string, unknown>) => {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      // Byte for byte (images too), without what is the workspace's own: its data, build output, settings.
      await cp(ws.dir, dir, {
        recursive: true,
        filter: (src) => {
          const path = relative(ws.dir, src).split(sep)
          const name = path[path.length - 1]!
          return src === ws.dir || (!name.startsWith('.') && name !== 'node_modules' && !(path.length === 1 && ['manifest.json', 'KIT.md', 'workspace.json'].includes(name)))
        },
      })
      const used = Array.isArray(ws.uses?.tools) ? ws.uses.tools.filter((t) => tools.list().some((x) => x.name === t)) : []
      for (const t of used) {
        await mkdir(join(dir, 'tools'), { recursive: true })
        await writeFile(join(dir, 'tools', `${t}.js`), tools.source(t))
      }
      const schedules = tools.schedules().filter((s) => used.includes(s.tool)).map(({ id, tool, cron, args }) => ({ id, tool, cron, args }))
      const requires = Object.entries(ws.connectors).flatMap(([alias, cid]) => {
        const c = connectors.get(cid)
        return c?.url && !c.native ? [{ alias, name: c.name, url: c.url }] : []
      })
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: ws.name, description: ws.description ?? '', icon: ws.icon, color: ws.color, ...manifest, requires, uses: ws.uses, ...(used.length ? { tools: used, schedules } : {}) }, null, 2))
    }

    const publish: MarketplaceShape['publish'] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const ws = workspaces.get(input.workspace)
          if (!ws) throw new Error(`No workspace named ${input.workspace}`)
          const id = slug(input.name ?? ws.name)
          await writeItem(ws, join(cfg.dataDir, 'marketplace', id), { name: input.name ?? ws.name, description: input.description ?? ws.description ?? '', author: 'you' })
          changed()
          return find(id, 'local')!
        },
        catch: asError,
      })

    // Public handles are unique and immutable; the Worker independently enforces email ownership.
    const updateFor = (ws: WorkspaceInfo, template?: string): PublishStage['update'] => {
      const prior = [...stages.values()].filter((s) => s.workspace === ws.id && s.published && s.publisher?.api === api && s.publisher.email === account?.account.email).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      const origin = ws.origin ? parseOrigin(ws.origin) : undefined
      const candidate = template ?? prior?.published?.id ?? (origin?.remote && origin.api === api ? origin.id : undefined)
      if (!candidate) return
      const item = list().find((i) => i.source === 'remote' && i.id === candidate)
      if (!account?.account.handle || !item || item.publisher?.handle !== account.account.handle) {
        if (template || prior) throw new Error('Sign in as the publisher and refresh the marketplace before updating this template')
        return
      }
      if (!item.version || !api) throw new Error('Refresh the marketplace before preparing this update')
      return { api, email: account.account.email, id: item.id, version: item.version, name: item.name }
    }
    const stage: MarketplaceShape['stage'] = (workspace, template) =>
      Effect.tryPromise({
        try: async () => {
          const ws = workspaces.get(workspace)
          if (!ws) throw new Error(`No workspace named ${workspace}`)
          const id = `${slug(ws.name)}-${Date.now().toString(36)}`
          const dir = join(stagesDir, id)
          // The author is whoever publishes it: the marketplace fills that in.
          const update = updateFor(ws, template)
          await writeItem(ws, dir, { tags: [], ...(update ? { id: update.id, name: update.name } : {}) })
          return keep({ id, workspace, update, name: update?.name ?? ws.name, dir, status: 'preparing', createdAt: new Date().toISOString() })
        },
        catch: asError,
      })

    // Before the user is asked, what the marketplace would refuse is caught here, where the agent can still fix it.
    const submit: MarketplaceShape['submit'] = (input) =>
      Effect.tryPromise({
        try: async () => {
          let s = stageOf(input.stage)
          if (s.status === 'publishing' || s.status === 'published') throw new Error(`${s.name} is already ${s.status}`)
          const m = readJson(join(s.dir, 'manifest.json'))
          if (!m || typeof m !== 'object') throw new Error('manifest.json is missing or is not valid JSON')
          // Account setup may have completed after staging. Resolve an owned origin before approval.
          if (!s.update) {
            const ws = workspaces.get(s.workspace)
            const update = ws && updateFor(ws)
            if (update) {
              m.id = update.id
              await writeFile(join(s.dir, 'manifest.json'), JSON.stringify(m, null, 2))
              s = await keep({ ...s, update })
            }
          }
          if (s.update && m.id !== s.update.id) throw new Error('Keep the original template ID when preparing an update')
          const name = typeof m.name === 'string' ? m.name.trim() : ''
          const description = typeof m.description === 'string' ? m.description.trim() : ''
          if (!name || name.length > 60) throw new Error('manifest.json needs a name of at most 60 characters')
          if (!description || description.length > 300) throw new Error('manifest.json needs a description: one sentence, at most 300 characters')
          // What the marketplace would refuse, said here where the agent can still fix it.
          const wrong = checkRequires(m.requires ?? []) ?? checkExactUses(m.uses, m.requires ?? []) ?? checkTools(m.tools, m.schedules)
          if (wrong) throw new Error(`manifest.json: ${wrong}`)
          const all = await walkFiles(s.dir)
          const odd = all.filter((f) => !safePath(f.path)).map((f) => f.path)
          if (odd.length) throw new Error(`Rename or remove these files; the marketplace takes plain names only: ${odd.join(', ')}`)
          const bytes = all.reduce((n, f) => n + f.data.length, 0)
          if (all.length > LIMITS.files || bytes > LIMITS.bytes) throw new Error(`Too big: ${all.length} files, ${(bytes / 1e6).toFixed(1)} MB (at most ${LIMITS.files} files and ${LIMITS.bytes / 1e6} MB)`)
          const build = await Effect.runPromise(workspaces.check(s.dir))
          if (build.status === 'error') throw new Error(`It does not build; fix it and submit again:\n${build.errors.join('\n\n')}`)
          return keep({ ...s, status: 'ready', contentHash: contentHash(all), readyAt: new Date().toISOString(), name, description, tags: normTags(m.tags), report: input.report ? String(input.report).slice(0, 4000) : s.report, files: all.map((f) => ({ path: f.path, size: f.data.length })), error: undefined })
        },
        catch: asError,
      })

    const upload: MarketplaceShape['upload'] = (id) =>
      Effect.tryPromise({
        try: async () => {
          const s = stageOf(id)
          if (s.status !== 'ready' && s.status !== 'failed') throw new Error(`${s.name} is not ready to publish (${s.status})`)
          if (!server) throw new Error('No marketplace server is set up')
          if (!account) throw new Error('Sign in to the marketplace to publish')
          if (!account.account.handle) throw new Error('Choose a unique handle before publishing')
          if (s.update && (s.update.api !== api || s.update.email !== account.account.email)) throw new Error('Sign in as the publisher on the original marketplace to publish this update')
          const ws = workspaces.get(s.workspace)
          if (!s.update && ws && updateFor(ws)) throw new Error('This workspace belongs to an existing template. Ask the agent to submit it again as an update')
          const session = account
          await keep({ ...s, status: 'publishing', error: undefined })
          try {
            const files = await walkFiles(s.dir)
            if (!s.contentHash || contentHash(files) !== s.contentHash) throw new Error('The files changed since the agent submitted them. Ask the agent to review and submit this copy again before publishing.')
            const bundle: BundleFile[] = files.map((f) => toBundleFile(f.path, f.data))
            if (account !== session) throw new Error('Your sign-in changed; review the publishing account and try again')
            const publisher = { api: api!, email: session.account.email }
            const t = await server.publish(session.token, { files: bundle, ...(s.update ? { update: { id: s.update.id, version: s.update.version } } : {}) })
            void refreshNow()
            return keep({ ...stageOf(id), status: 'published', publisher, published: { id: t.id, version: t.version } })
          } catch (e) {
            if (e instanceof SignedOut) await signOut()
            await keep({ ...stageOf(id), status: 'failed', error: e instanceof SignedOut ? 'You were signed out of the marketplace. Sign in and try again.' : asError(e).message })
            throw e
          }
        },
        catch: asError,
      })

    const discard: MarketplaceShape['discard'] = (id) =>
      Effect.tryPromise({
        try: async () => {
          const s = stageOf(id)
          if (s.status === 'publishing') throw new Error(`${s.name} is being published`)
          stages.delete(s.id)
          await rm(s.dir, { recursive: true, force: true })
          await rm(join(stagesDir, `${s.id}.json`), { force: true })
          changed()
        },
        catch: asError,
      })

    // ── previews: built on demand and kept until a file of the item, or of the kit, changes
    const kitDir = join(cfg.appRoot, 'src', 'kit')
    const built = new Map<string, { stamp: number; out: { js: string; css: string } }>()
    const stampOf = (dir: string): number =>
      readdirSync(dir, { withFileTypes: true }).reduce((n, e) => Math.max(n, e.name.startsWith('.') || e.name === 'node_modules' ? 0 : e.isDirectory() ? stampOf(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0)
    const preview: MarketplaceShape['preview'] = (source, id) =>
      Effect.tryPromise({
        try: async () => {
          const item = await locate(source, id)
          if (!item.preview) throw new Error(`${id} has no preview`)
          const key = `${source}:${id}`
          const stamp = Math.max(stampOf(item.dir), stampOf(kitDir))
          const cached = built.get(key)
          if (cached?.stamp === stamp) return cached.out
          const meta = JSON.stringify({ id: item.id, name: item.name, requires: item.requires })
          // The mock is installed in a module of its own, imported first, so it is in place before any of the item's modules run.
          const boot: esbuild.Plugin = {
            name: 'preview-boot',
            setup(b) {
              b.onResolve({ filter: /^sb-preview-boot$/ }, () => ({ path: 'boot', namespace: 'sb-preview' }))
              b.onLoad({ filter: /.*/, namespace: 'sb-preview' }, () => ({
                contents: `import { installPreview } from ${JSON.stringify(join(kitDir, 'preview.ts'))}\nimport mock from './preview/mock.js'\ninstallPreview(mock, ${meta})\n`,
                resolveDir: item.dir,
                loader: 'js',
              }))
            },
          }
          const result = await esbuild.build({
            stdin: { contents: `import 'sb-preview-boot'\nimport App from './App'\nimport { mount } from 'lynx'\nmount(App)\n`, resolveDir: item.dir, loader: 'jsx', sourcefile: 'preview-entry.jsx' },
            bundle: true,
            write: false,
            outdir: join(cfg.dataDir, '.preview-out'),
            format: 'iife',
            platform: 'browser',
            target: 'chrome130',
            jsx: 'automatic',
            alias: { lynx: join(kitDir, 'index.tsx') },
            nodePaths: [join(cfg.appRoot, 'node_modules')],
            define: { 'process.env.NODE_ENV': '"production"' },
            loader: { '.js': 'jsx', '.png': 'dataurl', '.jpg': 'dataurl', '.gif': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.md': 'text', '.txt': 'text' },
            logLevel: 'silent',
            plugins: [boot, confine(item.dir, cfg.appRoot, 'item')],
          })
          const out = (ext: string) => result.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? ''
          const done = { js: out('.js'), css: out('.css') }
          built.set(key, { stamp, out: done })
          return done
        },
        catch: asError,
      })

    return Marketplace.of({
      list,
      remote,
      refresh: () => Effect.tryPromise({ try: () => refreshNow().then(remote), catch: asError }),
      startLogin,
      login,
      claimHandle,
      logout: () => Effect.promise(signOut),
      stage,
      submit,
      upload,
      discard,
      files,
      fork,
      startReview,
      reviewStatus,
      restore,
      publish,
      preview,
    })
  }),
)

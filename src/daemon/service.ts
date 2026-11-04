// The background service's core: the whole runtime (agents, connectors, the hub agents reach them
// through, tools and their schedules, the store, notifications, workspaces) behind a loopback HTTP
// API that windows use. It runs in lynxd, its own process that outlives the window, or, with
// LYNX_DAEMON=0, inside the window's process.
//
//   GET  /v1/health         who is running: build, pid, whether it is ready, what is under way
//   GET  /v1/state          the AppState it knows (the window adds its own fields)
//   POST /v1/call           { connector, tool, args, caller } → a tool call, as the window makes it
//   POST /v1/bundle         { id } → a workspace's built bundle
//   POST /v1/preview        { source, item } → a marketplace item's preview bundle
//   POST /v1/runtime-error  { workspace, error }
//   POST /v1/held           { workspace, version } → a new version waits off screen while the user is busy (null: none)
//   POST /v1/presence       { client, windows }: how many windows that client has open
//   GET  /v1/events         server-sent events: { t: 'changed' } and every AppEvent (?client=&windows=)
//   POST /v1/stop           { when: 'now' | 'idle' }
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Effect } from 'effect'
import type { AppEvent, AppSettings } from '@shared/types'
import { readRequest } from '@shared/reads'
import { Connectors, Engine, Events, Marketplace, Notifications, Settings, Workspaces, makeRuntime, snapshot } from '../main/runtime'
import { loadConfig } from '../main/services/Config'
import type { Caller } from '../main/services/Connectors'
import { BLANK_APP, type WorkspacesShape } from '../main/services/Workspaces'
import { keepSiteIcons } from '../main/siteIcons'
import { ADDRESS_FILE } from './pid'

export interface ServiceOptions {
  dataDir: string
  appRoot: string
  outDir: string
  port: number
  token: string
}

export interface Activity {
  runs: number
  processes: number
}

export interface ServiceHooks {
  /** Something is under way, or nothing is any more (keeps the Mac awake in lynxd). */
  onBusy?: (busy: boolean) => void
  /** A notification was sent while no window was listening. */
  onUnseenNotification?: (text: string, workspace: string) => void
  /** The settings changed (lynxd keeps its login item in step). */
  onSettings?: (settings: AppSettings) => void
}

export interface Service {
  readonly ready: Promise<void>
  /** Resolves once the service has stopped, by request or by close(). */
  readonly stopped: Promise<void>
  readonly close: () => Promise<void>
}

/** A fingerprint of the built code, the same in the window and in the service built with it. */
export function buildId(outDir: string) {
  const hash = createHash('sha1')
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(c|m)?js$/.test(name)) hash.update(name).update(readFileSync(path))
    }
  }
  try {
    walk(outDir)
  } catch {
    return 'unknown'
  }
  return hash.digest('hex').slice(0, 12)
}

const digest = (s: string) => createHash('sha256').update(s).digest()
const sameToken = (given: string | undefined, expected: string) => !!given && timingSafeEqual(digest(given), digest(`Bearer ${expected}`))
const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}
const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function startService(opts: ServiceOptions, hooks: ServiceHooks = {}): Service {
  const startedAt = new Date().toISOString()
  const build = buildId(opts.outDir)
  let runtime: Awaited<ReturnType<typeof boot>> | undefined
  let stopping: Promise<void> | undefined
  let retiring = false
  let activity: Activity = { runs: 0, processes: 0 }
  const clients = new Set<ServerResponse>()
  /** Windows open per client (a window process stays connected on macOS with all its windows closed). */
  const windows = new Map<string, number>()
  const windowsOpen = () => [...windows.values()].reduce((a, b) => a + b, 0)
  let resolveStopped!: () => void
  const stopped = new Promise<void>((r) => (resolveStopped = r))
  const broadcast = (e: { t: 'changed' } | AppEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`
    for (const c of clients) c.write(line)
  }

  async function boot() {
    keepSiteIcons(join(opts.dataDir, 'site-icons'))
    const config = await loadConfig({ appRoot: opts.appRoot, outDir: opts.outDir, dataDir: opts.dataDir })
    const managed = makeRuntime(config)
    const run = <A, E>(e: Effect.Effect<A, E, any>) => managed.runPromise(e as Effect.Effect<A, E, never>)
    const services = await run(
      Effect.gen(function* () {
        return { events: yield* Events, engine: yield* Engine, connectors: yield* Connectors, workspaces: yield* Workspaces, marketplace: yield* Marketplace, settings: yield* Settings, notifications: yield* Notifications }
      }),
    )
    const { events, settings, notifications, workspaces } = services
    events.onChanged(() => {
      broadcast({ t: 'changed' })
      hooks.onSettings?.(settings.get())
    })
    events.listen(broadcast)
    notifications.listen((n) => {
      if (!windowsOpen()) hooks.onUnseenNotification?.(n.text, workspaces.get(n.workspace)?.name ?? n.workspace)
    })
    hooks.onSettings?.(settings.get())
    await seedHome(run, services.workspaces, config.appRoot)
    return { managed, run, ...services }
  }

  // What is under way, every few seconds: for replacing an old build once idle, and for staying awake.
  const busyCount = () => activity.runs + activity.processes
  const look = async () => {
    if (!runtime || stopping) return
    const engine = runtime.engine
    const before = busyCount()
    activity = engine.state().status === 'ready' ? await engine.admin('GET', '/v1/admin/activity').catch(() => activity) : activity
    if (!!before !== !!busyCount()) hooks.onBusy?.(busyCount() > 0)
    if (retiring && !busyCount()) void stop('the newer build replaces it')
  }
  const looking = setInterval(() => void look(), 3000)

  const stop = (why: string) =>
    (stopping ??= (async () => {
      console.error(`[lynxd] stopping: ${why}`)
      clearInterval(looking)
      // Windows hear it go at once; health keeps answering (stopping) until it is gone, so a
      // replacement never starts on the same data while this one is still letting go of it.
      for (const c of clients) c.end()
      // Ended, they take nothing more: what changes while the runtime winds down is not written to them.
      clients.clear()
      await booting.catch(() => undefined)
      // The engine's finalizer stops agentd, which records its runs as interrupted.
      await runtime?.managed.dispose()
      hooks.onBusy?.(false)
      server.close()
      server.closeAllConnections()
      resolveStopped()
    })())

  const server = createServer((req, res) => {
    // Loopback names only, so a web page cannot reach this through DNS rebinding.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return void res.writeHead(403).end()
    if (!sameToken(req.headers.authorization, opts.token)) return send(res, 401, { ok: false, error: 'Missing or wrong token' })
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = async () => {
      if (req.method === 'GET' && path === '/v1/health') {
        // Counted now, not at the last look: a window about to quit may ask right after starting something.
        await Promise.race([look(), new Promise((r) => setTimeout(r, 500))])
        return send(res, 200, { ok: true, ready: !!runtime, build, pid: process.pid, startedAt, busy: busyCount(), retiring, stopping: !!stopping, clients: clients.size, windows: windowsOpen() })
      }
      if (req.method === 'POST' && path === '/v1/stop') {
        const { when } = await readBody(req)
        if (when === 'idle') {
          retiring = true
          void look()
        } else void stop('asked to')
        return send(res, 200, { ok: true })
      }
      if (stopping) return send(res, 503, { ok: false, error: 'Lynx is stopping its background service' })
      await booting
      const r = runtime!
      if (req.method === 'GET' && path === '/v1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(': hello\n\n')
        clients.add(res)
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams
        const id = query.get('client') ?? `anon-${clients.size}-${Date.now()}`
        windows.set(id, Math.max(0, Number(query.get('windows')) || 0))
        req.once('close', () => {
          clients.delete(res)
          windows.delete(id)
        })
        return
      }
      if (req.method === 'GET' && path === '/v1/state') return send(res, 200, await r.run(snapshot))
      if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'No such route' })
      const body = await readBody(req)
      if (path === '/v1/call') {
        const caller: Caller | undefined = body.caller && typeof body.caller.by === 'string' ? { by: body.caller.by, ...(typeof body.caller.via === 'string' ? { via: body.caller.via } : {}), depth: Number(body.caller.depth) || 0, read: readRequest(body.caller.read) } : undefined
        return r.run(r.connectors.call(String(body.connector), String(body.tool), body.args ?? {}, caller)).then(
          (data) => send(res, 200, { ok: true, data }),
          (e) => send(res, 200, { ok: false, error: message(e) }),
        )
      }
      if (path === '/v1/bundle')
        return r.run(r.workspaces.bundle(String(body.id))).then(
          (data) => send(res, 200, { ok: true, data }),
          (e) => send(res, 200, { ok: false, error: message(e) }),
        )
      if (path === '/v1/preview')
        return r.run(r.marketplace.preview(String(body.source), String(body.item))).then(
          (data) => send(res, 200, { ok: true, data }),
          (e) => send(res, 200, { ok: false, error: message(e) }),
        )
      if (path === '/v1/presence') {
        if (typeof body.client === 'string' && windows.has(body.client)) windows.set(body.client, Math.max(0, Number(body.windows) || 0))
        return send(res, 200, { ok: true })
      }
      if (path === '/v1/runtime-error') {
        r.workspaces.reportRuntimeError(String(body.workspace), body.error === null ? null : String(body.error))
        return send(res, 200, { ok: true })
      }
      if (path === '/v1/held') {
        r.workspaces.reportHeld(String(body.workspace), typeof body.version === 'number' ? body.version : null)
        return send(res, 200, { ok: true })
      }
      send(res, 404, { ok: false, error: 'No such route' })
    }
    route().catch((e) => {
      console.error('[lynxd]', path, e)
      if (res.headersSent) return void res.destroy()
      send(res, 500, { ok: false, error: message(e) })
    })
  })
  // Keeps event streams open through idle stretches.
  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n')
  }, 15000)
  stopped.then(() => clearInterval(ping))

  // Listening first is what keeps a second copy from starting: it finds the port taken and goes.
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject)
      writeFileSync(join(opts.dataDir, 'lynxd.pid'), String(process.pid))
      // The port it is really on: the saved one can be moved under it (an older copy of Lynx opened meanwhile).
      writeFileSync(join(opts.dataDir, ADDRESS_FILE), JSON.stringify({ pid: process.pid, port: opts.port }))
      resolve()
    })
  })
  const booting = listening.then(boot)
  booting.then((r) => (runtime = r)).catch((e) => console.error('[lynxd] could not start', e))
  const ready = booting.then(() => undefined)
  ready.catch(() => resolveStopped())

  return { ready, stopped, close: () => stop('closed') }
}

/** Home is the workspace the app starts with, marked as the one that stays, first in the list. A new
 * install's is Onboarding: a checklist (resources/onboarding) with the agent panel beside it greeting
 * the user and getting their data sources connected. The user can then have the agent turn it into
 * anything. Installs from before keep their Home, the walk through Point, the agent and connectors
 * (resources/home). */
async function seedHome(run: <A, E>(e: Effect.Effect<A, E, any>) => Promise<A>, workspaces: WorkspacesShape, appRoot: string) {
  const filesOf = (folder: string, names: string[]) => Object.fromEntries(names.map((f) => [f, readFileSync(join(appRoot, 'resources', folder, f), 'utf8')]))
  const homeFiles = () => filesOf('home', ['App.jsx', 'home.css'])
  // What the checklist reads to tick itself: connectors, workspaces, schedules, and its own ticks in the store.
  const uses = { app: ['workspace_list', 'schedule_list', 'db_get', 'db_put'], agents: '*' as const }
  const makeHome = () =>
    run(workspaces.create({ name: 'Onboarding', icon: 'list-checks', color: 'purple', files: filesOf('onboarding', ['App.jsx', 'onboarding.css']), uses }).pipe(Effect.flatMap((w) => workspaces.update(w.id, { home: true, onboarding: true })))).then(
      (w) => run(workspaces.reorder([w.id])),
      (e) => console.error('[home]', e),
    )
  if (!workspaces.list().length) await makeHome()
  // From when Home was the chat template: that workspace stays, with its sessions, as an ordinary Chat
  // (name and icon change back only if they were never touched), and a blank Home takes its place.
  const chatHome = workspaces.list().find((w) => w.home && w.origin === 'chat')
  if (chatHome) await run(workspaces.update(chatHome.id, { home: false, name: chatHome.name === 'Home' ? 'Chat' : undefined, icon: chatHome.icon?.toLowerCase() === 'house' ? 'message-circle' : undefined })).catch((e) => console.error('[home]', e))
  if (!workspaces.list().some((w) => w.home)) await makeHome()
  // A Home made before the walk-through, still exactly the blank page it started as, gets it.
  const blankHome = workspaces.list().find((w) => w.home && !w.origin)
  const blankFile = blankHome && join(blankHome.dir, 'App.jsx')
  if (blankFile && existsSync(blankFile) && readFileSync(blankFile, 'utf8') === BLANK_APP.replace('title="New workspace"', 'title="Home"'))
    for (const [f, text] of Object.entries(homeFiles())) writeFileSync(join(blankHome.dir, f), text)
}

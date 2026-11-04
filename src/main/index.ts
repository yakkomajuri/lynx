// The Electron shell: one window, the IPC surface, and the sbw:// protocol that serves each
// workspace's bundle into its own frame. Everything else (agents, connectors, tools, the store) is the
// background service's (src/daemon), which this process starts if it is not running and leaves
// running when it quits.
import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, nativeTheme, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { comboOf, sameCombo, type Combo, type KeyPress } from '../kit/keys'
import { DEFAULT_MODE, isMode } from '@shared/themes'
import { OWNER_LABEL, type AppEvent, type AppState, type FindPlace, type WorkspaceInfo } from '@shared/types'
import type { VoiceModelId } from '@shared/voice'
import { readRequest } from '@shared/reads'
import type { ServiceSnapshot } from './runtime'
import { SCOPE_ALL_SESSIONS, classify, describe } from './consent'
import { attach } from './background'
import { fixPath } from './env'
import { keepLog } from './log'
import { keepSiteIcons, siteIcon } from './siteIcons'
import { attachments } from './attachments'
import { attachFind, find, placeFind, stopFind } from './find'
import { makeUpdater, updateConfig } from './updates'
import { openInTerminal, runnable } from './terminal'
import { makeCaffeinate } from './caffeinate'
import { isPreviewUrl, previewHeaders } from './previewSecurity'
import { makeVoice } from './voice'
import { makeVoiceFix } from './voiceFix'
import { makeUsage } from './usage'

protocol.registerSchemesAsPrivileged([{ scheme: 'sbw', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.html': 'text/html', '.woff2': 'font/woff2' }
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

function preloadPath(name = 'index') {
  const dir = join(import.meta.dirname, '../preload')
  for (const f of [`${name}.cjs`, `${name}.mjs`, `${name}.js`]) if (existsSync(join(dir, f))) return join(dir, f)
  return join(dir, `${name}.cjs`)
}

async function main() {
  fixPath()
  if (process.env.LYNX_DATA) app.setPath('userData', process.env.LYNX_DATA)
  // A data folder reached through a symlink goes by the folder it points to: that is the name the running
  // service was started with (its --data tag) and the one sessions recorded, and they are compared as text.
  try {
    app.setPath('userData', realpathSync(app.getPath('userData')))
  } catch {}
  keepLog(join(app.getPath('userData'), 'lynx.log'), 'window')
  console.error(`[window] Lynx ${app.getVersion()} starting (${process.execPath})`)
  // One app per data folder. Lynx and Lynx Dev share one, and two at once would each refresh the
  // same single-use sign-in tokens (one of them losing) and run two agent backends on one database.
  // A copy that does not get the lock never becomes ready: leave at once, and the one running says why.
  if (!app.requestSingleInstanceLock()) {
    console.error('[window] another Lynx window holds this data folder; leaving')
    return app.exit(0)
  }
  app.on('second-instance', (_e, argv) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win?.isMinimized()) win.restore()
    win?.focus()
    if (argv[0] && argv[0] !== process.execPath && !process.env.LYNX_E2E)
      void dialog.showMessageBox({ type: 'info', message: `${app.getName()} is already open`, detail: `Lynx and Lynx Dev share their data, so only one runs at a time. Quit ${app.getName()} to open the other.` })
  })
  await app.whenReady()

  const dataDir = app.getPath('userData')
  keepSiteIcons(join(dataDir, 'site-icons'))
  const staging = attachments(dataDir)
  void staging.sweep()
  const send = (e: AppEvent) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('sb:event', e)
  }
  const agentDir = join(dataDir, 'agent')
  mkdirSync(agentDir, { recursive: true })
  let pushing: NodeJS.Timeout | undefined
  let disposed = false
  // The service can report a change while it is still being attached, before there is a state to send:
  // until `getState` exists below, pushes do nothing, and one is sent once it does.
  let ready = false
  // Whether anything but a workspace's build changed since the last push: a quiet push leaves cached reads be.
  let loud = false
  const pushState = (quiet = false) => {
    loud ||= !quiet
    clearTimeout(pushing)
    pushing = setTimeout(() => {
      if (!ready || disposed) return
      const q = !loud
      loud = false
      void getState().then((state) => send({ t: 'state', state, quiet: q })).catch(() => undefined)
    }, 30)
  }
  // The background service: started here if it is not running already (or, LYNX_DAEMON=0, in this process).
  // Starting can take a while: a new version's first launch is checked by macOS, and a service from
  // before may be busy or on its way out. Past a moment the window says so, instead of showing nothing.
  const attaching = Date.now()
  let splash: BrowserWindow | undefined
  const splashing = process.env.LYNX_E2E ? undefined : setTimeout(() => (splash = showSplash()), 1500)
  const closeSplash = () => {
    clearTimeout(splashing)
    if (splash && !splash.isDestroyed()) splash.destroy()
  }
  const service = await attach({
    dataDir,
    appRoot: process.env.LYNX_ROOT ?? app.getAppPath(),
    outDir: import.meta.dirname,
    inProcess: process.env.LYNX_DAEMON === '0',
    onEvent: (e) => (e.t === 'changed' ? pushState() : (send(e), e.t === 'built' && pushState(true))),
    onStatus: () => pushState(),
  }).catch((e: Error) => {
    closeSplash()
    console.error(`[window] could not start the background service: ${e.message}`)
    dialog.showErrorBox('Lynx could not start its background service', e.message)
    throw e
  })
  console.error(`[window] connected to the background service after ${((Date.now() - attaching) / 1000).toFixed(1)}s`)
  // The last state the service gave, for what this process looks up itself (workspaces, connectors).
  let known: ServiceSnapshot = await (async () => {
    // A service being replaced as the window starts may miss a beat; the client finds the next one.
    for (let i = 0; ; i++) {
      try {
        return await service.state()
      } catch (e) {
        if (i >= 60) throw e
        if (i === 0) console.error(`[window] the service has no state for the window yet: ${e instanceof Error ? e.message : e}`)
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  })()
  // Light or dark as chosen in Appearance. Through nativeTheme it is what prefers-color-scheme says in
  // every page of the window, workspaces included. A service from before modes says nothing: the system's.
  const wearMode = (s: ServiceSnapshot) => {
    const mode = isMode(s.settings.mode) ? s.settings.mode : DEFAULT_MODE
    if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode
  }
  wearMode(known)
  // Updates belong to the installed window, not the background service. Installing quits as "Quit and
  // Stop Agents" does: the service runs from the app that is about to be replaced.
  const updater = makeUpdater({ current: app.getVersion(), config: updateConfig({ appRoot: process.env.LYNX_ROOT ?? app.getAppPath(), dataDir }), execPath: process.execPath, packaged: app.isPackaged, onChange: () => pushState(), quit: () => ((stopAgents = true), app.quit()) })
  // Voice mode: the speech models, and the process that runs one while the user talks to the agent.
  const voice = makeVoice({ dataDir, outDir: import.meta.dirname, onChange: () => pushState(), onEvent: (e) => send({ t: 'voice', ...e }) })
  app.on('will-quit', voice.dispose)
  const voiceFix = makeVoiceFix()
  app.on('will-quit', voiceFix.dispose)
  const getState = async (): Promise<AppState> => {
    const status = service.status()
    const fresh = await service.state().then(
      (s) => {
        wearMode(s)
        return (known = s)
      },
      () => null,
    )
    // While it is away the window keeps what it last knew, and says so.
    const engine = fresh ? known.engine : { status: 'starting' as const, detail: 'Reconnecting to the background service' }
    return { ...known, engine, dataDir, agentDir, service: status, update: updater.state(), voice: voice.state(), windowButtons: !BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && (w.isFullScreen() || w.isSimpleFullScreen())) }
  }
  /** A workspace by id; one this process has not heard of yet (just made) is looked up again. */
  const workspaceOf = async (id: string) => known.workspaces.find((w) => w.id === id) ?? (await getState().catch(() => undefined), known.workspaces.find((w) => w.id === id))
  const workspaces = { get: (id: string) => known.workspaces.find((w) => w.id === id), list: () => known.workspaces }
  ready = true
  pushState()

  // ── sbw://<workspace>/… : the page, its bundle, and any static file in the workspace folder
  protocol.handle('sbw', async (request) => {
    const url = new URL(request.url)
    const id = url.hostname
    // sbw://preview.<shelf>.<item>/ : a marketplace item on made-up data. Dots never appear in a workspace id.
    const shown = /^preview\.(local|remote)\.([a-z0-9-]+)$/.exec(id)
    if (shown) return servePreview(shown[1]!, shown[2]!, decodeURIComponent(url.pathname))
    const ws = await workspaceOf(id)
    if (!ws) return new Response('No such workspace', { status: 404 })
    const headers = { 'cache-control': 'no-store' }
    const path = decodeURIComponent(url.pathname)
    if (path === '/' || path === '/index.html') {
      const bundle = await service.bundle(id).catch((e: Error) => e)
      const boot = JSON.stringify({ id, name: ws.name, dir: ws.dir, connectors: ws.connectors }).replace(/</g, '\\u003c')
      const body =
        bundle instanceof Error
          ? `<pre style="font:12px ui-monospace,Menlo,monospace;white-space:pre-wrap;padding:24px;color:#b3261e">${escapeHtml(bundle.message)}</pre>`
          : `<div id="root"></div><script>window.__SB_WORKSPACE__=${boot}</script><link rel="stylesheet" href="/bundle.css?v=${bundle.version}"><script src="/bundle.js?v=${bundle.version}"></script>`
      // Home is the app's own page, so it starts in the app's theme; the window tells it when that changes.
      return new Response(`<!doctype html><html${ws.home ? ` data-sb-theme="${known.settings.theme}"` : ''}><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(ws.name)}</title></head><body>${body}</body></html>`, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
    }
    if (path === '/bundle.js' || path === '/bundle.css') {
      const bundle = await service.bundle(id).catch((e: Error) => (console.error(`[sbw] ${id}${path}: ${e.message}`), null))
      if (!bundle) return new Response('', { status: 404 })
      return new Response(path.endsWith('.js') ? bundle.js : bundle.css, { headers: { ...headers, 'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' } })
    }
    // Resolve symlinks before checking: only files that really live in the workspace folder are served.
    const [base, file] = await Promise.all([realpath(ws.dir), realpath(normalize(join(ws.dir, path))).catch(() => '')])
    if (!file || !file.startsWith(base + sep) || file.startsWith(join(base, '.data') + sep)) return new Response('', { status: 404 })
    return readFile(file).then(
      (data) => new Response(new Uint8Array(data), { headers: { ...headers, 'content-type': MIME[extname(file)] ?? 'application/octet-stream' } }),
      () => new Response('', { status: 404 }),
    )
  })

  const servePreview = async (source: string, item: string, path: string) => {
    const headers = previewHeaders(source, item)
    const bundle = await service.preview(source, item).catch((e: Error) => e)
    if (path === '/bundle.js' || path === '/bundle.css') {
      if (bundle instanceof Error) return new Response('', { status: 404 })
      return new Response(path.endsWith('.js') ? bundle.js : bundle.css, { headers: { ...headers, 'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' } })
    }
    if (path !== '/' && path !== '/index.html') return new Response('', { status: 404 })
    const body = bundle instanceof Error ? `<pre style="font:12px ui-monospace,Menlo,monospace;white-space:pre-wrap;padding:24px;color:#b3261e">${escapeHtml(bundle.message)}</pre>` : `<div id="root"></div><link rel="stylesheet" href="/bundle.css"><script src="/bundle.js"></script>`
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"></head><body>${body}</body></html>`, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
  }

  // ── IPC. Nearly everything is `call`: a tool on a connector, the same path workspace UIs use.
  // Only the host window's own page may use the bridge; workspace frames reach it through the host.
  const hostPage = pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
  const fromHost = (e: IpcMainInvokeEvent) => {
    const frame = e.senderFrame
    if (!frame || frame !== e.sender.mainFrame) return false
    const url = frame.url
    return isDev ? new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL!).origin : url.split(/[?#]/)[0] === hostPage
  }
  const guard = <A extends unknown[], R>(f: (e: IpcMainInvokeEvent, ...args: A) => R) => (e: IpcMainInvokeEvent, ...args: A) => {
    if (!fromHost(e)) throw new Error('Not allowed from this frame')
    return f(e, ...args)
  }

  // Calls from workspace code are judged by consent.ts. Grants the user chose to keep live in the
  // app's own data, keyed to the workspace as created (a new workspace reusing an id starts clean).
  const strict = process.env.LYNX_STRICT === '1'
  const grantsFile = join(dataDir, 'grants.json')
  let grants: Record<string, string[]> = {}
  try {
    grants = JSON.parse(readFileSync(grantsFile, 'utf8'))
  } catch {
    /* none yet */
  }
  const grantKey = (id: string) => `${id}@${workspaces.get(id)?.createdAt ?? ''}`
  // Standing permissions given "until I quit" live here; "always" ones are written to disk.
  const untilQuit = new Set<string>()
  const granted = (id: string, scope: string) => !!grants[grantKey(id)]?.includes(scope) || untilQuit.has(`${grantKey(id)}\n${scope}`)
  const grant = (id: string, scope: string) => {
    grants[grantKey(id)] = [...new Set([...(grants[grantKey(id)] ?? []), scope])]
    writeFileSync(grantsFile, JSON.stringify(grants, null, 2), { mode: 0o600 })
  }

  const refusedUntil = new Map<string, number>()
  let prompting: Promise<unknown> = Promise.resolve()
  // Conversations belong to the workspace that started them. Every session a workspace starts is
  // labelled with it here (not by the workspace), and its reads are narrowed to that label.
  const owners = new Map<string, string | null>()
  const ownerOf = async (sessionId: unknown) => {
    if (typeof sessionId !== 'string') return null
    if (!owners.has(sessionId)) {
      const info: any = await service.call('agents', 'session_get', { id: sessionId }).catch(() => null)
      if (!info) return null
      owners.set(sessionId, info.session?.labels?.[OWNER_LABEL] ?? null)
    }
    return owners.get(sessionId) ?? null
  }
  const sessionOfRun = async (runId: unknown) => (typeof runId === 'string' ? ((await service.call('agents', 'run_get', { id: runId }).catch(() => null)) as any)?.session_id : null)
  const sessionOfInput = async (inputId: unknown) => ((await service.call('agents', 'input_list', { limit: 500 }).catch(() => null)) as any)?.items?.find((i: any) => i.id === inputId)?.session_id
  /** Which conversations a call on the agents connector touches, after narrowing list-style calls to the caller's own. */
  const scopeSessions = async (workspace: string, tool: string, args: Record<string, unknown>): Promise<'own' | 'other'> => {
    if (granted(workspace, SCOPE_ALL_SESSIONS)) return 'own'
    // Ownership is this incarnation of the workspace (id and creation time), under a label only the app sets.
    const me = grantKey(workspace)
    const mine = async (sessionId: unknown) => ((await ownerOf(sessionId)) === me ? 'own' : 'other')
    const labels = () => ({ ...(args.labels && typeof args.labels === 'object' && !Array.isArray(args.labels) ? (args.labels as object) : {}), [OWNER_LABEL]: me })
    switch (tool) {
      case 'session_start':
      case 'session_list':
      case 'session_search':
        args.labels = labels()
        return tool === 'session_search' && args.session_id ? mine(args.session_id) : 'own'
      case 'session_get':
      case 'session_history':
      case 'session_send':
      case 'session_archive':
      case 'session_connections_set':
        return mine(args.id)
      case 'event_payload':
      case 'payload_read':
        return mine(args.stream_id)
      case 'run_get':
      case 'run_wait':
      case 'run_cancel':
        return mine(await sessionOfRun(args.id))
      case 'input_respond':
        return mine(await sessionOfInput(args.id))
      case 'input_list':
        return args.session_id ? mine(args.session_id) : args.run_id ? mine(await sessionOfRun(args.run_id)) : 'other'
      default:
        return 'own'
    }
  }

  // ── the manifest: a workspace's UI may call exactly what its workspace.json lists under "uses".
  // It is a description first (what does this workspace touch?) and it stays true because it is
  // enforced. Nothing is asked of the user: whoever writes the UI adds a line.
  /** What every UI may call: the kit asks for the list of connectors, and their icons, on its own. */
  const ALWAYS = new Set(['app.connector_list', 'app.connector_icon'])
  /** The connector a name means in a workspace: its binding for that alias, else the connector of that id. */
  const resolve = (ws: WorkspaceInfo, name: string) => (Object.hasOwn(ws.connectors, name) ? ws.connectors[name]! : name)
  // The check is on the connector the call will actually reach. A manifest entry speaks for the
  // connector its name resolves to, exactly as a call under that name would; so an entry can
  // never let through a call to some other connector that happens to share its name.
  const undeclared = (ws: WorkspaceInfo, connector: string, tool: string): string | null => {
    const entries = Object.entries(ws.uses).filter(([name]) => resolve(ws, name) === connector)
    if (entries.some(([, listed]) => listed === '*' || listed.includes(tool)) || ALWAYS.has(`${connector}.${tool}`)) return null
    const name = entries[0]?.[0] ?? Object.keys(ws.connectors).find((alias) => ws.connectors[alias] === connector) ?? connector
    const listed = entries[0]?.[1]
    return `${name}.${tool} is not in this workspace's manifest. Add it to "uses" in workspace.json: "uses": { ${JSON.stringify(name)}: [${[...(Array.isArray(listed) ? listed : []), tool].map((t) => JSON.stringify(t)).join(', ')}] } (or "*" for every tool of ${name}).`
  }

  const consent = async (e: IpcMainInvokeEvent, workspace: string, connector: string, tool: string, args: Record<string, unknown>): Promise<string | null> => {
    const ws = workspaces.get(workspace)
    if (!ws) return 'Unknown workspace'
    const sessions = connector === 'agents' ? await scopeSessions(workspace, tool, args) : 'own'
    const verdict = classify({ caller: workspace, bound: Object.values(ws.connectors), sessions }, known.connectors.find((c) => c.id === connector), tool, args)
    if (verdict.kind === 'allow') return null
    if (verdict.kind === 'deny') return verdict.reason
    if (verdict.scope && granted(workspace, verdict.scope)) return null
    // After a refusal the workspace stays refused for a while, so it cannot nag its way to a yes.
    if ((refusedUntil.get(workspace) ?? 0) > Date.now()) return 'You did not allow this.'
    const detail = describe([['Workspace name', ws.name], ...verdict.details])
    if (detail === null) return 'This request is too long to show you in full, so it was refused.'
    // One prompt at a time. The sentence is the app's; everything the workspace supplied sits below it, labelled and escaped.
    const ask = async () => {
      if (verdict.scope && granted(workspace, verdict.scope)) return null
      if ((refusedUntil.get(workspace) ?? 0) > Date.now()) return 'You did not allow this.'
      const win = BrowserWindow.fromWebContents(e.sender)
      const buttons = verdict.scope ? ['Don’t allow', 'Allow until I quit', 'Always allow for this workspace'] : ['Don’t allow', 'Allow once']
      const options = { type: 'warning' as const, noLink: true, buttons, defaultId: 0, cancelId: 0, title: 'Lynx', message: `The workspace “${workspace}” is asking to ${verdict.action}.`, detail: `${detail}\n\nThis request comes from that workspace's code, not from Lynx. Only allow it if you expected it.` }
      // Test runs cannot click a native dialog: the harness answers through a file in its own data directory.
      const scripted = process.env.LYNX_E2E ? (existsSync(join(dataDir, 'e2e-consent')) ? readFileSync(join(dataDir, 'e2e-consent'), 'utf8').trim() : 'deny') : null
      if (scripted) console.log(`[consent] ${scripted}: ${options.message} | ${detail.replace(/\n/g, ' | ')}`)
      const { response } = scripted ? { response: scripted === 'allow' ? 1 : scripted === 'always' ? 2 : 0 } : win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      if (response === 0) {
        refusedUntil.set(workspace, Date.now() + 30000)
        return 'You did not allow this.'
      }
      if (verdict.scope) response === 2 ? grant(workspace, verdict.scope) : untilQuit.add(`${grantKey(workspace)}\n${verdict.scope}`)
      return null
    }
    const result = prompting.then(ask, ask)
    prompting = result
    return result
  }

  ipcMain.handle('sb:state', guard(() => getState()))
  ipcMain.handle(
    'sb:call',
    guard(async (e, req: { workspace?: string; connector: string; tool: string; args?: Record<string, unknown>; read?: unknown }) => {
      const ws = req.workspace ? await workspaceOf(req.workspace) : undefined
      try {
        let connector = ws ? resolve(ws, String(req.connector)) : String(req.connector)
        let tool = String(req.tool)
        let args: Record<string, unknown> = req.args && typeof req.args === 'object' && !Array.isArray(req.args) ? structuredClone(req.args) : {}
        // The window itself (its dialogs, the agent panel) is the user, not workspace code.
        if (!req.workspace) return { ok: true, data: await service.call(connector, tool, args, { by: 'user', depth: 0, read: readRequest(req.read) }) }
        if (!ws) return { ok: false, error: 'Unknown workspace' }
        // app.connector_call is a call on another connector. Peel every layer off first, so the
        // call that is judged is, by construction, the very call that runs.
        let wrapped = 0
        while (connector === 'app' && tool === 'connector_call') {
          if (++wrapped > 4) return { ok: false, error: 'connector_call is nested too deeply' }
          const inner = args.arguments
          connector = String(args.connector)
          tool = String(args.tool)
          args = inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {}
        }
        // Only the window answers the app connector's requests of it.
        if (connector === 'app' && tool === 'window_reply') return { ok: false, error: 'Only the window answers the app connector' }
        // A manifest changed a moment ago may not have reached this process yet: look again before refusing.
        const missing = undeclared(ws, connector, tool) && undeclared((await getState(), workspaces.get(ws.id)) ?? ws, connector, tool)
        if (missing) {
          // Shown in the window with "ask the agent to fix it", and reported by workspace_build.
          void service.runtimeError(ws.id, missing)
          return { ok: false, error: missing }
        }
        // Beyond the manifest, connectors are open: no prompts. The permission policy in
        // consent.ts only applies when the app is started with LYNX_STRICT=1.
        const refused = strict ? await consent(e, req.workspace, connector, tool, args) : null
        if (refused) return { ok: false, error: refused }
        let data: unknown = await service.call(connector, tool, args, { by: `workspace:${ws.id}`, depth: 0, read: readRequest(req.read) })
        // Each peeled layer would have answered { result }.
        for (; wrapped > 0; wrapped--) data = { result: data }
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )
  ipcMain.handle('sb:runtime-error', guard((_e, req: { workspace: string; error: string | null }) => service.runtimeError(req.workspace, req.error)))
  ipcMain.handle('sb:held', guard((_e, req: { workspace: string; version: number | null }) => service.held(req.workspace, req.version)))
  // Icons for addresses that aren't connectors yet (the suggestions on the Connectors page). Host
  // only: workspace code gets icons by connector id, never for an address it picks.
  ipcMain.handle('sb:site-icon', guard((_e, url: string) => siteIcon(url)))
  // Files dropped or pasted on a conversation, as paths the agent engine can attach.
  ipcMain.handle(
    'sb:stage-file',
    guard((_e, req: { path?: string; name?: string; bytes?: Uint8Array }) =>
      staging.stage(req).then(
        (data) => ({ ok: true as const, data }),
        (err) => ({ ok: false as const, error: String(err?.message ?? err) }),
      ),
    ),
  )
  ipcMain.handle('sb:update-check', guard(() => updater.check()))
  ipcMain.handle('sb:update-install', guard(() => updater.install()))
  ipcMain.handle('sb:update-restart', guard(() => updater.restart()))
  ipcMain.handle('sb:update-download', guard(() => {
    const url = updater.downloadUrl()
    if (!url) throw new Error('The update feed does not say where to download it')
    return shell.openExternal(url)
  }))
  // ⌘F in the window: the find bar over a workspace, and the finds it asks for (src/main/find.ts).
  ipcMain.handle('sb:find', guard((e, req: { text: string; step?: boolean; forward?: boolean }) => find(e.sender, { text: String(req?.text ?? ''), step: !!req?.step, forward: req?.forward !== false })))
  ipcMain.handle('sb:find-place', guard((e, p: FindPlace) => placeFind(e.sender, p, preloadPath('find'))))
  ipcMain.handle('sb:find-stop', guard((e) => stopFind(e.sender)))
  // `/login` in the agent panel: the agent's own sign-in, in a terminal. The command is the one the
  // agent engine lists for that agent, never one the window sends.
  ipcMain.handle(
    'sb:agent-login',
    guard(async (_e, harness: string) => {
      const status = (await service.call('agents', 'server_status', {})) as { providers?: { name: string; display_name?: string; login_command?: string[] }[] }
      const provider = status.providers?.find((p) => p.name === harness)
      const command = provider?.login_command
      if (!runnable(command)) throw new Error(`${provider?.display_name ?? harness} has no sign-in command`)
      // The end-to-end run checks what would open, and leaves the screen alone.
      if (process.env.LYNX_E2E) console.log(`[terminal] ${command.join(' ')}`)
      else await openInTerminal(command, `When you are signed in, close this window and go back to ${app.getName()}.`)
      return command.join(' ')
    }),
  )
  // Caffeinate in the command bar: the Mac kept awake for some hours (src/main/caffeinate.ts).
  const caffeinate = makeCaffeinate(dataDir)
  ipcMain.handle('sb:caffeinate', guard((_e, req: { hours: number | null }) => (req?.hours == null ? caffeinate.stop() : caffeinate.start(Number(req.hours)))))
  ipcMain.handle('sb:caffeinate-status', guard(() => caffeinate.status()))
  // Settings › Usage: how much of their plans Claude Code and Codex have left (src/main/usage.ts).
  const usage = makeUsage()
  ipcMain.handle('sb:usage', guard((_e, req: { fresh?: boolean }) => usage.read(!!req?.fresh)))
  ipcMain.handle('sb:open-external', guard((_e, url: string) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined)))
  // Only workspace folders and the tools folder are revealed; this never opens (and so never launches) an arbitrary path.
  ipcMain.handle('sb:open-path', guard((_e, path: string) => (workspaces.list().some((w) => w.dir === path) || path === join(dataDir, 'tools') || path === service.status().logFile ? shell.openPath(path) : undefined)))

  // Voice mode (src/main/voice.ts). The microphone's samples come as plain messages, many a second.
  ipcMain.handle('sb:voice-set', guard((_e, patch: { enabled?: boolean; model?: VoiceModelId; speak?: boolean; autoSend?: boolean; pause?: number; listenAway?: boolean }) => voice.set({ enabled: patch?.enabled, model: patch?.model, speak: patch?.speak, autoSend: patch?.autoSend, pause: patch?.pause, listenAway: patch?.listenAway })))
  ipcMain.handle('sb:voice-fix', guard((_e, req: { harness: string; model: string; text: string; names: string[] }) => voiceFix.fix({ harness: String(req.harness), model: String(req.model), text: String(req.text), names: Array.isArray(req.names) ? req.names.map(String).slice(0, 200) : [] })))
  ipcMain.handle('sb:voice-fix-warm', guard((_e, req: { harness: string; model: string }) => voiceFix.warm(String(req.harness), String(req.model))))
  ipcMain.handle('sb:voice-install', guard((_e, model: VoiceModelId) => voice.install(model)))
  ipcMain.handle('sb:voice-remove', guard((_e, model: VoiceModelId) => voice.remove(model)))
  ipcMain.handle('sb:voice-cancel', guard(() => voice.cancel()))
  ipcMain.handle('sb:voice-prepare', guard(() => voice.prepare()))
  ipcMain.handle('sb:voice-start', guard(() => voice.start()))
  ipcMain.handle('sb:voice-stop', guard(() => voice.stop()))
  ipcMain.handle('sb:voice-reset', guard(() => voice.reset()))
  ipcMain.handle('sb:voice-say', guard((_e, text: string) => voice.say(text)))
  ipcMain.handle('sb:voice-hush', guard(() => voice.hush()))
  ipcMain.on('sb:voice-audio', (e, samples: unknown) => fromHost(e as unknown as IpcMainInvokeEvent) && samples instanceof Float32Array && voice.audio(samples))

  // ⌘` and ⇧⌘` move between windows on a Mac (System Settings › Keyboard › Shortcuts), and Chromium keeps such keys
  // from the page, before-input-event included. A menu item still gets them: hidden ones here, so a shortcut can have them.
  const systemKeys = new Map<BrowserWindow, (press: KeyPress) => void>()
  const createWindow = () => {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 940,
      minHeight: 560,
      title: 'Lynx',
      titleBarStyle: 'hiddenInset',
      // Level with the title, which is centred in the 56px title bar.
      trafficLightPosition: { x: 16, y: 19 },
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#131314' : '#f4f3ef',
      // Test runs skip the first-run screen, which would stand over everything they click, unless they ask for it (LYNX_FIRST_RUN).
      webPreferences: { preload: preloadPath(), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, additionalArguments: process.env.LYNX_E2E && !process.env.LYNX_FIRST_RUN ? ['--lynx-skip-first-run'] : [] },
      show: false,
    })
    // Under test the window opens without taking the keyboard from whatever the user is doing, or (E2E_HIDDEN) not at all.
    win.once('ready-to-show', () => {
      closeSplash()
      console.error(`[window] shown ${((Date.now() - attaching) / 1000).toFixed(1)}s after connecting began`)
      return process.env.LYNX_E2E === 'hidden' ? undefined : process.env.LYNX_E2E ? win.showInactive() : win.show()
    })
    win.on('unresponsive', () => console.error('[window] the page stopped responding'))
    // A page that went (it crashed, or ran out of memory) is loaded again, rather than leave an empty window.
    // One that keeps going stays as it is, and the log says so.
    let gone: number[] = []
    win.webContents.on('render-process-gone', (_e, d) => {
      console.error(`[window] the page went: ${d.reason}`)
      if (d.reason === 'clean-exit' || win.isDestroyed()) return
      gone = [...gone.filter((at) => Date.now() - at < 60_000), Date.now()]
      if (gone.length > 3) return console.error('[window] the page went four times in a minute; not loading it again')
      win.webContents.reload()
    })
    // The window's own errors, in lynx.log, so one that went wrong can be looked into afterwards. Workspaces in their
    // frames report theirs on their own (sb:runtime-error).
    let lastError = ''
    win.webContents.on('console-message', (e) => {
      if (e.level !== 'error' || e.frame !== win.webContents.mainFrame || e.message === lastError) return
      lastError = e.message
      console.error(`[page] ${e.message.slice(0, 4000)}`)
    })
    // Voice mode's own notes from the page, with LYNX_VOICE_DEBUG=1, go in the log beside the speech process's.
    if (process.env.LYNX_VOICE_DEBUG === '1') win.webContents.on('console-message', (e) => e.message.startsWith('[voice]') && console.error(e.message))
    attachFind(win)
    // The window buttons come and go with full screen, and the sidebar toggle sits beside them.
    win.on('enter-full-screen', () => pushState())
    win.on('leave-full-screen', () => pushState())
    // ⌘W closes the window, unless the page has something to close instead: the agent's tab while the keyboard
    // is in it, or the focused pane of two side by side. The page says which keys, as they can be changed.
    // The menu would take the keys before the page saw them, so they are caught here, frames included.
    let closeKeys: Combo | null = null
    // Setting a shortcut's keys: each press goes to the page and nowhere else, so ⌘W or ⌘M can be had too.
    let recording = false
    const onCloseHere = (e: Electron.IpcMainEvent, keys: Combo | null) => e.sender === win.webContents && (closeKeys = keys && typeof keys.key === 'string' ? keys : null)
    const onRecord = (e: Electron.IpcMainEvent, on: boolean) => e.sender === win.webContents && (recording = !!on)
    ipcMain.on('sb:close-here', onCloseHere)
    ipcMain.on('sb:record-keys', onRecord)
    // The service shows notifications on the desktop while no window is open, even with Lynx still running.
    const openWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length
    service.setWindows(openWindows())
    win.on('closed', () => {
      systemKeys.delete(win)
      ipcMain.off('sb:close-here', onCloseHere)
      ipcMain.off('sb:record-keys', onRecord)
      service.setWindows(openWindows())
    })
    // A page that reloads or crashes while recording would leave the keyboard dead.
    win.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => isMainFrame && ((recording = false), (closeKeys = null)))
    win.webContents.on('render-process-gone', () => ((recording = false), (closeKeys = null)))
    // A press the window takes before the page: true when it did.
    const take = (press: KeyPress) => {
      if (recording) {
        win.webContents.send('sb:event', { t: 'key', press } satisfies AppEvent)
        return true
      }
      const combo = closeKeys && comboOf(press, process.platform === 'darwin')
      if (combo && sameCombo(combo, closeKeys!, process.platform === 'darwin')) {
        win.webContents.send('sb:event', { t: 'close-pane' } satisfies AppEvent)
        return true
      }
      return false
    }
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return
      if (take({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift })) e.preventDefault()
    })
    // The keys the page never sees (⌘`, below) come here instead, and are a shortcut like any other.
    systemKeys.set(win, (press) => take(press) || win.webContents.send('sb:event', { t: 'shortcut', press } satisfies AppEvent))
    // The window only ever shows the host page; nothing can navigate it elsewhere.
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(({ url, referrer }) => {
      if (isPreviewUrl(referrer.url)) return { action: 'deny' }
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // Links inside workspace frames open in the browser instead of replacing the UI.
    win.webContents.on('will-frame-navigate', (e) => {
      // A preview cannot leave its sandbox via links, location changes, or external protocols.
      if (isPreviewUrl(e.frame?.url ?? '') || isPreviewUrl(e.initiator?.url ?? '')) {
        e.preventDefault()
        return
      }
      if (/^https?:\/\//.test(e.url) && !e.url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')) {
        e.preventDefault()
        void shell.openExternal(e.url)
      }
    })
    if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
    else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
    return win
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  // With every window closed the app stays in the Dock, as Mac apps do (with no listener, Electron would quit).
  app.on('window-all-closed', () => {})
  // Quitting leaves the background service running (agents, schedules, connectors), unless the user
  // turned that off or chose "Quit and Stop Agents".
  let stopAgents = false
  app.on('before-quit', (e) => {
    if (disposed) return
    e.preventDefault()
    disposed = true
    console.error(`[window] quitting${stopAgents ? ', stopping agents' : ''}`)
    updater.dispose()
    // The setting as it is now, not as last pushed to the window: it may have changed a moment ago.
    const keepRunning = Promise.race([service.state().then((s) => s.settings.background.keepRunning), new Promise<boolean>((_, no) => setTimeout(no, 1500))]).catch(() => known.settings.background.keepRunning)
    void keepRunning.then((keep) => service.quit(stopAgents || !keep)).finally(() => app.quit())
  })
  const menu = Menu.getApplicationMenu()
  const appMenu = menu?.items[0]?.submenu
  if (menu && appMenu) {
    appMenu.append(
      new MenuItem({
        label: 'Quit and Stop Agents',
        accelerator: 'Alt+Command+Q',
        click: () => {
          stopAgents = true
          app.quit()
        },
      }),
    )
    const backtick = (accelerator: string, shift: boolean) =>
      new MenuItem({
        label: shift ? 'Shortcut ⇧⌘`' : 'Shortcut ⌘`',
        accelerator,
        visible: false,
        acceleratorWorksWhenHidden: true,
        click: (_item, win) => {
          if (win instanceof BrowserWindow) systemKeys.get(win)?.({ key: shift ? '~' : '`', code: 'Backquote', metaKey: true, ctrlKey: false, altKey: false, shiftKey: shift })
        },
      })
    appMenu.append(backtick('Command+`', false))
    appMenu.append(backtick('Shift+Command+`', true))
    Menu.setApplicationMenu(menu)
  }
  ipcMain.handle(
    'sb:quit',
    guard((_e, opts: { stopAgents?: boolean }) => {
      stopAgents = !!opts?.stopAgents
      app.quit()
    }),
  )
}

/** A small window that says Lynx is starting, for while it waits for its background service. */
function showSplash() {
  const dark = nativeTheme.shouldUseDarkColors
  const splash = new BrowserWindow({ width: 320, height: 120, frame: false, resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false, show: false, title: 'Lynx', backgroundColor: dark ? '#131314' : '#f4f3ef', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;-webkit-app-region:drag;cursor:default}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;font:13px -apple-system,system-ui,sans-serif;color:${dark ? '#ececec' : '#1f1f1f'}}strong{font-size:14px;font-weight:600}span{color:${dark ? '#9a9a9a' : '#6b6b6b'}}</style><strong>Starting Lynx…</strong><span>Getting the background service ready</span>`
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  splash.once('ready-to-show', () => splash.show())
  console.error('[window] still connecting to the background service; showing that Lynx is starting')
  return splash
}

void main().catch((e) => {
  console.error(e)
  app.exit(1)
})

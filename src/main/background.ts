// The window's side of the background service (src/daemon): find the one running for this data
// folder or start it, follow its events, bring it back if it goes, and replace one left over from an
// older build once nothing is running on it. With LYNX_DAEMON=0 the service runs in this process
// instead, and stops with it.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, openSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AppEvent, ServiceState } from '@shared/types'
import { EXIT_PORT_TAKEN, dataTag, runningService, serviceAddress } from '../daemon/pid'
import { buildId, startService, type Service } from '../daemon/service'
import type { ServiceSnapshot } from './runtime'
import { daemonAddress, keepDaemonPort } from './services/Config'
import type { Caller } from './services/Connectors'

export interface Health {
  ok: true
  ready: boolean
  build: string
  pid: number
  startedAt: string
  busy: number
  retiring: boolean
  stopping: boolean
}

export interface BackgroundOptions {
  dataDir: string
  appRoot: string
  outDir: string
  inProcess: boolean
  /** Every event the service sends, `changed` included. */
  onEvent: (e: { t: 'changed' } | AppEvent) => void
  /** Connected, lost, replaced: the window's picture of the service changed. */
  onStatus: () => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MAX_LOG = 5 * 1024 * 1024

export async function attach(opts: BackgroundOptions) {
  const build = buildId(opts.outDir)
  const logFile = join(opts.dataDir, 'lynxd.log')
  let { port, token } = await daemonAddress(opts.dataDir)
  let local: Service | undefined
  let health: Health | null = null
  let connected = false
  let quitting = false
  let stream: AbortController | undefined
  let following: Promise<void> | undefined
  // Whether this process has a window open: the service shows notifications on the desktop only when no client does.
  const client = randomUUID()
  let windows = 0
  // A service from another build is replaced at most once per launch, so a build the window cannot
  // match (its files changed on disk) is not restarted over and over.
  let replaced = false
  /** Quitting stops everything that would start a service. */
  const halt = () => {
    if (quitting) throw new Error('Lynx is quitting')
  }

  const request = async (method: string, path: string, body?: unknown, timeout = 0) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    }).catch((e) => {
      // Nothing listening (between one service and the next): the request never got there.
      if ((e as { cause?: { code?: string } })?.cause?.code === 'ECONNREFUSED') throw Object.assign(new Error('The background service is restarting'), { unreached: true })
      throw e
    })
    const json: any = await res.json().catch(() => ({ ok: false, error: `Background service answered ${res.status}` }))
    if (res.status === 401) throw Object.assign(new Error('The background service did not accept this window'), { unauthorized: true })
    // Stopping: as good as away; the next one will answer. It did nothing with the request.
    if (res.status === 503) throw Object.assign(new Error(json?.error ?? 'The background service is stopping'), { unreached: true })
    return json
  }
  // Bounded, so a service that hangs cannot hang the window with it. Calls are given long enough for the
  // slowest tools (waits on runs and processes are at most 30s, custom tools have their own limits).
  const answer = async (path: string, body: unknown, timeout = 5 * 60_000) => {
    const r = await request('POST', path, body, timeout)
    if (!r.ok) throw Object.assign(new Error(r.error), { fromService: true })
    return r.data
  }
  /** For requests that can safely be sent twice (bundles): while the service is away (restarting, or
   * replaced after hanging, which takes up to about a minute), try again instead of failing what is on
   * screen. Its own errors come back at once. */
  const patiently = async <T>(f: () => Promise<T>): Promise<T> => {
    for (const end = Date.now() + 90_000; ; await sleep(500)) {
      try {
        return await f()
      } catch (e) {
        if ((e as { fromService?: boolean }).fromService || quitting || Date.now() > end) throw e
      }
    }
  }
  /** For any request: while the service is being replaced (an older build going once idle, one that
   * crashed), wait for the next instead of failing. Only requests it never received are sent again. */
  const delivered = async <T>(f: () => Promise<T>): Promise<T> => {
    for (const end = Date.now() + 90_000; ; await sleep(250)) {
      try {
        return await f()
      } catch (e) {
        if (!(e as { unreached?: boolean }).unreached || quitting || Date.now() > end) throw e
      }
    }
  }
  // Only lynxd's own answer counts: anything else on the port is as good as nothing there.
  const probe = (): Promise<Health | null> =>
    request('GET', '/v1/health', undefined, 1500).then(
      (r) => (r?.ok === true && typeof r.build === 'string' ? r : null),
      (e) => (e?.unauthorized ? Promise.reject(e) : null),
    )

  const spawnDaemon = () => {
    try {
      if (existsSync(logFile) && statSync(logFile).size > MAX_LOG) renameSync(logFile, `${logFile}.1`)
    } catch {
      /* logs are best effort */
    }
    const out = openSync(logFile, 'a')
    // Its own session (detached), so it is not in the window's process group and outlives it.
    const child = spawn(process.execPath, [join(opts.outDir, 'lynxd.js'), dataTag(opts.dataDir)], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LYNX_DAEMON_DATA: opts.dataDir, LYNX_DAEMON_ROOT: opts.appRoot },
    })
    child.unref()
    return child
  }

  const gone = async (pid: number, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150))
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
    return false
  }
  /** Stops whichever service runs for this data folder and waits until it has let go of it. */
  const stopRunning = async () => {
    await request('POST', '/v1/stop', { when: 'now' }, 2000).catch(() => undefined)
    const pid = runningService(opts.dataDir)
    if (pid && !(await gone(pid, 15000))) process.kill(pid, 'SIGKILL')
  }

  /** The service for this data folder, ready to answer: the one running, or a new one. */
  const ensure = async (): Promise<Health> => {
    if (opts.inProcess) {
      if (!local) {
        // A background service left running by a normal quit holds the data (and the port): it goes first.
        if ((await probe().catch(() => null)) || runningService(opts.dataDir)) await stopRunning()
        local = startService({ dataDir: opts.dataDir, appRoot: opts.appRoot, outDir: opts.outDir, port, token })
        await local.ready.catch(async (e) => {
          if (e?.code !== 'EADDRINUSE') throw e
          // Something that is not Lynx has the port.
          ;({ port, token } = await daemonAddress(opts.dataDir, true))
          local = startService({ dataDir: opts.dataDir, appRoot: opts.appRoot, outDir: opts.outDir, port, token })
          await local.ready
        })
      }
      return (health = (await probe())!)
    }
    let h = await probe().catch(async () => {
      // Something else holds the port, under another token: move to a port of our own.
      ;({ port, token } = await daemonAddress(opts.dataDir, true))
      return null
    })
    // No answer from a service that is running: it is busy or stuck, not gone. Give it time; one that
    // stays silent is stopped before another starts, so two never run on the same data.
    const silent = !h ? runningService(opts.dataDir) : null
    // It may be fine, only elsewhere: an older copy of Lynx (a disk image still mounted, a build lying
    // around) opened meanwhile can move the saved port from under it. Then it is where it says it is.
    const at = silent ? serviceAddress(opts.dataDir) : null
    if (at && at.pid === silent && at.port !== port) {
      const saved = port
      port = at.port
      h = await probe().catch(() => null)
      if (h) {
        console.error(`[background] the service (pid ${silent}) is on ${port}, not the saved ${saved}; using it`)
        keepDaemonPort(opts.dataDir, port)
      } else port = saved
    }
    console.error(h ? `[background] found the service on ${port} (pid ${h.pid}, ${h.build === build ? 'this build' : 'another build'}${h.ready ? '' : ', starting'}${h.stopping ? ', stopping' : ''})` : silent ? `[background] the service (pid ${silent}) is running but does not answer on ${port}; waiting up to 20s` : `[background] no service on ${port}`)
    if (silent) {
      for (const end = Date.now() + 20000; !h && Date.now() < end; ) await sleep(500), halt(), (h = await probe().catch(() => null))
      if (!h) {
        console.error(`[background] the service (pid ${silent}) has not answered for 20s; replacing it`)
        process.kill(silent, 'SIGTERM')
        if (!(await gone(silent, 10000))) process.kill(silent, 'SIGKILL')
      }
    }
    if (!h || h.stopping) {
      // One that is on its way out finishes first, so two never run on the same data.
      for (let i = 0; h?.stopping && i < 100; i++) await sleep(150), (h = await probe().catch(() => null))
      halt()
      console.error(`[background] starting a service on ${port}`)
      let child = spawnDaemon()
      let exited: number | null = null
      let moved = false
      const watch = () => child.once('exit', (code) => (exited = code ?? 1))
      watch()
      for (let i = 0; i < 400 && !h; i++) {
        await sleep(i < 20 ? 50 : 150)
        halt()
        h = await probe().catch(() => null)
        // Only a port held by something that is not Lynx (the service says so) is a reason to move.
        if (!h && exited === EXIT_PORT_TAKEN && !moved) {
          moved = true
          ;({ port, token } = await daemonAddress(opts.dataDir, true))
          console.error(`[background] the port was taken by something else; moving to ${port}`)
          exited = null
          child = spawnDaemon()
          watch()
          continue
        }
        if (!h && exited !== null && exited !== 0) throw new Error(`The background service did not start (exit ${exited}); see ${logFile}`)
      }
      if (!h) throw new Error(`The background service did not answer; see ${logFile}`)
    }
    const waited = Date.now()
    for (let i = 0; !h.ready && i < 800; i++) await sleep(150), (h = (await probe()) ?? h)
    if (Date.now() - waited > 1000) console.error(`[background] waited ${((Date.now() - waited) / 1000).toFixed(1)}s for the service to be ready${h.ready ? '' : ', and it still is not'}`)
    health = h
    // Left over from another build (an update, Lynx Dev and Lynx): it goes once nothing is running on it,
    // and the window starts this build's in its place. Idle, it goes at once: wait it out and start ours
    // now, so the window never begins on a service that is leaving. Busy, the window uses it meanwhile.
    if (h.build !== build && !h.retiring && !replaced) {
      replaced = true
      console.error(`[background] the service is another build (pid ${h.pid}); asking it to stop ${h.busy ? 'once idle' : 'now'}`)
      await request('POST', '/v1/stop', { when: 'idle' }).catch(() => undefined)
      if (!h.busy) {
        for (let i = 0; i < 100 && (await probe().catch(() => null)); i++) await sleep(150)
        return ensure()
      }
    }
    return h
  }

  // ── events. The stream ending means the service went (or is going): find it again, or start it.
  const follow = async () => {
    stream = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/v1/events?client=${client}&windows=${windows}`, { headers: { authorization: `Bearer ${token}` }, signal: stream.signal })
    if (!res.ok || !res.body) throw new Error(`events: ${res.status}`)
    connected = true
    opts.onStatus()
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n')
        if (data) opts.onEvent(JSON.parse(data))
      }
    }
  }
  const keepFollowing = async () => {
    while (!quitting) {
      await follow().catch(() => undefined)
      if (quitting) return
      connected = false
      console.error('[background] lost the service; reconnecting')
      opts.onStatus()
      await sleep(400)
      if (quitting) return
      await ensure().catch((e) => !quitting && console.error('[background]', e.message))
      // Whatever happened while away is in the state the window fetches next.
      opts.onEvent({ t: 'changed' })
    }
  }

  await ensure()
  following = keepFollowing()
  // What the window shows about it, refreshed now and then for the counts. It is also how a service that
  // hangs with its connections open is noticed: three silent looks in a row (about 12s) drop the event
  // stream, and the reconnection waits it out or replaces it.
  let silentLooks = 0
  const watching = setInterval(() => {
    if (connected && !opts.inProcess)
      void probe()
        .catch(() => null)
        .then((h) => {
          silentLooks = h ? 0 : silentLooks + 1
          if (silentLooks >= 3 && !quitting) {
            silentLooks = 0
            console.error('[background] the service has not answered for about 12s; reconnecting')
            stream?.abort()
          }
          if (h && (h.busy !== health?.busy || h.retiring !== health?.retiring)) (health = h), opts.onStatus()
        })
  }, 4000)

  return {
    state: async (): Promise<ServiceSnapshot> => {
      const r = await request('GET', '/v1/state', undefined, 15000)
      if (r.ok === false) throw new Error(r.error)
      return r
    },
    call: (connector: string, tool: string, args: Record<string, unknown> = {}, caller?: Caller) => delivered(() => answer('/v1/call', { connector, tool, args, caller })),
    bundle: (id: string): Promise<{ js: string; css: string; version: number }> => patiently(() => answer('/v1/bundle', { id }, 60_000)),
    preview: (source: string, item: string): Promise<{ js: string; css: string }> => patiently(() => answer('/v1/preview', { source, item }, 60_000)),
    runtimeError: (workspace: string, error: string | null) => answer('/v1/runtime-error', { workspace, error }, 10_000).catch(() => undefined),
    held: (workspace: string, version: number | null) => answer('/v1/held', { workspace, version }, 10_000).catch(() => undefined),
    /** How many windows this process has open. */
    setWindows: (n: number) => {
      if (n === windows) return
      windows = n
      void request('POST', '/v1/presence', { client, windows }).catch(() => undefined)
    },
    status: (): ServiceState => ({
      mode: opts.inProcess ? 'in-process' : 'daemon',
      connected,
      pid: health?.pid,
      startedAt: health?.startedAt,
      busy: health?.busy,
      stale: !!health && health.build !== build,
      logFile: opts.inProcess ? undefined : logFile,
    }),
    /** The window is going. With `stopAgents` the service goes too (its runs are recorded as interrupted); without, it carries on. */
    quit: async (stopAgents: boolean) => {
      quitting = true
      clearInterval(watching)
      stream?.abort()
      if (local) return local.close()
      // A reconnection under way finishes (or gives up) first, so the stop below reaches whichever service
      // is running, and nothing starts another after it.
      await Promise.race([following, sleep(5000)])
      if (!stopAgents) return
      // Until the process is gone, not until it stops answering: a service that hangs does that too.
      // Its agents get a few seconds to stop and be recorded; one that does not go is killed.
      await stopRunning()
      for (let i = 0; i < 100 && (await probe().catch(() => null)); i++) await sleep(120)
    },
  }
}

// agentd, the agent backend, as a child process of the background service (lynxd), on Electron's
// binary in Node mode. The rest of the app reaches it as the `agents` MCP server and the connection
// admin routes (see Engine.ts).
import { fork, type ChildProcess } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { Effect, Layer } from 'effect'
import type { EngineState } from '@shared/types'
import { fileRoots } from '../attachments'
import { Config } from './Config'
import { Engine, type EngineShape } from './Engine'
import { Events } from './Events'
import { Settings } from './Settings'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const AgentdLive = Layer.effect(Engine)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const events = yield* Events
    const settings = yield* Settings
    const url = `http://127.0.0.1:${cfg.enginePort}`
    let state: EngineState = { status: 'starting', detail: 'Starting agents' }
    const set = (s: EngineState) => {
      state = s
      Effect.runSync(events.changed)
    }
    let child: ChildProcess | undefined
    let stopping = false
    const sendLimits = () => {
      if (!child?.connected) return
      child.send({ type: 'execution', limits: settings.get().execution }, (error) => {
        if (error && !stopping) console.error('[agentd] could not update execution limits', error)
      })
    }
    const unlisten = settings.onExecutionChanged(sendLimits)
    yield* Effect.addFinalizer(() => Effect.sync(unlisten))

    const start = () =>
      new Promise<void>((resolve, reject) => {
        const proc = fork(join(cfg.outDir, 'agentd.js'), [], {
          execPath: process.execPath,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            AGENTD_DATA_DIR: join(cfg.dataDir, 'agents'),
            AGENTD_PORT: String(cfg.enginePort),
            AGENTD_TOKEN: cfg.engineToken,
            AGENTD_FILE_ROOTS: fileRoots(cfg.dataDir).join(delimiter),
            // Workers run on this same binary, as Node.
            AGENTD_NODE: process.execPath,
            AGENTD_WORKER: join(cfg.outDir, 'agentd-worker.js'),
            AGENTD_CONCURRENCY: String(settings.get().execution.agents),
            AGENTD_SHELL_CONCURRENCY: String(settings.get().execution.shell),
          },
        })
        child = proc
        let up = false
        let log = ''
        const onData = (d: Buffer) => {
          log = (log + d.toString()).slice(-4000)
          if (process.env.LYNX_DEBUG) process.stderr.write(`[agentd] ${d}`)
        }
        proc.stdout?.on('data', onData)
        proc.stderr?.on('data', onData)
        proc.on('message', (m: any) => {
          if (m?.type === 'ready' && !up) {
            up = true
            sendLimits()
            resolve()
          }
          if (m?.type === 'error' && !up) reject(new Error(m.message))
          if (m?.type === 'progress' && !up) set({ status: 'starting', detail: m.detail })
          if (m?.type === 'warning') Effect.runSync(events.publish({ t: 'toast', tone: 'bad', text: m.message }))
        })
        proc.once('exit', (code) => {
          child = undefined
          if (!up) return reject(new Error(`agents exited (${code}): ${log.trim().split('\n').slice(-6).join('\n')}`))
          if (stopping) return
          // It died underneath us: say so and bring it back. Runs it had started are marked unknown.
          set({ status: 'starting', detail: 'Restarting agents' })
          void sleep(1500)
            .then(start)
            .then(
              () => set({ status: 'ready', url }),
              (e) => set({ status: 'error', detail: String(e.message ?? e) }),
            )
        })
      })

    // The agentd of a service that just died may still be letting go of the port and the database:
    // give it a few seconds before saying the agents are unavailable.
    const startPatiently = async (tries = 6): Promise<void> => {
      try {
        await start()
      } catch (e) {
        if (stopping || tries <= 1) throw e
        console.error('[agentd] did not start; trying again', e instanceof Error ? e.message : e)
        await sleep(1000)
        return startPatiently(tries - 1)
      }
    }
    const ready = startPatiently().then(() => set({ status: 'ready', url }))
    ready.catch((e) => {
      console.error('[agentd]', e)
      set({ status: 'error', detail: String(e?.message ?? e) })
    })

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        stopping = true
        const proc = child
        if (!proc) return
        // It stops its workers and records their runs as interrupted, then exits.
        const exited = new Promise<void>((r) => proc.once('exit', () => r()))
        proc.send({ type: 'stop' })
        await Promise.race([exited, sleep(8000)])
        if (child) proc.kill()
      }),
    )

    const admin: EngineShape['admin'] = async (method, path, body) => {
      const res = await fetch(url + path, { method, headers: { authorization: `Bearer ${cfg.engineToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? `agents ${res.status}`), { status: res.status })
      return json
    }

    return Engine.of({ state: () => state, ready, url, admin })
  }),
)

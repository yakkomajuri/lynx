// agentd: Lynx's agent backend. It runs as a child of Lynx's background service, lynxd (or plain Node, in tests),
// owns agents.sqlite, runs Claude Code and Codex as worker processes and serves the `agents` tools.
//
// Settings come from the environment:
//   AGENTD_DATA_DIR    where agentd.sqlite and session folders live
//   AGENTD_PORT        loopback port to listen on
//   AGENTD_TOKEN       bearer token callers must send
//   AGENTD_FILE_ROOTS  folders agents may work in and attach from, separated by the path delimiter
//   AGENTD_NODE        Node binary for workers; AGENTD_WORKER the worker script
//   AGENTD_WARM        harnesses whose worker stays up between a session's messages (default: those the registry marks warm)
//   AGENTD_MAX_IDLE    idle warm workers kept (default 4); AGENTD_IDLE_MS how long (default 30 min)
import { mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { openDb } from './db'
import { providers } from './providers/registry'
import { createRunner } from './runner'
import { createFiles } from './files'
import { createSchedules } from './schedules'
import { createShell } from './shell'
import { createHttp } from './server'
import { createStore } from './store'
import { createTools } from './tools'
import { executionFromEnv, isExecutionLimit } from '../shared/execution'

const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}
// Started by lynxd it has an IPC channel; started by hand (tests) it says the same things on stdout.
const tell = (message: unknown) => (process.send ? process.send(message) : console.log(JSON.stringify(message)))

const dataDir = env('AGENTD_DATA_DIR')
mkdirSync(join(dataDir, 'sessions'), { recursive: true })
const roots = (process.env.AGENTD_FILE_ROOTS ?? dataDir).split(delimiter).filter(Boolean)
const limits = executionFromEnv(process.env)

const db = openDb(join(dataDir, 'agentd.sqlite'))
const store = createStore(db, { dataDir, roots })
const runner = createRunner(store, {
  node: env('AGENTD_NODE'),
  worker: env('AGENTD_WORKER'),
  nodeArgs: process.env.AGENTD_NODE_ARGS ? process.env.AGENTD_NODE_ARGS.split(' ') : [],
  concurrency: limits.agents,
  // Inside the app the worker runs on Electron's binary, which needs to be told to act as Node.
  // Compiled code is cached across workers, which shortens each cold start.
  env: { ELECTRON_RUN_AS_NODE: '1', NODE_COMPILE_CACHE: join(dataDir, 'compile-cache') },
  warm: process.env.AGENTD_WARM !== undefined ? process.env.AGENTD_WARM.split(',').filter(Boolean) : providers().filter((p) => p.capabilities.warm).map((p) => p.id),
  maxIdle: Number(process.env.AGENTD_MAX_IDLE ?? 4),
  idleMs: Number(process.env.AGENTD_IDLE_MS ?? 30 * 60_000),
})
const schedules = createSchedules(store, { dataDir })
const shell = createShell(store, { dataDir, concurrency: limits.shell })
const files = createFiles({ dataDir, roots })
const tools = createTools(store, runner, schedules, shell, files, { roots })
const server = createHttp(store, tools, env('AGENTD_TOKEN'))

const recovered = store.recover()
if (recovered.length) console.error(`[agentd] ${recovered.length} run(s) were in progress when Lynx last stopped; marked unknown`)
const lostCommands = shell.recover()
if (lostCommands) console.error(`[agentd] ${lostCommands} command(s) were running when Lynx last stopped; marked unknown`)

let ticking = false
const tick = () => {
  if (ticking) return
  ticking = true
  schedules
    .tick()
    .catch((e) => console.error('[agentd] schedules', e))
    .finally(() => (ticking = false))
}
const ticker = setInterval(tick, 1000)

let closing = false
const close = async () => {
  if (closing) return
  closing = true
  clearInterval(ticker)
  server.close()
  await Promise.all([runner.shutdown(), shell.shutdown()])
  db.close()
  process.exit(0)
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
process.on('message', (m: any) => {
  if (m?.type === 'stop') return void close()
  if (m?.type === 'execution' && isExecutionLimit('agents', m.limits?.agents) && isExecutionLimit('shell', m.limits?.shell)) {
    runner.setConcurrency(m.limits.agents)
    shell.setConcurrency(m.limits.shell)
  }
})
// The parent gone without a word (killed) leaves no one to stop us: stop on our own.
process.on('disconnect', () => void close())
process.on('exit', () => {
  runner.killAll()
  shell.killAll()
})

server.listen(Number(env('AGENTD_PORT')), '127.0.0.1', () => {
  runner.start()
  shell.start()
  tick()
  tell({ type: 'ready', port: Number(env('AGENTD_PORT')) })
})
server.on('error', (e) => {
  tell({ type: 'error', message: e.message })
  process.exit(1)
})

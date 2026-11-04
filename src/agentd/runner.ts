// Launches queued runs as worker processes and records what they report.
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { validEvent, WorkerLines } from './providers/protocol'
import { claudeProviderSettings } from './providers/claude-settings'
import { envSecrets, headerSecrets, redactCut, redactKnown } from './providers/redact'
import type { AgentEvent, AgentSpec, InputRequest } from './providers/types'
import type { Run, Store } from './store'

export interface RunnerOptions {
  /** A Node binary for the worker (Electron's own, in Node mode, inside the app). */
  node: string
  /** The built worker script. */
  worker: string
  /** Extra arguments before the script, e.g. `--import tsx` from a checkout. */
  nodeArgs?: string[]
  concurrency: number
  /** Environment overrides for workers. */
  env?: Record<string, string | undefined>
  /** Harnesses whose worker stays up between a session's messages. */
  warm?: string[]
  /** How many idle warm workers to keep, least recently used going first. */
  maxIdle?: number
  /** How long an idle warm worker is kept. */
  idleMs?: number
}

const MAX_LINE = 8 * 1024 * 1024
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type StopReason = 'cancel' | 'timeout' | 'shutdown'
type Exit = { code: number | null; signal: string | null; error?: string }
// The worker's own environment: nothing that grants access to this backend.
const workerEnv = (extra: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  for (const key of Object.keys(env)) if (key.startsWith('AGENTD_')) delete env[key]
  return env
}

/** One run as a worker serves it. */
interface Turn {
  run: Run
  outcome?: { success: boolean; result?: unknown; error?: unknown }
  protocolFailure?: string
  stopReason?: StopReason
  fatal?: Error
  providerSession?: string
  done: () => void
}
/** A worker process. A warm one outlives its run and waits for the session's next message. */
interface Worker {
  child: ChildProcess
  sessionId: string
  /** What the process was started with that it cannot change in place. */
  shape: string
  warm: boolean
  secrets: Set<string>
  turn?: Turn
  exited: Promise<Exit>
  /** Records diagnostics written so far; partial lines go too, so nothing carries into another run. */
  flushStderr: () => void
  idle?: NodeJS.Timeout
  stopping?: StopReason | 'retire' | 'broken'
}

/** A new process is needed when one of these changes; model, effort and connectors change in place. */
const shapeOf = (spec: AgentSpec) => JSON.stringify([spec.harness, spec.cwd, spec.config.permission_mode, spec.config.instructions ?? null])

export function createRunner(store: Store, opts: RunnerOptions) {
  const live = new Map<string, { worker: Worker; stop: (reason: StopReason) => void }>()
  /** Idle warm workers by session, least recently used first. */
  const idle = new Map<string, Worker>()
  /** Every worker process, including those on their way out. */
  const workers = new Set<Worker>()
  const warmHarnesses = new Set(opts.warm ?? [])
  const maxIdle = opts.maxIdle ?? 4
  const idleMs = opts.idleMs ?? 30 * 60_000
  let stopping = false

  // Signals the worker's whole process group: it leads one, so Claude Code, Codex and their tools go too.
  const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      // Already gone.
    }
  }

  /**
   * Ends a worker: a cancel or timeout asks it to wind down first, retiring an idle one just closes
   * its input. A broken one (its output stopped making sense) is wound down without its run counting
   * as cancelled.
   */
  const stopWorker = (worker: Worker, reason: StopReason | 'retire' | 'broken') => {
    if (worker.stopping) return
    worker.stopping = reason
    if (worker.turn && reason !== 'retire' && reason !== 'broken') worker.turn.stopReason = reason
    if (reason === 'retire') worker.child.stdin!.end()
    else worker.child.stdin!.write('{"type":"cancel"}\n')
    setTimeout(() => signalGroup(worker.child, 'SIGTERM'), reason === 'retire' ? 3000 : 500).unref()
    setTimeout(() => signalGroup(worker.child, 'SIGKILL'), reason === 'retire' ? 6000 : 4000).unref()
  }
  const retire = (worker: Worker) => {
    clearTimeout(worker.idle)
    if (idle.get(worker.sessionId) === worker) idle.delete(worker.sessionId)
    stopWorker(worker, 'retire')
  }
  const park = (worker: Worker) => {
    if (stopping || worker.stopping) return retire(worker)
    idle.delete(worker.sessionId)
    idle.set(worker.sessionId, worker)
    worker.idle = setTimeout(() => retire(worker), idleMs)
    worker.idle.unref()
    while (idle.size > maxIdle) retire(idle.values().next().value!)
  }

  const spawnWorker = (sessionId: string, spec: AgentSpec): Worker => {
    const child = spawn(opts.node, [...(opts.nodeArgs ?? []), opts.worker], {
      cwd: spec.cwd,
      env: workerEnv(opts.env),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const worker: Worker = {
      child,
      sessionId,
      shape: shapeOf(spec),
      warm: warmHarnesses.has(spec.harness),
      // Provider keys a worker may print; kept out of history like connection headers.
      secrets: new Set(envSecrets(process.env, claudeProviderSettings().env ?? {})),
      flushStderr: () => {},
      exited: new Promise<Exit>((resolve) => {
        child.once('error', (e) => resolve({ code: null, signal: null, error: e.message }))
        child.once('exit', (code, signal) => resolve({ code, signal }))
      }),
    }
    workers.add(worker)
    // An exited worker can serve nothing more, though its output may still be draining.
    void worker.exited.then(() => {
      worker.stopping ??= 'retire'
      clearTimeout(worker.idle)
      if (idle.get(sessionId) === worker) idle.delete(sessionId)
    })
    child.stdin!.on('error', () => {})
    const secrets = () => [...worker.secrets]
    // Output belongs to the run the worker is serving; between runs there is nothing to record.
    // Output that stops making sense may have swallowed the end of a turn, so the worker goes.
    const invalid = (line: string, reason: string) => {
      stopWorker(worker, 'broken')
      const turn = worker.turn
      if (!turn) return
      turn.protocolFailure ??= reason
      // Shortened (and an oversized line's preview is raw), so a secret may be cut off at the end.
      store.appendEvent(turn.run.session_id, turn.run.id, 'protocol_error', { line: redactCut(line.slice(0, 4000), secrets()), reason })
    }
    const handle = (turn: Turn, event: AgentEvent) => {
      const { run } = turn
      if (event.type === 'turn_done') return turn.done()
      if (event.type === 'agent_completed' && turn.outcome) return invalid(JSON.stringify(event).slice(0, 1000), 'duplicate_completion')
      // Claude repeats its session id on every message; only a change is worth a record.
      if (event.type === 'provider_session') {
        const id = (event.payload as any).id
        if (id === turn.providerSession) return
        turn.providerSession = id
      }
      if (event.type === 'input_request') return store.recordInput(run, event.payload as InputRequest)
      if (event.type === 'input_stale') return store.staleInput(run, (event.payload as any).id, (event.payload as any).reason)
      if (event.type === 'input_ack') return store.acknowledgeInput(run, (event.payload as any).id)
      store.appendEvent(run.session_id, run.id, event.type, event.payload, event.text ?? '')
      if (event.type === 'provider_session') store.setProviderSession(run, (event.payload as any).id)
      if (event.type === 'agent_completed') turn.outcome = event.payload as Turn['outcome']
      store.changes.emit('run', run.id)
    }
    const lines = new WorkerLines(
      MAX_LINE,
      (raw) => {
        if (!raw.trim()) return
        // A provider can print a secret outside structured events; whole lines are cleaned before use.
        const line = redactKnown(raw, secrets())
        let decoded: unknown
        try {
          decoded = JSON.parse(line)
        } catch {
          return invalid(line, 'invalid_json')
        }
        if (!validEvent(decoded)) return invalid(line, 'invalid_event')
        const turn = worker.turn
        if (!turn) return
        try {
          handle(turn, decoded)
        } catch (e) {
          // A store invariant broke (e.g. the provider swapped its session): stop the run.
          turn.fatal ??= e instanceof Error ? e : new Error(String(e))
          stopWorker(worker, 'cancel')
        }
      },
      (preview) => invalid(preview, 'line_too_large'),
      (fragment) => {
        const turn = worker.turn
        if (!turn) return
        turn.protocolFailure ??= 'incomplete_event'
        store.appendEvent(turn.run.session_id, turn.run.id, 'protocol_fragment', { text: redactCut(fragment.slice(0, 4000), secrets()) })
      },
    )
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    child.stdout!.on('data', (chunk: Buffer) => lines.write(stdout.write(chunk)))
    // Diagnostics are kept by whole lines, so a secret split across writes is still caught.
    let errLine = ''
    let skipRest = false
    const flushErr = (all: boolean) => {
      const cut = all ? errLine.length : errLine.lastIndexOf('\n') + 1
      if (!cut) return
      // A line cut off before its end may stop partway into a secret, so its ending is masked. The
      // rest of it is dropped: it could begin inside that secret, and it belongs to no later run.
      const partial = cut === errLine.length && !errLine.endsWith('\n')
      const text = (partial ? redactCut : redactKnown)(errLine.slice(0, cut), secrets())
      if (partial) skipRest = true
      errLine = errLine.slice(cut)
      const turn = worker.turn
      if (text.trim() && turn) store.appendEvent(turn.run.session_id, turn.run.id, 'stderr', { text }, text)
    }
    child.stderr!.on('data', (chunk: Buffer) => {
      let text = stderr.write(chunk)
      if (skipRest) {
        const end = text.indexOf('\n')
        if (end < 0) return
        skipRest = false
        text = text.slice(end + 1)
      }
      errLine += text
      flushErr(errLine.length > 65536)
    })
    worker.flushStderr = () => flushErr(true)
    const outputDone = Promise.all([new Promise((r) => child.stdout!.once('close', r)), new Promise((r) => child.stderr!.once('close', r))])
    // Output can trail the exit briefly; anything still holding the pipes after that is cut off.
    worker.exited = worker.exited.then(async (result) => {
      await Promise.race([outputDone, sleep(2000)])
      child.stdout!.destroy()
      child.stderr!.destroy()
      lines.write(stdout.end())
      lines.end()
      errLine += stderr.end()
      flushErr(true)
      // Whatever the worker left behind in its group goes with it.
      signalGroup(child, 'SIGKILL')
      workers.delete(worker)
      clearTimeout(worker.idle)
      if (idle.get(sessionId) === worker) idle.delete(sessionId)
      return result
    })
    return worker
  }

  const execute = async (run: Run, spec: AgentSpec) => {
    // The session's warm worker takes the message if it was started the same way; otherwise it makes way.
    let worker = idle.get(run.session_id)
    if (worker) {
      idle.delete(run.session_id)
      clearTimeout(worker.idle)
      if (worker.shape !== shapeOf(spec) || worker.stopping) {
        retire(worker)
        worker = undefined
      }
    }
    const reused = !!worker
    worker ??= spawnWorker(run.session_id, spec)
    for (const secret of headerSecrets((spec.connections ?? []).map((c) => c.headers))) worker.secrets.add(secret)
    // Whatever it wrote while idle belongs to no run.
    worker.flushStderr()
    let finishTurn!: () => void
    const turnDone = new Promise<'turn'>((resolve) => (finishTurn = () => resolve('turn')))
    const turn: Turn = { run, done: finishTurn }
    worker.turn = turn
    const w = worker
    live.set(run.id, { worker: w, stop: (reason) => stopWorker(w, reason) })
    const timer = spec.config.timeout_ms ? setTimeout(() => stopWorker(w, 'timeout'), spec.config.timeout_ms) : undefined

    try {
      if (w.child.pid) store.launched(run.id, w.child.pid, reused)
      if (store.getRun(run.id).cancel_requested) stopWorker(w, 'cancel')
      const line = reused ? { type: 'turn', spec } : { ...spec, warm: w.warm }
      w.child.stdin!.write(JSON.stringify(line) + '\n')
      const ended = await Promise.race([turnDone, w.exited])
      if (ended === 'turn') w.flushStderr()
      const result: Exit | { warm: true; pid?: number } = ended === 'turn' ? { warm: true, pid: w.child.pid } : ended
      const exit = ended === 'turn' ? undefined : ended
      const cancelled = turn.stopReason === 'cancel' || store.getRun(run.id).cancel_requested
      if (turn.stopReason === 'shutdown') return store.finishRun(run.id, 'interrupted', { process: result }, { message: 'Lynx stopped' })
      if (turn.fatal) return store.finishRun(run.id, 'failed', { process: result }, { code: 'provider_failure', message: turn.fatal.message })
      const success = !turn.protocolFailure && !!turn.outcome?.success
      const state = cancelled ? 'cancelled' : turn.stopReason === 'timeout' || (exit && exit.code !== 0) || !success ? 'failed' : 'completed'
      const error =
        state === 'completed' || state === 'cancelled'
          ? null
          : turn.stopReason === 'timeout'
            ? { code: 'timeout', message: 'Execution timeout exceeded' }
            : turn.protocolFailure
              ? { code: 'provider_failure', message: `Worker protocol failure: ${turn.protocolFailure}` }
              : exit?.error
                ? { message: exit.error }
                : {
                    // The adapter's failure class (usage_limit, auth, …) when it gave one.
                    code: typeof (turn.outcome?.error as any)?.code === 'string' ? (turn.outcome!.error as any).code : 'provider_failure',
                    message: typeof turn.outcome?.error === 'object' && turn.outcome.error ? ((turn.outcome.error as any).message ?? 'Provider failed') : String(turn.outcome?.error ?? 'No successful provider completion was captured'),
                    ...(turn.outcome?.error && typeof turn.outcome.error === 'object' ? { detail: turn.outcome.error } : {}),
                  }
      store.finishRun(run.id, state, { process: result, provider: turn.outcome?.result ?? null }, error)
      // Only a worker that finished cleanly serves the next message; anything else starts fresh.
      if (ended === 'turn') state === 'completed' ? park(w) : retire(w)
    } finally {
      clearTimeout(timer)
      w.turn = undefined
      live.delete(run.id)
    }
  }

  const launch = (run: Run) => {
    const claimed = store.claim(run.id)
    if (!claimed) return
    const { session } = claimed
    const spec: AgentSpec = {
      harness: session.harness,
      cwd: run.spec.cwd,
      prompt: run.spec.effective_prompt ?? run.spec.prompt,
      provider_session_id: session.provider_session_id,
      attachments: run.spec.attachments,
      connections: run.spec.connections,
      config: run.spec.config,
    }
    execute(claimed.run, spec)
      .catch((e) => {
        console.error('[agentd] run failed', run.id, e)
        store.finishRun(run.id, 'unknown', null, { message: 'The backend lost track of this run; inspect its history' })
      })
      .finally(pump)
  }

  /** Starts queued runs while there are free slots. */
  function pump() {
    if (stopping) return
    while (live.size < opts.concurrency) {
      const next = store.nextQueued()
      if (!next) return
      launch(next)
      // A claim that lost a race leaves the run as it was; don't spin on it.
      if (!live.has(next.id) && store.getRun(next.id).status === 'queued') return
    }
  }
  store.changes.on('queued', () => queueMicrotask(pump))
  store.changes.on('cancel', (id: string) => live.get(id)?.stop('cancel'))

  return {
    start: pump,
    concurrency: () => opts.concurrency,
    setConcurrency: (value: number) => {
      opts.concurrency = value
      queueMicrotask(pump)
    },
    /** Hands a line to a run's live worker; false when it has none. */
    deliver: (runId: string, line: string) => {
      const stdin = live.get(runId)?.worker.child.stdin
      if (!stdin?.writable) return false
      stdin.write(line)
      return true
    },
    live: () => live.size,
    warm: () => idle.size,
    /** Stops every worker and waits for their runs to be recorded as interrupted. */
    shutdown: async () => {
      stopping = true
      for (const worker of [...idle.values()]) retire(worker)
      for (const entry of live.values()) entry.stop('shutdown')
      const deadline = Date.now() + 6000
      while (live.size && Date.now() < deadline) await sleep(50)
      for (const worker of workers) signalGroup(worker.child, 'SIGKILL')
    },
    /** Synchronous last resort, for an exit that cannot wait. */
    killAll: () => {
      for (const worker of workers) signalGroup(worker.child, 'SIGKILL')
    },
  }
}
export type Runner = ReturnType<typeof createRunner>

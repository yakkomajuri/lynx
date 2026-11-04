// Shell commands run through `exec`: queued, run under bash in their own process group, with their
// output recorded as it arrives and readable by page while they run. Workspaces use these for what
// an agent is not needed for (git, scans, sign-ins); they behave as they did on the engine.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { json, now, parse } from './db'
import { isTerminal, problem, type Store } from './store'

export interface ExecInput {
  command: string
  cwd?: string
  env?: Record<string, string>
  timeout_ms?: number
}
export interface PageInput {
  id: string
  after?: string
  limit?: number
  tail?: boolean
  max_chars?: number
}
interface Process {
  id: string
  status: string
  spec: ExecInput & { cwd: string }
  result: { code: number | null; signal: string | null; error?: string } | null
  error: unknown
  cancel_requested: number
  pid: number | null
  created_at: string
  started_at: string | null
  ended_at: string | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toProcess = (row: any): Process => ({ ...row, spec: parse(row.spec), result: parse(row.result), error: parse(row.error) })
// A command's own environment: nothing that grants access to this backend or makes Electron act as Node.
const shellEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  for (const key of Object.keys(env)) if (key.startsWith('AGENTD_') || key === 'ELECTRON_RUN_AS_NODE' || key === 'NODE_COMPILE_CACHE') delete env[key]
  return env
}

export function createShell(store: Store, opts: { dataDir: string; concurrency: number }) {
  const { q, tx, changes } = store
  const live = new Map<string, { child: ChildProcess; stop: (reason: 'cancel' | 'timeout' | 'shutdown') => void }>()
  let stopping = false

  const get = (id: string) => {
    const row = q('SELECT * FROM processes WHERE id = ?').get(id)
    if (!row) throw problem('not_found', 'Execution not found', 404)
    return toProcess(row)
  }
  const touch = (id: string) => changes.emit('process', id)
  const append = (id: string, stream: 'stdout' | 'stderr', text: string, bytes: number) => {
    q('INSERT INTO process_output (process_id, stream, text, bytes, created_at) VALUES (?, ?, ?, ?, ?)').run(id, stream, text, bytes, now())
    touch(id)
  }
  const finish = (id: string, status: string, result: unknown, error: unknown = null) => {
    q("UPDATE processes SET status = ?, result = ?, error = ?, ended_at = ? WHERE id = ? AND status IN ('queued', 'starting', 'running', 'cancelling')").run(status, json(result), json(error), now(), id)
    q("UPDATE process_inputs SET status = 'failed', error = 'Process ended before delivery' WHERE process_id = ? AND status = 'queued'").run(id)
    touch(id)
  }

  /** Writes queued input to a running command, in order. */
  const deliver = (id: string) => {
    const child = live.get(id)?.child
    if (!child?.stdin) return
    for (const input of q("SELECT * FROM process_inputs WHERE process_id = ? AND status = 'queued' ORDER BY created_at, id").all(id)) {
      let error: string | null = null
      try {
        if (!child.stdin.writable) throw new Error('Input is closed')
        if (input.data) child.stdin.write(input.data)
        if (input.eof) child.stdin.end()
      } catch (e) {
        error = String(e instanceof Error ? e.message : e)
      }
      q('UPDATE process_inputs SET status = ?, error = ? WHERE id = ?').run(error ? 'failed' : 'delivered', error, input.id)
    }
  }

  const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      // Already gone.
    }
  }

  const run = async (job: Process) => {
    const child = spawn('/bin/bash', ['-lc', job.spec.command], {
      cwd: job.spec.cwd,
      env: shellEnv(job.spec.env),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stopReason: 'cancel' | 'timeout' | 'shutdown' | undefined
    const stop = (reason: 'cancel' | 'timeout' | 'shutdown') => {
      if (stopReason) return
      stopReason = reason
      signalGroup(child, 'SIGTERM')
      setTimeout(() => signalGroup(child, 'SIGKILL'), 500).unref()
    }
    live.set(job.id, { child, stop })
    child.stdin!.on('error', () => {})
    const exited = new Promise<{ code: number | null; signal: string | null; error?: string }>((resolve) => {
      child.once('error', (e) => resolve({ code: null, signal: null, error: e.message }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const capture = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr') => {
      const decoder = new StringDecoder('utf8')
      stream.on('data', (chunk: Buffer) => append(job.id, name, decoder.write(chunk), chunk.length))
      return new Promise<void>((resolve) =>
        stream.once('close', () => {
          const tail = decoder.end()
          if (tail) append(job.id, name, tail, 0)
          resolve()
        }),
      )
    }
    const output = Promise.all([capture(child.stdout!, 'stdout'), capture(child.stderr!, 'stderr')])
    const timer = job.spec.timeout_ms ? setTimeout(() => stop('timeout'), job.spec.timeout_ms) : undefined
    try {
      if (child.pid) {
        q("UPDATE processes SET pid = ?, status = CASE WHEN cancel_requested THEN 'cancelling' ELSE 'running' END WHERE id = ?").run(child.pid, job.id)
        touch(job.id)
      }
      if (get(job.id).cancel_requested) stop('cancel')
      deliver(job.id)
      const result = await exited
      // A command's leftovers in its group go with it. Output can still trail briefly; whatever
      // holds the pipes after that (something that left the group) is cut off.
      signalGroup(child, 'SIGKILL')
      let gap = false
      await Promise.race([output, sleep(10000).then(() => (gap = true))])
      child.stdout!.destroy()
      child.stderr!.destroy()
      const cancelled = stopReason === 'cancel' || !!get(job.id).cancel_requested
      if (stopReason === 'shutdown') return finish(job.id, 'interrupted', result, { message: 'Lynx stopped' })
      finish(
        job.id,
        gap ? 'unknown' : cancelled ? 'cancelled' : stopReason === 'timeout' || result.code !== 0 ? 'failed' : 'completed',
        result,
        gap
          ? { code: 'capture_gap', message: 'Output capture did not finish; detached work may remain' }
          : stopReason === 'timeout'
            ? { code: 'timeout', message: 'Execution timeout exceeded' }
            : result.error
              ? { message: result.error }
              : null,
      )
    } finally {
      clearTimeout(timer)
      live.delete(job.id)
    }
  }

  function pump() {
    if (stopping) return
    while (live.size < opts.concurrency) {
      const row = q("SELECT * FROM processes WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get()
      if (!row) return
      const claimed = q("UPDATE processes SET status = 'starting', started_at = ? WHERE id = ? AND status = 'queued'").run(now(), row.id)
      if (!claimed.changes) return
      const job = get(row.id)
      touch(job.id)
      run(job)
        .catch((e) => {
          console.error('[agentd] command failed', job.id, e)
          finish(job.id, 'unknown', null, { message: 'The backend lost track of this command' })
        })
        .finally(pump)
    }
  }

  const view = (job: Process, full = false) => {
    if (full) return { ...job, kind: 'process', session_id: null, output: null }
    const error = job.error && typeof job.error === 'object' && 'message' in (job.error as any) ? { code: (job.error as any).code ?? 'execution_error', message: String((job.error as any).message).slice(0, 2000) } : job.error
    const queue =
      job.status === 'queued'
        ? { position: Number(q("SELECT count(*) AS n FROM processes WHERE status = 'queued' AND (created_at < ? OR (created_at = ? AND id < ?))").get(job.created_at, job.created_at, job.id).n) + 1, pool: 'shell', reason: 'Waiting for an execution slot' }
        : undefined
    return {
      id: job.id,
      kind: 'process',
      session_id: null,
      status: job.status,
      output: null,
      error,
      created_at: job.created_at,
      started_at: job.started_at,
      ended_at: job.ended_at,
      exit_code: job.result?.code ?? null,
      signal: job.result?.signal ?? null,
      ...(queue ? { queue } : {}),
    }
  }

  /** A page of a command's output, as text, with what was typed into it. */
  const page = (input: PageInput) => {
    const execution = get(input.id)
    const limit = input.limit ?? 100
    const after = Number(input.after ?? 0)
    const rows = input.tail
      ? q('SELECT * FROM process_output WHERE process_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?').all(input.id, after, limit + 1).reverse()
      : q('SELECT * FROM process_output WHERE process_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(input.id, after, limit + 1)
    const more = rows.length > limit
    const items = input.tail ? rows.slice(more ? 1 : 0) : rows.slice(0, limit)
    let stdout = ''
    let stderr = ''
    for (const row of items) row.stream === 'stdout' ? (stdout += row.text) : (stderr += row.text)
    const max = input.max_chars ?? 8000
    const cut = (s: string) => (input.tail ? s.slice(-max) : s.slice(0, max))
    const stats = q("SELECT count(*) AS events, COALESCE(max(seq), 0) AS last_cursor, COALESCE(sum(CASE WHEN stream = 'stdout' THEN bytes END), 0) AS stdout_bytes, COALESCE(sum(CASE WHEN stream = 'stderr' THEN bytes END), 0) AS stderr_bytes FROM process_output WHERE process_id = ?").get(input.id)
    const truncated = stdout.length > max || stderr.length > max
    const last = items.at(-1)
    return {
      execution,
      events: { items: items.map((r: any) => ({ seq: String(r.seq), type: r.stream, payload: { text: r.text }, created_at: r.created_at })), next_cursor: String(last?.seq ?? input.after ?? '0'), has_more: input.tail ? false : more },
      inputs: q('SELECT id, status, error, created_at FROM process_inputs WHERE process_id = ? ORDER BY created_at DESC, id LIMIT 100').all(input.id),
      has_more: input.tail ? false : more,
      has_earlier: input.tail ? more : false,
      stdout: cut(stdout),
      stderr: cut(stderr),
      output_stats: {
        events: Number(stats.events),
        last_cursor: String(stats.last_cursor),
        stdout_bytes: Number(stats.stdout_bytes),
        stderr_bytes: Number(stats.stderr_bytes),
        bytes_complete: true,
        truncated,
        ...(truncated ? { full_page: { id: input.id, after: input.after ?? '0', limit, tail: input.tail ?? false, view: 'full' } } : {}),
      },
    }
  }
  /** Compact or full presentation of a page, as process_get and process_wait answer. */
  const pageView = (value: ReturnType<typeof page> & { wait_timed_out?: boolean }, full: boolean) =>
    full
      ? { ...value, execution: view(value.execution, true) }
      : {
          execution: view(value.execution),
          stdout: value.stdout,
          stderr: value.stderr,
          next_cursor: value.events.next_cursor,
          has_more: value.has_more,
          has_earlier: value.has_earlier,
          output: value.output_stats,
          ...(value.inputs.length ? { inputs: value.inputs } : {}),
          ...(value.wait_timed_out !== undefined ? { wait_timed_out: value.wait_timed_out } : {}),
        }

  /** Waits for a command to end, woken by its own changes. A wait that times out does not cancel it. */
  const wait = async (id: string, timeout = 10000) => {
    if (isTerminal(get(id).status)) return false
    return new Promise<boolean>((resolve) => {
      const done = (timedOut: boolean) => {
        clearTimeout(timer)
        changes.off('process', onChange)
        resolve(timedOut)
      }
      const onChange = (changed: string) => changed === id && isTerminal(get(id).status) && done(false)
      const timer = setTimeout(() => done(true), timeout)
      changes.on('process', onChange)
    })
  }

  return {
    get,
    view,
    page,
    pageView,
    wait,
    exec: async (input: ExecInput) => {
      const cwd = await store.allowedPath(input.cwd ?? opts.dataDir)
      if (!(await stat(cwd)).isDirectory()) throw problem('invalid_path', 'cwd must be a directory')
      const id = randomUUID()
      q("INSERT INTO processes (id, status, spec, created_at) VALUES (?, 'queued', ?, ?)").run(id, json({ ...input, cwd }), now())
      queueMicrotask(pump)
      return get(id)
    },
    cancel: (id: string) => {
      const job = tx(() => {
        const job = get(id)
        if (isTerminal(job.status)) return job
        if (job.status === 'queued') {
          q("UPDATE processes SET cancel_requested = 1, status = 'cancelled', ended_at = ? WHERE id = ?").run(now(), id)
        } else q("UPDATE processes SET cancel_requested = 1, status = 'cancelling' WHERE id = ?").run(id)
        return get(id)
      })
      live.get(id)?.stop('cancel')
      touch(id)
      return job
    },
    input: (input: { id: string; data?: string; eof?: boolean }) => {
      const job = get(input.id)
      if (isTerminal(job.status) || job.status === 'cancelling') throw problem('not_running', 'Process is no longer accepting input', 409)
      const id = randomUUID()
      q("INSERT INTO process_inputs (id, process_id, data, eof, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)").run(id, input.id, input.data ?? '', input.eof ? 1 : 0, now())
      deliver(input.id)
      return { id, status: q('SELECT status FROM process_inputs WHERE id = ?').get(id).status }
    },
    /** After a crash: commands that had started may have had effects, so they are marked unknown. Queued ones still run. */
    recover: () => {
      const changed = q("UPDATE processes SET status = 'unknown', error = ?, ended_at = ? WHERE status IN ('starting', 'running', 'cancelling')").run(json({ message: 'Lynx stopped while this command was running' }), now())
      return Number(changed.changes)
    },
    start: pump,
    concurrency: () => opts.concurrency,
    setConcurrency: (value: number) => {
      opts.concurrency = value
      queueMicrotask(pump)
    },
    live: () => live.size,
    shutdown: async () => {
      stopping = true
      for (const entry of live.values()) entry.stop('shutdown')
      const deadline = Date.now() + 3000
      while (live.size && Date.now() < deadline) await sleep(50)
      for (const entry of live.values()) signalGroup(entry.child, 'SIGKILL')
    },
    killAll: () => {
      for (const entry of live.values()) signalGroup(entry.child, 'SIGKILL')
    },
  }
}
export type Shell = ReturnType<typeof createShell>

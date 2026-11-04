// Custom tools: JavaScript files in one global folder, each callable as a tool on the native
// `tools` connector by workspaces, agents, schedules and each other. A tool's code runs in the
// sandbox (see sandbox.ts) and can do exactly one thing to the outside world: call other tools.
// Every run is recorded, and a schedule is a cron expression that runs a tool with fixed arguments.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Effect, Layer } from 'effect'
import { NATIVE_TOOLS, type CustomTool, type ToolRun, type ToolSchedule } from '@shared/types'
import { nextRun, parseCron } from '@shared/cron'
import { execute, inspect, newBudget } from '../sandbox'
import { follow } from '../watch'
import { Config } from './Config'
import { Connectors, type Caller } from './Connectors'
import { TOOL_NAME } from '@shared/marketplaceApi'
import { Data } from './Data'
import { Events } from './Events'

/** A tool calling a tool calling a tool… stops here. */
const MAX_DEPTH = 4
/** Runs kept per tool, so a tool that runs every second cannot push out what the others did. */
const KEEP_RUNS = 500
// The marketplace checks templates' tools by the same rule, so a published one can always be installed.
const NAME = TOOL_NAME

export interface ScheduleInput {
  id?: string
  tool: string
  cron: string
  args?: Record<string, unknown>
  enabled?: boolean
}

export interface ToolsShape {
  readonly dir: string
  readonly list: () => CustomTool[]
  readonly source: (name: string) => string
  /** Write a tool. Refused, with the reason, when the code does not load. */
  readonly save: (name: string, source: string) => Effect.Effect<CustomTool, Error>
  readonly remove: (name: string) => Effect.Effect<boolean, Error>
  readonly run: (name: string, args: Record<string, unknown>, caller: Caller) => Effect.Effect<unknown, Error>
  readonly runs: (filter?: { tool?: string; limit?: number }) => ToolRun[]
  readonly schedules: () => ToolSchedule[]
  readonly saveSchedule: (input: ScheduleInput) => ToolSchedule
  readonly removeSchedule: (id: string) => boolean
}

export class Tools extends Context.Service<Tools, ToolsShape>()('Tools') {}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })
const clip = (v: unknown, max = 20000) => {
  const text = JSON.stringify(v ?? null)
  return text.length > max ? JSON.stringify(`${text.slice(0, max)}… (${text.length} characters)`) : text
}

interface Entry {
  tool: CustomTool
  source: string
  mtimeMs: number
  size: number
}

export const ToolsLive = Layer.effect(Tools)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const events = yield* Events
    const connectors = yield* Connectors
    const { sql } = yield* Data
    const dir = join(cfg.dataDir, 'tools')
    mkdirSync(dir, { recursive: true })
    const changed = () => Effect.runSync(events.changed)

    sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT NOT NULL, by TEXT NOT NULL, started_at TEXT NOT NULL, ms INTEGER NOT NULL, ok INTEGER NOT NULL, args TEXT NOT NULL, result TEXT, error TEXT, logs TEXT NOT NULL, calls TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_tool ON runs (tool, id);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, tool TEXT NOT NULL, args TEXT NOT NULL, cron TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, next_at TEXT, last_at TEXT, last_ok INTEGER, last_error TEXT) WITHOUT ROWID;
    `)
    const prune = sql.prepare('DELETE FROM runs WHERE tool = ?1 AND id <= coalesce((SELECT id FROM runs WHERE tool = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2), 0)')
    for (const { tool } of sql.prepare('SELECT DISTINCT tool FROM runs').all() as { tool: string }[]) prune.run(tool, KEEP_RUNS)

    // ── the tools folder
    const entries = new Map<string, Entry>()
    const file = (name: string) => join(dir, `${name}.js`)
    const scan = async () => {
      const seen = new Set<string>()
      let dirty = false
      for (const f of readdirSync(dir)) {
        const name = f.endsWith('.js') ? f.slice(0, -3) : ''
        if (!NAME.test(name)) continue
        seen.add(name)
        const st = statSync(file(name))
        const had = entries.get(name)
        if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) continue
        const source = readFileSync(file(name), 'utf8')
        const base = { name, updatedAt: st.mtime.toISOString() }
        const tool: CustomTool = await inspect(name, source).then(
          (meta) => ({ ...base, ...meta }),
          (e) => ({ ...base, description: '', inputSchema: { type: 'object' }, error: message(e) }),
        )
        entries.set(name, { tool, source, mtimeMs: st.mtimeMs, size: st.size })
        dirty = true
      }
      for (const name of [...entries.keys()]) if (!seen.has(name)) dirty = entries.delete(name) || dirty
      if (dirty) {
        changed()
        // Definition edits invalidate custom-tool queries; recording a run must not retrigger it.
        Effect.runSync(events.publish({ t: 'connector-data-changed', connector: NATIVE_TOOLS }))
      }
    }
    let scanning: Promise<void> = Promise.resolve()
    const rescan = () => (scanning = scanning.then(scan).catch((e) => console.error('[tools] scan', e)))
    yield* Effect.promise(rescan)
    // Agents may write the files directly; the folder is the source of truth.
    let timer: NodeJS.Timeout | undefined
    const watcher = follow(dir, { label: 'tools' }, () => {
      clearTimeout(timer)
      timer = setTimeout(rescan, 150)
    })

    const list = () => [...entries.values()].map((e) => e.tool).sort((a, b) => a.name.localeCompare(b.name))
    const need = async (name: string) => {
      if (!entries.has(name) && NAME.test(name) && existsSync(file(name))) await rescan()
      const e = entries.get(name)
      if (!e) throw new Error(`No tool named ${name}.${entries.size ? ` There ${entries.size === 1 ? 'is' : 'are'}: ${[...entries.keys()].sort().join(', ')}` : ' No custom tools exist yet; create one with tool_save on the app connector.'}`)
      if (e.tool.error) throw new Error(`The tool ${name} does not load: ${e.tool.error}`)
      return e
    }

    // ── running
    const record = sql.prepare('INSERT INTO runs (tool, by, started_at, ms, ok, args, result, error, logs, calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const run = async (name: string, args: Record<string, unknown>, caller: Caller): Promise<unknown> => {
      if (caller.depth >= MAX_DEPTH) throw new Error(`Tools are calling tools more than ${MAX_DEPTH} deep; ${name} was not run`)
      const e = await need(name)
      const required = ((e.tool.inputSchema as { required?: unknown })?.required ?? []) as string[]
      const missing = Array.isArray(required) ? required.filter((k) => args[k] === undefined) : []
      if (missing.length) throw new Error(`${name} is missing: ${missing.join(', ')}`)
      const startedAt = new Date()
      const calls: ToolRun['calls'] = []
      const budget = caller.budget ?? newBudget()
      const inner: Caller = { by: `tool:${name}`, via: caller.by, depth: caller.depth + 1, budget }
      const host = async (connector: string, tool: string, a: Record<string, unknown>) => {
        const t = Date.now()
        const call = { connector, tool, ms: 0, ok: false }
        calls.push(call)
        try {
          const data = await Effect.runPromise(connectors.call(connector, tool, a, inner))
          call.ok = true
          return data
        } finally {
          call.ms = Date.now() - t
        }
      }
      const finish = (ok: boolean, result: unknown, error: string | null, logs: string[]) => {
        record.run(name, caller.by, startedAt.toISOString(), Date.now() - startedAt.getTime(), ok ? 1 : 0, clip(args), ok ? clip(result) : null, error, clip(logs), JSON.stringify(calls.slice(0, 500)))
        // A tool on a schedule of seconds writes thousands of runs a day; keep only its recent ones.
        prune.run(name, KEEP_RUNS)
        changed()
      }
      try {
        const out = await execute(name, e.source, args, host, undefined, budget)
        finish(true, out.result, null, out.logs)
        return out.result
      } catch (err) {
        const logs = (err as { logs?: string[] }).logs ?? []
        finish(false, null, message(err), logs)
        // The caller is often an agent fixing the tool: give it what the code printed on the way.
        throw new Error(logs.length ? `${message(err)}\n\nconsole output:\n${logs.slice(-20).join('\n')}` : message(err))
      }
    }

    const runs: ToolsShape['runs'] = (filter = {}) =>
      (sql.prepare(`SELECT * FROM runs ${filter.tool ? 'WHERE tool = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(filter.tool ? [filter.tool] : []), Math.min(Math.max(1, Math.floor(filter.limit ?? 20)), 200)) as any[]).map((r) => ({
        id: r.id,
        tool: r.tool,
        by: r.by,
        startedAt: r.started_at,
        ms: r.ms,
        ok: !!r.ok,
        args: JSON.parse(r.args),
        ...(r.ok ? { result: JSON.parse(r.result ?? 'null') } : { error: r.error ?? 'failed' }),
        logs: JSON.parse(r.logs),
        calls: JSON.parse(r.calls),
      }))

    // ── schedules
    const running = new Map<string, { edited: boolean }>()
    const schedules = (): ToolSchedule[] =>
      (sql.prepare('SELECT * FROM schedules ORDER BY created_at').all() as any[]).map((s) => ({ id: s.id, tool: s.tool, args: JSON.parse(s.args), cron: s.cron, enabled: !!s.enabled, nextAt: s.enabled ? s.next_at : null, lastAt: s.last_at, lastOk: s.last_ok === null ? null : !!s.last_ok, lastError: s.last_error, running: running.has(s.id) }))
    const saveSchedule: ToolsShape['saveSchedule'] = (input) => {
      parseCron(input.cron)
      if (!NAME.test(String(input.tool))) throw new Error(`"${input.tool}" is not a tool name`)
      const id = String(input.id ?? input.tool).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
      if (!id) throw new Error('A schedule needs an id')
      const enabled = input.enabled !== false
      const next = nextRun(input.cron, new Date()).toISOString()
      sql
        .prepare('INSERT INTO schedules (id, tool, args, cron, enabled, created_at, next_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET tool = excluded.tool, args = excluded.args, cron = excluded.cron, enabled = excluded.enabled, next_at = excluded.next_at')
        .run(id, input.tool, JSON.stringify(input.args ?? {}), input.cron.trim(), enabled ? 1 : 0, new Date().toISOString(), next)
      const active = running.get(id)
      if (active) active.edited = true
      changed()
      return schedules().find((s) => s.id === id)!
    }
    const removeSchedule = (id: string) => {
      const removed = sql.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0
      const active = running.get(id)
      if (removed && active) active.edited = true
      if (removed) changed()
      return removed
    }
    // A schedule that came due while the app was closed runs once now, not once per missed time;
    // and it never overlaps itself: a run still going when the next is due makes that one wait.
    const started = Date.now()
    const tick = () => {
      const now = new Date()
      for (const s of schedules()) {
        if (!s.enabled || running.has(s.id) || !s.nextAt || s.nextAt > now.toISOString()) continue
        const active = { edited: false }
        running.set(s.id, active)
        changed()
        const began = Date.now()
        void run(s.tool, s.args, { by: `schedule:${s.id}`, depth: 0 })
          .then(
            () => null,
            (e) => message(e).split('\n')[0]!.slice(0, 500),
          )
          .then((error) => {
            running.delete(s.id)
            // A save (or deletion and recreation) owns the next time now. The old execution is
            // still in runs, but must not overwrite the edited schedule's timing or last result.
            if (active.edited) return changed()
            let next: string | null = null
            try {
              // The limits on a run are per run. More often than once a minute, a schedule rests for as long
              // as its run took before the next, so those limits still bound what it uses over time.
              const cron = parseCron(s.cron)
              const rest = cron.second.size > 1 ? Date.now() - began : 0
              next = nextRun(cron, new Date(Date.now() + rest)).toISOString()
            } catch {
              /* a schedule that can no longer come round stops */
            }
            sql.prepare('UPDATE schedules SET last_at = ?, last_ok = ?, last_error = ?, next_at = ? WHERE id = ?').run(new Date().toISOString(), error ? 0 : 1, error, next, s.id)
            changed()
          })
      }
    }
    // A schedule can be as often as every second, so that is how often this looks. The first look
    // waits for connectors to come up.
    const ticking = setInterval(() => Date.now() - started >= 8000 && tick(), 1000)

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearInterval(ticking)
        clearTimeout(timer)
        watcher.close()
      }),
    )

    connectors.registerInternal(NATIVE_TOOLS, 'Tools', {
      tools: () => list().filter((t) => !t.error).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      call: (name, args, caller) => run(name, args, caller),
    })

    return Tools.of({
      dir,
      list,
      source: (name) => {
        const e = entries.get(name)
        if (!e) throw new Error(`No tool named ${name}`)
        return e.source
      },
      save: (name, source) =>
        attempt(async () => {
          if (!NAME.test(name)) throw new Error('A tool name is lower-case letters, digits and underscores, starting with a letter (for example check_new_prs)')
          if (typeof source !== 'string' || !source.trim()) throw new Error('source must be the JavaScript of the tool')
          await inspect(name, source)
          writeFileSync(file(name), source)
          await rescan()
          return entries.get(name)!.tool
        }),
      remove: (name) =>
        attempt(async () => {
          if (!NAME.test(name) || !existsSync(file(name))) return false
          unlinkSync(file(name))
          await rescan()
          return true
        }),
      run: (name, args, caller) => attempt(() => run(name, args, caller)),
      runs,
      schedules,
      saveSchedule,
      removeSchedule,
    })
  }),
)

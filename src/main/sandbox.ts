// Where custom tool code runs: QuickJS compiled to WebAssembly. The code has no network, files,
// timers or Node; the only way out is `call(connector, tool, args)`, which the host answers. Each
// run gets its own interpreter instance with a memory cap, so nothing carries over between runs
// and a run that ends badly cannot affect the next.
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime } from 'quickjs-emscripten'

export interface ToolMeta {
  description: string
  inputSchema: unknown
}
export interface SandboxLimits {
  /** Whole run, including time spent waiting on calls. */
  timeoutMs: number
  /** How long the code may compute without waiting on anything. The app's main thread is busy for that long. */
  cpuMs: number
  /** All the computing a run may do, and the tools it calls with it. */
  cpuTotalMs: number
  memoryBytes: number
  maxCalls: number
  /** Calls made by a run and every tool it calls, together. */
  maxTreeCalls: number
}
export const LIMITS: SandboxLimits = { timeoutMs: 15 * 60000, cpuMs: 1000, cpuTotalMs: 20000, memoryBytes: 64 << 20, maxCalls: 200, maxTreeCalls: 1000 }

/**
 * What a run has left, shared with every tool it calls: without it each nested tool would start
 * with fresh limits, and four levels of 200 calls is over a billion.
 */
export interface Budget {
  calls: number
  cpuMs: number
  /** When the outermost run must be over. */
  until: number
}
export const newBudget = (limits: SandboxLimits = LIMITS): Budget => ({ calls: 0, cpuMs: 0, until: Date.now() + limits.timeoutMs })

export interface SandboxRun {
  result: unknown
  logs: string[]
}
export type HostCall = (connector: string, tool: string, args: Record<string, unknown>) => Promise<unknown>

// What tool code sees. Everything is `call` underneath.
const PRELUDE = `
globalThis.call = async (connector, tool, args) => JSON.parse(await __call(String(connector), String(tool), JSON.stringify(args ?? {})))
globalThis.db = {
  get: async (collection, key) => (await call('app', 'db_get', { collection, key })).value,
  put: (collection, key, value, opts) => call('app', 'db_put', { collection, key, value, if_absent: !!(opts && opts.ifAbsent) }),
  delete: (collection, key) => call('app', 'db_delete', { collection, key }),
  query: (collection, opts) => call('app', 'db_query', { ...opts, collection }),
}
globalThis.files = {
  get: (name, opts) => call('app', 'files_get', { ...opts, name }),
  put: (name, text, opts) => call('app', 'files_put', { ...opts, name, text }),
  list: (prefix) => call('app', 'files_list', { prefix }),
  delete: (name) => call('app', 'files_delete', { name }),
}
globalThis.notify = (workspace, text, link) => call('app', 'notification_send', { workspace, text, link })
globalThis.tools = new Proxy({}, { get: (_, name) => (args) => call('tools', String(name), args) })
{
  const show = (v) => { if (typeof v === 'string') return v; if (v instanceof Error) return v.stack ? v.message + '\\n' + v.stack : v.message; try { return JSON.stringify(v) ?? String(v) } catch { return String(v) } }
  const log = (level) => (...a) => __log(level, a.map(show).join(' '))
  globalThis.console = { log: log('log'), info: log('log'), debug: log('log'), warn: log('warn'), error: log('error') }
}
globalThis.structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
globalThis.__run = async (fn, json) => JSON.stringify((await fn(JSON.parse(json))) ?? null)
`

const STOPPED = 'The tool computed for too long without waiting on anything and was stopped'
const OUT_OF_MEMORY = 'InternalError: out of memory'
const describe = ({ ctx, full }: Box, error: QuickJSHandle) => {
  const e = ctx.dump(error)
  error.dispose()
  // Out of memory, QuickJS may have none left to make the error with, and throws without one.
  if ((e === null || e === undefined) && full()) return OUT_OF_MEMORY
  if (!e || typeof e !== 'object') return String(e)
  if (e.message === 'interrupted') return STOPPED
  // Where in the tool's own code, not in the helpers every tool shares. An error that came back
  // from a call already says what it has to say.
  const where = typeof e.stack === 'string' ? ([...e.stack.matchAll(/([\w.-]+\.js):(\d+(?::\d+)?)/g)].find((m) => m[1] !== 'prelude.js')?.[0] ?? '') : ''
  const text = String(e.message ?? JSON.stringify(e))
  return `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${text}${where && !text.includes(where) ? ` (${where})` : ''}`
}

interface Box {
  rt: QuickJSRuntime
  ctx: QuickJSContext
  /** Give the code another slice of compute time; the interrupt fires when it runs past it. */
  slice: () => void
  /** Whether the heap has grown as far as it may. */
  full: () => boolean
  logs: string[]
}

/** WebAssembly is a global in Node and Electron; the types here only describe its shapes. */
const Wasm = (globalThis as unknown as { WebAssembly: { Memory: new (d: { initial: number; maximum: number }) => { buffer: ArrayBuffer } } }).WebAssembly
const PAGE = 64 << 10
/** What the interpreter's heap starts at: its own data and stack, before any code runs. */
const BASE = 16 << 20

async function open(limits: SandboxLimits, budget: Budget, onCall: (connector: string, tool: string, json: string, box: Box) => QuickJSHandle): Promise<Box> {
  // QuickJS's own memory limit is kept, but in this build it counts allocations rather than their size (it cannot ask
  // malloc how big a block is), so a string or a buffer of any size went uncounted, up to the 2 GB WebAssembly allows.
  // The heap itself is what is capped: each run's is its own and cannot grow past the limit, so an allocation past it
  // fails, as out of memory, at once.
  const most = BASE + Math.ceil(limits.memoryBytes / PAGE) * PAGE
  const memory = new Wasm.Memory({ initial: BASE / PAGE, maximum: most / PAGE })
  // The heap grows by a fifth at a time, so one refused leaves it short of the most it may be.
  const full = () => memory.buffer.byteLength > most * 0.75
  const rt = (await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: memory }))).newRuntime()

  rt.setMemoryLimit(limits.memoryBytes)
  rt.setMaxStackSize(1 << 20)
  // The interpreter asks this every so often while code runs: time between two asks is time spent computing.
  let deadline = 0
  let asked = 0
  rt.setInterruptHandler(() => {
    const now = Date.now()
    budget.cpuMs += now - asked
    asked = now
    return now > deadline || budget.cpuMs > limits.cpuTotalMs
  })
  const ctx = rt.newContext()
  const box: Box = { rt, ctx, logs: [], full, slice: () => (deadline = (asked = Date.now()) + limits.cpuMs) }
  ctx.newFunction('__call', (c, t, j) => onCall(ctx.getString(c), ctx.getString(t), ctx.getString(j), box)).consume((f) => ctx.setProp(ctx.global, '__call', f))
  ctx
    .newFunction('__log', (level, text) => {
      if (box.logs.length < 500) box.logs.push(`${ctx.getString(level) === 'log' ? '' : `[${ctx.getString(level)}] `}${ctx.getString(text).slice(0, 4000)}`)
    })
    .consume((f) => ctx.setProp(ctx.global, '__log', f))
  box.slice()
  ctx.unwrapResult(ctx.evalCode(PRELUDE, 'prelude.js')).dispose()
  return box
}

const close = (box: Box) => {
  // Calls still in flight hold handles; a fresh interpreter per run means a messy close costs nothing.
  try {
    box.ctx.dispose()
    box.rt.dispose()
  } catch {
    /* abandoned with the instance */
  }
}

/** Load the module and return its default export and the other things it declares. */
const load = (box: Box, name: string, source: string) => {
  const { ctx } = box
  box.slice()
  const loaded = ctx.evalCode(source, `${name}.js`, { type: 'module' })
  if (loaded.error) throw new Error(describe(box, loaded.error))
  const ns = loaded.value
  const fn = ctx.getProp(ns, 'default')
  if (ctx.typeof(fn) !== 'function') {
    fn.dispose()
    ns.dispose()
    throw new Error('A tool must `export default` a function (do not use `await` outside it)')
  }
  const read = (prop: string) => ctx.getProp(ns, prop).consume((h) => ctx.dump(h))
  const description = read('description')
  const input = read('input')
  ns.dispose()
  if (description !== undefined && typeof description !== 'string') throw new Error('`export const description` must be a string')
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('`export const input` must be a JSON Schema object')
  const inputSchema = input === undefined ? { type: 'object' } : input.type === 'object' ? input : { type: 'object', properties: input }
  return { fn, meta: { description: description ?? '', inputSchema } as ToolMeta }
}

/** Read a tool's description and input schema by loading it with no way to call out. */
export async function inspect(name: string, source: string): Promise<ToolMeta> {
  const limits = { ...LIMITS, cpuMs: 500, memoryBytes: 16 << 20 }
  const box = await open(limits, newBudget(limits), (_c, _t, _j, b) => {
    const d = b.ctx.newPromise()
    b.ctx.newError('A tool can only make calls while it runs, not while it loads').consume((e) => d.reject(e))
    return d.handle
  })
  try {
    const { fn, meta } = load(box, name, source)
    fn.dispose()
    return meta
  } finally {
    close(box)
  }
}

export async function execute(name: string, source: string, args: Record<string, unknown>, host: HostCall, limits: SandboxLimits = LIMITS, budget: Budget = newBudget(limits)): Promise<SandboxRun> {
  let alive = true
  let calls = 0
  const pending = new Set<QuickJSDeferredPromise>()
  const refuse = () => (++calls > limits.maxCalls ? `A tool can make at most ${limits.maxCalls} calls in one run` : ++budget.calls > limits.maxTreeCalls ? `A run and the tools it calls can make at most ${limits.maxTreeCalls} calls together` : null)
  const box = await open(limits, budget, (connector, tool, json, b) => {
    const d = b.ctx.newPromise()
    pending.add(d)
    const settle = (f: () => void) => {
      pending.delete(d)
      if (!alive) return
      f()
      b.slice()
      // Runs whatever was waiting on this answer. Errors surface through the tool's own promise.
      b.rt.executePendingJobs()
    }
    const refused = refuse()
    const work = refused ? Promise.reject(new Error(refused)) : Promise.resolve().then(() => host(connector, tool, JSON.parse(json)))
    work.then(
      (data) => settle(() => b.ctx.newString(JSON.stringify(data ?? null)).consume((v) => d.resolve(v))),
      (e) => settle(() => b.ctx.newError(e instanceof Error ? e.message : String(e)).consume((v) => d.reject(v))),
    )
    return d.handle
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const { ctx } = box
    const { fn } = load(box, name, source)
    const started = ctx.getProp(ctx.global, '__run').consume((run) => ctx.newString(JSON.stringify(args)).consume((json) => fn.consume((f) => ctx.callFunction(run, ctx.undefined, f, json))))
    if (started.error) throw new Error(describe(box, started.error))
    const settled = started.value.consume((p) => ctx.resolvePromise(p))
    box.slice()
    box.rt.executePendingJobs()
    const out = await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        // A tool called by a tool has only what is left of the outer run's time.
        timer = setTimeout(() => reject(new Error(`The tool ran for more than ${Math.round(limits.timeoutMs / 1000)}s (with the tools it called) and was stopped`)), Math.max(0, Math.min(limits.timeoutMs, budget.until - Date.now())))
      }),
    ])
    if (out.error) throw new Error(describe(box, out.error))
    return { result: JSON.parse(out.value.consume((v) => ctx.getString(v))), logs: box.logs }
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { logs: box.logs })
  } finally {
    clearTimeout(timer)
    alive = false
    for (const d of pending) if (d.alive) d.dispose()
    close(box)
  }
}

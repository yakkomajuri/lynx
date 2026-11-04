// The `agents` MCP tools: the same names, inputs and compact answers the engine had, so Lynx and the
// workspace apps built on it keep working unchanged.
import { randomUUID } from 'node:crypto'
import { discoverProviders } from './providers/discovery'
import { providers as registered } from './providers/registry'
import type { Files } from './files'
import type { Runner } from './runner'
import { anyObject, array, bool, check, cursor, int, limit, literals, object, str, strings, text, timestamp, uuid, type JsonSchema } from './schema'
import type { Launch, Schedules } from './schedules'
import type { Shell } from './shell'
import { DIAGNOSTIC, isTerminal, problem, type StartInput, type Store } from './store'

export interface ToolContext {
  view: 'compact' | 'full'
  idempotencyKey?: string
}
interface Tool {
  name: string
  description: string
  input: JsonSchema
  readOnly: boolean
  handler: (input: any, ctx: ToolContext) => unknown
}

const harnesses = () => registered().map((p) => p.id)
const attachments = array(object({ path: text, name: { type: 'string', pattern: '^[^\\u0000-\\u001f/\\\\]{1,200}$' }, transfer_id: uuid }), 20)
const config = object({
  model: text,
  effort: text,
  instructions: str,
  permission_mode: literals('ask', 'deny', 'auto', 'allow'),
  timeout_ms: int(1, 86400000),
})
const startFields = () => ({
  harness: literals(...harnesses()),
  connection_ids: array(uuid),
  prompt: text,
  cwd: str,
  config,
  labels: strings,
  trigger: anyObject,
  attachments,
})
const launch = (): JsonSchema => ({ anyOf: [object(startFields(), ['harness', 'prompt']), object({ session_id: uuid, prompt: text, attachments }, ['session_id', 'prompt'])] })
const sessionCursor = (created_at: string, id: string) => Buffer.from(JSON.stringify({ v: 1, created_at, id })).toString('base64url')
const readSessionCursor = (value?: string) => {
  if (!value) return { created_at: '', id: '' }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (decoded?.v === 1 && typeof decoded.created_at === 'string' && typeof decoded.id === 'string') return decoded as { created_at: string; id: string }
  } catch {
    // Falls through.
  }
  throw problem('invalid_cursor', 'Use next_cursor from a previous session_list')
}
/** Plain words for FTS5: each term quoted, all of them required. */
const ftsQuery = (query: string) =>
  query
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ''))
    .filter(Boolean)
    .map((w) => `"${w}"`)
    .join(' ')

/** History keeps its pages small; the complete payload stays readable through event_payload. */
function historyEvent(event: { stream_id: string; seq: string; execution_id: string | null; type: string; payload: any }) {
  const original = event.payload
  let payload = original
  const compactError = (error: any) => (error && typeof error === 'object' ? { code: error.code, message: String(error.message ?? 'Execution failed').slice(0, 2000) } : String(error).slice(0, 2000))
  if (event.type === 'agent_completed') payload = { success: original?.success, ...(original?.error ? { error: compactError(original.error) } : {}) }
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(event.type)) payload = { ...(original?.error ? { error: compactError(original.error) } : {}) }
  if (event.type === 'launched') payload = { started: true, ...(event.payload?.warm ? { warm: true } : {}) }
  if (event.type === 'starting') payload = {}
  let shortened = payload !== original
  const encoded = JSON.stringify(payload)
  if (encoded && encoded.length > 4000) {
    payload = { preview: encoded.slice(0, 4000) }
    shortened = true
  }
  return { seq: event.seq, execution_id: event.execution_id, type: event.type, payload, ...(shortened ? { payload_truncated: true, payload_ref: { stream_id: event.stream_id, seq: event.seq } } : {}) }
}

export function createTools(store: Store, runner: Runner, schedules: Schedules, shell: Shell, files: Files, info: { roots: string[] }) {
  const { q } = store
  const tools: Tool[] = []
  const define = (name: string, description: string, input: JsonSchema, readOnly: boolean, handler: Tool['handler']) => tools.push({ name, description, input, readOnly, handler })

  define('server_status', 'Server health, the agents installed on this machine and their models, and how many runs are in each state', object({}), true, async () => ({
    database: 'ok',
    time: new Date().toISOString(),
    file_roots: info.roots,
    concurrency: { agents: runner.concurrency(), shell: shell.concurrency() },
    supervisor: { heartbeat: new Date().toISOString(), healthy: true },
    executions: q("SELECT 'run' AS kind, status, count(*) AS count FROM runs GROUP BY status UNION ALL SELECT 'process', status, count(*) FROM processes GROUP BY status").all(),
    capabilities: { shell: true, files: true, agents: true },
    providers: await discoverProviders(),
  }))

  // Sign-ins the user finishes in their browser (`/login` in the agent panel), one at a time per
  // agent: Codex takes the browser's answer on a fixed port. Gone ten minutes after they end.
  type SignIn = { id: string; harness: string; status: 'pending' | 'signed_in' | 'failed' | 'cancelled'; error?: string; cancel: () => void; at: number }
  const signIns = new Map<string, SignIn>()
  define('provider_sign_in', "Sign in to an agent's account through the browser: answers with the address to open, then provider_sign_in_get says when it is done", object({ harness: literals(...harnesses()) }, ['harness']), false, async (input) => {
    const provider = registered().find((p) => p.id === input.harness)
    if (!provider?.sign_in) throw problem('unsupported_capability', `${provider?.name ?? input.harness} cannot sign in through the browser`)
    for (const [id, s] of signIns) {
      if (s.harness === input.harness && s.status === 'pending') s.cancel()
      if (s.status !== 'pending' && Date.now() - s.at > 600000) signIns.delete(id)
    }
    const started = await provider.sign_in().catch((e) => {
      throw problem('provider_failure', e instanceof Error ? e.message : String(e), 502)
    })
    const entry: SignIn = { id: randomUUID(), harness: input.harness, status: 'pending', cancel: () => {}, at: Date.now() }
    const expire = setTimeout(() => started.cancel(), 600000)
    expire.unref()
    entry.cancel = () => {
      if (entry.status !== 'pending') return
      entry.status = 'cancelled'
      started.cancel()
    }
    started.done.then(
      () => {
        if (entry.status === 'pending') entry.status = 'signed_in'
      },
      (e) => {
        if (entry.status !== 'pending') return
        entry.status = 'failed'
        entry.error = e instanceof Error ? e.message : String(e)
      },
    ).finally(() => {
      clearTimeout(expire)
      entry.at = Date.now()
    })
    signIns.set(entry.id, entry)
    return { id: entry.id, harness: entry.harness, url: started.url }
  })
  define('provider_sign_in_get', 'Whether a browser sign-in is still waiting, signed in, failed (and why) or was cancelled', object({ id: uuid }, ['id']), true, (input) => {
    const s = signIns.get(input.id)
    if (!s) throw problem('not_found', 'No such sign-in', 404)
    return { id: s.id, harness: s.harness, status: s.status, ...(s.error ? { error: s.error } : {}) }
  })
  define('provider_sign_in_cancel', 'Stop waiting for a browser sign-in', object({ id: uuid }, ['id']), false, (input) => {
    const s = signIns.get(input.id)
    if (!s) throw problem('not_found', 'No such sign-in', 404)
    s.cancel()
    return { id: s.id, harness: s.harness, status: s.status }
  })

  define('session_start', 'Create a durable conversation and optionally submit its first prompt', object({ ...startFields(), idempotency_key: text }, ['harness']), false, async (input, ctx) => {
    const { idempotency_key, ...rest } = input
    const result = await store.idempotent('session_start', ctx.idempotencyKey ?? idempotency_key, rest, async () => {
      const provider = (await discoverProviders()).find((p) => p.name === input.harness)
      if (!provider?.available) throw problem('provider_unavailable', 'Provider is not available on this installation', 503)
      const mode = input.config?.permission_mode
      if (mode && !provider.capabilities.permission_modes.includes(mode)) throw problem('unsupported_capability', `${provider.display_name} has no ${mode} permission mode`)
      const { session, run } = await store.startSession(rest as StartInput)
      return { session_id: session.id, run_id: run?.id ?? null }
    })
    const session = store.getSession(result.session_id)
    return { session: store.sessionView(session, ctx.view === 'full'), run: result.run_id ? store.runView(store.getRun(result.run_id), ctx.view === 'full') : null }
  })

  define(
    'session_send',
    'Continue an idle conversation using its native provider session. model, effort and permission_mode switch the session to another model, effort level or permission mode from this turn on.',
    object({ id: uuid, prompt: text, model: text, effort: text, permission_mode: literals('ask', 'deny', 'auto', 'allow'), idempotency_key: text, trigger: anyObject, attachments }, ['id', 'prompt']),
    false,
    async (input, ctx) => {
      const { idempotency_key, ...rest } = input
      if (input.permission_mode) {
        const provider = (await discoverProviders()).find((p) => p.name === store.getSession(input.id).harness)
        if (provider && !provider.capabilities.permission_modes.includes(input.permission_mode)) throw problem('unsupported_capability', `${provider.display_name} has no ${input.permission_mode} permission mode`)
      }
      const runId = await store.idempotent('session_send', ctx.idempotencyKey ?? idempotency_key, rest, async () => (await store.sendSession(input.id, input.prompt, input)).id)
      return store.runView(store.getRun(runId), ctx.view === 'full')
    },
  )

  define('session_get', 'Read conversation configuration and latest run', object({ id: uuid }, ['id']), true, (input, ctx) => {
    const session = store.getSession(input.id)
    const latest = store.latestRun(input.id)
    return { session: store.sessionView(session, ctx.view === 'full'), latest_run: latest ? store.runView(latest, ctx.view === 'full') : null, connection_ids: store.grants(input.id) }
  })

  define(
    'session_list',
    'List conversations chronologically with an opaque creation-time cursor',
    object({ after: str, created_from: timestamp, created_before: timestamp, limit, harness: literals(...harnesses()), cwd: str, labels: strings, status: str, include_archived: bool }),
    true,
    (input, ctx) => {
      const after = readSessionCursor(input.after)
      const n = input.limit ?? 100
      const labels = Object.entries((input.labels ?? {}) as Record<string, string>)
      const rows = q(
        `SELECT s.*, latest.status AS status, substr(json_extract(latest.spec, '$.prompt'), 1, 160) AS preview
         FROM sessions s LEFT JOIN runs latest ON latest.id = (SELECT id FROM runs r WHERE r.session_id = s.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
         WHERE (? OR s.archived_at IS NULL) AND (s.created_at, s.id) > (?, ?)
           AND (? IS NULL OR s.created_at >= ?) AND (? IS NULL OR s.created_at < ?)
           AND (? IS NULL OR s.harness = ?) AND (? IS NULL OR s.cwd = ?) AND (? IS NULL OR latest.status = ?)
           ${labels.map(() => "AND json_extract(s.labels, '$.' || json_quote(?)) = ?").join(' ')}
         ORDER BY s.created_at, s.id LIMIT ?`,
      ).all(
        input.include_archived ? 1 : 0, after.created_at, after.id,
        input.created_from ?? null, input.created_from ?? null, input.created_before ?? null, input.created_before ?? null,
        input.harness ?? null, input.harness ?? null, input.cwd ?? null, input.cwd ?? null, input.status ?? null, input.status ?? null,
        ...labels.flat(), n + 1,
      )
      const selected = rows.slice(0, n)
      const last = selected.at(-1)
      const items = selected.map((row) => {
        const session = store.toSession(row)
        return ctx.view === 'full'
          ? { ...session, status: row.status, preview: row.preview }
          : { id: session.id, harness: session.harness, cwd: session.cwd, labels: session.labels, status: row.status ?? 'idle', preview: row.preview, archived_at: session.archived_at, created_at: session.created_at }
      })
      return { items, next_cursor: last ? sessionCursor(last.created_at, last.id) : (input.after ?? null), has_more: rows.length > selected.length }
    },
  )

  define(
    'session_history',
    'Read captured provider and lifecycle events. With wait_ms, a page with nothing new waits up to that long for the next event instead of returning empty',
    object({ id: uuid, after: cursor, limit, types: array(text), wait_ms: int(0, 25000) }, ['id']),
    true,
    async (input, ctx) => {
      const read = () => store.history(input.id, input.after, input.limit, { types: input.types, exclude: ctx.view === 'full' || input.types ? [] : DIAGNOSTIC })
      let page = read()
      const deadline = Date.now() + (input.wait_ms ?? 0)
      while (!page.items.length && Date.now() < deadline) {
        // Woken by the session's own events. Events often come in bursts, so a woken reader waits a
        // moment to take the rest of the burst in the same page.
        const woken = await new Promise<boolean>((resolve) => {
          const finish = (value: boolean) => {
            clearTimeout(timer)
            store.changes.off('event', onEvent)
            resolve(value)
          }
          const onEvent = (sessionId: string) => sessionId === input.id && finish(true)
          const timer = setTimeout(() => finish(false), deadline - Date.now())
          store.changes.on('event', onEvent)
        })
        if (woken) await new Promise((r) => setTimeout(r, 15))
        page = read()
        if (!woken) break
      }
      return ctx.view === 'full' ? page : { ...page, items: page.items.map(historyEvent) }
    },
  )

  define(
    'session_search',
    'Search captured textual history with full-text search',
    object({ query: text, created_from: timestamp, created_before: timestamp, harness: literals(...harnesses()), cwd: str, labels: strings, session_id: uuid, include_archived: bool, after: str, limit }, ['query']),
    true,
    (input, ctx) => {
      const n = input.limit ?? 100
      let afterSession = ''
      let afterSeq = 0
      if (input.after) {
        const [s, seq] = String(input.after).split(':')
        if (!s || !seq || !/^\d+$/.test(seq)) throw problem('invalid_cursor', 'Expected session UUID and sequence')
        afterSession = s
        afterSeq = Number(seq)
      }
      const match = ftsQuery(input.query)
      if (!match) return { items: [], next_cursor: input.after ?? null, has_more: false }
      const labels = Object.entries((input.labels ?? {}) as Record<string, string>)
      const hidden = ctx.view === 'full' ? [] : DIAGNOSTIC
      const rows = q(
        `SELECT e.session_id, e.seq, e.type, snippet(events_fts, 0, '<b>', '</b>', '…', 32) AS snippet
         FROM events_fts JOIN events e ON e.seq = events_fts.rowid JOIN sessions s ON s.id = e.session_id
         WHERE events_fts MATCH ? AND (? OR s.archived_at IS NULL)
           AND (? IS NULL OR e.created_at >= ?) AND (? IS NULL OR e.created_at < ?)
           AND (? IS NULL OR s.harness = ?) AND (? IS NULL OR s.cwd = ?) AND (? IS NULL OR s.id = ?)
           ${hidden.length ? `AND e.type NOT IN (${hidden.map(() => '?').join(',')})` : ''}
           ${labels.map(() => "AND json_extract(s.labels, '$.' || json_quote(?)) = ?").join(' ')}
           AND (e.session_id, e.seq) > (?, ?)
         ORDER BY e.session_id, e.seq LIMIT ?`,
      ).all(
        match, input.include_archived ? 1 : 0,
        input.created_from ?? null, input.created_from ?? null, input.created_before ?? null, input.created_before ?? null,
        input.harness ?? null, input.harness ?? null, input.cwd ?? null, input.cwd ?? null, input.session_id ?? null, input.session_id ?? null,
        ...hidden, ...labels.flat(), afterSession, afterSeq, n + 1,
      )
      const items = rows.slice(0, n).map((r) => ({ session_id: r.session_id, seq: String(r.seq), type: r.type, snippet: r.snippet }))
      const last = items.at(-1)
      return { items, next_cursor: last ? `${last.session_id}:${last.seq}` : (input.after ?? null), has_more: rows.length > items.length }
    },
  )

  define('session_archive', 'Archive or restore a session without deleting history or files. Active/scheduled sessions must be stopped first.', object({ id: uuid, archived: bool }, ['id']), false, (input) =>
    store.tx(() => {
      store.getSession(input.id)
      const archived = input.archived ?? true
      if (archived) {
        const active = store.latestRun(input.id)
        const scheduled = q("SELECT id FROM schedules WHERE deleted_at IS NULL AND json_extract(launch, '$.session_id') = ?").get(input.id)
        if ((active && !isTerminal(active.status)) || scheduled) throw problem('busy', 'Stop active work and archive continuation schedules first', 409)
      }
      q('UPDATE sessions SET archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, new Date().toISOString(), new Date().toISOString(), input.id)
      return { id: input.id, archived }
    }),
  )

  define('session_connections_set', 'Set the connections a session may use from its next run on', object({ id: uuid, connection_ids: array(uuid), urgent: bool }, ['id', 'connection_ids']), false, (input) =>
    store.setGrants(input.id, input.connection_ids),
  )

  // Shell commands and files, for what workspaces do without an agent.
  define(
    'exec',
    'Queue a shell command; wait_ms optionally waits for output. timeout_ms starts at launch, not queue admission.',
    object({ command: text, cwd: str, env: { type: 'object', additionalProperties: { type: 'string' } }, timeout_ms: int(1, 86400000), wait_ms: int(0, 30000), idempotency_key: text }, ['command']),
    false,
    async (input, ctx) => {
      const { wait_ms, idempotency_key, ...submission } = input
      const created = await store.idempotent('exec', ctx.idempotencyKey ?? idempotency_key, submission, async () => shell.exec(submission))
      const full = ctx.view === 'full'
      if (wait_ms === undefined) return shell.view(shell.get(created.id), full)
      const timedOut = await shell.wait(created.id, wait_ms)
      const page = shell.page({ id: created.id })
      return { ...shell.view(shell.get(created.id), full), stdout: page.stdout, stderr: page.stderr, output_stats: page.output_stats, next_cursor: page.events.next_cursor, has_more: page.has_more, wait_timed_out: timedOut }
    },
  )
  const processFields = { id: uuid, after: cursor, limit, tail: bool, max_chars: int(1, 65536) }
  define('process_get', 'Read output and status. tail reads the last page; full view includes original events.', object(processFields, ['id']), true, (input, ctx) => shell.pageView(shell.page(input), ctx.view === 'full'))
  define('process_wait', 'Wait for a process, then return bounded output. A wait timeout does not cancel execution.', object({ ...processFields, timeout_ms: int(0, 30000) }, ['id']), true, async (input, ctx) => {
    const { timeout_ms, ...rest } = input
    const timedOut = await shell.wait(input.id, timeout_ms)
    return shell.pageView({ ...shell.page(rest), wait_timed_out: timedOut }, ctx.view === 'full')
  })
  define('process_cancel', 'Request termination of a command and its process group', object({ id: uuid }, ['id']), false, (input, ctx) => shell.view(shell.cancel(input.id), ctx.view === 'full'))
  define('process_input', 'Queue stdin text or EOF; inspect delivery acknowledgement in process_get', object({ id: uuid, data: str, eof: bool, idempotency_key: text }, ['id']), false, (input, ctx) => {
    const { idempotency_key, ...rest } = input
    return store.idempotent('stdin', ctx.idempotencyKey ?? idempotency_key, rest, async () => shell.input(rest))
  })
  define('files_list', 'List an allowed directory', object({ path: str, after: str, limit }, ['path']), true, (input) => files.list(input))
  define('file_read', 'Read a file range as base64 with its current version', object({ path: str, offset: int(0), length: int(1, 1048576) }, ['path']), true, async (input, ctx) => {
    const value = await files.read(input)
    if (ctx.view === 'full' || value.text === undefined) return value
    const { data, encoding, ...rest } = value
    return { ...rest, encoding: 'utf8' }
  })
  define('file_write', 'Atomically replace a file; expected_version can be a hash or missing', object({ path: str, text: str, data: str, expected_version: str }, ['path']), false, (input) => {
    if ((input.text === undefined) === (input.data === undefined)) throw problem('invalid_request', 'Provide exactly one of text or base64 data')
    return files.write(input)
  })
  define('file_patch', 'Replace exactly one matching text fragment', object({ path: str, find: text, replace: str, expected_version: str }, ['path', 'find', 'replace']), false, (input) => files.write(input))

  define('run_get', 'Read a run state and captured outcome', object({ id: uuid }, ['id']), true, (input, ctx) => store.runView(store.getRun(input.id), ctx.view === 'full'))
  define('run_cancel', 'Request cancellation while preserving the conversation', object({ id: uuid }, ['id']), false, (input, ctx) => store.runView(store.cancelRun(input.id), ctx.view === 'full'))
  define('run_wait', 'Wait for a terminal state or required input; timeout does not cancel', object({ id: uuid, timeout_ms: int(0, 30000) }, ['id']), true, async (input, ctx) => {
    const settled = () => {
      const run = store.getRun(input.id)
      return isTerminal(run.status) || (run.status === 'waiting_for_input' && !!q("SELECT id FROM inputs WHERE run_id = ? AND status = 'pending' LIMIT 1").get(run.id)) ? run : null
    }
    let done = settled()
    if (!done) {
      // Woken by the run's own changes rather than polling.
      done = await new Promise((resolve) => {
        const finish = (value: any) => {
          clearTimeout(timer)
          store.changes.off('run', onChange)
          resolve(value)
        }
        const onChange = (id: string) => {
          if (id !== input.id) return
          const run = settled()
          if (run) finish(run)
        }
        const timer = setTimeout(() => finish(null), input.timeout_ms ?? 10000)
        store.changes.on('run', onChange)
      })
    }
    return { run: store.runView(done ?? store.getRun(input.id), ctx.view === 'full'), wait_timed_out: !done }
  })

  define(
    'input_list',
    'List durable questions and approvals',
    object({ session_id: uuid, run_id: uuid, status: literals('pending', 'response_queued', 'delivered', 'stale'), after: uuid, limit }),
    true,
    (input) => store.listInputs(input),
  )
  define(
    'input_respond',
    'Persist an approval or answer and deliver it to the live provider',
    object({ id: uuid, response: object({ decision: literals('allow', 'deny'), message: str, answers: { type: 'object', additionalProperties: array(str) } }) }, ['id', 'response']),
    false,
    (input) => store.respondInput(input.id, input.response, runner.deliver),
  )

  define('event_payload', 'Retrieve a complete event payload using bounded byte ranges', object({ stream_id: uuid, seq: cursor, offset: int(0), length: int(1, 1048576) }, ['stream_id', 'seq']), true, (input) => {
    const row = q('SELECT payload FROM events WHERE session_id = ? AND seq = ?').get(input.stream_id, Number(input.seq))
    if (!row) throw problem('not_found', 'Event not found', 404)
    const bytes = Buffer.from(row.payload)
    const offset = input.offset ?? 0
    if (offset > bytes.length) throw problem('invalid_range', 'Offset is beyond the payload size', 416)
    const end = Math.min(bytes.length, offset + (input.length ?? 65536))
    return { inline: true, size: bytes.length, offset, next_offset: end, data: bytes.subarray(offset, end).toString('base64'), encoding: 'base64' }
  })

  const publicConnection = (row: any) => ({ id: row.id, name: row.name, transport: 'http', enabled: !!row.enabled, revision: row.revision, health: 'unchecked', capabilities: {}, last_error: null })
  define('connection_list', 'List configured connections without credentials', object({ after: uuid, limit, include_disabled: bool }), true, (input) => {
    const n = input.limit ?? 100
    const rows = q('SELECT * FROM connections WHERE (? OR enabled) AND id > ? ORDER BY id LIMIT ?').all(input.include_disabled ? 1 : 0, input.after ?? '', n + 1)
    const items = rows.slice(0, n).map(publicConnection)
    return { items, next_cursor: items.at(-1)?.id ?? input.after ?? null, has_more: rows.length > items.length }
  })
  define('connection_get', 'Read a connection without credentials', object({ id: uuid }, ['id']), true, (input) => {
    const row = q('SELECT * FROM connections WHERE id = ?').get(input.id)
    if (!row) throw problem('not_found', 'Connection not found', 404)
    return publicConnection(row)
  })

  const scheduleFields = () => ({ name: text, cron: text, run_at: timestamp, timezone: text, launch: launch(), enabled: bool })
  define('schedule_create', 'Create a cron schedule with an explicit timezone, or a one-off run_at', object({ ...scheduleFields(), idempotency_key: text }, ['name', 'launch']), false, async (input, ctx) => {
    const { idempotency_key, ...rest } = input
    const id = await store.idempotent('schedule_create', ctx.idempotencyKey ?? idempotency_key, rest, async () => (await schedules.create(rest as { name: string; launch: Launch })).id)
    return schedules.get(id)
  })
  define(
    'schedule_update',
    'Partially update a schedule; omit fields to preserve them. Switching cron/run_at replaces the timing mode.',
    object({ id: uuid, ...scheduleFields(), expected_revision: int() }, ['id']),
    false,
    (input) => schedules.update(input),
  )
  define('schedule_delete', 'Disable and archive a schedule, preserving occurrence history', object({ id: uuid }, ['id']), false, (input) => schedules.remove(input.id))
  define('schedule_list', 'List active schedule definitions', object({ after: uuid, limit }), true, (input) => schedules.list(input))
  define('schedule_occurrences', 'Inspect launched, skipped, and failed scheduled occurrences', object({ id: uuid, after: cursor, limit }, ['id']), true, (input) => schedules.occurrences(input))

  const byName = new Map(tools.map((t) => [t.name, t]))
  return {
    list: () =>
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { ...t.input, properties: { ...t.input.properties, view: { type: 'string', enum: ['compact', 'full'], default: 'compact', description: 'Compact answer by default; full includes raw records and diagnostics' } } },
        annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, openWorldHint: true },
      })),
    call: async (name: string, args: Record<string, unknown> = {}, ctx: Partial<ToolContext> = {}) => {
      const tool = byName.get(name)
      if (!tool) throw problem('not_found', `Unknown tool ${name}`, 404)
      const { view, ...input } = args
      if (view !== undefined && view !== 'compact' && view !== 'full') throw problem('invalid_request', 'view must be "compact" or "full"')
      check(tool.input, input)
      return tool.handler(input, { view: (view as ToolContext['view']) ?? 'compact', idempotencyKey: ctx.idempotencyKey })
    },
  }
}
export type Tools = ReturnType<typeof createTools>

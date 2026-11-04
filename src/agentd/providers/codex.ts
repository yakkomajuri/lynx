import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mcpName, type AgentSpec, type Emit, type Ask } from './types'
import { codexBin } from './codex-bin'
import { failure, type Failure, type FailureClass, type ToolInvocation, type ToolResult } from './events'

type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: unknown }
/** Protocol verified against codex-cli 0.161.0/0.162.0. */
export async function runCodex(spec: AgentSpec, emit: Emit, signal: AbortSignal, ask: Ask) {
  const child = spawn(
    codexBin(),
    ['-c', 'features.apps=false', '-c', 'features.plugins=false', 'app-server', '--stdio'],
    {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string }
  >()
  let nextId = 1,
    threadId: string | undefined,
    turnId: string | undefined,
    completed = false
  let resolveDone!: () => void, rejectDone!: (e: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  // Register a rejection observer during the handshake too.
  done.catch(() => {})
  const send = (message: Rpc) => {
    child.stdin.write(JSON.stringify(message) + '\n')
  }
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex request timed out: ${method}`))
      }, 60000)
      pending.set(id, { resolve, reject, timer, method })
      send({ id, method, params })
    })
  const fail = (error: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    pending.clear()
    rejectDone(error)
  }
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  child.on('exit', (code) => {
    if (!completed) fail(new Error(`Codex app-server exited before completion (${code})`))
  })
  const lines = createInterface({ input: child.stdout })
  let queue = Promise.resolve()
  let partial = ''
  let flushedAt = 0
  const flush = async () => {
    if (!partial) return
    const text = partial
    partial = ''
    flushedAt = Date.now()
    await emit({ type: 'assistant_delta', payload: { text } })
  }
  lines.on('line', (line) => {
    queue = queue
      .then(async () => {
        const message = JSON.parse(line) as Rpc
        // Answer text arrives in small deltas: coalesce them into a live `assistant_delta` preview
        // (the completed item below remains the durable record) instead of one raw event each.
        if (message.method === 'item/agentMessage/delta') {
          const delta = message.params?.delta
          if (typeof delta === 'string' && delta) {
            partial += delta
            if (Date.now() - flushedAt >= 50) await flush()
          }
          return
        }
        await flush()
        if (message.id === undefined || pending.get(Number(message.id))?.method !== 'config/read')
          await emit({ type: 'provider_event', payload: message })
        if (message.id !== undefined && !message.method) {
          const waiting = pending.get(Number(message.id))
          if (!waiting) return
          clearTimeout(waiting.timer)
          pending.delete(Number(message.id))
          if (message.error) waiting.reject(new Error(JSON.stringify(message.error)))
          else waiting.resolve(message.result)
          return
        }
        if (message.id !== undefined && message.method) {
          // Do not hold the notification queue while waiting for a user response.
          void answerCodexRequest(message, spec, ask, emit)
            .then((result) => send({ id: message.id, result }))
            .catch((error) => send({ id: message.id, error: { code: -32601, message: String(error) } }))
          return
        }
        const params = message.params
        if (message.method === 'item/completed') {
          const item = params?.item
          const result = codexToolResult(item)
          if (item?.type === 'agentMessage')
            await emit({ type: 'assistant_message', payload: item, text: item.text })
          else if (result) await emit({ type: 'tool_result', payload: result, text: JSON.stringify(result.output) })
        }
        if (message.method === 'item/started') {
          const invocation = codexTool(params?.item)
          if (invocation) await emit({ type: 'tool_invocation', payload: invocation, text: JSON.stringify(invocation.input) })
        }
        if (message.method === 'thread/tokenUsage/updated') await emit({ type: 'usage', payload: params })
        if (message.method === 'turn/completed') {
          completed = true
          const status = params?.turn?.status
          await emit({
            type: 'agent_completed',
            payload: {
              success: status === 'completed',
              result: params?.turn,
              ...(status === 'failed' ? { error: codexFailure(params?.turn?.error) } : {}),
            },
          })
          resolveDone()
        }
      })
      .catch((e) => fail(e instanceof Error ? e : new Error(String(e))))
  })
  const abort = () => {
    if (threadId && turnId) void request('turn/interrupt', { threadId, turnId }).catch(() => {})
    else child.kill('SIGTERM')
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    await request('initialize', {
      clientInfo: { name: 'headless_cloud_agents', title: 'Headless Cloud Agents', version: '0.1.0' },
    })
    send({ method: 'initialized', params: {} })
    const current = await request('config/read', { cwd: spec.cwd, includeLayers: false })
    const settings = codexThreadSettings(spec, Object.keys(current.config?.mcp_servers ?? {}))
    const result = spec.provider_session_id
      ? await request('thread/resume', { ...settings, threadId: spec.provider_session_id })
      : await request('thread/start', settings)
    threadId = result.thread.id
    await emit({ type: 'provider_session', payload: { id: threadId } })
    const turn = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: spec.prompt, text_elements: [] }],
      // A resumed thread keeps the model it started with unless the turn names one.
      ...(spec.config.model ? { model: spec.config.model } : {}),
      ...(spec.config.effort ? { effort: spec.config.effort } : {}),
    })
    turnId = turn.turn.id
    await done
    await queue
  } finally {
    signal.removeEventListener('abort', abort)
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('Adapter closed'))
    }
    pending.clear()
    lines.close()
    child.kill('SIGTERM')
  }
}

// Items that are the conversation itself, or the agent's thinking, rather than something it did.
const NOT_TOOLS = new Set(['userMessage', 'hookPrompt', 'agentMessage', 'reasoning', 'plan', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode', 'subAgentActivity', 'sleep'])
const failed = (status: unknown) => status === 'failed' || status === 'declined'
const rest = ({ id: _id, type: _type, ...item }: Record<string, unknown>) => item

/** A Codex thread item as a tool call, named as Claude Code would name the same tool. Undefined for items that are not tool calls. */
export function codexTool(item: any): ToolInvocation | undefined {
  if (!item || typeof item.id !== 'string' || typeof item.type !== 'string' || NOT_TOOLS.has(item.type)) return undefined
  const id = item.id
  switch (item.type) {
    case 'commandExecution':
      return { id, kind: 'command', name: 'Bash', input: { command: item.command, cwd: item.cwd } }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      return { id, kind: 'file_change', name: 'Edit', input: { path: changes.map((c: any) => c?.path).join(', '), changes: changes.map((c: any) => ({ path: c?.path, kind: c?.kind })) } }
    }
    case 'mcpToolCall':
      return { id, kind: 'mcp', name: `mcp__${item.server}__${item.tool}`, input: item.arguments }
    case 'dynamicToolCall':
      return { id, kind: 'other', name: item.namespace ? `${item.namespace}__${item.tool}` : String(item.tool), input: item.arguments }
    case 'webSearch':
      return { id, kind: 'web', name: 'WebSearch', input: { query: item.query } }
    case 'imageView':
      return { id, kind: 'file_read', name: 'Read', input: { path: item.path } }
    case 'collabAgentToolCall':
      return { id, kind: 'agent', name: 'Agent', input: { tool: item.tool, prompt: item.prompt, model: item.model } }
    default:
      return { id, kind: 'other', name: item.type, input: rest(item) }
  }
}

/** A finished Codex thread item as the result of its tool call. */
export function codexToolResult(item: any): ToolResult | undefined {
  if (!codexTool(item)) return undefined
  const id = item.id
  switch (item.type) {
    case 'commandExecution':
      return { id, output: item.aggregatedOutput ?? '', is_error: failed(item.status) || (typeof item.exitCode === 'number' && item.exitCode !== 0) }
    case 'fileChange':
      return { id, output: (Array.isArray(item.changes) ? item.changes : []).map((c: any) => c?.diff ?? '').filter(Boolean).join('\n') || item.status, is_error: failed(item.status) }
    case 'mcpToolCall':
      return { id, output: item.error ? item.error.message : mcpOutput(item.result), is_error: !!item.error || failed(item.status) }
    case 'dynamicToolCall':
      return { id, output: (item.contentItems ?? []).map((c: any) => (c?.type === 'inputText' ? { type: 'text', text: c.text } : c)), is_error: item.success === false || failed(item.status) }
    case 'webSearch':
      return { id, output: item.results ?? item.action ?? '', is_error: false }
    default:
      return { id, output: rest(item), is_error: failed(item.status) }
  }
}

/** An MCP result as Claude Code reports it: its content blocks, or its structured content when that is all it has. */
function mcpOutput(result: any): unknown {
  if (!result || typeof result !== 'object') return result ?? ''
  const content = Array.isArray(result.content) ? result.content : []
  const structured = result.structuredContent
  if (structured === undefined || structured === null) return content
  if (!content.length) return structured
  return { content, structuredContent: structured }
}

const CODEX_ERRORS: Record<string, FailureClass> = {
  usageLimitExceeded: 'usage_limit',
  sessionBudgetExceeded: 'usage_limit',
  rateLimitExceeded: 'usage_limit',
  unauthorized: 'auth',
  contextWindowExceeded: 'context_window',
}
/** Why a turn failed, from its `TurnError`: Codex's own error code when it gives one. */
export function codexFailure(error: any): Failure {
  const info = error?.codexErrorInfo
  const key = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined
  const message = typeof error?.message === 'string' && error.message ? error.message : 'Codex turn failed'
  return failure(message, key ? CODEX_ERRORS[key] : undefined, error ?? undefined)
}

/** Settings for `thread/start` and `thread/resume`; `configured` names the user's own MCP servers. */
export function codexThreadSettings(spec: AgentSpec, configured: string[] = []) {
  const mode = spec.config.permission_mode
  const servers: Record<string, unknown> = Object.fromEntries(
    configured.map((name) => [name, { enabled: false }]),
  )
  for (const connection of spec.connections ?? [])
    servers[mcpName(connection.id)] = {
      enabled: true,
      url: connection.url,
      http_headers: connection.headers,
      // With full access every connector tool is pre-approved. Otherwise Codex wants approval for
      // any tool not marked read-only, which "deny" (approval policy `never`) fails outright, "auto"
      // leaves to its reviewer and "ask" raises as an MCP elicitation (see answerCodexRequest).
      default_tools_approval_mode: spec.config.permission_mode === 'allow' ? 'approve' : 'auto',
    }
  return {
    config: { mcp_servers: servers, features: { apps: false, plugins: false } },
    cwd: spec.cwd,
    model: spec.config.model,
    approvalPolicy: mode === 'ask' || mode === 'auto' ? 'on-request' : 'never',
    // Auto is Codex's --approve-for-me: it writes in its own folder, and a reviewer of its own
    // settles each approval instead of the user.
    approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
    sandbox: mode === 'allow' ? 'danger-full-access' : mode === 'auto' ? 'workspace-write' : 'read-only',
    developerInstructions: spec.config.instructions,
  }
}

export async function answerCodexRequest(
  message: Rpc,
  spec: AgentSpec,
  ask: Ask,
  emit: Emit,
): Promise<unknown> {
  if (
    message.method === 'item/commandExecution/requestApproval' ||
    message.method === 'item/fileChange/requestApproval'
  ) {
    if (spec.config.permission_mode === 'allow') return { decision: 'accept' }
    if (spec.config.permission_mode === 'deny') return { decision: 'decline' }
    const response = await ask('approval', {
      provider: 'codex',
      method: message.method,
      detail: message.params,
    })
    return { decision: response.decision === 'allow' ? 'accept' : 'decline' }
  }
  // Codex asks before a connector tool that is not read-only, as an elicitation of its own.
  if (message.method === 'mcpServer/elicitation/request' && message.params?._meta?.codex_approval_kind === 'mcp_tool_call') {
    if (spec.config.permission_mode === 'allow') return { action: 'accept', content: {} }
    if (spec.config.permission_mode === 'deny') return { action: 'decline' }
    const meta = message.params._meta
    const response = await ask('approval', {
      provider: 'codex',
      method: message.method,
      // Its message names the tool ('… to run tool "write_note"?') when it has no title.
      tool_name: typeof meta.tool_title === 'string' ? meta.tool_title : String(message.params.message ?? '').match(/run tool "([^"]+)"/)?.[1],
      detail: message.params,
    })
    return response.decision === 'allow' ? { action: 'accept', content: {} } : { action: 'decline' }
  }
  if (message.method === 'item/tool/requestUserInput') {
    const questions = message.params?.questions as {
      id: string
      question: string
      isOther: boolean
      isSecret: boolean
      options?: { label: string }[]
    }[]
    if (
      !Array.isArray(questions) ||
      !questions.length ||
      questions.some(
        (q) =>
          !q ||
          typeof q.id !== 'string' ||
          !q.id ||
          typeof q.question !== 'string' ||
          !q.question ||
          (q.isOther !== undefined && typeof q.isOther !== 'boolean') ||
          (q.isSecret !== undefined && typeof q.isSecret !== 'boolean') ||
          (q.options !== undefined &&
            (!Array.isArray(q.options) ||
              q.options.some((option) => !option || typeof option.label !== 'string'))),
      ) ||
      new Set(questions.map((q) => q.id)).size !== questions.length
    ) {
      await emit({
        type: 'unsupported_input',
        payload: { provider: 'codex', method: message.method, reason: 'Malformed question payload' },
      })
      throw new Error('invalid_provider_input: malformed question payload')
    }
    if (questions.some((q) => q.isSecret)) {
      await emit({
        type: 'unsupported_input',
        payload: {
          provider: 'codex',
          method: message.method,
          reason: 'Secret questions require a credential flow',
        },
      })
      throw new Error('unsupported_capability: secret questions require a credential flow')
    }
    const response = await ask('questions', {
      provider: 'codex',
      method: message.method,
      questions: questions.map((q) => ({
        id: q.id,
        question: q.question,
        allow_other: q.isOther,
        options: q.options?.map((o) => o.label),
      })),
    })
    return {
      answers: Object.fromEntries(
        Object.entries(response.answers ?? {}).map(([id, answers]) => [id, { answers }]),
      ),
    }
  }
  await emit({ type: 'unsupported_input', payload: { provider: 'codex', method: message.method } })
  throw new Error(`unsupported_capability: ${message.method}`)
}

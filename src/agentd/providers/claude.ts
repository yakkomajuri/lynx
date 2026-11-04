import { query, type EffortLevel, type McpServerConfig, type McpServerStatus, type SDKAssistantMessageError, type SDKResultMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mcpName, type AgentSpec, type Emit, type Ask } from './types'
import { claudeExecutable } from './claude-bin'
import { claudeProviderSettings } from './claude-settings'
import { failure, type Failure, type FailureClass, type ToolInvocation, type ToolKind, type ToolResult } from './events'

const CONTROL_TIMEOUT = 15000
const withTimeout = <T>(work: Promise<T>, what: string) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Claude Code did not answer ${what}`)), CONTROL_TIMEOUT).unref())])
const MODES = { allow: 'bypassPermissions', auto: 'auto', ask: 'default', deny: 'dontAsk' } as const
const permissionMode = (mode: AgentSpec['config']['permission_mode']) => MODES[mode] ?? 'dontAsk'
const servers = (spec: AgentSpec): Record<string, McpServerConfig> =>
  Object.fromEntries((spec.connections ?? []).map((c) => [mcpName(c.id), { type: 'http' as const, url: c.url, headers: c.headers }]))
/**
 * The connector tools Claude Code may use without asking, as permission rules. With full access,
 * every tool of every granted connection; otherwise only the tools their server marks read-only,
 * so the rest are asked about ("ask"), left to the classifier ("auto") or refused ("deny"), like the
 * agent's own tools.
 */
export function connectorRules(spec: AgentSpec, status: McpServerStatus[] = []): string[] {
  const names = (spec.connections ?? []).map((c) => mcpName(c.id))
  if (spec.config.permission_mode === 'allow') return names.map((n) => `mcp__${n}`)
  return status.filter((s) => names.includes(s.name)).flatMap((s) => (s.tools ?? []).filter((t) => t.annotations?.readOnly === true).map((t) => `mcp__${s.name}__${t.name}`))
}

const KINDS: Record<string, ToolKind> = {
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  Read: 'file_read',
  Edit: 'file_change',
  MultiEdit: 'file_change',
  Write: 'file_change',
  NotebookEdit: 'file_change',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agent',
  Agent: 'agent',
}
export const claudeTool = (block: { id: string; name: string; input: unknown }): ToolInvocation => ({
  id: block.id,
  kind: block.name.startsWith('mcp__') ? 'mcp' : (KINDS[block.name] ?? 'other'),
  name: block.name,
  input: block.input,
})
export const claudeToolResult = (block: { tool_use_id: string; content?: unknown; is_error?: boolean | null }): ToolResult => ({
  id: block.tool_use_id,
  output: block.content ?? '',
  is_error: !!block.is_error,
})

const ERRORS: Partial<Record<SDKAssistantMessageError, FailureClass>> = {
  rate_limit: 'usage_limit',
  billing_error: 'usage_limit',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  verification_required: 'auth',
  cloud_credential_error: 'auth',
}
/** Why a turn failed: what Claude Code said about the API error, else its words. */
export function claudeFailure(message: SDKResultMessage, apiError?: SDKAssistantMessageError): Failure {
  const text = 'errors' in message && message.errors.length ? message.errors.join('; ') : 'result' in message && message.result ? message.result : 'Claude returned an error'
  const status = 'api_error_status' in message ? message.api_error_status : undefined
  const code: FailureClass | undefined =
    (apiError && ERRORS[apiError]) ??
    (status === 429 ? 'usage_limit' : status === 401 || status === 403 ? 'auth' : message.terminal_reason === 'prompt_too_long' ? 'context_window' : undefined)
  return failure(text, code, message)
}

/** Prompts for a live query: the SDK reads them one at a time for as long as the process lives. */
function promptQueue() {
  const queued: SDKUserMessage[] = []
  let wake: (() => void) | undefined
  let ended = false
  return {
    push(message: SDKUserMessage) {
      queued.push(message)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queued.length) yield queued.shift()!
        else if (ended) return
        else await new Promise<void>((r) => (wake = r))
      }
    },
  }
}

/**
 * One Claude Code process for a whole session. Each message is a turn on the same query, so the
 * process, its connectors and its prompt cache stay warm between messages. Model and effort change
 * in place. What fixes the process's shape (folder, permission mode, instructions) is the caller's
 * to compare: a change there needs a new process.
 */
export async function claudeSession(first: AgentSpec, emit: Emit, signal: AbortSignal, ask: Ask) {
  const abortController = new AbortController()
  if (signal.aborted) abortController.abort()
  else signal.addEventListener('abort', () => abortController.abort(), { once: true })
  const claude = claudeExecutable()
  if (!claude) throw new Error('Claude Code is not installed on this machine. Install it and sign in, then try again.')
  let spec = first
  const prompts = promptQueue()
  const conversation = query({
    prompt: prompts,
    options: {
      pathToClaudeCodeExecutable: claude,
      cwd: first.cwd,
      model: first.config.model,
      ...(first.config.effort ? { effort: first.config.effort as EffortLevel } : {}),
      resume: first.provider_session_id ?? undefined,
      abortController,
      settingSources: [],
      // Except how the user reaches the API (Bedrock, Vertex, a gateway): see claude-settings.ts.
      settings: claudeProviderSettings(),
      // Partial messages let clients show the answer as it is written.
      includePartialMessages: true,
      strictMcpConfig: true,
      // Connectors are registered over the control channel once the process is up (see `turn`), which
      // keeps their headers out of its command line, where any local user could read them.
      // With full access every connector tool is pre-approved. In the other modes only read-only
      // ones are, once the connectors are up and say which those are (see `turn`).
      allowedTools: connectorRules(first),
      permissionMode: permissionMode(first.config.permission_mode),
      allowDangerouslySkipPermissions: first.config.permission_mode === 'allow',
      ...(first.config.instructions
        ? {
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: first.config.instructions,
            },
          }
        : {}),
      canUseTool: async (toolName, input, options) => {
        if (toolName === 'AskUserQuestion') {
          const questions = input.questions as { question: string; options?: { label: string }[] }[]
          if (
            !Array.isArray(questions) ||
            !questions.length ||
            questions.some(
              (q) =>
                !q ||
                typeof q.question !== 'string' ||
                !q.question ||
                (q.options !== undefined &&
                  (!Array.isArray(q.options) ||
                    q.options.some((option) => !option || typeof option.label !== 'string'))),
            )
          ) {
            await emit({
              type: 'unsupported_input',
              payload: { provider: 'claude', tool_name: toolName, reason: 'Malformed question payload' },
            })
            return { behavior: 'deny', message: 'Malformed question payload' }
          }
          const response = await ask(
            'questions',
            {
              provider: 'claude',
              tool_name: toolName,
              questions: questions.map((q, index) => ({
                id: String(index),
                question: q.question,
                options: q.options?.map((o) => o.label),
                allow_other: true,
              })),
            },
            options.signal,
          )
          const answers = Object.fromEntries(
            questions.map((q, index) => [q.question, response.answers?.[String(index)]?.join(', ') ?? '']),
          )
          return { behavior: 'allow', updatedInput: { ...input, answers } }
        }
        // In auto mode the classifier settles what it can; what it cannot comes here, to the user.
        if (spec.config.permission_mode !== 'ask' && spec.config.permission_mode !== 'auto')
          return { behavior: 'deny', message: 'Unattended policy denies approval-required tools' }
        const response = await ask(
          'approval',
          {
            provider: 'claude',
            tool_name: toolName,
            tool_input: input,
            detail: options.title ?? options.decisionReason,
          },
          options.signal,
        )
        return response.decision === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: response.message ?? 'User denied this tool call' }
      },
      onUserDialog: async (request) => {
        await emit({
          type: 'unsupported_input',
          payload: {
            provider: 'claude',
            kind: request.dialogKind,
            reason: 'Dialog format not supported; cancelled explicitly',
          },
        })
        return { behavior: 'cancelled' }
      },
      onElicitation: async (request) => {
        await emit({
          type: 'unsupported_input',
          payload: {
            provider: 'claude',
            kind: 'mcp_elicitation',
            reason: 'Use connector authentication flow',
          },
        })
        return { action: 'cancel' }
      },
      stderr: (data) => {
        process.stderr.write(data)
      },
    },
  })
  // Text deltas are coalesced into at most one `assistant_delta` event every 50 ms. They are a
  // live preview only: the complete `assistant_message` that follows is the durable record.
  let partial = ''
  let flushedAt = 0
  const flush = async () => {
    if (!partial) return
    const text = partial
    partial = ''
    flushedAt = Date.now()
    await emit({ type: 'assistant_delta', payload: { text } })
  }
  // A turn's `result` does not always end it. Background tasks (subagents, shell commands) the agent
  // started keep running after it, and their notifications start more turns, each with its own
  // result. A resumed session can also replay a notification left over from its previous process
  // before our prompt's turn, as a result of its own. So a turn ends at a result for our prompt (or
  // a later one) once no background work is left; until then the process is not free for another.
  const background = new Set<string>()
  let turn: { answered: boolean; last?: SDKResultMessage; apiError?: SDKAssistantMessageError; done: () => void; fail: (e: Error) => void } | undefined
  const complete = async (message: SDKResultMessage, apiError?: SDKAssistantMessageError) =>
    emit({
      type: 'agent_completed',
      payload: {
        success: !message.is_error,
        result: message,
        ...(message.is_error ? { error: claudeFailure(message, apiError) } : {}),
      },
    })
  // Set once Claude Code is gone. A turn checks it right before it starts waiting, since nothing
  // else would tell it the process went away during its setup.
  let ended: Error | undefined
  const end = (error: Error) => {
    ended ??= error
    turn?.fail(error)
  }
  const consumed = (async () => {
    for await (const message of conversation) {
      if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
        background.clear()
        for (const task of message.tasks) if (!task.ambient) background.add(task.task_id)
      }
      // Between turns there is no run to report to.
      const current = turn
      if (!current) continue
      if (message.type === 'stream_event') {
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          partial += event.delta.text
          if (Date.now() - flushedAt >= 50) await flush()
        }
        continue
      }
      await flush()
      await emit({ type: 'provider_event', payload: message })
      if ('session_id' in message && typeof message.session_id === 'string')
        await emit({ type: 'provider_session', payload: { id: message.session_id } })
      if (message.type === 'assistant') {
        if (message.error) current.apiError = message.error
        for (const block of message.message.content) {
          if (block.type === 'text')
            await emit({ type: 'assistant_message', payload: { text: block.text }, text: block.text })
          if (block.type === 'tool_use')
            await emit({ type: 'tool_invocation', payload: claudeTool(block), text: JSON.stringify(block.input) })
        }
      }
      if (message.type === 'user' && Array.isArray(message.message.content))
        for (const block of message.message.content) {
          if (block.type === 'tool_result')
            await emit({ type: 'tool_result', payload: claudeToolResult(block), text: JSON.stringify(block.content) })
        }
      if (message.type === 'result') {
        await emit({ type: 'usage', payload: { usage: message.usage, cost_usd: message.total_cost_usd } })
        current.last = message
        if (message.origin?.kind !== 'task-notification') current.answered = true
        if (message.is_error || (current.answered && !background.size)) {
          turn = undefined
          await complete(message, current.apiError)
          current.done()
        }
      }
    }
  })().then(
    () => end(new Error('Claude Code exited')),
    (e) => end(e instanceof Error ? e : new Error(String(e))),
  )

  // What the live process currently has, so a turn only changes what differs.
  let model = first.config.model
  let effort = first.config.effort
  let registered = '[]'
  let allowed = JSON.stringify(connectorRules(first))
  const allow = async (rules: string[]) => {
    if (JSON.stringify(rules) === allowed) return
    await withTimeout(conversation.applyFlagSettings({ permissions: { allow: rules } }), 'a permission change')
    allowed = JSON.stringify(rules)
  }

  return {
    async turn(next: AgentSpec) {
      if (ended) throw ended
      spec = next
      if (next.config.model !== model) {
        await withTimeout(conversation.setModel(next.config.model), 'a model change')
        model = next.config.model
      }
      if (next.config.effort !== effort) {
        await withTimeout(conversation.applyFlagSettings({ effortLevel: (next.config.effort as EffortLevel) ?? null }), 'an effort change')
        effort = next.config.effort
      }
      const wanted = JSON.stringify(next.connections ?? [])
      const full = next.config.permission_mode === 'allow'
      if (wanted !== registered) {
        if (full) await allow(connectorRules(next))
        // A connector that fails to connect is reported by name (its errors can echo headers) and the
        // turn goes ahead without it. A registration that is not answered at all may have left a
        // removed connector in place, so the turn fails and the process goes with it.
        const result = await withTimeout(conversation.setMcpServers(servers(next)), 'the connector registration')
        const failed = Object.keys(result.errors)
        if (failed.length) await emit({ type: 'connector_unavailable', payload: { servers: failed } })
        registered = wanted
      }
      // Which connector tools are read-only is known once they are connected; they may have changed since the last turn.
      if (!full) await allow(next.connections?.length ? connectorRules(next, await withTimeout(conversation.mcpServerStatus(), 'the connector status')) : [])
      // Claude can switch itself into plan mode during a turn; every message starts from the session's own mode.
      await withTimeout(conversation.setPermissionMode(permissionMode(next.config.permission_mode)), 'a permission mode change')
      if (ended) throw ended
      const finished = new Promise<void>((done, fail) => (turn = { answered: false, done, fail }))
      prompts.push({ type: 'user', message: { role: 'user', content: next.prompt }, parent_tool_use_id: null })
      await finished
    },
    /** Settles when Claude Code is gone, between turns included. */
    closed: consumed,
    close() {
      prompts.end()
      conversation.close()
    },
  }
}

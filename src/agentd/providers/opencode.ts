import type { Part, Event } from '@opencode-ai/sdk/v2/client'
import { openCodeServer } from './opencode-server'
import { failure, type ToolKind } from './events'
import { mcpName, type AgentSpec } from './types'
import type { SessionIO } from './registry'

const kinds: Record<string, ToolKind> = { bash: 'command', shell: 'command', read: 'file_read', edit: 'file_change', write: 'file_change', apply_patch: 'file_change', glob: 'search', grep: 'search', webfetch: 'web', websearch: 'web' }

/** Native HTTP/SSE API. A message starts its own server and resumes the saved session. */
export async function runOpenCode(spec: AgentSpec, io: SessionIO) {
  const server = await openCodeServer(spec, io.signal)
  const { client } = server
  const streaming = new AbortController()
  const streamSignal = AbortSignal.any([io.signal, streaming.signal])
  const inputSignal = AbortSignal.any([server.signal, streaming.signal])
  let consume: Promise<void> | undefined
  const sent = new Set<string>(), finished = new Set<string>(), messages = new Set<string>()
  const servers = (spec.connections ?? []).map((c) => mcpName(c.id)).sort((a, b) => b.length - a.length)
  const part = async (p: Part) => {
    if (p.type === 'text' && p.time?.end && !finished.has(p.id)) {
      finished.add(p.id)
      if (p.text) await io.emit({ type: 'assistant_message', payload: { text: p.text }, text: p.text })
    }
    if (p.type !== 'tool' || p.state.status === 'pending') return
    const connector = servers.find((name) => p.tool.startsWith(`${name}_`))
    const name = connector ? `mcp__${connector}__${p.tool.slice(connector.length + 1)}` : p.tool
    if (!sent.has(p.callID)) {
      sent.add(p.callID)
      await io.emit({ type: 'tool_invocation', payload: { id: p.callID, name, kind: connector ? 'mcp' : kinds[name] ?? 'other', input: p.state.input }, text: JSON.stringify(p.state.input) })
    }
    if ((p.state.status === 'completed' || p.state.status === 'error') && !finished.has(p.callID)) {
      finished.add(p.callID)
      const output = p.state.status === 'completed' ? p.state.output : p.state.error
      await io.emit({ type: 'tool_result', payload: { id: p.callID, output, is_error: p.state.status === 'error' }, text: output })
    }
  }
  try {
    const session = spec.provider_session_id
      ? (await client.session.get({ sessionID: spec.provider_session_id }, { throwOnError: true })).data
      : (await client.session.create({}, { throwOnError: true })).data
    const sessionID = session.id
    // Clear persisted native permission overrides on a resumed session. This run's rules come
    // from the isolated agent configuration, and one Lynx approval never becomes an always rule.
    await client.session.update({ sessionID, permission: [] }, { throwOnError: true })
    await io.emit({ type: 'provider_session', payload: { id: sessionID } })
    for (const c of spec.connections ?? []) {
      const name = mcpName(c.id)
      const { data } = await client.mcp.add({ name, config: { type: 'remote', url: c.url, headers: c.headers, oauth: false } }, { throwOnError: true })
      if (data[name]?.status !== 'connected') throw new Error('OpenCode could not connect a granted connector')
    }
    let idle!: () => void, connected!: () => void
    const ready = new Promise<void>((resolve) => { connected = resolve })
    const done = new Promise<void>((resolve) => { idle = resolve })
    const handle = async (event: Event) => {
      if (event.type === 'server.connected') { connected(); return }
      const p = event.properties
      if (event.type === 'message.updated') {
        if (event.properties.info.sessionID === sessionID && event.properties.info.role === 'assistant') messages.add(event.properties.info.id)
        return
      }
      if (event.type === 'message.part.updated') {
        if (event.properties.part.sessionID === sessionID && messages.has(event.properties.part.messageID)) await part(event.properties.part)
        return
      }
      if (!('sessionID' in p) || p.sessionID !== sessionID) return
      if (event.type === 'message.part.delta' && event.properties.field === 'text' && messages.has(event.properties.messageID)) {
        await io.emit({ type: 'assistant_delta', payload: { text: event.properties.delta } })
      } else if (event.type === 'permission.asked') {
        const request = event.properties
        const allow = spec.config.permission_mode === 'allow' || (spec.config.permission_mode === 'ask' && (await io.ask('approval', { provider: 'opencode', tool_name: request.permission, tool_input: request.metadata, detail: request.patterns.join('\n') }, inputSignal)).decision === 'allow')
        await client.permission.reply({ requestID: request.id, reply: allow ? 'once' : 'reject' }, { throwOnError: true })
      } else if (event.type === 'question.asked') {
        const request = event.properties
        const reply = await io.ask('questions', { provider: 'opencode', questions: request.questions.map((q, i) => ({ id: String(i), question: q.question, options: q.options.map((o) => o.label), allow_other: q.custom !== false })) }, inputSignal)
        if (reply.answers) await client.question.reply({ requestID: request.id, answers: request.questions.map((_, i) => [...(reply.answers?.[String(i)] ?? [])]) }, { throwOnError: true })
        else await client.question.reject({ requestID: request.id }, { throwOnError: true })
      } else if (event.type === 'session.idle') idle()
    }
    const events = await client.event.subscribe({}, { signal: streamSignal, sseMaxRetryAttempts: 0 })
    consume = (async () => {
      for await (const event of events.stream) await handle(event)
      if (!streamSignal.aborted) throw new Error('OpenCode event stream closed before completion')
    })()
    consume.catch(() => {})
    // The SDK opens SSE lazily. Wait for its handshake before sending the prompt so
    // fast tool calls and approval requests cannot arrive before we subscribe.
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([ready, consume.then(() => { throw new Error('OpenCode event stream stopped') }), new Promise<never>((_, reject) => { readyTimer = setTimeout(() => reject(new Error('OpenCode event stream startup timed out')), 15000) })])
    } finally { clearTimeout(readyTimer) }
    let model: { providerID: string; modelID: string } | undefined
    if (spec.config.model) {
      const slash = spec.config.model.indexOf('/')
      if (slash < 1 || slash === spec.config.model.length - 1) throw new Error('OpenCode models use provider/model IDs')
      model = { providerID: spec.config.model.slice(0, slash), modelID: spec.config.model.slice(slash + 1) }
    }
    const result = await Promise.race([
      (async () => {
        const response = await client.session.prompt({ sessionID, agent: 'lynx', system: spec.config.instructions, model, variant: spec.config.effort, parts: [{ type: 'text', text: spec.prompt }] }, { throwOnError: true })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OpenCode did not finish its event stream')), 15000) })])
        } finally { clearTimeout(timer) }
        return response.data
      })(),
      consume.then(() => { throw new Error('OpenCode event stream stopped') }),
    ])
    io.signal.throwIfAborted()
    for (const p of result.parts) await part(p)
    await io.emit({ type: 'usage', payload: { tokens: result.info.tokens, cost: result.info.cost } })
    const error = result.info.error
    await io.emit({ type: 'agent_completed', payload: { success: !error, ...(error ? { error: failure('message' in error.data ? String(error.data.message) : error.name) } : {}) } })
  } catch (error) {
    await io.emit({ type: 'agent_completed', payload: { success: false, error: failure(error instanceof Error ? error.message : String(error)) } })
  } finally {
    streaming.abort()
    await consume?.catch(() => {})
    await server.close()
  }
}

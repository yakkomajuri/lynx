import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION, type SessionConfigOption, type NewSessionRequest, type NewSessionResponse, type LoadSessionResponse } from '@agentclientprotocol/sdk/unstable'
import { acpLaunch, acpMode } from './acp-launch'
import { acpEvents, acpErrorMessage } from './acp-events'
import { acpPermission, acpElicitation } from './acp-input'
import { failure } from './events'
import type { AgentSpec } from './types'
import type { Session, SessionIO } from './registry'

/** One ACP process per session. Only launch settings know which provider is behind the protocol. */
export async function acpSession(first: AgentSpec, io: SessionIO): Promise<Session> {
  const launch = await acpLaunch(first, io.signal)
  const child = spawn(launch.command, launch.args, { cwd: first.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let spec = first, sessionId: string | undefined, active = false, stopping = false
  let currentMode: string | undefined
  let options: SessionConfigOption[] = []
  let events = acpEvents(io.emit)
  let queue = Promise.resolve()
  let queueError: unknown
  const app = client({ name: 'Lynx' })
    .onRequest('session/request_permission', ({ params, signal }) => {
      if (!active || params.sessionId !== sessionId) return { outcome: { outcome: 'cancelled' as const } }
      return acpPermission(params, spec, io, AbortSignal.any([signal, io.signal]))
    })
    .onRequest('elicitation/create', ({ params, signal }) => {
      if (!active || !('sessionId' in params) || params.sessionId !== sessionId) return { action: 'cancel' as const }
      return acpElicitation(params, spec, io, AbortSignal.any([signal, io.signal]))
    })
    .onNotification('session/update', ({ params }) => {
      if (sessionId && params.sessionId !== sessionId) return
      if (params.update.sessionUpdate === 'current_mode_update') currentMode = params.update.currentModeId
      if (params.update.sessionUpdate === 'config_option_update') options = params.update.configOptions
      // session/load replays old messages. Lynx already stores them, so do not duplicate them.
      if (!active) return
      queue = queue.then(() => events.update(params.update)).catch((error) => {
        queueError = error
        connection.close(error)
      })
      return queue
    })
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: 8 * 1024 * 1024 }))
  const kill = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal)
    } catch { /* already gone */ }
  }
  const close = () => {
    if (stopping) return
    stopping = true
    io.signal.removeEventListener('abort', abort)
    connection.close()
    kill('SIGTERM')
    // The runner owns the worker process group, including adapter and provider children.
    setTimeout(() => kill('SIGKILL'), 1000).unref()
  }
  const abort = () => {
    if (sessionId) void connection.agent.notify('session/cancel', { sessionId }).catch(() => {})
    // Let the agent acknowledge cancellation, but never strand a worker on an unresponsive peer.
    setTimeout(close, 1000).unref()
  }
  io.signal.addEventListener('abort', abort, { once: true })
  child.on('error', (error) => connection.close(error))
  child.stdin.on('error', (error) => connection.close(error))
  child.on('exit', (code, signal) => connection.close(new Error(`ACP adapter exited (${signal ?? code})`)))
  child.stderr.on('data', (data) => process.stderr.write(data))
  void connection.closed.then(close)
  const control = { cancellationSignal: AbortSignal.any([io.signal, AbortSignal.timeout(30000)]), stopWaitingOnCancel: true }
  try {
    io.signal.throwIfAborted()
    const init = await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'lynx', title: 'Lynx', version: '1' },
      // Providers own filesystem and shell execution and apply their own sandbox. Do not advertise
      // client-side fs/terminal capabilities that could bypass those permission checks.
      clientCapabilities: { elicitation: { form: {} } },
    }, control)
    if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported ACP version: ${init.protocolVersion}`)
    if (first.connections?.length && !init.agentCapabilities?.mcpCapabilities?.http) throw new Error('ACP adapter does not support HTTP connectors')
    if (first.config.instructions && !init.agentCapabilities?.sessionCapabilities?.systemPrompt) throw new Error('ACP adapter does not support session instructions')
    const params: NewSessionRequest = {
      cwd: first.cwd, mcpServers: launch.servers, _meta: launch.meta,
      ...(first.config.instructions ? { systemPrompt: { mode: 'append' as const, content: [{ type: 'text' as const, text: first.config.instructions }] } } : {}),
    }
    let state: NewSessionResponse | LoadSessionResponse
    if (first.provider_session_id) {
      if (!init.agentCapabilities?.loadSession) throw new Error('ACP adapter cannot resume this session; start a new session')
      sessionId = first.provider_session_id
      state = await connection.agent.request('session/load', { ...params, sessionId }, control)
    } else {
      const created = await connection.agent.request('session/new', params, control)
      sessionId = created.sessionId
      state = created
    }
    options = state.configOptions ?? options
    const modeId = acpMode(first)
    if (!state.modes?.availableModes.some((mode) => mode.id === modeId)) throw new Error(`ACP adapter does not offer the required permission mode: ${modeId}`)
    await connection.agent.request('session/set_mode', { sessionId, modeId }, control)
    currentMode = modeId
    await io.emit({ type: 'provider_session', payload: { id: sessionId } })
  } catch (error) {
    close()
    throw new Error(acpErrorMessage(error))
  }
  const id = sessionId!
  return {
    close,
    closed: connection.closed,
    async turn(next) {
      spec = next
      events = acpEvents(io.emit)
      queueError = undefined
      try {
        io.signal.throwIfAborted()
        const modeId = acpMode(next)
        if (currentMode !== modeId) {
          await connection.agent.request('session/set_mode', { sessionId: id, modeId }, {
            cancellationSignal: AbortSignal.any([io.signal, AbortSignal.timeout(15000)]), stopWaitingOnCancel: true,
          })
          currentMode = modeId
        }
        for (const [category, value] of [['model', spec.config.model], ['thought_level', spec.config.effort]] as const) {
          if (!value) continue
          const option = options.find((option) => option.category === category)
          if (!option) throw new Error(`ACP adapter does not expose ${category} selection`)
          const configured = await connection.agent.request('session/set_config_option', { sessionId: id, configId: option.id, value }, {
            cancellationSignal: AbortSignal.any([io.signal, AbortSignal.timeout(15000)]), stopWaitingOnCancel: true,
          })
          options = configured.configOptions
        }
        active = true
        const result = await connection.agent.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: spec.prompt }] })
        await queue
        if (queueError) throw queueError
        await events.finish()
        if (result.usage) await io.emit({ type: 'usage', payload: result.usage })
        const success = !io.signal.aborted && result.stopReason === 'end_turn'
        await io.emit({ type: 'agent_completed', payload: { success, result, ...(!success ? { error: failure(`ACP turn stopped: ${result.stopReason}`) } : {}) } })
      } catch (error) {
        await queue
        await events.finish()
        await io.emit({ type: 'agent_completed', payload: { success: false, error: failure(acpErrorMessage(error)) } })
        close()
        throw error
      } finally {
        active = false
      }
    },
  }
}

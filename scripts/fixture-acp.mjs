#!/usr/bin/env node
// A deterministic ACP peer. Exercises the real worker transport without a model or account.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const result = (id, value) => send({ id, result: value })
const update = (sessionUpdate, extra) => send({ method: 'session/update', params: { sessionId: 'acp-session', update: { sessionUpdate, ...extra } } })
const options = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
]
const state = () => ({ configOptions: options, modes: { currentModeId: 'default', availableModes: ['default', 'auto', 'bypassPermissions', 'read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id })) } })
let promptId, mode = 'default', modeChanges = 0
const finish = () => { result(promptId, { stopReason: 'end_turn' }); promptId = undefined }
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (process.env.ACP_FIXTURE_LOG) appendFileSync(process.env.ACP_FIXTURE_LOG, JSON.stringify({ ...m, pid: process.pid, config: process.env.CODEX_CONFIG, credentialInEnv: Object.values(process.env).some((value) => value.includes('fixture-secret')), mode }) + '\n')
  if (m.method === 'initialize') {
    if (process.env.ACP_FIXTURE_CASE === 'startup-hang') return
    if (process.env.ACP_FIXTURE_CASE === 'startup-exit') return process.exit(12)
    result(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: process.env.ACP_FIXTURE_CASE !== 'no-resume', mcpCapabilities: { http: true }, sessionCapabilities: { systemPrompt: {} } }, authMethods: [] })
  } else if (m.method === 'session/new') result(m.id, { sessionId: 'acp-session', ...state() })
  else if (m.method === 'session/load') {
    update('agent_message_chunk', { content: { type: 'text', text: 'old replay must not be stored again' } })
    result(m.id, state())
  } else if (m.method === 'session/set_mode') {
    if (++modeChanges > 1 && process.env.ACP_FIXTURE_CASE === 'mode-reset-error') return send({ id: m.id, error: { code: -32602, message: 'Cannot reset mode' } })
    mode = m.params.modeId
    result(m.id, {})
  }
  else if (m.method === 'session/set_config_option') {
    if (m.params.value === 'unsupported') return send({ id: m.id, error: { code: -32602, message: 'Unsupported model' } })
    options.find((o) => o.id === m.params.configId).currentValue = m.params.value
    result(m.id, { configOptions: options })
  } else if (m.method === 'session/cancel') {
    if (process.env.ACP_FIXTURE_CASE !== 'ignore-cancel' && promptId !== undefined) result(promptId, { stopReason: 'cancelled' })
  } else if (m.method === 'session/prompt') {
    promptId = m.id
    const prompt = m.params.prompt[0].text
    if (prompt === 'crash') return process.exit(23)
    if (prompt === 'hang') return
    if (prompt === 'enter-plan') {
      mode = 'plan'
      update('current_mode_update', { currentModeId: mode })
      return finish()
    }
    if (prompt === 'failure') return result(m.id, { stopReason: 'refusal' })
    if (prompt === 'rpc-error') return send({ id: m.id, error: { code: -32000, message: 'Not logged in' } })
    if (prompt === 'permission') return send({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'acp-session', toolCall: { toolCallId: 't', title: 'Write', rawInput: { secret: 'fixture-secret' } }, options: [{ optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'once', name: 'Once', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }] } })
    if (prompt === 'question' || prompt === 'unsupported-question' || prompt === 'secret-question') return send({ id: 'question', method: 'elicitation/create', params: { mode: 'form', sessionId: 'acp-session', message: 'Pick a target', requestedSchema: { type: 'object', required: ['target'], properties: { target: prompt === 'secret-question' ? { type: 'string', _meta: { codex: { isSecret: true } } } : prompt === 'question' ? { type: 'string', oneOf: [{ const: 'dev', title: 'Development' }] } : { type: 'object' } } } } })
    update('agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: 'Hello ' } })
    update('agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: 'world' } })
    update('tool_call', { toolCallId: 't', title: 'Run command', name: 'Bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hello' } })
    update('tool_call_update', { toolCallId: 't', status: 'completed', rawOutput: 'hello' })
    update('agent_message_chunk', { messageId: 'm2', content: { type: 'text', text: 'Done fixture-secret' } })
    update('usage_update', { used: 10, size: 100 })
    finish()
  } else if (m.id === 'permission' || m.id === 'question') {
    update('agent_message_chunk', { content: { type: 'text', text: JSON.stringify(m.result) } })
    finish()
  }
})

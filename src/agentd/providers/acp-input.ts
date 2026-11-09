import { CreateElicitationRequest, type RequestPermissionRequest, type RequestPermissionResponse, type CreateElicitationResponse } from '@agentclientprotocol/sdk/unstable'
import type { AgentSpec, InputQuestion } from './types'
import type { SessionIO } from './registry'

export async function acpPermission(request: RequestPermissionRequest, spec: AgentSpec, io: SessionIO, signal: AbortSignal): Promise<RequestPermissionResponse> {
  const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
  if (signal.aborted) return cancelled
  const mode = spec.config.permission_mode
  const allow = mode === 'allow' || ((mode === 'ask' || mode === 'auto') && (await io.ask('approval', {
    provider: spec.harness,
    tool_name: request.toolCall.name ?? request.toolCall.title ?? undefined,
    tool_input: request.toolCall.rawInput,
    detail: request.toolCall,
  }, signal)).decision === 'allow')
  if (signal.aborted) return cancelled
  // Never turn approval of one action into a persistent permission rule.
  const option = request.options.find((o) => o.kind === (allow ? 'allow_once' : 'reject_once'))
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled
}

/** Lynx's input UI supports text and choices. Unsupported/credential forms are cancelled explicitly. */
export async function acpElicitation(request: CreateElicitationRequest, spec: AgentSpec, io: SessionIO, signal: AbortSignal): Promise<CreateElicitationResponse> {
  const unsupported = async (reason: string): Promise<CreateElicitationResponse> => {
    await io.emit({ type: 'unsupported_input', payload: { provider: spec.harness, method: 'elicitation/create', reason } })
    return { action: 'cancel' }
  }
  if (signal.aborted) return { action: 'cancel' }
  if (!CreateElicitationRequest.isForm(request)) return unsupported('Use the connector authentication flow for URL requests')
  const properties = Object.entries(request.requestedSchema.properties ?? {})
  if (!properties.length) return unsupported('Empty form')
  const fields: { id: string; array: boolean; choices?: { value: string; label: string }[] }[] = []
  const questions: InputQuestion[] = []
  for (const [id, property] of properties) {
    // ACP leaves future schema types open. Narrow the supported subset before presenting it.
    const p = property as Record<string, unknown>
    if (p.type !== 'string' && p.type !== 'array') return unsupported(`Unsupported field type: ${p.type}`)
    const meta = p._meta as { isSecret?: boolean; codex?: { isSecret?: boolean } } | undefined
    if (p.format || p.writeOnly || p.secret || meta?.isSecret || meta?.codex?.isSecret) return unsupported('Credential or formatted fields require a dedicated flow')
    const items = (p.type === 'array' ? p.items : p) as Record<string, unknown> | undefined
    const titled = p.type === 'array' ? items?.anyOf : p.oneOf
    const values = items?.enum
    let choices: { value: string; label: string }[] | undefined
    if (Array.isArray(titled)) {
      if (titled.some((o) => !o || typeof o.const !== 'string' || typeof o.title !== 'string')) return unsupported('Malformed choices')
      choices = titled.map((o) => ({ value: o.const, label: o.title }))
    } else if (Array.isArray(values)) {
      if (values.some((v) => typeof v !== 'string')) return unsupported('Malformed choices')
      choices = values.map((v: string) => ({ value: v, label: v }))
    } else if (p.type === 'array') return unsupported('Array without choices')
    if (choices && new Set(choices.map((o) => o.label)).size !== choices.length) return unsupported('Ambiguous choice labels')
    fields.push({ id, array: p.type === 'array', choices })
    const title = typeof p.title === 'string' ? p.title : id
    questions.push({ id, question: [request.message, title, typeof p.description === 'string' ? p.description : ''].filter(Boolean).join('\n'), options: choices?.map((o) => o.label), allow_other: !choices })
  }
  const response = await io.ask('questions', { provider: spec.harness, method: 'elicitation/create', questions }, signal)
  if (signal.aborted || !response.answers) return { action: 'cancel' }
  const content: Record<string, string | string[]> = {}
  for (const field of fields) {
    const answers = response.answers[field.id] ?? []
    if (!answers.length) {
      if (request.requestedSchema.required?.includes(field.id)) return { action: 'cancel' }
      continue
    }
    const values = answers.map((answer) => field.choices ? field.choices.find((c) => c.label === answer)?.value : answer)
    if (values.some((value) => value === undefined) || (!field.array && values.length > 1)) return { action: 'cancel' }
    content[field.id] = field.array ? values as string[] : values[0]!
  }
  return { action: 'accept', content }
}

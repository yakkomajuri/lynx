import type { SessionUpdate, ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk/unstable'
import type { Emit } from './types'
import type { ToolInvocation, ToolKind } from './events'

const kinds: Record<string, ToolKind> = { execute: 'command', read: 'file_read', edit: 'file_change', delete: 'file_change', move: 'file_change', search: 'search', fetch: 'web', other: 'other' }
export function acpTool(call: ToolCall): ToolInvocation {
  const name = call.name ?? call.title
  return { id: call.toolCallId, kind: name.startsWith('mcp__') ? 'mcp' : (kinds[call.kind ?? 'other'] ?? 'other'), name, input: call.rawInput ?? { locations: call.locations ?? [] } }
}

/** ACP deltas are previews. Save complete messages at message/tool boundaries and at turn end. */
export function acpEvents(emit: Emit) {
  let text = '', partial = '', messageId: string | null | undefined, flushedAt = 0
  const calls = new Map<string, ToolCall>()
  const finished = new Set<string>()
  const flush = async () => {
    if (!partial) return
    const delta = partial
    partial = ''
    flushedAt = Date.now()
    await emit({ type: 'assistant_delta', payload: { text: delta } })
  }
  const finish = async () => {
    await flush()
    if (!text) return
    const complete = text
    text = ''
    await emit({ type: 'assistant_message', payload: { text: complete }, text: complete })
  }
  return {
    finish,
    async update(update: SessionUpdate) {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        if (text && update.messageId != null && messageId != null && update.messageId !== messageId) await finish()
        messageId = update.messageId
        text += update.content.text
        partial += update.content.text
        if (Date.now() - flushedAt >= 50) await flush()
        return
      }
      await flush()
      await emit({ type: 'provider_event', payload: update })
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        await finish()
        const previous = calls.get(update.toolCallId)
        const call = { ...previous, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)) } as ToolCall & ToolCallUpdate
        call.title ??= call.toolCallId
        calls.set(call.toolCallId, call)
        // Partial updates replace supplied fields; omitted input/output remains from the first event.
        if (!previous || update.rawInput !== undefined || update.name !== undefined) {
          const invocation = acpTool(call)
          await emit({ type: 'tool_invocation', payload: invocation, text: JSON.stringify(invocation.input) })
        }
        if ((call.status === 'completed' || call.status === 'failed') && !finished.has(call.toolCallId)) {
          finished.add(call.toolCallId)
          const output = call.rawOutput ?? call.content ?? ''
          await emit({ type: 'tool_result', payload: { id: call.toolCallId, output, is_error: call.status === 'failed' }, text: JSON.stringify(output) })
        }
      } else if (update.sessionUpdate === 'usage_update') {
        await emit({ type: 'usage', payload: update })
      }
    },
  }
}

/** ACP errors often put the useful provider explanation in data.details. */
export function acpErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
  const details = data && typeof data === 'object' && 'details' in data ? data.details : undefined
  return typeof details === 'string' && details ? `${message}: ${details}` : message
}

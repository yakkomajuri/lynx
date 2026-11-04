// The events every harness reports in the same shape, so the history and the chat never need to
// know which agent wrote them. Each adapter keeps the provider's own message as `provider_event`;
// these are what it means.

/** What a tool call does, whatever the harness calls the tool. */
export type ToolKind = 'command' | 'file_read' | 'file_change' | 'search' | 'web' | 'mcp' | 'agent' | 'other'

/** `tool_invocation` payload. MCP tools are named `mcp__<server>__<tool>` by every harness. */
export interface ToolInvocation {
  id: string
  kind: ToolKind
  name: string
  input: unknown
}
/** `tool_result` payload, for the invocation with the same `id`. */
export interface ToolResult {
  id: string
  output: unknown
  is_error: boolean
}

/**
 * Why a run failed, as `agent_completed` reports it in `error.code`. A usage limit or a login
 * problem is the user's to fix, not a fault in the agent, so it is told apart from the rest.
 */
export type FailureClass = 'usage_limit' | 'auth' | 'context_window' | 'provider_error'
export interface Failure {
  code: FailureClass
  message: string
  detail?: unknown
}

/** A best guess from the provider's own words, for when it gives no structured reason. */
export function classifyFailure(message: string): FailureClass {
  if (/usage limit|quota|rate.?limit|too many requests|credit balance|billing|out of credits|\b429\b/i.test(message)) return 'usage_limit'
  if (/unauthori[sz]ed|authenticat|not logged in|log ?in again|invalid api key|\b401\b|\b403\b/i.test(message)) return 'auth'
  if (/context window|context length|prompt is too long|too many tokens/i.test(message)) return 'context_window'
  return 'provider_error'
}

export const failure = (message: string, code: FailureClass = classifyFailure(message), detail?: unknown): Failure => ({
  code,
  message,
  ...(detail === undefined ? {} : { detail }),
})

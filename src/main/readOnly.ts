// Which connector tools count as read-only, and for whom. A guess from the tool's name is fine for
// display; anything that lets a tool run without asking goes by what the tool's server declared.
import type { ConnectorState, ToolInfo } from '@shared/types'

const READ_RE = /^(get|list|search|read|fetch|find|query|describe|show|lookup|count|view|export|retrieve|check|status|whoami|me)\b/i

/** A tool as an MCP server listed it: its own read-only hint, else a guess from its name. */
export const toolInfo = (t: { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }): ToolInfo => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  readOnly: t.annotations?.readOnlyHint !== undefined ? t.annotations.readOnlyHint : READ_RE.test(t.name.replace(/[-_]/g, ' ')),
  declaredReadOnly: t.annotations?.readOnlyHint === true,
})

/**
 * The read-only hint the hub gives agents, who run such tools without asking even when they must
 * ask about the rest. The app's own connectors say exactly which of their tools only read; anyone
 * else's tool is read-only only if its server declared it so, never by its name.
 */
export const agentReadOnly = (connector: Pick<ConnectorState, 'transport'>, tool: ToolInfo) => (connector.transport === 'internal' ? !!tool.readOnly : tool.declaredReadOnly === true)

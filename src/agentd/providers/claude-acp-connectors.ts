import type { ClaudeAcpAgent } from '@agentclientprotocol/claude-agent-acp'
import type { McpServer, NewSessionRequest, NewSessionResponse } from '@agentclientprotocol/sdk/unstable'

const SERVERS = 'lynx/privateMcpServers'

/** The pinned adapter constructs queries in createSession, including internal restarts (plan
 * exit, account changes). Intercept that one seam so no query ever receives MCP credentials as
 * startup options. Keep the grants in adapter memory and register them on the SDK control channel.
 * This internal seam is deliberately tested against the pinned package; recheck it on upgrades. */
export function privateClaudeConnectors(adapter: ClaudeAcpAgent) {
  const internal = adapter as unknown as {
    createSession(params: NewSessionRequest, ...args: unknown[]): Promise<NewSessionResponse>
  }
  if (typeof internal.createSession !== 'function') throw new Error('Claude ACP adapter no longer supports private connector registration')
  const create = internal.createSession.bind(adapter)
  internal.createSession = async (params, ...args) => {
    const servers = params.mcpServers.length ? params.mcpServers : (params._meta?.[SERVERS] as McpServer[] | undefined) ?? []
    const config = Object.fromEntries(servers.map((server) => {
      if (!('type' in server) || server.type !== 'http') throw new Error('Lynx Claude sessions require HTTP connectors')
      return [server.name, { type: 'http' as const, url: server.url, headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])) }]
    }))
    const result = await create({ ...params, mcpServers: [], _meta: { ...params._meta, [SERVERS]: servers } }, ...args)
    const query = adapter.sessions[result.sessionId]?.query
    if (!query) throw new Error('Claude ACP query unavailable for connector registration')
    try {
      const registered = await query.setMcpServers(config)
      if (Object.keys(registered.errors).length) throw new Error('Claude could not register the granted connectors')
    } catch (error) {
      query.close()
      throw error
    }
    return result
  }
}

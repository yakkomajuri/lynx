import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { claudeExecutable } from './claude-bin'
import { claudeProviderSettings } from './claude-settings'
import { codexBin } from './codex-bin'
import { configuredCodexServers } from './codex-config'
import { mcpName, type AgentSpec } from './types'

const require = createRequire(import.meta.url)
function claudeAdapter() {
  const here = dirname(fileURLToPath(import.meta.url))
  // Vite puts the dynamically loaded provider in out/main/chunks; standalone test builds
  // put it beside the adapter. The adapter entry itself always lives at the build root.
  const entry = [join(here, 'agentd-claude-acp.js'), join(here, '..', 'agentd-claude-acp.js')].find(existsSync)
  if (!entry) throw new Error('The Claude ACP adapter is missing from this build')
  return entry
}
export const acpMode = (spec: AgentSpec) => spec.harness === 'claude'
  ? ({ allow: 'bypassPermissions', auto: 'auto', ask: 'default', deny: 'default' } as const)[spec.config.permission_mode]
  : ({ allow: 'agent-full-access', auto: 'agent', ask: 'read-only', deny: 'read-only' } as const)[spec.config.permission_mode]

export const acpServers = (spec: AgentSpec) => (spec.connections ?? []).map((connection) => ({
  type: 'http' as const, name: mcpName(connection.id), url: connection.url,
  headers: Object.entries(connection.headers).map(([name, value]) => ({ name, value })),
}))

export function codexAcpConfig(spec: AgentSpec, configured: string[]) {
  const granted = new Set((spec.connections ?? []).map((c) => mcpName(c.id)))
  const config: Record<string, unknown> = { 'features.apps': false, 'features.plugins': false }
  // Dotted overrides survive the adapter adding its own mcp_servers table. Codex splits these
  // keys on dots (not TOML quoting), so refuse names that cannot be isolated this way.
  for (const name of new Set([...configured, ...granted])) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Cannot isolate Codex MCP server with this name: ${name}`)
    config[`mcp_servers.${name}.enabled`] = granted.has(name)
    if (granted.has(name)) config[`mcp_servers.${name}.default_tools_approval_mode`] = spec.config.permission_mode === 'allow' ? 'approve' : 'auto'
  }
  return config
}

/** Claude's ACP adapter accepts SDK startup options as metadata. Only declared read-only tools
 * are pre-approved; listing failures leave the connector behind the normal permission check. */
async function readOnlyTools(spec: AgentSpec, signal: AbortSignal) {
  return (await Promise.all((spec.connections ?? []).map(async (connection) => {
    const client = new Client({ name: 'lynx-permissions', version: '1' })
    try {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(10000)])
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: connection.headers, signal: timeout },
      }), { signal: timeout })
      const names: string[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools({ cursor }, { signal: timeout })
        for (const tool of page.tools) if (tool.annotations?.readOnlyHint === true) names.push(`mcp__${mcpName(connection.id)}__${tool.name}`)
        cursor = page.nextCursor
      } while (cursor)
      return names
    } catch { return [] } finally { await client.close().catch(() => {}) }
  }))).flat()
}

export async function acpLaunch(spec: AgentSpec, signal: AbortSignal) {
  const env = { ...process.env }
  delete env.NODE_COMPILE_CACHE
  for (const key of Object.keys(env)) if (key.startsWith('LYNX_ACP_HEADER_')) delete env[key]
  // The adapter itself is JavaScript; its provider children must not inherit Electron's Node mode.
  // The bootstrap clears it before importing either adapter.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  const servers = acpServers(spec)
  let meta: Record<string, unknown> | undefined
  if (spec.harness === 'claude') {
    const executable = claudeExecutable()
    if (!executable) throw new Error('Claude Code is not installed. Install it and sign in, then try again.')
    env.CLAUDE_CODE_EXECUTABLE = executable
    const allowedTools = spec.config.permission_mode === 'allow' ? (spec.connections ?? []).map((c) => `mcp__${mcpName(c.id)}`) : await readOnlyTools(spec, signal)
    meta = { claudeCode: { options: {
      settingSources: [], strictMcpConfig: true, settings: claudeProviderSettings(),
      allowedTools, allowDangerouslySkipPermissions: spec.config.permission_mode === 'allow',
    } } }
  } else if (spec.harness === 'codex') {
    env.CODEX_PATH = codexBin()
    env.CODEX_CONFIG = JSON.stringify(codexAcpConfig(spec, await configuredCodexServers(spec.cwd, signal)))
    env.INITIAL_AGENT_MODE = acpMode(spec)
  } else throw new Error(`No ACP launcher for ${spec.harness}`)
  signal.throwIfAborted()
  const override = process.env[spec.harness === 'claude' ? 'AGENT_CLAUDE_ACP_BIN' : 'AGENT_CODEX_ACP_BIN']
  const entry = override ?? (spec.harness === 'claude' ? claudeAdapter() : require.resolve('@agentclientprotocol/codex-acp'))
  const bootstrap = "delete process.env.ELECTRON_RUN_AS_NODE; const { pathToFileURL } = await import('node:url'); await import(pathToFileURL(process.argv[1]).href)"
  return { command: override ?? process.execPath, args: override ? [] : ['--input-type=module', '--eval', bootstrap, '--', entry], env, meta, servers }
}

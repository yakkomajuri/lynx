import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '@anthropic-ai/claude-agent-sdk'

// Claude Code runs without the user's settings files (`settingSources: []`): their hooks, plugins,
// permissions and MCP servers are not the app's to use. How it reaches the API is, though: someone on
// Bedrock, Vertex, Foundry or a gateway sets that up in the settings' `env` (CLAUDE_CODE_USE_BEDROCK,
// AWS_PROFILE, AWS_REGION...) and the credential helpers next to it, and has no Claude without them.
const PROVIDER_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'modelOverrides'] as const

/** The part of the user's own Claude Code settings that picks and signs in to the API, as flag settings. */
export function claudeProviderSettings(dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): Settings {
  let file: Record<string, unknown>
  try {
    file = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
  if (!file || typeof file !== 'object') return {}
  const out: Record<string, unknown> = {}
  const env = file.env
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const strings = Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string')
    if (strings.length) out.env = Object.fromEntries(strings)
  }
  for (const key of PROVIDER_KEYS) if (file[key] !== undefined) out[key] = file[key]
  return out as Settings
}

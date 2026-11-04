import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { claudeExecutable } from './claude-bin'
import { claudeProviderSettings } from './claude-settings'
import type { ProviderModel } from './types'
const exec = promisify(execFile)

// Claude Code takes aliases (always the newest of a family) or full model IDs. Used when the
// installed Claude Code cannot be asked.
const claudeFallback: ProviderModel[] = [
  { id: 'opus', name: 'Opus', default: true },
  { id: 'fable', name: 'Fable' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
].map((m) => ({ ...m, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }))
let claudeModels: { at: number; value: ProviderModel[] } | undefined
/** Ask Claude Code which models this account can use, with the effort levels each takes. */
async function listClaudeModels(claude: string): Promise<ProviderModel[]> {
  if (claudeModels && Date.now() - claudeModels.at < 600000) return claudeModels.value
  const abortController = new AbortController()
  // A conversation that is never sent a message: it starts Claude Code and answers questions about it.
  const idle = (async function* (): AsyncGenerator<never> {
    await new Promise((resolve) => abortController.signal.addEventListener('abort', resolve, { once: true }))
  })()
  let timer: NodeJS.Timeout | undefined
  try {
    const conversation = query({
      prompt: idle,
      options: {
        abortController,
        settingSources: [],
        // On Bedrock or Vertex the models on offer are that provider's.
        settings: claudeProviderSettings(),
        strictMcpConfig: true,
        pathToClaudeCodeExecutable: claude,
      },
    })
    const listed = await Promise.race([
      conversation.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), 8000)
      }),
    ])
    // "default" is whichever model Claude Code would pick; say which one that is instead.
    const usual = listed.find((m) => m.value === 'default')?.resolvedModel
    const value = listed
      .filter((m) => m.value !== 'default')
      .map((m) => ({
        id: m.value,
        name: m.displayName,
        description: m.description,
        ...(usual && m.resolvedModel === usual ? { default: true } : {}),
        ...(m.supportsEffort && m.supportedEffortLevels?.length
          ? { efforts: [...m.supportedEffortLevels] }
          : {}),
      }))
    if (!value.length) return claudeFallback
    claudeModels = { at: Date.now(), value }
    return value
  } catch {
    return claudeFallback
  } finally {
    clearTimeout(timer)
    abortController.abort()
  }
}
/**
 * Whether Claude Code is signed in: `claude auth status` says, as JSON. One run through Bedrock,
 * Vertex or a gateway signs in elsewhere, so it counts as signed in. Null when it cannot be told.
 */
async function claudeSignedIn(claude: string): Promise<boolean | null> {
  try {
    const { stdout } = await exec(claude, ['auth', 'status'], { timeout: 8000 })
    const status = JSON.parse(stdout) as { loggedIn?: unknown; apiProvider?: unknown }
    if (typeof status.apiProvider === 'string' && status.apiProvider !== 'firstParty') return true
    return typeof status.loggedIn === 'boolean' ? status.loggedIn : null
  } catch (e) {
    // Signed out, it says so and exits with an error; anything else is not knowing.
    const out = (e as { stdout?: string }).stdout
    try {
      const status = out ? (JSON.parse(out) as { loggedIn?: unknown }) : null
      return typeof status?.loggedIn === 'boolean' ? status.loggedIn : null
    } catch {
      return null
    }
  }
}
/** Whether Claude Code is installed and signed in, its version, and the models it offers this account. */
export async function discoverClaude() {
  const claude = claudeExecutable()
  try {
    if (!claude) throw new Error('not found')
    const { stdout } = await exec(claude, ['--version'], { timeout: 5000 })
    const [signed_in, models] = await Promise.all([claudeSignedIn(claude), listClaudeModels(claude)])
    return { available: true, version: stdout.trim(), signed_in, models }
  } catch {
    return { available: false, version: null, error: 'Claude Code executable unavailable', models: [] }
  }
}

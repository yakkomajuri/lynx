// Settings › Usage: how much of their plan Claude Code and Codex have left, asked of each one's own
// install with its own sign-in. Claude Code answers its structured `/usage` (get_usage) in a
// conversation that is never sent a message; Codex answers `account/rateLimits/read` from its
// app-server. Neither costs any usage. Answers are kept a minute, so moving about Settings does not ask again.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { claudeExecutable } from '../agentd/providers/claude-bin'
import { claudeProviderSettings } from '../agentd/providers/claude-settings'
import { codexBin } from '../agentd/providers/codex-bin'
import { claudeExtra, claudeWindows, codexExtra, codexWindows, type ProviderUsage, type UsageReport } from '../shared/usage'

const PATIENCE = 15000
const KEEP = 60000

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function claudeUsage(): Promise<ProviderUsage> {
  const base = { id: 'claude' as const, name: 'Claude Code', windows: [] }
  const claude = claudeExecutable()
  if (!claude) return { ...base, status: 'missing', detail: 'Claude Code is not installed.' }
  const abortController = new AbortController()
  // A conversation that is never sent a message: it starts Claude Code and answers questions about it.
  const idle = (async function* (): AsyncGenerator<never> {
    await new Promise((resolve) => abortController.signal.addEventListener('abort', resolve, { once: true }))
  })()
  let timer: NodeJS.Timeout | undefined
  try {
    const conversation = query({
      prompt: idle,
      options: { abortController, cwd: tmpdir(), settingSources: [], settings: claudeProviderSettings(), strictMcpConfig: true, persistSession: false, pathToClaudeCodeExecutable: claude },
    })
    const usage = await Promise.race([
      conversation.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude Code took too long to answer')), PATIENCE)
      }),
    ])
    const plan = usage.subscription_type
    if (!usage.rate_limits_available || !usage.rate_limits)
      return { ...base, status: 'none', plan, detail: plan ? 'Claude Code could not read your plan’s limits just now.' : 'Plan limits apply only when Claude Code is signed in with a Claude subscription, not an API key, Bedrock or Vertex.' }
    return { ...base, status: 'ok', plan, windows: claudeWindows(usage.rate_limits), extra: claudeExtra(usage.rate_limits) }
  } catch (e) {
    // A Claude Code from before get_usage says it does not know the request.
    if (/get_usage|unknown|unsupported|not supported/i.test(message(e))) return { ...base, status: 'unsupported', detail: 'Update Claude Code to see its usage here.' }
    return { ...base, status: 'error', detail: message(e) }
  } finally {
    clearTimeout(timer)
    abortController.abort()
  }
}

/** Codex's app-server, asked who is signed in and how much of their limits is used. */
export function codexUsage(): Promise<ProviderUsage> {
  const base = { id: 'codex' as const, name: 'Codex', windows: [] }
  return new Promise((resolve) => {
    const child = spawn(codexBin(), ['app-server'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] })
    let account: any
    const finish = (u: ProviderUsage) => {
      clearTimeout(timer)
      child.kill('SIGTERM')
      resolve(u)
    }
    const timer = setTimeout(() => finish({ ...base, status: 'error', detail: 'Codex took too long to answer' }), PATIENCE)
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n')
    child.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ENOENT' ? { ...base, status: 'missing', detail: 'Codex is not installed.' } : { ...base, status: 'error', detail: e.message }))
    child.on('exit', () => finish({ ...base, status: 'error', detail: 'Codex stopped before it answered' }))
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', (line) => {
      let m: any
      try {
        m = JSON.parse(line)
      } catch {
        return
      }
      if (m.id === 1) {
        send({ method: 'initialized', params: {} })
        send({ id: 2, method: 'account/read', params: {} })
      } else if (m.id === 2) {
        // An error is not being signed out: say what Codex said.
        if (m.error) return finish({ ...base, status: 'error', detail: String(m.error?.message ?? JSON.stringify(m.error)) })
        account = m.result?.account
        if (!account) return finish({ ...base, status: 'none', detail: 'Codex is not signed in. Sign in with ChatGPT to see your plan’s limits.' })
        if (account.type !== 'chatgpt') return finish({ ...base, status: 'none', detail: 'Plan limits apply only when Codex is signed in with ChatGPT, not an API key.' })
        send({ id: 3, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })
      } else if (m.id === 3) {
        if (m.error) {
          const said = String(m.error?.message ?? JSON.stringify(m.error))
          return finish(/method not found|unknown variant|unknown method/i.test(said) ? { ...base, status: 'unsupported', detail: 'Update Codex to see its usage here.' } : { ...base, status: 'error', detail: said })
        }
        const plan = m.result?.rateLimits?.planType ?? account?.planType ?? null
        finish({ ...base, status: 'ok', plan, windows: codexWindows(m.result), extra: codexExtra(m.result) })
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lynx_usage', title: 'Lynx', version: '1' } } })
  })
}

/** Both providers' usage, read at most once a minute unless `fresh`. */
export function makeUsage() {
  let kept: { at: number; value: Promise<UsageReport> } | undefined
  return {
    read: (fresh = false): Promise<UsageReport> => {
      if (!fresh && kept && Date.now() - kept.at < KEEP) return kept.value
      const value = Promise.all([claudeUsage(), codexUsage()]).then((providers) => ({ providers, at: Date.now() }))
      kept = { at: Date.now(), value }
      return value
    },
  }
}

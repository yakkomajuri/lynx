import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { opencodeBin } from './opencode-bin'
import type { AgentSpec } from './types'
const exec = promisify(execFile)

/** OpenCode ACP modes select agents, not permissions. Use one private agent and explicit rules.
 * Resolve the effective config again before startup: managed/remote config must not silently
 * re-enable personal connectors or override Lynx permissions. Headers only travel over ACP. */
export async function opencodeLaunch(spec: AgentSpec, env: NodeJS.ProcessEnv, readOnly: string[], signal: AbortSignal) {
  if (spec.config.permission_mode === 'auto') throw new Error('OpenCode does not offer automatic permission review')
  const command = opencodeBin()
  const readConfig = async (environment: NodeJS.ProcessEnv) => {
    const { stdout } = await exec(command, ['--pure', 'debug', 'config'], { cwd: spec.cwd, env: environment, signal, timeout: 20000, maxBuffer: 8 * 1024 * 1024 })
    return JSON.parse(stdout)
  }
  const source = await readConfig(env)
  const dir = mkdtempSync(join(tmpdir(), 'lynx-opencode-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    const permission: Record<string, string> = {
      '*': spec.config.permission_mode === 'allow' ? 'allow' : 'ask',
      read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
      // ACP has no question bridge, and a subagent must not escape the session's permission rules.
      question: 'deny', task: 'deny', plan_enter: 'deny', plan_exit: 'deny',
      ...Object.fromEntries(readOnly.map((name) => [name, 'allow'])),
    }
    const agent = { mode: 'primary', description: 'Lynx session', prompt: spec.config.instructions ?? '', permission, disable: false }
    const config = {
      ...Object.fromEntries(['provider', 'model', 'small_model', 'enabled_providers', 'disabled_providers'].filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
      autoupdate: false, share: 'disabled', default_agent: 'lynx', permission,
      mcp: Object.fromEntries(Object.keys(source.mcp ?? {}).map((name) => [name, { enabled: false }])),
      agent: { ...Object.fromEntries([...new Set(['build', 'plan', 'general', 'explore', ...Object.keys(source.agent ?? {}), ...Object.keys(source.mode ?? {})])].map((name) => [name, { disable: true }])), lynx: agent },
    }
    const path = join(dir, 'opencode.json')
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
    const isolated = { ...env, XDG_CONFIG_HOME: dir, OPENCODE_CONFIG: path, OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_PURE: 'true' }
    for (const key of ['OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION']) delete (isolated as NodeJS.ProcessEnv)[key]
    const effective = await readConfig(isolated)
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
    if (Object.values(effective.mcp ?? {}).some((server: any) => server.enabled !== false)
      || effective.default_agent !== 'lynx' || !same(effective.agent?.lynx?.permission, permission)
      || effective.agent?.lynx?.prompt !== agent.prompt || effective.agent?.lynx?.disable
      || !same(effective.permission, permission)
      || Object.entries(effective.agent ?? {}).some(([name, value]: [string, any]) => name !== 'lynx' && value.disable !== true)) {
      throw new Error('OpenCode configuration overrides Lynx connector or permission isolation')
    }
    return { command, args: ['--pure', 'acp'], env: isolated, cleanup, instructionsConfigured: true }
  } catch (error) { cleanup(); throw error }
}

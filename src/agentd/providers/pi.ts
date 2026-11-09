import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { AgentSpec } from './types'
import type { Discovered } from './registry'
const exec = promisify(execFile)

export function piBin() {
  if (process.env.AGENT_PI_BIN) return process.env.AGENT_PI_BIN
  return [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).map((dir) => join(dir, 'pi')).find((file) => {
    try { accessSync(file, constants.X_OK); return true } catch { return false }
  }) ?? 'pi'
}

export async function discoverPi(): Promise<Discovered> {
  try {
    const { stdout } = await exec(piBin(), ['--version'], { timeout: 5000, env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' } })
    const version = stdout.trim()
    const [major, minor] = version.split('.').map(Number)
    if (!(major > 1 || (major === 1 && minor >= 5))) return { available: false, version, error: 'Pi 1.5.0 or newer is required.' }
    // Accounts can come from OAuth, environment keys or custom models. ACP discovers the
    // usable models when it opens the session; installation alone does not prove sign-in.
    try { return { available: true, version, signed_in: null, models: await piModels() } }
    catch { return { available: true, version, signed_in: null, models: [], error: 'Pi could not list models. Configure Pi in a terminal.' } }
  } catch { return { available: false, version: null, error: 'Pi executable unavailable', models: [] } }
}

// This metadata request does not send a prompt or use a model account.
async function piModels(): Promise<NonNullable<Discovered['models']>> {
  return new Promise((resolve, reject) => {
    const child = spawn(piBin(), ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates'], { env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => { reject(new Error('Pi model discovery timed out')); child.kill('SIGTERM') }, 8000)
    const lines = createInterface({ input: child.stdout })
    child.on('error', reject)
    child.stdin.on('error', reject)
    child.on('exit', () => { clearTimeout(timer); lines.close(); reject(new Error('Pi model discovery ended')) })
    lines.on('line', (line) => {
      let response: any
      try { response = JSON.parse(line) } catch { return }
      if (response.id !== 'lynx-models') return
      if (!response.success) reject(new Error('Pi could not list models'))
      else resolve((response.data?.models ?? []).filter((m: any) => typeof m.provider === 'string' && typeof m.id === 'string').map((m: any) => ({ id: `${m.provider}/${m.id}`, name: `${m.provider}/${m.name ?? m.id}` })))
      clearTimeout(timer)
      child.kill('SIGTERM')
    })
    child.stdin.write(JSON.stringify({ id: 'lynx-models', type: 'get_available_models' }) + '\n')
  })
}

/** The upstream bridge has no permissions or client MCP support. Enforce the supported
 * tool sets at Pi startup, and keep personal extensions/MCP from bypassing those choices. */
export function piLaunch(spec: AgentSpec, env: NodeJS.ProcessEnv) {
  if (spec.connections?.length) throw new Error('Pi ACP does not support Lynx connectors')
  if (!['deny', 'allow'].includes(spec.config.permission_mode)) throw new Error('Pi ACP supports read-only and full-access modes; it cannot ask for approvals')
  if (process.platform === 'win32') throw new Error('Pi ACP launch currently requires macOS or Linux')
  const dir = mkdtempSync(join(tmpdir(), 'lynx-pi-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    const args = ['--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--tools', spec.config.permission_mode === 'deny' ? 'read,grep,find,ls' : 'read,bash,edit,write,grep,find,ls']
    if (spec.config.instructions) {
      const path = join(dir, 'instructions.md')
      writeFileSync(path, spec.config.instructions, { mode: 0o600 })
      args.push('--append-system-prompt', path)
    }
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    const path = join(dir, 'pi')
    writeFileSync(path, `#!/bin/sh\nexec ${[piBin(), ...args].map(quote).join(' ')} "$@"\n`, { mode: 0o700 })
    return { env: { ...env, PI_ACP_PI_COMMAND: path, PI_OFFLINE: '1', PI_TELEMETRY: '0' }, cleanup, instructionsConfigured: true }
  } catch (error) { cleanup(); throw error }
}

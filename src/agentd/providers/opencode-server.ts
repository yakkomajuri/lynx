import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { opencodeBin } from './opencode-bin'
import { mcpName, type AgentSpec } from './types'
const exec = promisify(execFile)

/** Keep model-provider settings, but only the connectors and tools Lynx grants.
 * Resolve the effective config again before startup: managed/remote config must not silently
 * re-enable personal connectors or override Lynx permissions. Headers only travel over HTTP. */
async function configuration(spec: AgentSpec, env: NodeJS.ProcessEnv, readOnly: string[], signal: AbortSignal) {
  if (spec.config.permission_mode === 'auto') throw new Error('OpenCode does not offer automatic permission review')
  const command = opencodeBin()
  const readConfig = async (environment: NodeJS.ProcessEnv) => {
    const { stdout } = await exec(command, ['--pure', 'debug', 'config'], { cwd: spec.cwd, env: environment, signal, timeout: 20000, maxBuffer: 8 * 1024 * 1024 })
    return JSON.parse(stdout)
  }
  const source = await readConfig(env)
  const dir = mkdtempSync(join(tmpdir(), 'lynx-opencode-'))
  const configDir = join(dir, 'opencode')
  mkdirSync(configDir)
  writeFileSync(join(configDir, '.gitignore'), '*\n')
  // Our hook has no dependencies. A read-only config directory prevents OpenCode from
  // installing its plugin SDK on every message.
  chmodSync(configDir, 0o500)
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    chmodSync(configDir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    const permission: Record<string, string> = {
      '*': spec.config.permission_mode === 'allow' ? 'allow' : 'ask',
      read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
      // Subagents must not escape the session permission rules.
      question: 'allow', task: 'deny', plan_enter: 'deny', plan_exit: 'deny',
      ...Object.fromEntries(readOnly.map((name) => [name, 'allow'])),
    }
    const agent = { mode: 'primary', description: 'Lynx session', permission, disable: false }
    // Native shell commands must not inherit the API control credential. No connector credentials
    // are in config or environment; the only loaded plugin is this small, local hook.
    const plugin = join(dir, 'shell-env.mjs')
    writeFileSync(plugin, 'export const Lynx = async () => ({ "shell.env": async (_, output) => { output.env.OPENCODE_SERVER_PASSWORD = "" } })', { mode: 0o600 })
    const config = {
      ...Object.fromEntries(['provider', 'model', 'small_model', 'enabled_providers', 'disabled_providers'].filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
      plugin: [pathToFileURL(plugin).href], autoupdate: false, share: 'disabled', default_agent: 'lynx', permission,
      mcp: Object.fromEntries(Object.keys(source.mcp ?? {}).map((name) => [name, { enabled: false }])),
      agent: { ...Object.fromEntries([...new Set(['build', 'plan', 'general', 'explore', ...Object.keys(source.agent ?? {}), ...Object.keys(source.mode ?? {})])].map((name) => [name, { disable: true }])), lynx: agent },
    }
    const path = join(dir, 'opencode.json')
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
    const isolated = { ...env, XDG_CONFIG_HOME: dir, OPENCODE_CONFIG: path, OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true' }
    for (const key of ['OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'OPENCODE_PURE', 'ELECTRON_RUN_AS_NODE', 'NODE_COMPILE_CACHE']) delete (isolated as NodeJS.ProcessEnv)[key]
    const effective = await readConfig(isolated)
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
    if (Object.values(effective.mcp ?? {}).some((server: any) => server.enabled !== false)
      || effective.default_agent !== 'lynx' || !same(effective.agent?.lynx?.permission, permission)
      || effective.agent?.lynx?.disable || !same(effective.plugin, config.plugin)
      || !same(effective.permission, permission)
      || Object.entries(effective.agent ?? {}).some(([name, value]: [string, any]) => name !== 'lynx' && value.disable !== true)) {
      throw new Error('OpenCode configuration overrides Lynx connector or permission isolation')
    }
    return { command, env: isolated, cleanup }
  } catch (error) { cleanup(); throw error }
}

/** One short-lived server per message: current grants and permissions are rebuilt on every run. */
export async function openCodeServer(spec: AgentSpec, signal: AbortSignal) {
  const readOnly = (await Promise.all((spec.connections ?? []).map(async (c) => {
    const client = new Client({ name: 'lynx-permissions', version: '1' })
    try {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(10000)])
      await client.connect(new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers, signal: timeout } }), { signal: timeout })
      const names: string[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools({ cursor }, { signal: timeout })
        for (const tool of page.tools) if (tool.annotations?.readOnlyHint === true && /^[\w-]+$/.test(tool.name)) names.push(`${mcpName(c.id)}_${tool.name}`)
        cursor = page.nextCursor
      } while (cursor)
      return names
    } catch { return [] } finally { await client.close().catch(() => {}) }
  }))).flat()
  const launch = await configuration(spec, { ...process.env }, readOnly, signal)
  const password = randomBytes(32).toString('hex')
  const child = spawn(launch.command, ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: spec.cwd, env: { ...launch.env, OPENCODE_SERVER_USERNAME: 'lynx', OPENCODE_SERVER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stopped = new AbortController()
  const stop = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref() }
  signal.addEventListener('abort', stop, { once: true })
  child.stderr.on('data', (data) => process.stderr.write(data))
  const closed = new Promise<void>((resolve) => {
    const finish = () => { stopped.abort(); signal.removeEventListener('abort', stop); launch.cleanup(); resolve() }
    child.on('exit', finish)
    child.on('error', finish)
  })
  try {
    signal.throwIfAborted()
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCode server startup timed out')), 20000)
      void closed.then(() => { clearTimeout(timer); reject(new Error('OpenCode server exited before startup')) })
      createInterface({ input: child.stdout }).on('line', (line) => {
        const match = /^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)\s*$/.exec(line)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
    })
    const serverSignal = AbortSignal.any([signal, stopped.signal])
    const client = createOpencodeClient({ baseUrl: url, directory: spec.cwd, headers: { Authorization: `Basic ${Buffer.from(`lynx:${password}`).toString('base64')}` }, signal: serverSignal, throwOnError: true })
    return { client, signal: serverSignal, close: async () => { stop(); await closed } }
  } catch (error) { stop(); await closed; throw error }
}

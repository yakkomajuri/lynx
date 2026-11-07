import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { codexBin } from './codex-bin'

/** ACP adds session connectors but does not disable Codex's user/project connectors. Read their
 * names before starting the adapter so startup overrides can exclude every ungranted server.
 * This probe never starts a thread or a model turn and never returns credentials to callers. */
export async function configuredCodexServers(cwd: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin(), ['-c', 'features.apps=false', '-c', 'features.plugins=false', 'app-server', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = createInterface({ input: child.stdout })
    let done = false
    const finish = (error?: Error, names: string[] = []) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      lines.close()
      child.kill('SIGTERM')
      if (error) reject(error)
      else resolve(names)
    }
    const abort = () => finish(new Error('Cancelled while reading Codex connector settings'))
    const timer = setTimeout(() => finish(new Error('Could not verify Codex connector isolation')), 10000)
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', finish)
    child.stdin.on('error', finish)
    child.on('exit', () => finish(new Error('Codex exited while reading connector settings')))
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n')
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        if (message.error) return finish(new Error('Codex could not read connector settings'))
        if (message.id === 1) {
          send({ method: 'initialized', params: {} })
          send({ id: 2, method: 'config/read', params: { cwd, includeLayers: true } })
        } else if (message.id === 2) {
          const result = message.result
          if (!result?.config) return finish(new Error('Invalid Codex connector settings'))
          const configs = [result.config, ...(result.layers ?? []).map((layer: { config: unknown }) => layer.config)]
          finish(undefined, [...new Set(configs.flatMap((config) => Object.keys(config?.mcp_servers ?? {})))])
        }
      } catch { finish(new Error('Invalid response while reading Codex connector settings')) }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lynx', version: '1' } } })
  })
}

import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { codexBin } from './codex-bin'
import type { ProviderModel } from './types'
const exec = promisify(execFile)

let codexModels: { at: number; value: ProviderModel[] } | undefined
/** Ask the installed Codex which models this account can use. Empty when it cannot be asked. */
async function listCodexModels(): Promise<ProviderModel[]> {
  if (codexModels && Date.now() - codexModels.at < 600000) return codexModels.value
  const value = await new Promise<ProviderModel[]>((resolve) => {
    const child = spawn(codexBin(), ['app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const finish = (models: ProviderModel[]) => {
      clearTimeout(timer)
      child.kill('SIGTERM')
      resolve(models)
    }
    const timer = setTimeout(() => finish([]), 8000)
    child.on('error', () => finish([]))
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line)
        if (message.id === 1)
          child.stdin.write(
            JSON.stringify({ method: 'initialized', params: {} }) +
              '\n' +
              JSON.stringify({ id: 2, method: 'model/list', params: {} }) +
              '\n',
          )
        if (message.id === 2)
          finish(
            ((message.result?.data ?? []) as any[])
              .filter((m) => !m.hidden)
              .map((m) => ({
                id: String(m.id),
                name: String(m.displayName ?? m.id),
                default: !!m.isDefault,
                ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}),
                ...(Array.isArray(m.supportedReasoningEfforts) && m.supportedReasoningEfforts.length
                  ? { efforts: m.supportedReasoningEfforts.map((e: any) => String(e.reasoningEffort)) }
                  : {}),
                ...(m.defaultReasoningEffort ? { default_effort: String(m.defaultReasoningEffort) } : {}),
              })),
          )
      } catch {
        // Ignore non-protocol output.
      }
    })
    child.stdin.write(
      JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'headless_cloud_agents', title: 'Headless Cloud Agents', version: '0.1.0' },
        },
      }) + '\n',
    )
  })
  if (value.length) codexModels = { at: Date.now(), value }
  return value
}
/** Whether Codex is signed in: `codex login status` ends well only when it is ("Logged in using ChatGPT"). */
async function codexSignedIn(): Promise<boolean | null> {
  try {
    await exec(codexBin(), ['login', 'status'], { timeout: 5000 })
    return true
  } catch (e) {
    const said = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`
    return /not logged in/i.test(said) ? false : null
  }
}
/** Whether Codex is installed and signed in, its version, and the models it offers this account. */
export async function discoverCodex() {
  let version: string
  try {
    version = (await exec(codexBin(), ['--version'], { timeout: 3000 })).stdout.trim()
  } catch {
    return { available: false, version: null, error: 'Codex executable unavailable', models: [] }
  }
  const [signed_in, models] = await Promise.all([codexSignedIn(), listCodexModels()])
  return { available: true, version, signed_in, models }
}

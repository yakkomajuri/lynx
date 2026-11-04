import { providers } from './registry'

let cached: { at: number; value: Awaited<ReturnType<typeof discover>> } | undefined
/** Each provider as the app sees it: whether it runs here, its models, and what it can do. */
async function discover() {
  return Promise.all(
    providers().map(async (p) => ({
      name: p.id,
      display_name: p.name,
      ...(await p.discover().catch(() => ({ available: false, version: null, error: `${p.name} could not be checked` }))),
      transport: p.transport,
      capabilities: p.capabilities,
      ...(p.resume_command ? { resume_command: p.resume_command } : {}),
      ...(p.login_command ? { login_command: p.login_command() } : {}),
      ...(p.sign_in ? { sign_in: 'browser' as const } : {}),
    })),
  )
}
export async function discoverProviders() {
  if (cached && Date.now() - cached.at < 10000) return cached.value
  const value = await discover()
  cached = { at: Date.now(), value }
  return value
}

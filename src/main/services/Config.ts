// Where things live, and the secrets that tie the local pieces together.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Context, Layer } from 'effect'

export interface ConfigShape {
  readonly appRoot: string
  /** The folder of built entry points (out/main): agentd.js, agentd-worker.js and lynxd.js live here. */
  readonly outDir: string
  readonly dataDir: string
  readonly workspacesDir: string
  /** Where agentd, the engine, listens, and the token callers send it. */
  readonly enginePort: number
  readonly engineToken: string
  readonly hubPort: number
  readonly hubToken: string
}

export class Config extends Context.Service<Config, ConfigShape>()('Config') {}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })

interface Persisted {
  enginePort: number
  engineToken: string
  hubPort: number
  hubToken: string
  /** Where the background service (lynxd) listens, and the token the window sends it. */
  daemonPort: number
  daemonToken: string
}

const readPersisted = (file: string): Partial<Persisted> => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** How the window reaches the background service. Made on first use; the rest of local.json is the service's and left alone. */
export async function daemonAddress(dataDir: string, fresh = false): Promise<{ port: number; token: string }> {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'local.json')
  const saved = readPersisted(file)
  if (saved.daemonPort && saved.daemonToken && !fresh) return { port: saved.daemonPort, token: saved.daemonToken }
  const next = { ...saved, daemonPort: await freePort(), daemonToken: saved.daemonToken ?? randomBytes(24).toString('base64url') }
  writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  return { port: next.daemonPort, token: next.daemonToken }
}

/** Puts the service's port back in the saved address, where an older copy of Lynx moved it from under it. */
export function keepDaemonPort(dataDir: string, port: number) {
  const file = join(dataDir, 'local.json')
  writeFileSync(file, JSON.stringify({ ...readPersisted(file), daemonPort: port }, null, 2), { mode: 0o600 })
}

/** Ports and tokens are kept across launches so stored connector URLs and OAuth redirects stay valid. */
export async function loadConfig(opts: { appRoot: string; outDir: string; dataDir: string }): Promise<ConfigShape> {
  mkdirSync(opts.dataDir, { recursive: true })
  const file = join(opts.dataDir, 'local.json')
  const saved = readPersisted(file)
  const port = async (p?: number) => (p && (await portFree(p)) ? p : await freePort())
  const next: Persisted = {
    // agentd may still be letting go of it after a crash; Agentd.ts gives it a moment.
    enginePort: saved.enginePort ?? (await freePort()),
    engineToken: saved.engineToken ?? randomBytes(24).toString('base64url'),
    hubPort: await port(saved.hubPort),
    hubToken: saved.hubToken ?? randomBytes(24).toString('base64url'),
    daemonPort: saved.daemonPort ?? (await freePort()),
    daemonToken: saved.daemonToken ?? randomBytes(24).toString('base64url'),
  }
  writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  const workspacesDir = join(opts.dataDir, 'workspaces')
  mkdirSync(workspacesDir, { recursive: true })
  return { ...next, appRoot: opts.appRoot, outDir: opts.outDir, dataDir: opts.dataDir, workspacesDir }
}

export const ConfigLive = (c: ConfigShape) => Layer.succeed(Config)(c)

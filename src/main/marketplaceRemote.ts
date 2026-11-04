// The remote marketplace, as the app reaches it: one interface, and an HTTP client for the API in
// src/shared/marketplaceApi.ts. Everything else (the Marketplace service, the window) only sees the
// interface, so another server, or another way of reaching one, slots in here.
//
// Where the server is, first that is set wins:
//   1. LYNX_MARKETPLACE_URL in the environment
//   2. "api" in <data>/marketplace.json
//   3. "marketplace": { "api" } in package.json (what an installer ships with)
// With none, only your private shelf is available. Official templates always come from the server.
// Test runs (LYNX_E2E) only use the environment. https only, except on this machine.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIMITS, ROUTES, type Account, type BundleFile, type LoginRequest, type LoginResponse, type LoginStartResponse, type PublishRequest, type TemplateBundle, type TemplateList, type TemplateSummary } from '@shared/marketplaceApi'
import { fetchable } from './updates'

/**
 * A file as it goes up: text only when it is UTF-8 that decodes and encodes back to the very same bytes,
 * base64 otherwise (images, PDFs, other encodings), so publishing never changes a byte.
 */
export function toBundleFile(path: string, data: Uint8Array): BundleFile {
  const buf = Buffer.from(data)
  const text = buf.toString('utf8')
  return !buf.includes(0) && Buffer.from(text, 'utf8').equals(buf) ? { path, text } : { path, base64: buf.toString('base64') }
}

export interface RemoteMarketplace {
  /** The base URL, as shown to the user. */
  readonly api: string
  /** Every template, all pages (up to a few thousand). */
  readonly list: () => Promise<TemplateSummary[]>
  /** One version's files (the latest without one). */
  readonly bundle: (id: string, version?: number) => Promise<TemplateBundle>
  /** Counts a fork. Best effort: a failure is ignored. */
  readonly installed: (id: string) => Promise<void>
  /** Mails a one-time code to the address; signing in then takes it. */
  readonly startLogin: (email: string) => Promise<LoginStartResponse>
  readonly login: (req: LoginRequest) => Promise<LoginResponse>
  readonly me: (token: string) => Promise<Account>
  readonly claimHandle: (token: string, handle: string) => Promise<Account>
  readonly publish: (token: string, req: PublishRequest) => Promise<TemplateSummary>
  readonly remove: (token: string, id: string) => Promise<void>
}

/** Thrown when the server says the token is no good: the app signs out. */
export class SignedOut extends Error {}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\/+$/, '') : null)

export function marketplaceApi(opts: { appRoot: string; dataDir: string; env?: NodeJS.ProcessEnv }): string | null {
  const env = opts.env ?? process.env
  const json = (file: string) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) ?? {}
    } catch {
      return {}
    }
  }
  const test = !!env.LYNX_E2E
  const api = text(env.LYNX_MARKETPLACE_URL) ?? (test ? null : (text(json(join(opts.dataDir, 'marketplace.json')).api) ?? text(json(join(opts.appRoot, 'package.json')).marketplace?.api)))
  return api && fetchable(api) ? api : null
}

export function httpRemote(api: string, fetchImpl: typeof fetch = fetch): RemoteMarketplace {
  const request = async <T>(path: string, init: { method?: string; token?: string; body?: unknown; timeout?: number } = {}): Promise<T> => {
    let res: Response
    try {
      // No redirects: one could downgrade to http, or take the token somewhere else.
      res = await fetchImpl(`${api}${path}`, {
        method: init.method ?? 'GET',
        redirect: 'error',
        headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeout ?? 20_000),
      })
    } catch (e) {
      throw new Error(`Could not reach the marketplace (${api}): ${e instanceof Error ? e.message : String(e)}`)
    }
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    if (res.status === 401 && init.token) throw new SignedOut(typeof body?.error === 'string' ? body.error : 'Signed out of the marketplace')
    if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `The marketplace answered ${res.status}`)
    return body as T
  }
  return {
    api,
    list: async () => {
      const out: TemplateSummary[] = []
      let cursor: string | undefined
      for (let page = 0; page < 50; page++) {
        const r = await request<TemplateList>(`${ROUTES.list}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        out.push(...(r.templates ?? []))
        if (!r.next) break
        cursor = r.next
      }
      return out
    },
    bundle: (id, version) => request<TemplateBundle>(ROUTES.bundle(id, version), { timeout: 60_000 }),
    installed: (id) => request(ROUTES.installs(id), { method: 'POST' }).then(() => undefined, () => undefined),
    startLogin: (email) => request<LoginStartResponse>(ROUTES.loginStart, { method: 'POST', body: { email } }),
    login: (req) => request<LoginResponse>(ROUTES.login, { method: 'POST', body: req }),
    me: (token) => request<Account>(ROUTES.me, { token }),
    claimHandle: (token, handle) => request<Account>(ROUTES.claimHandle, { method: 'POST', token, body: { handle } }),
    publish: (token, req) => {
      const bytes = req.files.reduce((n, f) => n + ('text' in f ? f.text.length : f.base64.length), 0)
      if (req.files.length > LIMITS.files || bytes > LIMITS.bytes) return Promise.reject(new Error(`Too big to publish: ${req.files.length} files, ${(bytes / 1e6).toFixed(1)} MB (at most ${LIMITS.files} files and ${LIMITS.bytes / 1e6} MB)`))
      return request<TemplateSummary>(ROUTES.publish, { method: 'POST', token, body: req, timeout: 120_000 })
    },
    remove: (token, id) => request(ROUTES.template(id), { method: 'DELETE', token }).then(() => undefined),
  }
}

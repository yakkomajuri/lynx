// API connectors: an HTTP API with no MCP server of its own, made into a connector with one tool,
// `request`. The connector holds the base URL and the key; callers give a method and a path under
// that URL, and the key is added here. It never leaves this process: requests cannot be pointed at
// another server, cannot replace the key, and anything the API echoes of it comes back redacted.
import type { ApiAuthType, ApiConfig, ApiCredentials, ConnectorSpec, ToolInfo } from '@shared/types'
import { apiTraceSummary } from './connectorTrace'

export const API_AUTH_TYPES: ApiAuthType[] = ['none', 'bearer', 'basic', 'header', 'query']
export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const TIMEOUT = 60_000
/** Larger bodies are cut, and the result says so. */
const MAX_BODY = 1024 * 1024
/** Headers worth handing back: what the body is, and how to get the next page or slow down. */
const KEEP_HEADERS = /^(content-type|link|location|retry-after|x-request-id|x-total-count|x-ratelimit-.*|ratelimit-.*|x-next-.*|x-page.*|etag)$/i

export interface ApiRequest {
  method?: string
  path?: string
  query?: Record<string, unknown>
  headers?: Record<string, unknown>
  body?: unknown
}
export interface ApiResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: unknown
  truncated?: boolean
}

/** An API connector's settings as tools and forms give them. Unset fields keep what is stored. */
export interface ApiInput {
  auth_type?: string
  auth_name?: string
  headers?: Record<string, string>
  /** The methods requests may use; empty is every one. */
  methods?: string[]
  docs_url?: string
  notes?: string
  check_path?: string
}

/** A connector's API settings, checked, from what a tool call or form gave. */
export function apiConfig(input: ApiInput, base?: ApiConfig): ApiConfig {
  const type = (input.auth_type ?? base?.auth.type ?? 'none') as ApiAuthType
  if (!API_AUTH_TYPES.includes(type)) throw new Error(`auth_type must be one of ${API_AUTH_TYPES.join(', ')}`)
  const name = (input.auth_name ?? (type === base?.auth.type ? base?.auth.name : undefined))?.trim() || (type === 'header' ? 'X-API-Key' : type === 'query' ? 'api_key' : undefined)
  if (name && !/^[A-Za-z0-9_.~-]+$/.test(name)) throw new Error(`"${name}" is not a header or parameter name`)
  const checkPath = input.check_path !== undefined ? input.check_path.trim() || undefined : base?.checkPath
  if (checkPath && !checkPath.startsWith('/')) throw new Error('check_path is a path under the base URL, starting with /')
  const docsUrl = input.docs_url !== undefined ? input.docs_url.trim() || undefined : base?.docsUrl
  if (docsUrl && !/^https?:\/\//.test(docsUrl)) throw new Error('docs_url must start with http:// or https://')
  let methods = base?.methods
  if (input.methods !== undefined) {
    if (!Array.isArray(input.methods)) throw new Error(`methods is a list, e.g. ["GET"]`)
    const given = [...new Set(input.methods.map((m) => String(m).toUpperCase()))]
    const bad = given.find((m) => !API_METHODS.includes(m))
    if (bad) throw new Error(`${bad} is not one of ${API_METHODS.join(', ')}`)
    methods = given.length && given.length < API_METHODS.length ? API_METHODS.filter((m) => given.includes(m)) : undefined
  }
  return {
    auth: { type, ...(type === 'header' || type === 'query' ? { name } : {}) },
    headers: input.headers !== undefined ? (Object.keys(input.headers).length ? input.headers : undefined) : base?.headers,
    methods,
    docsUrl,
    notes: input.notes !== undefined ? input.notes.trim() || undefined : base?.notes,
    checkPath,
  }
}

/** Whether what is stored is enough to send requests. */
export const apiHasKey = (api: ApiConfig, c?: ApiCredentials) => (api.auth.type === 'none' ? true : api.auth.type === 'basic' ? !!c?.username : !!c?.key)

/** The one tool an API connector has. Its description is what an agent knows about the API. */
export function apiTools(s: ConnectorSpec): ToolInfo[] {
  const api = s.api!
  const sent = { none: 'without authentication', bearer: 'with the key as a bearer token', basic: 'with basic auth', header: `with the key in the ${api.auth.name} header`, query: `with the key in the ${api.auth.name} query parameter` }[api.auth.type]
  return [
    {
      name: 'request',
      description: [
        `Send an HTTP request to the ${s.name} API at ${s.url}. Authentication is added for you (${sent}); never put a key in the request. Returns { status, ok, headers, body }: a JSON body parsed, anything else as text.${api.methods ? ` Only ${api.methods.join(', ')} requests are allowed.` : ''}`,
        api.notes,
        api.docsUrl && `API documentation: ${api.docsUrl}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: api.methods ?? API_METHODS, description: 'Defaults to GET' },
          path: { type: 'string', description: `Path under ${s.url}, e.g. "/v1/items". May carry a query string.` },
          query: { type: 'object', description: 'Query parameters, added to the path', additionalProperties: true },
          headers: { type: 'object', description: 'Extra request headers', additionalProperties: { type: 'string' } },
          body: { description: 'An object or array is sent as JSON; a string as it is' },
        },
        required: ['path'],
      },
      // Only GET (and HEAD) allowed is a read-only API: the app's own setting, so it can be trusted.
      readOnly: !!api.methods?.every((m) => m === 'GET' || m === 'HEAD'),
      declaredReadOnly: !!api.methods?.every((m) => m === 'GET' || m === 'HEAD'),
    },
  ]
}

/** Where a path under the base URL leads. Anything that would leave it (another host, `..` above it) is refused. */
export function apiUrl(baseUrl: string, path: string, query?: Record<string, unknown>): URL {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Give a path, e.g. "/v1/items"')
  path = path.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) throw new Error(`The path must be relative to ${baseUrl}, not a URL of its own`)
  const base = new URL(baseUrl)
  const root = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  const url = new URL(root + path.replace(/^\/+/, ''), base.origin)
  // `..` is resolved by URL: the result must still be under the base path.
  const under = `${url.pathname}/`.startsWith(root) || url.pathname === base.pathname
  if (url.origin !== base.origin || !under) throw new Error(`The path must stay under ${baseUrl}`)
  for (const [k, v] of new URLSearchParams(base.search)) if (!url.searchParams.has(k)) url.searchParams.append(k, v)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue
    for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, typeof one === 'object' ? JSON.stringify(one) : String(one))
  }
  return url
}

const basic = (c: ApiCredentials) => Buffer.from(`${c.username ?? ''}:${c.password ?? ''}`).toString('base64')

/** Every form the stored secrets could come back in, so an API that echoes one cannot hand it out. */
export function secretsOf(c?: ApiCredentials): string[] {
  const raw = [c?.key, c?.password, c?.username && c.password ? basic(c) : undefined].filter((s): s is string => !!s && s.length >= 4)
  const out = new Set<string>()
  for (const s of raw) {
    out.add(s)
    out.add(encodeURIComponent(s))
    out.add(JSON.stringify(s).slice(1, -1))
    out.add(s.replace(/\//g, '\\/'))
  }
  return [...out].sort((a, b) => b.length - a.length)
}
const redact = (text: string, secrets: string[]) => secrets.reduce((t, s) => t.split(s).join('[redacted]'), text)

/** Send one request, with the key added. Statuses of 400 and up are answers too: `ok` says which. */
export async function apiRequest(s: ConnectorSpec, req: ApiRequest, fetchImpl: typeof fetch = fetch): Promise<ApiResponse> {
  const api = s.api
  if (!api || !s.url) throw new Error(`${s.id} is not an API connector`)
  let method = String(req.method ?? 'GET').toUpperCase()
  if (!(api.methods ?? API_METHODS).includes(method)) throw new Error(api.methods && API_METHODS.includes(method) ? `${s.id} only allows ${api.methods.join(', ')} requests` : `method must be one of ${API_METHODS.join(', ')}`)
  if (!apiHasKey(api, s.credentials)) throw new Error(`${s.id} needs credentials`)
  const url = apiUrl(s.url, String(req.path ?? ''), req.query)
  const c = s.credentials ?? {}
  const authHeader = api.auth.type === 'bearer' || api.auth.type === 'basic' ? 'authorization' : api.auth.type === 'header' ? api.auth.name!.toLowerCase() : undefined
  if (api.auth.type === 'query') {
    url.searchParams.delete(api.auth.name!)
    url.searchParams.set(api.auth.name!, c.key!)
  }

  const headers = new Headers()
  for (const [k, v] of Object.entries(api.headers ?? {})) headers.set(k, v)
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    // The caller cannot replace the key, or pose as another host.
    if (v === undefined || v === null || ['host', 'cookie', authHeader].includes(k.toLowerCase())) continue
    headers.set(k, String(v))
  }
  if (api.auth.type === 'bearer') headers.set('authorization', `Bearer ${c.key}`)
  else if (api.auth.type === 'basic') headers.set('authorization', `Basic ${basic(c)}`)
  else if (api.auth.type === 'header') headers.set(api.auth.name!, c.key!)
  if (!headers.has('accept')) headers.set('accept', 'application/json, text/plain;q=0.9, */*;q=0.8')

  let body: string | undefined
  if (req.body !== undefined && req.body !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof req.body === 'string') body = req.body
    else {
      body = JSON.stringify(req.body)
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    }
  }

  // Redirects are followed only on the same server: a key must not travel to wherever one points.
  let res: Response
  let at = url
  for (let hops = 0; ; hops++) {
    res = await fetchImpl(at, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) }).catch((e: unknown) => {
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause
      throw new Error(`${s.id}: ${e instanceof Error && e.name === 'TimeoutError' ? `no answer from ${url.host} in ${TIMEOUT / 1000}s` : `could not reach ${url.host} (${cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e))})`}`)
    })
    const next = res.status >= 300 && res.status < 400 && res.headers.get('location')
    if (!next || hops >= 5) break
    const to = new URL(next, at)
    if (to.origin !== url.origin) break
    at = to
    if (res.status === 303 && method !== 'HEAD') {
      method = 'GET'
      body = undefined
      headers.delete('content-type')
    }
  }

  const secrets = secretsOf(c)
  const out: Record<string, string> = {}
  res.headers.forEach((v, k) => KEEP_HEADERS.test(k) && (out[k] = redact(v, secrets)))
  const buf = Buffer.from(await res.arrayBuffer())
  const truncated = buf.length > MAX_BODY
  const text = redact(buf.subarray(0, MAX_BODY).toString('utf8'), secrets)
  let parsed: unknown = text
  if (!truncated && /json/i.test(res.headers.get('content-type') ?? '') && text.trim()) {
    try {
      parsed = JSON.parse(text)
    } catch {
      /* not JSON after all: the text */
    }
  }
  return { status: res.status, ok: res.ok, headers: out, body: method === 'HEAD' ? null : parsed, ...(truncated ? { truncated: true } : {}) }
}

/** Whether the key works, by a GET of the connector's check path. A refused key reads as missing credentials. */
export async function apiCheck(s: ConnectorSpec, fetchImpl: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; credentials: boolean; error: string }> {
  if (!s.api?.checkPath) return { ok: true }
  try {
    const r = await apiRequest(s, { method: 'GET', path: s.api.checkPath }, fetchImpl)
    if (apiTraceSummary(r).rateLimited) return { ok: false, credentials: false, error: `The API is rate limited (${r.status}); try again later` }
    if (r.status === 401 || r.status === 403) return { ok: false, credentials: true, error: `The API refused the ${s.api.auth.type === 'basic' ? 'username and password' : 'key'} (${r.status})` }
    if (r.status >= 400) return { ok: false, credentials: false, error: `${s.api.checkPath} answered ${r.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, credentials: false, error: e instanceof Error ? e.message : String(e) }
  }
}

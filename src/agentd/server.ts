// Loopback HTTP: the `agents` MCP endpoint, and the connection admin routes Lynx's connectors use.
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { json, now } from './db'
import { ACTIVE, AppError, problem, type Store } from './store'
import type { Tools } from './tools'

const sameToken = (given: string | undefined, expected: string) => {
  const a = Buffer.from(given ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (!chunks.length) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw problem('invalid_request', 'Body must be JSON')
  }
}
const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

export function createHttp(store: Store, tools: Tools, token: string) {
  const { q } = store
  const publicConnection = (row: any) => ({ id: row.id, name: row.name, transport: 'http', enabled: !!row.enabled, revision: row.revision, health: 'unchecked', capabilities: {}, last_error: null })

  /** A connection is an MCP URL and the headers to reach it with; Lynx points them at its own hub. */
  const configure = (id: string | undefined, body: any) => {
    if (!body || typeof body.name !== 'string' || !body.name) throw problem('invalid_request', 'name is required')
    if (body.spec?.transport !== 'http' || typeof body.spec.url !== 'string') throw problem('invalid_request', 'Only HTTP connections are supported')
    let url: URL
    try {
      url = new URL(body.spec.url)
    } catch {
      throw problem('invalid_request', 'Invalid MCP URL')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search) throw problem('invalid_request', 'MCP URL must be HTTP(S), with credentials provided separately and no query string')
    const headers = body.credentials?.headers
    if (headers !== undefined && (typeof headers !== 'object' || Object.values(headers).some((v) => typeof v !== 'string'))) throw problem('invalid_request', 'credentials.headers must map names to strings')
    return store.tx(() => {
      const at = now()
      if (id) {
        const existing = q('SELECT * FROM connections WHERE id = ?').get(id)
        if (!existing) throw problem('not_found', 'Connection not found', 404)
        q('UPDATE connections SET name = ?, url = ?, headers = ?, enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(
          body.name, url.href, headers ? json(headers) : existing.headers, body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0, at, id,
        )
      } else {
        id = randomUUID()
        q('INSERT INTO connections (id, name, url, headers, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, body.name, url.href, json(headers ?? {}), body.enabled === false ? 0 : 1, at, at)
      }
      return publicConnection(q('SELECT * FROM connections WHERE id = ?').get(id))
    })
  }

  const mcp = async (req: IncomingMessage, res: ServerResponse) => {
    const server = new Server({ name: 'lynx-agents', version: '0.2.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() as any }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const result = await tools.call(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (e) {
        const error = e instanceof AppError ? { code: e.code, message: e.message } : { code: 'internal_error', message: 'Internal server error' }
        if (!(e instanceof AppError)) console.error('[agentd]', request.params.name, e)
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] }
      }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => void server.close())
    await server.connect(transport)
    await transport.handleRequest(req, res, await readBody(req))
  }

  return createServer((req, res) => {
    // Loopback names only, so a web page cannot reach this through DNS rebinding.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return void res.writeHead(403).end()
    if (!sameToken(req.headers.authorization, `Bearer ${token}`)) return void send(res, 401, { error: { code: 'unauthorized', message: 'Missing or wrong token' } })
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = async () => {
      if (path === '/mcp') {
        if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end()
        return mcp(req, res)
      }
      const one = path.match(/^\/v1\/(?:admin\/)?connections\/([0-9a-f-]{36})$/)
      if (req.method === 'GET' && one) {
        const row = q('SELECT * FROM connections WHERE id = ?').get(one[1])
        return row ? send(res, 200, publicConnection(row)) : send(res, 404, { error: { code: 'not_found', message: 'Connection not found' } })
      }
      if (req.method === 'POST' && path === '/v1/admin/connections') return send(res, 201, configure(undefined, await readBody(req)))
      if (req.method === 'PUT' && one && path.startsWith('/v1/admin/')) return send(res, 200, configure(one[1], await readBody(req)))
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true })
      // What is under way, so the background service knows when it can be replaced and whether to keep the Mac awake.
      if (req.method === 'GET' && path === '/v1/admin/activity') {
        const count = (sql: string) => Number((q(sql).get() as { n: number }).n)
        return send(res, 200, {
          runs: count(`SELECT count(*) AS n FROM runs WHERE status IN (${ACTIVE.map((s) => `'${s}'`).join(', ')})`),
          processes: count("SELECT count(*) AS n FROM processes WHERE status IN ('queued', 'starting', 'running', 'cancelling')"),
        })
      }
      send(res, 404, { error: { code: 'not_found', message: 'No such route' } })
    }
    route().catch((e) => {
      if (res.headersSent) return void res.destroy()
      if (e instanceof AppError) return send(res, e.status, { error: { code: e.code, message: e.message } })
      console.error('[agentd]', e)
      send(res, 500, { error: { code: 'internal_error', message: 'Internal server error' } })
    })
  })
}

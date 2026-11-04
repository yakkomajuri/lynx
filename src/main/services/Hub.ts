// A small local HTTP server with two jobs: serve every connector as an MCP endpoint (that is how
// agents started by the engine reach them, with the credentials staying here), and catch OAuth
// redirects.
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context, Effect, Layer } from 'effect'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { OWNER_LABEL } from '@shared/types'
import { agentReadOnly } from '../readOnly'
import { Config } from './Config'
import { Connectors } from './Connectors'
import { Events } from './Events'

export class Hub extends Context.Service<Hub, { readonly url: string }>()('Hub') {}

/** The ownership label says which workspace started a conversation. Only the app's bridge sets it; an agent cannot claim one. */
const withoutOwner = (args: Record<string, unknown>) => {
  const strip = (o: unknown): unknown => {
    if (!o || typeof o !== 'object') return o
    if (Array.isArray(o)) return o.map(strip)
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => k !== OWNER_LABEL).map(([k, v]) => [k, strip(v)]))
  }
  return strip(args) as Record<string, unknown>
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const digest = (s: string) => createHash('sha256').update(s).digest()
const sameToken = (given: string | undefined, expected: string) => !!given && timingSafeEqual(digest(given), digest(expected))
/** Text in these pages can come from a query string or an upstream error: always escaped. */
const page = (rawTitle: string, rawBody: string, title = esc(rawTitle), body = esc(rawBody)) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f5f2;color:#1d1c1a"><div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p style="color:#6b6964">${body}</p></div>`

export const HubLive = Layer.effect(Hub)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const connectors = yield* Connectors
    const events = yield* Events

    const readBody = async (req: IncomingMessage) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
    }

    const mcp = async (req: IncomingMessage, res: ServerResponse, id: string) => {
      if (!sameToken(req.headers.authorization, `Bearer ${cfg.hubToken}`)) {
        res.writeHead(401).end()
        return
      }
      if (!connectors.get(id)) {
        res.writeHead(404).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end()
        return
      }
      const server = new Server({ name: `lynx-${id}`, version: '0.1.0' }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        let c = connectors.get(id)!
        if (c.status !== 'connected') c = await Effect.runPromise(connectors.connect(id)).catch(() => c)
        return { tools: c.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema as any) ?? { type: 'object' }, annotations: { readOnlyHint: agentReadOnly(c, t) } })) }
      })
      server.setRequestHandler(CallToolRequestSchema, async (request) =>
        Effect.runPromise(connectors.callRaw(id, request.params.name, withoutOwner((request.params.arguments ?? {}) as Record<string, unknown>), { by: 'agent', depth: 0 })).catch((e) => ({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] })) as any,
      )
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.once('close', () => void server.close())
      await server.connect(transport)
      await transport.handleRequest(req, res, await readBody(req))
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // Only requests addressed to this machine by its loopback name are served (no DNS rebinding).
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) {
        res.writeHead(403).end()
        return
      }
      const done = (status: number, html: string) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(html)
      const route = async () => {
        const m = url.pathname.match(/^\/mcp\/([a-z0-9_-]+)$/)
        if (m) return mcp(req, res, m[1]!)
        if (url.pathname === '/oauth/callback') {
          const code = url.searchParams.get('code')
          const state = url.searchParams.get('state')
          if (!code || !state) return done(400, page('Authorization failed', url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'No code was returned.'))
          const c = await Effect.runPromise(connectors.finishAuth(state, code))
          Effect.runSync(events.publish({ t: 'toast', tone: c.status === 'connected' ? 'good' : 'bad', text: c.status === 'connected' ? `${c.name} connected` : `${c.name}: ${c.error ?? c.status}` }))
          return done(200, page(c.status === 'connected' ? `${c.name} is connected` : 'Almost there', c.status === 'connected' ? 'You can close this tab and go back to Lynx.' : (c.error ?? c.status)))
        }
        res.writeHead(404).end()
      }
      route().catch((e) => {
        console.error('[hub]', e)
        if (!res.headersSent) done(500, page('Something went wrong', e instanceof Error ? e.message : String(e)))
        else res.destroy()
      })
    })
    yield* Effect.promise(() => new Promise<void>((resolve, reject) => server.once('error', reject).listen(cfg.hubPort, '127.0.0.1', resolve)))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.closeAllConnections()
        server.close()
      }),
    )
    return Hub.of({ url: `http://127.0.0.1:${cfg.hubPort}` })
  }),
)

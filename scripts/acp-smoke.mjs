// Optional live ACP smoke test: uses signed-in local agents and model quota.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
mkdirSync('node_modules/.cache', { recursive: true })
const out = mkdtempSync(join(process.cwd(), 'node_modules/.cache/acp-live-'))
const cwd = mkdtempSync(join(tmpdir(), 'lynx-acp-live-'))
await build({ entryPoints: ['src/agentd/providers/acp.ts'], outfile: join(out, 'client.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { acpSession } = await import(join(out, 'client.mjs'))
let pings = 0
const hub = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer acp-live-test-token') { res.writeHead(401).end(); return }
  const server = new McpServer({ name: 'acp-smoke', version: '1' })
  server.registerTool('ping', { description: 'Returns ACP OK for the transport test.', annotations: { readOnlyHint: true } }, async () => {
    pings++
    return { content: [{ type: 'text', text: 'ACP OK' }] }
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  res.on('close', () => { void transport.close(); void server.close() })
  await transport.handleRequest(req, res)
})
await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve))
try {
  for (const harness of ['claude', 'codex']) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 120000)
    let live, id, outcome
    const messages = []
    const io = {
      signal: abort.signal, secrets: () => [], ask: async () => ({ decision: 'deny' }),
      emit: async (event) => {
        if (event.type === 'provider_session') id = event.payload.id
        if (event.type === 'agent_completed') outcome = event.payload
        if (event.type === 'assistant_message') messages.push(event.text)
      },
    }
    const spec = { harness, cwd, prompt: 'Call the granted connection_smoke ping tool, then reply with exactly ACP OK.', provider_session_id: null, connections: [{ id: 'smoke', url: `http://127.0.0.1:${hub.address().port}/mcp`, headers: { authorization: 'Bearer acp-live-test-token' } }], config: { permission_mode: 'deny', instructions: 'This is a transport smoke test. Use only the granted ping tool when asked. Do not change files.' } }
    const turn = async (next, expected) => {
      outcome = undefined
      messages.length = 0
      await live.turn(next)
      assert.equal(outcome?.success, true, JSON.stringify(outcome))
      assert(messages.some((message) => message.includes(expected)), `Expected ${expected}`)
    }
    try {
      const before = pings
      live = await acpSession(spec, io)
      await turn(spec, 'ACP OK')
      assert(pings > before, `${harness} did not call the authenticated connector`)
      assert(id)
      const continued = { ...spec, provider_session_id: id, config: { ...spec.config, model: harness === 'claude' ? 'sonnet' : process.env.ACP_SMOKE_CODEX_MODEL || 'gpt-6-astra', effort: 'low' } }
      await turn({ ...continued, prompt: 'Reply with exactly WARM OK. Do not use tools.' }, 'WARM OK')
      live.close()
      live = await acpSession(continued, io)
      await turn({ ...continued, prompt: 'Reply with exactly RESUME OK. Do not use tools.' }, 'RESUME OK')
      console.log(`ok: ${harness} authenticated connector, new session, warm turn, model/effort and resume`)
    } finally { live?.close(); clearTimeout(timer) }
  }
} finally {
  hub.closeAllConnections()
  await new Promise((resolve) => hub.close(resolve))
  rmSync(out, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

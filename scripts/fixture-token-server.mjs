// A local MCP server over HTTP that turns away requests without an Authorization header, so the
// e2e run can take a connector from "needs a token" to connected. Prints its URL once listening.
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const http = createServer(async (req, res) => {
  // No OAuth here (no metadata, no /register): only a static token works.
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end()
    return
  }
  if (!req.headers.authorization) {
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
    return
  }
  const server = new McpServer({ name: 'fixture-token', version: '0.0.1' })
  server.registerTool('secret_word', { description: 'The secret word', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pelican' }] }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => void transport.close())
  await server.connect(transport)
  const chunks = []
  for await (const c of req) chunks.push(c)
  await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined)
})
http.listen(Number(process.env.FIXTURE_PORT ?? 0), '127.0.0.1', () => console.log(`http://127.0.0.1:${http.address().port}/mcp`))

// A tiny local MCP server used by the e2e run: one tool that returns an MCP-UI resource whose
// button calls a second tool on the same server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

let count = 0
const server = new McpServer({ name: 'fixture-ui', version: '0.0.1' })
server.registerTool('increment', { description: 'Add to the counter', inputSchema: { by: z.number().default(1) } }, async ({ by }) => {
  count += by
  return { content: [{ type: 'text', text: JSON.stringify({ count }) }] }
})
server.registerTool('show_counter', { description: 'An interactive counter', inputSchema: {} }, async () => ({
  content: [
    {
      type: 'resource',
      resource: {
        uri: 'ui://fixture/counter',
        mimeType: 'text/html',
        text: `<body style="font:14px system-ui;margin:16px"><button id="go">Increment through the connector</button> <span id="out">count: ${count}</span>
<script>
  let n = 0
  addEventListener('message', (e) => { if (e.data?.type === 'ui-message-response') document.getElementById('out').textContent = 'count: ' + e.data.payload.response.count })
  document.getElementById('go').onclick = () => parent.postMessage({ type: 'tool', messageId: 'm' + ++n, payload: { toolName: 'increment', params: { by: 2 } } }, '*')
</script></body>`,
      },
    },
  ],
}))
await server.connect(new StdioServerTransport())

// The installed OpenCode CLI with local synthetic model and MCP servers. No model account or quota.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
mkdirSync('node_modules/.cache', { recursive: true })
const out = mkdtempSync(join(process.cwd(), 'node_modules/.cache/opencode-'))
const cwd = mkdtempSync(join(tmpdir(), 'lynx-opencode-test-'))
const built = process.argv.includes('--built')
if (!built) await build({ entryPoints: ['src/agentd/providers/opencode.ts'], outfile: join(out, 'client.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
const entry = built ? join(process.cwd(), 'out/main/chunks', readdirSync('out/main/chunks').find((name) => /^opencode-[\w-]{8}\.js$/.test(name))) : join(out, 'client.mjs')
const { runOpenCode } = await import(entry)
let reads = 0, writes = 0, approvals = 0, requests = 0, instructed = 0, revoked = false
const seenModels = new Set()
let modelError
const model = createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests++
    seenModels.add(body.model)
    assert.equal(req.headers.authorization, 'Bearer fixture-model-key')
    const sessionPrompt = Boolean(body.tools?.length) && JSON.stringify(body.messages).includes('Lynx instruction sentinel')
    if (sessionPrompt) instructed++
    const lastUser = body.messages.findLastIndex((m) => m.role === 'user')
    const prompt = JSON.stringify(body.messages[lastUser]?.content)
    const used = body.messages.slice(lastUser + 1).some((m) => m.role === 'tool')
    if (sessionPrompt && prompt.includes('revoked connector')) {
      assert(!body.tools.some((t) => t.function.name.startsWith('connection_smoke_')))
      revoked = true
    }
    const name = !sessionPrompt ? undefined : prompt.includes('check shell') ? 'bash' : prompt.includes('write connector') ? 'write' : prompt.includes('read connector') ? 'read' : undefined
    const tool = name && !used ? body.tools?.find((t) => t.function.name === (name === 'bash' ? 'bash' : `connection_smoke_${name}`)) : undefined
    if (name && !used) assert(tool, `Missing connector tool ${name}: ${JSON.stringify(body.tools?.map((t) => t.function.name))}`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (tool) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(name === 'bash' ? { command: 'printf "control=%s\\n" "$OPENCODE_SERVER_PASSWORD"', description: 'Check shell environment' } : {}) } }] })
      send({}, 'tool_calls')
    } else {
      send({ role: 'assistant', content: 'NATIVE OK' })
      send({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  } catch (error) { modelError = error; res.writeHead(500).end(); controller.abort(error) }
})
const hub = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer fixture-connector-key') { res.writeHead(401).end(); return }
  const server = new McpServer({ name: 'smoke', version: '1' })
  server.registerTool('read', { annotations: { readOnlyHint: true } }, async () => { reads++; return { content: [{ type: 'text', text: 'Read OK' }] } })
  server.registerTool('write', {}, async () => { writes++; return { content: [{ type: 'text', text: 'Write OK' }] } })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  res.on('close', () => { void transport.close(); void server.close() })
  await transport.handleRequest(req, res)
})
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve))
await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve))
const previousEnv = { ...process.env }
// Keep all test sessions and accounts separate from the user's OpenCode state.
for (const name of ['DATA', 'CONFIG', 'CACHE', 'STATE']) {
  process.env[`XDG_${name}_HOME`] = join(cwd, name.toLowerCase())
  mkdirSync(process.env[`XDG_${name}_HOME`], { recursive: true })
}
process.env.OPENCODE_DB = join(cwd, 'opencode.sqlite')
process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true'
process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: 'fixture/model-a', enabled_providers: ['fixture'],
  provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Fixture', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-model-key' }, models: { 'model-a': { name: 'A', limit: { context: 128000, output: 4096 } }, 'model-b': { name: 'B', limit: { context: 128000, output: 4096 } } } } },
})
let id, outcome
const text = [], invocations = [], results = []
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 120000)
const io = {
  signal: controller.signal, secrets: () => [],
  ask: async () => { approvals++; return { decision: 'deny' } },
  emit: async (e) => {
    if (e.type === 'provider_session') id = e.payload.id
    if (e.type === 'agent_completed') outcome = e.payload
    if (e.type === 'tool_result') results.push(e.payload)
    if (e.type === 'tool_invocation') invocations.push(e.payload)
    if (e.type === 'assistant_message') text.push(e.text)
  },
}
const spec = { harness: 'opencode', cwd, prompt: 'read connector', provider_session_id: null, connections: [{ id: 'smoke', url: `http://127.0.0.1:${hub.address().port}/mcp`, headers: { authorization: 'Bearer fixture-connector-key' } }], config: { model: 'fixture/model-a', permission_mode: 'ask', instructions: 'Lynx instruction sentinel' } }
const turn = async (next, expectText = true) => {
  outcome = undefined; text.length = 0
  await runOpenCode(next, io)
  assert.ifError(modelError)
  assert.equal(outcome?.success, true, JSON.stringify(outcome))
  if (expectText) assert(text.some((line) => line.includes('NATIVE OK')))
}
try {
  await turn(spec)
  assert(instructed > 0, 'Session instructions must reach the model')
  assert.equal(reads, 1)
  assert(invocations.some((tool) => tool.kind === 'mcp' && tool.name === 'mcp__connection_smoke__read'))
  assert.equal(approvals, 0)
  await turn({ ...spec, provider_session_id: id, prompt: 'write connector' }, false)
  assert.equal(approvals, 1)
  assert.equal(writes, 0)
  const resumed = { ...spec, provider_session_id: id, config: { ...spec.config, model: 'fixture/model-b' } }
  await turn({ ...resumed, prompt: 'next message' })
  assert(seenModels.has('model-b'), 'The next turn must use the selected model')
  await turn({ ...resumed, prompt: 'resumed message' })
  for (const mode of ['deny', 'allow']) {
    const next = { ...spec, config: { ...spec.config, permission_mode: mode }, prompt: 'write connector' }
    await turn(next, mode === 'allow')
    assert.equal(approvals, 1, 'deny/allow must not ask the user')
    assert.equal(writes, mode === 'allow' ? 1 : 0)
  }
  await turn({ ...spec, provider_session_id: id, connections: [], prompt: 'revoked connector' })
  assert(revoked)
  await turn({ ...spec, prompt: 'check shell', config: { ...spec.config, permission_mode: 'allow' } })
  assert(results.some((r) => !r.is_error && /control=\s*$/.test(r.output)), 'shell must not inherit the server credential')
  console.log('ok: native OpenCode instructions, authenticated read-only connector, three permission modes, tool cards, model switch, resume, revocation and shell credential isolation')
} finally {
  clearTimeout(timer)
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
  Object.assign(process.env, previousEnv)
  for (const server of [model, hub]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  rmSync(out, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true })
}

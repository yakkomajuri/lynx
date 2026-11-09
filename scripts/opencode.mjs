// Exercise the real SDK against a native HTTP/SSE CLI fixture.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
mkdirSync('node_modules/.cache', { recursive: true })
const out = mkdtempSync(join(process.cwd(), 'node_modules/.cache/opencode-unit-'))
const cwd = mkdtempSync(join(tmpdir(), 'lynx-opencode-unit-'))
await build({ entryPoints: ['src/agentd/providers/opencode.ts', 'src/agentd/providers/opencode-discover.ts'], outdir: out, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, packages: 'external', logLevel: 'silent' })
const { runOpenCode } = await import(join(out, 'opencode.mjs'))
const { discoverOpenCode } = await import(join(out, 'opencode-discover.mjs'))
const previousEnv = { ...process.env }
process.env.AGENT_OPENCODE_BIN = join(process.cwd(), 'scripts/fixture-opencode.mjs')
process.env.OPENCODE_FIXTURE_LOG = join(cwd, 'requests.jsonl')
const requests = () => readFileSync(process.env.OPENCODE_FIXTURE_LOG, 'utf8').trim().split('\n').map(JSON.parse)
const hub = createServer(async (req, res) => {
  const server = new McpServer({ name: 'fixture', version: '1' })
  server.registerTool('read', { annotations: { readOnlyHint: true } }, async () => ({ content: [] }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  res.on('close', () => { void transport.close(); void server.close() })
  await transport.handleRequest(req, res)
})
await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve))
const spec = { harness: 'opencode', cwd, provider_session_id: null, prompt: 'hello', config: { model: 'fixture/model-a', effort: 'high', instructions: 'instructions sentinel', permission_mode: 'ask' }, connections: [{ id: 'smoke', url: `http://127.0.0.1:${hub.address().port}/mcp`, headers: { authorization: 'Bearer connector-secret' } }] }
const turn = async (next = spec, answer = { decision: 'deny' }, cancel = false) => {
  const events = [], asks = [], controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    await runOpenCode(next, { signal: controller.signal, secrets: () => ['connector-secret'], emit: async (event) => { events.push(event); if (cancel && event.type === 'provider_session') setTimeout(() => controller.abort(), 100) }, ask: async (kind, data, signal) => { asks.push({ kind, data }); if (answer === 'wait') await new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }); return answer } })
    return { events, asks, result: events.findLast((e) => e.type === 'agent_completed')?.payload }
  } finally { clearTimeout(timer) }
}
try {
  const discovered = await discoverOpenCode()
  assert.equal(discovered.available, true)
  assert.equal(discovered.signed_in, null)
  assert.deepEqual(discovered.models.map((m) => m.id), ['fixture/model-a', 'fixture/model-b'])
  const first = await turn()
  assert.equal(first.result.success, true)
  assert.deepEqual(first.events.filter((e) => e.type === 'assistant_message').map((e) => e.text), ['hello'])
  assert.equal(first.events.filter((e) => e.type === 'assistant_delta').length, 1)
  const card = first.events.find((e) => e.type === 'tool_invocation')
  assert.equal(card.payload.name, 'mcp__connection_smoke__read')
  assert.equal(card.payload.kind, 'mcp')
  assert.equal(first.events.filter((e) => e.type === 'tool_invocation').length, 1)
  assert.equal(first.events.filter((e) => e.type === 'tool_result').length, 1)
  const initial = requests()[0]
  assert.equal(initial.prompt.system, spec.config.instructions)
  assert.deepEqual(initial.prompt.model, { providerID: 'fixture', modelID: 'model-a' })
  assert.equal(initial.prompt.variant, 'high')
  assert.equal(initial.connections.connection_smoke.headers.authorization, 'Bearer connector-secret')
  assert(!existsSync(initial.configPath), 'temporary config must be removed')
  const resumed = { ...spec, provider_session_id: 'ses_fixture', connections: [] }
  assert.equal((await turn(resumed)).result.success, true)
  const revoked = requests().at(-1)
  assert.notEqual(revoked.pid, initial.pid, 'a resumed message must start a fresh server')
  assert.deepEqual(revoked.connections, {}, 'revoked grants must be absent')
  await turn({ ...resumed, connections: [{ ...spec.connections[0], headers: { authorization: 'Bearer rotated-secret' } }], config: { ...spec.config, model: 'fixture/model-b' } })
  assert.equal(requests().at(-1).connections.connection_smoke.headers.authorization, 'Bearer rotated-secret')
  assert.equal(requests().at(-1).prompt.model.modelID, 'model-b')
  for (const mode of ['ask', 'deny', 'allow']) {
    for (const decision of ['deny', 'allow']) {
      const run = await turn({ ...spec, prompt: 'approval', config: { ...spec.config, permission_mode: mode } }, { decision })
      assert.equal(run.result.success, true)
      assert.equal(run.asks.length, mode === 'ask' ? 1 : 0)
      assert.equal(requests().at(-1).approval.reply, mode === 'allow' || (mode === 'ask' && decision === 'allow') ? 'once' : 'reject')
    }
  }
  const question = await turn({ ...spec, prompt: 'question' }, { answers: { 0: ['custom answer'] } })
  assert.equal(question.asks[0].kind, 'questions')
  assert.equal(question.asks[0].data.questions[0].allow_other, true)
  assert.deepEqual(requests().at(-1).question.answers, [['custom answer']])
  await turn({ ...spec, prompt: 'question' }, {})
  assert.deepEqual(requests().at(-1).question, {})
  assert.equal((await turn({ ...spec, prompt: 'error' })).result.error.code, 'usage_limit')
  // Repeat the shutdown cases: closing SSE while fetch is reading used to race.
  for (let i = 0; i < 3; i++) {
    assert.equal((await turn({ ...spec, prompt: 'cancel' }, {}, true)).result.success, false)
    assert.equal((await turn({ ...spec, prompt: 'crash' })).result.success, false)
  }
  const crashedAt = Date.now()
  assert.equal((await turn({ ...spec, prompt: 'approval crash' }, 'wait')).result.success, false)
  assert(Date.now() - crashedAt < 5000, 'server failure must cancel pending input without waiting for the run timeout')
  process.env.OPENCODE_FIXTURE_MCP_FAIL = '1'
  assert.match((await turn()).result.error.message, /could not connect/)
  delete process.env.OPENCODE_FIXTURE_MCP_FAIL
  process.env.OPENCODE_FIXTURE_CONFLICT = '1'
  await assert.rejects(turn(), /overrides Lynx/)
  delete process.env.OPENCODE_FIXTURE_CONFLICT
  await assert.rejects(turn({ ...spec, config: { ...spec.config, permission_mode: 'auto' } }), /automatic permission/)
  process.env.AGENT_OPENCODE_BIN = join(cwd, 'missing')
  assert.equal((await discoverOpenCode()).available, false)
  console.log('ok: native OpenCode discovery, streaming, resume, grant changes, approvals, questions, failures, cancellation and config isolation')
} finally {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
  Object.assign(process.env, previousEnv)
  hub.closeAllConnections(); await new Promise((resolve) => hub.close(resolve))
  rmSync(out, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true })
}

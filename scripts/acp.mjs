// ACP contract checks through the real worker, over stdio, without paid model requests.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

mkdirSync('node_modules/.cache', { recursive: true })
const dir = mkdtempSync(join(process.cwd(), 'node_modules/.cache/acp-'))
await build({ entryPoints: ['src/agentd/providers/worker.ts'], outfile: join(dir, 'worker.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
const hub = createServer(async (req, res) => {
  const server = new McpServer({ name: 'fixture', version: '1' })
  server.registerTool('read', { annotations: { readOnlyHint: true } }, async () => ({ content: [] }))
  server.registerTool('get_or_create', {}, async () => ({ content: [] }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  res.on('close', () => { void transport.close(); void server.close() })
  await transport.handleRequest(req, res)
})
await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve))
const workers = new Set()
const fixture = join(process.cwd(), 'scripts/fixture-acp.mjs')
let count = 0
function worker(harness, config = {}, extra = {}, fixtureCase = '') {
  const log = join(dir, `log-${count++}.jsonl`)
  const spec = { harness, cwd: dir, prompt: 'hello', provider_session_id: null, warm: true, connections: [{ id: 'ab', url: `http://127.0.0.1:${hub.address().port}/mcp`, headers: { authorization: 'Bearer fixture-secret' } }], config: { permission_mode: 'ask', instructions: 'Test instructions', model: 'model-a', effort: 'high', ...config }, ...extra }
  const child = spawn(process.execPath, [join(dir, 'worker.mjs')], { env: { ...process.env, AGENT_CLAUDE_BIN: process.execPath, AGENT_CODEX_BIN: join(process.cwd(), 'scripts/fixture-codex.mjs'), AGENT_CLAUDE_ACP_BIN: fixture, AGENT_CODEX_ACP_BIN: fixture, AGENT_OPENCODE_ACP_BIN: fixture, AGENT_OPENCODE_BIN: join(process.cwd(), 'scripts/fixture-opencode.mjs'), ACP_FIXTURE_LOG: log, ACP_FIXTURE_CASE: fixtureCase }, stdio: ['pipe', 'pipe', 'pipe'] })
  workers.add(child)
  const events = []
  let stderr = '', ended = false, pending
  const closed = new Promise((resolve) => child.on('exit', (code) => { ended = true; workers.delete(child); resolve(code); pending?.() }))
  child.stderr.on('data', (data) => { stderr += data })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const event = JSON.parse(line)
    events.push(event)
    if (event.type === 'input_request') send({ type: 'input_response', id: event.payload.id, response: event.payload.kind === 'approval' ? { decision: 'allow' } : { answers: { target: ['Development'] } } })
    pending?.()
  })
  child.stdin.on('error', () => {})
  function send(value) { child.stdin.write(JSON.stringify(value) + '\n') }
  send(spec)
  const wait = async (predicate) => {
    const timer = setTimeout(() => pending?.(), 15000)
    const deadline = Date.now() + 15000
    try {
      while (!predicate()) {
        if (ended || Date.now() >= deadline) throw new Error(`Worker stopped or timed out: ${JSON.stringify(events)} ${stderr}`)
        await new Promise((resolve) => { pending = resolve })
      }
    } finally { clearTimeout(timer); pending = undefined }
  }
  return { spec, events, send, closed, wait, requests: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), stop: async () => { child.stdin.end(); await closed } }
}
try {
  for (const harness of ['claude', 'codex', 'opencode']) {
    const w = worker(harness)
    await w.wait(() => w.events.some((e) => e.type === 'turn_done'))
    assert.deepEqual(w.events.filter((e) => e.type === 'assistant_message').map((e) => e.text), ['Hello world', 'Done [REDACTED]'])
    assert.equal(w.events.find((e) => e.type === 'tool_invocation').payload.kind, 'command')
    assert.equal(w.events.find((e) => e.type === 'tool_result').payload.output, 'hello')
    assert(w.events.some((e) => e.type === 'usage'))
    assert(!JSON.stringify(w.events).includes('fixture-secret'))
    const created = w.requests().find((r) => r.method === 'session/new')
    if (harness === 'opencode') {
      assert.equal(created.params.systemPrompt, undefined)
      assert.equal(created.opencodeConfig.agent.lynx.prompt, 'Test instructions')
      assert.equal(created.opencodeConfig.mcp.personal.enabled, false)
      assert.equal(created.opencodeConfig.agent.personal.disable, true)
      assert.equal(created.opencodeConfig.permission.connection_ab_read, 'allow')
      assert.equal(created.opencodeConfig.permission['*'], 'ask')
      assert(!JSON.stringify(created.opencodeConfig).includes('fixture-secret'))
    } else assert.equal(created.params.systemPrompt.content[0].text, 'Test instructions')
    assert.equal(created.params.mcpServers[0].headers[0].value, 'Bearer fixture-secret')
    assert.equal(created.credentialInEnv, false)
    if (harness === 'claude') {
      assert.equal(created.params._meta.claudeCode.options.strictMcpConfig, true)
      assert.deepEqual(created.params._meta.claudeCode.options.settingSources, [])
      assert.deepEqual(created.params._meta.claudeCode.options.allowedTools, ['mcp__connection_ab__read'])
    } else if (harness === 'codex') {
      const settings = JSON.parse(created.config)
      assert.equal(settings['mcp_servers.personal.enabled'], false)
      assert.equal(settings['mcp_servers.server-with-dashes.enabled'], false)
      assert.equal(settings['mcp_servers.project.enabled'], false)
      assert.equal(settings['mcp_servers.connection_ab.enabled'], true)
      assert.equal(settings['mcp_servers.connection_ab.default_tools_approval_mode'], 'auto')
    }
    w.send({ type: 'turn', spec: { ...w.spec, prompt: 'question', provider_session_id: 'acp-session', config: { ...w.spec.config, model: 'model-b' } } })
    await w.wait(() => w.events.filter((e) => e.type === 'turn_done').length === 2)
    assert(w.events.some((e) => e.type === 'assistant_message' && e.text.includes('"target":"dev"')))
    assert.equal(new Set(w.requests().map((r) => r.pid)).size, 1)
    assert.equal(w.requests().filter((r) => r.method === 'session/new').length, 1)
    assert(w.requests().some((r) => r.method === 'session/set_config_option' && r.params.value === 'model-b'))
    await w.stop()
    if (harness === 'opencode') assert(!existsSync(created.opencodeConfigPath), 'Temporary config must be removed when the adapter exits')
    const resumed = worker(harness, {}, { provider_session_id: 'acp-session' })
    await resumed.wait(() => resumed.events.some((e) => e.type === 'turn_done'))
    assert(!JSON.stringify(resumed.events).includes('old replay'))
    assert(resumed.requests().some((r) => r.method === 'session/load'))
    await resumed.stop()
    for (const mode of (harness === 'opencode' ? ['deny', 'ask', 'allow'] : ['deny', 'ask', 'auto', 'allow'])) {
      const permissions = worker(harness, { permission_mode: mode }, { prompt: 'permission' })
      await permissions.wait(() => permissions.events.some((e) => e.type === 'turn_done'))
      const response = permissions.requests().find((r) => r.id === 'permission' && r.result)
      assert.equal(response.result.outcome.optionId, mode === 'deny' ? 'no' : 'once')
      assert.equal(permissions.events.some((e) => e.type === 'input_request'), mode === 'ask' || mode === 'auto')
      await permissions.stop()
    }
    for (const fixtureCase of ['', 'mode-reset-error']) {
      const w = worker(harness, {}, { prompt: 'enter-plan' }, fixtureCase)
      await w.wait(() => w.events.some((e) => e.type === 'turn_done'))
      w.send({ type: 'turn', spec: { ...w.spec, prompt: 'hello' } })
      if (fixtureCase) {
        await w.closed
        assert.equal(w.events.filter((e) => e.type === 'agent_completed').at(-1).payload.success, false)
        assert.equal(w.requests().filter((r) => r.method === 'session/prompt').length, 1)
      } else {
        await w.wait(() => w.events.filter((e) => e.type === 'turn_done').length === 2)
        const requests = w.requests()
        assert.equal(requests.filter((r) => r.method === 'session/set_mode').length, 2)
        assert.equal(requests.filter((r) => r.method === 'session/prompt').at(-1).mode, harness === 'claude' ? 'default' : harness === 'opencode' ? 'lynx' : 'read-only')
        await w.stop()
      }
    }
    console.log(`ok: ${harness} streaming, tools, redaction, settings, connectors, questions, warm turns, resume and supported permission modes`)
  }
  // Exercise grant changes through the real store and runner, which choose warm reuse.
  for (const name of ['runner', 'store', 'db']) {
    await build({ entryPoints: [`src/agentd/${name}.ts`], outfile: join(dir, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  }
  const { createRunner } = await import(join(dir, 'runner.mjs'))
  const { createStore } = await import(join(dir, 'store.mjs'))
  const { openDb } = await import(join(dir, 'db.mjs'))
  for (const harness of ['claude', 'codex', 'opencode']) {
    const db = openDb(join(dir, `${harness}.sqlite`))
    const store = createStore(db, { dataDir: dir, roots: [dir] })
    const log = join(dir, `${harness}-grants.jsonl`)
    const url = `http://127.0.0.1:${hub.address().port}/mcp`
    const headers = { authorization: 'Bearer fixture-secret', 'x-test': 'one' }
    for (const id of ['a', 'b']) store.q("INSERT INTO connections (id, name, url, headers, created_at, updated_at) VALUES (?, ?, ?, ?, '', '')").run(id, id, url, JSON.stringify(headers))
    const runner = createRunner(store, { node: process.execPath, worker: join(dir, 'worker.mjs'), concurrency: 1, warm: [harness], env: { AGENT_CLAUDE_BIN: process.execPath, AGENT_CODEX_BIN: join(process.cwd(), 'scripts/fixture-codex.mjs'), AGENT_CLAUDE_ACP_BIN: fixture, AGENT_CODEX_ACP_BIN: fixture, AGENT_OPENCODE_ACP_BIN: fixture, AGENT_OPENCODE_BIN: join(process.cwd(), 'scripts/fixture-opencode.mjs'), ACP_FIXTURE_LOG: log } })
    const requests = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    const complete = async (run) => {
      const deadline = Date.now() + 15000
      while (runner.live() || !['completed', 'failed'].includes(store.getRun(run.id).status)) {
        assert(Date.now() < deadline, `Runner timed out: ${JSON.stringify(store.getRun(run.id))}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(store.getRun(run.id).status, 'completed', JSON.stringify(store.getRun(run.id)))
      assert.equal(runner.warm(), 1)
      return requests().filter((r) => r.method === 'session/prompt').at(-1).pid
    }
    try {
      const { session, run } = await store.startSession({ harness, cwd: dir, prompt: 'hello', connection_ids: ['a'], config: { permission_mode: 'ask' } })
      let pid = await complete(run)
      assert.equal(await complete(await store.sendSession(session.id, 'hello')), pid)
      const changed = async (names, expectedHeaders = headers) => {
        const next = await complete(await store.sendSession(session.id, 'hello'))
        assert.notEqual(next, pid, 'Changed connector grants must retire the warm worker')
        pid = next
        const loaded = requests().filter((r) => r.method === 'session/load').at(-1)
        assert.equal(loaded.pid, pid)
        assert.deepEqual(loaded.params.mcpServers.map((s) => s.name), names.map((id) => `connection_${id}`))
        for (const server of loaded.params.mcpServers) assert.deepEqual(Object.fromEntries(server.headers.map(({ name, value }) => [name, value])), expectedHeaders)
        if (harness === 'claude') assert.deepEqual(loaded.params._meta.claudeCode.options.allowedTools, names.map((id) => `mcp__connection_${id}__read`))
        else if (harness === 'codex') {
          for (const id of names) assert.equal(JSON.parse(loaded.config)[`mcp_servers.connection_${id}.enabled`], true)
        } else {
          assert.equal(loaded.opencodeConfig.mcp.personal.enabled, false)
          assert.deepEqual(Object.keys(loaded.opencodeConfig.permission).filter((name) => name.startsWith('connection_')), names.map((id) => `connection_${id}_read`))
        }
        return loaded
      }
      store.setGrants(session.id, [])
      await changed([])
      store.setGrants(session.id, ['b'])
      await changed(['b'])
      const rotated = { ...headers, authorization: 'Bearer rotated-fixture-secret' }
      store.q('UPDATE connections SET headers = ? WHERE id = ?').run(JSON.stringify(rotated), 'b')
      await changed(['b'], rotated)
      store.q('UPDATE connections SET url = ? WHERE id = ?').run(url + '?changed', 'b')
      assert.equal((await changed(['b'], rotated)).params.mcpServers[0].url, url + '?changed')
      store.q('UPDATE connections SET headers = ? WHERE id = ?').run(JSON.stringify({ 'x-test': rotated['x-test'], authorization: rotated.authorization }), 'b')
      assert.equal(await complete(await store.sendSession(session.id, 'hello')), pid, 'Header ordering must not retire the worker')
      console.log(`ok: ${harness} warm reuse, connector revoke, grant, token rotation and URL change`)
    } finally { await runner.shutdown(); db.close() }
  }
  // Native OpenCode discovery and unsupported settings must fail safely.
  await build({ entryPoints: ['src/agentd/providers/opencode-discover.ts'], outfile: join(dir, 'opencode-discover.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const { discoverOpenCode } = await import(join(dir, 'opencode-discover.mjs'))
  const previousBin = process.env.AGENT_OPENCODE_BIN
  try {
    process.env.AGENT_OPENCODE_BIN = join(process.cwd(), 'scripts/fixture-opencode.mjs')
    const discovered = await discoverOpenCode()
    assert.equal(discovered.available, true)
    assert.equal(discovered.signed_in, null)
    assert.deepEqual(discovered.models.map((m) => m.id), ['fixture/model-a', 'fixture/model-b'])
    process.env.AGENT_OPENCODE_BIN = join(dir, 'missing-opencode')
    assert.equal((await discoverOpenCode()).available, false)
  } finally {
    if (previousBin === undefined) delete process.env.AGENT_OPENCODE_BIN
    else process.env.AGENT_OPENCODE_BIN = previousBin
  }
  const auto = worker('opencode', { permission_mode: 'auto' }, { warm: false })
  await auto.closed
  assert.equal(auto.events.find((e) => e.type === 'agent_completed').payload.success, false)
  process.env.OPENCODE_FIXTURE_CONFLICT = '1'
  const conflict = worker('opencode', {}, { warm: false })
  delete process.env.OPENCODE_FIXTURE_CONFLICT
  await conflict.closed
  assert.equal(conflict.events.find((e) => e.type === 'agent_completed').payload.success, false)
  assert(conflict.events.some((e) => JSON.stringify(e).includes('overrides Lynx')))
  console.log('ok: OpenCode discovery, missing binary, unsupported auto mode and configuration conflict')
  // The upstream adapter also recreates queries internally after plan exits/account changes.
  await build({ entryPoints: ['src/agentd/providers/claude-acp-connectors.ts'], outfile: join(dir, 'private-connectors.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const { privateClaudeConnectors } = await import(join(dir, 'private-connectors.mjs'))
  const created = [], registered = []
  let rejected = false, closed = false
  const adapter = {
    sessions: {},
    async createSession(params) {
      created.push(params)
      this.sessions.test = { query: { setMcpServers: async (config) => { registered.push(config); return { errors: rejected ? { connector: 'failed' } : {} } }, close: () => { closed = true } } }
      return { sessionId: 'test' }
    },
  }
  privateClaudeConnectors(adapter)
  const servers = [{ name: 'connection_test', type: 'http', url: 'https://example.invalid/mcp', headers: [{ name: 'authorization', value: 'private-token' }] }]
  await adapter.createSession({ cwd: dir, mcpServers: servers })
  await adapter.createSession(created[0])
  assert(created.every((params) => params.mcpServers.length === 0))
  assert.deepEqual(registered, Array(2).fill({ connection_test: { type: 'http', url: servers[0].url, headers: { authorization: 'private-token' } } }))
  rejected = true
  await assert.rejects(adapter.createSession(created[0]), /register the granted connectors/)
  assert.equal(closed, true)
  assert.throws(() => privateClaudeConnectors({}), /no longer supports/)
  console.log('ok: Claude credentials use control messages on initial and recreated queries; registration fails closed')
  for (const prompt of ['crash', 'failure', 'rpc-error', 'unsupported-question', 'secret-question']) {
    const w = worker('codex', {}, { prompt, warm: false })
    await w.closed
    const completion = w.events.find((e) => e.type === 'agent_completed')
    assert.equal(completion.payload.success, ['unsupported-question', 'secret-question'].includes(prompt))
    if (prompt === 'rpc-error') assert.equal(completion.payload.error.code, 'auth')
    if (['unsupported-question', 'secret-question'].includes(prompt)) assert(w.events.some((e) => e.type === 'unsupported_input'))
  }
  for (const fixtureCase of ['', 'ignore-cancel', 'startup-hang']) {
    const w = worker('codex', {}, { prompt: 'hang' }, fixtureCase)
    if (fixtureCase !== 'startup-hang') await w.wait(() => w.events.some((e) => e.type === 'provider_session'))
    w.send({ type: 'cancel' })
    await Promise.race([w.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancel hung')), 5000).unref())])
    assert(!w.events.some((e) => e.type === 'agent_completed' && e.payload.success))
  }
  for (const [extra, config, fixtureCase] of [[{}, {}, 'startup-exit'], [{ provider_session_id: 'old' }, {}, 'no-resume'], [{}, { model: 'unsupported' }, '']]) {
    const w = worker('codex', config, { ...extra, warm: false }, fixtureCase)
    await w.closed
    assert.equal(w.events.find((e) => e.type === 'agent_completed').payload.success, false)
    assert(!w.requests().some((r) => r.method === 'session/prompt'))
  }
  console.log('ok: crash, refusal, auth errors, unsupported input/settings/resume and cancellation')
} finally {
  for (const child of workers) child.kill('SIGTERM')
  hub.closeAllConnections()
  await new Promise((resolve) => hub.close(resolve))
  rmSync(dir, { recursive: true, force: true })
}

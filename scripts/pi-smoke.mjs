// Published pi-acp + real Pi, against a local synthetic model. No account or model quota.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
mkdirSync('node_modules/.cache', { recursive: true })
const dir = mkdtempSync(join(process.cwd(), 'node_modules/.cache/pi-'))
const agentDir = join(dir, 'agent')
mkdirSync(agentDir)
const original = { ...process.env }
const cli = process.env.AGENT_PI_BIN ?? 'pi'
const built = process.argv.includes('--built')
if (!built) await build({ entryPoints: ['src/agentd/providers/acp.ts', 'src/agentd/providers/pi.ts'], outdir: dir, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, packages: 'external', logLevel: 'silent' })
const entry = built ? join(process.cwd(), 'out/main/chunks', readdirSync('out/main/chunks').find((name) => /^acp-[\w-]{8}\.js$/.test(name))) : join(dir, 'acp.mjs')
const { acpSession } = await import(pathToFileURL(entry).href)
// Upstream 0.0.34 hardcodes its session map under os.homedir(). Stub only that function
// in the test adapter process; keep the user's HOME and account files untouched.
const bootstrap = join(dir, 'adapter.mjs')
writeFileSync(bootstrap, `delete process.env.ELECTRON_RUN_AS_NODE;\nimport os from 'node:os';\nimport { syncBuiltinESMExports } from 'node:module';\nos.homedir = () => ${JSON.stringify(dir)};\nsyncBuiltinESMExports();\nawait import(${JSON.stringify(pathToFileURL(require.resolve('pi-acp')).href)});\n`, { mode: 0o700 })
const runner = join(dir, 'adapter')
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'"
writeFileSync(runner, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bootstrap)} \"$@\"\n`, { mode: 0o700 })
Object.assign(process.env, { AGENT_PI_BIN: cli, AGENT_PI_ACP_BIN: runner, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' })
let requests = 0, modelError, mode = 'deny'
const models = new Set(), toolsByMode = new Map()
const model = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(req.headers.authorization, 'Bearer fixture-key')
    requests++; models.add(body.model)
    const names = body.tools?.map((tool) => tool.function.name) ?? []
    if (names.length) {
      assert(JSON.stringify(body.messages).includes('Lynx Pi instruction sentinel'))
      toolsByMode.set(mode, names)
      assert(!names.some((name) => name.startsWith('mcp__')))
    }
    const lastUser = body.messages.findLastIndex((m) => m.role === 'user')
    const prompt = JSON.stringify(body.messages[lastUser]?.content)
    const used = body.messages.slice(lastUser + 1).some((m) => m.role === 'tool')
    if (prompt.includes('hang') && names.length) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return }
    const tool = names.length && !used ? prompt.includes('write file') ? 'write' : prompt.includes('read file') ? 'read' : undefined : undefined
    const args = tool === 'write' ? { path: join(dir, 'written.txt'), content: 'written by Pi' } : { path: join(dir, 'input.txt') }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `test-${requests}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (tool) { send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls') }
    else { send({ role: 'assistant', content: 'PI OK' }); send({}, 'stop') }
    res.end('data: [DONE]\n\n')
  } catch (error) { modelError = error; res.writeHead(500).end(); abort.abort(error) }
})
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve))
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture-key', models: [{ id: 'model-a', reasoning: false }, { id: 'model-b', reasoning: false }] } } }))
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'model-a', quietStartup: true }))
writeFileSync(join(dir, 'input.txt'), 'local file contents')
// An extension would fail the test if personal/project discovery were accidentally enabled.
mkdirSync(join(dir, '.pi/extensions'), { recursive: true })
writeFileSync(join(dir, '.pi/extensions/unsafe.ts'), 'throw new Error("project extension must not load")')
let id, session, outcome
const events = [], abort = new AbortController()
const timeout = setTimeout(() => abort.abort(new Error('Pi smoke timed out')), 90000)
const io = { signal: abort.signal, secrets: () => [], ask: async () => { throw new Error('Pi must not advertise interactive approval support') }, emit: async (event) => { events.push(event); if (event.type === 'provider_session') id = event.payload.id; if (event.type === 'agent_completed') outcome = event.payload } }
const spec = { harness: 'pi', cwd: dir, provider_session_id: null, connections: [], prompt: 'read file', config: { model: 'fixture/model-a', permission_mode: 'deny', instructions: 'Lynx Pi instruction sentinel' } }
const turn = async (next) => {
  events.length = 0; outcome = undefined
  await session.turn(next)
  assert.ifError(modelError)
  assert.equal(outcome?.success, true, JSON.stringify(outcome))
  assert(events.some((e) => e.type === 'assistant_message' && e.text.includes('PI OK')))
}
const close = async () => { session?.close(); await session?.closed; session = undefined; await new Promise((resolve) => setTimeout(resolve, 500)) }
try {
  if (!built) {
    const { discoverPi } = await import(pathToFileURL(join(dir, 'pi.mjs')).href)
    const discovery = await discoverPi()
    assert.equal(discovery.available, true, JSON.stringify(discovery))
    assert(discovery.models.some((m) => m.id === 'fixture/model-a'))
  }
  session = await acpSession(spec, io)
  await turn(spec)
  assert(events.some((e) => e.type === 'tool_invocation' && e.payload.kind === 'file_read'))
  assert.deepEqual(toolsByMode.get('deny').sort(), ['find', 'grep', 'ls', 'read'])
  await turn({ ...spec, prompt: 'write file' })
  assert(!existsSync(join(dir, 'written.txt')), 'read-only Pi must reject a write even if the model requests it')
  await turn({ ...spec, prompt: 'next turn', config: { ...spec.config, model: 'fixture/model-b' } })
  assert(models.has('model-b'))
  const resumeId = id
  await close()
  session = await acpSession({ ...spec, provider_session_id: resumeId }, io)
  await turn({ ...spec, prompt: 'resumed turn' })
  await close()
  mode = 'allow'
  const allow = { ...spec, config: { ...spec.config, permission_mode: 'allow' }, prompt: 'write file' }
  session = await acpSession(allow, io)
  await turn(allow)
  assert.equal(readFileSync(join(dir, 'written.txt'), 'utf8'), 'written by Pi')
  assert(toolsByMode.get('allow').includes('bash'))
  const allowedSessionId = id
  await close()
  rmSync(join(dir, 'written.txt'))
  mode = 'deny'
  session = await acpSession({ ...spec, provider_session_id: allowedSessionId }, io)
  await turn({ ...spec, prompt: 'write file after downgrade' })
  assert(!existsSync(join(dir, 'written.txt')), 'resuming a full-access session as read-only must remove write access')
  const count = requests
  const pending = session.turn({ ...spec, prompt: 'hang' }).catch(() => {})
  while (requests === count) await new Promise((resolve) => setTimeout(resolve, 20))
  abort.abort()
  await pending
  assert.equal(outcome.success, false)
  console.log('ok: published Pi ACP adapter, local model, discovery, instructions, tool cards, read-only enforcement, warm model changes, resume, permission downgrade, full access and cancellation')
} finally {
  clearTimeout(timeout)
  await close()
  model.closeAllConnections(); await new Promise((resolve) => model.close(resolve))
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  rmSync(dir, { recursive: true, force: true })
}

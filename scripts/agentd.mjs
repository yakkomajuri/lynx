// Checks for agentd, the agent backend, run under plain Node with the fake harness: sessions, runs,
// questions, cancellation, history, search, payloads, attachments, connections, schedules,
// idempotency and recovery after a crash. Talks to it over MCP, the way Lynx does.
//   node scripts/agentd.mjs
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

// Bundles live inside node_modules so they resolve the project's packages.
mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true })
const out = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'agentd-'))
const opts = { bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.node.json', logLevel: 'silent' }
await build({ ...opts, entryPoints: ['src/agentd/index.ts'], outfile: join(out, 'agentd.mjs') })
await build({ ...opts, entryPoints: ['src/agentd/providers/worker.ts'], outfile: join(out, 'worker.mjs') })

const data = mkdtempSync(join(tmpdir(), 'agentd-data-'))
const files = mkdtempSync(join(tmpdir(), 'agentd-files-'))
const port = 40000 + Math.floor(Math.random() * 20000)
const token = 'test-token-' + Math.random().toString(36).slice(2)

let failed = 0
const check = (label, cond, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${cond || !detail ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let child
const startAgentd = () =>
  new Promise((resolve, reject) => {
    child = spawn(process.execPath, [join(out, 'agentd.mjs')], {
      env: {
        ...process.env,
        AGENTD_DATA_DIR: data,
        AGENTD_PORT: String(port),
        AGENTD_TOKEN: token,
        AGENTD_FILE_ROOTS: [data, files].join(':'),
        AGENTD_NODE: process.execPath,
        AGENTD_WORKER: join(out, 'worker.mjs'),
        AGENT_ENABLE_FAKE: '1',
        // Codex is the stand-in, so its browser sign-in runs end to end without an account.
        AGENT_CODEX_BIN: join(process.cwd(), 'scripts', 'fixture-codex.mjs'),
        FAKE_CODEX_OUTCOME: join(data, 'codex-outcome'),
        AGENTD_WARM: 'claude,fake',
        AGENTD_IDLE_MS: '3000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    child.stdout.on('data', (d) => {
      log += d
      if (log.includes('"ready"')) resolve()
    })
    child.stderr.on('data', (d) => process.env.AGENTD_DEBUG && process.stderr.write(d))
    child.once('exit', (code) => reject(new Error(`agentd exited (${code}) before ready: ${log}`)))
  })

let client
const connect = async () => {
  client = new Client({ name: 'agentd-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
}
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const value = JSON.parse(r.content[0].text)
  if (r.isError) throw Object.assign(new Error(value.error?.message ?? 'tool error'), { code: value.error?.code })
  return value
}
const fails = async (f) => {
  try {
    await f()
    return ''
  } catch (e) {
    return e.code || e.message
  }
}
const admin = (method, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))
const wait = async (id, timeout_ms = 15000) => {
  const deadline = Date.now() + timeout_ms
  for (;;) {
    const r = await call('run_wait', { id, timeout_ms: 10000 })
    if (!r.wait_timed_out || Date.now() > deadline) return r.run
  }
}
const history = async (id, args = {}) => (await call('session_history', { id, limit: 500, ...args })).items

// A connector stand-in: the "hub" an agent's connections point at.
let hubAuth
const hub = createServer(async (req, res) => {
  hubAuth = req.headers.authorization
  const server = new McpServer({ name: 'hub', version: '1' })
  server.tool('ping', 'Answers pong', async () => ({ content: [{ type: 'text', text: 'pong' }] }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.once('close', () => void server.close())
  await server.connect(transport)
  const chunks = []
  for await (const c of req) chunks.push(c)
  await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined)
})
await new Promise((r) => hub.listen(0, '127.0.0.1', r))
const hubUrl = `http://127.0.0.1:${hub.address().port}/mcp/docs`

// Provider transport checks live in scripts/acp.mjs.
await build({ ...opts, entryPoints: ['src/agentd/providers/redact.ts'], outfile: join(out, 'redact.mjs') })

try {
  console.log('redaction')
  const { redactKnown, redactCut } = await import(join(out, 'redact.mjs'))
  check('overlapping secrets are both masked', !/fg|cd|ef/.test(redactKnown('[abcdef]', ['abcd', 'cdef'])), redactKnown('[abcdef]', ['abcd', 'cdef']))
  check('a cut-off longer secret is masked though a shorter one is inside it', !/fg/.test(redactCut('x abcdefg', ['abcde', 'abcdefghi'])), redactCut('x abcdefg', ['abcde', 'abcdefghi']))
  check('a whole secret at the end of a cut is masked whole', redactCut('x wxyz1', ['wxyz1', 'z1qqq']) === 'x [REDACTED]', redactCut('x wxyz1', ['wxyz1', 'z1qqq']))

  console.log('the worker')
  {
    // The spec and a cancel in one write: readline emits both lines before the worker could have
    // started listening for the second, and the cancel must still stop the turn before it runs.
    const worker = spawn(process.execPath, [join(out, 'worker.mjs')], { cwd: data, env: { ...process.env, AGENT_ENABLE_FAKE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] })
    let output = ''
    worker.stdout.on('data', (d) => (output += d))
    worker.stdin.write(JSON.stringify({ harness: 'fake', cwd: data, prompt: 'hello', provider_session_id: null, config: { permission_mode: 'deny' } }) + '\n{"type":"cancel"}\n')
    const code = await Promise.race([new Promise((r) => worker.once('exit', r)), sleep(5000).then(() => 'hung')])
    if (code === 'hung') worker.kill('SIGKILL')
    const events = output.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    check('a cancel sent with the spec stops the turn before it runs', code !== 'hung' && !events.some((e) => e.type === 'assistant_message') && events.some((e) => e.type === 'agent_completed' && e.payload.success === false), `${code} ${output.slice(0, 300)}`)
  }

  await startAgentd()
  await connect()

  console.log('status and auth')
  const status = await call('server_status')
  check('lists the fake harness', status.providers.some((p) => p.name === 'fake' && p.available))
  check('each provider has a name and its capabilities', status.providers.every((p) => p.display_name && typeof p.capabilities?.warm === 'boolean' && p.capabilities.permission_modes?.length), JSON.stringify(status.providers.map((p) => [p.name, p.display_name, p.capabilities])))
  check('refuses a wrong token', (await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status === 401)
  check('lists every tool', (await client.listTools()).tools.length === 34)

  console.log('browser sign-in')
  {
    const outcome = (how) => writeFileSync(join(data, 'codex-outcome'), how)
    const settled = async (id) => {
      for (let i = 0; i < 50; i++) {
        const s = await call('provider_sign_in_get', { id })
        if (s.status !== 'pending') return s
        await sleep(100)
      }
      return call('provider_sign_in_get', { id })
    }
    check('Codex says it signs in through the browser', status.providers.find((p) => p.name === 'codex')?.sign_in === 'browser', status.providers.find((p) => p.name === 'codex'))
    check('Claude Code signs in in a terminal instead', !status.providers.find((p) => p.name === 'claude')?.sign_in)
    outcome('success')
    const ok = await call('provider_sign_in', { harness: 'codex' })
    check('a sign-in answers with the address to open', ok.url === 'https://auth.openai.com/oauth/authorize?fake=1' && ok.id, ok)
    check('it waits for the browser, then is signed in', (await settled(ok.id)).status === 'signed_in')
    outcome('fail')
    const bad = await settled((await call('provider_sign_in', { harness: 'codex' })).id)
    check('a refused sign-in says why', bad.status === 'failed' && /access denied/.test(bad.error), bad)
    outcome('wait')
    const first = await call('provider_sign_in', { harness: 'codex' })
    check('one that is not finished is pending', (await call('provider_sign_in_get', { id: first.id })).status === 'pending')
    const second = await call('provider_sign_in', { harness: 'codex' })
    check('a new sign-in replaces the one waiting', (await call('provider_sign_in_get', { id: first.id })).status === 'cancelled')
    check('which can be cancelled', (await call('provider_sign_in_cancel', { id: second.id })).status === 'cancelled' && (await settled(second.id)).status === 'cancelled')
    check('an agent with no browser sign-in is refused', (await fails(() => call('provider_sign_in', { harness: 'claude' }))) === 'unsupported_capability')
    check('an unknown sign-in is not found', (await fails(() => call('provider_sign_in_get', { id: '00000000-0000-4000-8000-00000000abcd' }))) === 'not_found')
  }

  console.log('a conversation')
  const started = await call('session_start', { harness: 'fake', prompt: 'hello', labels: { app: 'test' } })
  check('starts with a queued run', started.session.id && started.run?.id, started)
  const first = await wait(started.run.id)
  check('first run completes', first.status === 'completed', first)
  check('output is the answer', first.output === 'Reply: hello', first.output)
  const second = await wait((await call('session_send', { id: started.session.id, prompt: 'again', model: 'm2' })).id)
  check('second run completes', second.status === 'completed', second)
  const events = await history(started.session.id)
  const answers = events.filter((e) => e.type === 'assistant_message')
  check('second turn resumed the provider session', answers[1]?.payload?.resumed === true, answers)
  check('history hides diagnostics', !events.some((e) => e.type === 'provider_session'))
  const call1 = events.find((e) => e.type === 'tool_invocation')?.payload
  const result1 = events.find((e) => e.type === 'tool_result')?.payload
  check('tool calls are { id, kind, name, input }, results { id, output, is_error }', call1?.id && call1.kind === 'other' && call1.name === 'test_tool' && result1?.id === call1.id && result1.output === 'deterministic result' && result1.is_error === false, JSON.stringify([call1, result1]))
  check('history can ask for types', (await history(started.session.id, { types: ['user_message'] })).length === 2)
  const got = await call('session_get', { id: started.session.id })
  check('a model sent with a message sticks', got.session.model === 'm2', got.session)
  check('latest run is the second', got.latest_run.id === second.id)
  const listed = await call('session_list', { labels: { app: 'test' } })
  check('list filters by label', listed.items.length === 1 && listed.items[0].status === 'completed', listed)
  check('list filter excludes others', (await call('session_list', { labels: { app: 'other' } })).items.length === 0)
  check('busy session refuses a second message', (await fails(async () => {
    const r = await call('session_send', { id: started.session.id, prompt: 'slow one' })
    await call('session_send', { id: started.session.id, prompt: 'too soon' }).finally(() => wait(r.id))
  })) === 'busy')
  check('unknown fields are refused', (await fails(() => call('session_get', { id: started.session.id, nope: 1 }))) === 'invalid_request')

  console.log('warm workers')
  const launches = async (id) => (await history(id, { types: ['launched'], view: 'full' })).map((e) => e.payload)
  const firstLaunches = await launches(started.session.id)
  check('the next message goes to the same worker', firstLaunches[1]?.warm === true && firstLaunches[1]?.pid === firstLaunches[0]?.pid, firstLaunches)
  check('the worker kept its state between messages', answers[1]?.payload?.turn === 2, answers)
  const pool = []
  for (let i = 0; i < 5; i++) {
    pool.push(await call('session_start', { harness: 'fake', prompt: `pool ${i}` }))
    await wait(pool[i].run.id)
  }
  await wait((await call('session_send', { id: pool[4].session.id, prompt: 'newest' })).id)
  await wait((await call('session_send', { id: pool[0].session.id, prompt: 'oldest' })).id)
  check('the most recent idle worker is kept', (await launches(pool[4].session.id))[1]?.warm === true)
  check('past four idle workers, the least recently used goes', !(await launches(pool[0].session.id))[1]?.warm)
  await sleep(3500)
  await wait((await call('session_send', { id: pool[4].session.id, prompt: 'after a pause' })).id)
  const rested = await launches(pool[4].session.id)
  check('an idle worker is let go after its idle time', !rested[2]?.warm && rested[2]?.pid !== rested[1]?.pid, rested)

  console.log('following a session')
  const tail = await call('session_history', { id: pool[4].session.id, limit: 500 })
  let t0 = Date.now()
  const quiet = await call('session_history', { id: pool[4].session.id, after: tail.next_cursor, wait_ms: 400 })
  check('a waiting read with nothing new returns empty after its wait', quiet.items.length === 0 && Date.now() - t0 >= 380, { n: quiet.items.length, ms: Date.now() - t0 })
  const following = call('session_history', { id: pool[4].session.id, after: tail.next_cursor, wait_ms: 10000 })
  await sleep(150)
  t0 = Date.now()
  const woken = await call('session_send', { id: pool[4].session.id, prompt: 'wake up' })
  const arrived = await following
  check('a waiting read returns as soon as something is recorded', arrived.items.length > 0 && Date.now() - t0 < 1000, { n: arrived.items.length, ms: Date.now() - t0 })
  await wait(woken.id)

  console.log('warm workers that go wrong')
  const stuck = await call('session_start', { harness: 'fake', prompt: 'fixture:fragment' })
  const unstuck = await wait(stuck.run.id, 8000)
  check('a broken line ends the run instead of leaving it busy', unstuck.status === 'failed' && /protocol/.test(unstuck.error?.message), unstuck)
  await wait((await call('session_send', { id: stuck.session.id, prompt: 'after a broken line' })).id)
  const brokenLaunches = await launches(stuck.session.id)
  check('a broken worker is not reused', !brokenLaunches[1]?.warm && brokenLaunches[1]?.pid !== brokenLaunches[0]?.pid, brokenLaunches)
  const dying = await call('session_start', { harness: 'fake', prompt: 'fixture:exit-when-idle' })
  await wait(dying.run.id)
  await sleep(400)
  const revived = await wait((await call('session_send', { id: dying.session.id, prompt: 'after the provider went away' })).id)
  check('a provider that exits while idle is replaced on the next message', revived.status === 'completed' && !(await launches(dying.session.id))[1]?.warm, revived)
  const noisy = await call('session_start', { harness: 'fake', prompt: 'fixture:partial-stderr' })
  await wait(noisy.run.id)
  const quietRun = await wait((await call('session_send', { id: noisy.session.id, prompt: 'slow, next' })).id)
  const diagnostics = await history(noisy.session.id, { types: ['stderr'], view: 'full' })
  const holding = await call('session_start', { harness: 'fake', prompt: 'fixture:exit-holding-pipes' })
  await wait(holding.run.id)
  await sleep(300)
  const afterExit = await wait((await call('session_send', { id: holding.session.id, prompt: 'after the worker exited' })).id)
  check('a worker that exited is not handed the next message while its output drains', afterExit.status === 'completed' && !(await launches(holding.session.id))[1]?.warm, afterExit)
  check('a run keeps its own diagnostics, partial lines included', diagnostics.length === 1 && diagnostics[0].execution_id === noisy.run.id && diagnostics.every((e) => e.execution_id !== quietRun.id), diagnostics.map((e) => [e.execution_id, e.payload]))

  console.log('shell commands')
  const sh_proc = (p) => ({ ...p, ...(p?.execution || {}) })
  const sh_hello = await call('exec', { command: 'echo sh_hello; echo warn >&2', cwd: files, wait_ms: 10000 })
  check('exec runs a command and returns its output', sh_hello.kind === 'process' && sh_hello.status === 'completed' && sh_hello.exit_code === 0 && sh_hello.stdout === 'sh_hello\n' && sh_hello.stderr === 'warn\n', sh_hello)
  const sh_bad = await call('exec', { command: 'echo oops >&2; exit 3', wait_ms: 10000 })
  check('a failing command reports its exit code', sh_bad.status === 'failed' && sh_bad.exit_code === 3 && sh_bad.stderr === 'oops\n', sh_bad)
  let sh_later = sh_proc(await call('exec', { command: 'sleep 0.3; echo done', wait_ms: 0 }))
  check('exec without waiting returns the queued or running command', ['queued', 'starting', 'running'].includes(sh_later.status) && sh_later.id, sh_later)
  sh_later = sh_proc(await call('process_wait', { id: sh_later.id, timeout_ms: 10000, tail: true, max_chars: 30000 }))
  check('process_wait returns the finished command with its output', sh_later.status === 'completed' && sh_later.stdout === 'done\n' && sh_later.wait_timed_out === false, sh_later)
  check('process_get reads the same output', sh_proc(await call('process_get', { id: sh_later.id, tail: true })).stdout === 'done\n')
  const sh_reader = sh_proc(await call('exec', { command: 'read line; echo "got:$line"', wait_ms: 0 }))
  await call('process_input', { id: sh_reader.id, data: 'sh_typed\n', eof: true })
  const sh_typed = sh_proc(await call('process_wait', { id: sh_reader.id, timeout_ms: 10000 }))
  check('process_input types into a running command', sh_typed.stdout === 'got:sh_typed\n', sh_typed)
  const sh_long = sh_proc(await call('exec', { command: 'sleep 30', wait_ms: 0 }))
  await sleep(200)
  await call('process_cancel', { id: sh_long.id })
  const sh_stopped = sh_proc(await call('process_wait', { id: sh_long.id, timeout_ms: 10000 }))
  check('process_cancel stops a command', sh_stopped.status === 'cancelled', sh_stopped)
  const sh_slowCmd = await call('exec', { command: 'sleep 5', timeout_ms: 200, wait_ms: 10000 })
  check('a command past its timeout fails', sh_slowCmd.status === 'failed' && sh_slowCmd.error?.code === 'timeout', sh_slowCmd)
  const sh_t0 = Date.now()
  const sh_leftover = await call('exec', { command: 'sleep 30 & echo started', wait_ms: 10000 })
  check('what a command leaves running in the background ends with it', sh_leftover.status === 'completed' && Date.now() - sh_t0 < 3000, { status: sh_leftover.status, ms: Date.now() - sh_t0 })
  const sh_envd = await call('exec', { command: 'echo "$GREETING ${AGENTD_TOKEN:-no-token}"', env: { GREETING: 'hi' }, wait_ms: 10000 })
  check('commands get the env they are given, and not the backend token', sh_envd.stdout === 'hi no-token\n', sh_envd.stdout)
  check('commands cannot run outside the roots', (await fails(() => call('exec', { command: 'pwd', cwd: '/' }))) === 'permission_denied')

  console.log('files')
  const sh_note = join(files, 'sh_note.md')
  const sh_created = await call('file_write', { path: sh_note, text: 'first line\n', expected_version: 'missing' })
  check('file_write creates a file and returns its version', /^[a-f0-9]{64}$/.test(sh_created.version) && sh_created.size === 11, sh_created)
  const sh_readBack = await call('file_read', { path: sh_note })
  check('file_read returns its text and version', sh_readBack.text === 'first line\n' && sh_readBack.version === sh_created.version && sh_readBack.encoding === 'utf8' && sh_readBack.data === undefined, sh_readBack)
  check('a write based on an old version is refused', /changed/i.test(await fails(() => call('file_write', { path: sh_note, text: 'x', expected_version: 'a'.repeat(64) }))) || (await fails(() => call('file_write', { path: sh_note, text: 'x', expected_version: 'a'.repeat(64) }))) === 'version_conflict')
  const sh_patched = await call('file_patch', { path: sh_note, find: 'first', replace: 'only', expected_version: sh_created.version })
  check('file_patch replaces one fragment', (await call('file_read', { path: sh_note })).text === 'only line\n' && sh_patched.version !== sh_created.version)
  const sh_listing = await call('files_list', { path: files })
  check('files_list lists a folder', sh_listing.items.some((i) => i.name === 'sh_note.md' && i.type === 'file'), sh_listing)
  const sh_missingRead = await fails(() => call('file_read', { path: join(files, 'nope.txt') }))
  check('a missing file reads as not found', sh_missingRead === 'not_found', sh_missingRead)
  check('the agent database cannot be read', (await fails(() => call('file_read', { path: join(data, 'agentd.sqlite') }))) === 'permission_denied')
  check('files outside the roots cannot be written', (await fails(() => call('file_write', { path: '/tmp/agentd-outside.txt', text: 'x' }))) === 'permission_denied')

  console.log('search and payloads')
  const found = await call('session_search', { query: 'Reply again' })
  check('search finds the answer', found.items.some((i) => i.session_id === started.session.id && /<b>/.test(i.snippet)), found)
  const big = await call('session_start', { harness: 'fake', prompt: 'fixture:large' })
  await wait(big.run.id)
  const large = (await history(big.session.id)).find((e) => e.type === 'assistant_message')
  check('large payloads are shortened in history', large?.payload_truncated === true, large)
  const part = await call('event_payload', { stream_id: big.session.id, seq: large.seq, offset: 0, length: 1000 })
  check('event_payload returns byte ranges', part.size > 300000 && part.next_offset === 1000, part)
  const paged = await call('session_start', { harness: 'fake', prompt: 'fixture:history' })
  await wait(paged.run.id)
  const page1 = await call('session_history', { id: paged.session.id, limit: 50 })
  const page2 = await call('session_history', { id: paged.session.id, limit: 500, after: page1.next_cursor })
  check('history pages with a cursor', page1.has_more && page1.items.length === 50 && page2.items.length > 70 && !page2.has_more)

  console.log('questions and approvals')
  const asking = await call('session_start', { harness: 'fake', prompt: 'a question', config: { permission_mode: 'ask' } })
  let waiting = await wait(asking.run.id)
  check('run waits for an answer', waiting.status === 'waiting_for_input' && waiting.pending_inputs?.length === 1, waiting)
  const inputId = waiting.pending_inputs[0].id
  check('input_list shows it', (await call('input_list', { status: 'pending' })).items.some((i) => i.id === inputId && i.session_id === asking.session.id))
  check('a wrong answer is refused', (await fails(() => call('input_respond', { id: inputId, response: { answers: { format: ['medium'] } } }))) === 'invalid_response')
  await call('input_respond', { id: inputId, response: { answers: { format: ['short'] } } })
  const answered = await wait(asking.run.id)
  check('answered run completes', answered.status === 'completed', answered)
  const result = (await history(asking.session.id, { types: ['test_input_result'] }))[0]
  check('the worker got the answer', result?.payload?.answers?.format?.[0] === 'short', result)
  check('a stale input is refused', (await fails(() => call('input_respond', { id: inputId, response: { answers: { format: ['long'] } } }))) === 'response_conflict')
  const switching = await call('session_start', { harness: 'fake', prompt: 'hello', config: { permission_mode: 'allow' } })
  await wait(switching.run.id)
  const asked = await wait((await call('session_send', { id: switching.session.id, prompt: 'approve this', permission_mode: 'ask' })).id)
  check('a permission mode sent with a message applies from that turn', asked.status === 'waiting_for_input' && asked.pending_inputs?.[0]?.kind === 'approval', asked)
  await call('input_respond', { id: asked.pending_inputs[0].id, response: { decision: 'allow' } })
  check('the approved run completes', (await wait(asked.id)).status === 'completed')
  check('a permission mode sent with a message sticks', (await call('session_get', { id: switching.session.id })).session.permission_mode === 'ask')
  const freed = await wait((await call('session_send', { id: switching.session.id, prompt: 'approve again', permission_mode: 'allow' })).id)
  check('switching back stops asking', freed.status === 'completed', freed)
  const automatic = await wait((await call('session_send', { id: switching.session.id, prompt: 'carry on', permission_mode: 'auto' })).id)
  check('auto is a permission mode a message may switch to', automatic.status === 'completed' && (await call('session_get', { id: switching.session.id })).session.permission_mode === 'auto', automatic)
  check('an unknown permission mode is refused', !!(await fails(() => call('session_send', { id: switching.session.id, prompt: 'x', permission_mode: 'yolo' }))))

  console.log('cancellation and failures')
  const slow = await call('session_start', { harness: 'fake', prompt: 'slow' })
  await sleep(300)
  await call('run_cancel', { id: slow.run.id })
  const cancelled = await wait(slow.run.id)
  check('cancel ends the run', cancelled.status === 'cancelled', cancelled)
  const after = await wait((await call('session_send', { id: slow.session.id, prompt: 'after cancel' })).id)
  check('a cancelled session continues', after.status === 'completed', after)
  const afterCancel = (await history(slow.session.id, { types: ['launched'], view: 'full' })).map((e) => e.payload)
  check('a cancelled worker is not reused', afterCancel.length === 2 && !afterCancel[1].warm && afterCancel[1].pid !== afterCancel[0].pid, afterCancel)
  const malformed = await call('session_start', { harness: 'fake', prompt: 'fixture:malformed' })
  const bad = await wait(malformed.run.id)
  check('protocol errors fail the run', bad.status === 'failed' && /protocol/.test(bad.error?.message), bad)
  const missing = await wait((await call('session_start', { harness: 'fake', prompt: 'fixture:missing-completion' })).run.id)
  check('no completion fails the run', missing.status === 'failed', missing)
  const timed = await call('session_start', { harness: 'fake', prompt: 'slow', config: { timeout_ms: 200 } })
  const timeout = await wait(timed.run.id)
  check('timeouts fail the run', timeout.status === 'failed' && timeout.error?.code === 'timeout', timeout)

  console.log('attachments')
  const file = join(files, 'notes.txt')
  writeFileSync(file, 'attached words')
  const attach = await call('session_start', { harness: 'fake', prompt: 'read attachments', attachments: [{ path: file, name: 'notes.txt' }] })
  await wait(attach.run.id)
  const seen = (await history(attach.session.id, { types: ['test_attachments'] }))[0]
  check('the worker reads a copy of the file', Buffer.from(seen?.payload?.[0]?.data ?? '', 'base64').toString() === 'attached words', seen)
  check('files outside the roots are refused', (await fails(() => call('session_start', { harness: 'fake', prompt: 'x', attachments: [{ path: '/etc/hosts' }] }))) === 'permission_denied')

  console.log('connections')
  const created = await admin('POST', '/v1/admin/connections', { name: 'docs', spec: { transport: 'http', url: hubUrl }, enabled: true, credentials: { headers: { Authorization: 'Bearer hub-secret-1234' } } })
  check('admin creates a connection', created.status === 201 && created.body.id, created)
  check('admin reads it back', (await admin('GET', `/v1/connections/${created.body.id}`)).status === 200)
  check('tools never show headers', !JSON.stringify(await call('connection_list')).includes('hub-secret'))
  const conn = await call('session_start', { harness: 'fake', connection_ids: [created.body.id] })
  const used = await wait((await call('session_send', { id: conn.session.id, prompt: 'use the connector' })).id)
  check('connector run completes', used.status === 'completed', used)
  const connector = (await history(conn.session.id, { types: ['connector_result'] }))[0]
  check('the agent reached the connector directly', connector?.payload?.result?.content?.[0]?.text === 'pong' && hubAuth === 'Bearer hub-secret-1234', connector)
  check('workers do not inherit the backend token', connector?.payload?.service_credentials_inherited === false)
  const secret = await call('session_start', { harness: 'fake', connection_ids: [created.body.id] })
  await wait((await call('session_send', { id: secret.session.id, prompt: 'fixture:secret-output' })).id)
  check('connection secrets are redacted from history', !JSON.stringify(await call('session_history', { id: secret.session.id, view: 'full', limit: 500 })).includes('hub-secret'))
  await wait((await call('session_send', { id: secret.session.id, prompt: 'fixture:secret-cut' })).id)
  await wait((await call('session_send', { id: secret.session.id, prompt: 'slow, after the cut' })).id)
  const cut = await history(secret.session.id, { types: ['stderr'], view: 'full' })
  const fragmentRun = await wait((await call('session_send', { id: secret.session.id, prompt: 'fixture:fragment-secret' })).id)
  const oversizedRun = await wait((await call('session_send', { id: secret.session.id, prompt: 'fixture:oversized-secret' })).id)
  const shortened = await history(secret.session.id, { types: ['protocol_fragment', 'protocol_error'], view: 'full' })
  check('shortened copies of bad output keep no part of a secret', fragmentRun.status === 'failed' && oversizedRun.status === 'failed' && shortened.length >= 2 && !/Bearer h|hub-/.test(JSON.stringify(shortened)), shortened.map((e) => [e.type, JSON.stringify(e.payload).slice(-60)]))
  check('a diagnostic cut off partway into a secret keeps none of it', !/hub-secr|1234/.test(JSON.stringify(cut)) && cut.some((e) => /diagnostic \[REDACTED\]/.test(e.payload.text)), cut.map((e) => e.payload.text))
  const disabled = await admin('PUT', `/v1/admin/connections/${created.body.id}`, { name: 'docs-removed', spec: { transport: 'http', url: hubUrl }, enabled: false })
  check('admin disables it', disabled.status === 200 && disabled.body.enabled === false, disabled)
  check('disabled connections cannot be granted', (await fails(() => call('session_connections_set', { id: conn.session.id, connection_ids: [created.body.id] }))) === 'connection_unavailable')

  console.log('idempotency')
  const once = await call('session_start', { harness: 'fake', prompt: 'once', idempotency_key: 'k1' })
  const twice = await call('session_start', { harness: 'fake', prompt: 'once', idempotency_key: 'k1' })
  check('the same key returns the same session', once.session.id === twice.session.id)
  check('the same key with other input conflicts', (await fails(() => call('session_start', { harness: 'fake', prompt: 'other', idempotency_key: 'k1' }))) === 'idempotency_conflict')
  await wait(once.run.id)

  console.log('schedules')
  const run_at = new Date(Date.now() + 1500).toISOString()
  const schedule = await call('schedule_create', { name: 'soon', run_at, launch: { session_id: started.session.id, prompt: 'scheduled hello' } })
  check('schedule is created', schedule.id && schedule.enabled === true, schedule)
  await sleep(3000)
  const occ = await call('schedule_occurrences', { id: schedule.id })
  check('it launched once', occ.items.length === 1 && occ.items[0].status === 'launched', occ)
  if (occ.items[0]?.execution_id) check('its run completes', (await wait(occ.items[0].execution_id)).status === 'completed')
  check('a one-off schedule turns itself off', (await call('schedule_list')).items.find((s) => s.id === schedule.id)?.enabled === false)
  const cron = await call('schedule_create', { name: 'daily', cron: '0 9 * * *', timezone: 'Europe/Lisbon', launch: { harness: 'fake', prompt: 'daily' } })
  check('cron schedules get a next time', !!cron.next_fire_at, cron)
  const paused = await call('schedule_update', { id: cron.id, enabled: false })
  check('pausing clears the next time', paused.enabled === false && paused.next_fire_at === null && paused.revision === 2, paused)
  check('archiving a scheduled session is refused', (await fails(() => call('session_archive', { id: started.session.id }))) === 'busy')
  await call('schedule_delete', { id: schedule.id })
  await call('schedule_delete', { id: cron.id })
  check('deleted schedules leave the list', !(await call('schedule_list')).items.length)
  await call('session_archive', { id: started.session.id })
  check('archived sessions leave the list', !(await call('session_list')).items.some((s) => s.id === started.session.id))
  check('archived sessions refuse messages', (await fails(() => call('session_send', { id: started.session.id, prompt: 'x' }))) === 'archived')

  console.log('a crash mid-run')
  const crash = await call('session_start', { harness: 'fake', prompt: 'slow crash' })
  await sleep(400)
  child.kill('SIGKILL')
  await sleep(300)
  await startAgentd()
  await connect()
  const lost = await call('run_get', { id: crash.run.id })
  check('the interrupted run is marked unknown, not retried', lost.status === 'unknown', lost)
  const resumed = await wait((await call('session_send', { id: crash.session.id, prompt: 'after crash' })).id)
  check('the session carries on', resumed.status === 'completed', resumed)
  check('data survived the restart', (await call('session_get', { id: started.session.id })).session.archived_at)
} catch (e) {
  failed++
  console.error(e)
} finally {
  child?.kill('SIGTERM')
  hub.close()
  await sleep(200)
  rmSync(out, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
  rmSync(files, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)

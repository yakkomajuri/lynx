// Unit checks for the parts that run without Electron: the store, cron, the tool sandbox, schedule
// wording, code colouring, notification links, files staged for agents, workspace drafts and names, shortcut
// keys, updates, the remote marketplace, the background service's settings, login item and address, API connectors, OAuth sign-ins, what Point's
// note box can mention. Template code is checked separately by test-templates.mjs.
//   node scripts/unit.mjs
import { build, stop as stopEsbuild } from 'esbuild'
import { existsSync as exists, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Inside node_modules so the bundles resolve the project's packages.
mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true })
const tmp = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'sb-unit-'))
const load = async (entry, tsconfig = 'tsconfig.node.json') => {
  const out = join(tmp, entry.replace(/\W/g, '_') + '.mjs')
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig, logLevel: 'silent' })
  return import(pathToFileURL(out).href)
}
let failed = 0
const check = (label, cond, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${cond || !detail ? '' : `  -> ${detail}`}`)
}
const throws = async (f) => {
  try {
    await f()
    return ''
  } catch (e) {
    return e.message || 'threw'
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// External reads outlive frames; writes, reconfiguration and rate limits must invalidate safely.
{
  console.log('shared external reads')
  const { externalRequests, retryDelay } = await load('src/main/externalRequests.ts')
  let clock = 1000, calls = 0
  const requests = externalRequests({ now: () => clock })
  const read = { staleMs: 60_000 }
  const inspect = (value) => ({ ok: !value.error, retryMs: value.delay })
  const run = (args = {}, query = read, send = async () => ({ count: ++calls })) => requests.run('github', 'read', args, true, query === null ? undefined : query, send, inspect)
  const first = await run({ nested: { b: 2, a: 1 } })
  first.count = -1
  check('query answers survive callers and canonicalize object keys', (await run({ nested: { a: 1, b: 2 } })).count === 1 && calls === 1)
  check('direct calls bypass completed cached answers', (await run({ nested: { a: 1, b: 2 } }, null)).count === 2)
  check('manual refresh bypasses a fresh cache entry', (await run({ nested: { b: 2, a: 1 } }, { ...read, fresh: true })).count === 3)
  clock += 60_001
  check('expired answers fetch again', (await run({ nested: { b: 2, a: 1 } })).count === 4)
  let finish
  const pending = run({ key: 'pending' }, read, () => new Promise((r) => { calls++; finish = r }))
  await Promise.resolve()
  const joined = run({ key: 'pending' })
  finish({ count: calls })
  const [a, b] = await Promise.all([pending, joined])
  check('separate callers coalesce in-flight reads', a.count === b.count && a !== b && calls === 5)
  let writes = 0
  const write = () => requests.run('github', 'write', {}, false, read, async () => ({ write: ++writes }), inspect)
  await Promise.all([write(), write()])
  check('writes are never cached or coalesced', writes === 2)
  await run({ key: 'pending' })
  check('writes invalidate prior read answers', calls === 6)
  const late = run({ key: 'late' }, read, () => new Promise((r) => { finish = r }))
  await Promise.resolve()
  await write()
  finish({ count: 100 })
  await late
  check('a pre-mutation read cannot refill the cache', (await run({ key: 'late' })).count === 7)
  const old = run({ key: 'old' }, read, () => new Promise((r) => { finish = r }))
  await Promise.resolve()
  const oldObserver = requests.observe('github')
  requests.reset('github')
  finish({ count: 200 })
  await old
  oldObserver(60_000)
  check('credential/target resets discard old answers and old cooldowns', (await run({ key: 'old' })).count === 8)
  await run({}, { ...read, fresh: true }, async () => ({ error: true, delay: 3000 }))
  check('cooldowns block different reads and direct calls', /rate limited/.test(await throws(() => run({ other: true }, null))) && calls === 8)
  check('cooldowns also block writes', /rate limited/.test(await throws(write)) && writes === 3)
  clock += 3001
  await run({}, read, async () => ({ error: true, delay: 3000 }))
  check('repeated rate limits back off', requests.remaining('github') === 6000)
  clock += 6001
  check('requests resume after the cooldown expires', (await run()).count === 9)
  check('Retry-After seconds are honored', retryDelay('', { 'retry-after': '7' }, 429, clock) === 7000)
  check('Retry-After dates are honored', retryDelay('', { 'retry-after': new Date(clock + 10_000).toUTCString() }, 429, clock) >= 9000)
  check('primary-limit reset is honored', retryDelay('', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((clock + 90_000) / 1000) }, 403, clock) === 90_000)
  check('MCP retry hints are honored', retryDelay('secondary rate limit [retry after 37s]') === 37_000)
  check('unhinted limits wait a minute; ordinary forbidden does not', retryDelay({ message: 'secondary rate limit' }, {}, 403) === 60_000 && retryDelay('Forbidden', {}, 403) === undefined)
  const discussion = { items: [{ title: 'Investigate GitHub rate limits', number: 429 }] }
  for (const status of [200, 201, 204, 404, 500]) {
    check(`HTTP ${status} content cannot start a cooldown`, retryDelay(discussion, { 'retry-after': '60', 'x-ratelimit-remaining': '0' }, status) === undefined)
  }
  for (const error of ['issue 429 does not exist', 'pull request #429 was deleted', new Error('Could not find repository 429')]) {
    check('unrelated resource number 429 is not a rate limit', retryDelay(error) === undefined)
  }
  for (const error of ['HTTP 429', 'HTTP/1.1 429 Too Many Requests', 'status code: 429', '{"error":{"code":429}}', { statusCode: 429 }]) {
    check('explicit MCP HTTP/status 429 remains a rate limit', retryDelay(error) === 60_000)
  }
  const bounded = externalRequests({ now: () => clock, maxEntries: 1 })
  let boundedCalls = 0
  const boundedRead = (key) => bounded.run('github', 'read', { key }, true, read, async () => ({ count: ++boundedCalls }), inspect)
  await boundedRead('a'); await boundedRead('b'); await boundedRead('a')
  check('the shared cache has a bounded entry count', boundedCalls === 3)
  const tiny = externalRequests({ maxBytes: 4 })
  let largeCalls = 0
  for (let i = 0; i < 2; i++) await tiny.run('github', 'read', {}, true, read, async () => ({ text: 'too large', count: ++largeCalls }), inspect)
  check('oversized answers are not retained', largeCalls === 2)
}

// Connector diagnostics distinguish tool rate limits from transport errors without logging data.
{
  console.log('connector trace')
  const { connectorTrace, apiTraceSummary } = await load('src/main/connectorTrace.ts')
  const lines = []
  const trace = connectorTrace(true, (line) => lines.push(JSON.parse(line.slice('[connector-trace] '.length))))
  const answer = { content: [{ type: 'text', text: 'private repository content' }] }
  check('trace preserves the answer', await trace('github', 'search', 'agent', async () => answer) === answer)
  check('trace records caller, timing and result size', lines[0].by === 'agent' && lines[0].phase === 'start' && lines[1].outcome === 'ok' && lines[1].textChars === 26 && lines[1].ms >= 0, JSON.stringify(lines))
  check('trace never records the response content', !JSON.stringify(lines).includes('private repository'))
  await trace('github', 'search', 'workspace:w', async () => ({ isError: true, content: [{ type: 'text', text: 'API rate limit exceeded: secret' }] }))
  check('tool rate limits are identified without their text', lines.at(-1).outcome === 'tool_error' && lines.at(-1).rateLimited && !JSON.stringify(lines).includes('secret'))
  await trace('github', 'read', 'agent', async () => ({ isError: true, content: [{ type: 'text', text: 'issue 429 does not exist' }] }))
  check('MCP resource errors do not produce false rate-limit traces', lines.at(-1).outcome === 'tool_error' && !lines.at(-1).rateLimited)
  const failure = new Error('HTTP 429 secret')
  let caught
  try { await trace('github', 'search', 'agent', async () => { throw failure }) } catch (e) { caught = e }
  check('transport failures keep their identity and clear activity', caught === failure && lines.at(-1).outcome === 'error' && lines.at(-1).rateLimited && lines.at(-1).active === 0)
  let finish
  const pending = trace('github', 'search', 'agent', () => new Promise((r) => { finish = r }))
  await trace('github', 'search', 'agent', async () => answer)
  check('overlapping calls are counted', lines.at(-2).active === 2 && lines.at(-1).active === 1)
  finish(answer)
  await pending
  check('overlapping calls finish at zero', lines.at(-1).active === 0)
  const quiet = []
  await connectorTrace(false, (line) => quiet.push(line))('github', 'search', 'agent', async () => answer)
  check('tracing is silent by default', quiet.length === 0)
  check('a failed log cannot break a call', await connectorTrace(true, () => { throw new Error('disk full') })('github', 'search', 'agent', async () => answer) === answer)
  check('API 403 alone does not imply rate limiting', !apiTraceSummary({ status: 403, headers: {}, body: 'Forbidden' }).rateLimited)
  check('successful API data is not a rate-limit trace', !apiTraceSummary({ status: 200, headers: { 'retry-after': '60' }, body: { title: 'Investigate GitHub rate limits #429' } }).rateLimited)
  for (const response of [
    { status: 429, headers: {}, body: 'private' },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: 'private' },
    { status: 403, headers: { 'retry-after': '60' }, body: 'private' },
    { status: 403, headers: {}, body: { message: 'API rate limit exceeded' } },
  ]) check(`API ${response.status} rate-limit evidence is detected`, apiTraceSummary(response).rateLimited)
}

// Exercise the actual service paths: failed discovery before a call, scheduled reconnects and APIs.
{
  console.log('connector trace integration')
  const { Layer, ManagedRuntime } = await import('effect')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { createServer } = await import('node:http')
  const { setTimeout: realSleep } = await import('node:timers/promises')
  const { mock } = await import('node:test')
  const { ConfigLive } = await load('src/main/services/Config.ts')
  const { EventsLive } = await load('src/main/services/Events.ts')
  const { Engine } = await load('src/main/services/Engine.ts')
  const { Connectors, ConnectorsLive } = await load('src/main/services/Connectors.ts')
  const dataDir = join(tmp, 'connector-trace-data')
  mkdirSync(dataDir, { recursive: true })
  const lines = []
  const previous = { info: console.info, flag: process.env.LYNX_TRACE_CONNECTORS, connect: Client.prototype.connect }
  let mode = 'initialize-limit', lastClient
  let apiReads = 0, apiWrites = 0, scopeRequests = 0
  const server = createServer(async (req, res) => {
    const json = (status, value, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value))
    if (req.url === '/api/value') {
      if (req.method === 'POST') apiWrites++
      else apiReads++
      return json(200, { version: apiWrites, identity: req.headers.authorization === 'Bearer private-key' ? 'first' : 'second', items: [{ title: 'Investigate GitHub rate limits #429' }] })
    }
    if (req.url.startsWith('/api')) return json(req.url.endsWith('forbidden') ? 403 : 429, { message: 'private response' }, req.url.endsWith('limited') ? { 'x-ratelimit-remaining': '0' } : {})
    if (req.method !== 'POST') return res.writeHead(405).end()
    let body = ''
    for await (const chunk of req) body += chunk
    const rpc = JSON.parse(body)
    if (mode === 'scope') {
      scopeRequests++
      return json(403, { message: 'additional permissions required' }, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="workers:read"' })
    }
    if (mode === 'transient') return json(503, { message: 'private network unavailable' })
    if ((mode === 'initialize-limit' && rpc.method === 'initialize') || (mode === 'tools-limit' && rpc.method === 'tools/list')) return json(429, { message: mode === 'tools-limit' ? 'private response' : 'private rate limit' })
    if (rpc.method.startsWith('notifications/')) return res.writeHead(202).end()
    if (rpc.method === 'tools/call') return json(200, { jsonrpc: '2.0', id: rpc.id, result: rpc.params.name === 'missing'
      ? { isError: true, content: [{ type: 'text', text: 'issue 429 does not exist' }] }
      : { content: [{ type: 'text', text: 'ready' }] } })
    const result = rpc.method === 'initialize' ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
    json(200, { jsonrpc: '2.0', id: rpc.id, result })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  let rt
  const waitFor = async (test) => {
    for (let i = 0; i < 200 && !test(); i++) {
      await realSleep(10)
      // The transport also schedules timers while its real socket IO finishes. Let those run
      // between checks, rather than freezing a reconnect until the next test advances time.
      mock.timers.tick(10)
    }
    return test()
  }
  const ends = (id, operation, reason) => lines.filter((l) => l.connector === id && l.operation === operation && l.phase === 'end' && (!reason || l.reason === reason))
  try {
    process.env.LYNX_TRACE_CONNECTORS = '1'
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    console.info = (line) => { if (line.startsWith('[connector-trace] ')) lines.push(JSON.parse(line.slice('[connector-trace] '.length))) }
    Client.prototype.connect = async function (...args) { await previous.connect.apply(this, args); lastClient = this }
    const deps = Layer.mergeAll(ConfigLive({ appRoot: process.cwd(), outDir: tmp, dataDir, workspacesDir: dataDir, hubPort: 1, hubToken: 'fixture' }), EventsLive, Layer.succeed(Engine)({ ready: new Promise(() => {}), url: base, admin: async () => ({}) }))
    rt = ManagedRuntime.make(ConnectorsLive.pipe(Layer.provideMerge(deps)))
    const connectors = await rt.runPromise(Connectors)
    const run = (effect) => rt.runPromise(effect)
    const added = await run(connectors.add({ name: 'github-fixture', url: `${base}/mcp`, headers: { Authorization: 'Bearer private-key' } }))
    check('failed initialize emits a connect end with the rate limit', ends(added.id, 'connect').at(-1)?.rateLimited === true)
    const attempts = ends(added.id, 'connect').length
    check('a rate-limited connect suppresses immediate rediscovery', /rate limited/.test(await throws(() => run(connectors.callRaw(added.id, 'read')))) && ends(added.id, 'connect').length === attempts)
    mock.timers.tick(60_001)
    const error = await throws(() => run(connectors.callRaw(added.id, 'read', {}, { by: 'workspace:fixture', depth: 0 })))
    check('ensure failure is also traced as the calling workspace', !!error && ends(added.id, 'call').at(-1)?.rateLimited && ends(added.id, 'call').at(-1)?.by === 'workspace:fixture')
    mock.timers.tick(120_001)
    mode = 'tools-limit'
    await run(connectors.connect(added.id))
    check('failed listTools is traced', ends(added.id, 'connect').at(-1)?.rateLimited === true)
    mock.timers.tick(240_001)
    mode = 'transient'
    await run(connectors.connect(added.id))
    mode = 'ok'
    mock.timers.tick(60000)
    check('automatic transient-error retry is traced with its reason', await waitFor(() => ends(added.id, 'connect', 'retry').some((l) => l.outcome === 'connected')), JSON.stringify(ends(added.id, 'connect')))
    await lastClient.close()
    mock.timers.tick(3000)
    check('transport close reconnect is traced with its reason', await waitFor(() => ends(added.id, 'connect', 'onclose').some((l) => l.outcome === 'connected')), JSON.stringify(ends(added.id, 'connect')))
    const missing = await run(connectors.callRaw(added.id, 'missing'))
    check('an MCP issue 429 error leaves subsequent requests available', missing.isError && !ends(added.id, 'call').at(-1).rateLimited && await run(connectors.call(added.id, 'read')) === 'ready')
    // The OAuth scope flow and rate-limit guard must coexist after merging their transport changes.
    mode = 'scope'
    const scoped = await run(connectors.add({ name: 'scope-fixture', url: `${base}/scope` }))
    check('scope challenges remain authorization requests, not rate limits', scoped.status === 'auth-required' && ends(scoped.id, 'connect').at(-1)?.outcome === 'auth-required' && ends(scoped.id, 'connect').at(-1)?.rateLimited === false)
    const challenged = scopeRequests
    const scopeError = await throws(() => run(connectors.callRaw(scoped.id, 'read')))
    await run(connectors.connect(scoped.id))
    check('pending scope consent blocks calls and background reconnect traffic', /additional permissions/.test(scopeError) && scopeRequests === challenged && connectors.get(scoped.id).status === 'auth-required')
    mode = 'ok'
    const api = await run(connectors.add({ name: 'github-api-fixture', url: `${base}/api`, api: { auth_type: 'bearer' }, credentials: { key: 'private-key' } }))
    for (const path of ['/429', '/limited', '/forbidden']) {
      const answer = await run(connectors.callRaw(api.id, 'request', { path }, { by: 'agent', depth: 0 }))
      const end = ends(api.id, 'call').at(-1)
      check(`API ${path} status and limit signal are traced without changing the result`, end?.httpStatus === answer.structuredContent.status && end?.rateLimited === (path !== '/forbidden'))
      mock.timers.tick(15 * 60_000 + 1)
    }
    const query = { by: 'workspace:first', depth: 0, read: { staleMs: 60_000 } }
    const apiRead = (caller = query) => run(connectors.call(api.id, 'request', { path: '/value' }, caller))
    const listed = await apiRead()
    await apiRead({ ...query, by: 'workspace:second' })
    check('API issue listings mentioning rate limits stay available and cacheable', listed.body.items[0].title.includes('#429') && apiReads === 1)
    await apiRead({ by: 'agent', depth: 0 })
    check('direct API agent calls remain fresh', apiReads === 2)
    await run(connectors.call(api.id, 'request', { path: '/value', method: 'POST' }))
    check('API writes invalidate shared reads', (await apiRead()).body.version === 1 && apiReads === 3 && apiWrites === 1)
    await run(connectors.update(api.id, { credentials: { key: 'private-new-key' } }))
    check('credential changes discard previous-identity API answers', (await apiRead()).body.identity === 'second' && apiReads === 4)
    const cooldown = await run(connectors.callRaw(api.id, 'request', { path: '/429' }))
    check('API rate limits block subsequent calls', cooldown.structuredContent.status === 429 && /rate limited/.test(await throws(apiRead)) && apiReads === 4)
    await run(connectors.update(api.id, { name: 'Renamed API fixture' }))
      .catch(() => {}) // Reconnect is itself blocked; renaming must not reset the cooldown.
    check('renaming cannot bypass cooldowns', /rate limited/.test(await throws(apiRead)) && apiReads === 4)
    check('integration traces omit credentials and upstream contents', !JSON.stringify(lines).includes('private'))
    check('all completed spans have timing and an outcome', lines.filter((l) => l.phase === 'end').every((l) => typeof l.ms === 'number' && typeof l.outcome === 'string'))
  } finally {
    mock.timers.reset()
    if (rt) await rt.dispose()
    Client.prototype.connect = previous.connect
    console.info = previous.info
    if (previous.flag === undefined) delete process.env.LYNX_TRACE_CONNECTORS
    else process.env.LYNX_TRACE_CONNECTORS = previous.flag
    await new Promise((r) => server.close(r))
  }
}

// ── voice mode: replies as they are read out
{
  console.log('voice')
  const { spoken, recognizerConfig, VOICE_MODELS, isVoiceModel, fixFailed } = await load('src/shared/voice.ts')
  check('markdown is read as words', spoken('**Done.** I made the [card](https://x.dev/a) `blue`.') === 'Done. I made the card blue.', spoken('**Done.** I made the [card](https://x.dev/a) `blue`.'))
  check('code blocks and lists are not read out', spoken('Changed it:\n\n```js\nconst a = 1\n```\n\n- one\n- two') === 'Changed it: one two')
  check('bare links are not spelt out', spoken('See https://example.com/a/b?c=1 for more') === 'See a link for more')
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
  const cut = spoken(long)
  check('a long reply stops at a sentence', cut.length <= 601 && cut.endsWith('.'), cut.slice(-40))
  check('every model has a recognizer config', VOICE_MODELS.every((m) => recognizerConfig(m.id, '/m').tokens === '/m/tokens.txt'))
  check('model ids are checked', isVoiceModel('parakeet') && !isVoiceModel('whisper') && !isVoiceModel(undefined))
  const limited = fixFailed('haiku', "Error invoking remote method 'sb:voice-fix': Error: You've hit your limit · resets 5pm")
  check('a correcting model at its usage limit is named, not voice mode', limited.startsWith("Haiku, the model that corrects what was heard, hit your account's usage limit (You've hit your limit · resets 5pm)") && limited.includes('Voice mode still works'), limited)
  check('a rate-limited Luna is named too', fixFailed('gpt-6-luna', 'API Error: 429 Too Many Requests').startsWith('Luna,'))
  check('other correction failures keep their reason', fixFailed('haiku', 'The model took too long') === 'Could not correct what was heard, so it went as heard: The model took too long')
}

// ── voice mode: correcting what was heard against the names Lynx knows
{
  console.log('voice vocabulary')
  const { correct, vocabulary, namesIn } = await load('src/shared/vocab.ts')
  const terms = vocabulary([{ texts: ['MotherDuck', 'Linear', 'PostHog', 'GitHub', 'Voice board', 'Home', 'Inbox', 'Globex pilot', 'Initech upsell', 'Stage 1', 'Attio'], weight: 1 }])
  const fix = (s) => correct(s, terms).text
  check('a misheard name is put right', fix('open lenear beside this one') === 'open Linear beside this one', fix('open lenear beside this one'))
  check('a name heard as two words is one again', fix('show me post hog events') === 'show me PostHog events' && fix('check git hub for open PRs') === 'check GitHub for open PRs')
  check('a plural or possessive heard on a name still finds it', fix('open the post hogs dashboard') === 'open the PostHog dashboard')
  check('the distinctive word of a longer name is a name too', fix('make the glow bex card blue') === 'make the Globex card blue', fix('make the glow bex card blue'))
  check('a multi-word name heard apart is put together', fix('the initech up sell is done') === 'the Initech upsell is done' && fix('open the voice bored') === 'open the Voice board')
  check('a short misspelling of a name is caught', fix('go to atio and find the deal') === 'go to Attio and find the deal')
  for (const s of ['put the card in my inbox', 'open the home page', 'add a cart to the stage', 'move it to the next page', 'I need more luck today'])
    check(`ordinary words are left alone: "${s}"`, fix(s) === s, fix(s))
  check('a name that only sounds alike in meaning (more luck, MotherDuck) is left to the model', fix('query more luck for the signups') === 'query more luck for the signups')
  check('each change says what was heard and what it became', JSON.stringify(correct('open lenear', terms).changes.map((c) => [c.from, c.to])) === '[["lenear","Linear"]]')
  check('names are found in running text, without the word opening a sentence', JSON.stringify(namesIn('I found 3 issues in the Orion project. The MotherDuck warehouse has Globex pilot data.')) === '["Orion","MotherDuck","Globex"]', JSON.stringify(namesIn('I found 3 issues in the Orion project. The MotherDuck warehouse has Globex pilot data.')))
}

// ── store
{
  console.log('store')
  const { openData } = await load('src/main/services/Data.ts')
  const dir = join(tmp, 'data')
  let d = openData(dir)
  check('put creates', d.put('prs/seen', '1', { title: 'a', n: 1, open: true, author: { login: 'ada' } }, { by: 't' }).created === true)
  check('put again updates, not creates', d.put('prs/seen', '1', { title: 'a2', n: 1, open: true, author: { login: 'ada' } }, { by: 't' }).created === false)
  const absent = d.put('prs/seen', '1', { title: 'zzz' }, { by: 't', ifAbsent: true })
  check('ifAbsent leaves an existing record alone', absent.created === false && absent.value.title === 'a2' && d.get('prs/seen', '1').title === 'a2')
  d.put('prs/seen', '2', { title: 'b', n: 5, open: false, author: { login: 'bob' } }, { by: 't' })
  d.put('prs/seen', '10', { title: 'c', n: 3, open: true, author: { login: 'ada' } }, { by: 't' })
  d.put('other', 'x', { a: 1 }, { by: 't' })
  const q = (o) => d.query({ collection: 'prs/seen', ...o }).items.map((r) => r.key).join(',')
  check('query: all, by key', q({}) === '1,10,2', q({}))
  check('query: equality on a nested field', q({ where: [{ field: 'author.login', value: 'ada' }] }) === '1,10')
  check('query: booleans', q({ where: [{ field: 'open', value: false }] }) === '2')
  check('query: comparison + order by field desc', q({ where: [{ field: 'n', op: '>=', value: 3 }], order_by: 'n', desc: true }) === '2,10')
  check('query: in', q({ where: [{ field: 'n', op: 'in', value: [1, 5] }] }) === '1,2')
  check('query: prefix', q({ prefix: '1' }) === '1,10')
  const page = d.query({ collection: 'prs/seen', limit: 2 })
  check('query: limit reports more', page.items.length === 2 && page.more === true)
  check('query: bad field is refused', /Bad field/.test(await throws(() => d.query({ collection: 'prs/seen', where: [{ field: "a') OR 1=1 --", value: 1 }] }))))
  check('collections are counted', JSON.stringify(d.collections().map((c) => [c.collection, c.count])) === '[["other",1],["prs/seen",3]]')
  check('null value is refused', /db_delete/.test(await throws(() => d.put('c', 'k', null, { by: 't' }))))
  check('oversized value is refused', /at most/.test(await throws(() => d.put('c', 'k', { s: 'x'.repeat(1_100_000) }, { by: 't' }))))

  // history and point-in-time
  await sleep(5)
  const t0 = new Date().toISOString()
  await sleep(5)
  d.put('prs/seen', '1', { title: 'changed' }, { by: 'tool:x' })
  d.remove('prs/seen', '2', 'tool:x')
  d.put('prs/seen', 'new', { title: 'new' }, { by: 'tool:x' })
  d.put('other', 'x', { a: 2 }, { by: 'tool:x' })
  const h = d.history('prs/seen', '1')
  check('history is newest first, with who', h.length === 3 && h[0].by === 'tool:x' && h[0].value.title === 'changed' && h[2].value.title === 'a', JSON.stringify(h.map((v) => v.by)))
  check('history shows deletions', d.history('prs/seen', '2')[0].deleted === true)
  check('read as of a past time', d.get('prs/seen', '1', t0).title === 'a2' && d.get('prs/seen', 'new', t0) === null && d.get('prs/seen', '2', t0).title === 'b')
  const one = d.restore({ at: t0, collection: 'prs/seen', key: '1', by: 'user' })
  check('restore one key', one.changed === 1 && d.get('prs/seen', '1').title === 'a2' && d.get('prs/seen', 'new') !== null)
  const col = d.restore({ at: t0, collection: 'prs/seen', by: 'user' })
  check('restore a collection: deleted comes back, later additions go', col.changed === 2 && d.get('prs/seen', '2').title === 'b' && d.get('prs/seen', 'new') === null && d.get('other', 'x').a === 2, JSON.stringify(col))
  check('restore is itself in the history', d.history('prs/seen', 'new')[0].deleted === true && d.history('prs/seen', 'new')[0].by === 'user')
  check('restoring to the same time again changes nothing', d.restore({ at: t0, by: 'user' }).changed === 1 && d.restore({ at: t0, by: 'user' }).changed === 0)
  check('everything is back', d.get('other', 'x').a === 1)

  // files
  const f = d.filePut('reports/a.txt', Buffer.from('hello'), 'text/plain', 't')
  check('file put and get', f.size === 5 && d.fileGet('reports/a.txt').data.toString() === 'hello' && d.fileGet('reports/a.txt').content_type === 'text/plain')
  await sleep(5)
  const t1 = new Date().toISOString()
  await sleep(5)
  d.filePut('reports/a.txt', Buffer.from('hello again'), 'text/plain', 't')
  d.filePut('img.bin', Buffer.from([0, 1, 2, 255]), undefined, 't')
  check('file list with prefix', d.fileList('reports/').length === 1 && d.fileList().length === 2)
  check('file as of a past time', d.fileGet('reports/a.txt', t1).data.toString() === 'hello')
  check('file history hides hashes', d.fileHistory('reports/a.txt').length === 2 && !('hash' in d.fileHistory('reports/a.txt')[0].value))
  check('file restore', d.fileRestore({ at: t1, by: 'user' }).changed === 2 && d.fileGet('reports/a.txt').data.toString() === 'hello' && d.fileGet('img.bin') === null)
  check('file delete', d.fileRemove('reports/a.txt', 't') === true && d.fileGet('reports/a.txt') === null && d.fileRemove('reports/a.txt', 't') === false)
  check('files are not records', d.collections().every((c) => c.collection !== '') && d.query({ collection: 'reports' }).items.length === 0)

  // retention: with a zero-day window everything before "now" is outside it
  d.put('keep', 'live', { v: 1 }, { by: 't' })
  d.put('keep', 'live', { v: 2 }, { by: 't' })
  d.put('keep', 'gone', { v: 1 }, { by: 't' })
  d.remove('keep', 'gone', 't')
  d.close()
  await sleep(5)
  d = openData(dir, { retentionDays: 0 })
  const rows = d.sql.prepare('SELECT collection, key, value FROM log ORDER BY seq').all()
  check('pruning keeps exactly the latest entry of each live key', rows.length === d.sql.prepare('SELECT count(*) n FROM records').get().n && rows.every((r) => r.value !== null), `${rows.length} log rows`)
  check('pruning keeps current values', d.get('keep', 'live').v === 2 && d.get('keep', 'gone') === null && d.get('prs/seen', '1').title === 'a2')
  check('pruned history is refused, not answered wrongly', /History is kept/.test(await throws(() => d.get('keep', 'live', t0))) && /History is kept/.test(await throws(() => d.restore({ at: t0, by: 'user' }))))
  const { readdirSync } = await import('node:fs')
  check('unreferenced file contents are removed', readdirSync(join(dir, 'blobs')).length === 0, readdirSync(join(dir, 'blobs')).join(','))
  d.close()
}

// ── cron
{
  console.log('cron')
  const { nextRun, parseCron } = await load('src/shared/cron.ts')
  const at = (s) => new Date(s)
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const next = (expr, from) => fmt(nextRun(expr, at(from)))
  check('every minute', next('* * * * *', '2026-10-11T10:00:30') === '2026-10-11 10:01')
  check('every 10 minutes', next('*/10 * * * *', '2026-10-11T10:10:00') === '2026-10-11 10:20')
  check('daily at 09:30, already past today', next('30 9 * * *', '2026-10-11T10:00:00') === '2026-10-12 09:30')
  check('weekdays at 9 (11 Oct 2026 is a Sunday)', next('0 9 * * 1-5', '2026-10-11T10:00:00') === '2026-10-12 09:00')
  check('sunday as 7', next('0 9 * * 7', '2026-10-11T10:00:00') === '2026-10-18 09:00')
  check('first of the month', next('0 0 1 * *', '2026-10-11T10:00:00') === '2026-11-01 00:00')
  check('day-of-month or day-of-week when both are given', next('0 0 13 * 1', '2026-10-11T10:00:00') === '2026-10-12 00:00')
  check('lists and ranges with steps', next('5,35 8-18/2 * * *', '2026-10-11T10:06:00') === '2026-10-11 10:35')
  check('year rollover', next('0 0 1 1 *', '2026-10-11T10:00:00') === '2027-01-01 00:00')
  const sec = (expr, from) => {
    const d = nextRun(expr, at(from))
    return `${fmt(d)}:${String(d.getSeconds()).padStart(2, '0')}`
  }
  check('five fields run at the start of the minute', sec('* * * * *', '2026-10-11T10:00:30') === '2026-10-11 10:01:00')
  check('every second', sec('* * * * * *', '2026-10-11T10:00:30.400') === '2026-10-11 10:00:31')
  check('every second, over the minute', sec('* * * * * *', '2026-10-11T23:59:59') === '2026-10-12 00:00:00')
  check('every 5 seconds', sec('*/5 * * * * *', '2026-10-11T10:00:31') === '2026-10-11 10:00:35' && sec('*/5 * * * * *', '2026-10-11T10:00:55') === '2026-10-11 10:01:00')
  check('second 30 of every tenth minute', sec('30 */10 * * * *', '2026-10-11T10:00:31') === '2026-10-11 10:10:30')
  check('seconds out of range are explained', /second runs from 0 to 59/.test(await throws(() => parseCron('60 * * * * *'))))
  check('wrong field count is explained', /five fields/.test(await throws(() => parseCron('* * * *'))) && /five fields/.test(await throws(() => parseCron('* * * * * * *'))))
  check('out of range is explained', /hour runs from 0 to 23/.test(await throws(() => parseCron('0 24 * * *'))))
  check('impossible dates do not hang', /never comes round/.test(await throws(() => nextRun('0 0 31 2 *', at('2026-10-11T10:00:00')))))
}

// ── sandbox
{
  console.log('sandbox')
  const { execute, inspect, LIMITS } = await load('src/main/sandbox.ts')
  const calls = []
  const seen = new Set()
  const host = async (connector, tool, args) => {
    calls.push(`${connector}.${tool}`)
    await sleep(5)
    if (tool === 'list') return [{ number: 1 }, { number: 2 }]
    if (tool === 'db_put') return seen.has(args.key) ? { created: false } : (seen.add(args.key), { created: true })
    if (tool === 'db_get') return { value: { n: 7 } }
    if (tool === 'boom') throw new Error('GitHub said 401')
    if (tool === 'slow') return sleep(3000).then(() => 'late')
    if (tool === 'text') return 'plain text'
    return { echo: args }
  }
  const tool = `
export const description = 'Start a review for each new PR'
export const input = { repo: { type: 'string', description: 'owner/name' } }
export default async function ({ repo }) {
  const prs = await call('github', 'list', { repo })
  const started = []
  for (const pr of prs) {
    const { created } = await db.put('pr-reviews/seen', String(pr.number), { repo }, { ifAbsent: true })
    if (!created) continue
    console.log('reviewing', pr.number, { repo })
    started.push((await call('agents', 'session_start', { prompt: \`Review #\${pr.number}\` })).echo.prompt)
  }
  return { started }
}`
  const meta = await inspect('check_prs', tool)
  check('reads description and input', meta.description === 'Start a review for each new PR' && meta.inputSchema.type === 'object' && meta.inputSchema.properties.repo.type === 'string', JSON.stringify(meta))
  const full = await inspect('t', `export const input = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }; export default () => 1`)
  check('a full schema is kept as written', full.inputSchema.required[0] === 'a' && full.description === '')
  const first = await execute('check_prs', tool, { repo: 'acme/web' }, host)
  check('runs the example', JSON.stringify(first.result) === '{"started":["Review #1","Review #2"]}', JSON.stringify(first.result))
  check('captures console output', first.logs.length === 2 && first.logs[0] === 'reviewing 1 {"repo":"acme/web"}', JSON.stringify(first.logs))
  const second = await execute('check_prs', tool, { repo: 'acme/web' }, host)
  check('second run starts nothing', JSON.stringify(second.result) === '{"started":[]}' && second.logs.length === 0)
  check('calls went through the host', calls.filter((c) => c === 'agents.session_start').length === 2 && calls.includes('app.db_put'))
  const run = (body, limits) => execute('t', `export default async function (input) { ${body} }`, { n: 2 }, host, { ...LIMITS, ...limits })
  check('modern syntax: classes, getters, generators, destructuring', (await run(`class P { #n; constructor(n){ this.#n = n } get double(){ return this.#n * 2 } static of(n){ return new P(n) } } function* g(){ yield* [1,2] } const { a, ...rest } = { a: 1, b: 2 }; return [P.of(input.n).double, [...g()], rest, structuredClone({ a: [1] }).a[0], 2n ** 64n > 1n]`)).result[0] === 4)
  check('helpers: db.get unwraps, tools.x calls the tools connector', JSON.stringify((await run(`return [await db.get('c', 'k'), (await tools.other({ a: 1 })).echo]`)).result) === '[{"n":7},{"a":1}]' && calls.includes('tools.other'))
  check('plain-text results come back as strings', (await run(`return await call('x', 'text')`)).result === 'plain text')
  check('undefined result becomes null', (await run(`return undefined`)).result === null)
  check('a failing call can be caught, with its message', (await run(`try { await call('github', 'boom') } catch (e) { return e.message }`)).result === 'GitHub said 401')
  const uncaught = await throws(() => run(`await call('github', 'boom')`))
  check('an uncaught failure fails the run with the call\'s own message', uncaught === 'GitHub said 401', uncaught)
  const thrown = await throws(() => run(`const x = null; return x.y`))
  check('errors in tool code say where', /TypeError.*t\.js:1/.test(thrown), thrown)
  const out = JSON.stringify((await run(`return [typeof process, typeof require, typeof fetch, typeof setTimeout, (0, eval)('typeof process'), new Function('return typeof process')(), Object.keys(globalThis).sort().join(' ')]`)).result)
  check('no way out: process, require, fetch, timers, even through eval', out === '["undefined","undefined","undefined","undefined","undefined","undefined","__call __log __run call console db files notify structuredClone tools"]', out)
  let t = Date.now()
  const loop = await throws(() => run(`while (true) {}`, { cpuMs: 200 }))
  check('a busy loop is stopped', /computed for too long/.test(loop) && Date.now() - t < 1500, `${loop} after ${Date.now() - t}ms`)
  check('a busy loop after a call is stopped too', /computed for too long/.test(await throws(() => run(`await call('x', 'y'); while (true) {}`, { cpuMs: 200 }))))
  check('a busy loop while loading is stopped', /computed for too long/.test(await throws(() => inspect('t', `while (true) {}; export default () => 1`))))
  t = Date.now()
  const slow = await throws(() => run(`return await call('x', 'slow')`, { timeoutMs: 300 }))
  check('a run that waits too long is stopped', /ran for more than/.test(slow) && Date.now() - t < 1500, slow)
  // Allocate directly so this tests the memory cap without racing the CPU limit on slower runs.
  check('an allocation within the memory cap succeeds', (await run(`return new ArrayBuffer(1 << 20).byteLength`, { memoryBytes: 8 << 20 })).result === 1 << 20)
  const memory = await throws(() => run(`return new ArrayBuffer(16 << 20).byteLength`, { memoryBytes: 8 << 20 }))
  check('memory is capped', /out of memory|memory/i.test(memory), memory)
  // Strings and buffers count as much as objects: the heap is what is capped, so a run fills it in moments and is
  // stopped for memory, never for computing too long first.
  for (const [what, body] of [
    ['strings', `const a = []; while (true) a.push('x'.repeat(100000) + a.length)`],
    ['buffers', `const a = []; while (true) a.push(new Uint8Array(1 << 20))`],
    ['objects', `const a = []; while (true) a.push({ n: a.length, list: [1, 2, 3] })`],
  ]) {
    t = Date.now()
    const oom = await throws(() => run(body, { cpuMs: 5000, memoryBytes: 8 << 20 }))
    check(`memory is capped: ${what}`, /^InternalError: out of memory/.test(oom) && Date.now() - t < 2000, `${oom} after ${Date.now() - t}ms`)
  }
  const big = await throws(() => run(`return 'x'.repeat(100 << 20).length`))
  check('one string past the cap is refused', /out of memory/.test(big), big)
  check('and the next run has all of its memory', (await run(`return 'x'.repeat(32 << 20).length`)).result === 32 << 20)
  check('a thrown null is still null', (await throws(() => run(`throw null`))) === 'null')
  check('calls are capped', /at most 3 calls/.test(await throws(() => run(`for (let i = 0; i < 10; i++) await call('x', 'y'); return 1`, { maxCalls: 3 }))))
  // Limits are for a run and everything it calls: a nested run draws on what the outer one has left.
  const shared = { calls: 0, cpuMs: 0, until: Date.now() + 60000 }
  const nested = (body, limits) => execute('t', `export default async function () { ${body} }`, {}, host, { ...LIMITS, ...limits }, shared)
  await nested(`await call('x', 'y'); await call('x', 'y')`, { maxTreeCalls: 3 })
  check('calls are capped across nested runs', /at most 3 calls together/.test(await throws(() => nested(`await call('x', 'y'); await call('x', 'y')`, { maxTreeCalls: 3 }))))
  const spinner = `for (let n = 0; n < 50; n++) { const end = Date.now() + 60; while (Date.now() < end) {} await call('x', 'y') } return 1`
  const total = await throws(() => run(spinner, { cpuMs: 1000, cpuTotalMs: 300 }))
  check('computing is capped in total, not only between calls', /computed for too long/.test(total), total)
  check('a nested run has only the time the outer run has left', /ran for more than/.test(await throws(() => execute('t', `export default async () => await call('x', 'slow')`, {}, host, LIMITS, { calls: 0, cpuMs: 0, until: Date.now() + 200 }))))
  check('logs survive a failure', (await run(`console.log('before'); throw new Error('bad')`).catch((e) => e.logs))?.[0] === 'before')
  check('syntax errors are reported with the line', /SyntaxError.*bad\.js:2/.test(await throws(() => inspect('bad', `export default function () {\n  return {{ \n}`))))
  check('a tool without a default export is refused', /export default/.test(await throws(() => inspect('t', `export const description = 'x'`))))
  check('calls while loading are refused', /while it loads|export default/.test(await throws(() => inspect('t', `const x = await call('a', 'b'); export default () => x`))))
  await sleep(50)
  check('after a timeout and failures, runs still work', (await run(`return 1 + input.n`)).result === 3)
  t = Date.now()
  await Promise.all(Array.from({ length: 20 }, () => run(`return (await call('x', 'y', { a: 1 })).echo.a`)))
  console.log(`      20 concurrent runs: ${Date.now() - t}ms`)
}

// ── schedules in words
{
  console.log('cron in words')
  const { cronWords } = await load('src/shared/cronWords.ts')
  const cases = {
    '*/10 * * * *': 'Every 10 minutes',
    '* * * * *': 'Every minute',
    '* * * * * *': 'Every second',
    '*/5 * * * * *': 'Every 5 seconds',
    '*/10 * * * * 1-5': 'Every 10 seconds on weekdays',
    '0 */10 * * * *': 'Every 10 minutes',
    '30 */10 * * * *': '30 */10 * * * *',
    '15 * * * *': 'Every hour at :15',
    '0 */2 * * *': 'Every 2 hours at :00',
    '0 9 * * *': 'Every day at 09:00',
    '30 9 * * 1-5': 'Weekdays at 09:30',
    '0 10 * * 6,0': 'Weekends at 10:00',
    '0 9 * * 1': 'Mondays at 09:00',
    '0 9 * * 7': 'Sundays at 09:00',
    '0 9 * * 1,3,5': 'Monday, Wednesday and Friday at 09:00',
    '*/5 * * * 1-5': 'Every 5 minutes on weekdays',
    '0 8 1 * *': 'Day 1 of every month at 08:00',
    // Not sayable in a phrase: shown as written.
    '0 9 1 1 *': '0 9 1 1 *',
    '0,30 9-17 * * *': '0,30 9-17 * * *',
    '0 9 1 * 1': '0 9 1 * 1',
    'nonsense': 'nonsense',
  }
  for (const [expr, words] of Object.entries(cases)) check(`${expr} -> ${words}`, cronWords(expr) === words, cronWords(expr))
}

// ── code in messages
{
  console.log('code')
  const { highlight, splitFences } = await load('src/kit/highlight.ts')
  const html = highlight('const a = "<b>" // hi', 'js')
  check('javascript is coloured by token', /hljs-keyword">const/.test(html) && /hljs-string/.test(html) && /hljs-comment/.test(html), html)
  check('the code itself is escaped', html.includes('&lt;b&gt;') && !html.includes('<b>'))
  check('fence names people use are known', ['ts', 'tsx', 'jsx', 'json', 'py', 'sh', 'shell', 'html', 'yml', 'sql', 'diff', 'go', 'rust', 'md'].every((l) => highlight('x', l) !== null))
  check('an unknown language is left plain', highlight('x', 'brainfuck') === null && highlight('x', '') === null && highlight('x', undefined) === null)
  const kinds = (t) => splitFences(t).map((p) => (p.kind === 'code' ? `code:${p.language}:${p.code}` : `text:${p.text}`)).join(' | ')
  check('a message without code is one piece of text', kinds('# not a heading\n- not a list') === 'text:# not a heading\n- not a list')
  check('fenced code is set apart with its language', kinds('look:\n```js\nconst a = 1\n```\nok?') === 'text:look: | code:js:const a = 1 | text:ok?', kinds('look:\n```js\nconst a = 1\n```\nok?'))
  check('a fence left open runs to the end', kinds('```py\nprint(1)\nprint(2)') === 'code:py:print(1)\nprint(2)', kinds('```py\nprint(1)\nprint(2)'))
  check('an empty fence is empty code', kinds('```\n```') === 'code::', kinds('```\n```'))
  check('two blocks stay two', kinds('```\na\n```\nand\n```sh\nb\n```') === 'code::a | text:and | code:sh:b', kinds('```\na\n```\nand\n```sh\nb\n```'))
  const { inFence } = await load('src/kit/highlight.ts')
  check('three backticks on one line are not a block', kinds('run ```npm test``` now') === 'text:run ```npm test``` now' && kinds('```npm test```') === 'text:```npm test```' && !inFence('```npm test``` fails'))
  check('three backticks mid-sentence do not open a block', !inFence('what does ``` mean?') && kinds('what does ``` mean?') === 'text:what does ``` mean?')
  check('a fence may follow text on its line', kinds('like this: ```js\nlet a\n```') === 'text:like this: | code:js:let a', kinds('like this: ```js\nlet a\n```'))
  check('code may start on the fence line and end before the closing one', kinds('```const x = 1\nconst y = 2```') === 'code::const x = 1\nconst y = 2', kinds('```const x = 1\nconst y = 2```'))
  check('a language may be followed by more', kinds('```js title=a.js\nlet a\n```') === 'code:js:let a', kinds('```js title=a.js\nlet a\n```'))
  check('the caret is in code only while a fence is open', inFence('a\n```js\nlet a') && !inFence('a\n```js\nlet a\n```') && !inFence('a\n```js\nlet a\n```\nmore') && inFence('```\n```\n```py'))
  check('code may follow a language without a space', kinds('```a=b\nc\n```') === 'code::a=b\nc', kinds('```a=b\nc\n```'))
  {
    // One very long line must not take the parser long, however it is built.
    const t = Date.now()
    for (const line of ['```' + 'a'.repeat(200000) + '`', '`'.repeat(200000), '```' + ' '.repeat(200000) + 'x', 'x' + ' ```'.repeat(60000) + ' y']) splitFences(line), inFence(`\`\`\`js\n${line}`)
    check('a very long line is read quickly', Date.now() - t < 1500, `${Date.now() - t} ms`)
  }
  check('an indented closing fence closes', kinds('```js\n  a\n  ```\nafter') === 'code:js:  a | text:after', kinds('```js\n  a\n  ```\nafter'))
  check('backticks mid-line do not open a block', kinds('use ```x``` here') === 'text:use ```x``` here')
}

// ── notifications
{
  console.log('notifications')
  const { cleanLink } = await load('src/main/services/Notifications.ts')
  check('a page of the workspace is a link', cleanLink('/prs/42?tab=files') === '/prs/42?tab=files')
  check('a web address is a link', cleanLink('https://github.com/a/b/pull/1') === 'https://github.com/a/b/pull/1')
  check('no link is fine', cleanLink(undefined) === undefined && cleanLink('') === undefined)
  for (const bad of ['prs/42', 'javascript:alert(1)', 'file:///etc/passwd', '//evil.example/x', 'sbw://other/', '/a b']) check(`"${bad}" is refused`, /link must be/.test(await throws(() => cleanLink(bad))))
}

// ── files dropped on a conversation
{
  console.log('attachments')
  const { attachments } = await load('src/main/attachments.ts')
  const { homedir, tmpdir } = await import('node:os')
  const { existsSync } = await import('node:fs')
  const { readFile, realpath, utimes, writeFile } = await import('node:fs/promises')
  const data = await realpath(mkdtempSync(join(tmpdir(), 'sb-unit-data-')))
  const elsewhere = await realpath(mkdtempSync(join(tmpdir(), 'sb-unit-drop-')))
  const staging = attachments(data)
  const inside = join(data, 'report.pdf')
  await writeFile(inside, 'pdf')
  const a = await staging.stage({ path: inside, name: 'report.pdf' })
  check('a file the engine can read already goes as it is', a.path === inside && a.name === 'report.pdf' && a.size === 3, JSON.stringify(a))
  const outside = join(elsewhere, 'notes.txt')
  await writeFile(outside, 'hello')
  const b = await staging.stage({ path: outside, name: 'notes.txt' })
  const underHome = outside.startsWith(homedir() + '/')
  check('a file outside the engine\'s folders is copied into the data folder', underHome ? b.path === outside : b.path.startsWith(join(data, 'attachments') + '/') && (await readFile(b.path, 'utf8')) === 'hello', b.path)
  const c = await staging.stage({ name: '../../evil\u0001.png', bytes: new Uint8Array([1, 2, 3]) })
  check('bytes are written under the data folder with a clean name', c.path.startsWith(join(data, 'attachments') + '/') && c.name === 'evil.png' && c.size === 3, JSON.stringify(c))
  check('a folder is refused', /is a folder/.test(await throws(() => staging.stage({ path: elsewhere, name: 'stuff' }))))
  check('a missing file is refused', /Could not read/.test(await throws(() => staging.stage({ path: join(elsewhere, 'gone.txt') }))))
  check('nothing at all is refused', /Nothing to attach/.test(await throws(() => staging.stage({}))))
  const old = join(c.path, '..')
  await utimes(old, new Date(Date.now() - 2 * 864e5), new Date(Date.now() - 2 * 864e5))
  await staging.sweep()
  check('copies older than a day are swept', !existsSync(old) && existsSync(inside))
  rmSync(data, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
}

// ── connector icons come from the service's own site
{
  console.log('connector icons')
  const { rootDomain, iconLinks, lightSvg } = await load('src/shared/siteIcon.ts')
  // Mercury's icon turns near-white in dark mode, which leaves a blank chip: the light one is kept.
  const mercury = '<svg xmlns="http://www.w3.org/2000/svg"><style>@media (prefers-color-scheme:dark){#logo{fill:#f4f5f9}}</style><path id="logo" fill="#272735" d="M0 0h1"/></svg>'
  check('an icon that turns white in dark mode keeps its light colours', lightSvg(mercury) === '<svg xmlns="http://www.w3.org/2000/svg"><style></style><path id="logo" fill="#272735" d="M0 0h1"/></svg>', lightSvg(mercury))
  const both = '<style>.a{fill:red}@media (prefers-color-scheme: dark) { .a { fill: white } .b { fill: grey } }@media (min-width: 10px){.c{fill:blue}}</style>'
  check('only the dark rules go, with every rule inside them', lightSvg(both) === '<style>.a{fill:red}@media (min-width: 10px){.c{fill:blue}}</style>', lightSvg(both))
  check('an icon with none is left alone', lightSvg('<svg><path fill="#000"/></svg>') === '<svg><path fill="#000"/></svg>')
  check('a subdomain goes to its site', rootDomain('https://mcp.linear.app/mcp') === 'linear.app' && rootDomain('https://api.githubcopilot.com/mcp/') === 'githubcopilot.com')
  check("a country's second level is kept, a short site name is not", rootDomain('https://mcp.example.co.uk/x') === 'example.co.uk' && rootDomain('https://mcp.exa.ai/mcp') === 'exa.ai' && rootDomain('https://api.acme.com.br') === 'acme.com.br')
  check('local and missing addresses have none', [undefined, '', 'http://127.0.0.1:53075/mcp', 'http://localhost:3000', 'not a url'].every((u) => rootDomain(u) === null))
  const html = `<link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="/favicon/favicon.ico" sizes="any"/><link rel='icon' type='image/png' sizes='32x32' href='https://cdn.example.com/i32.png'><link rel="mask-icon" href="/mask.svg"><link rel="stylesheet" href="/a.css">`
  const links = iconLinks(html, 'https://granola.example/')
  check('declared icons are found and resolved, sized ones first', links.join(' ') === 'https://cdn.example.com/i32.png https://granola.example/favicon/favicon.ico https://granola.example/apple.png', links.join(' '))
  check('an SVG icon wins', iconLinks('<link rel="icon" href="/a.ico"><link rel="icon" type="image/svg+xml" href="/a.svg">', 'https://x.example/')[0] === 'https://x.example/a.svg')
}

// ── workspace drafts: agents edit their own copy and publish it, one at a time
{
  console.log('drafts')
  const { writeFileSync, readFileSync, existsSync, readdirSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { Layer, ManagedRuntime } = await import('effect')
  const { ConfigLive } = await load('src/main/services/Config.ts')
  const { EventsLive } = await load('src/main/services/Events.ts')
  const { WorkspacesLive } = await load('src/main/services/Workspaces.ts')
  const { Drafts, DraftsLive } = await load('src/main/services/Drafts.ts')
  const dataDir = join(tmp, 'drafts-data')
  const workspacesDir = join(dataDir, 'workspaces')
  mkdirSync(join(workspacesDir, 'demo'), { recursive: true })
  const app = (title, extra = '') => `export default function App() {\n  return (\n    <main>\n      <h1>${title}</h1>\n      <p>Body</p>\n${extra}    </main>\n  )\n}\n`
  writeFileSync(join(workspacesDir, 'demo', 'App.jsx'), app('Hello'))
  writeFileSync(join(workspacesDir, 'demo', 'workspace.json'), JSON.stringify({ name: 'Demo', connectors: {}, uses: {}, createdAt: new Date().toISOString() }))
  const base = Layer.mergeAll(ConfigLive({ appRoot: process.cwd(), outDir: join(process.cwd(), 'out', 'main'), dataDir, workspacesDir }), EventsLive)
  const rt = ManagedRuntime.make(DraftsLive.pipe(Layer.provideMerge(WorkspacesLive.pipe(Layer.provideMerge(base)))))
  const drafts = await rt.runPromise(Drafts)
  const run = (e) => rt.runPromise(e)
  const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

  const a = await run(drafts.open('demo', 'conv-a'))
  const b = await run(drafts.open('demo', 'conv-b'))
  check('a draft is its own folder, outside the workspace', a.dir !== b.dir && existsSync(join(a.dir, 'App.jsx')) && !a.dir.startsWith(join(workspacesDir, 'demo')))
  check('the workspace became a repository that ignores built output', existsSync(join(workspacesDir, 'demo', '.git')) && /\.out\//.test(readFileSync(join(workspacesDir, 'demo', '.gitignore'), 'utf8')))
  check('bad draft names are refused', /letters, digits/.test(await throws(() => run(drafts.open('demo', '../x')))))

  writeFileSync(join(a.dir, 'App.jsx'), app('Hello from A'))
  check('a draft does not touch what is on screen', readFileSync(join(workspacesDir, 'demo', 'App.jsx'), 'utf8').includes('<h1>Hello</h1>'))
  const pa = await run(drafts.publish('demo', 'conv-a', 'Retitle'))
  check('publishing puts the draft on screen', pa.published === true && readFileSync(join(workspacesDir, 'demo', 'App.jsx'), 'utf8').includes('Hello from A'), JSON.stringify(pa))
  check('publishing again with nothing new does nothing', (await run(drafts.publish('demo', 'conv-a', 'Again'))).reason === 'nothing')

  writeFileSync(join(b.dir, 'App.jsx'), app('Hello', '      <footer>B</footer>\n'))
  const pb = await run(drafts.publish('demo', 'conv-b', 'Add a footer'))
  check('a draft behind what is published is refused, with what changed', pb.published === false && pb.reason === 'behind' && pb.changes.some((c) => c.message === 'Retitle'), JSON.stringify(pb))
  check('a refused publish changes nothing on screen', !readFileSync(join(workspacesDir, 'demo', 'App.jsx'), 'utf8').includes('footer'))
  sh(b.dir, 'rebase', 'main')
  const pb2 = await run(drafts.publish('demo', 'conv-b', 'Add a footer'))
  const both = readFileSync(join(workspacesDir, 'demo', 'App.jsx'), 'utf8')
  check('after a rebase it publishes, keeping both changes', pb2.published === true && both.includes('Hello from A') && both.includes('<footer>B</footer>'), JSON.stringify(pb2))

  writeFileSync(join(a.dir, 'App.jsx'), 'export default function App( {')
  check('a draft has to build to publish', (await run(drafts.build('demo', 'conv-a'))).status === 'error' && (await run(drafts.publish('demo', 'conv-a', 'Break it'))).reason === 'behind')
  sh(a.dir, 'reset', '--hard', 'main')
  writeFileSync(join(a.dir, 'App.jsx'), 'export default function App( {')
  const broken = await run(drafts.publish('demo', 'conv-a', 'Break it'))
  check('a draft that does not build is refused with the errors', broken.reason === 'build' && broken.errors.length > 0, JSON.stringify(broken))
  sh(a.dir, 'reset', '--hard', 'main')

  writeFileSync(join(workspacesDir, 'demo', 'Note.md'), 'by hand')
  const h = await run(drafts.history('demo'))
  check('history: published changes newest first, with edits made in the folder', h.changes.map((c) => c.message).join(' | ') === 'Changed directly in the folder | Add a footer | Retitle | Start of history', h.changes.map((c) => c.message).join(' | '))
  check('history: who published each change', h.changes[1].by === 'Agent (conv-b)' && h.changes[1].files.includes('App.jsx'))
  check('history: drafts in progress', h.drafts.map((d) => d.draft).sort().join(',') === 'conv-a,conv-b')
  const retitle = h.changes.find((c) => c.message === 'Retitle')
  const r = await run(drafts.revert('demo', retitle.commit))
  const after = readFileSync(join(workspacesDir, 'demo', 'App.jsx'), 'utf8')
  check('revert undoes one change and keeps the later ones', r.reverted === true && after.includes('<h1>Hello</h1>') && after.includes('<footer>B</footer>'), JSON.stringify(r))
  check('revert of the start of history is refused', (await run(drafts.revert('demo', h.changes.at(-1).commit))).reverted === false)
  check('discarding removes the draft', (await run(drafts.discard('demo', 'conv-a'))) === true && !existsSync(a.dir))
  await rt.dispose()
}

// ── workspace names: no two workspaces share one
{
  console.log('workspace names')
  const { Layer, ManagedRuntime } = await import('effect')
  const { ConfigLive } = await load('src/main/services/Config.ts')
  const { EventsLive } = await load('src/main/services/Events.ts')
  const { Workspaces, WorkspacesLive } = await load('src/main/services/Workspaces.ts')
  const { freeName } = await load('src/shared/workspaceNames.ts')
  const dataDir = join(tmp, 'names-data')
  const workspacesDir = join(dataDir, 'workspaces')
  mkdirSync(workspacesDir, { recursive: true })
  const rt = ManagedRuntime.make(WorkspacesLive.pipe(Layer.provideMerge(Layer.mergeAll(ConfigLive({ appRoot: process.cwd(), outDir: join(process.cwd(), 'out', 'main'), dataDir, workspacesDir }), EventsLive))))
  const ws = await rt.runPromise(Workspaces)
  const run = (e) => rt.runPromise(e)

  check('a free name is kept, a taken one gets the first free number', freeName('Inbox', ['Mail']) === 'Inbox' && freeName('Inbox', ['inbox', 'Inbox 2']) === 'Inbox 3')
  const inbox = await run(ws.create({ name: 'Inbox' }))
  check('creating a second workspace of a name is refused', /already a workspace named “Inbox”/.test(await throws(() => run(ws.create({ name: '  inbox ' })))))
  const other = await run(ws.create({ name: 'Other' }))
  check('renaming onto a name another has is refused', /already a workspace named/.test(await throws(() => run(ws.update(other.id, { name: 'INBOX' })))))
  check('a workspace keeps its own name, or changes its case', (await run(ws.update(inbox.id, { name: 'Inbox' }))).name === 'Inbox' && (await run(ws.update(inbox.id, { name: 'inbox' }))).name === 'inbox')
  await run(ws.update(other.id, { archived: true }))
  check('an archived workspace still holds its name', /\(archived\)/.test(await throws(() => run(ws.create({ name: 'Other' })))))
  const c1 = await run(ws.fork(inbox.id))
  const c2 = await run(ws.fork(inbox.id))
  check('copies are named "<name> copy", then numbered', c1.name === 'inbox copy' && c2.name === 'inbox copy 2', `${c1.name}, ${c2.name}`)
  check('a copy given a taken name is refused', /already a workspace named/.test(await throws(() => run(ws.fork(inbox.id, 'Other')))))
  check('freeName counts every workspace', ws.freeName('Other') === 'Other 2')

  // At the same moment: only one of each gets the name.
  const settled = (es) => Promise.allSettled(es.map(run))
  const ok = (rs) => rs.filter((r) => r.status === 'fulfilled').length
  const named = (n) => ws.list().filter((w) => w.name.toLowerCase() === n.toLowerCase()).length
  check('creates at once: one gets the name', ok(await settled([ws.create({ name: 'Race' }), ws.create({ name: 'race' })])) === 1 && named('Race') === 1)
  const alpha = await run(ws.create({ name: 'Alpha' }))
  const beta = await run(ws.create({ name: 'Beta' }))
  check('renames at once: one gets the name', ok(await settled([ws.update(alpha.id, { name: 'Shared' }), ws.update(beta.id, { name: 'Shared' })])) === 1 && named('Shared') === 1)
  check('forks at once: one gets the name', ok(await settled([ws.fork(alpha.id, 'Twin'), ws.fork(beta.id, 'Twin')])) === 1 && named('Twin') === 1)
  check('a create, a rename and a fork at once: one gets the name', ok(await settled([ws.create({ name: 'Tri' }), ws.update(inbox.id, { name: 'Tri' }), ws.fork(inbox.id, 'Tri')])) === 1 && named('Tri') === 1)

  // workspace.json changed on disk.
  const { readFileSync } = await import('node:fs')
  const gamma = await run(ws.create({ name: 'Gamma' }))
  const delta = await run(ws.create({ name: 'Delta' }))
  const jsonOf = (id) => join(workspacesDir, id, 'workspace.json')
  const config = (id) => JSON.parse(readFileSync(jsonOf(id), 'utf8'))
  await Promise.all([run(ws.update(gamma.id, { name: 'Renamed gamma' })), run(ws.update(gamma.id, { description: 'Concurrent description' }))])
  check('concurrent patches to one workspace preserve both fields in memory and on disk', [ws.get(gamma.id), config(gamma.id)].every((c) => c.name === 'Renamed gamma' && c.description === 'Concurrent description'))
  await run(ws.update(gamma.id, { name: 'Gamma' }))
  writeFileSync(jsonOf(delta.id), JSON.stringify({ ...config(delta.id), name: 'gamma', description: 'by hand' }))
  await ws.naming(() => ws.reload(delta.id))
  check('a name taken by hand in workspace.json does not take; the rest of the edit does', ws.get(delta.id).name === 'Delta' && ws.get(delta.id).description === 'by hand' && named('Gamma') === 1, ws.get(delta.id).name)
  check('…and the file gets its name back', config(delta.id).name === 'Delta')
  writeFileSync(jsonOf(delta.id), JSON.stringify({ ...config(delta.id), name: 'Epsilon' }))
  await sleep(600)
  check('a free name by hand is picked up by the folder watcher', ws.get(delta.id).name === 'Epsilon', ws.get(delta.id).name)

  // A taken name and no manifest at once: the file is corrected in one write and still reads.
  const { uses: _uses, ...noManifest } = config(delta.id)
  writeFileSync(jsonOf(delta.id), JSON.stringify({ ...noManifest, name: 'Gamma' }))
  await ws.naming(() => ws.reload(delta.id))
  const both = (() => {
    try {
      return config(delta.id)
    } catch {
      return undefined
    }
  })()
  check('a taken name with no manifest: the file keeps its name, gets a manifest, and is valid JSON', both?.name === 'Epsilon' && both?.uses !== undefined && ws.get(delta.id).name === 'Epsilon', readFileSync(jsonOf(delta.id), 'utf8'))

  // A file read half-saved, then saved with a taken name: the name check still holds.
  writeFileSync(jsonOf(delta.id), '')
  await ws.naming(() => ws.reload(delta.id))
  check('a workspace.json that does not read keeps the workspace as it was', ws.get(delta.id)?.name === 'Epsilon')
  writeFileSync(jsonOf(delta.id), JSON.stringify({ ...config(gamma.id), name: 'Gamma' }))
  await ws.naming(() => ws.reload(delta.id))
  check('…and a taken name saved after it still does not take', ws.get(delta.id).name === 'Epsilon' && named('Gamma') === 1, ws.get(delta.id).name)

  // A name taken by hand while a create of it is half done: the reload waits for the create.
  const files = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f/${i}.txt`, 'x'.repeat(2000)]))
  const making = run(ws.create({ name: 'Zeta', files }))
  await sleep(5)
  writeFileSync(jsonOf(delta.id), JSON.stringify({ ...config(delta.id), name: 'Zeta' }))
  const zeta = await making
  await sleep(600)
  check('a reload during a create of the same name does not make two', named('Zeta') === 1 && ws.get(zeta.id).name === 'Zeta' && ws.get(delta.id).name === 'Epsilon', ws.list().map((w) => w.name).join(', '))

  // A workspace dragged up, then deleted: one made later under its id goes to the end like any new one.
  const eta = await run(ws.create({ name: 'Eta' }))
  await run(ws.reorder([eta.id]))
  check('a dragged workspace leads the list', ws.list()[0].id === eta.id)
  await run(ws.remove(eta.id))
  const again = await run(ws.create({ name: 'Eta' }))
  check('deleted and made again under its id, it goes to the end', again.id === eta.id && ws.list().at(-1).id === eta.id, ws.list().map((w) => w.name).join(', '))
  check('and the saved order no longer names it', !JSON.parse((await import('node:fs')).readFileSync(join(dataDir, 'workspace-order.json'), 'utf8')).includes(eta.id))
  await rt.dispose()
}

// ── workspace names through drafts: publishing and undoing a rename
{
  console.log('workspace names in drafts')
  const { readFileSync } = await import('node:fs')
  const { Layer, ManagedRuntime } = await import('effect')
  const { ConfigLive } = await load('src/main/services/Config.ts')
  const { EventsLive } = await load('src/main/services/Events.ts')
  const { Workspaces, WorkspacesLive } = await load('src/main/services/Workspaces.ts')
  const { Drafts, DraftsLive } = await load('src/main/services/Drafts.ts')
  const dataDir = join(tmp, 'names-drafts-data')
  const workspacesDir = join(dataDir, 'workspaces')
  mkdirSync(workspacesDir, { recursive: true })
  const base = Layer.mergeAll(ConfigLive({ appRoot: process.cwd(), outDir: join(process.cwd(), 'out', 'main'), dataDir, workspacesDir }), EventsLive)
  const rt = ManagedRuntime.make(DraftsLive.pipe(Layer.provideMerge(WorkspacesLive.pipe(Layer.provideMerge(base)))))
  const ws = await rt.runPromise(Workspaces)
  const drafts = await rt.runPromise(Drafts)
  const run = (e) => rt.runPromise(e)
  const one = await run(ws.create({ name: 'One' }))
  await run(ws.create({ name: 'Two' }))
  const rename = (dir, name) => writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8')), name }))

  const d = await run(drafts.open(one.id, 'n'))
  rename(d.dir, 'two')
  const refused = await run(drafts.publish(one.id, 'n', 'Take a name'))
  check('a draft renaming onto a taken name is refused', refused.published === false && refused.reason === 'name' && ws.get(one.id).name === 'One', JSON.stringify(refused))
  rename(d.dir, 'Uno')
  const p = await run(drafts.publish(one.id, 'n', 'Rename'))
  check('a draft renaming onto a free name publishes, and the name shows at once', p.published === true && ws.get(one.id).name === 'Uno', JSON.stringify(p))
  await run(ws.create({ name: 'One' }))
  const h = await run(drafts.history(one.id))
  const r = await run(drafts.revert(one.id, h.changes.find((c) => c.message === 'Rename').commit))
  check('undoing a rename back to a name now taken is refused, and nothing changes', r.reverted === false && /name in use/.test(r.reason) && ws.get(one.id).name === 'Uno' && JSON.parse(readFileSync(join(workspacesDir, one.id, 'workspace.json'), 'utf8')).name === 'Uno', JSON.stringify(r))
  await rt.dispose()
}

// ── background service: its settings, its login item and how the window finds it
{
  console.log('execution limits')
  const { DEFAULT_EXECUTION, readExecution, executionFromEnv } = await load('src/shared/execution.ts')
  check('higher local capacity defaults', DEFAULT_EXECUTION.agents === 12 && DEFAULT_EXECUTION.shell === 16)
  check('environment overrides remain supported', JSON.stringify(executionFromEnv({ AGENTD_CONCURRENCY: '20', AGENTD_SHELL_CONCURRENCY: '64' })) === '{"agents":20,"shell":64}')
  check('malformed environment overrides cannot stall the queues', JSON.stringify(executionFromEnv({ AGENTD_CONCURRENCY: 'nope', AGENTD_SHELL_CONCURRENCY: '0' })) === JSON.stringify(DEFAULT_EXECUTION))
  check('invalid saved fields fall back independently', JSON.stringify(readExecution({ agents: -1, shell: 40 }, { agents: 8, shell: 10 })) === '{"agents":8,"shell":40}')
  for (const value of [null, [], 'bad', { agents: 0, shell: 0 }, { agents: 1.5, shell: Infinity }, { agents: 65, shell: 129 }]) {
    check(`invalid saved capacity falls back: ${JSON.stringify(value)}`, JSON.stringify(readExecution(value)) === JSON.stringify(DEFAULT_EXECUTION))
  }
}

{
  console.log('execution settings persistence')
  const { readFileSync } = await import('node:fs')
  const { Layer, ManagedRuntime } = await import('effect')
  const { ConfigLive } = await load('src/main/services/Config.ts')
  const { EventsLive } = await load('src/main/services/Events.ts')
  const { Settings, SettingsLive } = await load('src/main/services/Settings.ts')
  const dataDir = join(tmp, 'execution-settings-data')
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'settings.json')
  const savedFile = () => JSON.parse(readFileSync(file, 'utf8'))
  const open = () => ManagedRuntime.make(SettingsLive.pipe(Layer.provideMerge(Layer.mergeAll(ConfigLive({ appRoot: process.cwd(), outDir: tmp, dataDir, workspacesDir: dataDir }), EventsLive))))
  const envBefore = { agents: process.env.AGENTD_CONCURRENCY, shell: process.env.AGENTD_SHELL_CONCURRENCY }
  let rt
  try {
    process.env.AGENTD_CONCURRENCY = '8'
    process.env.AGENTD_SHELL_CONCURRENCY = '4'
    rt = open()
    let settings = await rt.runPromise(Settings)
    check('unsaved limits use the launch environment', settings.get().execution.agents === 8 && settings.get().execution.shell === 4)
    settings.setTheme('classic')
    settings.setMode('dark')
    settings.setLayout({ workspaces: 'side' })
    settings.setBackground({ startAtLogin: true })
    check('unrelated settings do not persist environment-derived limits', !Object.hasOwn(savedFile(), 'execution'))
    await rt.dispose()
    process.env.AGENTD_CONCURRENCY = '10'
    process.env.AGENTD_SHELL_CONCURRENCY = '7'
    rt = open()
    settings = await rt.runPromise(Settings)
    check('changed environment overrides apply on the next launch after unrelated saves', settings.get().execution.agents === 10 && settings.get().execution.shell === 7 && settings.get().mode === 'dark')
    await rt.dispose()
    delete process.env.AGENTD_CONCURRENCY
    delete process.env.AGENTD_SHELL_CONCURRENCY
    rt = open()
    settings = await rt.runPromise(Settings)
    check('removing environment overrides restores defaults after unrelated saves', settings.get().execution.agents === 12 && settings.get().execution.shell === 16)
    await rt.dispose()
    writeFileSync(file, JSON.stringify({ ...savedFile(), execution: { shell: 5 } }))
    rt = open()
    settings = await rt.runPromise(Settings)
    settings.setTheme('sand')
    check('unrelated saves preserve partial execution choices without materializing fallbacks', JSON.stringify(savedFile().execution) === '{"shell":5}')
    settings.setExecution({ agents: 11, shell: 9 })
    settings.setLayout({ agent: 'float' })
    check('explicit execution choices are persisted and retained by other saves', savedFile().execution.agents === 11 && savedFile().execution.shell === 9)
    await rt.dispose()
    process.env.AGENTD_CONCURRENCY = '30'
    process.env.AGENTD_SHELL_CONCURRENCY = '50'
    rt = open()
    settings = await rt.runPromise(Settings)
    check('explicit saved choices still override a changed environment', settings.get().execution.agents === 11 && settings.get().execution.shell === 9)
    const withoutExecution = savedFile()
    delete withoutExecution.execution
    writeFileSync(file, JSON.stringify(withoutExecution))
    settings.setMode('light')
    check('a file removal is preserved even before the settings watcher catches up', !Object.hasOwn(savedFile(), 'execution'))
    await sleep(400)
    check('removing a saved choice restores the environment live', settings.get().execution.agents === 30 && settings.get().execution.shell === 50)
  } finally {
    await rt?.dispose()
    if (envBefore.agents === undefined) delete process.env.AGENTD_CONCURRENCY
    else process.env.AGENTD_CONCURRENCY = envBefore.agents
    if (envBefore.shell === undefined) delete process.env.AGENTD_SHELL_CONCURRENCY
    else process.env.AGENTD_SHELL_CONCURRENCY = envBefore.shell
  }
}

{
  console.log('background')
  const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
  const { Effect, Layer, ManagedRuntime } = await import('effect')
  const { ConfigLive, daemonAddress } = await load('src/main/services/Config.ts')
  const { EventsLive } = await load('src/main/services/Events.ts')
  const { Settings, SettingsLive } = await load('src/main/services/Settings.ts')
  const { loginEnv, loginPlist, syncLoginItem, LOGIN_LABEL } = await load('src/daemon/desktop.ts')
  const { buildId } = await load('src/daemon/service.ts')
  const dataDir = join(tmp, 'background-data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ theme: 'paper', later: { kept: true } }))
  const rt = ManagedRuntime.make(SettingsLive.pipe(Layer.provideMerge(Layer.mergeAll(ConfigLive({ appRoot: process.cwd(), outDir: tmp, dataDir, workspacesDir: dataDir }), EventsLive))))
  const settings = await rt.runPromise(Settings)
  check('keep running is on and login is off unless chosen', settings.get().background.keepRunning === true && settings.get().background.startAtLogin === false)
  const next = settings.setBackground({ startAtLogin: true })
  const file = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
  check('a background choice is saved beside the theme, keys this version does not know kept', next.background.startAtLogin && next.background.keepRunning && file.background.startAtLogin === true && file.later?.kept === true && file.theme === next.theme, JSON.stringify(file))
  check('setting the theme keeps the background choices', settings.setTheme(next.theme).background.startAtLogin === true)
  check('light or dark follows the system unless chosen', settings.get().mode === 'system')
  const dark = settings.setMode('dark')
  check('a chosen mode is saved beside the theme, keeping the rest', dark.mode === 'dark' && JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).mode === 'dark' && dark.background.startAtLogin === true && dark.theme === next.theme)
  check('an unknown mode is refused', /No mode named/.test(await throws(() => settings.setMode('dusk'))) && settings.get().mode === 'dark')
  check('an install from before the sidebar was the default keeps the title bar, saved, and the agent beside', settings.get().layout.workspaces === 'top' && settings.get().layout.agent === 'panel' && JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).layout?.workspaces === 'top')
  const side = settings.setLayout({ workspaces: 'side' })
  check('a layout choice is saved beside the theme, keeping the rest', side.layout.workspaces === 'side' && side.layout.agent === 'panel' && JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).layout?.workspaces === 'side' && side.mode === 'dark')
  check('the agent can float on its own', settings.setLayout({ agent: 'float' }).layout.workspaces === 'side' && settings.get().layout.agent === 'float')
  check('an unknown place is refused', /workspaces go in one of/.test(await throws(() => settings.setLayout({ workspaces: 'bottom' }))) && /agent goes in one of/.test(await throws(() => settings.setLayout({ agent: 'left' }))) && /No layout setting/.test(await throws(() => settings.setLayout({ nap: 'x' }))) && settings.get().layout.agent === 'float')
  check('unknown or non-boolean background settings are refused', /No background setting/.test(await throws(() => settings.setBackground({ nap: true }))) && /true or false/.test(await throws(() => settings.setBackground({ keepRunning: 'yes' }))))
  const changed = []
  const unlisten = settings.onExecutionChanged((limits) => changed.push(limits))
  settings.setExecution({ agents: 20, shell: 40 })
  const capacity = settings.setExecution({ shell: 128 })
  check('capacity patches preserve the other queue and other settings', capacity.execution.agents === 20 && capacity.execution.shell === 128 && capacity.background.startAtLogin && capacity.theme === next.theme && capacity.layout.agent === 'float')
  check('capacity is saved and changes reach the backend listener', JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).execution.shell === 128 && changed.length === 2 && changed[1].shell === 128)
  settings.setExecution({ shell: 128 })
  check('saving unchanged capacity does not update the backend', changed.length === 2)
  for (const value of [0, -1, 1.5, 129, NaN, Infinity, '4', null]) {
    check(`invalid capacity patch is refused atomically: ${value}`, /whole number/.test(await throws(() => settings.setExecution({ agents: 1, shell: value }))) && settings.get().execution.agents === 20 && settings.get().execution.shell === 128)
  }
  check('unknown capacity setting is refused', /No execution setting/.test(await throws(() => settings.setExecution({ servers: 10 }))))
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')), execution: { agents: 9, shell: 30 } }))
  await sleep(400)
  check('editing capacity on disk updates settings and the backend listener', settings.get().execution.agents === 9 && settings.get().execution.shell === 30 && changed.at(-1).shell === 30)
  unlisten()
  const changeCount = changed.length
  settings.setExecution({ shell: 31 })
  check('capacity listener can be removed', changed.length === changeCount)
  await rt.dispose()
  const reopened = ManagedRuntime.make(SettingsLive.pipe(Layer.provideMerge(Layer.mergeAll(ConfigLive({ appRoot: process.cwd(), outDir: tmp, dataDir, workspacesDir: dataDir }), EventsLive))))
  check('chosen capacity survives a service restart', (await reopened.runPromise(Settings)).get().execution.shell === 31)
  await reopened.dispose()

  const fresh = join(tmp, 'fresh-install-data')
  const freshWorkspaces = join(fresh, 'workspaces')
  mkdirSync(freshWorkspaces, { recursive: true })
  const openAt = (dir, workspacesDir) => ManagedRuntime.make(SettingsLive.pipe(Layer.provideMerge(Layer.mergeAll(ConfigLive({ appRoot: process.cwd(), outDir: tmp, dataDir: dir, workspacesDir }), EventsLive))))
  let at = openAt(fresh, freshWorkspaces)
  check('a new install has the sidebar and the agent beside', (await at.runPromise(Settings)).get().layout.workspaces === 'side' && (await at.runPromise(Settings)).get().layout.agent === 'panel')
  await at.dispose()
  check('a new install saves the sidebar on its first launch', JSON.parse(readFileSync(join(fresh, 'settings.json'), 'utf8')).layout?.workspaces === 'side')
  mkdirSync(join(freshWorkspaces, 'onboarding'))
  at = openAt(fresh, freshWorkspaces)
  check('a new install keeps the sidebar once it has workspaces', (await at.runPromise(Settings)).get().layout.workspaces === 'side')
  await at.dispose()
  const older = join(tmp, 'older-install-data')
  mkdirSync(join(older, 'workspaces', 'home'), { recursive: true })
  at = openAt(older, join(older, 'workspaces'))
  check('an install with workspaces and no settings keeps the title bar', (await at.runPromise(Settings)).get().layout.workspaces === 'top')
  await at.dispose()

  const plist = loginPlist({ program: ['/Applications/Lynx & Co.app/Contents/MacOS/Lynx', '/x/lynxd.js'], env: { ELECTRON_RUN_AS_NODE: '1', LYNX_DAEMON_DATA: '/d<1>' }, log: '/d/lynxd.log' })
  check('the login item runs lynxd, escaped, restarting only after a crash', plist.includes(`<string>${LOGIN_LABEL}</string>`) && plist.includes('Lynx &#38; Co.app') && plist.includes('/d&#60;1&#62;') && /<key>SuccessfulExit<\/key>\s*<false\/>/.test(plist) && /<key>RunAtLoad<\/key>\s*<true\/>/.test(plist))
  const env = loginEnv({ LYNX_DEBUG: '1', AGENT_CODEX_BIN: '/x/codex', AGENTD_WARM: 'claude,codex', LYNX_DAEMON_DATA: '/old', LYNX_E2E: '1', HOME: '/h', OPENAI_API_KEY: 'sk' }, { LYNX_DAEMON_DATA: '/d', ELECTRON_RUN_AS_NODE: '1' })
  check('a login-started service keeps the overrides it was started with, and nothing else', JSON.stringify(env) === JSON.stringify({ LYNX_DEBUG: '1', AGENT_CODEX_BIN: '/x/codex', AGENTD_WARM: 'claude,codex', LYNX_DAEMON_DATA: '/d', ELECTRON_RUN_AS_NODE: '1' }), JSON.stringify(env))
  if (process.platform === 'darwin') {
    const agents = join(tmp, 'LaunchAgents')
    const item = join(agents, `${LOGIN_LABEL}.plist`)
    syncLoginItem(true, plist, agents)
    const written = existsSync(item) && readFileSync(item, 'utf8') === plist
    syncLoginItem(false, plist, agents)
    check('the login item is written when chosen and removed when not', written && !existsSync(item))
  }

  const first = await daemonAddress(dataDir)
  const again = await daemonAddress(dataDir)
  const moved = await daemonAddress(dataDir, true)
  const saved = JSON.parse(readFileSync(join(dataDir, 'local.json'), 'utf8'))
  check('the service keeps one address; a fresh one is a new port with the same token', first.port === again.port && first.token === again.token && moved.token === first.token && saved.daemonPort === moved.port && first.token.length >= 24)
  const out = join(tmp, 'out-main')
  mkdirSync(join(out, 'chunks'), { recursive: true })
  writeFileSync(join(out, 'lynxd.js'), 'a')
  writeFileSync(join(out, 'chunks', 'x.js'), 'b')
  const id = buildId(out)
  writeFileSync(join(out, 'chunks', 'x.js'), 'c')
  check('a change anywhere in the built code is a new build', id !== buildId(out) && buildId(out) === buildId(out) && buildId(join(tmp, 'nowhere')) === 'unknown')
}

// ── service identity: upgrades recognize a service started with a symlink data path
{
  console.log('service identity')
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { realpathSync, symlinkSync } = await import('node:fs')
  const { dataTag, runningService } = await load('src/daemon/pid.ts')
  const root = join(tmp, 'service identity')
  const data = join(root, 'Application Support', 'Lynx')
  const alias = join(root, 'linked data')
  const other = `${data} Other`
  mkdirSync(data, { recursive: true })
  mkdirSync(other)
  symlinkSync(data, alias, 'dir')
  for (const script of ['lynxd.js', 'unrelated.js']) writeFileSync(join(root, script), 'setTimeout(() => {}, 30000)')
  const withService = async (script, dir, inspect) => {
    const child = spawn(process.execPath, [join(root, script), dataTag(dir)], { stdio: 'ignore' })
    await once(child, 'spawn')
    const exited = once(child, 'exit')
    try {
      writeFileSync(join(data, 'lynxd.pid'), String(child.pid))
      await inspect(child.pid)
    } finally {
      child.kill()
      await exited
    }
  }
  check('a folder without a pid has no service', runningService(data) === null)
  await withService('lynxd.js', alias, (pid) => {
    check('a service started through a symlink is found by its real path', runningService(realpathSync(data)) === pid)
    check('the original symlink path still finds that service', runningService(alias) === pid)
  })
  check('an exited service is not mistaken for a running one', runningService(data) === null)
  await withService('lynxd.js', realpathSync(data), (pid) => {
    check('a service started with the real path is also found through a symlink', runningService(alias) === pid)
  })
  await withService('lynxd.js', other, () => {
    check('a service for a folder sharing the same prefix is rejected', runningService(data) === null)
  })
  await withService('unrelated.js', data, () => {
    check('an unrelated process with the same data argument is rejected', runningService(data) === null)
  })
}

// ── shortcut keys: read off a key press the same way on any keyboard, and written as the platform does
{
  console.log('shortcut keys')
  const { comboOf, sameCombo, comboLabel } = await load('src/kit/keys.ts')
  const press = (key, code, mods = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  check('⌘N on a Mac', same(comboOf(press('n', 'KeyN', { metaKey: true }), true), { key: 'n' }))
  check('⌥⌘N goes by where N is, as ⌥ makes it a dead key', same(comboOf(press('Dead', 'KeyN', { metaKey: true, altKey: true }), true), { key: 'n', option: true }))
  check('⌥⌘1 goes by the digit, not ¡', same(comboOf(press('¡', 'Digit1', { metaKey: true, altKey: true }), true), { key: '1', option: true }))
  check('⇧⌘[ is [, not {', same(comboOf(press('{', 'BracketLeft', { metaKey: true, shiftKey: true }), true), { key: '[', shift: true }))
  check('⌃Tab on a Mac is ⌃, not ⌘', same(comboOf(press('Tab', 'Tab', { ctrlKey: true }), true), { key: 'tab', ctrl: true }))
  check('⌃⌘ together is no shortcut on a Mac', comboOf(press('k', 'KeyK', { ctrlKey: true, metaKey: true }), true) === null)
  check('a key alone is no shortcut', comboOf(press('k', 'KeyK'), true) === null && comboOf(press('k', 'KeyK'), false) === null)
  check('a modifier alone is no shortcut', comboOf(press('Meta', 'MetaLeft', { metaKey: true }), true) === null)
  check('a letter follows the layout (AZERTY A is where Q is)', same(comboOf(press('a', 'KeyQ', { metaKey: true }), true), { key: 'a' }))
  check('Ctrl+Tab elsewhere is the shortcut key with Tab', same(comboOf(press('Tab', 'Tab', { ctrlKey: true }), false), { key: 'tab' }))
  check('elsewhere ⌃ in a combo changes nothing', sameCombo({ key: 'tab', ctrl: true }, { key: 'tab' }, false) && !sameCombo({ key: 'tab', ctrl: true }, { key: 'tab' }, true))
  check('labels on a Mac in ⌃⌥⇧⌘ order', comboLabel({ key: 'tab', ctrl: true, shift: true }, true) === '⌃⇧Tab' && comboLabel({ key: 'n', option: true, shift: true }, true) === '⌥⇧⌘N' && comboLabel({ key: 'arrowleft', option: true }, true) === '⌥⌘←', comboLabel({ key: 'tab', ctrl: true, shift: true }, true))
  check('labels elsewhere', comboLabel({ key: 'n', option: true }, false) === 'Ctrl+Alt+N' && comboLabel({ key: 'tab', ctrl: true }, false) === 'Ctrl+Tab')
  check('⌘` is the backtick', same(comboOf(press('`', 'Backquote', { metaKey: true }), true), { key: '`' }) && comboLabel({ key: '`' }, true) === '⌘`')
  check('⇧⌘` is `, not ~ (as the menu reports it, too)', same(comboOf(press('~', 'Backquote', { metaKey: true, shiftKey: true }), true), { key: '`', shift: true }))
  check('⌥⌘` goes by where ` is, as ⌥ makes it a dead key', same(comboOf(press('Dead', 'Backquote', { metaKey: true, altKey: true }), true), { key: '`', option: true }))
}

// ── agents: every harness reports tool calls and failures in one shape, and is named in one list
{
  console.log('agent events')
  const { acpTool, acpErrorMessage } = await load('src/agentd/providers/acp-events.ts')
  const { codexAcpConfig } = await load('src/agentd/providers/acp-launch.ts')
  const { classifyFailure } = await load('src/agentd/providers/events.ts')
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  check('ACP tools retain their identity and input', same(acpTool({ toolCallId: '1', name: 'Bash', title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' } }), { id: '1', kind: 'command', name: 'Bash', input: { command: 'npm test' } }))
  check('ACP connector tools keep their MCP names', acpTool({ toolCallId: '2', title: 'mcp__connection_a__read' }).kind === 'mcp')
  check('unknown ACP kinds remain visible', acpTool({ toolCallId: '3', title: 'New tool', kind: 'future' }).kind === 'other')
  check('failures distinguish quota, login and provider errors', classifyFailure('usage limit') === 'usage_limit' && classifyFailure('Not logged in') === 'auth' && classifyFailure('boom') === 'provider_error')

  check('ACP error details explain a generic internal error', acpErrorMessage(Object.assign(new Error('Internal error'), { data: { details: 'Not logged in' } })) === 'Internal error: Not logged in')
  check('Codex refuses server names its override keys cannot safely address', !!await throws(() => codexAcpConfig({ config: { permission_mode: 'ask' } }, ['server.with.dots'])))
  const { providers, providerById } = await load('src/agentd/providers/registry.ts')
  delete process.env.AGENT_ENABLE_FAKE
  check('the registry offers Claude Code, Codex and Pi, and the test agent only when asked', same(providers().map((p) => p.id), ['claude', 'codex', 'pi']))
  process.env.AGENT_ENABLE_FAKE = '1'
  check('the test agent is offered when enabled', !!providerById('fake'))
  delete process.env.AGENT_ENABLE_FAKE
  check('each provider says how its CLI resumes a conversation', same(providerById('claude').resume_command, ['claude', '--resume']) && same(providerById('codex').resume_command, ['codex', 'resume']))
  check('Pi advertises only supported capabilities', !providerById('pi').capabilities.connections && !providerById('pi').capabilities.interactive_input && same(providerById('pi').capabilities.permission_modes, ['deny', 'allow']))
  check('all providers use ACP and keep warm sessions', providers().every((p) => p.transport === 'acp' && p.capabilities.warm))
}

// ── Claude Code on Bedrock, Vertex or a gateway: how it reaches the API comes along, nothing else
{
  console.log('claude provider settings')
  const { claudeProviderSettings } = await load('src/agentd/providers/claude-settings.ts')
  const { providerEnv } = await load('src/main/env.ts')
  const { envSecrets } = await load('src/agentd/providers/redact.ts')
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const dir = mkdtempSync(join(tmp, 'claude-'))
  check('no settings file, nothing added', same(claudeProviderSettings(dir), {}))
  writeFileSync(join(dir, 'settings.json'), '{ not json')
  check('a broken settings file, nothing added', same(claudeProviderSettings(dir), {}))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'work', N: 3 }, awsAuthRefresh: 'aws sso login', hooks: { Stop: [] }, permissions: { allow: ['Bash'] }, enabledPlugins: { x: true } }))
  check('the settings env and credential helpers come along; hooks, permissions and plugins do not', same(claudeProviderSettings(dir), { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'work' }, awsAuthRefresh: 'aws sso login' }), JSON.stringify(claudeProviderSettings(dir)))
  const listing = 'Welcome!\nCLAUDE_CODE_USE_BEDROCK=1\nAWS_REGION=us-east-1\nAWS_PROFILE=mine\nANTHROPIC_API_KEY=sk-ant\nANTHROPIC_DEFAULT_OPUS_MODEL=us.anthropic.x\nHOME=/h\n'
  check('the shell lends its cloud provider settings, but not API keys or what is already set', same(providerEnv(listing, { AWS_PROFILE: 'set' }), { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.x' }), JSON.stringify(providerEnv(listing, { AWS_PROFILE: 'set' })))
  check('AWS and Bedrock credentials are redacted like API keys', same(envSecrets({ AWS_SECRET_ACCESS_KEY: 'secret', AWS_REGION: 'us-east-1' }, { AWS_BEARER_TOKEN_BEDROCK: 'bearer' }), ['secret', 'bearer']))
}

// ── tool views: what the chat reads out of a tool call to draw it
{
  console.log('tool views')
  const { numberedLines, diffLines, editCounts, resultText, connectorOf, answerOf, previewField, callInput } = await load('src/kit/toolviews.tsx')
  const read = numberedLines('    12→const a = 1\n    13→\n    14→return a\n')
  check('a file Read returns: its lines and the first number', read?.start === 12 && read.code === 'const a = 1\n\nreturn a', JSON.stringify(read))
  check('tab-numbered lines read the same', numberedLines('     1\tx\n     2\ty')?.code === 'x\ny')
  check('text that is not numbered is left alone', numberedLines('hello\n2→x') === undefined)
  const d = diffLines('a\nb\nc', 'a\nB\nc\nd')
  check('a line diff keeps what stayed and marks what changed', d.map((l) => l.op + l.text).join('|') === ' a|-b|+B| c|+d', d.map((l) => l.op + l.text).join('|'))
  check('an edit sums up its lines', editCounts({ key: '1', name: 'Edit', input: { file_path: 'x', old_string: 'a\nb', new_string: 'a\nc\nd' } }) === '+2 −1')
  check('a write counts every line added', editCounts({ key: '1', name: 'Write', input: { file_path: 'x', content: 'a\nb\nc' } }) === '+3 −0')
  check('a tool that is not an edit has no sum', editCounts({ key: '1', name: 'Bash', input: { command: 'ls' } }) === undefined)
  check('content blocks read as their text', resultText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]) === 'one\ntwo')
  const app = 'a'.repeat(32)
  const lin = 'b'.repeat(32)
  const names = new Map([[app, 'app'], [lin, 'linear']])
  check('a connector call wears the connector it ran on', connectorOf({ key: '1', name: `mcp__connection_${lin}__list_issues`, input: {} }, names) === 'linear')
  check('the app connector\'s connector_call wears the connector it called', connectorOf({ key: '1', name: `mcp__connection_${app}__connector_call`, input: { connector: 'github', tool: 'x' } }, names) === 'github')
  check('other app tools wear the app', connectorOf({ key: '1', name: `mcp__connection_${app}__workspace_list`, input: {} }, names) === 'app')
  // The app's connector_call, as Claude Code reports it: its JSON as text, wrapping the connector's own result.
  const wrapped = [{ type: 'text', text: JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ issues: [{ id: 1, title: 'a' }] }) }] } }) }]
  check('a connector_call answers with the connector\'s data, unwrapped', JSON.stringify(answerOf(wrapped)) === JSON.stringify({ issues: [{ id: 1, title: 'a' }] }), JSON.stringify(answerOf(wrapped)))
  check('structured content wins over the text beside it', JSON.stringify(answerOf({ result: { content: [{ type: 'text', text: 'see data' }], structuredContent: { n: 2 } } })) === '{"n":2}')
  check('a connector answer in words stays words', answerOf([{ type: 'text', text: 'Available pages: …' }]) === 'Available pages: …')
  check('a connector_call shows the arguments it passed on', JSON.stringify(callInput({ key: '1', name: `mcp__connection_${app}__connector_call`, input: { connector: 'linear', tool: 'list', arguments: { q: 1 } } })) === '{"q":1}')
  const preview = JSON.stringify({ id: 'toolu_1', kind: 'command', name: 'Bash', input: { command: 'echo "hi"\nls', description: 'x'.repeat(5000) } }).slice(0, 4000)
  check('a shortened call is still read for its id, name and command', previewField(preview, 'id') === 'toolu_1' && previewField(preview, 'name') === 'Bash' && previewField(preview, 'command') === 'echo "hi"\nls')
  check('a field the cut went through is not made up', previewField(preview, 'description') === undefined)
  check('a tool on no connector has none', connectorOf({ key: '1', name: 'Bash', input: { command: 'ls' } }, names) === undefined)
  check('tools a search found read as their names', resultText([{ type: 'tool_reference', tool_name: 'mcp__x__a' }]) === 'mcp__x__a')
}

// ── a review must finish with an unambiguous favorable assessment
{
  const { reviewOutcome, reviewOf } = await load('src/shared/templateReview.ts')
  const safe = '**My assessment:** **Most likely safe to install**. No unexpected behavior.'
  check('a completed favorable review unlocks creation', reviewOutcome({ status: 'completed', output: safe }).status === 'passed')
  for (const status of ['failed', 'cancelled', 'interrupted', 'unknown']) check(`${status} reviews never unlock creation`, reviewOutcome({ status, output: safe }).status === 'blocked')
  for (const output of ['', 'Looks fine', '**My assessment:** Most likely safe to install. Actually, appears unsafe to install.', '**My assessment:** **Appears unsafe to install**.', 'The template says Most likely safe to install']) check('missing, unsafe or quoted verdicts fail closed', reviewOutcome({ status: 'completed', output }).status === 'blocked')
  check('a truncated review cannot unlock creation', reviewOutcome({ status: 'completed', output: safe, output_truncated: true }).status === 'blocked')
  check('a running review cannot unlock creation', reviewOutcome({ status: 'running', output: safe }).status === 'running')
  const plan = reviewOf({ id:'x', name:'Example', source:'remote', creator:'community', dir:'/tmp/example' }, { harness:'fake', model:'', effort:'', access:'full' }, [])
  check('review instructions and configuration always forbid connectors and changes', plan.readOnly && plan.labels.connectors === 'none' && plan.instructions.includes('Do not run, build'))
}

// ── the transcript: a connect card stays where it first appeared as the conversation goes on
{
  console.log('transcript')
  const { toItems, cardsInTurn } = await load('src/kit/items.ts', 'tsconfig.web.json')
  let seq = 0
  const ev = (type, payload) => ({ seq: String(++seq), type, payload })
  const refined = toItems([
    ev('tool_invocation', { id: 'acp-tool', kind: 'command', name: 'Bash', input: {} }),
    ev('tool_invocation', { id: 'acp-tool', kind: 'command', name: 'Bash', input: { command: 'echo hello' } }),
    ev('tool_result', { id: 'acp-tool', output: 'hello', is_error: false }),
  ]).filter((item) => item.kind === 'tools').flatMap((item) => item.steps)
  check('ACP tool updates refine one transcript step and keep its result', refined.length === 1 && refined[0].input.command === 'echo hello' && refined[0].result === 'hello')
  const touch = (tool, id) => {
    const call = `t${seq}`
    return [ev('tool_invocation', { id: call, name: `mcp__connection_x__${tool}`, input: { connector: id } }), ev('tool_result', { tool_use_id: call, output: JSON.stringify({ id, status: 'auth-required' }) })]
  }
  const publishCards = toItems([...touch('marketplace_account', 'unused'), ...touch('marketplace_account', 'unused'), ...touch('marketplace_submit', 'stage-one'), ...touch('marketplace_submit', 'stage-one'), ...touch('marketplace_submit', 'stage-two')]).filter((i) => i.kind === 'marketplace')
  check('marketplace account and submitted stage cards are deduplicated independently', publishCards.length === 3 && !publishCards[0].stage && publishCards[1].stage === 'stage-one' && publishCards[2].stage === 'stage-two')
  const ordered = toItems([ev('user_message', { text: 'publish' }), ...touch('marketplace_account', 'unused'), ev('assistant_message', { text: 'Use the card below.' }), ev('user_message', { text: 'done' }), ev('assistant_message', { text: 'Thanks.' })])
  check('marketplace cards follow the reply but stay before the next user turn', ordered.map((i) => i.kind).join(' ') === 'user tools assistant marketplace user assistant')
  const longReport = [ev('tool_invocation', { id: 'long', name: 'marketplace_submit', input: { stage: 'large-template', report: 'Long report' } }), { ...ev('tool_result', { preview: '{"id":"long","output":"very long report' }), payload_truncated: true }]
  check('a truncated submit result still restores its approval card from the invocation', toItems(longReport).some((i) => i.kind === 'marketplace' && i.stage === 'large-template'))
  const failedCard = touch('marketplace_submit', 'bad-stage')
  failedCard[1].payload.is_error = true
  check('a failed marketplace call cannot render an approval card', !toItems(failedCard).some((i) => i.kind === 'marketplace'))
  const read = (items) => items.map((i) => (i.kind === 'connect' ? `card:${i.connector}` : i.kind)).join(' ')
  const added = [ev('user_message', { text: 'add linear' }), ...touch('connector_add', 'linear'), ev('assistant_message', { text: 'Use the card' }), ...touch('connector_update', 'linear'), ev('assistant_message', { text: 'still going' })]
  const first = toItems(added)
  check('a connect card goes right after the call that added the connector, not at the end of the answer', read(first) === 'user tools card:linear assistant tools assistant', read(first))
  const later = [...added, ev('user_message', { text: 'try again' }), ...touch('connector_update', 'linear'), ...touch('connector_reconnect', 'linear'), ev('assistant_message', { text: 'updated' })]
  const items = toItems(later)
  const cards = items.filter((i) => i.kind === 'connect')
  const turns = cardsInTurn(toItems([...later, ev('user_message', { text: 'add github and posthog' }), ...touch('connector_add', 'github'), ...touch('connector_add', 'posthog'), ev('assistant_message', { text: 'Connect both' })]))
  check('a card alone in its answer counts one, so connecting it carries the conversation on', turns.get('linear') === 1)
  check('cards asked for together count each other, so connecting one waits for the user', turns.get('github') === 2 && turns.get('posthog') === 2, JSON.stringify([...turns]))
  check('an update or reconnect in a later answer leaves the card where it was, with its key', read(items) === 'user tools card:linear assistant tools assistant user tools assistant' && cards.length === 1 && cards[0].key === first.find((i) => i.kind === 'connect').key, read(items))
}

// ── workspace builds: packages come from the app, even with a node_modules above the folder (one in the home folder)
{
  console.log('workspace imports')
  const { confine } = await load('src/main/services/confine.ts')
  const { writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'sb-home-'))
  const ws = join(home, 'Library', 'Lynx', 'workspaces', 'home')
  mkdirSync(join(home, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(home, 'node_modules', 'react', 'package.json'), '{"name":"react","main":"index.js"}')
  writeFileSync(join(home, 'node_modules', 'react', 'index.js'), 'export const useState = "stray"')
  mkdirSync(ws, { recursive: true })
  const bundle = (code) =>
    build({ stdin: { contents: code, resolveDir: ws, loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', logLevel: 'silent', plugins: [confine(ws, process.cwd(), 'workspace')] })
      .then((r) => r.outputFiles[0].text)
      .catch((e) => `ERROR ${e.message}`)
  const out = await bundle(`import { useState } from 'react'\nexport default () => <b>{String(useState)}</b>`)
  check("react and its JSX runtime come from the app's node_modules", !out.startsWith('ERROR') && !out.includes('stray') && out.includes('jsx'), out.slice(0, 300))
  writeFileSync(join(home, 'secret.js'), 'export default 1')
  check('a file outside the folder is still turned away', (await bundle(`import s from '../../../../secret.js'\nconsole.log(s)`)).includes('Imports must stay inside the workspace folder'))
  mkdirSync(join(home, 'node_modules', 'not-in-app'), { recursive: true })
  writeFileSync(join(home, 'node_modules', 'not-in-app', 'index.js'), 'export default 1')
  const notInApp = await bundle(`import s from 'not-in-app'\nconsole.log(s)`)
  check('a package only above the folder is turned away, saying Lynx does not come with it', notInApp.includes('"not-in-app" is not one of the packages Lynx comes with'), notInApp)
  mkdirSync(join(ws, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(ws, 'node_modules', 'react', 'package.json'), '{"name":"react","main":"index.js"}')
  writeFileSync(join(ws, 'node_modules', 'react', 'index.js'), 'export const useState = "second copy"')
  const own = await bundle(`import { useState } from 'react'\nconsole.log(useState)`)
  check("a react in the workspace's own node_modules is not bundled beside the app's", !own.startsWith('ERROR') && !own.includes('second copy'), own.slice(0, 300))
  mkdirSync(join(ws, 'node_modules', 'own-pkg'), { recursive: true })
  writeFileSync(join(ws, 'node_modules', 'own-pkg', 'index.js'), 'export default "mine"')
  check("other packages in the workspace's own node_modules still load", (await bundle(`import s from 'own-pkg'\nconsole.log(s)`)).includes('mine'))
  rmSync(home, { recursive: true, force: true })
}

// ── release builds require a working production marketplace
{
  console.log('marketplace release gate')
  const { checkMarketplace } = await import('../scripts/check-marketplace.mjs')
  const template = { id: 'test', version: 2, creator: 'official', verified: true, uses: {} }
  const ready = async (url) => new Response(JSON.stringify(url.includes('/health') ? { ready: true } : url.includes('/bundle') ? { id: 'test', version: 2, files: [{ path: 'App.jsx', text: 'ok' }] } : { templates: [template] }))
  check('a configured marketplace with a retrievable official template passes', !(await throws(() => checkMarketplace('https://marketplace.example', ready))))
  for (const api of ['', undefined, 'http://marketplace.example', 'https://localhost', 'https://user:password@marketplace.example', 'https://marketplace.example?override=1']) {
    let fetched = false
    const error = await throws(() => checkMarketplace(api, () => { fetched = true; throw new Error('must not fetch') }))
    check('an absent or unsuitable shipped endpoint fails before a request', !!error && !fetched)
  }
  const unavailable = await throws(() => checkMarketplace('https://marketplace.example', async () => new Response(JSON.stringify({ ready: false }), { status: 503 })))
  check('unready production blocks release packaging with its HTTP status', unavailable === 'Marketplace is not ready (503)')
  for (const [route, status, body] of [['/health', 502, '<html>Bad gateway</html>'], ['/templates?', 404, 'Not found'], ['/bundle', 503, '']]) {
    const error = await throws(() => checkMarketplace('https://marketplace.example', async (url) => url.includes(route) ? new Response(body, { status }) : ready(url)))
    check(`non-JSON failure on ${route} preserves HTTP ${status}`, error === `Marketplace is not ready (${status})`, error)
  }
  const malformed = await throws(() => checkMarketplace('https://marketplace.example', async () => new Response('<html>Wrong host</html>')))
  check('a non-JSON success explains which endpoint failed', malformed === 'Marketplace returned invalid JSON (200) for /v1/health', malformed)
  const empty = await throws(() => checkMarketplace('https://marketplace.example', async (url) => url.includes('/health') ? ready(url) : new Response(JSON.stringify({ templates: [] }))))
  check('an empty official catalog blocks packaging', /Seed/.test(empty))
  const wrong = await throws(() => checkMarketplace('https://marketplace.example', async (url) => url.includes('/bundle') ? new Response(JSON.stringify({ id: 'test', version: 1, files: [{ path: 'App.jsx' }] })) : ready(url)))
  check('a mismatched downloaded version blocks packaging', /listed template version/.test(wrong))
}

await (await import('./marketplace-regressions.mjs')).marketplaceRegressions({ load, tmp, check, throws })

// ── the remote marketplace: where it is, the client's requests, what a bundle may hold, and the filters
{
  console.log('remote marketplace')
  const { marketplaceApi, httpRemote, SignedOut } = await load('src/main/marketplaceRemote.ts')
  const { safePath, normTags, ROUTES } = await load('src/shared/marketplaceApi.ts')
  const { matches, matchesFacets, connectorsOf } = await load('src/shared/templates.ts')
  const dir = join(tmp, 'mkt')
  mkdirSync(join(dir, 'data'), { recursive: true })
  mkdirSync(join(dir, 'app'), { recursive: true })
  writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify({ marketplace: { api: 'https://shipped.example/' } }))
  const where = (env = {}) => marketplaceApi({ appRoot: join(dir, 'app'), dataDir: join(dir, 'data'), env })
  check('the address package.json ships with, without its trailing slash', where() === 'https://shipped.example')
  writeFileSync(join(dir, 'data', 'marketplace.json'), JSON.stringify({ api: 'https://local.example' }))
  check('<data>/marketplace.json over package.json', where() === 'https://local.example')
  check('the environment over both', where({ LYNX_MARKETPLACE_URL: 'http://localhost:8787' }) === 'http://localhost:8787')
  check('test runs only read the environment', where({ LYNX_E2E: '1' }) === null)
  check('plain http is refused, except on this machine', where({ LYNX_MARKETPLACE_URL: 'http://evil.example' }) === null)

  const seen = []
  const fake = (handler) => async (url, init) => {
    seen.push({ url, init })
    const [status, body] = handler(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  let page = 0
  const r = httpRemote('https://m.example', fake((url) => (url.includes('cursor=') ? [200, { templates: [{ id: 'b' }] }] : (page++, [200, { templates: [{ id: 'a' }], next: 'p2' }]))))
  check('list follows the pages', (await r.list()).map((t) => t.id).join() === 'a,b' && seen[1].url === `https://m.example${ROUTES.list}?limit=100&cursor=p2`)
  check('requests never follow redirects', seen.every((s) => s.init.redirect === 'error'))
  seen.length = 0
  const authed = httpRemote('https://m.example', fake(() => [401, { error: 'Token expired' }]))
  const out = await authed.me('tok').catch((e) => e)
  check('a refused token is a SignedOut, with the server\'s words', out instanceof SignedOut && out.message === 'Token expired' && seen[0].init.headers.authorization === 'Bearer tok')
  const bad = await httpRemote('https://m.example', fake(() => [400, { error: 'manifest.json is missing' }])).publish('tok', { files: [] }).catch((e) => e)
  check('an error comes back as the server said it', bad.message === 'manifest.json is missing' && !(bad instanceof SignedOut))
  const big = await r.publish('tok', { files: [{ path: 'a.js', text: 'x'.repeat(5_000_001) }] }).catch((e) => e)
  check('too big is refused before anything is sent', /Too big/.test(big.message))
  const down = await httpRemote('https://m.example', async () => Promise.reject(new TypeError('fetch failed'))).list().catch((e) => e)
  check('an unreachable server says where it was looking', /Could not reach the marketplace \(https:\/\/m\.example\)/.test(down.message), down.message)
  await httpRemote('https://m.example', async () => Promise.reject(new Error('down'))).installed('x')
  check('counting an install never fails the fork', true)

  check('bundle paths: plain relative ones', ['App.jsx', 'preview/mock.js', 'tools/a-b.js', 'img/logo @2x.png'].every(safePath))
  check('bundle paths: nothing that climbs out, hides or is absolute', ['../x', 'a/../../x', '/etc/passwd', '.env', 'a/.git/config', 'a//b', 'C:\\x', '', 'a\\..\\b', './a'].every((p) => !safePath(p)))
  check('tags: lower case, dashes, unique, at most eight', JSON.stringify(normTags([' Finance ', 'finance', 'Code Review!', '', 1, 'a', 'b', 'c', 'd', 'e', 'f', 'g'])) === '["finance","code-review","1","a","b","c","d","e"]')
  check('tags: anything else is none', normTags('finance').length === 0)

  const { validSummary, checkRequires, checkUses, checkTools } = await load('src/shared/marketplaceApi.ts')
  const summary = (o) => ({ id: 'x', name: 'X', description: 'd', tags: [], creator: 'community', verified: false, publisher: { name: 'a', handle: 'a' }, version: 1, requires: [], uses: {}, ...o })
  check('a well-formed listed template passes', validSummary(summary({ requires: [{ alias: 'gh', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', optional: true }], uses: { gh: ['search_pull_requests'], app: ['db_get'] } })))
  check('a listed template that may call every tool of a connector is left out', !validSummary(summary({ requires: [{ alias: 'gh', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' }], uses: { gh: '*' } })))
  check('so is one that names a connector it neither requires nor ships with', !validSummary(summary({ uses: { 'work-gmail': ['send_email'] } })))
  check('so is one that leaves uses out: installed, it would get every tool of each bound connector', !validSummary(summary({ requires: [{ alias: 'gh', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' }], uses: undefined })) && validSummary(summary({ uses: {} })))
  check('a blank icon or colour is the default: the template is still listed', validSummary(summary({ icon: '', color: '' })) && !validSummary(summary({ color: 5 })) && !validSummary(summary({ icon: 'x'.repeat(61) })))
  check('a connector URL that is not text is left out (it broke the page)', !validSummary(summary({ requires: [{ alias: 'x', name: 'X', url: 123 }] })))
  check('so are odd uses, hints, flags and schedules', !validSummary(summary({ uses: { app: 'all' } })) && !validSummary(summary({ requires: [{ alias: 'x', name: 'X', hint: 5 }] })) && !validSummary(summary({ requires: [{ alias: 'x', name: 'X', optional: 'yes' }] })) && !validSummary(summary({ tools: ['t'], schedules: [{ id: 's', tool: 'other', cron: '* * * * *' }] })) && !validSummary(summary({ requires: 'none' })))
  seen.length = 0
  await httpRemote('https://m.example', fake(() => [200, { sent: true }])).startLogin('a@b.c')
  check('signing in starts by asking for a code to be mailed', seen[0].url === `https://m.example${ROUTES.loginStart}` && JSON.parse(seen[0].init.body).email === 'a@b.c')
  seen.length = 0
  await httpRemote('https://m.example', fake(() => [200, { handle: 'alice' }])).claimHandle('test-token', 'alice')
  check('a handle is claimed through the authenticated account route', seen[0].url === `https://m.example${ROUTES.claimHandle}` && seen[0].init.method === 'POST' && seen[0].init.headers.authorization === 'Bearer test-token' && JSON.parse(seen[0].init.body).handle === 'alice')
  check('a taken handle reports the conflict without signing the user out', /taken/.test(await throws(() => httpRemote('https://m.example', fake(() => [409, { error: 'That handle is taken' }])).claimHandle('test-token', 'alice'))))

  const { toBundleFile } = await load('src/main/marketplaceRemote.ts')
  const back = (f) => ('text' in f ? Buffer.from(f.text, 'utf8') : Buffer.from(f.base64, 'base64'))
  const pdf = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n', 'latin1')
  const latin1 = Buffer.from('café menu', 'latin1')
  const utf8 = Buffer.from('café ✓ menu', 'utf8')
  check('uploads: a binary without NUL bytes goes as base64, byte for byte', 'base64' in toBundleFile('a.pdf', pdf) && back(toBundleFile('a.pdf', pdf)).equals(pdf))
  check('uploads: text in another encoding goes as base64, byte for byte', 'base64' in toBundleFile('a.txt', latin1) && back(toBundleFile('a.txt', latin1)).equals(latin1))
  check('uploads: UTF-8 text goes as text, unchanged', 'text' in toBundleFile('a.js', utf8) && back(toBundleFile('a.js', utf8)).equals(utf8))
  const { parseOrigin, remoteOrigin, canUpdateFrom } = await load('src/shared/templates.ts')
  const origin = remoteOrigin('https://m.example', 'standup-notes')
  check('origins: a marketplace workspace remembers the server it came from', JSON.stringify(parseOrigin(origin)) === '{"remote":true,"id":"standup-notes","api":"https://m.example"}')
  check('origins: it updates from that server only', canUpdateFrom(origin, 'https://m.example') && !canUpdateFrom(origin, 'https://other.example') && !canUpdateFrom(origin, null) && !canUpdateFrom('remote:standup-notes', 'https://m.example'))
  check('origins: a legacy or local origin remains readable', canUpdateFrom('chat', null) && JSON.stringify(parseOrigin('chat')) === '{"remote":false,"id":"chat"}')

  check('schedules: a cron that can never run (31 February) is refused, as the installer would', /schedule s/.test(checkTools(['tt'], [{ id: 's', tool: 'tt', cron: '0 0 31 2 *' }]) ?? '') && checkTools(['tt'], [{ id: 's', tool: 'tt', cron: '0 9 * * 1-5' }]) === null)

  // The download cache: a preview of v1 still downloading when a refresh lists v2 and v2 is installed.
  const { bundleCache } = await load('src/main/marketplaceCache.ts')
  const { readFileSync: readF, existsSync: exists } = await import('node:fs')
  const asked = []
  let releaseV1
  const v1Held = new Promise((r) => (releaseV1 = r))
  const bundleOf = (v) => ({ id: 't', version: v, files: [{ path: 'manifest.json', text: JSON.stringify({ name: 'T', v }) }, { path: 'App.jsx', text: `// v${v}` }] })
  const cache = bundleCache({ root: join(tmp, 'cache'), api: 'https://m.example', fetch: async (id, v) => (asked.push(v), v === 1 ? (await v1Held, bundleOf(1)) : bundleOf(v)) })
  const preview = cache.ensure({ id: 't', version: 1, name: 'T' })
  await sleep(5)
  const install = await cache.ensure({ id: 't', version: 2, name: 'T' })
  check('cache: an install of v2 does not wait on, or take, a v1 download still on its way', asked.join() === '1,2' && readF(join(install, 'App.jsx'), 'utf8') === '// v2', `asked ${asked} · ${readF(join(install, 'App.jsx'), 'utf8')}`)
  releaseV1()
  const v1dir = await preview
  check('cache: each version keeps its own folder, the v1 download landing beside v2 without touching it', v1dir !== install && readF(join(v1dir, 'App.jsx'), 'utf8') === '// v1' && readF(join(install, 'App.jsx'), 'utf8') === '// v2')
  const again = await cache.ensure({ id: 't', version: 2, name: 'T' })
  check('cache: a version already here is not fetched again', again === install && asked.length === 2)
  const twice = await Promise.all([cache.ensure({ id: 't', version: 3, name: 'T' }), cache.ensure({ id: 't', version: 3, name: 'T' })])
  check('cache: the same version asked twice at once is fetched once', twice[0] === twice[1] && asked.filter((v) => v === 3).length === 1)
  const liar = bundleCache({ root: join(tmp, 'cache2'), api: 'https://m.example', fetch: async () => bundleOf(9) })
  check('cache: a bundle of another version than asked is refused', /sent version 9 for version 4/.test(await throws(() => liar.ensure({ id: 't', version: 4, name: 'T' }))))
  const other = bundleCache({ root: join(tmp, 'cache'), api: 'https://other.example', fetch: async (id, v) => (asked.push(`other${v}`), bundleOf(v)) })
  await other.ensure({ id: 't', version: 2, name: 'T' })
  check('cache: files another server wrote are not taken as this one\'s', asked.includes('other2'))
  cache.prune([{ id: 't', version: 2 }])
  check('cache: pruning keeps only the listed version', exists(cache.dirOf('t', 2)) && !exists(cache.dirOf('t', 1)) && !exists(cache.dirOf('t', 3)))

  const item = (o) => ({ id: 'x', name: 'Revenue', description: 'Stripe at a glance', source: 'remote', creator: 'community', tags: ['finance'], requires: [{ alias: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com' }], uses: { stripe: '*', agents: '*' }, dir: '', ...o })
  check('a template\'s connectors: by host, and the built-in ones it calls', connectorsOf(item()).map((c) => c.key).join() === 'stripe.com,agents')
  check('filters: words, tags, connector and creator together', matches(item(), { q: 'stripe glance', tags: ['finance'], connector: 'stripe.com', creator: 'community' }))
  check('filters: each one can rule it out', !matches(item(), { creator: 'official' }) && !matches(item(), { tags: ['finance', 'team'] }) && !matches(item(), { connector: 'github.com' }) && !matches(item(), { q: 'linear' }))
  check('picker: choices within each facet are alternatives', matchesFacets(item(), { creators: ['official', 'community'], connectors: ['github.com', 'stripe.com'], categories: ['team', 'finance'] }))
  check('picker: every active facet must match', !matchesFacets(item(), { creators: ['official'], connectors: ['stripe.com'], categories: ['finance'] }) && !matchesFacets(item(), { creators: ['community'], connectors: ['github.com'], categories: ['finance'] }) && !matchesFacets(item(), { creators: ['community'], connectors: ['stripe.com'], categories: ['team'] }))
  check('picker: empty facets do not restrict results', matchesFacets(item(), { creators: [], connectors: [], categories: [] }))
  const byAda = item({ publisher: { handle: 'ada', name: 'Ada' } })
  check('picker: a handle selects that publisher case-insensitively', matchesFacets(byAda, { creators: ['@ADA'] }))
  check('picker: a publisher handle matches exactly, not a prefix or display name', !matchesFacets(byAda, { creators: ['@ad'] }) && !matchesFacets(item({ publisher: { handle: 'someone_else', name: 'ada' } }), { creators: ['@ada'] }))
  check('picker: handles and creator groups are alternatives within Created by', matchesFacets(byAda, { creators: ['official', '@ada'] }) && matchesFacets(item({ creator: 'official' }), { creators: ['official', '@ada'] }))
  check('picker: multiple selected publishers are alternatives', matchesFacets(byAda, { creators: ['@other', '@ada'] }))
  check('picker: handles still combine with every other facet', !matchesFacets(byAda, { creators: ['@ada'], connectors: ['github.com'] }) && matchesFacets(byAda, { creators: ['@ada'], categories: ['finance'] }))
  check('picker: an item without a publisher cannot match a handle', !matchesFacets(item(), { creators: ['@ada'] }))

  check('picker: search narrows selected facets', matchesFacets(item(), { categories: ['team', 'finance'], q: 'stripe glance' }) && !matchesFacets(item(), { categories: ['finance'], q: 'linear' }))
}

// Signature policy is independent of the feed and fails closed on verifier errors.
{
  const { updateSignatures } = await load('src/main/updateSignatures.ts')
  const calls = []
  const signatures = updateSignatures(async (args) => {
    calls.push(args)
    return { stderr: 'Identifier=dev.lynx.app\nTeamIdentifier=A246P62YA3\n' }
  })
  const requirement = await signatures.requirement('/installed.app')
  await signatures.verify('/candidate.app', requirement)
  check('updates pin Apple Developer ID, installed team and bundle identity', requirement.includes('anchor apple generic') && requirement.includes('1.2.840.113635.100.6.2.6') && requirement.includes('1.2.840.113635.100.6.1.13') && requirement.includes('A246P62YA3') && requirement.includes('dev.lynx.app'))
  check('installed and candidate signatures are checked deeply and strictly', calls.slice(1).every((a) => a.slice(0, 5).join('|') === ['--verify', '--deep', '--strict', '--test-requirement', `=${requirement}`].join('|')) && calls[1].at(-1) === '/installed.app' && calls[2].at(-1) === '/candidate.app')
  check('missing/ad-hoc publisher is refused', !!(await throws(() => updateSignatures(async () => ({ stderr: 'Identifier=dev.lynx.app\nTeamIdentifier=not set\n' })).requirement('/ad-hoc.app'))))
  check('claimed publisher is verified, not trusted from display output', /valid Developer ID/.test(await throws(() => updateSignatures(async (a) => { if (a[0] === '--verify') throw new Error('untrusted certificate'); return { stderr: 'Identifier=dev.lynx.app\nTeamIdentifier=A246P62YA3\n' } }).requirement('/self-signed.app'))))
  for (const reason of ['different team', 'tampered resources', 'codesign unavailable']) {
    check(`signature rejection fails closed: ${reason}`, /valid Developer ID/.test(await throws(() => updateSignatures(async () => { throw new Error(reason) }).verify('/candidate.app', requirement))))
  }
}

// ── updates: what counts as newer, where to look, and putting a downloaded app in place of this one
{
  console.log('updates')
  const fixtureSignatures = { requirement: async () => 'fixture publisher', verify: async () => {} }
  const u = await load('src/main/updates.ts')
  const { createServer } = await import('node:http')
  const { createHash } = await import('node:crypto')
  const { execFileSync, spawn } = await import('node:child_process')
  const { writeFileSync, readFileSync, existsSync, readdirSync } = await import('node:fs')
  check('newer patch', u.compareVersions('0.1.7', '0.1.6') > 0)
  check('older minor', u.compareVersions('0.1.9', '0.2.0') < 0)
  check('same, with a v and a missing part', u.compareVersions('v1.2', '1.2.0') === 0)
  check('a prerelease is before its release', u.compareVersions('1.0.0-beta.2', '1.0.0') < 0 && u.compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0)
  check('numbers, not text', u.compareVersions('0.10.0', '0.9.0') > 0)
  check('feed: a version is required', /no version/.test(await throws(() => u.parseRelease({ notes: 'x' }))))
  const rel = u.parseRelease({ version: 'v0.2.0', notes: ' - Faster ', extra: 1 })
  check('feed: fields are read', rel.version === '0.2.0' && rel.notes === '- Faster' && rel.sha256 === undefined, JSON.stringify(rel))
  for (const sha256 of ['NOT-A-HASH', '', null, 123]) {
    check(`feed: an invalid checksum is refused (${sha256})`, /checksum/.test(await throws(() => u.parseRelease({ version: '0.2.0', sha256 }))))
  }
  check('feed: without a list, the changes are the release alone', JSON.stringify(rel.changes) === JSON.stringify([{ version: '0.2.0', notes: '- Faster' }]), JSON.stringify(rel.changes))
  const many = u.parseRelease({ version: '0.1.19', notes: 'nineteen', date: '2026-10-20', releases: [{ version: '0.1.15', notes: 'fifteen' }, { version: '0.1.19', notes: 'stale' }, { version: '0.1.20', notes: 'too new' }, { version: 'nope' }, null, { version: 'v0.1.17', notes: ' seventeen ', date: '2026-10-18' }, { version: '0.1.16' }] })
  check('feed: the versions since are read, newest first, none newer than the release, its own notes kept', JSON.stringify(many.changes) === JSON.stringify([{ version: '0.1.19', notes: 'nineteen', date: '2026-10-20' }, { version: '0.1.17', notes: 'seventeen', date: '2026-10-18' }, { version: '0.1.16' }, { version: '0.1.15', notes: 'fifteen' }]), JSON.stringify(many.changes))
  check('feed: asked for the versions since this one', u.feedUrl('https://site/updates/darwin-arm64.json', '0.1.14') === 'https://site/updates/darwin-arm64.json?since=0.1.14' && u.feedUrl('https://site/feed.json?x=1&since=0.0.1', '0.1.14') === 'https://site/feed.json?x=1&since=0.1.14')
  {
    const asked = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url) => (asked.push(url), new Response(JSON.stringify({ version: '0.1.19', notes: 'nineteen', releases: [{ version: '0.1.15', notes: 'fifteen' }, { version: '0.1.14', notes: 'already have it' }] })))
    const updater = u.makeUpdater({ current: '0.1.14', config: { feed: 'https://example.com/feed.json', download: null }, packaged: false, execPath: '', onChange() {}, quit() {} })
    try {
      const state = await updater.check()
      check('updater: asks the feed since its version, and shows only the versions after it', asked[0] === 'https://example.com/feed.json?since=0.1.14' && JSON.stringify(state.latest.changes.map((c) => c.version)) === '["0.1.19","0.1.15"]', JSON.stringify({ asked, latest: state.latest }))
    } finally {
      updater.dispose()
      globalThis.fetch = realFetch
    }
  }
  {
    // The site's feed (lynx-admin/site) lists every release since the app's version, however many.
    const releases = Array.from({ length: 35 }, (_, i) => ({ version: `0.1.${35 - i}`, notes: `- ${35 - i}` }))
    check('app: reads all 35 of them', u.parseRelease({ version: '0.1.35', notes: '- 35', releases }).changes.length === 35)
  }
  check('feed: uppercase checksums are normalized', u.parseRelease({ version: '0.2.0', sha256: 'A'.repeat(64) }).sha256 === 'a'.repeat(64))
  const cfg = { feed: 'https://example.com/lynx/latest.json', download: 'https://dl.example.com/Lynx-{version}-{arch}.dmg' }
  check('download: the template is filled in', u.downloadUrl(rel, cfg, 'arm64') === 'https://dl.example.com/Lynx-0.2.0-arm64.dmg')
  check('download: the feed’s url wins, relative to the feed', u.downloadUrl({ ...rel, url: 'Lynx.zip' }, cfg) === 'https://example.com/lynx/Lynx.zip')
  check('download: none known', u.downloadUrl(rel, { feed: cfg.feed, download: null }) === null)
  for (const url of ['http://example.com/Lynx.dmg', 'file:///tmp/Lynx.app']) {
    check(`manual download: explains why ${url} is refused`, /https only/.test(await throws(() => u.downloadUrl({ ...rel, url }, cfg))))
  }
  check('malformed download URL is distinguished from a missing URL', /URL is invalid/.test(await throws(() => u.downloadUrl({ ...rel, url: 'https://[' }, cfg))))
  check('only https, or http on this machine', u.fetchable('https://a.b/x') && u.fetchable('http://127.0.0.1:9/x') && !u.fetchable('http://a.b/x') && !u.fetchable('file:///etc/passwd'))
  check('the bundle of an installed app', u.bundleOf('/Applications/Lynx.app/Contents/MacOS/Lynx') === '/Applications/Lynx.app' && u.bundleOf('/usr/local/bin/electron') === null)
  check('not from a disk image or translocated', !(await u.canReplace('/Volumes/Lynx/Lynx.app')) && !(await u.canReplace('/private/var/folders/x/AppTranslocation/y/Lynx.app')) && !(await u.canReplace(null)))

  const root = join(tmp, 'updates')
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ updates: { feed: 'https://shipped/feed.json', download: 'https://shipped/{version}.dmg' } }))
  check('config: what the app ships with', u.updateConfig({ appRoot: root, dataDir: join(root, 'data'), env: {} }).feed === 'https://shipped/feed.json')
  writeFileSync(join(root, 'data', 'updates.json'), JSON.stringify({ feed: 'https://local/feed.json' }))
  const both = u.updateConfig({ appRoot: root, dataDir: join(root, 'data'), env: {} })
  check('config: the data folder’s file wins, key by key', both.feed === 'https://local/feed.json' && both.download === 'https://shipped/{version}.dmg', JSON.stringify(both))
  check('config: the environment wins', u.updateConfig({ appRoot: root, dataDir: join(root, 'data'), env: { LYNX_UPDATE_FEED: 'https://env/feed.json' } }).feed === 'https://env/feed.json')
  writeFileSync(join(root, 'data', 'updates.json'), JSON.stringify({ feed: 'https://site/updates/{platform}-{arch}.json' }))
  check('config: the feed is this machine’s', u.updateConfig({ appRoot: root, dataDir: join(root, 'data'), env: {}, platform: 'darwin', arch: 'arm64' }).feed === 'https://site/updates/darwin-arm64.json')
  check('config: test runs only look at the environment', u.updateConfig({ appRoot: root, dataDir: join(root, 'data'), env: { LYNX_E2E: '1' } }).feed === null)
  check('config: empty is unset', u.updateConfig({ appRoot: join(root, 'nowhere'), dataDir: join(root, 'nowhere'), env: { LYNX_UPDATE_FEED: ' ' } }).feed === null)

  // A redirect must be checked before any request to its destination, for both feeds and binaries.
  const originalFetch = globalThis.fetch
  const requested = []
  let redirect = 'http://insecure.example/Lynx.zip'
  globalThis.fetch = async (url, init) => {
    requested.push(url)
    if (init.redirect !== 'manual') throw new Error('automatic redirects bypass validation')
    return new Response(null, { status: 302, headers: { location: redirect } })
  }
  const redirectUpdater = u.makeUpdater({ current: '0.1.6', config: cfg, packaged: false, execPath: '', onChange() {}, quit() {} })
  try {
    check('download: insecure redirect rejected before requesting it', /https only/.test(await throws(() => u.download('https://example.com/app.zip', join(root, 'unsafe.zip')))) && requested.length === 1)
    requested.length = 0
    const state = await redirectUpdater.check()
    check('feed: insecure redirect rejected before requesting it', /https only/.test(state.error) && requested.length === 1)
    redirect = '/loop'
    requested.length = 0
    check('redirect loops are bounded', /too many redirects/.test(await throws(() => u.fetchUpdate('https://example.com/loop'))) && requested.length === 21)
    let hop = 0
    globalThis.fetch = async (url) => ++hop === 1 ? new Response(null, { status: 307, headers: { location: '/latest.json' } }) : new Response(url)
    check('relative HTTPS redirects still work', await (await u.fetchUpdate('https://example.com/start')).text() === 'https://example.com/latest.json')
  } finally {
    redirectUpdater.dispose()
    globalThis.fetch = originalFetch
  }

  for (const url of ['http://example.com/Lynx.dmg', 'file:///tmp/Lynx.app', 'https://[', undefined]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ version: '0.2.0', url }))
    const updater = u.makeUpdater({ current: '0.1.6', config: { feed: cfg.feed, download: null }, packaged: false, execPath: '', onChange() {}, quit() {} })
    try {
      const result = await updater.install()
      const expected = url === undefined ? /does not say where/ : url === 'https://[' ? /URL is invalid/ : /https only/
      check(`install reports the reason a download URL is unusable (${url})`, result.status === 'error' && expected.test(result.error), result.error)
      if (url) check('manual download reports the same refusal', expected.test(await throws(() => updater.downloadUrl())))
    } finally {
      updater.dispose()
      globalThis.fetch = originalFetch
    }
  }

  if (process.platform === 'darwin') {
    const { symlinkSync, utimesSync } = await import('node:fs')
    const cleanupDir = join(root, 'cleanup')
    const cleanupBundle = join(cleanupDir, 'Lynx.app')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const abandoned = spawn(process.execPath, ['-e', ''])
    await new Promise((resolve) => abandoned.once('exit', resolve))
    const folder = (name, owner, stale = true) => {
      const work = join(cleanupDir, name)
      mkdirSync(work, { recursive: true })
      writeFileSync(join(work, 'download.dmg'), 'partial download')
      if (owner) writeFileSync(join(work, 'owner.json'), JSON.stringify(owner))
      if (stale) utimesSync(work, old, old)
      return work
    }
    const legacy = folder('.lynx-update-legacy')
    const dead = folder('.lynx-update-dead00', { pid: abandoned.pid, bundle: cleanupBundle })
    const live = folder('.lynx-update-live00', { pid: process.pid, bundle: cleanupBundle })
    const recent = folder('.lynx-update-new000', undefined, false)
    const otherStaging = folder('.lynx-update-other0', { pid: abandoned.pid, bundle: join(cleanupDir, 'Other.app') })
    const unrelated = folder('unrelated-data')
    symlinkSync(unrelated, join(cleanupDir, '.lynx-update-link00'))
    await u.sweepStaging(cleanupBundle)
    check('stale staging from a crash and from older versions is reclaimed', !existsSync(dead) && !existsSync(legacy))
    check('cleanup preserves live, recent and other-app staging', [live, recent, otherStaging].every(existsSync))
    check('cleanup preserves unrelated folders and does not follow symlinks', existsSync(join(unrelated, 'download.dmg')) && existsSync(join(cleanupDir, '.lynx-update-link00')))

    // A stand-in app at two versions, and a zip and a disk image of the newer one.
    const fake = (dir, version) => {
      mkdirSync(join(dir, 'Lynx.app', 'Contents', 'MacOS'), { recursive: true })
      writeFileSync(join(dir, 'Lynx.app', 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.lynx.app</string><key>CFBundleExecutable</key><string>Lynx</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`)
      writeFileSync(join(dir, 'Lynx.app', 'Contents', 'MacOS', 'Lynx'), version, { mode: 0o755 })
      return join(dir, 'Lynx.app')
    }
    const installed = fake(join(root, 'Applications'), '0.1.6')
    const staleWork = join(root, 'Applications', '.lynx-update-stale0')
    mkdirSync(staleWork)
    writeFileSync(join(staleWork, 'partial.dmg'), 'abandoned download')
    utimesSync(staleWork, old, old)
    const next = fake(join(root, 'next'), '0.2.0')
    execFileSync('ditto', ['-c', '-k', '--keepParent', next, join(root, 'Lynx.zip')])
    execFileSync('hdiutil', ['create', '-quiet', '-srcfolder', join(root, 'next'), '-format', 'UDZO', '-volname', 'Lynx', join(root, 'Lynx.dmg')])
    let feedVersion = '0.2.0'
    let downloads = 0
    const server = createServer((req, res) => {
      if (req.url.startsWith('/feed.json?')) return setTimeout(() => res.end(JSON.stringify({ version: feedVersion, url: '/broken.zip' })), 50)
      if (req.url === '/broken.zip') {
        downloads++
        return setTimeout(() => res.end('not a zip'), 100)
      }
      const f = join(root, req.url.slice(1))
      if (!existsSync(f)) return res.writeHead(404).end()
      const body = readFileSync(f)
      res.writeHead(200, { 'content-length': body.length, ...(f.endsWith('.html') ? { 'content-type': 'text/html; charset=utf-8' } : {}) }).end(body)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    writeFileSync(join(root, 'page.html'), '<!doctype html><p>Sign in')
    const sum = createHash('sha256').update(readFileSync(join(root, 'Lynx.dmg'))).digest('hex')
    let seen = 0
    check('download: progress and hash', (await u.download(`${base}/Lynx.dmg`, join(root, 'got.dmg'), { sha256: sum, onProgress: (p) => (seen = p) })) === sum && seen === 1)
    check('download: a different file is refused', /checksum/.test(await throws(() => u.download(`${base}/Lynx.zip`, join(root, 'bad.zip'), { sha256: sum }))))
    check('download: a web page is not the app', /web page/.test(await throws(() => u.download(`${base}/page.html`, join(root, 'page.dmg')))))
    check('download: a missing file fails', /404/.test(await throws(() => u.download(`${base}/nope.dmg`, join(root, 'nope.dmg')))))
    const statuses = []
    const updater = u.makeUpdater({ current: '0.1.6', config: { feed: `${base}/feed.json`, download: null }, signatures: fixtureSignatures, packaged: true, execPath: join(installed, 'Contents', 'MacOS', 'Lynx'), onChange: () => statuses.push(updater.state().status), quit: () => { throw new Error('must not quit for a broken archive') } })
    try {
      await updater.check()
      feedVersion = '0.3.0'
      const refresh = updater.check()
      const firstInstall = updater.install()
      const secondInstall = updater.install()
      check('concurrent installs share one operation', firstInstall === secondInstall)
      await Promise.all([refresh, firstInstall, secondInstall])
      check('updater startup sweeps abandoned staging', !existsSync(staleWork))
      check('install waits for an in-flight refresh and downloads once', downloads === 1 && updater.state().latest.version === '0.3.0' && updater.state().status === 'error', JSON.stringify(updater.state()))
      check('refresh does not reset install progress', !statuses.slice(statuses.indexOf('downloading')).includes('available'), statuses.join(','))
      check('failed staging is cleaned up beside the app', readdirSync(join(root, 'Applications')).join() === 'Lynx.app')
    } finally {
      updater.dispose()
      server.close()
    }
    {
      // Installing goes on while the app carries on; only Restart quits. Not restarted into, it is removed on quit.
      const good = createServer((req, res) => (req.url.startsWith('/feed.json?') ? res.end(JSON.stringify({ version: '0.2.0', url: '/Lynx.zip' })) : res.end(readFileSync(join(root, 'Lynx.zip')))))
      await new Promise((r) => good.listen(0, '127.0.0.1', r))
      let quits = 0
      const swaps = []
      const make = () => u.makeUpdater({ current: '0.1.6', config: { feed: `http://127.0.0.1:${good.address().port}/feed.json`, download: null }, signatures: fixtureSignatures, packaged: true, execPath: join(installed, 'Contents', 'MacOS', 'Lynx'), onChange() {}, quit: () => quits++, swap: async (o) => swaps.push(o) })
      const a = make()
      await a.check()
      const done = await a.install()
      check('install ends ready to restart, without quitting', done.status === 'ready' && quits === 0 && swaps.length === 0, JSON.stringify(done))
      check('installed beside the app, checked', readdirSync(join(root, 'Applications')).some((f) => f.startsWith('.lynx-update-')))
      check('a check while ready leaves it ready', (await a.check()).status === 'ready')
      await a.restart()
      check('restart starts the swap of the installed app, then quits', quits === 1 && swaps.length === 1 && swaps[0].target === installed && readFileSync(join(swaps[0].staged, 'Contents', 'MacOS', 'Lynx'), 'utf8') === '0.2.0')
      a.dispose()
      check('restarting keeps what the swap needs', existsSync(swaps[0].work))
      rmSync(swaps[0].work, { recursive: true, force: true })
      let rejectSignature = false
      const guarded = u.makeUpdater({ current: '0.1.6', config: { feed: `http://127.0.0.1:${good.address().port}/feed.json`, download: null }, signatures: { ...fixtureSignatures, verify: async () => { if (rejectSignature) throw new Error('tampered signature') } }, packaged: true, execPath: join(installed, 'Contents', 'MacOS', 'Lynx'), onChange() {}, quit: () => quits++, swap: async (o) => swaps.push(o) })
      await guarded.check()
      await guarded.install()
      rejectSignature = true
      check('restart rechecks signatures and never swaps or quits on failure', (await guarded.restart()).status === 'error' && quits === 1 && swaps.length === 1)
      guarded.dispose()
      for (let i = 0; i < 50 && readdirSync(join(root, 'Applications')).some((f) => f.startsWith('.lynx-update-')); i++) await sleep(100)
      const b = make()
      await b.check()
      await b.install()
      const work = readdirSync(join(root, 'Applications')).find((f) => f.startsWith('.lynx-update-'))
      b.dispose()
      for (let i = 0; i < 50 && existsSync(join(root, 'Applications', work)); i++) await sleep(100)
      check('quitting without restarting removes the installed update', !existsSync(join(root, 'Applications', work)))
      good.close()
    }
    mkdirSync(join(root, 'from-dmg'))
    mkdirSync(join(root, 'from-zip'))
    const fromDmg = await u.extractApp(join(root, 'got.dmg'), join(root, 'from-dmg')).catch((e) => e)
    check('the app comes out of a disk image', typeof fromDmg === 'string' && readFileSync(join(fromDmg, 'Contents', 'MacOS', 'Lynx'), 'utf8') === '0.2.0', String(fromDmg))
    const fromZip = await u.extractApp(join(root, 'Lynx.zip'), join(root, 'from-zip'))
    check('the app comes out of a zip', readFileSync(join(fromZip, 'Contents', 'MacOS', 'Lynx'), 'utf8') === '0.2.0')
    check('the new app is this app, at the promised version', !(await throws(() => u.checkApp(fromZip, installed, '0.2.0', fixtureSignatures))))
    const { copyFileSync } = await import('node:fs')
    const adhoc = fake(join(root, 'adhoc'), '0.2.0')
    copyFileSync('/bin/echo', join(adhoc, 'Contents', 'MacOS', 'Lynx'))
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', adhoc], { stdio: 'pipe' })
    const realSignatures = (await load('src/main/updateSignatures.ts')).updateSignatures()
    check('real codesign rejects an ad-hoc installation as an update trust root', !!(await throws(() => realSignatures.requirement(adhoc))))
    check('real codesign rejects an ad-hoc candidate claiming the same bundle id', !!(await throws(() => realSignatures.verify(adhoc, 'anchor apple generic and identifier "dev.lynx.app"'))))
    check('an unsigned update cannot pass the production signature check', !!(await throws(() => u.checkApp(fromZip, installed, '0.2.0'))))
    let verified = []
    const signed = { requirement: async () => 'trusted publisher', verify: async (app, requirement) => { verified.push([app, requirement]); throw new Error('wrong publisher or tampered signature') } }
    check('signature failure blocks a matching bundle and version', /wrong publisher/.test(await throws(() => u.checkApp(fromZip, installed, '0.2.0', signed))) && verified[0][0] === fromZip && verified[0][1] === 'trusted publisher')
    const unsigned = u.makeUpdater({ current: '0.1.6', config: { feed: null, download: null }, packaged: true, execPath: join(installed, 'Contents', 'MacOS', 'Lynx'), onChange() {}, quit() { throw new Error('must not quit') } })
    await unsigned.install()
    check('unsigned installations cannot install automatically', !unsigned.state().canInstall)
    unsigned.dispose()
    check('an older one is refused', /not 0\.3\.0/.test(await throws(() => u.checkApp(fromZip, installed, '0.3.0'))))
    const other = fake(join(root, 'other'), '9.0.0')
    writeFileSync(join(other, 'Contents', 'Info.plist'), readFileSync(join(other, 'Contents', 'Info.plist'), 'utf8').replace('dev.lynx.app', 'com.evil.app'))
    check('another app is refused', /different app/.test(await throws(() => u.checkApp(other, installed, '9.0.0'))))
    const invalid = fake(join(root, 'invalid'), '0.2.0')
    const info = join(invalid, 'Contents', 'Info.plist')
    const validInfo = readFileSync(info, 'utf8')
    writeFileSync(info, validInfo.replace('<key>CFBundleShortVersionString</key><string>0.2.0</string>', ''))
    check('a missing bundle version is refused', !!(await throws(() => u.checkApp(invalid, installed, '0.2.0'))))
    writeFileSync(info, validInfo.replace('<string>0.2.0</string>', '<string>999garbage</string>'))
    check('a malformed bundle version is refused', !!(await throws(() => u.checkApp(invalid, installed, '0.2.0'))))
    writeFileSync(info, validInfo)
    rmSync(join(invalid, 'Contents', 'MacOS', 'Lynx'))
    check('an app with no executable is refused', !!(await throws(() => u.checkApp(invalid, installed, '0.2.0'))))
    // The swap waits for the process to go, then puts the new bundle in place (`open` is stubbed out).
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'open'), `#!/bin/sh\necho "$1" > "${join(root, 'opened')}"\n`, { mode: 0o755 })
    // Nor is Launch Services told about these test bundles: a stand-in records what it would have been told.
    writeFileSync(join(bin, 'lsregister'), `#!/bin/sh\necho "$@" >> "${join(root, 'registered')}"\n`, { mode: 0o755 })
    process.env.LYNX_LSREGISTER = join(bin, 'lsregister')
    const work = join(root, 'from-dmg')
    const sleeper = spawn('sleep', ['1'])
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    await u.scheduleSwap({ pid: sleeper.pid, target: installed, staged: fromDmg, work })
    process.env.PATH = path
    await sleep(300)
    check('the swap waits for the app to quit', readFileSync(join(installed, 'Contents', 'MacOS', 'Lynx'), 'utf8') === '0.1.6')
    for (let i = 0; i < 40 && !existsSync(join(root, 'opened')); i++) await sleep(100)
    check('then the new version is in place, and opened', readFileSync(join(installed, 'Contents', 'MacOS', 'Lynx'), 'utf8') === '0.2.0' && readFileSync(join(root, 'opened'), 'utf8').trim() === installed)
    for (let i = 0; i < 40 && existsSync(work); i++) await sleep(100)
    check('and nothing is left behind', !existsSync(work) && readdirSync(join(root, 'Applications')).join() === 'Lynx.app', readdirSync(join(root, 'Applications')).join())
    const told = readFileSync(join(root, 'registered'), 'utf8').trim().split('\n')
    check('Launch Services is told the new bundle is the app, and the old one is gone', told[0] === `-f ${installed}` && told[1]?.startsWith(`-u ${installed}.old-`), told.join(' | '))
    // Launch Services rejecting the new bundle must restore the previous version.
    const rollbackWork = join(root, 'rollback')
    const rejected = fake(rollbackWork, '0.3.0')
    const restored = join(root, 'restored')
    writeFileSync(join(bin, 'open'), `#!/bin/sh\n[ "$(cat "$1/Contents/MacOS/Lynx")" = "0.3.0" ] && exit 1\necho "$1" > "${restored}"\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${path}`
    try {
      await u.scheduleSwap({ pid: sleeper.pid, target: installed, staged: rejected, work: rollbackWork })
    } finally {
      process.env.PATH = path
    }
    for (let i = 0; i < 40 && existsSync(rollbackWork); i++) await sleep(100)
    check('failed launch restores and opens the previous bundle', existsSync(restored) && readFileSync(join(installed, 'Contents', 'MacOS', 'Lynx'), 'utf8') === '0.2.0')
    check('rollback cleans up after successful recovery', !existsSync(rollbackWork) && readdirSync(join(root, 'Applications')).join() === 'Lynx.app')
    delete process.env.LYNX_LSREGISTER
  }
}

// ── API connectors: the key is added here, stays on its server, and never comes back
{
  console.log('api connectors')
  const { apiConfig, apiRequest, apiCheck, apiTools, apiUrl, apiHasKey } = await load('src/main/apiConnector.ts')
  const limitedCheck = await apiCheck({ id: 'limited', url: 'https://api.example.test', api: apiConfig({ check_path: '/me' }) }, async () => new Response(JSON.stringify({ message: 'secondary rate limit' }), { status: 403, headers: { 'content-type': 'application/json' } }))
  check('API sign-in checks do not mistake secondary limits for bad credentials', !limitedCheck.ok && !limitedCheck.credentials && /rate limited/.test(limitedCheck.error))
  const { createServer } = await import('node:http')
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body })
      if (u.pathname === '/v1/echo') return res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining': '9', 'set-cookie': 'a=b' }).end(JSON.stringify({ auth: req.headers.authorization ?? null, key: req.headers['x-api-key'] ?? u.searchParams.get('api_key') }))
      if (u.pathname === '/v1/me') return res.writeHead(req.headers['x-api-key'] === 'good-key-1234' ? 200 : 401).end('')
      if (u.pathname === '/v1/away') return res.writeHead(302, { location: 'https://elsewhere.example/steal' }).end()
      if (u.pathname === '/v1/here') return res.writeHead(302, { location: '/v1/echo' }).end()
      if (u.pathname === '/v1/text') return res.writeHead(404, { 'content-type': 'text/plain' }).end('not here')
      res.writeHead(200).end('?')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/v1`
  const spec = (auth, credentials, extra = {}) => ({ id: 'typesafe', name: 'Typesafe', transport: 'api', url: base, api: apiConfig({ ...auth, ...extra }), credentials, createdAt: '' })

  check('config: header auth defaults its name', apiConfig({ auth_type: 'header' }).auth.name === 'X-API-Key')
  check('config: unknown auth type is refused', /auth_type/.test(await throws(() => apiConfig({ auth_type: 'magic' }))))
  check('config: a check path must be a path', /check_path/.test(await throws(() => apiConfig({ check_path: 'https://x/y' }))))
  check('config: unset fields keep what is stored', apiConfig({ notes: 'n' }, apiConfig({ auth_type: 'query', auth_name: 'token', docs_url: 'https://d' })).auth.name === 'token')
  check('has a key: none needs none, basic a username', apiHasKey({ auth: { type: 'none' } }) && apiHasKey({ auth: { type: 'basic' } }, { username: 'sk' }) && !apiHasKey({ auth: { type: 'bearer' } }, {}))
  check('one tool, request, saying how the key is sent', (() => { const t = apiTools(spec({ auth_type: 'header' }, {}, { notes: 'Payments.' })); return t.length === 1 && t[0].name === 'request' && /X-API-Key header/.test(t[0].description) && /Payments\./.test(t[0].description) })())

  check('url: path under the base', apiUrl(base, '/items', { a: 1, b: [2, 3] }).href === `${base}/items?a=1&b=2&b=3`)
  check('url: another host is refused', /relative/.test(await throws(() => apiUrl(base, 'https://evil.example/x'))))
  check('url: protocol-relative is refused', /relative/.test(await throws(() => apiUrl(base, '//evil.example/x'))))
  check('url: climbing above the base is refused', /stay under/.test(await throws(() => apiUrl(base, '/../admin'))))
  check('url: a sibling with the same prefix is refused', /stay under/.test(await throws(() => apiUrl(`${base}/a`, '/../ab'))))

  let r = await apiRequest(spec({ auth_type: 'bearer' }, { key: 'secret-token-1' }), { path: '/echo', headers: { Authorization: 'Bearer stolen', 'x-extra': '1' } })
  check('bearer: key added, the caller cannot replace it', seen.at(-1).headers.authorization === 'Bearer secret-token-1' && seen.at(-1).headers['x-extra'] === '1')
  check('bearer: an echoed key comes back redacted', r.ok && r.status === 200 && r.body.auth === 'Bearer [redacted]', JSON.stringify(r.body))
  check('only useful response headers are kept', r.headers['x-ratelimit-remaining'] === '9' && !('set-cookie' in r.headers))
  r = await apiRequest(spec({ auth_type: 'basic' }, { username: 'user', password: 'pass-word' }), { path: '/echo' })
  check('basic: username and password, redacted when echoed', seen.at(-1).headers.authorization === `Basic ${Buffer.from('user:pass-word').toString('base64')}` && r.body.auth === 'Basic [redacted]')
  r = await apiRequest(spec({ auth_type: 'header', auth_name: 'X-API-Key' }, { key: 'good-key-1234' }), { method: 'post', path: '/echo', body: { a: 1 } })
  check('header: key in its own header; JSON body sent as JSON', seen.at(-1).headers['x-api-key'] === 'good-key-1234' && seen.at(-1).method === 'POST' && seen.at(-1).body === '{"a":1}' && seen.at(-1).headers['content-type'] === 'application/json' && r.body.key === '[redacted]')
  r = await apiRequest(spec({ auth_type: 'query' }, { key: 'query-key-99' }), { path: '/echo?api_key=mine&x=1' })
  check('query: the key replaces a caller-supplied one', seen.at(-1).query.api_key === 'query-key-99' && seen.at(-1).query.x === '1' && r.body.key === '[redacted]')
  r = await apiRequest(spec({ auth_type: 'none' }), { path: '/text' })
  check('an error status is an answer, text stays text', r.status === 404 && r.ok === false && r.body === 'not here')
  r = await apiRequest(spec({ auth_type: 'bearer' }, { key: 'secret-token-1' }), { path: '/away' })
  check('a redirect to another server is not followed', r.status === 302 && seen.at(-1).path === '/v1/away')
  r = await apiRequest(spec({ auth_type: 'bearer' }, { key: 'secret-token-1' }), { path: '/here' })
  check('a redirect on the same server is followed', r.status === 200 && seen.at(-1).path === '/v1/echo')
  check('without its key it refuses to send', /needs credentials/.test(await throws(() => apiRequest(spec({ auth_type: 'bearer' }, {}), { path: '/echo' }))))
  check('an unknown method is refused', /method/.test(await throws(() => apiRequest(spec({ auth_type: 'none' }), { method: 'TRACE', path: '/echo' }))))

  check('config: methods are checked and kept in order', JSON.stringify(apiConfig({ methods: ['post', 'GET'] }).methods) === '["GET","POST"]' && apiConfig({ methods: [] }).methods === undefined && /TRACE/.test(await throws(() => apiConfig({ methods: ['TRACE'] }))))
  const readOnly = spec({ auth_type: 'none' }, undefined, { methods: ['GET'] })
  check('methods: GET only is a read-only tool', apiTools(readOnly)[0].declaredReadOnly === true && apiTools(spec({ auth_type: 'none' }))[0].declaredReadOnly === false)
  check('methods: others are refused before anything is sent', /only allows GET/.test(await throws(() => apiRequest(readOnly, { method: 'DELETE', path: '/echo' }))))
  const good = await apiCheck(spec({ auth_type: 'header' }, { key: 'good-key-1234' }, { check_path: '/me' }))
  const bad = await apiCheck(spec({ auth_type: 'header' }, { key: 'wrong-key-000' }, { check_path: '/me' }))
  check('check: a working key passes, a refused one asks for credentials', good.ok && !bad.ok && bad.credentials && /refused/.test(bad.error))
  server.close()
}

// ── a message said aloud stays in its conversation until that conversation's own history has it
{
  console.log('outgoing voice message')
  // The real session hook, rendered by a small stand-in for React: hooks kept by order, effects run after each render.
  const reactStub = join(tmp, 'react-stub.mjs')
  writeFileSync(
    reactStub,
    `let hooks = [], at = 0, effects = [], component = null, scheduled = false
export const renders = []
const rerender = () => { scheduled = false; at = 0; effects = []; renders.push(component()); for (const f of effects) f() }
const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(rerender) } }
export const mount = (f) => { component = f; rerender() }
export const update = () => rerender()
export const unmount = () => { for (const h of hooks) h?.cleanup?.(); hooks = [] }
export function useState(init) {
  const i = at++
  if (!(i in hooks)) hooks[i] = { v: typeof init === 'function' ? init() : init }
  const slot = hooks[i]
  return [slot.v, (n) => { const v = typeof n === 'function' ? n(slot.v) : n; if (!Object.is(v, slot.v)) { slot.v = v; schedule() } }]
}
export function useRef(init) { const i = at++; return (hooks[i] ??= { current: init }) }
export function useEffect(f, deps) {
  const i = at++
  const slot = (hooks[i] ??= {})
  if (slot.deps && deps && deps.every((d, k) => Object.is(d, slot.deps[k]))) return
  slot.deps = deps
  effects.push(() => { slot.cleanup?.(); slot.cleanup = f() })
}
export const useLayoutEffect = useEffect
export const useCallback = (f) => f
export const useMemo = (f) => f()
export const useSyncExternalStore = (_s, get) => get()
`,
  )
  const entry = join(tmp, 'outgoing-entry.ts')
  writeFileSync(entry, `export { useSession } from ${JSON.stringify(join(process.cwd(), 'src/kit/agents.ts'))}\nexport { setTransport } from ${JSON.stringify(join(process.cwd(), 'src/kit/core.ts'))}\nexport { outgoing, useOutgoing } from ${JSON.stringify(join(process.cwd(), 'src/renderer/src/outgoing.ts'))}\nexport * from ${JSON.stringify(reactStub)}\n`)
  const out = join(tmp, 'outgoing-entry.mjs')
  // React, and the JSX runtime of the components bundled with the hook (never drawn here), are the stand-ins.
  const jsxStub = join(tmp, 'jsx-stub.mjs')
  writeFileSync(jsxStub, 'export const jsx = () => null, jsxs = jsx, Fragment = null\n')
  const stand = { name: 'react-stub', setup: (b) => b.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, (a) => ({ path: a.path === 'react' ? reactStub : jsxStub })) }
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [stand], tsconfig: 'tsconfig.web.json', logLevel: 'silent' })
  const { useSession, setTransport, outgoing, useOutgoing, useEffect, mount, update, unmount, renders } = await import(pathToFileURL(out).href)
  const user = (seq) => ({ seq: String(seq), stream_id: '', execution_id: `r${seq}`, type: 'user_message', payload: { text: `said ${seq}` }, created_at: '' })
  // A has one message so far, B three. A read of A's history can be held back, and A's live follow can bring one more.
  const history = { A: [user(1)], B: [user(2), user(3), user(4)] }
  let holdA = null
  const hold = () => {
    let go
    holdA = new Promise((r) => (go = r))
    return () => ((holdA = null), go())
  }
  const liveA = []
  setTransport({
    call: async (_c, tool, args) => {
      if (tool !== 'session_history') return {}
      if (args.after !== '0') {
        // Following live: what came since, or nothing new.
        if (args.id === 'A' && liveA.length) return { items: liveA.splice(0), next_cursor: String(Number(args.after) + 1), has_more: false }
        return new Promise((r) => setTimeout(() => r({ items: [], next_cursor: args.after, has_more: false }), 5))
      }
      if (args.id === 'A' && holdA) await holdA
      return { items: history[args.id], next_cursor: String(history[args.id].length), has_more: false }
    },
    post: () => {},
  })
  // As the agent panel has it: the conversation on screen, what is on its way there, settled against the conversation's own events.
  let id = 'A'
  const panel = () => {
    const session = useSession(id)
    const pending = useOutgoing()
    useEffect(() => outgoing.settle(id, session.events), [id, session.events, pending])
    return { id, session, shown: pending.filter((o) => o.tab === id).map((o) => o.text) }
  }
  const settle = () => new Promise((r) => setTimeout(r, 30))
  const last = () => renders.at(-1)
  mount(panel)
  await settle()
  check('A is read, one message', last().session.events.length === 1 && !last().session.loading)

  // Said aloud in A, taken by the agent as turn r5.
  const key = outgoing.add('A', 'said 5')
  outgoing.sent(key, 'r5')
  update()
  check('the message on its way shows in A', last().shown.join() === 'said 5')
  // To B, which has more of the user's messages, and back to A while A's history is slow.
  id = 'B'
  update()
  await settle()
  check('B is read', last().id === 'B' && last().session.events.length === 3)
  let letGo = hold()
  const from = renders.length
  id = 'A'
  update()
  await settle()
  update()
  const whileSlow = renders.slice(from)
  check("back on A, B's history is never taken for A's", whileSlow.every((r) => r.id === 'A' && r.session.events.every((e) => e.seq === '1' || e.seq === '5')), JSON.stringify(whileSlow.map((r) => r.session.events.map((e) => e.seq))))
  check("so the message on its way stays until A's history has it", whileSlow.every((r) => r.shown.join() === 'said 5'), JSON.stringify(whileSlow.map((r) => r.shown)))

  // The panel is drawn anew (another workspace on screen) before A has it: what is on its way is still there.
  unmount()
  mount(panel)
  update()
  check('drawn anew before A has it, the panel still shows it', last().shown.join() === 'said 5')
  // A's history comes without it (the agent has not recorded it yet), with an older message of the user's.
  letGo()
  await settle()
  update()
  check("A's history without it, an older message in it, is not taken for it", !last().session.loading && last().session.events.length === 1 && last().shown.join() === 'said 5', JSON.stringify([last().session.events.length, last().shown]))
  // Then the turn's own message is recorded, and read with the conversation's next read (idle, a couple of seconds on).
  liveA.push(user(5))
  for (let i = 0; i < 100 && liveA.length; i++) await sleep(50)
  await settle()
  update()
  check("A's history with that turn's message has it: it is no longer on its way", last().session.events.some((e) => e.seq === '5') && last().shown.length === 0, JSON.stringify([last().session.events.map((e) => e.seq), last().shown]))

  // One that went with no turn to know it by is not shown any longer; one that did not go is taken away.
  const unknown = outgoing.add('A', 'no turn')
  outgoing.sent(unknown)
  const failed = outgoing.add('A', 'failed')
  outgoing.drop(failed)
  check('one with no turn known, or that did not go, is not shown', outgoing.list().length === 0)
  // A new conversation started from a tab takes what was on its way from there.
  const fresh = outgoing.add('blank-1', 'new one')
  outgoing.move('blank-1', 'C')
  check('a new conversation takes what was on its way from the tab that started it', outgoing.list().find((o) => o.key === fresh)?.tab === 'C')
  outgoing.drop(fresh)
  unmount()
  setTransport(undefined)
}

// ── the agent's queue: messages written while a conversation works go once it is done, and none is lost on the way
{
  console.log('agent queue')
  const stored = new Map()
  globalThis.localStorage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: (k) => stored.delete(k) }
  // One bundle, so the queue and the transport it calls through are the same module.
  const entry = join(tmp, 'queue-entry.ts')
  writeFileSync(entry, `export * from ${JSON.stringify(join(process.cwd(), 'src/renderer/src/agentQueue.ts'))}\nexport { setTransport } from ${JSON.stringify(join(process.cwd(), 'src/kit/core.ts'))}\n`)
  const { queue, setTransport } = await load(entry, 'tsconfig.web.json')
  const sent = []
  let answer = () => Promise.resolve({ id: 'run', status: 'queued' })
  setTransport({ call: (_c, tool, args) => (tool === 'session_send' ? (sent.push(args), answer(args)) : Promise.resolve([])), post: () => {} })
  const saved = () => JSON.parse(stored.get('sb.agent.queue') ?? '{}')
  const item = (id, extra = {}) => ({ id, text: id, prompt: `prompt ${id}`, files: [], ...extra })

  // A send that is turned down keeps its message, first in line, even with no panel to put it back.
  let reject
  answer = () => new Promise((_, r) => (reject = r))
  queue.add('s1', item('a', { model: 'model-b', effort: 'low' }))
  queue.add('s1', item('b', { model: 'model-a', effort: 'high' }))
  queue.heard('s1', 'running')
  check('nothing goes while the conversation works', sent.length === 0)
  queue.heard('s1', 'completed')
  check('the first goes once it is done, with the model and effort it was written with', sent.length === 1 && sent[0].prompt === 'prompt a' && sent[0].model === 'model-b' && sent[0].effort === 'low', JSON.stringify(sent))
  check('while it is on its way it stays in the stored queue', saved().s1?.[0]?.id === 'a' && saved().s1[0].sending === true, JSON.stringify(saved()))
  queue.remove('s1', 'a')
  check('a message on its way cannot be taken off', saved().s1?.length === 2)
  reject(new Error('engine went away'))
  await sleep(10)
  check('turned down, it is still first in the stored queue, marked as failed', saved().s1?.map((x) => x.id).join() === 'a,b' && !saved().s1[0].sending && saved().s1[0].failed === 'engine went away', JSON.stringify(saved()))
  answer = () => Promise.resolve({ id: 'run', status: 'queued' })
  await sleep(1600)
  check('a failed message is not tried again on its own, and the ones after it wait', sent.length === 1)

  // Retried, both go, in order, each with its own model: the second goes back to model-a.
  queue.retry('s1', 'a')
  await sleep(10)
  check('retried, it goes again', sent.length === 2 && sent[1].prompt === 'prompt a')
  check('sent, it leaves the queue', saved().s1?.map((x) => x.id).join() === 'b')
  queue.heard('s1', 'running')
  queue.heard('s1', 'completed')
  await sleep(1600)
  check('the next goes with its own model and effort, not the last one sent', sent.length === 3 && sent[2].model === 'model-a' && sent[2].effort === 'high', JSON.stringify(sent[2]))
  check('an empty queue is not kept', !('s1' in saved()))

  // A stop holds the queue, unless the stop was to steer.
  queue.heard('s2', 'running')
  queue.add('s2', item('c'))
  queue.add('s2', item('d'))
  queue.heard('s2', 'cancelled')
  check('after a stop the queue waits', sent.length === 3)
  queue.steer('s2', 'd')
  await sleep(10)
  check('steering sends that one first, through the stop', sent.length === 4 && sent[3].prompt === 'prompt d')

  // A turn that failed holds the queue too: the rest should not pile into a broken provider.
  queue.heard('s4', 'running')
  queue.add('s4', item('f'))
  queue.heard('s4', 'failed')
  await sleep(10)
  check('after a failed turn the queue waits', sent.length === 4)
  queue.next('s4', true)
  await sleep(10)
  check('Send next sends it anyway', sent.length === 5 && sent[4].prompt === 'prompt f')
  await sleep(1600)

  // A refusal because the conversation works is not a failure: it goes the next time it is done.
  answer = () => Promise.reject(new Error('Session has active work'))
  queue.heard('s3', 'completed')
  queue.add('s3', item('e'))
  await sleep(10)
  check('refused as busy, it waits without failing', sent.length === 6 && saved().s3?.[0] && !saved().s3[0].failed && !saved().s3[0].sending, JSON.stringify(saved().s3))
  answer = () => Promise.resolve({ id: 'run', status: 'queued' })
  queue.heard('s3', 'running')
  queue.heard('s3', 'completed')
  await sleep(1600)
  check('and then goes', sent.length === 7 && !saved().s3)

  // What was heard about a conversation does not outlive its queue: the next one waits to hear afresh.
  await sleep(1600)
  queue.add('s3', item('g'))
  await sleep(10)
  check('a new queue does not go on what was heard before it', sent.length === 7)
  queue.heard('s3', 'completed')
  await sleep(10)
  check('it goes once the engine says so again', sent.length === 8)

  // An edit holds the message, and the ones after it, until it is saved; what the panel added stays.
  await sleep(1600)
  queue.heard('s5', 'running')
  queue.add('s5', item('j', { text: 'old words', prompt: 'old words\n\n[Workspace attached: x]', context: '\n\n[Workspace attached: x]' }))
  queue.add('s5', item('k'))
  queue.editing('s5', 'j', true)
  queue.setDraft('s5', 'j', 'half written')
  queue.heard('s5', 'completed')
  await sleep(10)
  check('a message being edited does not go, nor the ones after it', sent.length === 8 && saved().s5?.[0]?.editing === true)
  check('what is typed into the edit is kept for its editor to come back to, and not stored', queue.draft('s5', 'j') === 'half written' && !stored.get('sb.agent.queue').includes('half written'))
  queue.rewrite('s5', 'j', 'new words')
  await sleep(10)
  check('saved, its draft goes', queue.draft('s5', 'j') === undefined)
  check('saved, it goes with the new words and what was attached to it', sent.length === 9 && sent[8].prompt === 'new words\n\n[Workspace attached: x]' && !saved().s5?.some((x) => x.id === 'j'), JSON.stringify(sent[8]))
  await sleep(1600)
  queue.heard('s5', 'completed')
  await sleep(10)
  check('and the next one follows', sent.length === 10 && sent[9].prompt === 'prompt k')
  await sleep(1600)
  // One queued before edits kept what was added: it is found where the panel's blocks start.
  queue.heard('s6', 'running')
  queue.add('s6', item('l', { text: 'before', prompt: 'before\n\n[I pointed at these parts: y]' }))
  queue.editing('s6', 'l', true)
  queue.rewrite('s6', 'l', 'after')
  check('an older message keeps what was added to it too', saved().s6?.[0]?.prompt === 'after\n\n[I pointed at these parts: y]' && saved().s6[0].text === 'after' && !saved().s6[0].editing, JSON.stringify(saved().s6))
  queue.editing('s6', 'l', true)
  queue.setDraft('s6', 'l', 'never saved')
  queue.editing('s6', 'l', false)
  check('an edit put down drops its draft: editing again starts from the message', queue.draft('s6', 'l') === undefined)
  check('an edit put down leaves it as it was', saved().s6?.[0]?.prompt === 'after\n\n[I pointed at these parts: y]' && !saved().s6[0].editing)
  queue.remove('s6', 'l')

  // Unreadable storage costs the queue, not the app.
  stored.set('sb.agent.queue', '{not json')
  const again = join(tmp, 'queue-entry-2.ts')
  writeFileSync(again, `export * from ${JSON.stringify(join(process.cwd(), 'src/renderer/src/agentQueue.ts'))}\n`)
  const fresh = await load(again, 'tsconfig.web.json').catch((e) => e)
  check('a queue that cannot be read starts empty', !(fresh instanceof Error) && typeof fresh.queue?.add === 'function', fresh instanceof Error ? fresh.message : '')

  // A send or a steer cut off by the app quitting waits like the rest when it opens again.
  stored.set('sb.agent.queue', JSON.stringify({ s9: [item('h', { now: true, sending: true, editing: true })] }))
  const third = join(tmp, 'queue-entry-3.ts')
  writeFileSync(third, `export * from ${JSON.stringify(join(process.cwd(), 'src/renderer/src/agentQueue.ts'))}\n`)
  const reopened = await load(third, 'tsconfig.web.json')
  reopened.queue.add('s10', item('i'))
  check('after a restart a saved message is neither sending, steering nor being edited', JSON.stringify(saved().s9) === JSON.stringify([item('h')]), JSON.stringify(saved().s9))
}

// ── OAuth sign-ins: refreshed through blips in the server's metadata, never re-registered elsewhere, one refresh per refresh token
{
  console.log('oauth sign-ins')
  const { oauthProvider } = await load('src/main/oauthProvider.ts')
  const { refreshOnce } = await load('src/main/oauthRefresh.ts')
  const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js')
  const MCP = 'https://mcp.example/mcp'
  const AS = 'https://auth.example'
  // An MCP server whose authorization server lives elsewhere, rotating refresh tokens (each works once).
  // Its own origin also answers as an authorization server, as proxies in front of one do.
  const srv = { prmDown: false, valid: new Map([['r1', 'c1']]), n: 1, tokenPosts: 0, registered: [] }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const asMeta = (o) => ({ issuer: o, authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token`, registration_endpoint: `${o}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] })
  const fake = async (input, init = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input))
    const body = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(typeof init.body === 'string' ? init.body : '')
    if (u.origin === 'https://mcp.example' && u.pathname.startsWith('/.well-known/oauth-protected-resource')) return srv.prmDown ? new Response('busy', { status: 503 }) : json({ resource: MCP, authorization_servers: [AS] })
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(asMeta(u.origin))
    if (u.pathname === '/register') {
      srv.registered.push(u.origin)
      return json({ client_id: `reg-${srv.registered.length}`, ...JSON.parse(init.body) }, 201)
    }
    if (u.origin === AS && u.pathname === '/token' && body.get('grant_type') === 'authorization_code' && body.get('code') === 'grant-workers') {
      const next = `r${++srv.n}`
      srv.valid.set(next, body.get('client_id'))
      return json({ access_token: `a${srv.n}`, token_type: 'Bearer', expires_in: 3600, refresh_token: next, scope: 'workers:read' })
    }
    if (u.origin === AS && u.pathname === '/token' && body.get('grant_type') === 'refresh_token') {
      srv.tokenPosts++
      await sleep(20)
      const rt = body.get('refresh_token')
      if (srv.valid.get(rt) !== body.get('client_id')) return json({ error: 'invalid_grant' }, 400)
      srv.valid.delete(rt)
      const next = `r${++srv.n}`
      srv.valid.set(next, body.get('client_id'))
      return json({ access_token: `a${srv.n}`, token_type: 'Bearer', expires_in: 3600, refresh_token: next })
    }
    return new Response('not found', { status: 404 })
  }
  const redirect = 'http://127.0.0.1:1/oauth/callback'
  const kept = { client: { client_id: 'c1', redirect_uris: [redirect], issuer: AS }, tokens: { access_token: 'a1', token_type: 'Bearer', refresh_token: 'r1', issuer: AS }, savedAt: 0, verifier: 'v' }
  const asked = []
  const provider = oauthProvider({ id: 'x', redirect, data: () => kept, forget: () => {}, save: () => {}, interactive: () => false, redirectToAuthorization: (url, renewable) => void asked.push(renewable) })
  const fetchFn = refreshOnce(fake)
  const run = () => auth(provider, { serverUrl: MCP, fetchFn }).catch((e) => `threw ${e.message}`)
  const old = () => (kept.savedAt = 0) // as if the last refresh were long ago

  check('a refresh rotates the token', (await run()) === 'AUTHORIZED' && kept.tokens.refresh_token === 'r2' && srv.valid.has('r2'), JSON.stringify(kept.tokens))
  check('where the authorization server is gets kept', kept.discovery?.authorizationServerUrl === AS)
  old()
  srv.prmDown = true
  check("with the server's metadata down, the refresh still goes to the right place", (await run()) === 'AUTHORIZED' && kept.tokens.refresh_token === 'r3' && srv.registered.length === 0, `${JSON.stringify(kept.tokens)} ${srv.registered}`)

  // An install from before discovery was kept, meeting the same blip: the SDK falls back to the
  // server's own origin and registers there. That client must not replace the one the token belongs to.
  delete kept.discovery
  old()
  const r = await run()
  check('the fallback really registers elsewhere', srv.registered.join() === 'https://mcp.example', srv.registered.join())
  check('… but the client the refresh token belongs to is kept', kept.client.client_id === 'c1', kept.client.client_id)
  check('… and so is the refresh token, to try again', kept.tokens.refresh_token === 'r3' && asked.at(-1) === true && r === 'REDIRECT', `${r} ${asked}`)
  srv.prmDown = false
  old()
  check('once the metadata answers again, the refresh works', (await run()) === 'AUTHORIZED' && kept.tokens.refresh_token === 'r4')

  // Calls that find the token expired together share one refresh.
  old()
  const posts = srv.tokenPosts
  const [a, b, c] = await Promise.all([run(), run(), run()])
  check('three at once: one refresh, all signed in', a === 'AUTHORIZED' && b === 'AUTHORIZED' && c === 'AUTHORIZED' && srv.tokenPosts - posts === 1 && srv.valid.has(kept.tokens.refresh_token), `${a} ${b} ${c} posts ${srv.tokenPosts - posts}`)

  // A scope challenge requires fresh consent; refreshing the same grant cannot add access.
  const { consentScope, scopeAwareFetch, ScopeRequiredError } = await load('src/main/oauthScope.ts')
  check('permission upgrades retain offline access and already granted scopes without duplicates', consentScope('user:read offline_access account:read', 'user:read account:read zone.read') === 'user:read offline_access account:read zone.read')
  check('a challenge without a scope leaves discovery in charge', consentScope('account:read', undefined) === undefined)
  const challenges = []
  const challenged = scopeAwareFetch(async () => new Response('permission required', { status: 403, headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="workers:read", resource_metadata="${MCP}/metadata"` } }), MCP, (c) => challenges.push(c))
  let scopeError
  try { await challenged(MCP) } catch (e) { scopeError = e }
  check('a server scope challenge pauses the request instead of refreshing old permissions', scopeError instanceof ScopeRequiredError && challenges[0]?.scope === 'workers:read' && challenges[0]?.resourceMetadataUrl === `${MCP}/metadata`)
  const unrelated = await challenged(`${AS}/token`)
  check('another origin cannot request a connector permission upgrade', unrelated.status === 403 && challenges.length === 1)
  const ordinary = scopeAwareFetch(async () => new Response('denied', { status: 403 }), MCP, (c) => challenges.push(c))
  check('a plain 403 is not a consent challenge', (await ordinary(MCP)).status === 403 && challenges.length === 1)
  const consentUrls = []
  const beforeConsent = structuredClone(kept.tokens)
  const beforePosts = srv.tokenPosts
  const consenting = oauthProvider({ id: 'x', redirect, data: () => kept, forget: () => {}, save: () => {}, interactive: () => true, consent: true, redirectToAuthorization: (url) => void consentUrls.push(url) })
  const consentResult = await auth(consenting, { serverUrl: MCP, scope: 'workers:read', fetchFn })
  check('a user permission upgrade opens consent with exactly the requested scope', consentResult === 'REDIRECT' && consentUrls.length === 1 && consentUrls[0].searchParams.get('scope') === 'workers:read')
  check('opening consent keeps existing tokens and never posts their refresh token', JSON.stringify(kept.tokens) === JSON.stringify(beforeConsent) && srv.tokenPosts === beforePosts)
  const backgroundConsent = oauthProvider({ id: 'x', redirect, data: () => kept, forget: () => {}, save: () => {}, interactive: () => false, consent: true, redirectToAuthorization: () => {} })
  check('consent mode cannot hide credentials without an explicit user action', backgroundConsent.tokens() === kept.tokens)
  const finishedConsent = await auth(provider, { serverUrl: MCP, authorizationCode: 'grant-workers', fetchFn })
  check('finishing consent replaces the old grant with the newly approved scopes', finishedConsent === 'AUTHORIZED' && kept.tokens.scope === 'workers:read' && kept.tokens.access_token !== beforeConsent.access_token)


  // Revoked: the server refuses the refresh token, which is then dropped and a sign-in asked for.
  old()
  srv.valid.clear()
  const asks = asked.length
  check('a refused refresh token is let go, and a sign-in asked for', (await run()) === 'REDIRECT' && !kept.tokens && asked.length === asks + 1 && asked.at(-1) === false, JSON.stringify(kept.tokens))

  kept.verifier = 'v2'
  provider.invalidateCredentials('discovery')
  check('forgetting discovery keeps the code verifier', kept.verifier === 'v2' && !kept.discovery)
}

// ── which connector tools agents may run without asking: what servers declared, never a guess from a name
{
  console.log('read-only connector tools')
  const { toolInfo, agentReadOnly } = await load('src/main/readOnly.ts')
  const listed = [{ name: 'get_or_create_record' }, { name: 'list_records' }, { name: 'list_declared', annotations: { readOnlyHint: true } }, { name: 'get_said_writes', annotations: { readOnlyHint: false } }].map(toolInfo)
  check('a name that looks like a read is still guessed read-only for display', listed[0].readOnly === true && listed[0].declaredReadOnly === false)
  const external = { transport: 'http' }
  // What the hub advertises, as Claude Code reports it back for the agent's connectors.
  const advertised = listed.map((t) => [t.name, agentReadOnly(external, t)])
  check('the hub advertises only declared read-only tools of an outside connector', JSON.stringify(advertised) === JSON.stringify([['get_or_create_record', false], ['list_records', false], ['list_declared', true], ['get_said_writes', false]]), JSON.stringify(advertised))
  const internal = { transport: 'internal' }
  check("the app's own connectors keep their own read-only flags", agentReadOnly(internal, { name: 'workspace_list', readOnly: true }) === true && agentReadOnly(internal, { name: 'workspace_delete', readOnly: false }) === false && agentReadOnly(internal, { name: 'my_custom_tool' }) === false)
}

{
  // Where a conversation came from: put on it as it starts, whatever the caller claimed, and read back for the list of agents running.
  const { withProvenance } = await load('src/main/services/Connectors.ts')
  const { originOf, workspaceOf } = await load('src/shared/provenance.ts')
  const started = withProvenance('session_start', { harness: 'claude', prompt: 'hi', labels: { title: 'Hi', sb_by: 'user', sb_via: 'schedule:forged' } }, { by: 'tool:triage', via: 'schedule:s1', depth: 1 })
  check('a session a tool starts says which tool, and what ran it; claimed labels are replaced', JSON.stringify(started.labels) === JSON.stringify({ title: 'Hi', sb_by: 'tool:triage', sb_via: 'schedule:s1' }), JSON.stringify(started.labels))
  const page = withProvenance('session_start', { harness: 'claude', prompt: 'hi', labels: { sb_via: 'agent' } }, { by: 'workspace:revenue', depth: 0 })
  check('a session a page starts has no via, even a claimed one', JSON.stringify(page.labels) === JSON.stringify({ sb_by: 'workspace:revenue' }), JSON.stringify(page.labels))
  const sched = withProvenance('schedule_create', { name: 'Digest', cron: '0 9 * * 1-5', launch: { harness: 'claude', prompt: 'digest', labels: { sb_by: 'user' } } }, { by: 'agent', depth: 0 })
  check("an agent schedule's launch carries its name and cron", JSON.stringify(sched.launch.labels) === JSON.stringify({ sb_by: 'schedule', sb_schedule: 'Digest', sb_cron: '0 9 * * 1-5' }), JSON.stringify(sched.launch.labels))
  check('a schedule that continues a conversation is left alone, as are other tools', !withProvenance('schedule_create', { name: 'x', launch: { session_id: 'a', prompt: 'p' } }, { by: 'agent', depth: 0 }).launch.labels && withProvenance('session_list', { labels: { a: 'b' } }, { by: 'agent', depth: 0 }).labels.a === 'b')
  const o = (labels) => JSON.stringify(originOf(labels))
  check('the panel is the panel, whoever asked', o({ kind: 'agent', conversation: 'c-1', sb_by: 'user' }) === JSON.stringify({ kind: 'panel' }))
  check('a tool run by a schedule', o({ sb_by: 'tool:triage', sb_via: 'schedule:s1' }) === JSON.stringify({ kind: 'tool', tool: 'triage', via: { kind: 'schedule', id: 's1' } }), o({ sb_by: 'tool:triage', sb_via: 'schedule:s1' }))
  check('a page, an agent, an agent schedule, the user', o({ sb_by: 'workspace:w1' }) === JSON.stringify({ kind: 'workspace', workspace: 'w1' }) && o({ sb_by: 'agent' }) === JSON.stringify({ kind: 'agent' }) && o({ sb_by: 'schedule', sb_schedule: 'D', sb_cron: '* * * * *' }) === JSON.stringify({ kind: 'schedule', name: 'D', cron: '* * * * *' }) && o({ sb_by: 'user' }) === JSON.stringify({ kind: 'you' }))
  check('before these labels: a workspace by its ownership label, else unknown', o({ sb_owner: 'w2@2026-10-01T00:00:00Z' }) === JSON.stringify({ kind: 'workspace', workspace: 'w2' }) && o({}) === JSON.stringify({ kind: 'unknown' }))
  check('the workspace: the one it is about, else the page that started it or ran its tool', workspaceOf({ workspace: 'a', sb_by: 'workspace:b' }) === 'a' && workspaceOf({ sb_by: 'tool:t', sb_via: 'workspace:c' }) === 'c' && workspaceOf({ sb_by: 'tool:t', sb_via: 'schedule:s' }) === null)
}

// ── /login: an agent's sign-in, run in a terminal window from a script that cleans up after itself
{
  console.log('sign-in terminal')
  const { terminalScript } = await load('src/main/terminal.ts')
  const { execFileSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const bin = join(tmp, "a b's bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'fake-login'), '#!/bin/sh\necho "signed in as $1"\n', { mode: 0o755 })
  const file = join(tmp, 'sign-in.command')
  writeFileSync(file, terminalScript(['fake-login', "o'neil"], "Done. Go back to Lynx's window.", `${bin}:/usr/bin:/bin`), { mode: 0o700 })
  const out = execFileSync(file, { encoding: 'utf8', env: { TERM: 'dumb' } })
  check('runs the command from the PATH it was given, every word kept as it is', out.includes("signed in as o'neil"), out)
  check('then says what to do next', out.includes("Done. Go back to Lynx's window."), out)
  check('and removes its own file', !existsSync(file))

  // An install outside PATH (claude-bin.ts finds ~/.claude/local, AGENT_CLAUDE_BIN), named by its path.
  const away = join(tmp, "not on 'path'", 'claude')
  mkdirSync(join(away, '..'), { recursive: true })
  writeFileSync(away, '#!/bin/sh\necho "claude $*"\n', { mode: 0o755 })
  const awayFile = join(tmp, 'away.command')
  writeFileSync(awayFile, terminalScript([away, 'auth', 'login'], 'done', '/usr/bin:/bin'), { mode: 0o700 })
  const awayOut = execFileSync(awayFile, { encoding: 'utf8', env: { TERM: 'dumb' } })
  check('an install outside PATH runs by its path', awayOut.includes('claude auth login'), awayOut)
  const { runnable } = await load('src/main/terminal.ts')
  check('names, flags and absolute paths are runnable', runnable(['claude', 'auth', 'login']) && runnable([away, 'auth', 'login']))
  check('a relative path, a line break or shell syntax is not', !runnable(['bin/claude']) && !runnable(['/x/claude\nrm -rf ~']) && !runnable(['claude; rm']) && !runnable(['$(id)']) && !runnable([]) && !runnable('claude'))

  // open's own end says whether Terminal was asked for the window.
  const { launch } = await load('src/main/terminal.ts')
  check('a launcher that ends with a fault fails, so the command is copied instead', /code 1|failed/i.test(await throws(() => launch('/bin/sh', ['-c', 'exit 1']))))
  check('a launcher that ends cleanly opened its window', (await throws(() => launch('/bin/sh', ['-c', 'exit 0']))) === '')
  check('a launcher that is not there fails', !!(await throws(() => launch(join(tmp, 'no-such-terminal'), []))))

  // The engine names the install it runs: AGENT_CLAUDE_BIN and AGENT_CODEX_BIN too.
  process.env.AGENT_CLAUDE_BIN = away
  process.env.AGENT_CODEX_BIN = '/opt/codex dir/codex'
  const { providers } = await load('src/agentd/providers/registry.ts')
  const login = (id) => providers().find((p) => p.id === id).login_command()
  check('Claude Code signs in with the install the engine found', JSON.stringify(login('claude')) === JSON.stringify([away, 'auth', 'login']), JSON.stringify(login('claude')))
  check('and Codex', JSON.stringify(login('codex')) === JSON.stringify(['/opt/codex dir/codex', 'login']), JSON.stringify(login('codex')))
  delete process.env.AGENT_CLAUDE_BIN
  delete process.env.AGENT_CODEX_BIN
}

// ── first run: a workspace from the main template of each connected service that has one, once
{
  console.log('first run templates')
  const { plannedTemplates } = await load('src/renderer/src/firstRunTemplates.ts', 'tsconfig.web.json')
  const req = (alias, url, optional = false) => ({ alias, url, optional })
  const items = [
    { id: 'github-pulls', requires: [req('github', 'https://api.githubcopilot.com/mcp/')] },
    { id: 'linear-team-issues', requires: [req('linear', 'https://mcp.linear.app/mcp')] },
    { id: 'granola-notes', requires: [req('granola', 'https://mcp.granola.ai/mcp')] },
    { id: 'oneleet-soc2', requires: [req('oneleet', 'https://api.oneleet.com/mcp'), req('github', 'https://api.githubcopilot.com/mcp/', true)] },
  ].map((i) => ({ ...i, name: i.id, source: 'remote', creator: 'official' }))
  const c = (id, url, status = 'connected') => ({ id, name: id, url, status })
  const gh = c('gh', 'https://api.githubcopilot.com/mcp/')
  const plan = plannedTemplates([gh, c('granola', 'https://mcp.granola.ai/mcp'), c('linear', 'https://mcp.linear.app/mcp'), c('pg', undefined)], items, [])
  check('one main template for each connected service that has one', plan.map((p) => p.item).join() === 'github-pulls,linear-team-issues,granola-notes', plan.map((p) => p.item).join())
  check('a template that needs a service not connected is left out', !plan.some((p) => p.item === 'oneleet-soc2'))
  const optional = plannedTemplates([gh, c('oneleet', 'https://api.oneleet.com/mcp')], items, []).find((p) => p.item === 'oneleet-soc2')
  check('it binds the connector, and an optional one when it is connected too', optional?.connectors.oneleet === 'oneleet' && optional?.connectors.github === 'gh')
  check('one already made is not made again', !plannedTemplates([gh], items, [{ origin: 'github-pulls' }]).length)
  check('remote origins are not created twice', !plannedTemplates([gh], items, [{ origin: 'remote:github-pulls@https://m.example' }]).length)
  check('local and community look-alikes are not auto-installed', !plannedTemplates([gh], items.map((i) => ({ ...i, creator: 'community' })), []).length && !plannedTemplates([gh], items.map((i) => ({ ...i, source: 'local' })), []).length)
  check('a catalog that has not loaded yet produces no installs', !plannedTemplates([gh], [], []).length)
  check('one not connected yet is left for later', !plannedTemplates([c('gh', gh.url, 'auth-required')], items, []).length)
}

// ── first run: the line under the agents says who is ready and what the others still need
{
  console.log('first run agents')
  const { agentStatus } = await load('src/renderer/src/agentStatus.ts', 'tsconfig.web.json')
  const cc = (state) => ({ title: 'Claude Code', state })
  const cx = (state) => ({ title: 'Codex', state })
  const say = (a, b) => agentStatus([cc(a), cx(b)], false)
  check('while looking it says so, and is neither good nor bad', agentStatus([], true).ok === null && /Looking/.test(agentStatus([], true).text))
  check('both ready', say('ready', 'ready').ok === true && say('ready', 'ready').text === 'Claude Code and Codex are ready.', say('ready', 'ready').text)
  check('one ready, the other signed out', say('ready', 'out').text === "Claude Code is ready. Codex isn't signed in yet.", say('ready', 'out').text)
  check('one ready, the other not installed', say('missing', 'ready').text === "Codex is ready. Claude Code isn't installed.", say('missing', 'ready').text)
  check('none ready, one signed out: sign in to it', say('out', 'missing').ok === false && say('out', 'missing').text === 'Sign in to Claude Code to continue.', say('out', 'missing').text)
  check('none ready, both signed out', say('out', 'out').text === 'Sign in to Claude Code or Codex to continue.', say('out', 'out').text)
  check('none installed: what Lynx needs', say('missing', 'missing').ok === false && say('missing', 'missing').text.startsWith('Lynx needs Claude Code or Codex to be installed'))
}

// ── onboarding: a connection is written down as told only once the onboarding conversation has it
{
  console.log('onboarding connections')
  const stored = new Map()
  globalThis.localStorage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: (k) => stored.delete(k) }
  const { lookAtConnections, putAway } = await load('src/renderer/src/onboarding.ts', 'tsconfig.web.json')
  const told = () => JSON.parse(stored.get('sb.onboarding.told') ?? 'null')
  const linear = { id: 'linear', name: 'Linear', native: false, status: 'connected' }
  const github = { id: 'github', name: 'GitHub', native: false, status: 'connected' }
  check('the first look writes down what is there already', (await lookAtConnections([], async () => true)) && JSON.stringify(told()) === '[]')

  // The agent does not start (no provider yet): the connection waits, and goes on the next look.
  const asked = []
  let ok = false
  const start = async (text) => (asked.push(text), ok)
  check('a start that fails asks for another look', (await lookAtConnections([linear], start)) === false && asked.length === 1)
  check('and leaves the connection untold', JSON.stringify(told()) === '[]', JSON.stringify(told()))
  ok = true
  check('the next look starts it with that connection', (await lookAtConnections([linear], start)) === true && asked.length === 2 && asked[1].includes('Linear'), JSON.stringify(asked))
  check('which is then written down', JSON.stringify(told()) === '["linear"]')
  check('and not told again', (await lookAtConnections([linear], start)) && asked.length === 2)

  // A look while a start is under way does not start another for the same connection.
  let finish
  const slow = (text) => (asked.push(text), new Promise((r) => (finish = r)))
  const first = lookAtConnections([linear, github], slow)
  const second = await lookAtConnections([linear, github], slow)
  check('a look while one is starting it leaves it to that one', second === true && asked.length === 3)
  finish(true)
  check('which then writes it down', (await first) && JSON.stringify(told()) === '["linear","github"]', JSON.stringify(told()))

  // A start that fails, then the checklist put away: the connection is still owed, and goes once it comes back.
  const sentry = { id: 'sentry', name: 'Sentry', native: false, status: 'connected' }
  const notion = { id: 'notion', name: 'Notion', native: false, status: 'connected' }
  ok = false
  check('a failed start for another connection', (await lookAtConnections([linear, github, sentry], start)) === false && asked.length === 4)
  putAway([linear, github, sentry, notion])
  check('put away, what connects meanwhile is written down, the failed one is not', JSON.stringify(told()) === '["linear","github","notion"]', JSON.stringify(told()))
  ok = true
  check('back again, the failed one is tried again and goes', (await lookAtConnections([linear, github, sentry, notion], start)) === true && asked.length === 5 && asked[4].includes('Sentry') && !asked[4].includes('Notion'), JSON.stringify(asked))
  check('and is written down, waiting on nothing', JSON.stringify(told()) === '["linear","github","notion","sentry"]' && !stored.has('sb.onboarding.waiting'), JSON.stringify(told()))
  putAway([linear, github, sentry, notion])
  check('put away again, nothing changes', JSON.stringify(told()) === '["linear","github","notion","sentry"]')
  delete globalThis.localStorage
}

// ── Caffeinate in the command bar: the hours typed, and macOS's caffeinate run, found again and stopped
{
  console.log('caffeinate')
  const { parseHours, hoursLabel } = await load('src/shared/caffeinate.ts')
  for (const [text, want] of [['2', 2], ['1.5', 1.5], ['0,5', 0.5], [' 3h ', 3], ['4 hours', 4], ['.25', 0.25], ['168', 168]]) check(`"${text}" is ${want} hours`, parseHours(text) === want, String(parseHours(text)))
  for (const text of ['', 'abc', '0', '-1', '169', '2 days', '1e3']) check(`"${text}" is no number of hours`, parseHours(text) === null, String(parseHours(text)))
  check('hours in words', hoursLabel(1) === '1 hour' && hoursLabel(2.5) === '2.5 hours' && hoursLabel(0.5) === '30 minutes', `${hoursLabel(1)} / ${hoursLabel(2.5)} / ${hoursLabel(0.5)}`)
  const { makeCaffeinate, caffeinateArgs } = await load('src/main/caffeinate.ts')
  check('idle and system sleep held off (the screen may sleep), for the seconds asked', JSON.stringify(caffeinateArgs(1.5)) === JSON.stringify(['-ims', '-t', '5400']))
  const dir = mkdtempSync(join(tmp, 'caf-'))
  const caf = makeCaffeinate(dir)
  check('nothing going at first', caf.status() === null)
  check('a run of no time is refused', !!(await throws(() => caf.start(0))))
  const until = await caf.start(1 / 60)
  check('a run ends when asked', Math.abs(until - (Date.now() + 60000)) < 2000, String(until - Date.now()))
  const { pid } = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'caffeinate.json'), 'utf8'))
  const alive = (p) => { try { process.kill(p, 0); return true } catch { return false } }
  check('caffeinate is running', alive(pid))
  check('a later window finds it', makeCaffeinate(dir).status() === until)
  const next = await caf.start(2 / 60)
  await sleep(100)
  check('a new run takes the place of the one going', !alive(pid) && caf.status() === next)
  const { pid: pid2 } = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'caffeinate.json'), 'utf8'))
  check('stop ends it', caf.stop() === null && caf.status() === null)
  await sleep(100)
  check('and the process is gone', !alive(pid2))
  // A pid outlives its run only to be given to another process: a record is trusted only for the very process it names.
  const { writeFileSync: write } = await import('node:fs')
  const later = Date.now() + 3600000
  write(join(dir, 'caffeinate.json'), JSON.stringify({ pid: process.pid, until: later, id: 'Thu Jan  1 00:00:00 1970     /usr/bin/caffeinate' }))
  check('a pid now another process is no run going', caf.status() === null)
  write(join(dir, 'caffeinate.json'), JSON.stringify({ pid: process.pid, until: later, id: 'Thu Jan  1 00:00:00 1970     /usr/bin/caffeinate' }))
  caf.stop()
  check('and stopping leaves that process alone', alive(process.pid))
  const other = (await import('node:child_process')).spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  await sleep(100)
  write(join(dir, 'caffeinate.json'), JSON.stringify({ pid: other.pid, until: later, id: 'Thu Jan  1 00:00:00 1970     /usr/bin/caffeinate' }))
  await caf.start(1 / 60)
  check('a new run leaves it alone too', alive(other.pid) && caf.status() !== null)
  other.kill()
  write(join(dir, 'caffeinate.json'), JSON.stringify({ pid: process.pid, until: later }))
  check('a record from before identities is not trusted either', caf.status() === null)
  caf.stop()
}

// ── folders followed for changes: a watch that fails (EMFILE when the system runs short) is started again, not fatal
{
  console.log('watch')
  const { follow } = await load('src/main/watch.ts')
  const { EventEmitter } = await import('node:events')
  const emfile = () => Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' })
  let starts = 0
  let live = null
  const start = (_path, _opts, listener) => {
    if (++starts === 1) throw emfile()
    live = Object.assign(new EventEmitter(), { listener, closed: false, close() { this.closed = true } })
    return live
  }
  const seen = []
  const quiet = console.error
  console.error = () => {}
  const f = follow('/nowhere', { label: 'test', retryMs: 20, start }, (file) => seen.push(file))
  check('a watch that cannot start is not fatal', starts === 1 && live === null)
  await sleep(60)
  check('it starts again, and says something may have changed meanwhile', starts === 2 && JSON.stringify(seen) === '[null]', JSON.stringify(seen))
  live.listener('change', 'settings.json')
  check('changes come with their file', seen.at(-1) === 'settings.json')
  const first = live
  first.emit('error', emfile())
  check('one that fails later is closed, not thrown', first.closed)
  await sleep(60)
  check('and is started again too', starts === 3 && live !== first && seen.at(-1) === null)
  f.close()
  check('closed, it stays closed', live.closed)
  first.emit('error', emfile())
  await sleep(60)
  check('and is not started again', starts === 3)
  console.error = quiet
}

// ── what Point's note box can mention
{
  console.log('point mentions')
  const { pointMentions } = await load('src/renderer/src/pointMentions.tsx', 'tsconfig.web.json')
  const ws = [{ id: 'w1', name: 'Revenue' }, { id: 'w2', name: 'Here' }]
  const cx = [
    { id: 'slow', name: 'Slow site', url: 'https://slow.example' },
    { id: 'fast', name: 'Fast site', url: 'https://fast.example' },
  ]
  const lists = []
  let late
  const icon = (c) => (c.id === 'slow' ? new Promise((r) => (late = r)) : Promise.resolve('data:image/png;base64,AA'))
  const stop = pointMentions(ws, cx, 'w2', icon, (l) => lists.push(l))
  check('every mention is there at once, an icon still coming', lists.length === 1 && lists[0].map((m) => m.id).join() === 'w2,w1,slow,fast', JSON.stringify(lists[0]?.map((m) => m.id)))
  check('connectors start with their glyphs', lists[0].filter((m) => m.kind === 'connector').every((m) => /^<svg/.test(m.svg) && !m.img))
  await sleep(0)
  const now = lists.at(-1)
  check('an icon that comes takes its glyph\'s place, the slow one still pending', now.find((m) => m.id === 'fast').img && !now.find((m) => m.id === 'slow').img && now.length === 4)
  stop()
  late('data:image/png;base64,BB')
  await sleep(0)
  check('once stopped, a late icon changes nothing', !lists.at(-1).find((m) => m.id === 'slow').img)
}

// Settings › Usage: Claude Code's get_usage and Codex's account/rateLimits/read, as windows.
{
  console.log('usage')
  const { claudeWindows, claudeExtra, codexWindows, codexExtra } = await load('src/shared/usage.ts')
  const claude = claudeWindows({ five_hour: { utilization: 42.5, resets_at: '2026-11-03T15:00:00Z' }, seven_day: { utilization: 130, resets_at: null }, seven_day_opus: null, model_scoped: [{ display_name: 'Fable', utilization: 10, resets_at: null }] })
  check('claude: its windows in order, named', claude.map((w) => w.name).join() === '5-hour limit,Weekly limit,Weekly · Fable', JSON.stringify(claude))
  check('claude: resets as ms, share kept within 0–100', claude[0].resetsAt === Date.parse('2026-11-03T15:00:00Z') && claude[0].used === 42.5 && claude[1].used === 100 && claude[1].resetsAt === null)
  check('claude: nothing known, no windows', claudeWindows(null).length === 0 && claudeWindows({ five_hour: { utilization: null } }).length === 0)
  check('claude: extra usage in money, from cents', /12\.40/.test(claudeExtra({ extra_usage: { is_enabled: true, used_credits: 1240, monthly_limit: 5000, currency: 'USD' } }) ?? '') && claudeExtra({ extra_usage: { is_enabled: false } }) === undefined)
  const snapshot = (limitId, primary, secondary = null) => ({ limitId, limitName: null, primary, secondary, credits: { hasCredits: false, unlimited: false, balance: '0' } })
  const one = codexWindows({ rateLimits: snapshot('codex', { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1793780169 }), rateLimitsByLimitId: { codex: snapshot('codex', { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1793780169 }) } })
  check('codex: one bucket, not counted twice; seconds as ms', one.length === 1 && one[0].name === 'Weekly limit' && one[0].resetsAt === 1793780169000, JSON.stringify(one))
  const two = codexWindows({ rateLimits: snapshot('codex', { usedPercent: 5, windowDurationMins: 300, resetsAt: null }), rateLimitsByLimitId: { codex: snapshot('codex', { usedPercent: 5, windowDurationMins: 300, resetsAt: null }, { usedPercent: 20, windowDurationMins: 10080, resetsAt: null }), spark: { ...snapshot('spark', { usedPercent: 50, windowDurationMins: 300, resetsAt: null }), limitName: 'Spark' } } })
  check('codex: several buckets, the others named', two.map((w) => w.name).join() === '5-hour limit,Weekly limit,5-hour limit · Spark', JSON.stringify(two))
  check('codex: without the by-id view, the single one', codexWindows({ rateLimits: snapshot('codex', { usedPercent: 3, windowDurationMins: 1440, resetsAt: null }) })[0]?.name === '1-day limit')
  check('claude: the OAuth-apps weekly window, alone, still counts', claudeWindows({ five_hour: null, seven_day: null, seven_day_oauth_apps: { utilization: 25, resets_at: null } }).map((w) => `${w.name}:${w.used}`).join() === 'Weekly · OAuth apps:25')
  check('codex: credits only when there are some', codexExtra({ rateLimits: snapshot('codex', null) }) === undefined && codexExtra({ rateLimits: { credits: { hasCredits: true, unlimited: false, balance: '40' } } }) === 'Credits: 40')
  // A stand-in app-server: account/read answers as FAKE_ACCOUNT says (an error, signed out, or signed in).
  const fake = join(tmp, 'fake-codex.mjs')
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'account/read') {
    const mode = process.env.FAKE_ACCOUNT
    if (mode === 'error') send({ id: m.id, error: { code: -32603, message: 'failed to refresh token: network error' } })
    else send({ id: m.id, result: { account: mode === 'out' ? null : { type: 'chatgpt', planType: 'plus' } } })
  } else if (m.method === 'account/rateLimits/read') send({ id: m.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: null }, secondary: null, planType: 'plus' }, rateLimitsByLimitId: null } })
})
`, { mode: 0o755 })
  const { codexUsage } = await load('src/main/usage.ts')
  const codexAs = async (mode) => {
    const was = { bin: process.env.AGENT_CODEX_BIN, mode: process.env.FAKE_ACCOUNT }
    process.env.AGENT_CODEX_BIN = fake
    process.env.FAKE_ACCOUNT = mode
    try {
      return await codexUsage()
    } finally {
      if (was.bin === undefined) delete process.env.AGENT_CODEX_BIN
      else process.env.AGENT_CODEX_BIN = was.bin
      if (was.mode === undefined) delete process.env.FAKE_ACCOUNT
      else process.env.FAKE_ACCOUNT = was.mode
    }
  }
  const broken = await codexAs('error')
  check('codex: an account/read error is an error, with what Codex said, not signed out', broken.status === 'error' && /refresh token: network error/.test(broken.detail ?? ''), JSON.stringify(broken))
  const out = await codexAs('out')
  check('codex: signed out only when account/read answers with no account', out.status === 'none' && /not signed in/.test(out.detail ?? ''), JSON.stringify(out))
  const signedIn = await codexAs('in')
  check('codex: signed in, its windows and plan', signedIn.status === 'ok' && signedIn.plan === 'plus' && signedIn.windows[0]?.name === '5-hour limit', JSON.stringify(signedIn))
}

await (await import('./service-regressions.mjs')).serviceRegressions({ load, tmp, check, throws, sleep })

rmSync(tmp, { recursive: true, force: true })
// Its service may still be answering a build that is being put away; cut off, it dumps a deadlock as it goes.
await stopEsbuild()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)

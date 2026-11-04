// Lifecycle regressions for connector calls and custom tools, using temporary storage and an MCP
// client stand-in. The tool sandbox, persistence, schedules and service layers are the real ones.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { mock } from 'node:test'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

export async function serviceRegressions({ load, tmp, check, throws, sleep }) {
  const { ConfigLive } = await load('src/main/services/Config.ts')
  const { EventsLive } = await load('src/main/services/Events.ts')
  const { Engine } = await load('src/main/services/Engine.ts')
  const { Connectors, ConnectorsLive } = await load('src/main/services/Connectors.ts')
  const base = (dataDir, hubPort = 1) => Layer.mergeAll(ConfigLive({ appRoot: process.cwd(), dataDir, hubPort, hubToken: 'test-only' }), EventsLive)

  console.log('connector retries')
  const dataDir = join(tmp, 'connector-retries')
  mkdirSync(dataDir, { recursive: true })
  let connected = 0
  let called = 0
  let action = async () => { throw new Error('fetch failed') }
  mock.method(Client.prototype, 'connect', async () => { connected++ })
  mock.method(Client.prototype, 'close', async function () { this.onclose?.() })
  mock.method(Client.prototype, 'listTools', async () => ({ tools: [
    { name: 'create_item', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'get_or_create_item', inputSchema: { type: 'object' } },
    { name: 'list_items', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ] }))
  mock.method(Client.prototype, 'callTool', async () => { called++; return action() })
  const reservation = createServer()
  await new Promise((resolve, reject) => reservation.once('error', reject).listen(0, '127.0.0.1', resolve))
  const hubPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const connectorBase = base(dataDir, hubPort)
  const cr = ManagedRuntime.make(ConnectorsLive.pipe(Layer.provideMerge(Layer.mergeAll(connectorBase, Layer.succeed(Engine)({
    ready: new Promise(() => {}), url: 'http://127.0.0.1:1', state: () => ({ status: 'starting' }),
  })))))
  let hr
  try {
    const c = await cr.runPromise(Connectors)
    await cr.runPromise(c.add({ name: 'Fixture', url: 'http://127.0.0.1:1/mcp', oauth: false }))
    const { Hub, HubLive } = await load('src/main/services/Hub.ts')
    hr = ManagedRuntime.make(HubLive.pipe(Layer.provideMerge(Layer.mergeAll(connectorBase, Layer.succeed(Connectors)(c)))))
    const hub = await hr.runPromise(Hub)
    const discover = async () => {
      const response = await fetch(`${hub.url}/mcp/fixture`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-only', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(5000),
      })
      const text = await response.text()
      const result = JSON.parse(text.startsWith('event:') ? text.split('\n').find((l) => l.startsWith('data: ')).slice(6) : text)
      return result.result?.tools ?? []
    }
    for (const tool of ['create_item', 'get_or_create_item', 'unknown_tool']) {
      called = 0
      const error = await throws(() => cr.runPromise(c.call('fixture', tool)))
      check(`${tool}: an ambiguous failure never replays a possible write`, called === 1 && /outcome is unknown/.test(error), `${called}: ${error}`)
      check(`${tool}: losing the client marks the connector disconnected`, c.get('fixture').status === 'disconnected')
      if (tool === 'create_item') {
        // With no discovery request to trigger it, recovery must still happen on its own.
        for (let i = 0; i < 500 && !c.get('fixture').tools.length; i++) await sleep(10)
        check('background recovery restores discovery without replaying the write', c.get('fixture').status === 'connected' && c.get('fixture').tools.length === 3 && called === 1)
      }
      const discovered = await discover()
      check(`${tool}: the hub discovers tools again without replaying the write`, discovered.some((t) => t.name === 'create_item') && c.get('fixture').status === 'connected' && called === 1)
    }
    called = 0
    const before = connected
    action = async () => {
      if (called === 1) throw new Error('fetch failed')
      return { content: [{ type: 'text', text: '{"items":[]}' }] }
    }
    const answer = await cr.runPromise(c.call('fixture', 'list_items'))
    check('a declared read reconnects and retries once', called === 2 && connected > before && answer.items.length === 0)
    called = 0
    action = async () => { throw new Error('fetch failed') }
    await throws(() => cr.runPromise(c.call('fixture', 'list_items')))
    check('a declared read stops after its second failure', called === 2)
    called = 0
    action = async () => ({ content: [{ type: 'text', text: '{"created":true}' }] })
    const written = await cr.runPromise(c.call('fixture', 'create_item'))
    check('a subsequent write can reconnect and run normally', called === 1 && written.created === true)
  } finally {
    if (hr) await hr.dispose()
    await cr.dispose()
    mock.restoreAll()
  }

  console.log('tool retention and schedule edits')
  const { Data, DataLive } = await load('src/main/services/Data.ts')
  const { Tools, ToolsLive } = await load('src/main/services/Tools.ts')
  const pending = []
  const connectors = Layer.succeed(Connectors)({
    registerInternal() {},
    call: () => Effect.promise(() => new Promise((resolve) => pending.push(resolve))),
  })
  const toolBase = base(join(tmp, 'tool-regressions'))
  // Only the schedule clock is advanced; async IO and sandbox deadlines keep real timers.
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2030-06-15T12:00:00Z') })
  const tr = ManagedRuntime.make(ToolsLive.pipe(Layer.provideMerge(Layer.mergeAll(toolBase, DataLive.pipe(Layer.provide(toolBase)), connectors))))
  const until = async (label, f) => {
    for (let i = 0; i < 500; i++) {
      if (f()) return
      await sleep(10)
    }
    throw new Error(`Timed out: ${label}`)
  }
  try {
    const t = await tr.runPromise(Tools)
    const { sql } = await tr.runPromise(Data)
    await tr.runPromise(t.save('alpha', 'export default () => "alpha"'))
    await tr.runPromise(t.save('beta', 'export default () => { throw new Error("beta failed") }'))
    await tr.runPromise(t.save('held', 'export default () => call("fixture", "wait")'))
    // Existing interleaved history: alpha has odd global IDs and beta has even ones. Neither may
    // depend on owning the next global multiple of 50 to enforce its own retention limit.
    const insert = sql.prepare("INSERT INTO runs (tool, by, started_at, ms, ok, args, result, logs, calls) VALUES (?, 'test', ?, 0, 1, '{}', 'null', '[]', '[]')")
    for (let i = 0; i < 600; i++) for (const tool of ['alpha', 'beta']) insert.run(tool, new Date().toISOString())
    await tr.runPromise(t.run('alpha', {}, { by: 'test', depth: 0 }))
    await throws(() => tr.runPromise(t.run('beta', {}, { by: 'test', depth: 0 })))
    for (const tool of ['alpha', 'beta']) {
      const { n } = sql.prepare('SELECT count(*) n FROM runs WHERE tool = ?').get(tool)
      check(`${tool}: interleaved runs retain only the latest 500`, n === 500, String(n))
    }
    check('retention keeps the newest successful and failed results', t.runs({ tool: 'alpha', limit: 1 })[0].result === 'alpha' && t.runs({ tool: 'beta', limit: 1 })[0].error.includes('beta failed'))

    mock.timers.tick(8000)
    const start = async (id) => {
      t.saveSchedule({ id, tool: 'held', cron: '* * * * *' })
      sql.prepare('UPDATE schedules SET next_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id)
      mock.timers.tick(1000)
      await until('the tool reaches its connector', () => pending.length === 1)
      check(`${id}: the schedule is running`, t.schedules().find(s => s.id === id).running)
    }
    const finish = async (id) => {
      pending.shift()(null)
      await until('the schedule finishes', () => !t.schedules().find(s => s.id === id)?.running)
    }
    await start('edited')
    const edited = t.saveSchedule({ id: 'edited', tool: 'held', cron: '0 0 1 1 *' })
    await finish('edited')
    check('an edit during a run keeps its newly saved next time', t.schedules().find(s => s.id === 'edited').nextAt === edited.nextAt)
    t.removeSchedule('edited')

    await start('disabled')
    t.saveSchedule({ id: 'disabled', tool: 'held', cron: '* * * * *', enabled: false })
    const disabled = sql.prepare('SELECT next_at FROM schedules WHERE id = ?').get('disabled').next_at
    mock.timers.tick(60_000)
    await finish('disabled')
    check('disabling a running schedule keeps the saved timing and disabled state', !t.schedules().find(s => s.id === 'disabled').enabled && sql.prepare('SELECT next_at FROM schedules WHERE id = ?').get('disabled').next_at === disabled)
    t.removeSchedule('disabled')

    await start('replaced')
    t.removeSchedule('replaced')
    const replaced = t.saveSchedule({ id: 'replaced', tool: 'alpha', cron: '0 0 1 1 *' })
    await finish('replaced')
    const replacement = t.schedules().find(s => s.id === 'replaced')
    check('an old run cannot overwrite a replacement schedule with the same ID', replacement.tool === 'alpha' && replacement.nextAt === replaced.nextAt && replacement.lastAt === null)
    t.removeSchedule('replaced')

    await start('deleted')
    t.removeSchedule('deleted')
    pending.shift()(null)
    await until('the deleted schedule run is recorded', () => t.runs({ tool: 'held', limit: 200 }).length === 4)
    check('finishing a deleted schedule does not recreate it', !t.schedules().some(s => s.id === 'deleted'))

    await start('unchanged')
    await finish('unchanged')
    const unchanged = t.schedules().find(s => s.id === 'unchanged')
    check('an unchanged schedule advances and records its result', unchanged.nextAt > new Date().toISOString() && unchanged.lastOk === true && unchanged.lastAt !== null)
    check('runs finished after edits remain in the audit history', t.runs({ tool: 'held', limit: 200 }).length === 5)
  } finally {
    for (const resolve of pending) resolve(null)
    await tr.dispose()
    mock.timers.reset()
  }
}

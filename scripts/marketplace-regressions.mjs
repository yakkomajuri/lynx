// Exercise the actual marketplace service without any bundled templates or live network requests.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'node:test'
import { Layer, ManagedRuntime } from 'effect'

export async function marketplaceRegressions({ load, tmp, check, throws }) {
  console.log('remote marketplace installation and offline cache')
  const { ConfigLive } = await load('src/main/services/Config.ts')
  const { EventsLive } = await load('src/main/services/Events.ts')
  const { Workspaces, WorkspacesLive } = await load('src/main/services/Workspaces.ts')
  const { Marketplace, MarketplaceLive } = await load('src/main/services/Marketplace.ts')
  const { Connectors } = await load('src/main/services/Connectors.ts')
  const { Tools } = await load('src/main/services/Tools.ts')
  const { remoteOrigin, templateForOrigin, hasUpdateSource } = await load('src/shared/templates.ts')
  const appRoot = join(tmp, 'install-app')
  const dataDir = join(tmp, 'install-data')
  const workspacesDir = join(dataDir, 'workspaces')
  mkdirSync(join(appRoot, 'resources'), { recursive: true })
  mkdirSync(workspacesDir, { recursive: true })
  writeFileSync(join(appRoot, 'resources', 'KIT.md'), 'Test guide')
  symlinkSync(join(process.cwd(), 'src'), join(appRoot, 'src'))
  symlinkSync(join(process.cwd(), 'node_modules'), join(appRoot, 'node_modules'))
  const api = 'https://marketplace.example'
  const requirement = { alias: 'gh', name: 'GitHub', url: 'https://github.example/mcp' }
  const summaries = ['omitted', 'empty', 'exact'].map((id) => ({
    id, name: id, description: 'Test template', tags: [], creator: 'official', verified: true,
    publisher: { name: 'Lynx', handle: 'lynx' }, version: 1, requires: [requirement], uses: id === 'exact' ? { gh: ['list_prs'] } : {}, preview: { path: '/' },
  }))
  // An old app folder must not inject official templates, even if files are left in it.
  mkdirSync(join(appRoot, 'marketplace', 'bundled-only'), { recursive: true })
  writeFileSync(join(appRoot, 'marketplace', 'bundled-only', 'manifest.json'), JSON.stringify({ name: 'Must not load', uses: {} }))
  mkdirSync(join(dataDir, 'marketplace', 'private'), { recursive: true })
  writeFileSync(join(dataDir, 'marketplace', 'private', 'manifest.json'), JSON.stringify({ name: 'My private template', uses: {} }))
  writeFileSync(join(dataDir, 'marketplace', 'private', 'App.js'), 'export default () => null')

  let offline = false, downloads = 0
  const fetchMock = mock.method(globalThis, 'fetch', async (url) => {
    if (offline) throw new Error('offline')
    const path = new URL(url).pathname
    if (path === '/v1/templates') return Response.json({ templates: summaries })
    if (path.endsWith('/installs')) return Response.json({ ok: true })
    const id = path.split('/')[3]
    const item = summaries.find((t) => t.id === id)
    if (!item || !path.endsWith('/bundle')) return Response.json({ error: 'not found' }, { status: 404 })
    downloads++
    return Response.json({ id, version: 1, files: [
      { path: 'manifest.json', text: JSON.stringify({ ...item, uses: id === 'omitted' ? undefined : item.uses }) },
      { path: 'App.jsx', text: 'export default () => <div>Remote preview</div>' },
      { path: 'preview/mock.js', text: 'export default () => ({})' },
    ] })
  })
  const oldUrl = process.env.LYNX_MARKETPLACE_URL
  process.env.LYNX_MARKETPLACE_URL = api
  const base = Layer.mergeAll(
    ConfigLive({ appRoot, dataDir, workspacesDir, outDir: join(process.cwd(), 'out/main') }), EventsLive,
    Layer.succeed(Connectors)({ findByUrl: () => [{ id: 'my-github' }], get: () => ({ id: 'my-github' }) }),
    Layer.succeed(Tools)({ list: () => [], schedules: () => [] }),
  )
  const runtime = () => ManagedRuntime.make(MarketplaceLive.pipe(Layer.provideMerge(WorkspacesLive.pipe(Layer.provideMerge(base)))))
  let rt = runtime()
  try {
    let market = await rt.runPromise(Marketplace)
    await rt.runPromise(market.refresh())
    check('official templates come only from the remote catalog', market.list().filter((i) => i.creator === 'official').length === 3 && market.list().every((i) => i.source === 'remote' || i.source === 'local') && !market.list().some((i) => i.id === 'bundled-only'))
    check('listing does not download template code', downloads === 0)
    check('the private local shelf is still available', market.list().some((i) => i.id === 'private' && i.creator === 'you' && i.source === 'local'))
    const ws = await rt.runPromise(Workspaces)
    for (const id of ['omitted', 'empty', 'exact']) {
      const installed = await rt.runPromise(market.fork({ item: id, source: 'remote' }))
      const saved = JSON.parse(readFileSync(join(installed.dir, 'workspace.json'), 'utf8'))
      const expected = id === 'exact' ? { gh: ['list_prs'] } : {}
      check(`${id}: remote install keeps only declared tools and records its server`, installed.connectors.gh === 'my-github' && JSON.stringify(saved.uses) === JSON.stringify(expected) && installed.origin === remoteOrigin(api, id))
      await rt.runPromise(ws.update(installed.id, { uses: { gh: '*' } }))
      const restored = await rt.runPromise(market.restore(installed.id))
      check(`${id}: restoring removes permissions added after installation`, JSON.stringify(restored.uses) === JSON.stringify(expected))
    }
    const legacy = await rt.runPromise(ws.create({ name: 'Legacy builtin fork', origin: 'exact', files: { 'App.jsx': 'export default () => null' }, uses: {} }))
    await rt.runPromise(market.restore(legacy.id))
    check('old bundled-template workspaces restore from their official remote replacement', readFileSync(join(legacy.dir, 'App.jsx'), 'utf8').includes('Remote preview'))
    const community = [{ id: 'exact', source: 'remote', creator: 'community' }]
    check('a legacy origin never falls back to a community look-alike', !templateForOrigin('exact', api, community) && !hasUpdateSource('exact', api, community))
    check('server-qualified origins never switch marketplaces', !templateForOrigin(remoteOrigin('https://other.example', 'exact'), api, market.list()))
    const local = { id: 'exact', source: 'local', creator: 'you' }
    check('private templates keep precedence for unqualified origins', templateForOrigin('exact', api, [...market.list(), local]) === local)
    const before = downloads
    const files = await rt.runPromise(market.files('remote', 'exact'))
    check('file inspection reuses downloaded code', files.files.some((f) => f.path === 'App.jsx') && downloads === before)
    await rt.dispose()
    offline = true
    rt = runtime()
    market = await rt.runPromise(Marketplace)
    await rt.runPromise(market.refresh())
    check('an offline restart retains the cached remote catalog', market.remote().status === 'error' && market.list().filter((i) => i.source === 'remote').length === 3)
    const cached = await rt.runPromise(market.fork({ item: 'exact', source: 'remote', name: 'Offline fork' }))
    check('previously downloaded remote templates can be forked offline', cached.origin === remoteOrigin(api, 'exact') && downloads === before)
    const preview = await rt.runPromise(market.preview('remote', 'exact'))
    check('cached remote previews build offline', preview.js.includes('Remote preview'))
    check('missing remote items report an error', /No marketplace item/.test(await throws(() => rt.runPromise(market.fork({ item: 'bundled-only' })))))
  } finally {
    await rt.dispose()
    fetchMock.mock.restore()
    if (oldUrl === undefined) delete process.env.LYNX_MARKETPLACE_URL
    else process.env.LYNX_MARKETPLACE_URL = oldUrl
  }
}

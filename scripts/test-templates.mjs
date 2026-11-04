// Checks for the separately maintained official templates. Run from the Lynx checkout:
//   LYNX_TEMPLATES_DIR=/path/to/lynx-official-marketplace-templates node scripts/test-templates.mjs
import { build, stop as stopEsbuild } from 'esbuild'
import { existsSync as exists, mkdirSync, mkdtempSync, readdirSync as readdir, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { templatesDir } from './templates-dir.mjs'
import { pathToFileURL } from 'node:url'

// Template code is read from an independent checkout; it is never bundled with the app.
const templateIds = () => readdir(templatesDir).filter((id) => exists(join(templatesDir, id, 'manifest.json')))

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

// ── marketplace: every official item can be forked as it stands
{
  console.log('marketplace')
  const { readdirSync, readFileSync, existsSync } = await import('node:fs')
  const { parseCron } = await load('src/shared/cron.ts')
  const { inspect } = await load('src/main/sandbox.ts')
  // Words that would mean someone's own data was left in an item: your names, domains and the like, as
  // a regular expression in LYNX_PRIVATE_WORDS (e.g. 'acme|jane'), so the list itself is not published.
  const PRIVATE = process.env.LYNX_PRIVATE_WORDS ? new RegExp(process.env.LYNX_PRIVATE_WORDS, 'i') : null
  // A home folder on a Mac; "/users/:id" routes are fine.
  const HOME = /\/Users\/[a-z]/
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
  for (const id of templateIds()) {
    const dir = join(templatesDir, id)
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    check(`${id}: has a name, a description and App.jsx`, !!m.name && !!m.description && existsSync(join(dir, 'App.jsx')))
    check(`${id}: has one to five tags, as the marketplace stores them`, Array.isArray(m.tags) && m.tags.length >= 1 && m.tags.length <= 5 && m.tags.every((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)), JSON.stringify(m.tags))
    check(`${id}: every connector it needs has an alias, a name and a URL or a hint`, (m.requires ?? []).every((r) => r.alias && r.name && (r.url || r.optional || r.hint)), JSON.stringify(m.requires))
    for (const t of m.tools ?? []) {
      const path = join(dir, 'tools', `${t}.js`)
      check(`${id}: tool ${t} is shipped and loads`, existsSync(path) && !(await throws(() => inspect(t, readFileSync(path, 'utf8')))), existsSync(path) ? await throws(() => inspect(t, readFileSync(path, 'utf8'))) : 'missing')
    }
    for (const s of m.schedules ?? []) check(`${id}: schedule ${s.id} runs a shipped tool on a valid cron`, (m.tools ?? []).includes(s.tool) && !(await throws(() => parseCron(s.cron))), JSON.stringify(s))
    const leaks = walk(dir).filter((f) => !f.includes(`${join(dir, 'vendor')}/`) && (PRIVATE?.test(readFileSync(f, 'utf8')) || HOME.test(readFileSync(f, 'utf8'))))
    check(`${id}: nothing private left in the code`, !leaks.length, leaks.join(', '))
  }
}


{
  const { checkRequires, checkUses, checkTools } = await load('src/shared/marketplaceApi.ts')
  for (const id of templateIds()) {
    const m = JSON.parse((await import('node:fs')).readFileSync(join(templatesDir, id, 'manifest.json'), 'utf8'))
    const why = checkRequires(m.requires ?? []) ?? checkUses(m.uses) ?? checkTools(m.tools, m.schedules)
    check(`${id}: its manifest is one the marketplace accepts`, why === null, why)
  }
}

// ── look-alikes: the logic behind templates' reads, with the `lynx` module stood in for
{
  console.log('look-alikes')
  // `call` answers from globalThis.__lynxCall, so each check decides what the connector says.
  const stub = join(tmp, 'lynx-stub.mjs')
  writeFileSync(stub, `export const call = (...a) => globalThis.__lynxCall(...a)\nexport const useTool = () => ({})\nexport const workspace = () => ({ connectors: {} })\nexport const Markdown = () => null\n`)
  const item = async (file) => {
    const out = join(tmp, file.replace(/\W/g, '_') + '.mjs')
    await build({ entryPoints: [file], outfile: out, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.js': 'jsx' }, alias: { lynx: stub }, external: ['react', 'react/*', 'lucide-react', 'recharts'], logLevel: 'silent' })
    return import(pathToFileURL(out).href)
  }

  // Cloudflare reports upstream auth failures inside a successful MCP response. A 403 alone
  // must not cause retries or be treated as an invalid credential.
  const cfRead = await item(join(templatesDir, 'cloudflare-workers/read.js'))
  const invalid = new Error('Error: Cloudflare API error: GET /accounts returned HTTP 403: 9109: Invalid access token. The API spec lists no permissions for this endpoint. HTTP 403 means the credential was accepted but is not allowed to do this')
  check('cloudflare: recognizes a refresh already in progress', cfRead.authFailure(new Error('Token refresh is already in progress; retry shortly')) === 'refresh')
  check('cloudflare: 9109 takes precedence over misleading permission guidance', cfRead.authFailure(invalid) === 'token' && !cfRead.readError(invalid).message.includes('credential was accepted') && cfRead.readError(invalid).message.includes('reconnect Cloudflare'))
  for (const text of ['HTTP 403: insufficient permissions', 'HTTP 401: unauthorized', 'fetch failed', 'Cloudflare API error: GET /accounts returned HTTP 403: 10000: Authentication error']) {
    const error = new Error(text)
    check(`cloudflare: does not replay unrelated error ${text}`, cfRead.authFailure(error) === null && cfRead.readError(error) === error)
  }

  // Table editor: what the SQL editor lets through, and the filters it builds.
  const te = await item(join(templatesDir, 'supabase-table-editor/api.js'))
  const runs = (sql) => te.readOnlyCheck(sql)
  for (const sql of ['WITH removed AS (DELETE FROM public.projects RETURNING *) SELECT * FROM removed', 'EXPLAIN ANALYZE DELETE FROM public.projects', 'explain (analyze) select 1', 'select * into backup from projects', 'select 1; drop table projects', 'update projects set name = 1', "select 'unclosed", 'select /* open comment', 'select * from projects for update'])
    check(`table editor: refuses ${sql}`, !runs(sql).ok, JSON.stringify(runs(sql)))
  for (const [sql, sent] of [
    ["SELECT '/*literal*/' AS value", "SELECT '/*literal*/' AS value"],
    ["select 'https://x.example/a--b' as url;", "select 'https://x.example/a--b' as url"],
    ["select 1 as n; -- done", 'select 1 as n'],
    ["select \"delete\", 'it''s; fine' from t /* update */", "select \"delete\", 'it''s; fine' from t /* update */"],
    ['select $$drop table x; -- not code$$ as s', 'select $$drop table x; -- not code$$ as s'],
    ['/* a */ (select 1)', '/* a */ (select 1)'],
  ])
    check(`table editor: runs ${sql} exactly as written`, runs(sql).ok && runs(sql).sql === sent, JSON.stringify(runs(sql)))
  const types = { amount_cents: 'integer', name: 'text', due_date: 'date', settings: 'jsonb', meta: 'json' }
  const where = (f) => te.whereOf([f], types).where
  check('table editor: a number column compares as a number', where({ col: 'amount_cents', op: 'gt', value: '100' }) === ' WHERE "amount_cents" > $1', where({ col: 'amount_cents', op: 'gt', value: '100' }))
  check('table editor: dates and text keep their type too', where({ col: 'due_date', op: 'lte', value: '2026-10-01' }) === ' WHERE "due_date" <= $1' && where({ col: 'name', op: 'eq', value: 'x' }) === ' WHERE "name" = $1')
  check('table editor: LIKE, json and unknown columns compare as text', where({ col: 'amount_cents', op: 'like', value: '1%' }).includes('"amount_cents"::text LIKE') && where({ col: 'meta', op: 'eq', value: '{}' }).includes('::text') && where({ col: 'other', op: 'eq', value: 'x' }).includes('::text'))
  check('table editor: values are parameters, never SQL', te.whereOf([{ col: 'name', op: 'eq', value: "'; drop table x; --" }], types).params[0] === "'; drop table x; --")

  // Mercury: a busy window is read whole, page by page, or not at all.
  const merc = await item(join(templatesDir, 'mercury-home/mercury.js'))
  const txns = Array.from({ length: 250 }, (_, i) => ({ id: `t${i}`, amount: -1, date: '2026-10-01' }))
  const pager = ({ tooLongAbove = Infinity } = {}) => {
    const calls = []
    return {
      calls,
      read: async (a) => {
        calls.push(a)
        if (a.limit > tooLongAbove) return 'Result too long: try a smaller limit'
        const from = a.start_after ? txns.findIndex((t) => t.id === a.start_after) + 1 : 0
        return { result: { transactions: txns.slice(from, from + a.limit), totalFetched: 0, truncatedAt: null } }
      },
    }
  }
  const all = pager()
  const got = await merc.listAccount('acc', '2026-10-01', '2026-10-01', {}, all.read)
  check('mercury: one day with more rows than a page is read page after page', got.length === 250 && new Set(got.map((t) => t.id)).size === 250 && got.every((t) => t.accountId === 'acc'), `${got.length} rows in ${all.calls.length} calls`)
  const smaller = pager({ tooLongAbove: 30 })
  const got2 = await merc.listAccount('acc', '2026-10-01', '2026-10-01', {}, smaller.read)
  check('mercury: "Result too long" is read again in smaller pages, nothing dropped', got2.length === 250, `${got2.length} rows`)
  const never = pager({ tooLongAbove: 0 })
  check('mercury: a day that cannot be read whole is an error, not an empty day', /incomplete/.test(await throws(() => merc.listAccount('acc', '2026-10-01', '2026-10-01', {}, never.read))))

  // Mercury: the chart rebuilds the balance of the same accounts whose activity it undoes.
  const day = 86400e3
  const now = new Date('2026-10-22T12:00:00').getTime()
  const accts = [{ id: 'chk', deposit: true, balance: 1000 }, { id: 'sav', deposit: true, balance: 500 }, { id: 'tre', treasury: true, balance: 5000 }]
  const at = (n) => new Date(now - n * day).toISOString()
  const hist = merc.balanceHistory(accts, [
    { accountId: 'chk', amount: -100, date: at(0), status: 'sent', kind: 'treasuryTransfer' },
    { accountId: 'chk', amount: -50, date: at(1), status: 'sent', kind: 'internalTransfer' },
    { accountId: 'sav', amount: 50, date: at(1), status: 'sent', kind: 'internalTransfer' },
    { accountId: 'chk', amount: 999, date: at(1), status: 'pending' },
  ], 3, now)
  check('mercury: the chart is checking and savings, without treasury', hist.at(-1).value === 1500, JSON.stringify(hist))
  check('mercury: a move to treasury today shows as money that was in checking yesterday', hist.at(-2).value === 1600, JSON.stringify(hist))
  check('mercury: a move between checking and savings, or a pending row, changes nothing', hist.at(-3).value === 1600 && hist.length === 4, JSON.stringify(hist))

  // Linear inbox: a snooze made here lasts until it ends; the server's word replaces local changes.
  const inbox = await item(join(templatesDir, 'linear-inbox/data.js'))
  const l = { read: { a: { read: true, at: now - 60e3 } }, snoozed: { b: new Date(now + 3600e3).toISOString() } }
  const rows = [{ id: 'a', unread: true }, { id: 'b', unread: true }]
  check('linear inbox: a snoozed notification is hidden until its snooze ends', inbox.withLocal(rows, l, now).map((n) => n.id).join() === 'a' && inbox.withLocal(rows, l, now + 2 * 3600e3).map((n) => n.id).join() === 'a,b')
  inbox.reconcile([{ id: 'a', readAt: at(0) }, { id: 'b', readAt: null, snoozedUntilAt: null }], l, now + 2 * 3600e3)
  check('linear inbox: once the server agrees, or the snooze is over, the local change is dropped', !('a' in l.read) && !('b' in l.snoozed), JSON.stringify(l))
  // Read here in the Unread view, left out of the next unread-only answer, then marked unread in Linear.
  const seq = { read: { c: { read: true, at: now } }, snoozed: {} }
  inbox.reconcile([{ id: 'd', readAt: null }], seq, now + 1000, { unreadOnly: true })
  check('linear inbox: an unread-only answer without a notification read here settles that change', !('c' in seq.read), JSON.stringify(seq))
  const back = inbox.withLocal([{ id: 'c', unread: true }], seq, now + 120e3)
  check('linear inbox: marked unread in Linear afterwards, it comes back unread', back[0].unread === true, JSON.stringify(back))
  const kept = { read: { e: { read: true, at: now } }, snoozed: {} }
  inbox.reconcile([], kept, now, { unreadOnly: false })
  check('linear inbox: an answer that is not unread-only says nothing about rows it leaves out', 'e' in kept.read)
  const later = { read: { f: { read: true, at: now } }, snoozed: {} }
  inbox.reconcile([{ id: 'f', readAt: null, updatedAt: new Date(now + 60e3).toISOString() }], later, now + 60e3)
  check('linear inbox: a notification changed on the server after the change made here follows the server', !('f' in later.read))
  check('linear inbox: reconciling says whether it dropped anything, so the screen is drawn again only then', inbox.reconcile([{ id: 'g', readAt: null }], { read: { g: { read: false, at: now } }, snoozed: {} }, now) === true && inbox.reconcile([{ id: 'g', readAt: null }], { read: {}, snoozed: {} }, now) === false)

  // PostHog SQL editor: a cell with a line break or "|" stays one cell of one row.
  const ph = await item(join(templatesDir, 'posthog-sql-editor/api.js'))
  check('posthog sql: JSON rows keep line breaks and pipes inside their cell', JSON.stringify(ph.parseJsonRows({ results: 'row\n["first line\\nsecond line"]\n["a|b"]\n[null]' })) === JSON.stringify([['first line\nsecond line'], ['a|b'], [null]]))
  const answers = (rowsText, head) => async (_c, _t, a) => {
    const q = JSON.parse(a.command.replace(/^call --json execute-sql /, '')).query
    if (q.startsWith('SELECT toJSONString(tuple(*))')) return rowsText instanceof Error ? Promise.reject(rowsText) : { result: { results: rowsText } }
    if (q.endsWith(') LIMIT 0')) return { result: { results: head } }
    return { result: { results: `${head}\nfirst line\nsecond line` } }
  }
  globalThis.__lynxCall = answers('row\n["first line\\nsecond line"]', 'message')
  const one = await ph.runQuery('SELECT message FROM logs')
  check('posthog sql: a one-column result with a line break is one row, under its name', one.rows.length === 1 && one.rows[0][0] === 'first line\nsecond line' && one.columns.join() === 'message' && !one.note, JSON.stringify(one))
  const warned = '<taxonomy_warnings>\nEvent "signup" was not seen in the last 30 days.\n</taxonomy_warnings>\n'
  globalThis.__lynxCall = answers(`${warned}row\n["a",1]\n["b",2]`, `${warned}name|n`)
  const withWarnings = await ph.runQuery('SELECT name, n FROM t')
  check('posthog sql: taxonomy warnings before the answer are not taken for rows or column names', withWarnings.columns.join() === 'name,n' && withWarnings.rows.length === 2 && withWarnings.rows[1][1] === '2' && !withWarnings.note, JSON.stringify(withWarnings))
  check('posthog sql: warning text inside a row is data', ph.parseJsonRows({ results: 'row\n["<taxonomy_warnings>x</taxonomy_warnings>"]' })[0][0] === '<taxonomy_warnings>x</taxonomy_warnings>')
  globalThis.__lynxCall = answers(new Error('cannot wrap'), 'message')
  const plain = await ph.runQuery('SELECT message FROM logs SETTINGS x=1')
  check('posthog sql: a statement that cannot be wrapped runs as written, and says it may be split', !!plain.note && plain.columns.join() === 'message', JSON.stringify(plain))

  // GitHub pull requests: a "Viewed" tick belongs to the version of the file it was given to.
  const ghp = await item(join(templatesDir, 'github-pulls/data.js'))
  const file = { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d' }
  const rev = ghp.fileRevision(file, 'head1')
  check('github pulls: the same file at a new head keeps its tick', ghp.fileRevision({ ...file }, 'head2') === rev)
  check('github pulls: a file a new commit changed loses its tick', ghp.fileRevision({ ...file, patch: file.patch + '\n+e', additions: 3, changes: 4 }, 'head2') !== rev && ghp.fileRevision({ ...file, patch: file.patch.replace('+d', '+x') }, 'head1') !== rev)
  const binary = { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0, changes: 0 }
  check('github pulls: a file without a patch loses its tick on any new commit', ghp.fileRevision(binary, 'head1') !== ghp.fileRevision(binary, 'head2'))

  // GitHub issues: what a search word matches.
  const ghi = await item(join(templatesDir, 'github-issues/data.js'))
  const issue = { title: 'Checkout total is wrong &amp; slow', user: { login: 'priya-r' }, labels: [{ name: 'bug' }, 'p1'] }
  check('github issues: search words match the title, author and labels, all of them', ghi.matches(issue, ['checkout', '&']) && ghi.matches(issue, ['priya', 'bug']) && ghi.matches(issue, ['p1']) && !ghi.matches(issue, ['checkout', 'android']))
  delete globalThis.__lynxCall
}

// The refreshed coding template must not turn old remote tasks into local execution.
{
  const { default: coding } = await load(join(templatesDir, 'local-coding/tools/local_coding.js'))
  check('coding template refuses a remote task before touching storage', /only supports local/.test(await throws(() => coding({ action: 'create', task: { location: 'cloud', prompt: 'x', model: { harness: 'fake' } } }))))
  check('coding template refuses a remote project too', /only supports local/.test(await throws(() => coding({ action: 'create', task: { project: { location: 'cloud' }, prompt: 'x', model: { harness: 'fake' } } }))))
  const prior = { db: globalThis.db, call: globalThis.call }
  let invoked = 0
  globalThis.db = {
    query: async (collection) => ({ items: collection === 'local-coding/tasks' ? [{ value: { id: 'old-remote', location: 'cloud', status: 'working' } }] : [] }),
    get: async () => ({ at: Date.now() }), put: async () => ({ created: true }), delete: async () => {},
  }
  globalThis.call = async () => { invoked++; throw new Error('Unexpected connector call') }
  try {
    const result = await coding({ action: 'tick' })
    check('scheduled ticks leave pre-existing remote tasks untouched', !invoked && result.advanced.length === 0)
  } finally { Object.assign(globalThis, prior) }
}

// ── template manifests: an official template's "uses" names exactly the tools its UI calls, never "*".
// A static read of the UI code (not preview/ mocks, not tools/ run by the sandbox, not vendor/):
// literal call()/useTool() on a literal or constant connector, one-argument wrappers around them
// (useLinear('get_issue', …)), and the kit helpers below. Dynamic calls go unseen.
{
  console.log('template manifests')
  const { readdirSync, readFileSync } = await import('node:fs')
  // What the kit calls for a template when it uses one of these (src/kit). connector_list and connector_icon are always allowed.
  const transcript = ['agents.event_payload', 'agents.session_send', 'agents.input_respond', 'agents.session_get', 'agents.session_connections_set', 'app.connector_update', 'app.connector_reconnect']
  const KIT = [
    [/\bagents\.start\(/, 'agents', ['agents.session_start']],
    [/\bagents\.send\(/, 'agents', ['agents.session_send']],
    [/\bagents\.(info|providerSession)\(/, 'agents', ['agents.session_get']],
    [/\bagents\.setConnectors\(/, 'agents', ['agents.session_connections_set']],
    [/\bagents\.grant\(/, 'agents', ['agents.session_get', 'agents.session_connections_set']],
    [/\bagents\.cancel\(/, 'agents', ['agents.run_cancel']],
    [/\bagents\.archive\(/, 'agents', ['agents.session_archive']],
    [/\bagents\.respond\(/, 'agents', ['agents.input_respond']],
    [/\bagents\.requestAll\(/, 'agents', ['app.request_access']],
    [/\bagents\.list\(/, 'agents', ['agents.session_list']],
    [/\buseSessions\(/, 'useSessions', ['agents.session_list']],
    [/\buseSession\(/, 'useSession', ['agents.session_history']],
    [/\buseSessionInfo\(/, 'useSessionInfo', ['agents.session_get']],
    [/\buseProviders\(/, 'useProviders', ['agents.server_status']],
    [/\bfullPayload\(/, 'fullPayload', ['agents.event_payload']],
    [/\buseStored\(/, 'useStored', ['app.db_get', 'app.db_put']],
    [/\buseNotifications\(/, 'useNotifications', ['app.notification_list']],
    [/\bnotifyUser\(/, 'notifyUser', ['app.notification_send']],
    [/<Transcript\b/, 'Transcript', transcript],
    [/<ConnectCard\b/, 'ConnectCard', ['app.connector_update', 'app.connector_reconnect']],
  ]
  const ALWAYS = new Set(['app.connector_list', 'app.connector_icon'])
  const SKIP = new Set(['preview', 'tools', 'vendor'])
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (SKIP.has(e.name) ? [] : walk(join(dir, e.name))) : /\.(jsx?|tsx?|mjs)$/.test(e.name) ? [join(dir, e.name)] : []))
  const lit = String.raw`(?:'([\w-]+)'|"([\w-]+)")`
  for (const id of templateIds()) {
    const dir = join(templatesDir, id)
    const uses = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).uses ?? {}
    const stars = Object.keys(uses).filter((k) => uses[k] === '*')
    check(`${id}: no connector in "uses" is "*"`, !stars.length, stars.join(', '))
    const sources = walk(dir).map((f) => [f, readFileSync(f, 'utf8')])
    const all = sources.map(([, s]) => s).join('\n')
    const imported = new Set([...all.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lynx['"]/g)].flatMap((m) => m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)))
    // Connector names held in constants: const S = 'stripe'.
    const consts = Object.fromEntries([...all.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:'([\w-]+)'|"([\w-]+)")/g)].map((m) => [m[1], m[2] ?? m[3]]))
    const connectorOf = (m) => m[1] ?? m[2] ?? consts[m[3]]
    const found = new Map() // "connector.tool" -> where
    const note = (key, where) => !ALWAYS.has(key) && !found.has(key) && found.set(key, where)
    for (const [f, s] of sources) {
      const direct = new RegExp(String.raw`(?<![\w.$])(?:call|useTool)\s*(?:<[^>]*>)?\(\s*(?:${lit}|([A-Z][A-Z0-9_]*))\s*,\s*${lit}`, 'g')
      if (imported.has('call') || imported.has('useTool')) for (const m of s.matchAll(direct)) if (connectorOf(m)) note(`${connectorOf(m)}.${m[4] ?? m[5]}`, f)
      // useLinear(tool, args) { … useTool('linear', tool, … }: each literal tool it is called with.
      const passed = new RegExp(String.raw`(?<![\w.$])(?:call|useTool)\s*(?:<[^>]*>)?\(\s*(?:${lit}|([A-Z][A-Z0-9_]*))\s*,\s*([a-z]\w*)\s*[,)]`, 'g')
      for (const m of s.matchAll(passed)) {
        const heads = [...s.slice(0, m.index).matchAll(/(?:function\s+(\w+)\s*\(\s*(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(\s*(\w+))/g)].at(-1)
        const [name, param] = heads ? [heads[1] ?? heads[3], heads[2] ?? heads[4]] : []
        if (!connectorOf(m) || param !== m[4]) continue
        for (const [g, t] of sources) for (const w of t.matchAll(new RegExp(String.raw`(?<![\w.$])${name}\(\s*${lit}`, 'g'))) note(`${connectorOf(m)}.${w[1] ?? w[2]}`, g)
      }
      for (const [re, name, keys] of KIT) if (imported.has(name) && re.test(s)) keys.forEach((k) => note(k, f))
    }
    const missing = [...found].filter(([key]) => {
      const [c, t] = key.split('.')
      return !Array.isArray(uses[c]) || !uses[c].includes(t)
    })
    check(`${id}: "uses" lists every tool its UI calls (${found.size} seen)`, !missing.length, missing.map(([k, f]) => `${k} (${f})`).join(', '))
  }
}


rmSync(tmp, { recursive: true, force: true })
await stopEsbuild()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)

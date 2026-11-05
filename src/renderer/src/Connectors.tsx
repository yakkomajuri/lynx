// Connectors: every MCP server the app can reach. Adding one is a URL (or a command) and, when
// the server asks, a sign-in in the browser or a token. An HTTP API with no MCP server is added by
// its base URL and how it takes its key, and becomes a connector with one tool, request.
//
// The page is a grid of tiles: the service's icon, its name, and one line under it. The line is what
// it is (host and tool count) while it works and what is wrong when it doesn't, so a broken connector
// is the thing that stands out. Tiles carry no buttons; opening one shows its tools and actions.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, CircleX, Globe, Loader2, Plug, Plus, Search, SquareTerminal, Trash2, Wrench } from 'lucide-react'
import type { ApiAuthType, AppState, ConnectorState } from '@shared/types'
import { app, bridge } from './api'
import { glyphOf } from './pointMentions'
import type { Toast } from './App'

export interface ConnectorPreset {
  name?: string
  url?: string
  reason?: string
  /** Edit the credentials of this existing connector instead of adding one. */
  connector?: string
  /** Skip the question of what to add: an MCP server, or an HTTP API. */
  mcp?: boolean
  api?: boolean
}
type ToastFn = (text: string, tone?: Toast['tone']) => void

const KNOWN = [
  { name: 'PostHog', url: 'https://mcp.posthog.com/mcp' },
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' },
  { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { name: 'Exa', url: 'https://mcp.exa.ai/mcp' },
  { name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp' },
  { name: 'Context7', url: 'https://mcp.context7.com/mcp' },
]

type Tone = 'ok' | 'busy' | 'warn' | 'bad'
const STATUS: Record<string, { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'ok' },
  connecting: { label: 'Connecting', tone: 'busy' },
  'auth-required': { label: 'Waiting for sign-in in your browser', tone: 'warn' },
  'needs-credentials': { label: 'Needs a token', tone: 'warn' },
  error: { label: 'Could not connect', tone: 'bad' },
  disconnected: { label: 'Disconnected', tone: 'warn' },
}
export const statusOf = (c: ConnectorState) => STATUS[c.status] ?? STATUS.disconnected!

/** `npx -y @scope/server --flag "two words"` -> command + args */
const splitCommand = (line: string) => (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^(["'])(.*)\1$/, '$2'))

const host = (url?: string) => {
  try {
    return new URL(url ?? '').host
  } catch {
    return url ?? ''
  }
}
const sameServer = (a?: string, b?: string) => !!a && !!b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
const displayName = (c: ConnectorState) => (c.native ? c.name : c.id)
/** Where it lives, in a few words: the host, the command, or that it comes with the app. */
const where = (c: ConnectorState) =>
  c.native ? (c.id === 'app' ? 'This app' : c.id === 'agents' ? 'Agents on this machine' : 'Built in') : c.url ? host(c.url) : [c.command?.split('/').pop(), ...(c.args ?? [])].join(' ')
const toolCount = (n: number) => `${n} tool${n === 1 ? '' : 's'}`

// Icons are fetched once per key and shared by every tile that shows them. The main process also
// keeps them on disk, so after the first load they come back without a network request.
const icons = new Map<string, Promise<string | null>>()
function useIcon(key: string | null, load: () => Promise<string | null>) {
  const [icon, setIcon] = useState<string | null>(null)
  useEffect(() => {
    if (!key) return setIcon(null)
    let live = true
    if (!icons.has(key)) icons.set(key, load().catch(() => null))
    void icons.get(key)!.then((i) => live && setIcon(i))
    return () => {
      live = false
    }
  }, [key])
  return icon
}

/**
 * What a favicon's mark is, so a theme can flip it when it would vanish: 'dark' for a colourless dark
 * mark on transparency (GitHub's black cat), 'light' for a colourless light one, null for anything
 * that stands on its own (a full square, a colourful mark, an SVG that restyles itself for dark mode).
 */
type Mark = 'dark' | 'light' | null
const marks = new Map<string, Promise<Mark>>()
function markOf(src: string): Promise<Mark> {
  if (!marks.has(src)) marks.set(src, measure(src))
  return marks.get(src)!
}
async function measure(src: string): Promise<Mark> {
  if (src.startsWith('data:image/svg+xml')) {
    try {
      if (/prefers-color-scheme/.test(atob(src.slice(src.indexOf(',') + 1)))) return null
    } catch {
      /* not base64: measure it like any image */
    }
  }
  const img = new Image()
  img.src = src
  try {
    await img.decode()
  } catch {
    return null
  }
  const n = 32
  const ctx = Object.assign(document.createElement('canvas'), { width: n, height: n }).getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, n, n)
  const px = ctx.getImageData(0, 0, n, n).data
  let clear = 0, solid = 0, lum = 0, colourful = 0
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b, a] = [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!]
    if (a < 26) clear++
    if (a < 128) continue
    solid++
    lum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    if ((Math.max(r, g, b) - Math.min(r, g, b)) / 255 > 0.25) colourful++
  }
  // A mostly opaque icon brings its own background; a colourful one reads on any tile.
  if (clear < n * n * 0.15 || !solid || colourful / solid > 0.2) return null
  const mean = lum / solid
  return mean < 0.35 ? 'dark' : mean > 0.7 ? 'light' : null
}
function useMark(icon: string | null) {
  const [mark, setMark] = useState<Mark>(null)
  useEffect(() => {
    if (!icon) return setMark(null)
    let live = true
    void markOf(icon).then((m) => live && setMark(m))
    return () => {
      live = false
    }
  }, [icon])
  return mark
}

const iconKey = (c: ConnectorState) => `c:${c.id}:${c.url}`
const loadIcon = (c: ConnectorState) => app<{ icon: string | null }>('connector_icon', { connector: c.id }).then((r) => r.icon)
/** An added connector's site icon, from the same cache as its tiles; null when it has none. */
export function connectorIcon(c: ConnectorState): Promise<string | null> {
  if (!c.url) return Promise.resolve(null)
  const key = iconKey(c)
  if (!icons.has(key)) icons.set(key, loadIcon(c).catch(() => null))
  return icons.get(key)!
}

/**
 * A connector's or a suggestion's icon: the site's favicon on a white chip, or a glyph for what has no
 * site. `builtIn` is the app's own connectors as a group; `dim` greys it out (not connected yet).
 */
export function Logo({ connector, url, size = 32, builtIn = false, dim = false }: { connector?: ConnectorState; url?: string; size?: number; builtIn?: boolean; dim?: boolean }) {
  const remote = connector ? !connector.native && !!connector.url : !!url
  const key = remote ? (connector ? iconKey(connector) : `u:${url}`) : null
  const icon = useIcon(key, () => (connector ? loadIcon(connector) : bridge.siteIcon(url!)))
  const mark = useMark(icon)
  const Glyph = connector?.native ? (connector.id === 'agents' ? Bot : connector.id === 'tools' ? Wrench : null) : connector ? glyphOf(connector) : Plug
  return (
    <span className={`h-cx-logo${icon ? ' site' : ''}${mark ? ` mark-${mark}` : ''}${dim ? ' dim' : ''}`} style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size / 4)) }} aria-hidden="true">
      {icon ? <img src={icon} alt="" /> : builtIn || connector?.id === 'app' ? <LynxMark /> : Glyph && <Glyph size={Math.max(11, Math.round(size * 0.62))} />}
    </span>
  )
}

/** The app's own mark (resources/icon.svg without the plate), for the built-in `app` connector. */
const LynxMark = () => (
  <svg viewBox="0 0 100 100" className="own">
    <path fill="currentColor" fillRule="evenodd" d="M50 88 L30 76 L16 58 L22 34 L24 16 L40 34 L60 34 L76 16 L78 34 L84 58 L70 76 Z M31 50 Q38 44 45 52 Q37 56 31 50 Z M69 50 Q62 44 55 52 Q63 56 69 50 Z M45 62 L55 62 L50 68 Z" />
  </svg>
)

/** A state that isn't "working" as a line with an icon, in the same spot the host line goes. */
function StatusLine({ c }: { c: ConnectorState }) {
  const s = statusOf(c)
  const Icon = s.tone === 'bad' ? CircleX : s.tone === 'busy' ? Loader2 : CircleAlert
  return (
    <span className={`h-cx-status ${s.tone}`} title={c.error}>
      <Icon size={13} className={s.tone === 'busy' ? 'spin' : undefined} />
      <span>{s.tone === 'busy' ? `${s.label}…` : s.label}</span>
    </span>
  )
}

export function ConnectorsView({ state, onAdd, toast }: { state: AppState; onAdd: (preset?: ConnectorPreset) => void; toast: ToastFn }) {
  const [tab, setTab] = useState<'connected' | 'available'>('connected')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const needle = search.trim().toLowerCase()
  const matches = (...text: (string | undefined)[]) => !needle || text.some((t) => t?.toLowerCase().includes(needle))
  const byName = (a: ConnectorState, b: ConnectorState) => displayName(a).localeCompare(displayName(b))
  const added = useMemo(() => state.connectors.filter((c) => !c.native && matches(c.id, c.name, c.url, c.command)).sort(byName), [state.connectors, needle])
  const servers = added.filter((c) => !c.api)
  const apis = added.filter((c) => c.api)
  const builtIn = useMemo(() => state.connectors.filter((c) => c.native && matches(c.id, c.name)).sort(byName), [state.connectors, needle])
  const suggestions = KNOWN.filter((k) => matches(k.name, k.url))
  const opened = state.connectors.find((c) => c.id === open)

  return (
    <div className="h-scroll">
      <div className="sb-page">
        <header className="sb-page-head">
          <div>
            <h1>Connectors</h1>
            <p>MCP servers and HTTP APIs your workspaces and agents can use. Connections stay open, so calls are fast.</p>
          </div>
        </header>

        <div className="h-cx-tabs" role="tablist" aria-label="Connectors">
          {(['connected', 'available'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'connected' ? 'Connected' : 'Available'}
              {t === 'connected' && <span className="h-cx-count">{state.connectors.length}</span>}
            </button>
          ))}
        </div>

        <div className="h-cx-bar">
          <label className="h-cx-search">
            <Search size={14} aria-hidden="true" />
            <input className="sb-input" type="search" placeholder="Search" aria-label="Search connectors" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} />
          </label>
          <button className="sb-btn primary" onClick={() => onAdd()}>
            <Plus size={14} /> Add connector
          </button>
        </div>

        {tab === 'connected' ? (
          <>
            {!!servers.length && (
              <Section title="MCP servers">
                {servers.map((c) => (
                  <Tile key={c.id} connector={c} onOpen={() => setOpen(c.id)} />
                ))}
              </Section>
            )}
            {!!apis.length && (
              <Section title="APIs">
                {apis.map((c) => (
                  <Tile key={c.id} connector={c} onOpen={() => setOpen(c.id)} />
                ))}
              </Section>
            )}
            {!!builtIn.length && (
              <Section title="Built in">
                {builtIn.map((c) => (
                  <Tile key={c.id} connector={c} onOpen={() => setOpen(c.id)} />
                ))}
              </Section>
            )}
            {!added.length && !builtIn.length && <p className="h-cx-empty">No connectors match “{search.trim()}”.</p>}
          </>
        ) : (
          <>
          <Section title="MCP servers">
            {suggestions.map((k) => {
              const have = state.connectors.filter((c) => sameServer(c.url, k.url))
              return (
                // Already added: this adds another (a second account or project), under a name of its own.
                <button key={k.url} className="h-cx-tile" onClick={() => onAdd({ name: have.length ? undefined : k.name.toLowerCase(), url: k.url })}>
                  <Logo url={k.url} />
                  <span className="h-cx-text">
                    <strong>{k.name}</strong>
                    <span className="h-cx-line">{have.length ? `Added${have.length > 1 ? ` ${have.length} times` : ''} · add another account` : host(k.url)}</span>
                  </span>
                </button>
              )
            })}
            <button className="h-cx-tile" onClick={() => onAdd({ mcp: true })}>
              <span className="h-cx-logo" style={{ width: 32, height: 32 }} aria-hidden="true">
                <Plus size={16} />
              </span>
              <span className="h-cx-text">
                <strong>Any MCP server</strong>
                <span className="h-cx-line">By URL or a local command</span>
              </span>
            </button>
          </Section>
          <Section title="APIs">
            <button className="h-cx-tile" onClick={() => onAdd({ api: true })}>
              <span className="h-cx-logo" style={{ width: 32, height: 32 }} aria-hidden="true">
                <Globe size={16} />
              </span>
              <span className="h-cx-text">
                <strong>Any HTTP API</strong>
                <span className="h-cx-line">A service with no MCP server: its URL and API key</span>
              </span>
            </button>
          </Section>
          </>
        )}

        <p className="h-hint">You can also add one from any chat: “add the Linear MCP at https://mcp.linear.app/mcp”, or “connect to the Typefully API” for a service without one.</p>
      </div>
      {opened && <ConnectorDetail c={opened} onClose={() => setOpen(null)} onAdd={onAdd} toast={toast} />}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="h-cx-section">
      <h2>{title}</h2>
      <div className="h-cx-grid">{children}</div>
    </section>
  )
}

function Tile({ connector: c, onOpen }: { connector: ConnectorState; onOpen: () => void }) {
  const ok = statusOf(c).tone === 'ok'
  return (
    <button className="h-cx-tile" onClick={onOpen} aria-label={`Open ${displayName(c)}`}>
      <Logo connector={c} />
      <span className="h-cx-text">
        <strong>{displayName(c)}</strong>
        {ok ? <span className="h-cx-line">{`${where(c)} · ${c.api ? 'HTTP API' : toolCount(c.tools.length)}`}</span> : <StatusLine c={c} />}
      </span>
    </button>
  )
}

/** One connector: where it is, its state, its tools, and what you can do with it. */
function ConnectorDetail({ c, onClose, onAdd, toast }: { c: ConnectorState; onClose: () => void; onAdd: (preset?: ConnectorPreset) => void; toast: ToastFn }) {
  const [filter, setFilter] = useState('')
  const act = (f: () => Promise<unknown>) => void f().catch((e) => toast(e instanceof Error ? e.message : String(e), 'bad'))
  const tools = c.tools.filter((t) => !filter || `${t.name} ${t.description ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <Shell
      title={displayName(c)}
      onClose={onClose}
      width={600}
      footer={
        <>
          {!c.native && (
            <button className="sb-btn ghost danger" style={{ marginRight: 'auto' }} onClick={() => confirm(`Remove ${c.id}?`) && (act(() => app('connector_remove', { connector: c.id })), onClose())}>
              Remove
            </button>
          )}
          {!c.native && c.transport === 'http' && (
            <button className="sb-btn" onClick={() => (onClose(), onAdd({ connector: c.id }))}>
              {c.hasCredentials ? 'Credentials' : 'Add token'}
            </button>
          )}
          {c.api && (
            <button className="sb-btn" onClick={() => (onClose(), onAdd({ connector: c.id }))}>
              Settings
            </button>
          )}
          {!c.native && (
            <button className="sb-btn" onClick={() => act(() => app('connector_reconnect', { connector: c.id, sign_in: true }))}>
              Reconnect
            </button>
          )}
          <button className="sb-btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="h-cx-head">
        <Logo connector={c} size={40} />
        <div className="h-cx-text">
          <span className="h-cx-url">{c.native ? where(c) : (c.url ?? [c.command, ...(c.args ?? [])].join(' '))}</span>
          {statusOf(c).tone === 'ok' ? <span className="h-cx-status ok">Connected · {toolCount(c.tools.length)}</span> : <StatusLine c={c} />}
        </div>
      </div>
      {c.error && c.status !== 'connected' && <div className="sb-error">{c.error}</div>}
      {c.api && (
        <dl className="h-cx-api">
          <dt>Authentication</dt>
          <dd>{apiAuthLine(c.api.auth.type, c.api.auth.name)}{c.api.auth.type !== 'none' && (c.hasCredentials ? ' · stored' : ' · not given yet')}</dd>
          {c.api.docsUrl && (
            <>
              <dt>Documentation</dt>
              <dd>
                <a href={c.api.docsUrl} onClick={(e) => (e.preventDefault(), void bridge.openExternal(c.api!.docsUrl!))}>
                  {c.api.docsUrl}
                </a>
              </dd>
            </>
          )}
          {c.api.notes && (
            <>
              <dt>For agents</dt>
              <dd>{c.api.notes}</dd>
            </>
          )}
        </dl>
      )}
      <div className="h-cx-tools">
        {c.tools.length > 8 && <input className="sb-input" placeholder={`Filter ${c.tools.length} tools`} value={filter} onChange={(e) => setFilter(e.target.value)} />}
        {tools.map((t) => (
          <div key={t.name} className="h-tool">
            <code>{t.name}</code>
            <span>{t.description?.split('\n')[0]?.slice(0, 160)}</span>
          </div>
        ))}
        {!tools.length && <div className="h-tool muted">{c.tools.length ? 'No tools match.' : 'No tools yet.'}</div>}
      </div>
    </Shell>
  )
}

export function ConnectorDialog({ preset, state, onClose, toast }: { preset: ConnectorPreset; state: AppState; onClose: () => void; toast: ToastFn }) {
  const editing: ConnectorState | undefined = preset.connector ? state.connectors.find((c) => c.id === preset.connector) : undefined
  // What is being added: asked first, unless the way here already said.
  const [kind, setKind] = useState<'mcp' | 'api' | null>(preset.api ? 'api' : preset.mcp || preset.url || preset.name ? 'mcp' : null)
  const asked = !preset.api && !preset.mcp && !preset.url && !preset.name
  const [mode, setMode] = useState<'remote' | 'local'>('remote')
  const [name, setName] = useState(preset.name ?? '')
  const [url, setUrl] = useState(preset.url ?? '')
  const [auth, setAuth] = useState<Auth>(() => authFrom(editing?.auth, editing?.status === 'needs-credentials'))
  const [command, setCommand] = useState('')
  const [env, setEnv] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [added, setAdded] = useState<string | null>(null)
  // After adding, keep watching the connector: sign-in finishes in the browser.
  const live = added ? state.connectors.find((c) => c.id === added) : undefined
  // A server that turned out to want a token: most hand out a bearer token.
  const asking = (editing ?? live)?.status === 'needs-credentials'
  useEffect(() => {
    if (asking) setAuth((a) => (a.kind === 'oauth' || a.kind === 'none' ? { ...a, kind: 'bearer' } : a))
  }, [asking])

  const headers = () => headersOf(auth)
  // Whether the server may be offered a browser sign-in: every kind but None (static headers win over it anyway).
  const oauth = () => auth.kind !== 'none'
  const guessName = (u: string) => {
    try {
      const host = new URL(u).hostname.replace(/^(mcp|api|www)\./, '')
      return host.split('.')[0] ?? ''
    } catch {
      return ''
    }
  }
  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (editing) {
        const c = await app('connector_update', { connector: editing.id, headers: headers(), oauth: oauth(), sign_in: true })
        if (c.status === 'connected') {
          toast(`${c.id} connected`, 'good')
          onClose()
        } else setAdded(c.id)
        return
      }
      const args =
        mode === 'remote'
          ? { name: name.trim() || guessName(url), url: url.trim(), headers: headers(), oauth: oauth() }
          : (() => {
              const [cmd, ...rest] = splitCommand(command)
              return { name: name.trim() || cmd, command: cmd, args: rest, env: Object.fromEntries(env.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) }
            })()
      const c = await app('connector_add', { ...args, sign_in: true })
      if (c.status === 'connected') {
        toast(`${c.id} connected: ${c.tool_count} tools`, 'good')
        onClose()
      } else setAdded(c.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Opened for a connector just added elsewhere (a template's Connect): it shows once the state has it.
  if (preset.connector && !editing) return null
  if (live && live.status === 'connected') {
    return (
      <Shell title={`${live.id} is connected`} onClose={onClose} footer={<button className="sb-btn primary" onClick={onClose}>Done</button>}>
        <p className="h-muted">{live.api ? 'Its request tool is' : `${live.tools.length} tools are`} available to your workspaces and agents.</p>
      </Shell>
    )
  }
  if (live && live.status !== 'needs-credentials') {
    return (
      <Shell title={live.status === 'auth-required' ? 'Finish signing in' : live.status === 'connecting' ? 'Connecting…' : `Could not connect to ${live.id}`} onClose={onClose} footer={<><button className="sb-btn" onClick={() => void app('connector_reconnect', { connector: live.id, sign_in: true })}>Try again</button><button className="sb-btn primary" onClick={onClose}>Close</button></>}>
        {live.status === 'auth-required' ? <p className="h-muted">Your browser opened {live.name}'s sign-in page. This closes by itself when you are done.</p> : live.status === 'connecting' ? <p className="h-muted">Talking to the server.</p> : <div className="sb-error">{live.error ?? 'The server did not answer.'}</div>}
      </Shell>
    )
  }

  const apiTarget = editing?.api ? editing : live?.api ? live : undefined
  if (apiTarget || (!editing && !live && kind === 'api'))
    return <ApiDialog key={apiTarget?.id ?? 'new'} existing={apiTarget} preset={preset} onBack={!apiTarget && asked ? () => setKind(null) : undefined} onClose={onClose} onAdded={setAdded} toast={toast} />
  if (!editing && !live && !kind) return <KindChooser onPick={setKind} onClose={onClose} reason={preset.reason} />

  const needsToken = !!editing || live?.status === 'needs-credentials'
  const target = editing ?? live
  if (needsToken && target) {
    return (
      <Shell
        title={target.hasCredentials ? `Credentials for ${target.id}` : `${target.id} needs a token`}
        onClose={onClose}
        footer={
          <>
            <button className="sb-btn" onClick={onClose}>Cancel</button>
            <button className="sb-btn primary" disabled={busy || !authReady(auth)} onClick={() => void (live && !editing ? app('connector_update', { connector: live.id, headers: headers(), oauth: oauth(), sign_in: true }).then((c) => (c.status === 'connected' ? (toast(`${c.id} connected`, 'good'), onClose()) : setError(c.error ?? c.status)), (e) => setError(String(e.message ?? e))) : submit())}>
              {busy ? 'Connecting…' : 'Save and connect'}
            </button>
          </>
        }
      >
        {preset.reason && <p className="h-muted">{preset.reason}</p>}
        <p className="h-muted">{target.url}</p>
        <AuthFields auth={auth} setAuth={setAuth} signedIn={target.auth?.kind === 'oauth'} />
        <p className="h-hint">Stored on this machine only. Agents use the connector through the app and never see the token.</p>
        {error && <div className="sb-error">{error}</div>}
      </Shell>
    )
  }

  return (
    <Shell
      title="Add an MCP server"
      onClose={onClose}
      footer={
        <>
          {asked ? <button className="sb-btn" style={{ marginRight: 'auto' }} onClick={() => setKind(null)}>Back</button> : null}
          <button className="sb-btn" onClick={onClose}>Cancel</button>
          <button className="sb-btn primary" disabled={busy || (mode === 'remote' ? !url.trim() || !authReady(auth) : !command.trim())} onClick={() => void submit()}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      }
    >
      {preset.reason && <p className="h-muted">{preset.reason}</p>}
      <div className="sb-tabs" role="tablist">
        <button role="tab" className={mode === 'remote' ? 'on' : ''} onClick={() => setMode('remote')}>Remote (URL)</button>
        <button role="tab" className={mode === 'local' ? 'on' : ''} onClick={() => setMode('local')}>Local (command)</button>
      </div>
      {mode === 'remote' ? (
        <>
          <label className="sb-field">
            <span>MCP server URL</span>
            <input className="sb-input" autoFocus placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && void submit()} />
          </label>
          {!preset.url && (
            <div className="h-known">
              {KNOWN.map((k) => (
                <button key={k.url} className={`h-chip btn${url === k.url ? ' on' : ''}`} onClick={() => (setUrl(k.url), setName((n) => n || k.name.toLowerCase()))}>
                  {k.name}
                </button>
              ))}
            </div>
          )}
          <label className="sb-field">
            <span>Name</span>
            <input className="sb-input" placeholder={guessName(url) || 'e.g. posthog-eu'} value={name} onChange={(e) => setName(e.target.value)} />
            <small>Add the same server twice under different names for two accounts or projects.</small>
          </label>
          <AuthFields auth={auth} setAuth={setAuth} />
        </>
      ) : (
        <>
          <label className="sb-field">
            <span>Command</span>
            <input className="sb-input" autoFocus placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents" value={command} onChange={(e) => setCommand(e.target.value)} />
          </label>
          <label className="sb-field">
            <span>Name</span>
            <input className="sb-input" placeholder="e.g. files" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="sb-field">
            <span>Environment</span>
            <textarea className="sb-input" rows={2} placeholder={'API_KEY=…\nOne per line'} value={env} onChange={(e) => setEnv(e.target.value)} />
          </label>
        </>
      )}
      {error && <div className="sb-error">{error}</div>}
    </Shell>
  )
}

// How a remote connector proves who you are. Each kind asks only for what it needs, and the
// header it turns into is built here: a bearer token is pasted bare, never typed as "Bearer …".
type AuthKind = 'oauth' | 'bearer' | 'header' | 'basic' | 'none'
type HeaderRow = { name: string; value: string; stored?: boolean }
interface Auth {
  kind: AuthKind
  token: string
  user: string
  pass: string
  rows: HeaderRow[]
  /** What is stored already: a field left empty keeps it. */
  stored?: ConnectorState['auth']
}
const AUTH_KINDS: { kind: AuthKind; name: string; hint: string }[] = [
  { kind: 'oauth', name: 'OAuth', hint: 'Sign in through the browser when the server asks' },
  { kind: 'bearer', name: 'Bearer token', hint: 'Paste a token or API key' },
  { kind: 'header', name: 'Custom header', hint: 'A key in a header of its own, like X-API-Key' },
  { kind: 'basic', name: 'Username and password', hint: 'HTTP basic auth' },
  { kind: 'none', name: 'None', hint: 'The server takes no authentication' },
]
/** The form for what is stored. A server that asked for a token and has none starts on a bearer token. */
const authFrom = (stored?: ConnectorState['auth'], wantsToken = false): Auth => ({
  kind: stored && stored.kind !== 'oauth' ? stored.kind : wantsToken ? 'bearer' : 'oauth',
  token: '',
  user: '',
  pass: '',
  rows: stored?.kind === 'header' ? stored.headers.map((name) => ({ name, value: '', stored: true })) : [{ name: '', value: '' }],
  stored,
})
const keeps = (a: Auth) => a.stored?.kind === a.kind && 'headers' in a.stored
const named = (a: Auth) => a.rows.filter((r) => r.name.trim())
/** Whether the fields are enough to save: filled in, or left empty over something stored. */
const authReady = (a: Auth) =>
  a.kind === 'oauth' ||
  a.kind === 'none' ||
  (a.kind === 'bearer' && (!!a.token.trim() || keeps(a))) ||
  (a.kind === 'basic' && ((!!a.user.trim() && !!a.pass) || (keeps(a) && !a.user.trim() && !a.pass))) ||
  (a.kind === 'header' && named(a).length > 0 && named(a).every((r) => r.value.trim() || r.stored))
/** The headers to store. An empty value keeps the stored one; none at all clears them. */
const headersOf = (a: Auth): Record<string, string> => {
  if (a.kind === 'bearer') return { Authorization: a.token.trim() ? `Bearer ${a.token.trim().replace(/^bearer\s+/i, '')}` : '' }
  if (a.kind === 'basic') return { Authorization: a.user.trim() ? `Basic ${btoa(String.fromCodePoint(...new TextEncoder().encode(`${a.user.trim()}:${a.pass}`)))}` : '' }
  if (a.kind === 'header') return Object.fromEntries(named(a).map((r) => [r.name.trim(), r.value.trim()]))
  return {}
}

function AuthFields({ auth, setAuth, signedIn }: { auth: Auth; setAuth: (a: Auth) => void; /** Signed in through the browser now. */ signedIn?: boolean }) {
  const set = (patch: Partial<Auth>) => setAuth({ ...auth, ...patch })
  const kept = keeps(auth)
  const setRow = (i: number, patch: Partial<HeaderRow>) => set({ rows: auth.rows.map((r, j) => (j === i ? { ...r, ...patch, ...(patch.name !== undefined ? { stored: false } : {}) } : r)) })
  return (
    <div className="h-auth">
      <div className="sb-field">
        <span>Authentication</span>
        <AuthPicker value={auth.kind} onChange={(kind) => set({ kind })} options={signedIn ? AUTH_KINDS.map((k) => (k.kind === 'oauth' ? { ...k, hint: 'Signed in through the browser' } : k)) : AUTH_KINDS} />
      </div>
      {auth.kind === 'bearer' && (
        <label className="sb-field">
          <span>Token</span>
          <input className="sb-input mono" type="password" autoFocus autoComplete="off" spellCheck={false} placeholder={kept ? 'Stored · paste a new one to replace it' : 'Paste it here'} value={auth.token} onChange={(e) => set({ token: e.target.value })} />
          <small>Sent as <code>Authorization: Bearer …</code></small>
        </label>
      )}
      {auth.kind === 'basic' && (
        <div className="h-token">
          <label className="sb-field" style={{ flex: 1 }}>
            <span>Username</span>
            <input className="sb-input" autoFocus autoComplete="off" spellCheck={false} placeholder={kept ? 'Stored' : ''} value={auth.user} onChange={(e) => set({ user: e.target.value })} />
          </label>
          <label className="sb-field" style={{ flex: 1 }}>
            <span>Password</span>
            <input className="sb-input" type="password" autoComplete="off" placeholder={kept ? 'Stored' : ''} value={auth.pass} onChange={(e) => set({ pass: e.target.value })} />
          </label>
        </div>
      )}
      {auth.kind === 'header' && (
        <div className="sb-field">
          <span>Headers</span>
          {auth.rows.map((r, i) => (
            <div key={i} className="h-auth-row">
              <input className="sb-input mono" autoFocus={i === 0 && !r.name} autoComplete="off" spellCheck={false} aria-label="Header name" placeholder="X-API-Key" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
              <input className="sb-input mono" type="password" autoComplete="off" spellCheck={false} aria-label="Header value" placeholder={r.stored ? 'Stored' : 'Value'} value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
              <button type="button" className="sb-btn ghost sm icon" title="Remove header" aria-label="Remove header" disabled={auth.rows.length < 2} onClick={() => set({ rows: auth.rows.filter((_, j) => j !== i) })}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button type="button" className="sb-btn ghost sm h-auth-add" onClick={() => set({ rows: [...auth.rows, { name: '', value: '' }] })}>
            <Plus size={14} /> Add header
          </button>
        </div>
      )}
    </div>
  )
}

/** The kinds of authentication, each with a line on when to pick it. */
function AuthPicker<K extends string>({ value, onChange, options }: { value: K; onChange: (k: K) => void; options: { kind: K; name: string; hint: string }[] }) {
  const [at, setAt] = useState<React.CSSProperties | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const kinds = options
  const current = kinds.find((k) => k.kind === value)!
  const open = () => {
    const r = button.current!.getBoundingClientRect()
    const below = window.innerHeight - r.bottom > kinds.length * 48 + 12
    setAt(below ? { left: r.left, width: r.width, top: r.bottom + 4 } : { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4 })
  }
  const close = () => (setAt(null), button.current?.focus())
  const move = (e: React.KeyboardEvent) => {
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault(), all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    else if (e.key === 'Escape' || e.key === 'Tab') e.preventDefault(), e.stopPropagation(), close()
  }
  return (
    <>
      <button ref={button} type="button" className="sb-input h-csel" aria-label="Authentication" aria-haspopup="listbox" aria-expanded={!!at} onClick={() => (at ? close() : open())} onKeyDown={(e) => e.key === 'ArrowDown' && (e.preventDefault(), open())}>
        <span className="h-csel-name">{current.name}</span>
        <ChevronDown size={14} className="h-csel-caret" aria-hidden="true" />
      </button>
      {at && (
        <>
          <div className="h-scrim h-csel-scrim" onMouseDown={close} />
          <div ref={list} className="h-menu h-csel-menu h-auth-menu" role="listbox" aria-label="Authentication" style={at} onKeyDown={move}>
            {kinds.map((k) => (
              <button key={k.kind} type="button" role="option" aria-selected={k.kind === value} autoFocus={k.kind === value} onClick={() => (onChange(k.kind), close())}>
                <span className="h-auth-opt">
                  <b>{k.name}</b>
                  <small>{k.hint}</small>
                </span>
                {k.kind === value && <Check size={14} className="h-csel-check" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}

// ── HTTP APIs. The form says how the API takes its key; the key is sent by the app on every request.
const API_KINDS: { kind: ApiAuthType; name: string; hint: string }[] = [
  { kind: 'bearer', name: 'Bearer token', hint: 'Authorization: Bearer <key>' },
  { kind: 'header', name: 'Key in a header', hint: 'A header of its own, like X-API-Key' },
  { kind: 'query', name: 'Key in the URL', hint: 'A query parameter, like ?api_key=<key>' },
  { kind: 'basic', name: 'Username and password', hint: 'HTTP basic auth; some APIs take the key as the username' },
  { kind: 'none', name: 'None', hint: 'The API is open' },
]
const apiAuthLine = (type: ApiAuthType, name?: string) =>
  type === 'bearer' ? 'Bearer token' : type === 'basic' ? 'Username and password' : type === 'header' ? `Key in the ${name} header` : type === 'query' ? `Key in the ${name} query parameter` : 'None'
/** "Name: value" lines, one header each. */
const parseHeaders = (text: string) => Object.fromEntries(text.split('\n').map((l) => l.trim()).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]))

/** The first question when adding: a server that speaks MCP, or an HTTP API without one. */
function KindChooser({ onPick, onClose, reason }: { onPick: (kind: 'mcp' | 'api') => void; onClose: () => void; reason?: string }) {
  const kinds = [
    { kind: 'mcp' as const, Icon: Plug, name: 'MCP server', hint: 'A server that speaks MCP: remote by its URL, or a program on this computer. Its tools come with it.' },
    { kind: 'api' as const, Icon: Globe, name: 'HTTP API', hint: 'A service with no MCP server: its REST API and an API key. Agents and workspaces call it through one tool, request.' },
  ]
  return (
    <Shell title="Add a connector" onClose={onClose} footer={<button className="sb-btn" onClick={onClose}>Cancel</button>}>
      {reason && <p className="h-muted">{reason}</p>}
      <div className="h-kinds">
        {kinds.map(({ kind, Icon, name, hint }, i) => (
          <button key={kind} type="button" className="h-kind" autoFocus={i === 0} onClick={() => onPick(kind)}>
            <span className="h-cx-logo" style={{ width: 36, height: 36 }} aria-hidden="true">
              <Icon size={18} />
            </span>
            <span className="h-kind-text">
              <strong>{name}</strong>
              <span>{hint}</span>
            </span>
            <ChevronRight size={16} className="h-kind-go" aria-hidden="true" />
          </button>
        ))}
      </div>
    </Shell>
  )
}

// The steps of adding an API, in order. The first two must be filled in; the rest have defaults.
const API_STEPS = ['API', 'Authentication', 'Requests', 'Documentation'] as const
const API_LAST = API_STEPS.length - 1
const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

/** Where you are in the steps. Adding, Next and Back move; editing, every step is filled in, so each is a link to it. */
function Steps({ step, onStep }: { step: number; onStep?: (step: number) => void }) {
  return (
    <ol className="h-steps">
      {API_STEPS.map((label, i) => {
        const at = i === step ? 'current' : i < step ? 'done' : 'todo'
        const content = (
          <>
            <span className="h-step-n">{at === 'done' && !onStep ? <Check size={11} /> : i + 1}</span>
            <span className="h-step-label">
              {label}
              {i >= 2 && <small> (optional)</small>}
            </span>
          </>
        )
        return (
          <li key={label} className={`h-step ${at}`}>
            {onStep ? (
              <button type="button" aria-current={at === 'current' ? 'step' : undefined} onClick={() => onStep(i)}>
                {content}
              </button>
            ) : (
              <span aria-current={at === 'current' ? 'step' : undefined}>{content}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function ApiDialog({ existing, preset, onBack, onClose, onAdded, toast }: { existing?: ConnectorState; preset: ConnectorPreset; /** Back to choosing what to add. */ onBack?: () => void; onClose: () => void; onAdded: (id: string) => void; toast: ToastFn }) {
  const api = existing?.api
  // A connector waiting for its key opens on the step that asks for it.
  const [step, setStep] = useState(existing?.status === 'needs-credentials' ? 1 : 0)
  const [name, setName] = useState(existing ? existing.name : (preset.name ?? ''))
  const [base, setBase] = useState(existing?.url ?? preset.url ?? '')
  const [type, setType] = useState<ApiAuthType>(api?.auth.type ?? 'bearer')
  const [authName, setAuthName] = useState(api?.auth.name ?? '')
  const [key, setKey] = useState('')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [check, setCheck] = useState(api?.checkPath ?? '')
  const [methods, setMethods] = useState<string[]>(api?.methods ?? API_METHODS)
  const [headers, setHeaders] = useState(Object.entries(api?.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'))
  const [docs, setDocs] = useState(api?.docsUrl ?? '')
  const [notes, setNotes] = useState(api?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // A key stays stored while the way it is sent stays the same; a field left empty keeps it.
  const kept = !!existing?.hasCredentials && type === api?.auth.type
  const validBase = /^https?:\/\/[^/\s]+/.test(base.trim())
  const keyReady = type === 'none' || (type === 'basic' ? !!user.trim() || kept : !!key.trim() || kept)
  const defaultName = type === 'header' ? 'X-API-Key' : 'api_key'
  const guessName = () => {
    try {
      const host = new URL(base.trim()).hostname
      return /^[\d.]+$|^localhost$/.test(host) ? '' : (host.replace(/^(api|www)\./, '').split('.')[0] ?? '')
    } catch {
      return ''
    }
  }
  const go = (to: number) => (setError(undefined), setStep(to))
  /** Forward one step, checking only what this one asked for. */
  const next = () => {
    if (step === 0 && !validBase) return setError('Enter the base URL, starting with https://')
    if (step === 1 && !keyReady) return setError(type === 'basic' ? 'Enter the username.' : 'Paste the API key.')
    go(Math.min(step + 1, API_LAST))
  }
  // Saving needs the first two steps; the others have defaults.
  const canSave = validBase && keyReady && methods.length > 0

  const submit = async () => {
    if (!validBase) return go(0)
    if (!keyReady) return go(1)
    setBusy(true)
    setError(undefined)
    try {
      const settings = { auth_type: type, auth_name: type === 'header' || type === 'query' ? authName.trim() || defaultName : undefined, check_path: check.trim(), methods: methods.length === API_METHODS.length ? [] : methods, headers: parseHeaders(headers), docs_url: docs.trim(), notes: notes.trim() }
      const credentials = type === 'none' ? undefined : type === 'basic' ? (user.trim() ? { username: user.trim(), password: pass } : undefined) : key.trim() ? { key: key.trim() } : undefined
      const c = existing
        ? await app('connector_update', { connector: existing.id, name: name.trim() || existing.name, url: base.trim(), api: settings, credentials })
        : await app('connector_add', { name: name.trim() || guessName() || 'api', url: base.trim(), api: settings, credentials })
      if (c.status === 'connected') {
        toast(`${c.id} connected`, 'good')
        onClose()
      } else if (c.status === 'needs-credentials') {
        // The key was refused (or none given): back to the step that asks for it.
        if (!existing) onAdded(c.id)
        setError(c.error ?? 'The API needs a key')
        setStep(1)
        setKey('')
        setPass('')
      } else onAdded(c.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const enter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'TEXTAREA') return
    e.preventDefault()
    if (step < 2 && !existing) next()
    else if (canSave) void submit()
  }

  return (
    <Shell
      title={existing ? `${existing.id} settings` : 'Add an HTTP API'}
      onClose={onClose}
      width={640}
      footer={
        <>
          {step === 0 ? (
            onBack ? <button className="sb-btn" style={{ marginRight: 'auto' }} onClick={onBack}>Back</button> : null
          ) : (
            <button className="sb-btn" style={{ marginRight: 'auto' }} onClick={() => go(step - 1)}>Back</button>
          )}
          <button className="sb-btn" onClick={onClose}>Cancel</button>
          {step < API_LAST && <button className={`sb-btn${step < 2 && !existing ? ' primary' : ''}`} onClick={next}>Next</button>}
          {/* Once the steps that must be filled in are behind you (or when editing), saving is there; the last step's main action. */}
          {(step >= 2 || existing) && (
            <button className={`sb-btn${step === API_LAST || existing ? ' primary' : ''}`} disabled={busy || !canSave} onClick={() => void submit()}>
              {busy ? 'Connecting…' : existing ? 'Save and connect' : 'Add connector'}
            </button>
          )}
        </>
      }
    >
      <Steps step={step} onStep={existing ? go : undefined} />
      <div className="h-step-body" onKeyDown={enter}>
        {step === 0 && (
          <>
            {preset.reason && <p className="h-muted">{preset.reason}</p>}
            {!existing && <p className="h-muted">For a service with no MCP server. Agents and workspaces get one tool, request, that calls the API with your key added.</p>}
            <label className="sb-field">
              <span>Base URL</span>
              <input className="sb-input mono" autoFocus spellCheck={false} placeholder="https://api.example.com/v1" value={base} onChange={(e) => setBase(e.target.value)} />
              <small>{existing?.hasCredentials ? 'Pointing it at another server drops the stored key.' : 'Requests are paths under it, and can never leave it.'}</small>
            </label>
            <label className="sb-field">
              <span>Name</span>
              <input className="sb-input" placeholder={guessName() || 'e.g. typefully'} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </>
        )}
        {step === 1 && (
          <>
            <div className="sb-field">
              <span>How the API takes its key</span>
              <AuthPicker value={type} onChange={(t) => (setType(t), setError(undefined))} options={API_KINDS} />
            </div>
            {(type === 'header' || type === 'query') && (
              <label className="sb-field">
                <span>{type === 'header' ? 'Header name' : 'Parameter name'}</span>
                <input className="sb-input mono" spellCheck={false} placeholder={defaultName} value={authName} onChange={(e) => setAuthName(e.target.value)} />
              </label>
            )}
            {type === 'basic' ? (
              <div className="h-token">
                <label className="sb-field" style={{ flex: 1 }}>
                  <span>Username</span>
                  <input className="sb-input" autoFocus autoComplete="off" spellCheck={false} placeholder={kept ? 'Stored' : ''} value={user} onChange={(e) => setUser(e.target.value)} />
                </label>
                <label className="sb-field" style={{ flex: 1 }}>
                  <span>Password</span>
                  <input className="sb-input" type="password" autoComplete="off" placeholder={kept ? 'Stored' : ''} value={pass} onChange={(e) => setPass(e.target.value)} />
                </label>
              </div>
            ) : (
              type !== 'none' && (
                <label className="sb-field">
                  <span>API key</span>
                  <input className="sb-input mono" type="password" autoFocus autoComplete="off" spellCheck={false} placeholder={kept ? 'Stored · paste a new one to replace it' : 'Paste it here'} value={key} onChange={(e) => setKey(e.target.value)} />
                </label>
              )
            )}
            <label className="sb-field">
              <span>Check path (optional)</span>
              <input className="sb-input mono" spellCheck={false} placeholder="/v1/me" value={check} onChange={(e) => setCheck(e.target.value)} />
              <small>A cheap GET that only works with a valid key. The key is tried on it when you save.</small>
            </label>
            <p className="h-hint">Stored on this machine only. Agents use the API through the app and never see the key.</p>
          </>
        )}
        {step === 2 && (
          <>
            <div className="sb-field">
              <span>Allowed methods</span>
              <div className="h-methods">
                {API_METHODS.map((m) => {
                  const on = methods.includes(m)
                  return (
                    <button key={m} type="button" className={`h-chip btn${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setMethods((cur) => (on ? cur.filter((x) => x !== m) : API_METHODS.filter((x) => x === m || cur.includes(x))))}>
                      {m}
                    </button>
                  )
                })}
              </div>
              <small>{!methods.length ? 'Allow at least one.' : methods.every((m) => m === 'GET' || m === 'HEAD') ? 'Read-only: workspaces bound to it can call it without asking.' : 'Requests with any other method are refused.'}</small>
            </div>
            <label className="sb-field">
              <span>Headers on every request</span>
              <textarea className="sb-input mono" rows={3} spellCheck={false} placeholder={'X-Api-Version: 2026-05-12\nOne per line, not secrets'} value={headers} onChange={(e) => setHeaders(e.target.value)} />
            </label>
          </>
        )}
        {step === 3 && (
          <>
            <p className="h-muted">Help agents use this API. Both are part of what they read about its request tool.</p>
            <label className="sb-field">
              <span>Documentation</span>
              <input className="sb-input" autoFocus spellCheck={false} placeholder="https://docs.example.com/api" value={docs} onChange={(e) => setDocs(e.target.value)} />
            </label>
            <label className="sb-field">
              <span>Notes for agents</span>
              <textarea className="sb-input" rows={4} placeholder="What it is for, the endpoints that matter, how pages work. e.g. Amounts are in cents; paginate with ?cursor=…" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </>
        )}
      </div>
      {(error || (existing?.status !== 'connected' && existing?.error)) && <div className="sb-error">{error ?? existing?.error}</div>}
    </Shell>
  )
}

export function Shell({ title, onClose, children, footer, width = 500 }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number }) {
  return (
    <div className="sb-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="sb-modal" style={{ width }} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <div className="sb-modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

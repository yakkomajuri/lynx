// New workspace: start blank or install a template. Templates come from the remote marketplace
// (official or community) and your private shelf; the page filters them by words, who made them, connector and tag. A template opens as a page of
// its own, running on its demo data beside the steps to install it, and a security review for templates
// the Lynx team did not make. Installing
// (forking) copies the code into a workspace you own and binds it to your connectors. A connector you
// don't have yet is added from here in one click: the server is tried with OAuth, and only one that
// wants a token opens a dialog to paste it.
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { BadgeCheck, Check, ChevronDown, ChevronRight, Clock, Eye, Search, ShieldCheck, Users, Wrench, X } from 'lucide-react'
import { sameCombo, type Combo } from '@kit/keys'
import { Markdown, Tabs } from '@kit/ui'
import { cronWords } from '@shared/cronWords'
import { connectorsOf, matchesFacets as fits, type TemplateFacets, type TemplateFilter } from '@shared/templates'
import { freeName } from '@shared/workspaceNames'
import { normUrl, type AppState, type ConnectorState, type MarketplaceItem, type MarketplaceRequirement, type WorkspaceInfo } from '@shared/types'
import { app } from './api'
import type { TemplateReview } from '@shared/templateReview'
import { Logo, Shell, statusOf, type ConnectorPreset } from './Connectors'
import { boundCombos, comboFor, onShortcuts } from './keymap'
import { ReviewDialog, type ReviewChoice } from './SecurityReview'
import { WorkspaceIcon } from './WorkspaceIcon'

// Monaco is big: the code inspector loads the first time someone opens it.
const CodeInspector = lazy(() => import('./CodeInspector'))

const matches = (state: AppState, url: string) => state.connectors.filter((c) => c.url && normUrl(c.url) === normUrl(url))
// A requirement without a URL takes any connector of yours, and none unless you pick one.
const optionsFor = (state: AppState, r: MarketplaceRequirement) => (r.url ? matches(state, r.url) : state.connectors.filter((c) => !c.native))

const FILTER = 'sb.market.filter'
const owned = (item: MarketplaceItem, state: AppState) => item.source === 'remote' && !!state.remote.account?.handle && item.publisher?.handle === state.remote.account.handle

/** Who made a template, as a badge: verified by the Lynx team, a community member, or you. */
export function Creator({ item, long = false }: { item: MarketplaceItem; long?: boolean }) {
  if (item.creator === 'official')
    return (
      <span className="h-creator official" title="Made and checked by the Lynx team">
        <BadgeCheck size={long ? 15 : 13} aria-hidden="true" />
        {long ? 'Verified · by the Lynx team' : 'Verified'}
      </span>
    )
  if (item.creator === 'you') return <span className="h-creator">{long ? 'Yours · saved on this computer' : 'Yours'}</span>
  return (
    <span className="h-creator" title="Published by a community member. Not checked by the Lynx team: run a security review before you install it.">
      <Users size={long ? 14 : 12} aria-hidden="true" />
      {item.verified ? <>Verified · </> : null}
      Community{item.publisher?.handle ? ` · @${item.publisher.handle}` : ''}
    </span>
  )
}

export function MarketplaceView({ state, onOpen, onPick }: { state: AppState; onOpen: (id: string) => void; /** A template was clicked: its page opens. */ onPick: (item: MarketplaceItem) => void }) {
  const [blank, setBlank] = useState(false)
  const [shelf, setShelf] = useState<'all' | 'mine'>('all')
  const search = useRef<HTMLInputElement>(null)
  // Kept while the app is open, so going into a template and back finds the list as it was.
  const [filter, setFilterState] = useState<TemplateFacets>(() => {
    const saved = JSON.parse(sessionStorage.getItem(FILTER) ?? '{}') as TemplateFacets & TemplateFilter
    return { q: saved.q, creators: saved.creators ?? (saved.creator ? [saved.creator] : []), connectors: saved.connectors ?? (saved.connector ? [saved.connector] : []), categories: saved.categories ?? saved.tags ?? [] }
  })
  const setFilter = (next: TemplateFacets) => {
    sessionStorage.setItem(FILTER, JSON.stringify(next))
    setFilterState(next)
  }
  const items = state.marketplace.filter((i) => shelf !== 'mine' || owned(i, state))
  const shown = items.filter((i) => fits(i, filter))
  const filtering = !!(filter.q?.trim() || filter.categories?.length || filter.connectors?.length || filter.creators?.length)
  // Alphabetical options, limited to what some template has.
  const tags = [...new Set(items.flatMap((i) => i.tags ?? []))].sort((a, b) => a.localeCompare(b))
  const conns = [...new Map(items.flatMap(connectorsOf).map((c) => [c.key, c])).values()].sort((a, b) => a.name.localeCompare(b.name))
  const handles = [...new Set([...items.flatMap((i) => i.publisher?.handle ? [`@${i.publisher.handle.toLowerCase()}` as const] : []), ...(filter.creators ?? []).filter((value): value is `@${string}` => value.startsWith('@'))])].sort((a, b) => a.localeCompare(b))
  const creators: { value: NonNullable<TemplateFacets['creators']>[number]; label: string }[] = [
    { value: 'official', label: 'Official' },
    { value: 'community', label: 'Community' },
    ...(items.some((i) => i.creator === 'you') ? [{ value: 'you' as const, label: 'Yours' }] : []),
    ...handles.map((handle) => ({ value: handle, label: handle })),
  ]
  const connectorOptions = conns.map((c) => ({ value: c.key, label: c.name, icon: <Logo url={c.url} connector={c.native ? state.connectors.find((n) => n.id === c.key) : undefined} builtIn={c.key === 'app'} size={18} /> }))
  const selectedFilters: { key: string; label: string; kind: string; icon?: ReactNode; remove: () => void }[] = [
    ...(filter.creators ?? []).map((value) => ({ key: `creator:${value}`, label: creators.find((c) => c.value === value)?.label ?? value, kind: 'creator', remove: () => setFilter({ ...filter, creators: filter.creators?.filter((v) => v !== value) }) })),
    ...(filter.connectors ?? []).map((value) => {
      const option = connectorOptions.find((c) => c.value === value)
      return { key: `connector:${value}`, label: option?.label ?? value, kind: 'connector', icon: option?.icon, remove: () => setFilter({ ...filter, connectors: filter.connectors?.filter((v) => v !== value) }) }
    }),
    ...(filter.categories ?? []).map((value) => ({ key: `category:${value}`, label: value, kind: 'category', remove: () => setFilter({ ...filter, categories: filter.categories?.filter((v) => v !== value) }) })),
  ]
  return (
    <div className="h-scroll">
      <div className="sb-page">
        <p className="h-lead">Install a template and make it yours, or start from nothing and ask the agent to build it.</p>
        <Tabs value={shelf} onChange={setShelf} options={[{ value: 'all', label: 'All templates' }, { value: 'mine', label: 'My templates' }]} />
        {shelf === 'mine' && <p className="h-muted">{state.remote.account ? 'Templates published by your marketplace account. Open one to publish an update from a workspace.' : 'Sign in under Settings → Marketplace to see your published templates.'}</p>}
        <div className="h-market-filters">
          <label className="h-market-search">
            <Search size={14} aria-hidden="true" />
            <input ref={search} className="sb-input" type="search" placeholder="Search templates" aria-label="Search templates" value={filter.q ?? ''} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          </label>
          <div className="h-market-filter-row">
            <FilterChoices label="Created by" empty="Anyone" searchPlaceholder="Search @handle" options={creators} values={filter.creators ?? []} onChange={(creators) => setFilter({ ...filter, creators })} />
            <FilterChoices label="Connector" empty="Any connector" options={connectorOptions} values={filter.connectors ?? []} onChange={(connectors) => setFilter({ ...filter, connectors })} />
            <FilterChoices label="Category" empty="All categories" options={tags.map((t) => ({ value: t, label: t }))} values={filter.categories ?? []} onChange={(categories) => setFilter({ ...filter, categories })} />
            <button className="h-link" disabled={!filtering} onClick={() => setFilter({})}>Clear filters</button>
          </div>
          {!!selectedFilters.length && (
            <div className="h-chips h-market-selected" role="group" aria-label="Selected filters">
              {selectedFilters.map((selected) => (
                <button key={selected.key} type="button" className="h-chip" aria-label={`Remove ${selected.label} ${selected.kind} filter`} onClick={(e) => {
                  // Keep keyboard focus on a remaining pill, or return to search after the last one.
                  const next = (e.currentTarget.nextElementSibling ?? e.currentTarget.previousElementSibling) as HTMLButtonElement | null
                  next?.focus()
                  if (!next) search.current?.focus()
                  selected.remove()
                }}>
                  {selected.icon}
                  <span>{selected.label}</span>
                  <X size={12} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>
        <RemoteStatus state={state} />
        <div className="h-market">
          {!filtering && shelf === 'all' && (
            <button className="h-tile blank" onClick={() => setBlank(true)}>
              <span className="h-tile-icon">＋</span>
              <strong>Blank workspace</strong>
              <p>An empty page and an agent. Describe what you want to see.</p>
            </button>
          )}
          {shown.map((i) => (
            <Tile key={`${i.source}:${i.id}`} item={i} state={state} onPick={onPick} />
          ))}
        </div>
        {(filtering || shelf === 'mine') && !shown.length && (
          <p className="h-muted h-market-none">
            {shelf === 'mine' && !filtering ? 'No published templates yet.' : 'No templates match.'}{' '}
            <button className="h-link" onClick={() => setFilter({})}>
              Clear filters
            </button>
          </p>
        )}
      </div>
      {blank && <BlankDialog onClose={() => setBlank(false)} onOpen={onOpen} />}
    </div>
  )
}

/** A compact disclosure with checkbox choices; selecting one leaves the list open. */
function FilterChoices<T extends string>({ label, empty, options, values, onChange, searchPlaceholder }: {
  label: string
  empty: string
  options: { value: T; label: string; icon?: ReactNode }[]
  values: T[]
  onChange: (values: T[]) => void
  searchPlaceholder?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => { if (!open) setQuery('') }, [open])
  const term = query.trim().toLowerCase().replace(/^@/, '')
  const visible = options.filter((o) => !term || o.label.toLowerCase().replace(/^@/, '').includes(term))
  const toggle = (value: T) => onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value])
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const selected = options.filter((o) => values.includes(o.value))
  const summary = selected.length ? selected.map((o) => o.label).join(', ') : empty
  return (
    <div ref={box} className="sb-field h-filter-choices" onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
    }} onKeyDown={(e) => {
      if (e.key === 'Escape' && open) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        button.current?.focus()
      }
    }}>
      <span id={`${id}-label`}>{label}</span>
      <button ref={button} type="button" className="sb-input h-csel" aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-choices`} onClick={() => setOpen(!open)}>
        {selected.some((o) => o.icon) && <span className="h-filter-icons" aria-hidden="true">{selected.slice(0, 3).map((o) => <span key={o.value}>{o.icon}</span>)}</span>}
        <span className="h-csel-name" id={`${id}-value`} title={summary}>{summary}</span>
        <ChevronDown size={14} className="h-csel-caret" aria-hidden="true" />
      </button>
      {open && (
        <div ref={list} id={`${id}-choices`} className="h-filter-options" role="group" aria-labelledby={`${id}-label`} onKeyDown={(e) => {
          const inputs = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role=checkbox]') ?? [])]
          const i = inputs.indexOf(document.activeElement as HTMLButtonElement)
          const typing = e.target instanceof HTMLInputElement
          if (typing && e.key === 'Enter' && visible.length === 1) {
            e.preventDefault()
            toggle(visible[0].value)
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            inputs[i < 0 ? (e.key === 'ArrowDown' ? 0 : inputs.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : inputs.length - 1)) % inputs.length]?.focus()
          } else if (!typing && (e.key === 'Home' || e.key === 'End')) {
            e.preventDefault()
            inputs[e.key === 'Home' ? 0 : inputs.length - 1]?.focus()
          }
        }}>
          {searchPlaceholder && <input className="sb-input h-filter-search" type="search" aria-label={searchPlaceholder} placeholder={searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />}
          {visible.map((o) => (
            <button key={o.value} type="button" role="checkbox" aria-checked={values.includes(o.value)} className="h-filter-option" onClick={() => toggle(o.value)}>
              <span className="h-filter-check" aria-hidden="true"><Check size={12} /></span>
              {o.icon}
              <span>{o.label}</span>
            </button>
          ))}
          {!visible.length && <span className="h-muted h-filter-empty">{term ? 'No matching creators' : 'No options available'}</span>}
        </div>
      )}
    </div>
  )
}

/** Whether the public marketplace answered: said only when it is on its way or did not. */
function RemoteStatus({ state }: { state: AppState }) {
  const { status, error } = state.remote
  const [retrying, setRetrying] = useState(false)
  if (status === 'loading' && !state.marketplace.some((i) => i.source === 'remote')) return <p className="h-muted h-market-status">Loading templates…</p>
  if (status !== 'error') return null
  return (
    <p className="h-market-status bad" title={error}>
      Could not reach the marketplace, so only the templates on this computer are shown.
      <button className="h-link" disabled={retrying} onClick={() => (setRetrying(true), void app('marketplace_refresh').finally(() => setRetrying(false)))}>
        {retrying ? 'Trying…' : 'Try again'}
      </button>
    </p>
  )
}

function Tile({ item: i, state, onPick }: { item: MarketplaceItem; state: AppState; onPick: (item: MarketplaceItem) => void }) {
  return (
    <button className={`h-tile${i.preview ? ' shown' : ''}`} onClick={() => onPick(i)}>
      {i.preview && <Preview item={i} />}
      <span className="h-tile-title">
        <strong>{i.name}</strong>
        {/* Connector identity stays in color, including before it is connected. */}
        <span className="h-tile-stack">
          {i.requires.length ? (
            i.requires.map((r) => {
              // Without a fixed server, any of your connectors can stand in.
              const n = optionsFor(state, r).length
              return (
                <span key={r.alias} title={`${r.name}${r.optional ? ' (optional)' : ''}${n ? '' : ' · not connected yet'}`}>
                  <Logo url={r.url} size={18} />
                </span>
              )
            })
          ) : (
            <span title="Uses only the built-in connectors">
              <Logo builtIn size={18} />
            </span>
          )}
        </span>
      </span>
      <p className="h-tile-desc">{i.description}</p>
      <span className="h-tile-meta">
        <Creator item={i} />
        {!!i.installs && <span className="h-muted">{i.installs.toLocaleString()} install{i.installs === 1 ? '' : 's'}</span>}
      </span>
    </button>
  )
}

// Tiles' previews load in the order they are on the page, top first, a couple at a time: each is a whole
// app, and started all at once they finish in any order, so tiles further down drew before the first ones.
// A tile waits its turn once it is near the screen; the next one starts when one has loaded.
const AT_ONCE = 2
const waiting = new Map<HTMLElement, () => void>()
let loading = 0
function startNext() {
  while (loading < AT_ONCE && waiting.size) {
    const at = (e: HTMLElement) => e.getBoundingClientRect()
    // Top first, and left first along a row.
    const [el, go] = [...waiting].reduce((a, b) => (at(b[0]).top < at(a[0]).top - 1 || (Math.abs(at(b[0]).top - at(a[0]).top) <= 1 && at(b[0]).left < at(a[0]).left) ? b : a))
    waiting.delete(el)
    loading++
    go()
  }
}
/** Waits for `el`'s turn, calls `go`; the returned `done` (call it once loaded) lets the next one start. */
function inTurn(el: HTMLElement, go: () => void) {
  let started = false
  let finished = false
  waiting.set(el, () => ((started = true), go()))
  // After this round of tiles coming near the screen has queued, so the first pick sees them all.
  setTimeout(startNext)
  const done = () => {
    if (finished) return
    finished = true
    if (started) loading--
    else waiting.delete(el)
    startNext()
  }
  return done
}

// The item itself, running on the made-up data of its preview/mock.js. On a tile, drawn at a desktop
// size and scaled to fit, so it shows the whole page as it will look; on the template's page it fills
// the room as a workspace would, and can be used.
const PAGE = { width: 1280, height: 800 }
function Preview({ item, live = false, onShortcut }: { item: MarketplaceItem; live?: boolean; /** One of the app's shortcuts, pressed inside a live preview. */ onShortcut?: (combo: Combo) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const shortcut = useRef(onShortcut)
  shortcut.current = onShortcut
  // A live preview hands the app's shortcuts to the window, as a workspace does: it is told which keys they are once it is up.
  useEffect(() => {
    if (!live) return
    const send = () => frame.current?.contentWindow?.postMessage({ sb: 1, type: 'shortcuts', combos: boundCombos() }, '*')
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.sb !== 1) return
      if (e.data.type === 'ready') send()
      // Opening the command bar is harmless; never forward arbitrary shortcuts from untrusted code.
      else if (e.data.type === 'shortcut' && e.data.combo && typeof e.data.combo.key === 'string') {
        const bar = comboFor('command-bar')
        if (bar && sameCombo(e.data.combo, bar)) shortcut.current?.(bar)
      }
    }
    window.addEventListener('message', onMessage)
    const off = onShortcuts(send)
    return () => {
      window.removeEventListener('message', onMessage)
      off()
    }
  }, [live])
  const [scale, setScale] = useState(0)
  // A tile's turn to load (see inTurn); the template's page loads its one preview at once.
  const [turn, setTurn] = useState(live)
  const loaded = useRef<() => void>(undefined)
  useEffect(() => {
    const el = box.current
    if (live || !el) return
    let done: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    // Near the screen: what is far below waits until it is scrolled to.
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting || done) return
        io.disconnect()
        done = inTurn(el, () => {
          setTurn(true)
          // One that never says it loaded does not hold up the rest.
          timer = setTimeout(() => done?.(), 4000)
        })
        loaded.current = done
      },
      { root: el.closest('.h-scroll'), rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      clearTimeout(timer)
      done?.()
    }
  }, [live])
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (live) return setScale(1)
    const fit = () => setScale(el.clientWidth / PAGE.width)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // A page that focuses something as it loads (chat's composer) would pull the focus, and the scroll
  // with it, into the preview. Tiles never focus anything (the kit sees ?tile); the template page's gives it back while loading.
  useEffect(() => {
    if (!live) return
    const before = document.activeElement as HTMLElement | null
    const until = Date.now() + 3000
    const back = () => setTimeout(() => Date.now() < until && document.activeElement?.tagName === 'IFRAME' && box.current?.contains(document.activeElement) && before?.focus({ preventScroll: true }))
    window.addEventListener('blur', back)
    return () => window.removeEventListener('blur', back)
  }, [live])
  return (
    <div ref={box} className={`h-preview${live ? ' live' : ''}`} aria-hidden={!live} inert={!live}>
      {scale > 0 && turn && (
        <iframe
          ref={frame}
          title={`${item.name} preview`}
          src={`sbw://preview.${item.source}.${item.id}/${live ? '' : '?tile'}#${item.preview?.path ?? '/'}`}
          sandbox="allow-scripts"
          onLoad={() => loaded.current?.()}
          tabIndex={live ? 0 : -1}
          style={live ? undefined : { width: PAGE.width, height: PAGE.height, transform: `scale(${scale})` }}
        />
      )}
    </div>
  )
}

/**
 * A template's page. Down the left, what it is and who made it, then the steps to install it and the
 * button that does, all in one column, in the order they are done. The rest of the page shows the
 * template running on made-up data, marked as a preview so it is not taken for the real thing, or its code.
 */
export function TemplateView({ item, state, onOpen, onAddConnector, onReview, onShortcut, onUpdate }: { item: MarketplaceItem; state: AppState; onOpen: (id: string) => void; onAddConnector: (preset: ConnectorPreset) => void; onReview: (choice: ReviewChoice) => void; onUpdate: (workspace: WorkspaceInfo) => void; /** One of the app's shortcuts, pressed in the demo or the code: the app runs it. */ onShortcut: (combo: Combo) => void }) {
  const [name, setName] = useState(() => freeName(item.name, state.workspaces.map((w) => w.name)))
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [reviewing, setReviewing] = useState(false)
  const [review, setReview] = useState<TemplateReview>({ status: 'required' })
  const needsReview = item.creator === 'community' && review.status !== 'passed'
  useEffect(() => {
    if (item.creator !== 'community') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await app<TemplateReview>('marketplace_review_status', { source: item.source, item: item.id })
        if (!stopped) setReview(next)
      } catch (e) {
        if (!stopped) setReview({ status: 'required', report: `Could not check the review: ${e instanceof Error ? e.message : String(e)}` })
      }
      if (!stopped) timer = setTimeout(poll, 2000)
    }
    setReview({ status: 'required' })
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [item.source, item.id, item.version, item.creator])
  // What the room beside the form shows: the template running on its demo data, or its files.
  const [side, setSide] = useState<'preview' | 'code'>(item.preview ? 'preview' : 'code')
  const chosen = (r: MarketplaceRequirement) => picked[r.alias] ?? (r.url ? matches(state, r.url)[0]?.id : undefined)
  const missing = item.requires.filter((r) => !r.optional && !chosen(r))
  const has = (tool: string) => state.tools.some((t) => t.name === tool)
  // The requirement being connected right now, by alias.
  const [connecting, setConnecting] = useState<string>()
  // A known server is added as it is and signed in through the browser; one that turns out to want a
  // token gets the dialog that asks for it. Without a URL there is nothing to try: the full form opens.
  const connect = async (r: MarketplaceRequirement) => {
    if (!r.url) return onAddConnector({ name: r.name.toLowerCase(), reason: r.hint })
    setConnecting(r.alias)
    setError(undefined)
    try {
      const c = await app('connector_add', { name: r.name.toLowerCase(), url: r.url, sign_in: true })
      if (c.status === 'needs-credentials') onAddConnector({ connector: c.id, reason: r.hint })
      else if (c.status === 'error') setError(`${r.name}: ${c.error ?? 'could not connect'}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConnecting(undefined)
    }
  }
  const fork = async () => {
    if (needsReview) return setReviewing(true)
    setBusy(true)
    setError(undefined)
    try {
      const w = await app('marketplace_fork', { item: item.id, source: item.source, name: name.trim() || undefined, connectors: Object.fromEntries(item.requires.flatMap((r) => (chosen(r) ? [[r.alias, chosen(r)]] : []))) })
      onOpen(w.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  let step = 0
  return (
    <div className="h-template">
      <aside className="h-template-side">
        <div className="h-template-scroll">
          <header className="h-template-head">
            <div className="h-template-name">
              <WorkspaceIcon icon={item.icon} color={item.color} size={18} />
              <h2>{item.name}</h2>
            </div>
            <Creator item={item} long />
            <p className="h-muted">{item.description}</p>
            {!!item.tags?.length && (
              <div className="h-chips">
                {item.tags.map((t) => (
                  <span key={t} className="h-chip">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </header>
          {owned(item, state) && (
            <details className="h-template-owner">
              <summary>Update this template · v{item.version}</summary>
              <p className="h-muted">Choose a workspace with your changes. An agent prepares the update for your approval.</p>
              <div className="h-template-workspaces">
                {state.workspaces.map((w) => <button key={w.id} className="sb-btn ghost" onClick={() => onUpdate(w)}><WorkspaceIcon icon={w.icon} color={w.color} size={16} />{w.name}</button>)}
                {!state.workspaces.length && <p className="h-muted">Create a workspace from this template first, then edit it.</p>}
              </div>
            </details>
          )}
          <section className="h-setup" aria-label="Set up your workspace">
            <h3>Set up your workspace</h3>
            <div className="h-setup-step">
              <span className="h-setup-n">{++step}</span>
              <label className="sb-field">
                <span>Name it</span>
                <input className="sb-input" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
            <div className="h-setup-step">
              <span className="h-setup-n">{++step}</span>
              <div className="sb-field">
                <span>Connect your accounts</span>
                {!item.requires.length && <small>Nothing to connect: it only uses what comes with Lynx.</small>}
                {item.requires.map((r) => {
                  const options = optionsFor(state, r)
                  const waiting = options.find((c) => c.id === chosen(r))?.status === 'auth-required'
                  return (
                    <div key={r.alias} className="h-setup-conn">
                      <span className="h-setup-conn-name">
                        {r.name}
                        {r.optional ? <span className="h-muted"> (optional)</span> : ''}
                      </span>
                      {options.length ? (
                        <ConnectorSelect options={options} value={chosen(r)} optional={!!r.optional} label={`${r.name} connector`} onChange={(id) => setPicked({ ...picked, [r.alias]: id })} />
                      ) : (
                        <div className="h-need">
                          <button className="sb-btn sm h-connect" disabled={connecting === r.alias} onClick={() => void connect(r)}>
                            <Logo url={r.url} size={16} />
                            {connecting === r.alias ? `Connecting ${r.name}…` : `Connect ${r.name}`}
                          </button>
                        </div>
                      )}
                      {/* Under a Connect button the button says it all; a hint only explains a choice. */}
                      {options.length > 0 && <small>{waiting ? `Your browser opened ${r.name}'s sign-in page. This updates by itself when you are done.` : !r.url ? (r.hint ?? 'Optional: pick one of your connectors, or none.') : options.length > 1 ? 'Several of your connectors point at this server. Pick the account this workspace should use.' : (r.hint ?? `This UI was written against ${r.url}.`)}</small>}
                    </div>
                  )
                })}
              </div>
            </div>
            {item.tools?.length ? (
              <div className="h-setup-step">
                <span className="h-setup-n">{++step}</span>
                <div className="sb-field">
                  <span>Custom tools it adds</span>
                  <div className="h-fork-tools">
                    {item.tools.map((t) => {
                      const schedule = item.schedules?.find((s) => s.tool === t)
                      // The first sentence: the rest of a tool's description is for agents.
                      const what = item.toolDescriptions?.[t]?.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? item.toolDescriptions?.[t]
                      return (
                        <div key={t} className="h-fork-tool" title={item.toolDescriptions?.[t] || undefined}>
                          <div className="h-fork-tool-top">
                            <Wrench size={13} aria-hidden="true" />
                            <code>{t}</code>
                            {/* Forking skips a tool you already have, so yours (and any edits to it) stays as it is. */}
                            {has(t) && <span className="h-fork-tool-kept">Already installed</span>}
                            {schedule && (
                              <span className="h-fork-tool-when" title="Runs while the app is open. Pause it in Settings › Schedules.">
                                <Clock size={11} aria-hidden="true" />
                                {cronWords(schedule.cron)}
                              </span>
                            )}
                          </div>
                          {what && <p>{what}</p>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            ) : null}
            <Reach item={item} state={state} />
          {/* The Lynx team's own templates were checked before they shipped: no review to run. Anyone else's can be reviewed first. */}
          {item.creator === 'official' ? (
            <div className="h-verified" role="note">
              <BadgeCheck size={18} strokeWidth={2} aria-hidden="true" />
              <span>
                <strong>This is a verified template</strong>
                <small>Made and checked by the Lynx team. It only calls the tools listed under What it may call.</small>
              </span>
            </div>
          ) : item.creator === 'community' ? (
            <div className="h-community-review" data-status={review.status}>
              <strong><ShieldCheck size={16} aria-hidden="true" /> {review.status === 'passed' ? 'Security review complete' : review.status === 'running' ? 'Security review in progress' : review.status === 'blocked' ? 'Creation blocked by the review' : 'Security review required'}</strong>
              <p className="h-muted">{review.status === 'passed' ? 'The agent found no reason to block this version. Read its assessment before you continue.' : review.status === 'running' ? 'Read the assessment in the agent panel when it finishes.' : 'An agent must check this community template before it can use your data.'}</p>
              {review.report && <details><summary>Review assessment</summary><Markdown>{review.report}</Markdown></details>}
              <button className="sb-btn h-review" disabled={review.status === 'running'} onClick={() => setReviewing(true)}>{review.status === 'passed' || review.status === 'blocked' ? 'Run another review' : 'Run security review'}</button>
            </div>
          ) : (
            <button className="sb-btn ghost h-review" onClick={() => setReviewing(true)}><ShieldCheck size={15} aria-hidden="true" />Run a security review</button>
          )}
          </section>
        </div>
        <footer className="h-template-actions">
          {error && <div className="sb-error">{error}</div>}
          <button className="sb-btn primary h-install" disabled={busy || !!missing.length || needsReview} onClick={() => void fork()}>
            {busy ? 'Creating workspace…' : 'Create workspace from template'}
          </button>
          <small className="h-muted">{needsReview ? 'Complete the security review to create this workspace.' : missing.length ? `Connect ${missing.map((r) => r.name).join(' and ')} first.` : 'Copies the template into a new workspace of yours. Change anything later.'}</small>

        </footer>
      </aside>
      <section className="h-template-preview" aria-label={side === 'preview' ? 'Preview' : 'Code inspector'}>
        <div className="h-template-switch">
          <Tabs
            value={side}
            onChange={setSide}
            options={[
              { value: 'preview', label: 'Preview' },
              { value: 'code', label: 'Code' },
            ]}
          />
          <span className="h-muted h-template-hint">{side === 'preview' ? 'Try it out: it runs on sample data.' : 'Every file the template ships, read-only.'}</span>
        </div>
        {/* The demo stays loaded behind the code, so going back to it is instant. */}
        {item.preview ? (
          <div className="h-template-pane h-template-demo" hidden={side !== 'preview'}>
            <div className="h-demo-banner" role="note">
              <Eye size={14} aria-hidden="true" />
              <strong>Preview</strong>
              <span>Sample data, not connected to your accounts. Create a workspace to use your own.</span>
            </div>
            <Preview key={`${item.source}:${item.id}`} item={item} live onShortcut={onShortcut} />
          </div>
        ) : (
          side === 'preview' && <p className="h-muted h-template-none">This template has no preview. Create a workspace to see it on your own data, or read its code.</p>
        )}
        {side === 'code' && (
          <div className="h-template-pane">
            <Suspense fallback={<p className="h-muted h-template-none">Loading the code inspector…</p>}>
              <CodeInspector item={item} onShortcut={onShortcut} />
            </Suspense>
          </div>
        )}
      </section>
      {reviewing && (
        <ReviewDialog
          item={item}
          onClose={() => setReviewing(false)}
          onStart={(choice) => {
            setReviewing(false)
            onReview(choice)
          }}
        />
      )}
    </div>
  )
}

/** What a fork may call, by connector, as its manifest says: folded away until asked for, then each connector with its tools. */
function Reach({ item, state }: { item: MarketplaceItem; state: AppState }) {
  const [open, setOpen] = useState(false)
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set())
  const uses = Object.entries(item.uses ?? {})
  if (!uses.length) return null
  const need = (alias: string) => item.requires.find((r) => r.alias === alias)
  const native = (alias: string) => state.connectors.find((c) => c.id === alias && c.native)
  const count = (tools: '*' | string[]) => (tools === '*' ? 'Every tool' : `${tools.length} tool${tools.length === 1 ? '' : 's'}`)
  return (
    <div className="h-reach">
      <button className="h-reach-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} strokeWidth={2} className={open ? 'open' : ''} aria-hidden="true" />
        What it may call
        <span className="h-muted">
          {uses.length} connector{uses.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div className="h-reach-list">
          {uses.map(([alias, tools]) => {
            const r = need(alias)
            const shown = unfolded.has(alias)
            return (
              <div key={alias} className="h-reach-row">
                <button className="h-reach-conn" aria-expanded={tools === '*' ? undefined : shown} disabled={tools === '*'} onClick={() => setUnfolded((u) => (u.has(alias) ? new Set([...u].filter((x) => x !== alias)) : new Set([...u, alias])))}>
                  {native(alias) ? <Logo connector={native(alias)!} size={16} /> : r ? <Logo url={r.url} size={16} /> : <Logo builtIn size={16} />}
                  <strong>{r?.name ?? native(alias)?.name ?? alias}</strong>
                  <span className={`h-reach-count${tools === '*' ? ' all' : ''}`}>{count(tools)}</span>
                  {tools !== '*' && <ChevronDown size={13} strokeWidth={2} className={shown ? 'open' : ''} aria-hidden="true" />}
                </button>
                {shown && tools !== '*' && (
                  <div className="h-reach-tools">
                    {tools.map((t) => (
                      <code key={t}>{t}</code>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** One of your connectors, with its favicon: the app's own list, since a native select can't show images. */
function ConnectorSelect({ options, value, optional, label, onChange }: { options: ConnectorState[]; value?: string; optional: boolean; label: string; onChange: (id: string) => void }) {
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Fixed to the window, so the dialog's scrolling body can't clip it; opens upward near the bottom.
  const [at, setAt] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null)
  const items: (ConnectorState | null)[] = [...(optional ? [null] : []), ...options]
  const current = options.find((c) => c.id === value)
  const open = () => {
    const r = button.current!.getBoundingClientRect()
    const below = window.innerHeight - r.bottom > Math.min(items.length * 32 + 12, 272)
    setAt(below ? { left: r.left, width: r.width, top: r.bottom + 4 } : { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4 })
  }
  const close = () => (setAt(null), button.current?.focus())
  const pick = (id: string) => (onChange(id), close())
  const move = (e: React.KeyboardEvent) => {
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault(), all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    else if (e.key === 'Escape' || e.key === 'Tab') e.preventDefault(), e.stopPropagation(), close()
  }
  const row = (c: ConnectorState | null | undefined) =>
    c ? (
      <>
        <Logo connector={c} size={18} />
        <span className="h-csel-name">{c.id}</span>
        {c.status !== 'connected' && <span className="h-csel-status">{statusOf(c).label}</span>}
      </>
    ) : (
      <span className="h-csel-name muted">None</span>
    )
  return (
    <>
      <button ref={button} type="button" className="sb-input h-csel" aria-label={label} aria-haspopup="listbox" aria-expanded={!!at} onClick={() => (at ? close() : open())} onKeyDown={(e) => e.key === 'ArrowDown' && (e.preventDefault(), open())}>
        {row(current)}
        <ChevronDown size={14} className="h-csel-caret" aria-hidden="true" />
      </button>
      {at && (
        <>
          <div className="h-scrim h-csel-scrim" onMouseDown={close} />
          <div ref={list} className="h-menu h-csel-menu" role="listbox" aria-label={label} style={at} onKeyDown={move}>
            {items.map((c) => {
              const id = c?.id ?? ''
              const on = id === (value ?? '')
              return (
                <button key={id} type="button" role="option" aria-selected={on} autoFocus={on} onClick={() => pick(id)}>
                  {row(c)}
                  {on && <Check size={14} className="h-csel-check" aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

function BlankDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const create = async () => {
    try {
      const w = await app('workspace_create', { name: name.trim() })
      onClose()
      onOpen(w.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <Shell
      title="Blank workspace"
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="sb-btn" onClick={onClose}>Cancel</button>
          <button className="sb-btn primary" disabled={!name.trim()} onClick={() => void create()}>
            Create
          </button>
        </>
      }
    >
      <label className="sb-field">
        <span>Name</span>
        <input className="sb-input" autoFocus placeholder="e.g. Release desk" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
      </label>
      {error && <div className="sb-error">{error}</div>}
    </Shell>
  )
}

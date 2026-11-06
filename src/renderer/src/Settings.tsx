// Settings for the whole app: a large dialog over whatever the window shows, with a list of sections
// down the left and the one that is open beside it.
// Schedules, Tools and Connectors are pages of their own; the design system (markdown every agent
// reads before it writes or restyles a workspace) lives here, and so does the app's own theme, and
// what the background service does while Lynx is closed, and how much of their plans the agents have left.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Clock, Database, Gauge, Globe, History, Keyboard, Mic, Moon, Palette, RefreshCw, SwatchBook, X } from 'lucide-react'
import { Icon } from '@kit/icons'
import { Markdown, Tabs } from '@kit/ui'
import { AGENT_PLACES, DEFAULT_LAYOUT, MODES, THEMES, WORKSPACE_PLACES, type LayoutSettings, type ModeId, type ThemeId } from '@shared/themes'
import type { AppState } from '@shared/types'
import type { ProviderUsage, UsageReport } from '@shared/usage'
import { DEFAULT_PAUSE, VOICE_MODELS, VOICE_PAUSES, voiceModel, type VoiceModelId } from '@shared/voice'
import type { Toast } from './App'
import { app, bridge } from './api'
import { Toggle } from './Page'
import { MarketplaceAccountCard } from './Publish'
import { keys } from './CommandBar'
import { comboFor } from './keymap'
import { DEFAULT_EXECUTION, isExecutionLimit, MAX_EXECUTION } from '@shared/execution'

type ToastFn = (text: string, tone?: Toast['tone']) => void

const EXAMPLE = `# Design system

## Feel
Calm and dense. Information first; no decoration that does not carry meaning.

## Colour
- Accent: #3b5bdb, for the one primary action on a page and for links. Nothing else.
- Status: green only for success, red only for failure or destructive actions.
- Support light and dark: use the --sb-* variables for surfaces, text and borders.

## Type
- System font. Page titles 22px semibold, section titles 15px semibold, body 14px.
- Numbers in tables are right-aligned and use tabular figures.

## Layout
- 8px spacing grid. Cards have 12px radius and a 1px border, no shadow.
- Lists and tables over card grids when there are more than six items.

## Components
- One primary button per view; the rest are plain.
- Every list has a loading state, an empty state that says what to do next, and an error state with a retry.

## Words
- Sentence case everywhere. Buttons are verbs ("Start review"), never "OK" or "Submit".
`

export type Section = 'marketplace' | 'tools' | 'schedules' | 'runs' | 'store' | 'connectors' | 'design' | 'appearance' | 'background' | 'voice' | 'usage' | 'shortcuts'
export const SECTIONS: { id: Section; name: string; icon: ReactNode }[] = [
  { id: 'connectors', name: 'Connectors', icon: <Icon name="plug" size={17} /> },
  { id: 'appearance', name: 'Appearance', icon: <SwatchBook size={16} strokeWidth={1.6} /> },
  { id: 'shortcuts', name: 'Shortcuts', icon: <Keyboard size={16} strokeWidth={1.6} /> },
  { id: 'voice', name: 'Voice', icon: <Mic size={16} strokeWidth={1.6} /> },
  { id: 'usage', name: 'Usage', icon: <Gauge size={16} strokeWidth={1.6} /> },
  { id: 'marketplace', name: 'Marketplace', icon: <Globe size={17} /> },
  { id: 'schedules', name: 'Schedules', icon: <Clock size={16} strokeWidth={1.6} /> },
  { id: 'tools', name: 'Tools', icon: <Icon name="wrench" size={17} /> },
  { id: 'runs', name: 'Runs', icon: <History size={16} strokeWidth={1.6} /> },
  { id: 'store', name: 'Store', icon: <Database size={16} strokeWidth={1.6} /> },
  { id: 'background', name: 'Background', icon: <Moon size={16} strokeWidth={1.6} /> },
  { id: 'design', name: 'Design system', icon: <Palette size={16} strokeWidth={1.6} /> },
]

export function SettingsDialog({ state, section, onSection, onClose, children }: { state: AppState; section: Section; onSection: (s: Section) => void; /** Puts settings away; the window is as it was under them. */ onClose: () => void; /** The open section. */ children: ReactNode }) {
  const counts: Partial<Record<Section, number>> = { schedules: state.schedules.length, tools: state.tools.length, connectors: state.connectors.length }
  const engine = state.engine
  const close = useRef(onClose)
  close.current = onClose
  const dialog = useRef<HTMLDivElement>(null)
  // The keys come to them, not to the composer or the workspace behind, whichever way they were opened;
  // and go back there when they close, unless something else has taken them since.
  useEffect(() => {
    const node = dialog.current
    const was = document.activeElement as HTMLElement | null
    if (!node?.contains(was)) node?.focus({ preventScroll: true })
    return () => {
      const now = document.activeElement
      if (was?.isConnected && (!now || now === document.body || node?.contains(now))) was.focus({ preventScroll: true })
    }
  }, [])
  // Escape closes them, unless it is for one of their fields, or for something open over them (a dialog, the command bar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const field = (e.target as HTMLElement | null)?.closest?.('textarea, input, select')
      if (field && dialog.current?.contains(field)) return
      // The notifications, or a page's drawer (a tool, a run), close first, by themselves.
      if (document.querySelector('.sb-overlay, .h-cmd-scrim, .h-drawer, .h-pdrawer')) return
      close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="h-set-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="h-set" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
        <nav className="h-set-nav" aria-label="Settings">
          <div className="h-set-head">
            <h1 className="h-set-title">Settings</h1>
          </div>
          {SECTIONS.map((s) => (
            <button key={s.id} className={`h-item${s.id === section ? ' on' : ''}`} aria-current={s.id === section ? 'page' : undefined} onClick={() => onSection(s.id)}>
              <span className="h-icon">{s.icon}</span>
              <span className="h-name">{s.name}</span>
              {!!counts[s.id] && <span className="h-count">{counts[s.id]}</span>}
            </button>
          ))}
          {/* Only worth a line while the agents are not up. */}
          {engine.status !== 'ready' && (
            <div className="h-engine" title={engine.detail ?? engine.url}>
              <i className={`sb-dot ${engine.status === 'error' ? 'bad' : 'live'}`} />
              <span>{engine.status === 'error' ? 'Agents unavailable' : (engine.detail ?? 'Starting agents')}</span>
            </div>
          )}
        </nav>
        {children}
        {/* In the card's corner, over whichever section is open. */}
        <button className="sb-btn sm ghost h-set-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
          <X size={17} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  )
}

export function DesignSystemView({ state, toast }: { state: AppState; toast: ToastFn }) {
  const saved = state.settings.designSystem
  const [draft, setDraft] = useState(saved)
  // What the draft was last in step with: a change made elsewhere (an agent, the file) shows up
  // here unless the user has typed something of their own since.
  const [base, setBase] = useState(saved)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (saved === base) return
    if (draft === base) setDraft(saved)
    setBase(saved)
  }, [saved])
  const dirty = draft !== saved
  const save = async () => {
    setSaving(true)
    try {
      await app('design_system_set', { markdown: draft })
      setBase(draft)
      toast(draft.trim() ? 'Design system saved' : 'Design system removed', 'good')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="h-scroll">
      <div className="sb-page">
        <header className="sb-page-head">
          <div>
            <h1>Design system</h1>
            <p>What holds for every workspace.</p>
          </div>
        </header>
        <div className="sb-card">
          <div className="sb-card-head">
            <h2>Markdown</h2>
            <span className="h-muted">{saved ? `${saved.length.toLocaleString()} characters` : 'Not set'}</span>
          </div>
          <div className="h-settings">
            <p className="h-hint">How your workspaces should look, in your own words: colour, type, spacing, components, tone. Agents read it before they build or restyle a workspace, and follow it over the built-in defaults. Existing workspaces change when you next ask an agent to work on them.</p>
            <div className="sb-row" style={{ justifyContent: 'space-between' }}>
              <Tabs value={tab} onChange={setTab} options={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]} />
              {!draft.trim() && (
                <button className="sb-btn sm" onClick={() => (setDraft(EXAMPLE), setTab('write'))}>
                  Start from an example
                </button>
              )}
            </div>
            {tab === 'write' ? (
              <textarea
                className="sb-input h-design"
                value={draft}
                spellCheck={false}
                placeholder={'# Design system\n\nMarkdown. Say what the accent colour is, how dense pages should be, what buttons and empty states look like…'}
                aria-label="Design system, markdown"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    if (dirty && !saving) void save()
                  }
                }}
              />
            ) : draft.trim() ? (
              <div className="h-design-preview">
                <Markdown>{draft}</Markdown>
              </div>
            ) : (
              <div className="h-design-preview h-muted">Nothing to preview yet.</div>
            )}
            <div className="sb-row" style={{ justifyContent: 'flex-end' }}>
              {dirty && <span className="h-muted" style={{ marginRight: 'auto' }}>Unsaved changes</span>}
              <button className="sb-btn" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
                Revert
              </button>
              <button className="sb-btn primary" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Light or dark (or as the system is), then the app's theme: one tile per theme, each a small picture of the window wearing it. */
export function AppearanceView({ state, toast }: { state: AppState; toast: ToastFn }) {
  const saved = state.settings.theme
  // Shown as chosen at once; the app's own state follows a moment later.
  const [picked, setPicked] = useState<ThemeId | null>(null)
  const theme = picked ?? saved
  useEffect(() => setPicked(null), [saved])
  const pick = (id: ThemeId) => {
    if (id === theme) return
    setPicked(id)
    app('theme_set', { theme: id }).catch((e) => {
      setPicked(null)
      toast(e instanceof Error ? e.message : String(e), 'bad')
    })
  }
  const [pickedMode, setPickedMode] = useState<ModeId | null>(null)
  const mode = pickedMode ?? state.settings.mode
  useEffect(() => setPickedMode(null), [state.settings.mode])
  const pickMode = (id: ModeId) => {
    if (id === mode) return
    setPickedMode(id)
    app('mode_set', { mode: id }).catch((e) => {
      setPickedMode(null)
      toast(e instanceof Error ? e.message : String(e), 'bad')
    })
  }
  const savedLayout = state.settings.layout ?? DEFAULT_LAYOUT
  const [pickedLayout, setPickedLayout] = useState<Partial<LayoutSettings>>({})
  useEffect(() => setPickedLayout({}), [savedLayout.workspaces, savedLayout.agent])
  const layout = { ...savedLayout, ...pickedLayout }
  const place = (patch: Partial<LayoutSettings>) => {
    setPickedLayout((p) => ({ ...p, ...patch }))
    app('layout_set', patch).catch((e) => {
      setPickedLayout({})
      toast(e instanceof Error ? e.message : String(e), 'bad')
    })
  }
  return (
    <div className="h-scroll">
      <div className="sb-page">
        <header className="sb-page-head">
          <div>
            <h1>Appearance</h1>
            <p>How Lynx itself looks.</p>
          </div>
        </header>
        <div className="sb-card">
          <div className="sb-card-head">
            <h2>Light or dark</h2>
            <div className="h-modes" role="group" aria-label="Light or dark">
              {MODES.map((m) => (
                <button key={m.id} aria-pressed={m.id === mode} onClick={() => pickMode(m.id)}>
                  {m.name}
                </button>
              ))}
            </div>
          </div>
          <div className="h-settings">
            <p className="h-hint">For the whole window: Lynx's own pages and every workspace in it. System follows your computer's setting as it changes.</p>
          </div>
        </div>
        <div className="sb-card">
          <div className="sb-card-head">
            <h2>Theme</h2>
            <span className="h-muted">{THEMES.find((t) => t.id === theme)?.name}</span>
          </div>
          <div className="h-settings">
            <p className="h-hint">A theme colours what is Lynx's own: the window, Home, the agent, settings and menus. The workspaces you build keep their own look, so you can tell at a glance which is which. Light and dark follow the choice above.</p>
            <div className="h-themes" role="group" aria-label="Theme">
              {THEMES.map((t) => (
                <button key={t.id} className={`h-theme${t.id === theme ? ' on' : ''}`} aria-pressed={t.id === theme} onClick={() => pick(t.id)}>
                  {/* The window in small: its title bar, a workspace (never themed) and the agent panel beside it. */}
                  <span className="h-theme-view" data-sb-theme={t.id} aria-hidden>
                    <span className="h-theme-bar">
                      <i />
                      <i />
                      <i />
                      <b />
                    </span>
                    <span className="h-theme-body">
                      <span className="h-theme-ws">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="h-theme-agent">
                        <i />
                        <i />
                        <b />
                      </span>
                    </span>
                  </span>
                  <span className="h-theme-name">
                    {t.name}
                    {t.id === theme && <Check size={14} strokeWidth={2.2} />}
                  </span>
                  <span className="h-theme-about">{t.about}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="sb-card">
          <div className="sb-card-head">
            <h2>Layout</h2>
          </div>
          <div className="h-settings">
            <p className="h-hint">Where the list of workspaces goes, and where the agent opens.</p>
            <h3 className="h-layout-label">Workspaces</h3>
            <div className="h-themes h-layouts" role="group" aria-label="Workspaces">
              {WORKSPACE_PLACES.map((p) => (
                <button key={p.id} className={`h-theme${p.id === layout.workspaces ? ' on' : ''}`} aria-pressed={p.id === layout.workspaces} data-place={p.id} onClick={() => p.id !== layout.workspaces && place({ workspaces: p.id })}>
                  <LayoutPicture workspaces={p.id} agent={layout.agent} focus="workspaces" />
                  <span className="h-theme-name">
                    {p.name}
                    {p.id === layout.workspaces && <Check size={14} strokeWidth={2.2} />}
                  </span>
                  <span className="h-theme-about">{p.about}</span>
                </button>
              ))}
            </div>
            <h3 className="h-layout-label">Agent</h3>
            <div className="h-themes h-layouts" role="group" aria-label="Agent">
              {AGENT_PLACES.map((p) => (
                <button key={p.id} className={`h-theme${p.id === layout.agent ? ' on' : ''}`} aria-pressed={p.id === layout.agent} data-place={p.id} onClick={() => p.id !== layout.agent && place({ agent: p.id })}>
                  <LayoutPicture workspaces={layout.workspaces} agent={p.id} focus="agent" />
                  <span className="h-theme-name">
                    {p.name}
                    {p.id === layout.agent && <Check size={14} strokeWidth={2.2} />}
                  </span>
                  <span className="h-theme-about">{p.about}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A row in the picture: an icon and a label, `w` wide (a share of the row). */
const LpItem = ({ w, on, cls = '' }: { w: number; on?: boolean; cls?: string }) => (
  <span className={`h-lp-item${on ? ' on' : ''}${cls ? ` ${cls}` : ''}`}>
    <i className="ic" />
    <i className="tx" style={{ width: `${w}%` }} />
  </span>
)
/** A button in the picture: an outline with an icon and a label. */
const LpButton = ({ cls = '' }: { cls?: string }) => (
  <span className={`h-lp-btn${cls ? ` ${cls}` : ''}`}>
    <i className="ic" />
    <i className="tx" />
  </span>
)

/**
 * The window in small, laid out as a choice would have it, drawn after the real one: the title bar with
 * the workspace's name and its buttons; the workspaces as a sidebar (search, the list with the open one
 * picked, and running agents, notifications and settings at its foot) or as the list that drops from the
 * name; the agent as a panel beside the workspace, or floating over it above the bar along the bottom.
 * The workspace is the onboarding one, a header over a list. What the row of choices is about (`focus`)
 * is in the accent colour; the rest is grey.
 */
function LayoutPicture({ workspaces, agent, focus }: LayoutSettings & { focus: 'workspaces' | 'agent' }) {
  const ws = focus === 'workspaces' ? ' fx' : ''
  const ag = focus === 'agent' ? ' fx' : ''
  const chat = (
    <>
      <span className="h-lp-tabs">
        <i className="on" />
        <i />
      </span>
      <span className="h-lp-chat">
        <span className="h-lp-bubble">
          <i />
        </span>
        <i className="h-lp-text" style={{ width: '88%' }} />
        <i className="h-lp-text" style={{ width: '70%' }} />
        <i className="h-lp-text" style={{ width: '80%' }} />
      </span>
      <span className="h-lp-input">
        <i />
        <b />
      </span>
    </>
  )
  return (
    <span className={`h-lp ${workspaces} ${agent}`} aria-hidden>
      <span className="h-lp-bar">
        <span className={`h-lp-title${workspaces === 'top' ? ws : ''}`}>
          <i className="ic" />
          <i className="tx" />
          {workspaces === 'top' && <em />}
        </span>
        <span className="h-lp-acts">
          <LpButton />
          {agent === 'panel' && <LpButton cls={`agent${ag}`} />}
          {workspaces === 'top' && (
            <>
              <i className="h-lp-icon" />
              <i className="h-lp-icon" />
              <i className="h-lp-icon" />
            </>
          )}
        </span>
      </span>
      <span className="h-lp-body">
        {workspaces === 'side' && (
          <span className={`h-lp-side${ws}`}>
            <LpItem w={55} cls="search" />
            <i className="h-lp-label" />
            <LpItem w={70} on />
            <LpItem w={55} />
            <LpItem w={62} />
            <span className="h-lp-side-foot">
              <LpItem w={66} />
              <LpItem w={58} />
              <LpItem w={48} />
            </span>
          </span>
        )}
        <span className="h-lp-main">
          <span className="h-lp-row">
            <span className="h-lp-ws">
              <span className="h-lp-head">
                <i className="logo" />
                <span>
                  <i className="h1" />
                  <i className="sub" />
                </span>
              </span>
              <span className="h-lp-list">
                {[64, 52, 58].map((w, n) => (
                  <span key={n} className="h-lp-li">
                    <i className="num" />
                    <i className="tx" style={{ width: `${w}%` }} />
                    <i className="more" />
                  </span>
                ))}
              </span>
            </span>
            {agent === 'panel' && <span className={`h-lp-agent${ag}`}>{chat}</span>}
          </span>
          {agent === 'float' && (
            <>
              <span className={`h-lp-agent float${ag}`}>{chat}</span>
              <span className="h-lp-foot">
                <LpButton cls={`agent${ag}`} />
                <i className="h-lp-icon" />
              </span>
            </>
          )}
        </span>
      </span>
      {workspaces === 'top' && focus === 'workspaces' && (
        <span className="h-lp-menu fx">
          <LpItem w={70} on />
          <LpItem w={55} />
          <LpItem w={62} />
          <LpItem w={48} cls="new" />
        </span>
      )}
    </span>
  )
}

/** What runs while Lynx is closed: the background service, and the two choices about it. */
export function BackgroundView({ state, toast }: { state: AppState; toast: ToastFn }) {
  const saved = state.settings.background
  // Shown as chosen at once; the app's own state follows a moment later.
  const [picked, setPicked] = useState<Partial<typeof saved>>({})
  useEffect(() => setPicked({}), [saved.keepRunning, saved.startAtLogin])
  const current = { ...saved, ...picked }
  const set = (key: 'keepRunning' | 'startAtLogin', on: boolean) => {
    setPicked((p) => ({ ...p, [key]: on }))
    app('background_set', key === 'keepRunning' ? { keep_running: on } : { start_at_login: on }).catch((e) => {
      setPicked({})
      toast(e instanceof Error ? e.message : String(e), 'bad')
    })
  }
  const service = state.service
  const busy = service.busy ?? 0
  const status = !service.connected ? 'Reconnecting…' : service.mode === 'in-process' ? 'Running inside this window (LYNX_DAEMON=0)' : busy ? `Running · ${busy === 1 ? '1 agent or command' : `${busy} agents and commands`} at work` : 'Running · idle'
  return (
    <div className="h-scroll">
      <div className="sb-page">
        <header className="sb-page-head">
          <div>
            <h1>Background</h1>
            <p>What keeps running when Lynx is closed.</p>
          </div>
        </header>
        <div className="sb-card">
          <div className="sb-card-head">
            <h2>Background service</h2>
            <span className="h-muted h-bg-status">
              <i className={`sb-dot ${service.connected ? (busy ? 'live' : 'good') : 'warn'}`} />
              {status}
            </span>
          </div>
          <div className="h-settings">
            <p className="h-hint">Agents, schedules, tools and connectors run in a service of their own, apart from this window. Close or quit Lynx and they carry on; open it again and it picks up where they are.</p>
            <div className="h-bg-row">
              <div>
                <strong>Keep running after quitting</strong>
                <p className="h-hint">Off: quitting Lynx stops agents, as if you chose Quit and Stop Agents (⌥⌘Q) every time. Anything running is recorded as interrupted.</p>
              </div>
              <Toggle on={current.keepRunning} label="Keep running after quitting" onChange={(on) => set('keepRunning', on)} />
            </div>
            <div className="h-bg-row">
              <div>
                <strong>Start when I log in</strong>
                <p className="h-hint">Schedules run after a restart without you opening Lynx. The window still opens only when you open it.{bridge.platform !== 'darwin' && ' Only on macOS for now.'}</p>
              </div>
              <Toggle on={current.startAtLogin} label="Start when I log in" disabled={bridge.platform !== 'darwin'} onChange={(on) => set('startAtLogin', on)} />
            </div>
            {service.mode === 'daemon' && (
              <div className="sb-row h-bg-facts">
                <span className="h-muted">
                  {service.pid ? `Process ${service.pid}` : ''}
                  {service.startedAt ? ` · since ${new Date(service.startedAt).toLocaleString()}` : ''}
                  {service.stale ? ' · from an older build, replaced once nothing is running' : ''}
                </span>
                <span style={{ marginLeft: 'auto' }} />
                {service.logFile && (
                  <button className="sb-btn sm ghost" onClick={() => void bridge.openPath(service.logFile!)}>
                    Show log
                  </button>
                )}
                <button className="sb-btn sm" onClick={() => void bridge.quit({ stopAgents: true })} title="Quit and Stop Agents (⌥⌘Q)">
                  Quit and stop agents
                </button>
              </div>
            )}
          </div>
        </div>
        <ExecutionControls state={state} toast={toast} />
      </div>
    </div>
  )
}

export function MarketplaceSettings({ state }: { state: AppState }) {
  return <div className="h-scroll"><div className="sb-page">
    <header className="sb-page-head"><div><h1>Marketplace</h1><p>Manage the account you use to publish templates.</p></div></header>
    <div className="h-marketplace-settings">
      {state.remote.api && <p className="h-muted">Connected to {new URL(state.remote.api).host}</p>}
      {state.remote.account && <p>Signed in as <strong>{state.remote.account.email}</strong></p>}
      <MarketplaceAccountCard state={state} />
    </div>
  </div></div>
}

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

function ExecutionControls({ state, toast }: { state: AppState; toast: ToastFn }) {
  const saved = state.settings.execution ?? DEFAULT_EXECUTION
  const [base, setBase] = useState(saved)
  const [draft, setDraft] = useState({ agents: String(saved.agents), shell: String(saved.shell) })
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setDraft((current) => ({
      agents: current.agents === String(base.agents) ? String(saved.agents) : current.agents,
      shell: current.shell === String(base.shell) ? String(saved.shell) : current.shell,
    }))
    setBase(saved)
  }, [saved.agents, saved.shell])
  const limits = { agents: Number(draft.agents), shell: Number(draft.shell) }
  const valid = isExecutionLimit('agents', limits.agents) && isExecutionLimit('shell', limits.shell)
  const dirty = draft.agents !== String(base.agents) || draft.shell !== String(base.shell)
  const save = async () => {
    if (!valid || !dirty) return
    setSaving(true)
    try {
      await app('execution_set', limits)
      setBase(limits)
      setDraft({ agents: String(limits.agents), shell: String(limits.shell) })
      toast('Execution limits saved', 'good')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="sb-card h-execution">
      <div className="sb-card-head"><h2>Local execution limits</h2></div>
      <form className="h-settings" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <p className="h-hint">How much runs at once on this machine. Extra work waits in its queue. Higher limits use more memory and CPU.</p>
        {([
          { key: 'agents', name: 'Agent runs', about: 'Claude, Codex and other agent sessions working on tasks.' },
          { key: 'shell', name: 'Shell commands', about: 'Task setup, one-off commands and dev servers. Each running server holds one slot until it stops.' },
        ] as const).map(({ key, name, about }) => (
          <div className="h-bg-row" key={key}>
            <div>
              <label htmlFor={`execution-${key}`}><strong>{name}</strong></label>
              <p className="h-hint" id={`execution-${key}-hint`}>{about} Default {DEFAULT_EXECUTION[key]}; range 1–{MAX_EXECUTION[key]}.</p>
            </div>
            <input className="sb-input" id={`execution-${key}`} aria-describedby={`execution-${key}-hint`} type="number" min={1} max={MAX_EXECUTION[key]} step={1} required value={draft[key]} disabled={saving} onChange={(e) => setDraft((p) => ({ ...p, [key]: e.target.value }))} style={{ width: 88, flexShrink: 0 }} />
          </div>
        ))}
        <p className="h-hint">Applies immediately to new work. Lowering a limit lets running work finish. These settings apply to the local agents connector; cloud machines have their own limits.</p>
        <div className="sb-row" style={{ justifyContent: 'flex-end' }}>
          {dirty && <span className="h-muted" style={{ marginRight: 'auto' }}>Unsaved changes</span>}
          <button className="sb-btn primary" type="submit" disabled={!dirty || !valid || saving}>{saving ? 'Saving…' : 'Save limits'}</button>
        </div>
      </form>
    </div>
  )
}

/** Voice mode: on or off, and the speech model it runs on this computer, downloaded from here. */
export function VoiceSettingsView({ state, toast }: { state: AppState; toast: ToastFn }) {
  const v = state.voice
  const fail = (e: unknown) => toast(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), 'bad')
  // Picking one that is not here yet downloads it.
  const pick = (id: VoiceModelId) =>
    void bridge.voice
      .set({ model: id })
      .then(async (next) => {
        if (!next.installed.includes(id) && !next.download) await bridge.voice.install(id)
      })
      .catch(fail)
  const combo = comboFor('voice')
  const down = v.download
  return (
    <div className="h-scroll">
      <div className="sb-page">
        <header className="sb-page-head">
          <div>
            <h1>Voice</h1>
            <p>Talk to the agent. What you say is turned into text on this computer and never leaves it.</p>
          </div>
        </header>
        <div className="sb-card">
          <div className="h-settings">
            <div className="h-bg-row first">
              <div>
                <strong>Voice mode</strong>
                <p className="h-hint">Puts a microphone in the agent panel{combo ? ` (${keys(combo)})` : ''} to enable using voice to interact with Lynx agents.</p>
              </div>
              <Toggle on={v.enabled} label="Voice mode" onChange={(on) => void bridge.voice.set({ enabled: on }).catch(fail)} />
            </div>
            <div className="h-bg-row">
              <div>
                <strong>Send when I stop talking</strong>
                <p className="h-hint">{!!v.autoSend ? 'What you say goes to the agent once you pause. While the agent works it does not listen, and it listens again when the agent is done.' : 'What you say is written into the message box as you go, to read over and send with ↩ yourself.'}</p>
              </div>
              <Toggle on={!!v.autoSend} label="Send when I stop talking" onChange={(on) => void bridge.voice.set({ autoSend: on }).catch(fail)} />
            </div>
            {!!v.autoSend && (
              <div className="h-bg-row h-voice-pause">
                <div>
                  <strong>Pause before sending</strong>
                  <p className="h-hint">How long a quiet ends what you said. Longer gives room to think mid-sentence; shorter answers sooner.</p>
                </div>
                <Tabs value={String(v.pause ?? DEFAULT_PAUSE)} onChange={(p) => void bridge.voice.set({ pause: Number(p) }).catch(fail)} options={VOICE_PAUSES.map((p) => ({ value: String(p), label: `${p} s` }))} />
              </div>
            )}
            <div className="h-bg-row">
              <div>
                <strong>Read replies aloud</strong>
                <p className="h-hint">Determines whether the agent responses should be said out loud using the system voice, at its speed: pick it, Siri voices included, in System Settings › Accessibility › Spoken Content.</p>
              </div>
              <Toggle on={v.speak} label="Read replies aloud" onChange={(on) => void bridge.voice.set({ speak: on }).catch(fail)} />
            </div>
            <div className="h-bg-row">
              <div>
                <strong>Listen again when I'm away</strong>
                <p className="h-hint">{v.listenAway ? 'When the agent is done, it listens again even if Lynx is not in front or the agent panel is hidden.' : 'When the agent is done and Lynx is not in front, or the agent panel is hidden, voice mode turns off instead of listening again.'}</p>
              </div>
              <Toggle on={!!v.listenAway} label="Listen again when I'm away" onChange={(on) => void bridge.voice.set({ listenAway: on }).catch(fail)} />
            </div>
          </div>
        </div>
        <div className="sb-card">
          <div className="sb-card-head">
            <h2>Speech model</h2>
            <span className="h-muted">Runs on this computer</span>
          </div>
          <div className="h-settings">
            <div className="h-voice-models" role="radiogroup" aria-label="Speech model">
              {VOICE_MODELS.map((m) => {
                const installed = v.installed.includes(m.id)
                const loading = down?.model === m.id ? down : undefined
                const picked = v.model === m.id
                return (
                  <div key={m.id} className={`h-voice-model${picked ? ' on' : ''}`}>
                    <button className="h-voice-pick" role="radio" aria-checked={picked} onClick={() => pick(m.id)}>
                      <span className="h-voice-radio" aria-hidden>{picked && <Check size={12} strokeWidth={2.4} />}</span>
                      <span className="h-voice-about">
                        <span className="h-voice-name">
                          <strong>{m.tier}</strong>
                          <span>{m.name}</span>
                          {m.id === 'parakeet' && <span className="sb-badge">Recommended</span>}
                        </span>
                        <span className="h-hint">{m.about}</span>
                        <span className="h-voice-facts">
                          {size(m.download)} download · {size(m.disk)} on disk · about {size(m.memory)} of memory while on · {m.languages}
                        </span>
                      </span>
                    </button>
                    <span className="h-voice-state">
                      {loading ? (
                        <>
                          <span className="h-voice-progress" title={loading.phase === 'unpacking' ? 'Unpacking' : `${size(loading.received)} of ${size(loading.total)}`}>
                            <i style={{ width: `${loading.phase === 'unpacking' ? 100 : Math.round((loading.received / Math.max(1, loading.total)) * 100)}%` }} />
                          </span>
                          <small>{loading.phase === 'unpacking' ? 'Unpacking…' : `${Math.round((loading.received / Math.max(1, loading.total)) * 100)}%`}</small>
                          {loading.phase === 'downloading' && (
                            <button className="sb-btn sm ghost" onClick={() => void bridge.voice.cancel().catch(fail)}>
                              Cancel
                            </button>
                          )}
                        </>
                      ) : installed ? (
                        <>
                          <small className="h-voice-ok">
                            <Check size={13} strokeWidth={2.2} />
                            Downloaded
                          </small>
                          <button className="sb-btn sm ghost" onClick={() => confirm(`Remove ${m.name} (${size(m.disk)}) from this computer?`) && void bridge.voice.remove(m.id).catch(fail)}>
                            Remove
                          </button>
                        </>
                      ) : (
                        <button className="sb-btn sm" disabled={!!down} title={down ? `${voiceModel(down.model).name} is downloading` : undefined} onClick={() => void bridge.voice.install(m.id).catch(fail)}>
                          Download
                        </button>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
            {v.error && <p className="h-voice-error">{v.error}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

/** "in 3 h 20 min", "in 2 days 4 h", "Tue 14:00" further off. */
function resetsIn(at: number, now: number) {
  const mins = Math.max(0, Math.round((at - now) / 60000))
  if (mins < 1) return 'Resets in a moment'
  if (mins < 60) return `Resets in ${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Resets in ${hours} h${mins % 60 ? ` ${mins % 60} min` : ''}`
  const days = Math.floor(hours / 24)
  if (days < 7) return `Resets in ${days} ${days === 1 ? 'day' : 'days'}${hours % 24 ? ` ${hours % 24} h` : ''}`
  return `Resets ${new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

/** Settings › Usage: how much of their plan Claude Code and Codex have left, window by window (src/main/usage.ts). */
export function UsageView() {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = (fresh = false) => {
    setLoading(true)
    setError(null)
    bridge
      .usage(fresh)
      .then(setReport, (e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => load(), [])
  // The times to reset count down while the page is open.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="h-scroll">
      <div className="sb-page">
        <header className="sb-page-head">
          <div>
            <h1>Usage</h1>
            <p>How much of your plan Claude Code and Codex have left, as each one counts it.</p>
          </div>
          <button className="sb-btn sm" onClick={() => load(true)} disabled={loading}>
            <RefreshCw size={14} strokeWidth={1.8} className={loading ? 'h-spin' : undefined} />
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </header>
        {error ? (
          <div className="sb-card">
            <div className="h-settings">
              <p className="h-voice-error">{error}</p>
            </div>
          </div>
        ) : !report ? (
          <div className="sb-card">
            <div className="h-settings">
              <p className="h-hint">Asking Claude Code and Codex…</p>
            </div>
          </div>
        ) : (
          <>
            {report.providers.map((p) => (
              <ProviderUsageCard key={p.id} usage={p} now={now} />
            ))}
            <p className="h-hint h-usage-at">Checked {new Date(report.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. Each is asked with its own sign-in on this computer; asking uses none of your limits.</p>
          </>
        )}
      </div>
    </div>
  )
}

/** Plans whose own names do not read well capitalised. */
const PLAN_NAMES: Record<string, string> = { prolite: 'Pro Lite', chatgpt: 'ChatGPT' }

function ProviderUsageCard({ usage, now }: { usage: ProviderUsage; now: number }) {
  const plan = usage.plan ? (PLAN_NAMES[usage.plan.toLowerCase()] ?? usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1)) : null
  return (
    <div className="sb-card h-usage" data-provider={usage.id}>
      <div className="sb-card-head">
        <h2>{usage.name}</h2>
        {plan && <span className="sb-badge">{plan} plan</span>}
      </div>
      <div className="h-settings">
        {usage.status === 'ok' && usage.windows.length ? (
          usage.windows.map((w, i) => {
            const left = Math.round(100 - w.used)
            const tone = w.used >= 90 ? 'bad' : w.used >= 70 ? 'warn' : 'ok'
            return (
              <div key={w.name} className={`h-bg-row h-usage-row${i === 0 ? ' first' : ''}`}>
                <div className="h-usage-about">
                  <strong>{w.name}</strong>
                  <p className="h-hint">{w.resetsAt ? resetsIn(w.resetsAt, now) : `${Math.round(w.used)}% used`}</p>
                </div>
                <div className="h-usage-meter">
                  <span className={`h-usage-left ${tone}`}>{left}% left</span>
                  <span className={`h-usage-bar ${tone}`} role="meter" aria-label={`${usage.name} ${w.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}>
                    <i style={{ width: `${left}%` }} />
                  </span>
                </div>
              </div>
            )
          })
        ) : (
          <p className="h-hint">{usage.status === 'ok' ? 'No limits are counting right now.' : usage.detail}</p>
        )}
        {usage.extra && <p className="h-hint h-usage-extra">{usage.extra}</p>}
      </div>
    </div>
  )
}

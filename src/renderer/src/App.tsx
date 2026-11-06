// The host window: a title bar, the running workspace in its own frame under it, and the agent
// panel beside it. Everything else (the list of workspaces, settings) opens from the title bar; settings open
// over whatever the window shows, so closing them puts it back as it was. Appearance can move the list of
// workspaces (with the agents running, notifications and settings) to a sidebar, and float the agent over
// the workspace from a thin bar along the bottom instead of a panel beside it.
// Two workspaces can share the window for a while, side by side, each in a pane with its own header.
// The host stays up whatever the workspace code does.
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Archive, ArrowLeftRight, Bell, ChevronsUpDown, CircleArrowUp, Clock, Coffee, Columns2, Database, Gauge, Globe, History, Keyboard, Maximize2, Mic, Minimize2, PanelLeft, Pencil, Rows2, Search, Settings as Gear, SwatchBook } from 'lucide-react'
import { emitAppChange } from '@kit/core'
import { Guard } from '@kit/guard'
import type { Pointed } from '@kit/annotate'
import { Icon } from '@kit/icons'
import type { AppEvent, AppNotification, AppState, MarketplaceItem, WorkspaceInfo } from '@shared/types'
import { DEFAULT_LAYOUT } from '@shared/themes'
import { hoursLabel, parseHours } from '@shared/caffeinate'
import { AgentPanel, type AgentPanelHandle } from './AgentPanel'
import { QueueRunner, useAnyQueued } from './agentQueue'
import { app, bridge, onKitPost } from './api'
import { onboardingSession, useOnboardingConnections } from './onboarding'
import { CreatedToasts, type Created } from './CreatedToast'
import { FirstRun, firstRunDone } from './FirstRun'
import { ArchivedView } from './Archived'
import { CommandBar, Keys, titled, type Command } from './CommandBar'
import { comboOf, sameCombo, type Combo } from '@kit/keys'
import { comboFor, useShortcuts } from './keymap'
import { ConnectorDialog, ConnectorsView, connectorIcon, type ConnectorPreset } from './Connectors'
import type { InspectorHandle } from './CodeInspector'
import { FindInPage, type FindHandle } from './Find'
import { Frame, forgetRoutes, type FrameHandle } from './Frame'
import { HistoryDialog } from './History'
import { MarketplaceView, TemplateView } from './Marketplace'
import { hasUpdateSource, ownedPublication } from '@shared/templates'
import { reviewOf, type ReviewChoice } from './SecurityReview'
import { Count, NotificationsDrawer, unreadBy } from './Notifications'
import { RunningAgents } from './Running'
import { RunsView } from './Runs'
import { SchedulesView } from './Schedules'
import { StoreView } from './Store'
import { AppearanceView, BackgroundView, DesignSystemView, MarketplaceSettings, SECTIONS, SettingsDialog, UsageView, VoiceSettingsView, type Section } from './Settings'
import { usePointMentions } from './pointMentions'
import { Sidebar } from './Sidebar'
import { Switcher, under, WORKSPACE_DRAG } from './Switcher'
import { ShortcutsView } from './Shortcuts'
import { ToolsView } from './Tools'
import { UndoToast, type UndoOffer } from './Undo'
import { UpdateButton } from './Update'
import { voice, useVoice } from './Voice'
import { IconPicker, WorkspaceIcon } from './WorkspaceIcon'

/** Something the user pointed at in a workspace, waiting to go to the agent with their next message. */
export type Note = Pointed & { page: string; /** The workspace it is in. */ workspace: string }
type View = { kind: 'workspace'; id: string } | { kind: 'marketplace' } | { kind: 'template'; source: MarketplaceItem['source']; id: string } | { kind: 'archived' }
/** Settings while they are open, over the view: the section, and something to open straight away in it (a tool, or a schedule's id). */
type Prefs = { section: Section; focus?: string }
/** Two workspaces on screen at once. It is what the window shows until a workspace is opened on its own: other pages and restarts come back to it. */
interface Split {
  /** Left and right, or top and bottom. */
  panes: [string, string]
  /** The pane the agent, Point and the shortcuts act on. */
  focus: 0 | 1
  /** The first pane's share of the room. */
  ratio: number
  stacked: boolean
}
/** A workspace into a pane: one already on screen just gets the focus. */
const place = (s: Split, id: string, at: 0 | 1): Split => {
  const i = s.panes.indexOf(id)
  if (i >= 0) return { ...s, focus: i as 0 | 1 }
  const panes: [string, string] = [...s.panes]
  panes[at] = id
  return { ...s, panes, focus: at }
}
/** A workspace into this pane even when it is in the other one: then the two change places. */
const put = (s: Split, id: string, at: 0 | 1): Split => (s.panes[1 - at] === id ? { ...s, panes: [s.panes[1], s.panes[0]], focus: at } : place(s, id, at))
/** Under this width two panes go one above the other. */
const NARROW = 900
const clampRatio = (r: number) => Math.min(0.8, Math.max(0.2, r))
const SPLIT = 'sb.split'
const savedSplit = (): Split | null => {
  try {
    const s = JSON.parse(localStorage.getItem(SPLIT) ?? 'null')
    return Array.isArray(s?.panes) && s.panes.length === 2 && s.panes.every((x: unknown) => typeof x === 'string') ? { panes: s.panes, focus: s.focus === 1 ? 1 : 0, ratio: clampRatio(Number(s.ratio) || 0.5), stacked: !!s.stacked } : null
  } catch {
    return null
  }
}

export interface Toast {
  id: number
  tone: 'info' | 'good' | 'bad'
  text: string
}

/** The keys a frame handed over: a combo, or the key and ⇧ ⌥ that workspaces built with an older kit send. */
/** The commands workspace code may run through the kit (togglePoint, toggleAgent, showConnectors, showTemplates, showSchedules, openCommandBar). */
const KIT_COMMANDS = new Set(['point', 'agent', 'connectors', 'new', 'schedules', 'command-bar'])
/** Set once the agent has opened on its own beside the onboarding checklist, so it does so only the first time. */
const GREETED = 'sb.onboarding.greeted'
/** A time of day to come, as the clock shows it: "5:30 PM", with the day when it is not today ("Fri 5:30 PM"). */
const clock = (at: number) => new Date(at).toLocaleString([], { ...(new Date(at).toDateString() === new Date().toDateString() ? {} : { weekday: 'short' }), hour: 'numeric', minute: '2-digit' })
const pressed = (p: Record<string, any>): Combo => (p.combo && typeof p.combo.key === 'string' ? p.combo : { key: String(p.key), ...(p.shift ? { shift: true } : {}), ...(p.option ? { option: true } : {}) })

export function App() {
  // A shortcut's keys changed in settings: the commands and their hints follow.
  useShortcuts()
  const [state, setState] = useState<AppState | null>(null)
  const [view, setView] = useState<View>(() => {
    const last = localStorage.getItem('sb.view')
    return { kind: 'workspace', id: last ?? '' }
  })
  const [agentOpen, setAgentOpen] = useState(() => localStorage.getItem('sb.agent.open') === '1')
  const [agentFull, setAgentFull] = useState(() => localStorage.getItem('sb.agent.full') === '1')
  // The sidebar, when Appearance has one, collapsed out of the way (⌘B, or the button by the window's buttons).
  const [sideHidden, setSideHidden] = useState(() => localStorage.getItem('sb.side.hidden') === '1')
  const toggleSide = () =>
    setSideHidden((h) => {
      localStorage.setItem('sb.side.hidden', h ? '0' : '1')
      return !h
    })
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  // What can be taken back from the corner toast: the workspace just archived. A newer one takes its place.
  const [undo, setUndo] = useState<UndoOffer | null>(null)
  // Workspaces agents just made, each offering to go there until it times out or is closed.
  const [created, setCreated] = useState<Created[]>([])
  // A new install starts on the first-run screen (FirstRun.tsx), until it is finished or skipped.
  const [firstRunOpen, setFirstRunOpen] = useState(() => !firstRunDone())
  const firstRunRef = useRef(false)
  const [dialog, setDialog] = useState<ConnectorPreset | null>(null)
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const panel = useRef<AgentPanelHandle>(null)
  const finder = useRef<FindHandle>(null)
  const [annotating, setAnnotating] = useState(false)
  // Point's "Trigger agent right away" is ticked in the note box, inside the workspace's frame, so workspace code
  // could post the same thing. A note sends itself only when Point was turned on by the user (not by a workspace,
  // through the kit or a forwarded shortcut) and the window has just had a real press or key. Anything else only
  // joins the list, for the user to send.
  const pointMine = useRef(false)
  // What handlePost is running for, while it runs: a workspace's command, or keys a frame says were pressed in it.
  const posting = useRef<null | 'kit' | 'keys'>(null)
  const togglePoint = () => {
    pointMine.current = posting.current === null || (posting.current === 'keys' && navigator.userActivation.isActive)
    setAnnotating((a) => !a)
  }
  const pointSendsNow = () => annotating && pointMine.current && navigator.userActivation.isActive
  const sendPoint = () => {
    showAgent(true)
    // The panel mounts on the next frame when it was closed, and the note just added is in its list by then.
    setTimeout(() => panel.current?.sendPoint(), 30)
  }
  // The command bar, and whether it opened on the workspaces that can go beside this one.
  const [bar, setBar] = useState<false | 'all' | 'beside'>(false)
  // When the Mac's caffeinate run ends (ms), or null when none is going: looked at again each time the bar opens.
  const [awakeUntil, setAwakeUntil] = useState<number | null>(null)
  useEffect(() => {
    if (bar !== false) void bridge.caffeinateStatus().then(setAwakeUntil, () => {})
  }, [bar])
  const [split, setSplit] = useState<Split | null>(savedSplit)
  // The keyboard is in the agent panel (its message field, or anything else in it).
  const [agentFocus, setAgentFocus] = useState(false)
  // The titles of the agent panel's tabs, for ⌘1–9.
  const [agentTabs, setAgentTabs] = useState<string[]>([])
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW)
  // A workspace being dragged out of the list of workspaces, and the half of the window it is over.
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<0 | 1 | null>(null)
  // Dragging the line between the panes.
  const [sizing, setSizing] = useState(false)
  const splitBox = useRef<HTMLDivElement>(null)
  // The notifications drawer: closed, open on everything, or open on one workspace.
  const [drawer, setDrawer] = useState<{ only?: string } | null>(null)
  // The list of workspaces, and where on screen it hangs: under whichever button opened it. Opened from a pane, it picks for that pane.
  const [switcher, setSwitcher] = useState<{ top: number; left: number; pane?: 0 | 1 } | null>(null)
  const toggleSwitcher = (from: HTMLElement, pane?: 0 | 1) => setSwitcher((s) => (s ? null : { ...under(from), pane }))
  // The workspace whose name is being edited in the title bar.
  const [renaming, setRenaming] = useState<string | null>(null)
  // Each workspace on screen has its frame; these reach them.
  const frames = useRef(new Map<string, { current: FrameHandle | null }>())
  const frameOf = (id: string) => {
    let f = frames.current.get(id)
    if (!f) frames.current.set(id, (f = { current: null }))
    return f
  }
  // Workspaces showing their own code in their place (Inspect code), and each one's editor: Find and Back go
  // there instead of to the hidden workspace.
  const [inspecting, setInspecting] = useState<Record<string, boolean>>({})
  const inspect = (id: string, on: boolean) => setInspecting((s) => (!!s[id] === on ? s : { ...s, [id]: on }))
  const inspectors = useRef(new Map<string, { current: InspectorHandle | null }>())
  const inspectorOf = (id: string) => {
    let f = inspectors.current.get(id)
    if (!f) inspectors.current.set(id, (f = { current: null }))
    return f
  }
  // The commands as of the latest render; shortcuts and the command bar both read this.
  const commands = useRef<Command[]>([])
  const shortcut = (combo: Combo) => {
    // The first-run screen stands over everything: the app's keys wait for it.
    if (firstRunRef.current) return false
    const bar = comboFor('command-bar')
    if (bar && sameCombo(combo, bar)) return setBar((b) => (b ? false : 'all')), true
    const c = commands.current.find((c) => c.combo && sameCombo(c.combo, combo))
    c?.run()
    return !!c
  }
  const talking = useVoice().phase !== 'off'
  const [notes, setNotes] = useState<Record<string, Note[]>>({})
  const setNotesFor = useCallback((id: string, f: (n: Note[]) => Note[]) => setNotes((all) => ({ ...all, [id]: f(all[id] ?? []) })), [])

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, tone, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 3500)
  }, [])
  // Messages queued for the agent go when their conversation is done, whether the panel is open or not.
  const queued = useAnyQueued()
  const queueError = useCallback((text: string) => toast(text, 'bad'), [toast])
  /** Opens a workspace on its own, in place of whatever the window shows, two side by side included. */
  const open = useCallback((id: string) => {
    localStorage.setItem('sb.view', id)
    setView({ kind: 'workspace', id })
    setSplit(null)
    setAnnotating(false)
    setPrefs(null)
  }, [])
  /** Puts the focus on the pane a workspace is in. */
  const focusOn = useCallback((id: string) => {
    setAgentFocus(false)
    setSplit((s) => {
      const i = s?.panes.indexOf(id) ?? -1
      return s && i >= 0 && i !== s.focus ? { ...s, focus: i as 0 | 1 } : s
    })
    localStorage.setItem('sb.view', id)
    setView((v) => (v.kind === 'workspace' && v.id === id ? v : { kind: 'workspace', id }))
  }, [])
  /** Shows a workspace: in its pane when it is one of two on screen, otherwise on its own. */
  const reveal = useCallback((id: string) => {
    if (split?.panes.includes(id)) focusOn(id)
    else open(id)
  }, [split, focusOn, open])
  const showSplit = (next: Split | null, id: string) => {
    setSplit(next)
    localStorage.setItem('sb.view', id)
    setView({ kind: 'workspace', id })
  }
  const showAgent = useCallback((on: boolean) => {
    localStorage.setItem('sb.agent.open', on ? '1' : '0')
    setAgentOpen(on)
    // Closed while it filled the window, the agent comes back beside the workspace.
    if (!on) {
      localStorage.setItem('sb.agent.full', '0')
      setAgentFull(false)
    }
  }, [])
  /** The agent fills the window, the workspaces staying loaded behind it, or goes back beside them. */
  const fillWithAgent = useCallback((on: boolean) => {
    localStorage.setItem('sb.agent.full', on ? '1' : '0')
    setAgentFull(on)
    if (on) showAgent(true)
  }, [showAgent])
  /** A security review of a template, in a new tab of the agent panel beside its page. */
  const review = (item: MarketplaceItem, choice: ReviewChoice, kitDoc?: string) => {
    showAgent(true)
    // The agent is told every file there is: in read-only mode it may have no way to list a folder.
    void app<{ files: { path: string; size: number }[] }>('marketplace_files', { item: item.id, source: item.source })
      .then(({ files }) => {
        // The panel mounts on a later frame when it was closed.
        const start = (tries = 0): unknown => (panel.current ? panel.current.review(reviewOf(item, choice, files, kitDoc)) : tries < 50 && setTimeout(() => start(tries + 1), 30))
        start()
      })
      .catch((e) => toast(`The review did not start: ${e instanceof Error ? e.message : String(e)}`, 'bad'))
  }
  /** Publishing starts with an agent; account setup and approval stay in its conversation. */
  const openPublish = (w: WorkspaceInfo, template?: string) => {
    showAgent(true)
    const start = (tries = 0): unknown => panel.current ? panel.current.publish(w, template ?? (state ? ownedPublication(w, state)?.id : undefined)) : tries < 50 && setTimeout(() => start(tries + 1), 30)
    start()
  }
  const saveTemplate = (w: WorkspaceInfo) => app('marketplace_publish', { workspace: w.id }).then(() => toast('Saved to your templates', 'good'))
  const askAgent = useCallback(
    (prompt: string) => {
      showAgent(true)
      // The panel mounts on the next frame when it was closed.
      setTimeout(() => panel.current?.compose(prompt), 30)
    },
    [showAgent],
  )

  // What agents ask of the window through the app connector: workspace_open, window_get, window_layout, ui_*. Set each render, below.
  const agentAsks = useRef<{ open: (e: Extract<AppEvent, { t: 'open-workspace' }>) => void; request: (op: string, args: Record<string, any>) => Promise<unknown> }>({ open: (e) => open(e.workspace), request: async () => ({}) })
  // Questions put to a workspace's page (find, highlight), waiting for its ui-result.
  const pageAsks = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>())
  useEffect(() => {
    void bridge.state().then(setState)
    return bridge.onEvent((e: AppEvent) => {
      if (e.t === 'state') {
        setState(e.state)
        // Only workspaces' builds changed: a workspace's own frame reloads for its build, and the others
        // must not refetch everything (and flash) for one they do not show.
        if (!e.quiet) emitAppChange()
      } else if (e.t === 'connector-data-changed') emitAppChange({ connector: e.connector, errorsOnly: e.errorsOnly })
      else if (e.t === 'open-workspace') agentAsks.current.open(e)
      else if (e.t === 'window-request') void agentAsks.current.request(e.op, e.args).then(
          (data) => app('window_reply', { id: e.id, ok: true, data }),
          (err) => app('window_reply', { id: e.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
        ).catch(() => undefined)
      else if (e.t === 'toast') toast(e.text, e.tone)
      else if (e.t === 'workspace-created') setCreated((c) => [...c.filter((x) => x.workspace !== e.workspace), { workspace: e.workspace, name: e.name }])
      else if (e.t === 'open-connector-dialog') setDialog(e.preset)
      else if (e.t === 'close-pane') closeFocused.current()
      else if (e.t === 'shortcut') {
        const combo = comboOf(e.press)
        if (combo) shortcut(combo)
      }
    })
  }, [open, toast])

  // A workspace that is gone takes the page it was on with it.
  const workspaceIds = state?.workspaces.map((w) => w.id).join('\n')
  useEffect(() => {
    if (workspaceIds !== undefined) forgetRoutes(workspaceIds.split('\n'))
  }, [workspaceIds])

  // Messages the kit posts when it runs inside the host (the agent panel).
  useEffect(() => {
    onKitPost((type, p) => handlePost(type, p))
  }, [])
  /** A message from the agent panel's kit, or from a workspace's frame (`from`, its id). */
  const handlePost = (type: string, p: Record<string, any>, from?: string) => {
    if (type === 'ask-agent') askAgent(String(p.prompt ?? ''))
    else if (type === 'open-workspace') {
      const id = String(p.workspace)
      if (p.path) localStorage.setItem(`sb.route.${id}`, String(p.path))
      // A link from one pane to another workspace opens it in the other pane, leaving the one it was clicked in.
      const i = split && from ? split.panes.indexOf(from) : -1
      if (split && i >= 0 && id !== from) {
        if (split.panes.includes(id) && p.path) frameOf(id).current?.send('navigate', { to: String(p.path) })
        showSplit(put(split, id, (1 - i) as 0 | 1), id)
      } else reveal(id)
    }
    else if (type === 'ui-result') {
      const w = pageAsks.current.get(String(p.req))
      pageAsks.current.delete(String(p.req))
      if (p.ok) w?.resolve(p.data)
      else w?.reject(new Error(String(p.error)))
    }
    // A press or the keyboard inside a workspace's frame: with two side by side, that pane has the focus.
    else if (type === 'pointer') from && focusOn(from)
    // Back, pressed inside a workspace, is for that workspace whichever pane has the focus.
    else if (type === 'shortcut' && from && comboFor('back') && sameCombo(pressed(p), comboFor('back')!)) back(from)
    else if (type === 'open-external') void bridge.openExternal(String(p.url))
    else if (type === 'toast') toast(String(p.text), p.tone)
    else if (type === 'connector-dialog') setDialog(p.preset ?? {})
    else if (type === 'shortcut') {
      posting.current = 'keys'
      try {
        shortcut(pressed(p))
      } finally {
        posting.current = null
      }
    }
    // A command by its id, from the kit (togglePoint, showTemplates, …): the same whatever keys it has.
    // Only those the kit offers: workspace code must not publish, fork, archive or delete on its own.
    else if (type === 'command' && p.id === 'command-bar') setBar('all')
    else if (type === 'command' && KIT_COMMANDS.has(String(p.id))) {
      posting.current = 'kit'
      try {
        commands.current.find((c) => c.id === p.id)?.run()
      } finally {
        posting.current = null
      }
    }
  }
  // Back leaves the code for the workspace before it goes back a page in the workspace.
  const back = (id: string) => (inspecting[id] ? inspect(id, false) : frameOf(id).current?.send('back'))
  const agentOpenRef = useRef(agentOpen)
  agentOpenRef.current = agentOpen

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = comboOf(e)
      if (combo) {
        if (shortcut(combo)) e.preventDefault()
      } else if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('textarea, input, select')) setAnnotating(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showAgent])

  // The app's theme is on the page itself; workspaces are other pages and do not see it.
  const theme = state?.settings.theme
  useEffect(() => {
    if (!theme) return
    document.documentElement.dataset.sbTheme = theme
    localStorage.setItem('sb.theme', theme)
  }, [theme])

  // Focus anywhere in the host says whether it is in the agent; a frame taking it says so itself ('pointer').
  useEffect(() => {
    const onIn = (e: FocusEvent) => setAgentFocus(!!(e.target as HTMLElement | null)?.closest?.('.h-agent'))
    document.addEventListener('focusin', onIn)
    return () => document.removeEventListener('focusin', onIn)
  }, [])
  useEffect(() => {
    if (split) localStorage.setItem(SPLIT, JSON.stringify(split))
    else localStorage.removeItem(SPLIT)
  }, [split])
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // ⌘W closes the agent's tab while the keyboard is in it, or else the focused pane while there are two; the app lets the window close otherwise.
  const closeFocused = useRef(() => {})
  // Not while the agent fills the window: the panes are behind it.
  const splitShown = !!split && view.kind === 'workspace' && !(agentOpen && agentFull)
  const closesHere = splitShown || (agentOpen && agentFocus)
  const closeKeys = closesHere ? (comboFor('close') ?? null) : null
  useEffect(() => bridge.setCloseHere(closeKeys), [closeKeys && JSON.stringify(closeKeys)])
  // A pane whose workspace was archived or deleted closes, and the other has the window.
  useEffect(() => {
    if (!split || !state) return
    const live = split.panes.filter((id) => state.workspaces.some((w) => w.id === id && !w.archived))
    if (live.length === 2) return
    setSplit(null)
    if (live[0]) open(live[0])
  }, [split, state, open])
  // A click inside a pane's frame does not reach the host. The frame says so itself ('pointer'); for one built
  // with an older kit, the window losing focus to the frame is the sign, though not when focus goes frame to frame.
  const splitOn = !!split
  useEffect(() => {
    if (!splitOn) return
    const onBlur = () =>
      setTimeout(() => {
        const id = document.activeElement?.closest?.('[data-pane]')?.getAttribute('data-pane')
        if (id) focusOn(id)
      })
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [splitOn, focusOn])

  // The first time the onboarding checklist is on screen, the agent opens beside it with its greeting.
  // Only on a new install: one with the onboarding checklist. Installs from before never see it.
  const firstRun = firstRunOpen && !!state?.workspaces.some((w) => w.onboarding)
  firstRunRef.current = firstRun
  const onboardingShown = !firstRun && !!state && view.kind === 'workspace' && !!(state.workspaces.find((w) => w.id === view.id) ?? state.workspaces.find((w) => !w.archived))?.onboarding
  useEffect(() => {
    if (!onboardingShown || localStorage.getItem(GREETED)) return
    localStorage.setItem(GREETED, '1')
    showAgent(true)
  }, [onboardingShown, showAgent])

  // A connection made outside the onboarding conversation (the checklist's buttons, settings) still sets it going.
  useOnboardingConnections(state, async (text) => {
    // On the first-run screen, what is connected is seen to at its end (templates, then a word in the panel).
    if (firstRunRef.current) return true
    showAgent(true)
    // The panel mounts on a later frame when it was closed.
    for (let tries = 0; !panel.current && tries < 50; tries++) await new Promise((r) => setTimeout(r, 30))
    return panel.current ? panel.current.onboard(text) : false
  })

  if (!state) return <div className="h-boot">Starting…</div>
  // Where the list of workspaces and the agent sit (Appearance). A service from before there was a choice sends none.
  const layout = state.settings.layout ?? DEFAULT_LAYOUT
  const sided = layout.workspaces === 'side'
  const floating = layout.agent === 'float'

  const current = view.kind === 'workspace' ? state.workspaces.find((w) => w.id === view.id) : undefined
  // A remembered workspace that no longer exists falls back to the first one.
  const active = state.workspaces.filter((w) => !w.archived)
  const archived = state.workspaces.filter((w) => w.archived)
  // A failed upload stays up, with why, to try again.
  // A template that is gone (an item of yours deleted) falls back to the marketplace.
  const template = view.kind === 'template' ? state.marketplace.find((i) => i.id === view.id && i.source === view.source) : undefined
  const shown: View = view.kind === 'workspace' && !current ? (active[0] ? { kind: 'workspace', id: active[0].id } : { kind: 'marketplace' }) : view.kind === 'template' && !template ? { kind: 'marketplace' } : view
  const ws = shown.kind === 'workspace' ? state.workspaces.find((w) => w.id === shown.id) : undefined
  // The two workspaces of a split, left to right (or top to bottom), once both are there to show.
  const pair = split && ws ? split.panes.map((id) => active.find((w) => w.id === id)) : []
  const panes = pair[0] && pair[1] ? ([pair[0], pair[1]] as const) : null
  const onScreen = panes ? panes.map((w) => w.id) : ws ? [ws.id] : []
  const stacked = !!split && (split.stacked || narrow)
  // The agent takes what was pointed at in every workspace on screen, numbered as one list.
  const screenNotes = onScreen.flatMap((id) => notes[id] ?? [])
  const setScreenNotes = (f: (n: Note[]) => Note[]) =>
    setNotes((all) => {
      const next = f(onScreen.flatMap((id) => all[id] ?? []))
      return { ...all, ...Object.fromEntries(onScreen.map((id) => [id, next.filter((n) => n.workspace === id)])) }
    })

  // Other pages leave the split as it is, to come back to.
  const go = (v: View) => {
    setView(v)
    setAnnotating(false)
    setPrefs(null)
  }
  /** Opens a workspace beside the one on screen: on the right unless `at` says the left (0). Split already, it takes the other pane, or the one `at` names. */
  const beside = (id: string, at?: 0 | 1) => {
    if (!ws) return open(id)
    if (split) return showSplit(at === undefined ? place(split, id, (1 - split.focus) as 0 | 1) : put(split, id, at), id)
    if (id === ws.id) return
    showSplit({ panes: at === 0 ? [id, ws.id] : [ws.id, id], focus: at ?? 1, ratio: 0.5, stacked: false }, id)
    setAnnotating(false)
  }
  /** Closes a pane; the other workspace has the window to itself. */
  const closePane = (i: 0 | 1) => {
    if (!split) return
    setSplit(null)
    open(split.panes[1 - i]!)
  }
  /** ⌘⌥← and ⌘⌥→: the keyboard goes round what is on screen, left to right: the panes, then the agent when it is open. */
  const cycle = (step: 1 | -1) => {
    const panes = split && view.kind === 'workspace' ? split.panes : ws ? [ws.id] : []
    const stops = [...panes, ...(agentOpen ? ['agent'] : [])]
    if (stops.length < 2) return
    const at = document.activeElement?.closest?.('.h-agent') ? 'agent' : split ? split.panes[split.focus] : ws?.id
    const next = stops[(stops.indexOf(at ?? '') + step + stops.length) % stops.length]!
    if (next === 'agent') return void (document.querySelector('.h-agent textarea') as HTMLElement | null)?.focus()
    focusOn(next)
    // A workspace showing its code has the keyboard in the code: its frame is hidden.
    if (inspecting[next]) return void inspectorOf(next).current?.focus()
    ;(document.querySelector(split ? `[data-pane="${next}"] .h-frame` : '.h-frame') as HTMLElement | null)?.focus()
  }
  closeFocused.current = () => (agentOpen && agentFocus ? panel.current?.closeTab() : split && !(agentOpen && agentFull) && closePane(split.focus))
  const swap = () => split && setSplit({ ...split, panes: [split.panes[1], split.panes[0]], focus: (1 - split.focus) as 0 | 1, ratio: 1 - split.ratio })
  const stack = (on: boolean) => split && setSplit({ ...split, stacked: on })
  /**
   * Asks a workspace's page to find or highlight something, and waits for what it says. A page just
   * opened, or reloading as it moves into a pane, is not listening yet: the question goes again until
   * it answers (finding, highlighting and clearing come out the same done twice).
   */
  const askPage = (id: string, type: string, args: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const req = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const ask = () => frameOf(id).current?.send(type, { ...args, req })
      const again = setInterval(ask, 600)
      const timer = setTimeout(() => {
        pageAsks.current.delete(req)
        clearInterval(again)
        reject(new Error('The workspace page did not answer. It may still be loading, or have been built by an older Lynx: it answers once it is built again.'))
      }, 8000)
      const end = () => (clearTimeout(timer), clearInterval(again))
      pageAsks.current.set(req, { resolve: (v) => (end(), resolve(v)), reject: (e) => (end(), reject(e)) })
      ask()
    })
  const focused = split && panes ? split.panes[split.focus] : ws?.id
  const nameOf = (id: string) => state.workspaces.find((w) => w.id === id)?.name ?? id
  agentAsks.current = {
    open: (e) => {
      if (e.path) {
        localStorage.setItem(`sb.route.${e.workspace}`, e.path)
        if (onScreen.includes(e.workspace)) frameOf(e.workspace).current?.send('navigate', { to: e.path })
      }
      // Asked for, a workspace is to be looked at: the agent goes back beside it.
      if (filling) fillWithAgent(false)
      if (e.beside === undefined) reveal(e.workspace)
      else beside(e.workspace, e.beside)
    },
    request: async (op, args) => {
      const target = typeof args.workspace === 'string' && args.workspace ? args.workspace : focused
      if (op === 'screen') {
        const side = (i: number) => (stacked ? (i ? 'bottom' : 'top') : i ? 'right' : 'left')
        return {
          page: shown.kind === 'workspace' ? 'workspace' : shown.kind,
          layout: panes ? (stacked ? 'stacked' : 'side_by_side') : 'single',
          workspaces: onScreen.map((id, i) => ({ id, name: nameOf(id), page: localStorage.getItem(`sb.route.${id}`) ?? '/', ...(panes ? { pane: side(i), focused: id === focused } : {}) })),
          agent_panel: agentOpen ? (filling ? 'fills the window' : 'beside') : 'closed',
          others: active.filter((w) => !onScreen.includes(w.id)).map((w) => ({ id: w.id, name: w.name })),
        }
      }
      if (!target) throw new Error('No workspace is on screen. Open one with workspace_open.')
      if (!onScreen.includes(target)) throw new Error(`"${nameOf(target)}" is not on screen. Open it with workspace_open first.`)
      if (op === 'layout') {
        const i = split && panes ? split.panes.indexOf(target) : -1
        if (args.action === 'focus') return focusOn(target), { focused: target }
        if (i < 0) throw new Error('Only one workspace is on screen. To show two, open another with workspace_open and beside.')
        if (args.action === 'alone') closePane((1 - i) as 0 | 1)
        else if (args.action === 'close') closePane(i as 0 | 1)
        else if (args.action === 'swap') swap()
        else if (args.action === 'stack') stack(true)
        else if (args.action === 'side_by_side') stack(false)
        else throw new Error(`No layout action named ${JSON.stringify(args.action)}`)
        return { done: args.action }
      }
      if (op === 'find' || op === 'highlight' || op === 'clear') {
        // What is highlighted must be seen: not behind the agent filling the window.
        if (op === 'highlight' && filling) fillWithAgent(false)
        const { workspace: _, ...rest } = args
        return { workspace: target, ...(await askPage(target, `ui-${op}`, rest) as object) }
      }
      throw new Error(`The window cannot do ${op}`)
    },
  }
  /** The short texts the workspaces on screen show, for voice mode to listen for. A page that does not answer at once is left out. */
  const screenWords = () =>
    Promise.all(
      onScreen.map(
        (id) =>
          new Promise<string[]>((resolve) => {
            const req = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
            const timer = setTimeout(() => (pageAsks.current.delete(req), resolve([])), 400)
            pageAsks.current.set(req, { resolve: (v) => (clearTimeout(timer), resolve(Array.isArray((v as { words?: unknown })?.words) ? (v as { words: string[] }).words : [])), reject: () => (clearTimeout(timer), resolve([])) })
            frameOf(id).current?.send('ui-words', { req })
          }),
      ),
    ).then((all) => all.flat())
  /** Takes away whatever an agent highlighted in the workspaces on screen. */
  const clearHighlights = () => onScreen.forEach((id) => frameOf(id).current?.send('ui-clear', {}))
  // Settings open on the section that was open last.
  const settings = (section?: Section, focus?: string) => {
    const last = localStorage.getItem('sb.settings')
    const to = section ?? SECTIONS.find((s) => s.id === last)?.id ?? SECTIONS[0]!.id
    localStorage.setItem('sb.settings', to)
    setPrefs({ section: to, focus })
    setAnnotating(false)
  }
  const act = (f: () => Promise<unknown>) => void f().catch((e) => toast(e instanceof Error ? e.message : String(e), 'bad'))
  const checkUpdate = () =>
    act(async () => {
      const u = await bridge.checkUpdate()
      if (u.latest) toast(`Lynx ${u.latest.version} is available: Update is in the title bar`, 'good')
      else toast(u.error ? `Couldn’t check for updates: ${u.error}` : `Lynx ${u.current} is the newest version`, u.error ? 'bad' : 'info')
    })
  const rename = (w: WorkspaceInfo, name: string) => {
    setRenaming(null)
    if (name.trim() && name.trim() !== w.name) act(() => app('workspace_update', { workspace: w.id, name: name.trim() }))
  }
  const archive = (w: WorkspaceInfo, on: boolean) =>
    act(async () => {
      await app('workspace_update', { workspace: w.id, archived: on })
      if (!on) return open(w.id)
      const shownHere = !!split?.panes.includes(w.id) || ws?.id === w.id
      // Undo brings it back, and to the screen if it was on it.
      setUndo({ id: Date.now() + Math.random(), text: `Workspace “${w.name}” archived.`, undo: () => act(() => app('workspace_update', { workspace: w.id, archived: false }).then(() => shownHere && open(w.id))) })
      // In a pane, its pane closes.
      if (split?.panes.includes(w.id)) return closePane(split.panes.indexOf(w.id) as 0 | 1)
      // Putting away the one on screen moves on to the one after it in the list.
      if (ws?.id === w.id) {
        const next = active[active.indexOf(w) + 1] ?? active.filter((x) => x.id !== w.id).at(-1)
        if (next) open(next.id)
        else go({ kind: 'marketplace' })
      }
    })
  const remove = (w: WorkspaceInfo) => {
    if (confirm(`Delete “${w.name}” and its folder?`)) act(() => app('workspace_delete', { workspace: w.id }).then(() => (split?.panes.includes(w.id) ? closePane(split.panes.indexOf(w.id) as 0 | 1) : ws?.id === w.id ? go({ kind: 'marketplace' }) : undefined)))
  }
  // Archived workspaces keep their places behind the rest.
  const reorder = (ids: string[]) => {
    // Shown in the new order at once; the app's own state follows a moment later.
    setState({ ...state, workspaces: [...ids.map((id) => active.find((w) => w.id === id)!), ...archived] })
    act(() => app('workspace_reorder', { order: ids }))
  }
  const unread = unreadBy(state)
  const unreadAll = Object.values(unread).reduce((a, b) => a + b, 0)
  // A notification leads to the page it is about; one without a link, to its workspace.
  const follow = (n: AppNotification) => {
    setDrawer(null)
    setPrefs(null)
    if (n.link && /^https?:/i.test(n.link)) return void bridge.openExternal(n.link)
    if (!state.workspaces.some((w) => w.id === n.workspace)) return toast('That workspace no longer exists', 'bad')
    if (n.link) {
      localStorage.setItem(`sb.route.${n.workspace}`, n.link)
      // Already on screen: its frame is told to go there. Otherwise it opens at the saved address.
      if (onScreen.includes(n.workspace)) frameOf(n.workspace).current?.send('navigate', { to: n.link })
    }
    reveal(n.workspace)
  }
  // The keyboard is in the agent panel.
  const inAgent = agentOpen && agentFocus
  const filling = agentOpen && agentFull
  // A workspace picked here is one to look at: the agent stops filling the window and goes back beside it.
  const besideAgent = (show: () => void) => () => {
    if (filling) fillWithAgent(false)
    show()
  }
  commands.current = [
    ...active.map((w, i): Command => ({ id: `ws:${w.id}`, group: 'Go to', title: w.name, icon: <WorkspaceIcon icon={w.icon} color={w.color} />, combo: i < 9 ? comboFor(`workspace-${i + 1}`) : undefined, run: besideAgent(() => open(w.id)) })),
    // Every workspace not on screen can open beside what is.
    ...(ws ? active.filter((w) => !onScreen.includes(w.id)).map((w): Command => ({ id: `beside:${w.id}`, group: 'Open beside', title: w.name, icon: <WorkspaceIcon icon={w.icon} color={w.color} />, run: besideAgent(() => beside(w.id, 1)), alt: besideAgent(() => beside(w.id, 0)) })) : []),
    { id: 'new', group: 'Go to', title: 'New workspace (marketplace)', icon: <Icon name="plus" size={18} />, combo: comboFor('new'), run: () => go({ kind: 'marketplace' }) },
    { id: 'archived', group: 'Go to', title: 'Archived workspaces', icon: <Archive size={16} strokeWidth={1.6} />, run: () => go({ kind: 'archived' }) },
    { id: 'connectors', group: 'Go to', title: 'Connectors', icon: <Icon name="plug" size={18} />, combo: comboFor('connectors'), run: () => settings('connectors') },
    { id: 'appearance', group: 'Go to', title: 'Appearance and themes', icon: <SwatchBook size={16} strokeWidth={1.6} />, run: () => settings('appearance') },
    { id: 'design', group: 'Go to', title: 'Design system', run: () => settings('design') },
    { id: 'voice-settings', group: 'Go to', title: 'Voice mode settings', keywords: 'speech microphone talk', icon: <Mic size={16} strokeWidth={1.6} />, run: () => settings('voice') },
    { id: 'usage', group: 'Go to', title: 'Usage limits', keywords: 'claude codex plan rate limit remaining quota', icon: <Gauge size={16} strokeWidth={1.6} />, run: () => settings('usage') },
    { id: 'tools', group: 'Go to', title: 'Tools', icon: <Icon name="wrench" size={18} />, combo: comboFor('tools'), run: () => settings('tools') },
    { id: 'schedules', group: 'Go to', title: 'Schedules', icon: <Clock size={16} strokeWidth={1.6} />, run: () => settings('schedules') },
    { id: 'runs', group: 'Go to', title: 'Runs of custom tools', icon: <History size={16} strokeWidth={1.6} />, run: () => settings('runs') },
    { id: 'shortcuts', group: 'Go to', title: 'Keyboard shortcuts', keywords: 'keys', icon: <Keyboard size={16} strokeWidth={1.6} />, run: () => settings('shortcuts') },
    { id: 'store', group: 'Go to', title: 'Store', icon: <Database size={16} strokeWidth={1.6} />, run: () => settings('store') },
    { id: 'notifications', group: 'Go to', title: unreadAll ? `Notifications (${unreadAll} unread)` : 'Notifications', icon: <Bell size={16} strokeWidth={1.6} />, run: () => setDrawer({}) },
    ...(sided ? ([{ id: 'sidebar', group: 'App', title: sideHidden ? 'Show the sidebar' : 'Hide the sidebar', icon: <PanelLeft size={16} strokeWidth={1.6} />, combo: comboFor('sidebar'), run: toggleSide }] satisfies Command[]) : []),
    { id: 'settings', group: 'Go to', title: 'Settings', icon: <Gear size={16} strokeWidth={1.6} />, combo: comboFor('settings'), run: () => (prefs ? setPrefs(null) : settings()) },
    ...(state.update.configured ? ([{ id: 'update', group: 'App', title: state.update.latest ? `Update to Lynx ${state.update.latest.version}` : 'Check for updates', icon: <CircleArrowUp size={16} strokeWidth={1.6} />, run: checkUpdate }] satisfies Command[]) : []),
    // The agent is there on every page; pointing and the rest need a workspace.
    { id: 'agent', group: 'Agent', title: agentOpen ? 'Close the agent' : 'Open the agent', icon: <Icon name="spark" size={18} />, combo: comboFor('agent'), run: () => showAgent(!agentOpenRef.current) },
          {
            id: 'agent-new',
            group: 'Agent',
            title: 'New agent conversation',
            icon: <Icon name="compose" size={18} />,
            combo: comboFor('agent-new'),
            run: () => {
              showAgent(true)
              setTimeout(() => panel.current?.newThread(), 30)
            },
          },
          // Voice mode, once it is turned on in settings. It talks to the agent panel, so the panel opens.
          ...(state.voice?.enabled || talking
            ? ([
                {
                  id: 'voice',
                  group: 'Agent',
                  title: talking ? 'Turn voice mode off' : 'Voice mode: talk to the agent',
                  keywords: 'speak microphone talk dictate',
                  combo: comboFor('voice'),
                  run: () => {
                    if (talking) return voice.stop()
                    showAgent(true)
                    setTimeout(() => void voice.start(), 60)
                  },
                },
              ] satisfies Command[])
            : []),
          { id: 'agent-full', group: 'Agent', title: filling ? 'Put the agent back beside the workspace' : 'Agent full screen', icon: filling ? <Minimize2 size={16} strokeWidth={1.6} /> : <Maximize2 size={16} strokeWidth={1.6} />, combo: comboFor('agent-full'), run: () => fillWithAgent(!(agentOpenRef.current && agentFull)) },
          // ⌘1–8 are the agent's tabs by place, and ⌘9 the last, as in a browser; ⌃Tab and ⌃⇧Tab go round them.
          ...(agentOpen
            ? [
                ...agentTabs.slice(0, 9).map((_, i): Command => {
                  const at = i === 8 ? agentTabs.length - 1 : i
                  return { id: `agent-tab:${i}`, group: 'Agent', title: `Agent tab: ${agentTabs[at]}`, icon: <Icon name="spark" size={18} />, combo: comboFor(`agent-tab-${i + 1}`), run: () => panel.current?.showTab(at) }
                }),
                ...(agentTabs.length > 1
                  ? ([
                      { id: 'agent-tab-next', group: 'Agent', title: 'Next agent tab', combo: comboFor('agent-tab-next'), run: () => panel.current?.cycleTab(1) },
                      { id: 'agent-tab-prev', group: 'Agent', title: 'Previous agent tab', combo: comboFor('agent-tab-prev'), run: () => panel.current?.cycleTab(-1) },
                    ] satisfies Command[])
                  : []),
              ]
            : []),
    ...(ws
      ? ([
          { id: 'point', group: 'Agent', title: annotating ? 'Stop pointing' : 'Point at things for the agent', icon: <Icon name="pointer" size={18} />, combo: comboFor('point'), run: togglePoint },
          ...((split || agentOpen) && !filling
            ? ([
                { id: 'focus-prev', group: 'This workspace', title: agentOpen ? 'Focus the previous pane or the agent' : 'Focus the previous pane', combo: comboFor('focus-prev'), run: () => cycle(-1) },
                { id: 'focus-next', group: 'This workspace', title: agentOpen ? 'Focus the next pane or the agent' : 'Focus the next pane', combo: comboFor('focus-next'), run: () => cycle(1) },
              ] satisfies Command[])
            : []),
          ...(filling
            ? []
            : ([
                { id: 'find', group: 'This workspace', title: 'Find in the workspace', keywords: 'search text page', icon: <Search size={16} strokeWidth={1.6} />, combo: comboFor('find'), run: () => (inspecting[ws.id] ? inspectorOf(ws.id).current?.find() : finder.current?.open()) },
                { id: 'find-next', group: 'This workspace', title: 'Find the next match', combo: comboFor('find-next'), run: () => (inspecting[ws.id] ? inspectorOf(ws.id).current?.step(true) : finder.current?.step(true)) },
                { id: 'find-prev', group: 'This workspace', title: 'Find the previous match', combo: comboFor('find-prev'), run: () => (inspecting[ws.id] ? inspectorOf(ws.id).current?.step(false) : finder.current?.step(false)) },
              ] satisfies Command[])),
          { id: 'back', group: 'This workspace', title: 'Back', icon: <Icon name="arrow-left" size={18} />, combo: comboFor('back'), run: () => back(ws.id) },
          { id: 'beside', group: 'This workspace', title: 'Open a new workspace to the side', keywords: 'beside split', icon: <Columns2 size={16} strokeWidth={1.6} />, combo: comboFor('beside'), run: () => setBar('beside') },
          ...(split
            ? ([
                { id: 'pane-swap', group: 'This workspace', title: 'Swap the panes', icon: <ArrowLeftRight size={16} strokeWidth={1.6} />, run: swap },
                { id: 'pane-stack', group: 'This workspace', title: split.stacked ? 'Put the panes side by side' : 'Stack the panes top and bottom', icon: split.stacked ? <Columns2 size={16} strokeWidth={1.6} /> : <Rows2 size={16} strokeWidth={1.6} />, run: () => stack(!split.stacked) },
                { id: 'pane-alone', group: 'This workspace', title: 'Show only this workspace', run: () => closePane((1 - split.focus) as 0 | 1) },
              ] satisfies Command[])
            : []),
          { id: 'folder', group: 'This workspace', title: 'Open its folder', run: () => act(() => bridge.openPath(ws.dir)) },
          { id: 'fork', group: 'This workspace', title: 'Duplicate workspace', icon: <Icon name="copy" size={18} />, run: () => act(async () => open((await app('workspace_fork', { workspace: ws.id })).id)) },
          { id: 'publish', group: 'This workspace', title: ownedPublication(ws, state) ? 'Update marketplace template' : 'Publish it to the marketplace', icon: <Globe size={16} strokeWidth={1.6} />, run: () => openPublish(ws) },
          { id: 'save-template', group: 'This workspace', title: 'Save it to my templates', run: () => act(() => saveTemplate(ws)) },
          // Home stays: it has no delete.
          ...(ws.home ? [] : ([{ id: 'delete', group: 'This workspace', title: 'Delete it', icon: <Icon name="x" size={18} />, run: () => remove(ws) }] satisfies Command[])),
          { id: 'rename', group: 'This workspace', title: 'Rename it', icon: <Pencil size={16} strokeWidth={1.6} />, run: () => setRenaming(ws.id) },
          { id: 'archive', group: 'This workspace', title: ws.archived ? 'Bring it back from the archive' : 'Archive it', icon: <Icon name="archive" size={18} />, run: () => archive(ws, !ws.archived) },
        ] satisfies Command[])
      : []),
    // The agent's tab while the keyboard is in it, or else the focused pane of two.
    ...((split && ws && !filling) || inAgent ? ([{ id: 'close', group: 'This workspace', title: inAgent ? 'Close this agent tab' : 'Close this pane', icon: <Icon name="x" size={18} />, combo: comboFor('close'), run: () => closeFocused.current() }] satisfies Command[]) : []),
    { id: 'add-connector', group: 'App', title: 'Add a connector', icon: <Icon name="plug" size={18} />, run: () => setDialog({}) },
    // macOS's caffeinate, for the hours typed in the bar; a new run takes the place of one going.
    {
      id: 'caffeinate',
      group: 'App',
      title: awakeUntil ? `Caffeinate (awake until ${clock(awakeUntil)})` : 'Caffeinate',
      keywords: 'awake sleep keep hours',
      icon: <Coffee size={16} strokeWidth={1.6} />,
      run: () => {},
      ask: {
        placeholder: 'Keep the Mac awake for how many hours?',
        answer: (text) => {
          const hours = parseHours(text)
          if (hours === null) return text.trim() ? 'Type a number of hours, up to 168 (a week)' : 'Type a number of hours, such as 2 or 1.5'
          return {
            title: `Keep the Mac awake for ${hoursLabel(hours)}, until ${clock(Date.now() + hours * 3600000)}`,
            run: () =>
              act(async () => {
                const until = await bridge.caffeinate(hours)
                setAwakeUntil(until)
                toast(`Caffeinated: the Mac stays awake until ${clock(until)}`, 'good')
              }),
          }
        },
      },
    },
    ...(awakeUntil
      ? ([
          {
            id: 'caffeinate-stop',
            group: 'App',
            title: 'Stop caffeinate',
            keywords: 'awake sleep decaffeinate',
            icon: <Coffee size={16} strokeWidth={1.6} />,
            run: () =>
              act(async () => {
                setAwakeUntil(await bridge.caffeinate(null))
                toast('The Mac may sleep again', 'info')
              }),
          },
        ] satisfies Command[])
      : []),
  ]
  // The bell counts everything unread, and lists every notification.
  const bell = () => setDrawer(drawer ? null : {})
  /** A conversation from the agents running, in a tab of the agent panel (opened if it was closed). */
  const showConversation = (id: string, conversation?: string) => {
    showAgent(true)
    const go = (tries = 0): unknown => (panel.current ? panel.current.open(id, conversation) : tries < 50 && setTimeout(() => go(tries + 1), 30))
    go()
  }
  // The end of the title bar that every page has: the agents running, notifications and settings.
  const tools = (
    <>
      <RunningAgents state={state} onScreen={onScreen} onOpen={reveal} onConversation={(s) => showConversation(s.id, s.labels.conversation)} toast={toast} />
      <button className="sb-btn sm ghost h-bell" onClick={bell} aria-label={unreadAll ? `Notifications, ${unreadAll} unread` : 'Notifications'} title="Notifications">
        <Bell size={17} strokeWidth={1.7} />
        <Count n={unreadAll} />
      </button>
      <button className={`sb-btn sm ghost h-gear${prefs ? ' on' : ''}`} onClick={() => (prefs ? setPrefs(null) : settings())} aria-label="Settings" title={titled('Settings', comboFor('settings'))}>
        <Gear size={17} strokeWidth={1.7} />
      </button>
    </>
  )

  // An update when there is one, then Point and the agent, at the end of the title bar. With two workspaces, Point is on in both. A page that is not a workspace has nothing to point at.
  const agentTools = (point: boolean) => (
    <>
      <UpdateButton update={state.update} busy={state.service.busy ?? 0} onError={(e) => toast(e instanceof Error ? e.message : String(e), 'bad')} />
      <button className={`sb-btn sm${point && annotating ? ' primary' : ' outline'}`} disabled={!point} onClick={togglePoint} title={point ? titled('Point at things for the agent', comboFor('point')) : 'Point works in a workspace'} aria-pressed={point && annotating}>
        <Icon name="pointer" size={15} />
        {point && annotating ? 'Done' : 'Point'}
        <Keys combo={comboFor('point')} />
      </button>
      {/* Floating, the agent opens from the bar along the bottom. */}
      {!floating && (
        <button className={`sb-btn sm${agentOpen ? ' primary' : ''}`} onClick={() => showAgent(!agentOpen)} title={titled(`${agentOpen ? 'Close' : 'Open'} the agent`, comboFor('agent'))}>
          Agent
          <Keys combo={comboFor('agent')} />
        </button>
      )}
      {/* With a sidebar, these are at its foot. */}
      {!sided && tools}
    </>
  )
  const wsTools = agentTools(true)
  // One panel for the window. Beside two workspaces it stays put as the focus moves between them.
  // Where the keyboard is, as a tinted header. With two workspaces: whichever pane or the agent has it, the
  // others' names grey. With one, only the agent is marked, while the keyboard is in it.
  const here = inAgent ? 'agent' : split ? split.panes[split.focus] : ws?.id
  const toneOf = (id: string): Tone | undefined => (id === 'agent' && filling ? undefined : panes ? (id === here ? 'lit' : 'dim') : id === 'agent' && inAgent ? 'lit' : undefined)
  // Floating, the panel stays up while it is closed: its tabs are in the bar along the bottom of the window.
  const side =
    agentOpen || floating ? (
      <Guard key={panes ? 'split' : (ws?.id ?? shown.kind)} name="the agent" fallback={(error, retry) => (
        <aside className="h-agent">
          <Failed what="the agent" error={error} retry={retry}>
            <button className="sb-btn" onClick={() => showAgent(false)}>
              Close the agent
            </button>
          </Failed>
        </aside>
      )}>
        <AgentPanel ref={panel} tone={toneOf('agent')} onTabs={setAgentTabs} ws={ws} onScreen={onScreen} state={state} onBusy={(b) => ws && setBusy((prev) => (prev[ws.id] === b ? prev : { ...prev, [ws.id]: b }))} notes={screenNotes} setNotes={setScreenNotes} annotating={annotating} onSent={() => setAnnotating(false)} onClose={() => showAgent(false)} toast={toast} full={filling} onFull={fillWithAgent} clearHighlights={clearHighlights} screenWords={screenWords} floating={floating} shown={agentOpen} onShow={() => showAgent(true)} />
      </Guard>
    ) : null
  const viewProps = (w: WorkspaceInfo) => ({
    frame: frameOf(w.id),
    ws: w,
    state,
    switching: !!switcher,
    renaming: renaming === w.id,
    onRenaming: (on: boolean) => setRenaming(on ? w.id : null),
    onRename: (name: string) => rename(w, name),
    onAnnotate: setAnnotating,
    pointSendsNow,
    sendPoint,
    notes: notes[w.id] ?? [],
    noteIds: screenNotes.map((n) => n.id),
    setNotes: (f: (n: Note[]) => Note[]) => setNotesFor(w.id, f),
    showAgent: () => showAgent(true),
    onPost: (type: string, m: Record<string, any>) => handlePost(type, m, w.id),
    askAgent,
    toast,
    onOpen: open,
    onPublish: () => openPublish(w),
    onShortcut: shortcut,
    inspecting: !!inspecting[w.id],
    onInspect: (on: boolean) => inspect(w.id, on),
    inspector: inspectorOf(w.id),
    // With the keyboard in the agent panel, the agent's changes go on screen as they are published.
    mayHold: !inAgent,
  })
  // Where a workspace dragged out of the list can go: either half of the window, or in place of either pane.
  const dropTo = (i: 0 | 1, id: string) => {
    setDragging(null)
    setDropAt(null)
    setSwitcher(null)
    if (id) beside(id, i)
  }
  const dropZones =
    dragging && ws && (split || dragging !== ws.id) ? (
      <div className={`h-drop${stacked ? ' stacked' : ''}`}>
        {([0, 1] as const).map((i) => (
          <div
            key={i}
            className={`h-drop-zone${dropAt === i ? ' on' : ''}`}
            data-side={i}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(WORKSPACE_DRAG)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dropAt !== i) setDropAt(i)
            }}
            onDragLeave={() => setDropAt((d) => (d === i ? null : d))}
            onDrop={(e) => {
              e.preventDefault()
              dropTo(i, e.dataTransfer.getData(WORKSPACE_DRAG))
            }}
          >
            <span>{panes ? `In place of ${panes[i].name}` : i === 1 ? `Open beside ${ws.name}` : 'Open on the left'}</span>
          </div>
        ))}
      </div>
    ) : null

  // Something drawn over the window that fails closes, with a word, rather than take the window with it.
  const closeOnError = (what: string, close: () => void) => (error: Error) => {
    close()
    toast(`${what} closed after an error: ${error.message}`, 'bad')
  }

  return (
    <div className={`h-app ${bridge.platform}${state.windowButtons ? ' lights' : ''}${sided ? ` sided${sideHidden ? ' side-hidden' : ''}` : ''}${floating ? ' agent-float' : ''}`}>
      {sided && (
        <Guard name="the sidebar" fallback={(error, retry) => (
          <aside className="h-side">
            <Failed what="the sidebar" error={error} retry={retry} />
          </aside>
        )}>
          <Sidebar
            state={state}
            onScreen={view.kind === 'workspace' ? onScreen : []}
            page={shown.kind === 'marketplace' || shown.kind === 'template' ? 'marketplace' : shown.kind === 'archived' ? 'archived' : undefined}
            unread={unread}
            busy={busy}
            // A workspace picked here is one to look at, as from the command bar.
            onOpen={(id) => besideAgent(() => open(id))()}
            onBeside={ws ? (id) => besideAgent(() => beside(id, split ? undefined : 1))() : undefined}
            onDragOut={ws ? (id) => (setDragging(id), setDropAt(null)) : undefined}
            onArchive={(w) => archive(w, true)}
            onDelete={remove}
            onReorder={reorder}
            onNew={() => go({ kind: 'marketplace' })}
            onArchived={() => go({ kind: 'archived' })}
            onFind={() => setBar('all')}
            running={<RunningAgents row state={state} onScreen={onScreen} onOpen={reveal} onConversation={(s) => showConversation(s.id, s.labels.conversation)} toast={toast} />}
            unreadAll={unreadAll}
            notifications={!!drawer}
            onNotifications={bell}
            settings={!!prefs}
            onSettings={() => (prefs ? setPrefs(null) : settings())}
            hidden={sideHidden}
          />
        </Guard>
      )}
      <main className="h-main">
        {/* The page on screen, drawn afresh once another is opened. */}
        <Guard reset={`${shown.kind}:${ws?.id ?? ''}:${panes?.map((w) => w.id).join(' ') ?? ''}:${template?.id ?? ''}`} name="this page" fallback={(error, retry) => (
          // A title bar still, to move the window by, and a way to somewhere else.
          <>
            <header className="h-top h-drag" />
            <Failed what="this page" error={error} retry={retry}>
              <button className="sb-btn" onClick={() => setBar('all')}>
                Open something else
              </button>
            </Failed>
          </>
        )}>
          {panes && split ? (
            <>
              <header className="h-top h-drag">
                <div className="h-title">
                  <nav className="h-crumbs h-nodrag" aria-label="Workspaces on screen">
                    <span className="h-crumb ws on h-pair-title">{panes.map((w) => w.name).join(' + ')}</span>
                    {!sided && (
                      <button className="h-switch" onClick={(e) => toggleSwitcher(e.currentTarget)} aria-label="Switch workspace" aria-haspopup="dialog" aria-expanded={!!switcher && switcher.pane === undefined} title="Switch workspace">
                        <ChevronsUpDown size={15} strokeWidth={1.8} />
                      </button>
                    )}
                  </nav>
                </div>
                <div className="sb-row h-nodrag h-top-side end">{wsTools}</div>
              </header>
              <div className={`h-body${filling ? ' agent-full' : ''}`}>
                <div ref={splitBox} className={`h-split${stacked ? ' stacked' : ''}`}>
                  {/* In the same order whatever side each is on: moving a frame reloads it. */}
                  {[...panes]
                    .sort((a, b) => (a.id < b.id ? -1 : 1))
                    .map((w) => {
                      const i = split.panes.indexOf(w.id) as 0 | 1
                      return (
                        <WorkspaceView
                          key={w.id}
                          {...viewProps(w)}
                          annotating={annotating}
                          onSwitch={(el) => toggleSwitcher(el, i)}
                          onGone={() => closePane(i)}
                          tone={toneOf(w.id)}
                          pane={{
                            index: i,
                            focused: i === split.focus,
                            share: i === 0 ? split.ratio : 1 - split.ratio,
                            stacked,
                            onFocus: () => focusOn(w.id),
                            onSwap: swap,
                            onStack: stack,
                            onShare: (share) => setSplit({ ...split, ratio: i === 0 ? share : 1 - share }),
                            onAlone: () => closePane((1 - i) as 0 | 1),
                            onClose: () => closePane(i),
                          }}
                        />
                      )
                    })}
                  <div
                    className="h-split-bar"
                    style={{ order: 1 }}
                    role="separator"
                    aria-orientation={stacked ? 'horizontal' : 'vertical'}
                    aria-label="Resize the panes"
                    title="Drag to resize. Double-click for half and half."
                    onMouseDown={(e) => {
                      e.preventDefault()
                      if (e.detail < 2) return setSizing(true)
                      setSplit({ ...split, ratio: 0.5 })
                    }}
                  />
                </div>
                {side}
                {dropZones}
              </div>
              {/* While dragging, a sheet over the whole window keeps the pointer from falling into a frame. */}
              {sizing && (
                <div
                  className={`h-resize-sheet${stacked ? ' rows' : ''}`}
                  onPointerMove={(e) => {
                    const box = splitBox.current?.getBoundingClientRect()
                    if (box) setSplit((s) => s && { ...s, ratio: clampRatio(stacked ? (e.clientY - box.top) / box.height : (e.clientX - box.left) / box.width) })
                  }}
                  onPointerUp={() => setSizing(false)}
                  onPointerLeave={() => setSizing(false)}
                />
              )}
            </>
          ) : ws ? (
            <WorkspaceView key={ws.id} {...viewProps(ws)} annotating={annotating} onSwitch={(el) => toggleSwitcher(el)} switcher={!sided} onGone={() => setView({ kind: 'marketplace' })} side={side} agentFull={filling} tools={wsTools} overlay={dropZones} />
          ) : (
            <>
              {/* A page of the app's own, titled like a workspace: the list of workspaces is the way elsewhere. */}
              <header className="h-top h-drag">
                <div className="h-title">
                  <nav className="h-crumbs h-nodrag" aria-label="Page">
                    {/* A template is a page under New workspace, as a workspace's pages are under its name. */}
                    {template ? (
                      <button className="h-crumb ws" onClick={() => go({ kind: 'marketplace' })}>
                        New workspace
                      </button>
                    ) : (
                      <h1 className="h-crumb ws on h-page-title">{shown.kind === 'archived' ? 'Archived workspaces' : 'New workspace'}</h1>
                    )}
                    {!sided && (
                      <button className="h-switch" onClick={(e) => toggleSwitcher(e.currentTarget)} aria-label="Switch workspace" aria-haspopup="dialog" aria-expanded={!!switcher} title="Switch workspace">
                        <ChevronsUpDown size={15} strokeWidth={1.8} />
                      </button>
                    )}
                    {template && (
                      <span className="h-crumb-step">
                        <Icon name="chevron-right" size={14} />
                        <h1 className="h-crumb on h-page-title" aria-current="page" title={template.name}>
                          {template.name}
                        </h1>
                      </span>
                    )}
                  </nav>
                </div>
                <div className="sb-row h-nodrag h-top-side end">{agentTools(false)}</div>
              </header>
              <div className={`h-body${filling ? ' agent-full' : ''}`}>
                {shown.kind === 'archived' ? (
                  <ArchivedView workspaces={archived} onOpen={open} onRestore={(w) => archive(w, false)} onDelete={remove} />
                ) : template ? (
                  <TemplateView key={`${template.source}:${template.id}`} item={template} state={state} onOpen={open} onUpdate={(workspace) => openPublish(workspace, template.id)} onAddConnector={(preset) => setDialog(preset)} onReview={(choice) => review(template, choice, active[0] && `${active[0].dir}/KIT.md`)} onShortcut={shortcut} />
                ) : (
                  <MarketplaceView state={state} onOpen={open} onPick={(i) => go({ kind: 'template', source: i.source, id: i.id })} />
                )}
                {side}
              </div>
            </>
          )}
        </Guard>
        {queued && state.engine.status === 'ready' && <QueueRunner onError={queueError} />}
        {state.engine.status === 'error' && <div className="h-banner bad">The local agent engine did not start: {state.engine.detail}</div>}
      </main>

      {prefs && (
        <SettingsDialog state={state} section={prefs.section} onSection={(s) => settings(s)} onClose={() => setPrefs(null)}>
          <Guard reset={prefs.section} name="this section">
            {prefs.section === 'marketplace' ? (
              <MarketplaceSettings state={state} />
            ) : prefs.section === 'connectors' ? (
              <ConnectorsView state={state} onAdd={(preset) => setDialog(preset ?? {})} toast={toast} />
            ) : prefs.section === 'tools' ? (
              <ToolsView key={prefs.focus} state={state} toast={toast} focus={prefs.focus} onSchedule={(id) => settings('schedules', id)} />
            ) : prefs.section === 'schedules' ? (
              <SchedulesView key={prefs.focus} state={state} toast={toast} focus={prefs.focus} onTools={(tool) => settings('tools', tool)} />
            ) : prefs.section === 'runs' ? (
              <RunsView state={state} />
            ) : prefs.section === 'store' ? (
              <StoreView state={state} />
            ) : prefs.section === 'appearance' ? (
              <AppearanceView state={state} toast={toast} />
            ) : prefs.section === 'background' ? (
              <BackgroundView state={state} toast={toast} />
            ) : prefs.section === 'voice' ? (
              <VoiceSettingsView state={state} toast={toast} />
            ) : prefs.section === 'usage' ? (
              <UsageView />
            ) : prefs.section === 'shortcuts' ? (
              <ShortcutsView />
            ) : (
              <DesignSystemView state={state} toast={toast} />
            )}
          </Guard>
        </SettingsDialog>
      )}
      {switcher && (
        <Guard name="the workspace list" fallback={() => null} onError={closeOnError('The workspace list', () => setSwitcher(null))}>
          <Switcher
            state={state}
            current={split && switcher.pane !== undefined ? split.panes[switcher.pane] : panes ? onScreen : ws?.id}
            onScreen={onScreen}
            at={switcher}
            unread={unread}
            busy={busy}
            // Opened from a pane, the list picks that pane's workspace, and beside means the other pane.
            onOpen={split && switcher.pane !== undefined ? ((at) => (id: string) => showSplit(put(split, id, at), id))(switcher.pane) : open}
            onBeside={ws ? (split && switcher.pane !== undefined ? ((at) => (id: string) => showSplit(put(split, id, at), id))((1 - switcher.pane) as 0 | 1) : (id) => beside(id, split ? undefined : 1)) : undefined}
            onDragOut={ws ? (id) => (setDragging(id), setDropAt(null)) : undefined}
            onArchive={(w) => archive(w, true)} onDelete={remove} onReorder={reorder} onNew={() => go({ kind: 'marketplace' })} onArchived={() => go({ kind: 'archived' })} onClose={() => setSwitcher(null)} />
        </Guard>
      )}
      {drawer && (
        <Guard key={drawer.only ?? ''} name="notifications" fallback={() => null} onError={closeOnError('Notifications', () => setDrawer(null))}>
          <NotificationsDrawer state={state} only={drawer.only} onClose={() => setDrawer(null)} onGo={follow} onError={(e) => toast(e instanceof Error ? e.message : String(e), 'bad')} />
        </Guard>
      )}
      {/* A new bar for each mode, so going from every command to opening beside starts with an empty field. */}
      {bar && (
        <Guard key={bar} name="the command bar" fallback={() => null} onError={closeOnError('The command bar', () => setBar(false))}>
          <CommandBar commands={commands.current} beside={bar === 'beside' && ws ? ws.name : undefined} onClose={() => setBar(false)} onAll={() => setBar('all')} />
        </Guard>
      )}
      {dialog && (
        <Guard name="the connector" fallback={() => null} onError={closeOnError('The connector dialog', () => setDialog(null))}>
          <ConnectorDialog preset={dialog} state={state} onClose={() => setDialog(null)} toast={toast} />
        </Guard>
      )}
      {/* An agent handed a workspace over to be published: the user sees it, and says yes or no. */}
      {/* Not while the agent fills the window: the workspace is behind it. */}
      <FindInPage ref={finder} workspace={shown.kind === 'workspace' && ws && !filling && !inspecting[ws.id] ? ws.id : null} />
      <div className="h-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`h-toast ${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
      {firstRun && (
        <Guard name="the first-run screen" fallback={() => null} onError={closeOnError('The first-run screen', () => setFirstRunOpen(false))}>
          <FirstRun
            state={state}
            onDone={(end) => {
              setFirstRunOpen(false)
              // Nothing connected and nothing asked: the checklist's greeting, as on any new install.
              const asked = onboardingSession()
              if (!end.intro && !end.draft && !asked) return
              // Otherwise the panel opens on what was made and what is left, or on what was asked, in place of the greeting.
              localStorage.setItem(GREETED, '1')
              showAgent(true)
              const show = (tries = 0): unknown => (panel.current ? (end.intro || end.draft ? panel.current.welcome(end) : panel.current.open(asked!, undefined, { replaceBlank: true })) : tries < 50 && setTimeout(() => show(tries + 1), 30))
              show()
            }}
          />
        </Guard>
      )}
      <CreatedToasts items={created} workspaces={state.workspaces} floating={floating} onGo={(id) => (state.workspaces.some((w) => w.id === id) ? open(id) : toast('That workspace no longer exists', 'bad'))} onDone={(id) => setCreated((c) => c.filter((x) => x.workspace !== id))} />
      {undo && <UndoToast key={undo.id} offer={undo} onDone={() => setUndo((u) => (u?.id === undo.id ? null : u))} />}
      {/* Beside the window's buttons, in the same place whether the sidebar is out or not. Last in the page on purpose: the
          window's drag areas are applied in page order, and a button that comes before one is swallowed by it. */}
      {sided && (
        <button className="h-side-toggle" onClick={toggleSide} aria-label={sideHidden ? 'Show the sidebar' : 'Hide the sidebar'} aria-expanded={!sideHidden} title={titled(sideHidden ? 'Show the sidebar' : 'Hide the sidebar', comboFor('sidebar'))}>
          <PanelLeft size={17} strokeWidth={1.6} />
        </button>
      )}
    </div>
  )
}

/** In place of a part of the window that failed to draw: what went wrong, and a way to try again. */
function Failed({ what, error, retry, children }: { what: string; error: Error; retry: () => void; /** More ways out, beside Try again. */ children?: React.ReactNode }) {
  return (
    <div className="sb-crash h-failed" role="alert">
      <strong>Something went wrong showing {what}.</strong>
      <pre className="sb-code bad">{error.message}</pre>
      <div className="sb-row">
        <button className="sb-btn primary" onClick={retry}>
          Try again
        </button>
        {children}
      </div>
    </div>
  )
}

/** Where the keyboard is, for what has a header: here (lit), or in something else on screen (dim). */
type Tone = 'lit' | 'dim'

/** How a workspace sits in a split window, and what its pane menu does. */
interface PaneProps {
  /** 0 is the left pane (or the top one). */
  index: 0 | 1
  focused: boolean
  /** Its share of the room, 0 to 1. */
  share: number
  stacked: boolean
  onFocus: () => void
  onSwap: () => void
  onStack: (on: boolean) => void
  onShare: (share: number) => void
  /** Closes the other pane. */
  onAlone: () => void
  onClose: () => void
}

// Monaco is big: the code inspector loads the first time someone opens it.
const CodeInspector = lazy(() => import('./CodeInspector'))

function WorkspaceView(p: { frame: { current: FrameHandle | null }; /** The agent panel, shown beside the workspace and under the title bar. Not in a pane: the window has one panel. */ side?: React.ReactNode; /** The agent fills the window; the workspace waits behind it. */ agentFull?: boolean; /** Set when the workspace is one of two in the window. */ pane?: PaneProps; /** In a pane, with more than one thing on screen: whether the keyboard is here (lit) or elsewhere (dim). */ tone?: Tone; /** Drawn over the workspace: where a workspace dragged out of the list can go. */ overlay?: React.ReactNode; ws: WorkspaceInfo; state: AppState; /** The buttons at the end of the title bar: Point, Agent and the ones every page has. */ tools?: React.ReactNode; /** The list of workspaces is open. */ switching: boolean; onSwitch: (from: HTMLElement) => void; /** Whether the title has the carets that open the list of workspaces: not when it is in a sidebar. A pane's always has them, to pick for that pane. */ switcher?: boolean; renaming: boolean; onRenaming: (on: boolean) => void; onRename: (name: string) => void; annotating: boolean; onAnnotate: (on: boolean) => void; /** Whether a note ticked to go right away may send itself; see pointMine in App. */ pointSendsNow: () => boolean; sendPoint: () => void; notes: Note[]; /** Every note on screen, in the agent's order, which the markers are numbered by. */ noteIds: string[]; setNotes: (f: (n: Note[]) => Note[]) => void; showAgent: () => void; onPost: (type: string, payload: Record<string, any>) => void; askAgent: (prompt: string) => void; toast: (t: string, tone?: Toast['tone']) => void; onOpen: (id: string) => void; onGone: () => void; /** Publish to the marketplace: its dialog opens. */ onPublish: () => void; /** A shortcut of the app pressed where the app does not see it, as in the code inspector. */ onShortcut: (combo: Combo) => void; /** Whether a new version may wait while the user is busy in the workspace: not while the keyboard is in the agent panel. */ mayHold: boolean; /** Its code is on screen in its place: <Workspace> › Inspect code. */ inspecting: boolean; onInspect: (on: boolean) => void; /** The code's editor, while it is open, for Find. */ inspector: { current: InspectorHandle | null } }) {
  const { ws, state } = p
  const [menu, setMenu] = useState(false)
  const [picking, setPicking] = useState(false)
  // The menu a right-click on the workspace's name opens, and where the click was.
  const [nameMenu, setNameMenu] = useState<{ top: number; left: number } | null>(null)
  const nameMenuAt = (e: React.MouseEvent) => {
    e.preventDefault()
    setNameMenu({ top: e.clientY + 4, left: e.clientX })
  }
  const [path, setPath] = useState('/')
  // Breadcrumbs: the pages above the current one (as the workspace's routes define them), and the
  // names pages have given themselves, remembered so a page above still has its name.
  const [above, setAbove] = useState<string[]>([])
  const [titles, setTitles] = useState<Record<string, string>>({})
  const here = path.split('?')[0]!
  const tail = (p: string, after: string) => {
    const rest = p.slice(after === '/' ? 1 : after.length + 1).split('/').filter(Boolean)
    return rest.map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    }).join(' / ')
  }
  const crumbs = here === '/' ? [] : [...above, here].map((p, i, all) => ({ path: p, label: titles[p] || tail(p, all[i - 1] ?? '/') }))
  // The workspace's own code, as a page of the workspace: <Workspace> › Inspect code. The workspace stays loaded behind it.
  const { inspecting, onInspect: setInspecting } = p
  const frame = p.frame
  // What is on screen is the latest good build. Agents work in drafts, so the folder only changes when one publishes.
  const shownVersion = ws.build.version
  const [history, setHistory] = useState(false)
  // A newer version, waiting off screen while the user types in the workspace.
  const [held, setHeld] = useState<number | null>(null)

  // The frame draws the picker; the list of what was picked lives here, so it survives reloads.
  const ids = p.noteIds.join(' ')
  const syncFrame = () => {
    frame.current?.send('annotate', { on: p.annotating })
    frame.current?.send('annotate-sync', { ids: p.noteIds, here: p.notes.filter((n) => n.page === path).map((n) => ({ id: n.id, selector: n.selector })) })
  }
  useEffect(syncFrame, [p.annotating, ids, path])
  // What a note can @ mention, as the agent's message box can.
  const mentions = usePointMentions(state.workspaces, state.connectors, ws.id, connectorIcon)
  const syncMentions = () => frame.current?.send('annotate-mentions', { list: mentions })
  useEffect(syncMentions, [mentions])
  const onFramePost = (type: string, m: Record<string, any>) => {
    if (type === 'title') {
      const at = String(m.path ?? path).split('?')[0]!
      setTitles((t) => (t[at] === String(m.title ?? '') ? t : { ...t, [at]: String(m.title ?? '') }))
    }
    else if (type === 'ready') (syncFrame(), syncMentions())
    else if (type === 'annotate-exit') p.onAnnotate(false)
    else if (type === 'annotate-add') {
      p.setNotes((n) => [...n, { ...m.item, page: path, workspace: ws.id }])
      // Ticked "Trigger agent right away": the note (with any others on the list) goes now, with a message that points
      // the agent at them. Workspace code can post the same flag, so the host also checks the user is the one pointing.
      if (m.send && String(m.item?.note ?? '').trim() && p.pointSendsNow()) p.sendPoint()
      else p.showAgent()
    } else p.onPost(type, m)
  }

  const act = async (f: () => Promise<unknown>) => {
    setMenu(false)
    try {
      await f()
    } catch (e) {
      p.toast(e instanceof Error ? e.message : String(e), 'bad')
    }
  }

  const title = (
        <div className="h-title">
          <span className="h-menu-anchor h-nodrag">
            <button className="h-icon-button" onClick={() => setPicking(!picking)} aria-label="Change icon and colour" title="Change icon and colour">
              <WorkspaceIcon icon={ws.icon} color={ws.color} size={15} />
            </button>
            {picking && <IconPicker icon={ws.icon} color={ws.color} onClose={() => setPicking(false)} onChange={(next) => void app('workspace_update', { workspace: ws.id, ...next }).catch((e) => p.toast(e instanceof Error ? e.message : String(e), 'bad'))} />}
          </span>
          <nav className="h-crumbs h-nodrag" aria-label="Breadcrumbs">
            {p.renaming ? (
              <input
                className="h-rename"
                aria-label={`Rename ${ws.name}`}
                defaultValue={ws.name}
                maxLength={80}
                size={Math.max(8, ws.name.length)}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => (e.currentTarget.dataset.dropped ? undefined : p.onRename(e.currentTarget.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  else if (e.key === 'Escape') {
                    // Removing the field blurs it; this keeps that from saving what was typed.
                    e.currentTarget.dataset.dropped = '1'
                    p.onRenaming(false)
                  }
                }}
              />
            ) : inspecting ? (
              <button className="h-crumb ws" onClick={() => setInspecting(false)} onDoubleClick={() => p.onRenaming(true)} onContextMenu={nameMenuAt} title={`Back to ${ws.name}`}>
                {ws.name}
              </button>
            ) : crumbs.length ? (
              <button className="h-crumb ws" onClick={() => frame.current?.send('navigate', { to: '/' })} onDoubleClick={() => p.onRenaming(true)} onContextMenu={nameMenuAt}>
                {ws.name}
              </button>
            ) : (
              <span className="h-crumb ws on" onDoubleClick={() => p.onRenaming(true)} onContextMenu={nameMenuAt}>
                {ws.name}
              </span>
            )}
            {p.switcher !== false && (
              <button className="h-switch" onClick={(e) => p.onSwitch(e.currentTarget)} aria-label="Switch workspace" aria-haspopup="dialog" aria-expanded={p.switching} title="Switch workspace">
                <ChevronsUpDown size={15} strokeWidth={1.8} />
              </button>
            )}
            {inspecting && (
              <span className="h-crumb-step">
                <Icon name="chevron-right" size={14} />
                <span className="h-crumb on" aria-current="page">
                  Inspect code
                </span>
              </span>
            )}
            {!inspecting &&
              crumbs.map((c, i) => (
                <span key={c.path} className="h-crumb-step">
                  <Icon name="chevron-right" size={14} />
                  {i < crumbs.length - 1 ? (
                    <button className="h-crumb" onClick={() => frame.current?.send('navigate', { to: c.path })} title={c.label}>
                      {c.label}
                    </button>
                  ) : (
                    <span className="h-crumb on" aria-current="page" title={c.label}>
                      {c.label}
                    </span>
                  )}
                </span>
              ))}
          </nav>
        </div>
  )
  const building = ws.build.status === 'building' && <span className="sb-badge live">Building</span>
  const pane = p.pane
  const menuButton = (
    <div className="h-menu-anchor">
      <button className={`sb-btn sm ghost${menu ? ' on' : ''}`} style={{ width: 30, padding: 0 }} onClick={() => setMenu(!menu)} aria-label={pane ? 'Pane menu' : 'Workspace menu'} aria-expanded={menu}>
        <Icon name="dots" size={18} />
      </button>
      {menu && (
        <>
          <div className="h-scrim" onClick={() => setMenu(false)} />
          <div className="h-menu h-workspace-menu">
            {/* A pane's menu starts with how the two panes share the window. */}
            {pane && (
              <>
                <button onClick={() => act(async () => pane.onStack(!pane.stacked))}>
                  {pane.stacked ? <Columns2 size={14} strokeWidth={1.7} /> : <Rows2 size={14} strokeWidth={1.7} />}
                  {pane.stacked ? 'Side by side' : 'Stack top and bottom'}
                </button>
                <div className="h-menu-widths" role="group" aria-label={pane.stacked ? 'Height of this pane' : 'Width of this pane'}>
                  {[
                    ['⅓', 1 / 3],
                    ['½', 1 / 2],
                    ['⅔', 2 / 3],
                  ].map(([label, share]) => (
                    <button key={label as string} aria-pressed={Math.abs(pane.share - (share as number)) < 0.02} onClick={() => act(async () => pane.onShare(share as number))}>
                      {label}
                    </button>
                  ))}
                </div>
                <button onClick={(e) => (setMenu(false), p.onSwitch(e.currentTarget.closest('.h-menu-anchor') as HTMLElement))}>
                  <ChevronsUpDown size={14} strokeWidth={1.7} />
                  Replace with…
                </button>
                <hr className="h-menu-sep" />
              </>
            )}
            <button onClick={() => act(async () => setHistory(true))}>Version history</button>
            <button onClick={() => act(async () => setInspecting(!inspecting))}>{inspecting ? 'Close code inspector' : 'Inspect code'}</button>
            <button
              onClick={() =>
                act(async () => {
                  const w = await app('workspace_fork', { workspace: ws.id })
                  p.onOpen(w.id)
                })
              }
            >
              Duplicate
            </button>
            {/* Only from where it came from: a marketplace workspace from another server has nothing to update from here. */}
            {hasUpdateSource(ws.origin, p.state.remote.api, p.state.marketplace) && (
              <button
                onClick={() =>
                  act(async () => {
                    if (!confirm(`Replace “${ws.name}” with the current marketplace version? Edits made to this workspace are lost.`)) return
                    await app('marketplace_restore', { workspace: ws.id })
                    p.toast('Updated to the marketplace version', 'good')
                  })
                }
              >
                Update from marketplace
              </button>
            )}
            <hr className="h-menu-sep" />
            <button onClick={() => act(async () => p.onPublish())}>{ownedPublication(p.ws, p.state) ? 'Update marketplace template' : 'Publish to marketplace'}</button>
            {!ws.home && (
              <button
                className="danger"
                onClick={() =>
                  act(async () => {
                    if (!confirm(`Delete “${ws.name}” and its folder?`)) return
                    await app('workspace_delete', { workspace: ws.id })
                    p.onGone()
                  })
                }
              >
                Delete
              </button>
            )}
            {pane && (
              <>
                <hr className="h-menu-sep" />
                <button onClick={() => act(async () => pane.onClose())}>
                  <Icon name="x" size={14} />
                  Close pane
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
  const rest = (
    <>
      {nameMenu && (
        <>
          <div className="h-scrim" onClick={() => setNameMenu(null)} onContextMenu={(e) => (e.preventDefault(), setNameMenu(null))} />
          <div className="h-menu h-name-menu" role="menu" style={nameMenu}>
            <button
              role="menuitem"
              autoFocus
              onKeyDown={(e) => e.key === 'Escape' && setNameMenu(null)}
              onClick={() => {
                setNameMenu(null)
                p.onRenaming(true)
              }}
            >
              <Pencil size={14} strokeWidth={1.7} />
              Rename
            </button>
          </div>
        </>
      )}
      {ws.build.status === 'error' && (
        <div className="h-banner bad">
          <span>
            <strong>The latest change does not build.</strong> {shownVersion ? 'The last working version is still on screen.' : ''}
            <code>{ws.build.errors[0]?.split('\n').slice(0, 3).join(' ')}</code>
          </span>
          <button className="sb-btn sm" onClick={() => p.askAgent(`The workspace does not build. Fix it.\n\n${ws.build.errors.join('\n\n').slice(0, 3000)}`)}>
            Ask the agent to fix it
          </button>
        </div>
      )}
      {ws.build.status !== 'error' && ws.build.runtimeError && (
        <div className="h-banner bad">
          <span>
            <strong>The workspace hit an error.</strong> <code>{ws.build.runtimeError.split('\n')[0]}</code>
          </span>
          <button className="sb-btn sm" onClick={() => p.askAgent(`The workspace UI threw this error at runtime. Fix it.\n\n${ws.build.runtimeError}`)}>
            Ask the agent to fix it
          </button>
        </div>
      )}
      {held !== null && (
        <div className="h-banner held" role="status">
          <span>
            <strong>There is a new version of this workspace.</strong> {p.annotating ? 'It waits while Point is on.' : 'It waits while you type here, so nothing you typed is lost.'}
          </span>
          <button className="sb-btn sm" onClick={() => frame.current?.update()}>
            Update now
          </button>
        </div>
      )}
      {history && <HistoryDialog ws={ws} onClose={() => setHistory(false)} toast={p.toast} />}
    </>
  )
  const inspector = inspecting && (
    <div className="h-inspect-page">
      <Suspense fallback={<p className="h-muted h-template-none">Loading the code inspector…</p>}>
        <CodeInspector ws={ws} onShortcut={p.onShortcut} handle={p.inspector} onOpenFolder={() => void bridge.openPath(ws.dir)} />
      </Suspense>
    </div>
  )
  // Back to the workspace from its code.
  const closeCode = inspecting && (
    <button className="sb-btn sm ghost" style={{ width: 30, padding: 0 }} onClick={() => setInspecting(false)} aria-label="Close code inspector" title="Back to the workspace">
      <Icon name="x" size={16} />
    </button>
  )
  const frameEl = (
    <Frame
      workspace={ws.id}
      version={shownVersion}
      mayHold={p.mayHold}
      pinned={p.annotating}
      onHeld={setHeld}
      onPost={onFramePost}
      onRoute={(next, pages) => {
        setPath(next)
        setAbove(pages)
      }}
      handle={frame}
    />
  )

  // One of two: a card with its own header, which a click anywhere in focuses. The focused one's header is tinted.
  if (pane)
    return (
      <section className={`h-pane${pane.focused ? ' on' : ''}${p.tone ? ` ${p.tone}` : ''}${inspecting ? ' inspecting' : ''}`} data-pane={ws.id} aria-label={ws.name} style={{ order: pane.index * 2, flex: `${pane.share} 1 0` }} onPointerDownCapture={pane.onFocus}>
        <header className="h-pane-head">
          {title}
          <div className="sb-row h-pane-side">
            {building}
            {/* Swap, show only and the menu are on the focused pane's header; close is on both. */}
            {pane.focused && (
              <>
                {closeCode}
                <button className="sb-btn sm ghost" style={{ width: 30, padding: 0 }} onClick={pane.onSwap} aria-label="Swap sides" title={pane.stacked ? 'Swap top and bottom' : 'Swap sides'}>
                  <ArrowLeftRight size={15} strokeWidth={1.7} style={pane.stacked ? { transform: 'rotate(90deg)' } : undefined} />
                </button>
                <button className="sb-btn sm ghost" style={{ width: 30, padding: 0 }} onClick={pane.onAlone} aria-label={`Show only ${ws.name}`} title="Show only this workspace">
                  <Maximize2 size={14} strokeWidth={1.7} />
                </button>
                {menuButton}
              </>
            )}
            <button className="sb-btn sm ghost" style={{ width: 30, padding: 0 }} onClick={pane.onClose} aria-label={`Close ${ws.name}`} title="Close this pane">
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>
        {rest}
        {frameEl}
        {inspector}
      </section>
    )
  return (
    <>
      <header className="h-top h-drag">
        {title}
        <div className="sb-row h-nodrag h-top-side end">
          {building}
          {closeCode}
          {menuButton}
          {p.tools}
        </div>
      </header>
      {rest}
      <div className={`h-body${p.agentFull ? ' agent-full' : ''}${inspecting ? ' inspecting' : ''}`}>
        {frameEl}
        {inspector}
        {p.side}
        {p.overlay}
      </div>
    </>
  )
}

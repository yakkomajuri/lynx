// The agent. It lives in the host, not in a workspace, so it is still there when workspace code is
// broken, and its conversations are the same whichever workspace is on screen. It is an ordinary
// session on the `agents` connector, free to do anything; a workspace is context a message carries
// (@ mentioned in it: a new conversation starts with the one on screen), not where the agent is confined.
// Agents change a workspace through drafts: each conversation edits its own copy and publishes it.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import { ArrowUp, History, Maximize2, Mic, Minimize2, Minus, Plus, RotateCw, Search, Undo2 } from 'lucide-react'
import { agents, chooseModel, effortName, harnessName, isBusy, PERMISSIONS, type PermissionMode, type SessionSummary, useProviders, useSession, useSessionInfo, useSessions } from '@kit/agents'
import { Icon } from '@kit/icons'
import { Composer, fullPayload, Marked, markRanges, OutgoingMessage, Transcript, useAttachments, type AttachmentDraft, type Mark } from '@kit/chat'
import { Guard, GuardNote } from '@kit/guard'
import { typedMention } from '@kit/marks'
import { call, type Attachment } from '@kit/core'
import { rel } from '@kit/ui'
import type { AppState, ConnectorState, WorkspaceInfo } from '@shared/types'
import { correct as correctHeard, namesIn, vocabulary } from '@shared/vocab'
import { fixFailed } from '@shared/voice'
import { bridge } from './api'
import type { Note } from './App'
import { app } from './api'
import { Keys, keys, titled } from './CommandBar'
import { AgentMark, Pick } from './ComposerLine'
import { Logo } from './Connectors'
import { comboFor, useShortcuts } from './keymap'
import type { ReviewStart } from './SecurityReview'
import { MarketplaceAccountCard, PublishConfirm, publishOf } from './Publish'
import { shellQuote, SignInCard } from './SignIn'
import { WorkspaceIcon } from './WorkspaceIcon'
import { HOLDS, leadOf, queue, useQueues, type Queued } from './agentQueue'
import { beginOnboarding, checklistInUse, GREETING, welcomeRules, ONBOARDING_REPLY, onboardingRules, onboardingSession, PRODUCTS, tellOnboarding } from './onboarding'

/** The agent's first words on the onboarding checklist, as its message would look. */
function Greeting({ text = GREETING }: { text?: string }) {
  return (
    <div className="sb-msg assistant h-greet">
      <p>{text}</p>
    </div>
  )
}

/** What a note sent straight from Point says, after the workspaces it is about. */
export const POINT_SEND = 'Look at the notes I left using Point and go through my asks'
import { voice, VoiceBar, useVoice } from './Voice'
import { outgoing, useOutgoing } from './outgoing'
import { sideWidth, useRoom, WORKSPACE_ROOM } from './room'

/** The gap between the panel and the window's right edge; --h-agent-inset in host.css. */
const INSET = 10
/** Floating, the panel keeps this far inside the workspace's edges (host.css, .h-agent.floating). */
const FLOAT_GAP = 12
/** The floating panel's size, as last dragged: { w, h }, either missing for the default. */
const FLOAT_SIZE = 'sb.agent.float'
type Drag = 'dock' | 'x' | 'y' | 'xy'

export interface AgentPanelHandle {
  compose: (prompt: string) => void
  /** Sends the notes left with Point now (a draft while a turn runs). For the host only, when the user set Point to send right away: never for a workspace. */
  sendPoint: () => void
  newThread: () => void
  /** ⌘W: closes the tab on screen. The only tab, a new conversation, has nothing to close to, so the panel closes. */
  closeTab: () => void
  /** ⌘1–9: shows the tab at that place on the strip. */
  showTab: (i: number) => void
  /** ⌃Tab and ⌃⇧Tab: the tab after the one on screen, or before it, round from the end to the start. */
  cycleTab: (by: 1 | -1) => void
  /** Starts a security review of a template, as a conversation in a tab of its own. */
  review: (r: ReviewStart) => void
  publish: (w: WorkspaceInfo, template?: string) => void
  /** Shows a conversation in a tab, as the list of every conversation does: one picked from the agents running, say. */
  open: (sessionId: string, conversation?: string, opts?: { /** An empty new conversation on screen gives its tab to this one. */ replaceBlank?: boolean }) => void
  /** Starts the onboarding conversation with this message, in place of the greeting's tab: the user connected something before writing to it. */
  onboard: (text: string) => Promise<boolean>
  /** Once the first-run screen is done: a new conversation opening on what the agent made, with a message about the rest waiting in the box. */
  welcome: (end: { intro?: string; draft?: string; made: string[]; connected: string[] }) => void
}

/** The user's design system, as an agent should take it: the text itself when there is one, and where to find the current version either way. */
const designRules = (design: string) =>
  design.trim()
    ? `- The user has a design system. It is how every workspace should look, and it wins over the kit's defaults and your own taste; where it is silent, use the kit as it is. It may have changed since this conversation began: design_system_get on the app connector returns the current text. As of the start of this conversation it reads:

<design-system>
${design.trim().slice(0, 12000)}${design.trim().length > 12000 ? '\n… (cut here; read the rest with design_system_get)' : ''}
</design-system>`
    : `- The user has not written a design system (Settings). If they describe a look they want everywhere, offer to save it with design_system_set; design_system_get returns it once there is one.`

/** What the agent in the panel is told at the start of every conversation (also the first-run screen's). */
export const instructions = (design: string) => `You are the agent built into Lynx, a desktop app where each workspace is a custom UI (React code in a folder) that reads and acts through connectors (MCP servers). You can help with anything: you have this computer and every connector. Your working directory is a scratch folder of your own.

A message may come with workspaces attached ([Workspace attached: …]): usually the one the user is looking at, or the two when they have two side by side. Take it as context for what they mean, not as a limit on what you may do.

Changing a workspace's code:
- Never edit a workspace's own folder: it is what is on screen, and other agents may be changing the same workspace. Work in a draft: workspace_draft on the app connector, with the workspace id and the draft name the message gives, returns your own folder (a git worktree on its own branch). Make every change there.
- Read KIT.md in the draft before writing UI code. It documents the "lynx" module (call, useTool, routing, agents, components). App.jsx is the whole UI.
- workspace.json holds the connector bindings (alias -> connector id) and the manifest, "uses": every tool the UI calls, by connector. The manifest is enforced: when you add a call to the UI, add it to "uses" in the draft's workspace.json. A call that is missing fails with the exact line to add.
- workspace_build with the workspace and your draft builds it and reports compile errors. Fix them.
- When the change is done and builds, workspace_publish with the workspace, your draft and a one-line message for the history puts it on screen. If someone published to the workspace since your draft began, it is refused with what they changed: run \`git rebase main\` in your draft folder, resolve conflicts so both changes survive, build, and publish again. Never force it, and never copy files into the workspace folder yourself.
- A published version can wait off screen while the user is typing in the workspace, so their text is not lost; workspace_build without a draft then says so (held). It goes on screen when they stop or click Update now. That is not a failure: do not publish again for it. Where the UI has unsaved work the page cannot see (an editor's buffer, a draft kept only in state), mark it with useBusy from the kit (see KIT.md).
- The draft stays caught up after publishing; keep using it.
- The user watches the workspace while you work, so publish in steps they can follow, never once per edit. Each step must build and leave the UI working, never broken or half-wired, and gets its own message.
  - Building a new workspace (blank, or not much there yet): be incremental so the user sees it take shape. Publish the layout and navigation with loading and empty states first, then each page or feature as it starts working.
  - Changing an established workspace: publish fewer times, one per natural grouping. Changing two pages is two publishes, the first as soon as it works; a change to one page, however many edits it takes, is one.
- Before rendering data from a connector, look at it: app connector_tools for the schemas, connector_call to see a real response. Never guess a response shape.
- The UI should look finished: real loading, empty and error states, sensible layout. You may write any React and CSS you like; the kit is optional.
- Always use agents-in-UI for work a workspace performs: run sessions through the kit agents API and keep their transcript, progress, approvals, stop control and follow-ups in that workspace. AgentTask provides this for error investigation. Declare the required agents tools in the manifest. Never route operational tasks to the sidebar through askAgent. Reserve askAgent for meta help such as onboarding, building or configuring a workspace, and repairing its UI code; it only prepares a draft for the user to send.
- Handle errors where they happen and say what went wrong in plain words. Offer an AgentTask or another embedded agent conversation for operational failures, including the error and what the page was doing. Use ErrorNote with fix={false} alongside it to avoid a second sidebar helper. A sidebar draft is appropriate only for meta workspace repair. Leave agent help out where it cannot help, such as invalid user input.
${designRules(design)}

Everywhere:
- Data that should outlive a page goes in the store (db_* and files_* on the app connector). It is shared by every workspace, tool and agent: name collections for what they hold.
- For several calls that belong together, or anything on a schedule, write a custom tool: read tool_guide on the app connector, save it with tool_save, run it once through the tools connector, and schedule it with schedule_save.
- To publish a workspace to the public marketplace, use marketplace_stage to prepare a copy, marketplace_account to show secure account setup, and marketplace_submit to show the final publish card. Never ask for sign-in codes in chat or upload directly.
- To add a data source, use connector_add. Never ask the user to paste secrets into chat; the app asks them directly. Each one shows a connect card in the conversation. When one card is all you asked for, the user connecting it carries you on; when you add several in one answer, nothing does: end by asking the user to tell you once they have connected the ones they want.
- When a service the user wants has no MCP server, offer to connect its HTTP API instead: from its documentation, find the base URL and how it takes its key, then connector_add with url (the base URL) and api (auth_type, auth_name, docs_url, notes on the endpoints that matter, and a check_path when there is a cheap authenticated GET). It gets one tool, request, which adds the key itself.
- When something happens that the user should hear about while they are elsewhere (a scheduled check found something, a long job finished), send notification_send on the app connector with the workspace it concerns, a short text, and link set to the page it concerns ("/prs/42"). In a custom tool that is notify(workspace, text, link).
- Files the user attaches arrive as read-only copies under .agent-attachments/ in your working directory. When one should become part of a workspace (an image the UI shows, data it loads), copy it into your draft.
- When the user points at parts of a workspace's UI, each one comes with the element's text, classes, selector and surrounding components, and sometimes a note: locate it in the code from those. They may want it changed, or explained or looked into (what it shows, where its data comes from): do what they ask, and when changing, change that element, not lookalikes.
- You can move the window for the user: workspace_open brings a workspace on screen, or beside the one there (beside "right" or "left") to split the window in two, at a page in it (path). window_get says what is on screen; window_layout closes, swaps, stacks or focuses panes.
- You can point back at the running UI: ui_find finds elements on a workspace's page as the user sees it (by selector, text, or an outline of the page), and ui_highlight outlines one, or a few numbered, with a short question on it. When the user asks to change something on screen and which one they mean is not certain ("the card", "that button"), highlight your best guess with a question ("This card?"), ask the same in your reply and end your turn; their answer comes next. Once they confirm, ui_clear and go ahead.
- workspace_build is the check: do not run browser or end-to-end tests unless the user asks for them.
- Keep replies short. Say what changed, not how.`

/** A new conversation's name for its drafts. */
export const newDraftName = () => `c-${Math.random().toString(36).slice(2, 10)}`
/** A new conversation not sent yet has a tab of its own under a key like this, until its first message starts it. There can be several. */
const BLANK = 'new:'
const blankKey = () => `${BLANK}${Math.random().toString(36).slice(2, 10)}`
const isBlank = (key: string) => key.startsWith(BLANK)
/** Where a conversation's draft name is remembered, for when its labels have not loaded yet. */
const draftKey = (sessionId: string) => `sb.agent.draft.${sessionId}`
const CURRENT = 'sb.agent.current'
/**
 * What the panel has that is not sent yet, kept here so it outlives the panel: it is drawn again
 * when the workspace on screen changes, and what was typed, attached or left in a new tab stays.
 */
const kept: {
  drafts?: Record<string, string>
  blanks?: string[]
  current?: string
  welcomes: Record<string, { intro?: string; made: string[]; connected: string[] }>
  fresh: Record<string, string>
  composed: Set<string>
  greeted: Set<string>
  files: AttachmentDraft[]
} = { welcomes: {}, fresh: {}, composed: new Set(), greeted: new Set(), files: [] }

/** How the blocks the panel adds to a message for the agent begin: the workspaces it is about, what the user pointed at, and that it was said aloud. */
const ADDED = ['[Workspace attached: ', '[Connector mentioned: ', '[I pointed at these parts', '[Said aloud in voice mode']

/** What goes with a message said in voice mode: the reply may be heard rather than read, and the agent can show the user what it means. */
const voicedNote = (readOut: boolean, heardAs?: string) => `[Said aloud in voice mode: you heard me through the microphone${heardAs ? ` (it heard "${heardAs}"; names in it were corrected to ones Lynx knows, so if this reads wrong, go by what was heard)` : ''}${readOut ? ', and your reply is read out to me. Answer in one or two short spoken sentences: no markdown, lists, code or links.' : '. Answer in a sentence or two.'} You can move the window for me (workspace_open, beside to split; window_layout). When I refer to something on screen and which one is not certain, find it with ui_find, highlight your best guess with ui_highlight and a question like "This card?", ask just that, and end your turn: my next words answer. Words may be misheard; go by what makes sense.]`

/**
 * What the user wrote in a message, without what the panel added for the agent. Previews and
 * titles are the message's start, so they may end partway into the first block's opening.
 */
const said = (text?: string | null) => {
  if (!text) return undefined
  const at = text.search(/(^|\s)\[(Workspace attached: |Connector mentioned: |I pointed at these parts|Said aloud in voice mode)/)
  const kept = at < 0 ? text : text.slice(0, at)
  const tail = kept.match(/(^|\s)(\[[^\]]*)$/)
  return (tail && ADDED.some((b) => b.startsWith(tail[2])) ? kept.slice(0, tail.index) : kept).trim()
}

/**
 * A queued message being rewritten, in place. It waits meanwhile, and the ones after it with it.
 * Enter saves, Shift+Enter starts a new line, Escape puts it back as it was. What is typed is kept
 * by the queue, so leaving the conversation and coming back finds it as it was left.
 */
function QueuedEdit({ session, item, onSave, onCancel }: { session: string; item: Queued; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(() => queue.draft(session, item.id) ?? leadOf(item))
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  // The field grows with what is in it, up to what the queue has room for.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])
  const save = () => text.trim() && onSave(text.trim())
  return (
    <div className="h-queued editing">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        aria-label="Edit the queued message"
        onChange={(e) => {
          setText(e.target.value)
          queue.setDraft(session, item.id, e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            save()
          }
        }}
      />
      <div className="h-queued-edit-actions">
        <button className="h-queued-now" onClick={onCancel}>
          Cancel
        </button>
        <button className="h-queued-now save" onClick={save} disabled={!text.trim()}>
          Save
        </button>
      </div>
    </div>
  )
}

/** The conversations open as tabs, left to right. */
const TABS = 'sb.agent.tabs'
/**
 * A conversation started from a new conversation's tab takes that tab's place, and what was on its way from there goes
 * to it. Starting takes a moment, and the panel may be drawn anew meanwhile (another workspace on screen): the panel on
 * screen when it has started does this, or with none, what the next one opens on.
 */
const handOff: { owner?: object; started?: (from: string, id: string, name?: string) => void } = {}
const startedOffScreen = (from: string, id: string, name?: string) => {
  outgoing.move(from, id)
  kept.blanks = kept.blanks?.filter((x) => x !== from)
  kept.current = id
  delete kept.welcomes[from]
  delete kept.fresh[from]
  if (kept.drafts) delete kept.drafts[from]
  localStorage.setItem(CURRENT, id)
  if (name) localStorage.setItem(draftKey(id), name)
  const tabs: unknown = JSON.parse(localStorage.getItem(TABS) ?? '[]')
  const open = Array.isArray(tabs) ? tabs : []
  if (!open.includes(id)) localStorage.setItem(TABS, JSON.stringify([...open, id]))
}
const startedFrom = (from: string, id: string, name?: string) => (handOff.started ?? startedOffScreen)(from, id, name)

/** How a workspace is on screen, as the agent is told: the one, one of two side by side, or not at all. */
const where = (id: string, onScreen: string[], focused: string) => (!onScreen.includes(id) ? '' : onScreen.length < 2 ? ', the one on screen' : id === focused ? ', on screen beside another, with the focus' : ', on screen beside another')

/** The workspaces a message is about, as the agent needs them: where they are, how to change them, and what is wrong with them now. */
const attached = (list: WorkspaceInfo[], onScreen: string[], focused: string, draft: string) =>
  list
    .map((w) =>
      [
        `[Workspace attached: "${w.name}" (id: ${w.id})${where(w.id, onScreen, focused)}. Its folder ${w.dir} is what is on screen: read it there, but change it only in your draft (workspace_draft with workspace "${w.id}" and draft "${draft}"), then publish.`,
        w.build.status === 'error' ? `It currently fails to build:\n${w.build.errors.join('\n').slice(0, 2000)}` : '',
        w.build.runtimeError ? `Its running UI last reported this error:\n${w.build.runtimeError.slice(0, 1500)}` : '',
        w.build.held !== undefined ? `Its newest version (${w.build.held}) waits off screen while the user types in it; what is on screen is the one before.` : '',
      ]
        .filter(Boolean)
        .join('\n') + ']',
    )
    .join('\n\n')

/** The connectors a message mentions, as the agent needs them: which ones the user means. */
const mentioned = (list: ConnectorState[]) => list.map((c) => `[Connector mentioned: "${c.name}" (id: ${c.id}). I mean this connector: use it for what I ask.]`).join('\n\n')

/** What can be @ mentioned in a message: a workspace or a connector, by its name. */
interface Mention {
  kind: 'workspace' | 'connector'
  id: string
  name: string
  /** "@" and the name, as it is typed. */
  text: string
  icon: (size: number) => React.ReactNode
}


/** The command that picks the conversation up in the agent's own CLI, from the folder it ran in. */
const resumeCommand = (command: string[], cwd: string, id: string) => `cd ${shellQuote(cwd)} && ${[...command, id].map(shellQuote).join(' ')}`

/** Where a note was put, in a few words: its workspace when there are two on screen, its component, element and text. */
const whereOf = (n: Note, workspace: string) => `${workspace ? `${workspace} · ` : ''}${n.components.at(-1) ? `${n.components.at(-1)} · ` : ''}${n.tag}${n.text ? ` “${n.text.slice(0, 40)}”` : ''}`

/** What the user pointed at on the running UI, in words an agent can find in the code. With notes in two workspaces, each says which. */
const pointedAt = (notes: Note[], name: (id: string) => string) =>
  `[I pointed at these parts of the running UI. A note on one says what I want there; the ones without a note are what my message is about. Find each one in the code by its text, classes and components.${notes.some((n) => n.note) ? ' Where a note asks for a change, change only that.' : ''}
${notes
  .map((n, i) =>
    [
      `${i + 1}. ${n.note || '(no note)'}`,
      `   element: <${n.tag}${n.classes ? ` class="${n.classes}"` : ''}>${n.text ? ` showing "${n.text}"` : ''}${n.label ? ` (labelled "${n.label}")` : ''}`,
      n.components.length ? `   components: ${n.components.join(' > ')}` : '',
      `   selector: ${n.selector}`,
      new Set(notes.map((x) => x.workspace)).size > 1 ? `   workspace: ${name(n.workspace)} (id: ${n.workspace})` : '',
      `   page: ${n.page}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
  .join('\n')}]`

/** The words of a text, for telling whether correcting changed any (and not only capitals or stops). */
const wordsOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** A connector's product, from its address: mcp.linear.app is Linear, api.attio.com Attio. */
const productOf = (url?: string) => {
  try {
    const parts = new URL(url ?? '').hostname.split('.').filter((p) => !/^(mcp|api|www|app|server|gateway)$/.test(p))
    const name = parts.length > 1 ? parts[parts.length - 2]! : parts[0]
    return name && !/^(localhost|\d+)$/.test(name) ? name[0]!.toUpperCase() + name.slice(1) : undefined
  } catch {
    return undefined
  }
}

/** The names voice mode listens for now: workspaces and connectors, what was just said, and what is on screen. */
const vocabularyNow = async (state: AppState, events: { type: string; payload: any }[], screenWords: () => Promise<string[]>) => {
  const words = await screenWords().catch(() => [] as string[])
  const recent = events
    .filter((e) => e.type === 'assistant_message' || e.type === 'user_message')
    .slice(-6)
    .map((e) => (e.type === 'user_message' ? (said(String(e.payload?.text ?? '')) ?? '') : String(e.payload?.text ?? '')))
  return vocabulary([
    { texts: ['Lynx', ...state.workspaces.filter((w) => !w.archived).map((w) => w.name), ...state.connectors.flatMap((c) => [c.name, productOf(c.url) ?? ''])], weight: 1 },
    { texts: recent.flatMap(namesIn), weight: 0.85 },
    { texts: words.flatMap((w) => (w.split(' ').length <= 4 ? [w, ...namesIn(w)] : namesIn(w))), weight: 0.7 },
  ])
}

export const AgentPanel = forwardRef<AgentPanelHandle, { /** Whether the keyboard is here (lit) or in a workspace beside it (dim). */ tone?: 'lit' | 'dim'; /** The titles of the tabs, left to right, each time they change (and none once the panel closes). */ onTabs: (titles: string[]) => void; /** The workspace on screen, or the focused one of two. None on a page that is not a workspace. */ ws?: WorkspaceInfo; /** Every workspace on screen. */ onScreen: string[]; state: AppState; onBusy: (busy: boolean) => void; onClose: () => void; notes: Note[]; setNotes: (f: (n: Note[]) => Note[]) => void; annotating: boolean; /** A message went to the agent: pointing is over. */ onSent: () => void; toast: (text: string) => void; /** The panel fills the window, the workspace hidden behind it. */ full: boolean; onFull: (on: boolean) => void; /** Takes away what an agent highlighted in the workspaces on screen. */ clearHighlights: () => void; /** The short texts the workspaces on screen show, for voice mode to listen for. */ screenWords: () => Promise<string[]>; /** It floats over the workspace instead of sitting beside it (Appearance), with its tabs in a bar along the bottom of the window. */ floating?: boolean; /** Floating, whether it is open over the workspace; closed, only the bar shows. */ shown?: boolean; /** Opens it over the workspace, from a tab in the bar. */ onShow?: () => void }>(function AgentPanel({ tone, onTabs, ws, onScreen, state, onBusy, onClose, notes, setNotes, annotating, onSent, toast, full, onFull, clearHighlights, screenWords, floating, shown = true, onShow }, ref) {
  // The tabs' shortcut hints follow the keys set in settings.
  useShortcuts()
  // New conversations not sent yet have tabs of their own, after the others.
  const [blanks, setBlanks] = useState<string[]>(() => kept.blanks ?? (localStorage.getItem(CURRENT) ? [] : [blankKey()]))
  // New conversations that open on something the agent says (after the first-run screen), by tab, with what it is told about them.
  const [welcomes, setWelcomes] = useState<Record<string, { intro?: string; made: string[]; connected: string[] }>>(() => kept.welcomes)
  // The tab on screen: a conversation's id, or a new one's key (BLANK).
  const [current, setCurrent] = useState<string>(() => kept.current ?? localStorage.getItem(CURRENT) ?? blanks[0]!)
  const sessionId = isBlank(current) ? null : current
  // The conversations open as tabs. Closing one only takes it off the strip: it keeps going, and History brings it back.
  const [tabs, setTabs] = useState<string[]>(() => {
    const saved = JSON.parse(localStorage.getItem(TABS) ?? 'null')
    const current = localStorage.getItem(CURRENT)
    return Array.isArray(saved) ? saved : current ? [current] : []
  })
  useEffect(() => {
    localStorage.setItem(TABS, JSON.stringify(tabs))
  }, [tabs])
  // What can be @ mentioned: the workspaces, then the connectors the user added. A name both have is the workspace's.
  const mentions: Mention[] = [
    ...state.workspaces.filter((w) => !w.archived).map((w): Mention => ({ kind: 'workspace', id: w.id, name: w.name, text: `@${w.name}`, icon: (size) => <WorkspaceIcon icon={w.icon} color={w.color} size={size} /> })),
    ...state.connectors.filter((c) => !c.native).map((c): Mention => ({ kind: 'connector', id: c.id, name: c.name, text: `@${c.name}`, icon: (size) => <Logo connector={c} size={size} /> })),
  ]
  // In a mark the icon stands in for the @, so it is no wider than one.
  const marks: Mark[] = mentions.map((m) => ({ text: m.text, icon: m.icon(11), title: m.kind === 'workspace' ? `${m.name} goes with your message` : `The ${m.name} connector` }))
  // A title leaves out the mentions a message starts with (a new one starts with the workspace on screen): the list shows those.
  // With nothing after them, a note pointed at names it, or else the mentions do.
  const untitled = (text: string) => {
    let at = 0
    for (const r of markRanges(text, mentions.map((m) => m.text))) if (!text.slice(at, r.start).trim()) at = r.end
    return text.slice(at).trim()
  }
  // What is typed in each tab, so switching tabs does not lose it, by the tab's key.
  // Until something is typed there, it mentions the workspaces on screen, and follows them.
  // Kept from before the panel was last drawn, except a new conversation's with nothing past its mentions: it mentions the ones on screen now.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(kept.drafts ?? {}).filter(([key, text]) => !isBlank(key) || untitled(text))))
  useEffect(() => {
    Object.assign(kept, { drafts, blanks, current, welcomes })
  }, [drafts, blanks, current, welcomes])
  const onScreenMentions = onScreen.map((id) => state.workspaces.find((w) => w.id === id)).filter((w): w is WorkspaceInfo => !!w)
  const opening = onScreenMentions.length ? `${onScreenMentions.map((w) => `@${w.name}`).join(' ')} ` : ''
  // There is one onboarding conversation. Until it starts, a new conversation with the checklist alone on screen opens on
  // the agent's greeting, and its first message starts it; not one a page filled in (a schedule asked for, a fix), which
  // is an ordinary conversation, except the checklist's own reply to the greeting.
  const [onboarded, setOnboarded] = useState(() => !!onboardingSession())
  const composed = useRef(kept.composed)
  const onboardingWs = onScreenMentions.length === 1 && onScreenMentions[0]!.onboarding ? onScreenMentions[0] : undefined
  /** Whether a message sent from this tab now starts the onboarding conversation. Read when it goes: a page can fill the box and send in one step. */
  const greetsAt = (key: string) => !!onboardingWs && !onboardingSession() && isBlank(key) && !composed.current.has(key)
  const greets = !onboarded && greetsAt(current)
  // Tabs that showed the greeting: a reply written in one goes to the onboarding conversation even if a connection started it meanwhile.
  const greeted = useRef(kept.greeted)
  if (greets) greeted.current.add(current)
  const draft = drafts[current] ?? (sessionId ? '' : opening)
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [current]: text }))
  /** A tab's draft goes: a new conversation's goes back to its opening mentions. */
  const dropDraft = (key: string) => setDrafts(({ [key]: _, ...others }) => others)
  const [harness, setHarness] = useState(() => localStorage.getItem('sb.agent.harness') ?? 'claude')
  const [starting, setStarting] = useState(false)
  // The list of past conversations, shown in place of the current one.
  const [listing, setListing] = useState(false)
  // What the message mentions, where in it, and the workspaces and connectors that makes it about.
  const ranges = markRanges(draft, mentions.map((m) => m.text))
  const inDraft = [...new Set(ranges.map((r) => mentions.find((m) => m.text === r.mark)!))]
  /** What a new conversation's tab has in it, past the mentions it opens with. */
  const typed = (key: string) => untitled(drafts[key] ?? '')
  // The new conversation that asking for one goes to: beside the workspace, an empty one; floating, any not sent yet, typed in
  // or not, as none has a tab until its first message goes (the Agent button stands for it).
  const unsent = (key: string) => isBlank(key) && ((!!floating && !full) || !typed(key))
  const tagged = inDraft.filter((m) => m.kind === 'workspace').map((m) => state.workspaces.find((w) => w.id === m.id)!)
  const taggedConnectors = inDraft.filter((m) => m.kind === 'connector').map((m) => state.connectors.find((c) => c.id === m.id)!)
  const where = (n: Note) => whereOf(n, onScreen.length > 1 ? (state.workspaces.find((w) => w.id === n.workspace)?.name ?? '') : '')
  // A conversation not started yet already has its draft name, so its first message can carry it: one for each new tab.
  const fresh = useRef(kept.fresh)
  const freshOf = (key: string) => (fresh.current[key] ??= newDraftName())
  const session = useSession(sessionId)
  const { sessions, error: listError, reload: reloadList } = useSessions({ kind: 'agent' })
  // Tabs whose conversation was archived or is gone close. The one on screen stays: a new one may not be listed yet.
  useEffect(() => {
    if (sessions) setTabs((t) => (t.every((id) => id === sessionId || sessions.some((s) => s.id === id && !s.archived_at)) ? t : t.filter((id) => id === sessionId || sessions.some((s) => s.id === id && !s.archived_at))))
  }, [sessions])
  const { providers } = useProviders()
  const { info, reload: reloadInfo } = useSessionInfo(sessionId)
  // The onboarding conversation's connections are told to it from one place (onboarding.ts), on screen or not.
  const onboardingHere = !!sessionId && (sessionId === onboardingSession() || !!info?.session.labels.onboarding)
  const draftName = sessionId ? (info?.session.labels.conversation ?? localStorage.getItem(draftKey(sessionId)) ?? `c-${sessionId.replace(/-/g, '').slice(0, 10)}`) : freshOf(current)
  // The agent is fixed once a conversation starts; its model can change with any message.
  // One picked before that is no longer there (uninstalled, or the test agent) gives way to the first that is.
  const activeHarness = info?.session.harness ?? (providers.length && !providers.some((p) => p.name === harness) ? providers[0]!.name : harness)
  // What was last picked for each agent; until something is, the agent's own default model and effort.
  const [picked, setPicked] = useState<Record<string, { model?: string; effort?: string }>>(() => {
    const saved = JSON.parse(localStorage.getItem('sb.agent.choice') ?? 'null')
    // Before effort levels, only a model id was kept per agent.
    return saved ?? Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem('sb.agent.models') ?? '{}') as Record<string, string>).map(([h, id]) => [h, { model: id }]))
  })
  const { model, effort, models, efforts } = chooseModel(providers.find((p) => p.name === activeHarness), picked[activeHarness], info?.session)
  const pick = (choice: { model?: string; effort?: string }) => {
    const next = { ...picked, [activeHarness]: { ...picked[activeHarness], ...choice } }
    localStorage.setItem('sb.agent.choice', JSON.stringify(next))
    setPicked(next)
  }
  // What the agent may do without asking, the same for every agent and conversation: auto until the user picks otherwise.
  // Like the model, it applies from the next message, so a conversation started in one mode can go on in another.
  const offered = providers.find((p) => p.name === activeHarness)?.capabilities?.permission_modes
  const modes = (Object.keys(PERMISSIONS) as PermissionMode[]).filter((m) => !offered || offered.includes(m))
  const [pickedPermission, setPickedPermission] = useState(() => localStorage.getItem('sb.agent.permission') as PermissionMode | null)
  const permission: PermissionMode = (pickedPermission && modes.includes(pickedPermission) ? pickedPermission : null) ?? info?.session.permission_mode ?? (modes.includes('auto') ? 'auto' : (modes[0] ?? 'auto'))
  const pickPermission = (mode: PermissionMode) => {
    localStorage.setItem('sb.agent.permission', mode)
    setPickedPermission(mode)
  }
  const busy = session.busy || starting
  // What was said aloud and is on its way, shown in the tab it went from as soon as it goes, until that conversation
  // has it: correcting it already took a moment, and the agent may take another before the conversation shows it.
  const onTheirWay = useOutgoing()
  useEffect(() => outgoing.settle(sessionId, session.events), [sessionId, session.events, onTheirWay])
  const here = onTheirWay.filter((o) => o.tab === current)
  const outgoingHere = here.length ? here.map((o) => <OutgoingMessage key={o.key} text={o.text} marks={marks} />) : undefined
  const queued = useQueues()[sessionId ?? ''] ?? []
  // Stopped by the user, the queue waits; stopped to steer, the message it was stopped for goes.
  const paused = HOLDS.includes(session.status) && !busy && !queued[0]?.now
  // The panel's left edge drags to resize; the width is the same for every workspace.
  const [width, setWidth] = useState(() => Number(localStorage.getItem('sb.agent.width')) || 420)
  // It leaves the workspace its room, beside the sidebar when there is one.
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, 320), Math.max(320, window.innerWidth - sideWidth() - WORKSPACE_ROOM)))
  // Floating, it sits above the bar at the workspace's bottom right: its top and left edges, and the corner between them, drag to resize it.
  const [floatSize, setFloatSize] = useState<{ w?: number; h?: number }>(() => {
    try {
      return JSON.parse(localStorage.getItem(FLOAT_SIZE) ?? '{}') ?? {}
    } catch {
      return {}
    }
  })
  // While an edge is dragged: which, what holds still (the floating panel's right and bottom), how far it may grow, and where
  // the pointer took hold, so the edge stays under it rather than jumping to it.
  const [resizing, setResizing] = useState<{ by: Drag; right: number; bottom: number; maxW: number; maxH: number; grabX: number; grabY: number } | null>(null)
  const startResize = (by: Drag) => (e: React.MouseEvent) => {
    e.preventDefault()
    // The second press of a double-click puts the size back.
    if (e.detail >= 2) {
      if (by === 'dock') localStorage.removeItem('sb.agent.width'), setWidth(420)
      else localStorage.removeItem(FLOAT_SIZE), setFloatSize({})
      return
    }
    const box = panelRef.current!.getBoundingClientRect()
    const body = panelRef.current!.parentElement!.getBoundingClientRect()
    setResizing({ by, right: box.right, bottom: box.bottom, maxW: box.right - body.left - FLOAT_GAP, maxH: box.bottom - body.top - FLOAT_GAP, grabX: e.clientX - box.left, grabY: e.clientY - box.top })
  }
  const resize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing) return
    if (resizing.by === 'dock') {
      const w = clamp(window.innerWidth - INSET - e.clientX)
      localStorage.setItem('sb.agent.width', String(w))
      return setWidth(w)
    }
    const r = resizing
    setFloatSize((s) => {
      const next = { ...s, ...(r.by !== 'y' ? { w: Math.round(Math.min(Math.max(r.right - (e.clientX - r.grabX), 320), r.maxW)) } : {}), ...(r.by !== 'x' ? { h: Math.round(Math.min(Math.max(r.bottom - (e.clientY - r.grabY), 240), r.maxH)) } : {}) }
      localStorage.setItem(FLOAT_SIZE, JSON.stringify(next))
      return next
    })
  }

  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy])

  /**
   * Shows a tab: a conversation (whose tab opens if it was not), or a new conversation's, by its key. Voice mode talks to
   * the tab it was turned on in: another tab on screen turns it off, unless this is the conversation that tab just started.
   */
  const openConversation = (id: string, conversation?: string, startedHere = false) => {
    if (id !== current && !startedHere) voice.stop()
    if (isBlank(id)) {
      localStorage.removeItem(CURRENT)
      setBlanks((b) => (b.includes(id) ? b : [...b, id]))
    } else {
      localStorage.setItem(CURRENT, id)
      if (conversation) localStorage.setItem(draftKey(id), conversation)
      setTabs((t) => (t.includes(id) ? t : [...t, id]))
    }
    setCurrent(id)
    setListing(false)
  }
  // This panel takes over conversations started from its tabs, from any panel before it, while it is on screen.
  const me = useRef({})
  handOff.owner = me.current
  handOff.started = (from, id, name) => {
    setWelcomes(({ [from]: _, ...others }) => others)
    setBlanks((b) => b.filter((x) => x !== from))
    outgoing.move(from, id)
    openConversation(id, name, true)
    dropDraft(from)
    delete fresh.current[from]
    void reloadList()
  }
  useEffect(
    () => () => {
      if (handOff.owner === me.current) handOff.started = handOff.owner = undefined
    },
    [],
  )
  /** Takes a conversation off the strip, without stopping it. The tab beside it takes its place on screen; with none left, a new conversation's. */
  const closeTab = (id: string) => {
    const strip = [...tabs, ...blanks]
    const rest = strip.filter((k) => k !== id)
    if (isBlank(id)) setBlanks((b) => b.filter((x) => x !== id))
    else setTabs((t) => t.filter((x) => x !== id))
    dropDraft(id)
    if (id !== current) return
    openConversation(rest.length ? rest[Math.min(strip.indexOf(id), rest.length - 1)]! : blankKey())
  }

  const files = useAttachments()
  // Files attached before the panel was last drawn come back; one still on its way up starts again.
  const filesNow = useRef(files.items)
  filesNow.current = files.items
  useEffect(() => {
    const back = kept.files
    kept.files = []
    files.restore(back.filter((d) => d.staged || d.error))
    const unstaged = back.filter((d) => !d.staged && !d.error)
    if (unstaged.length) files.add(unstaged.map((d) => d.file))
    return () => {
      kept.files = filesNow.current
    }
  }, [])
  /** A message as the agent gets it: what was typed, and what the panel adds for it. */
  const compose = (text: string, attachedFiles: Attachment[], voiced = false, heardAs?: string) => {
    // Said aloud and written in, then sent by hand, it is still said aloud.
    if (dictated.current.delete(current)) voiced = true
    const sent = notes
    onSent()
    // Files can go on their own too; the engine wants some words with them.
    const lead = text || (attachedFiles.length && !sent.some((n) => n.note) ? `Take a look at ${attachedFiles.length === 1 ? 'this file' : 'these files'}.` : 'Do what my notes ask.')
    // What the agent cannot see for itself: the workspaces this is about and the state they are in right now.
    const name = (id: string) => state.workspaces.find((w) => w.id === id)?.name ?? id
    // What the notes mention counts as mentioned in the message.
    const inNotes = sent.flatMap((n) => markRanges(n.note, mentions.map((m) => m.text)).map((r) => mentions.find((m) => m.text === r.mark)!))
    const noteWorkspaces = state.workspaces.filter((w) => inNotes.some((m) => m.kind === 'workspace' && m.id === w.id))
    const connectors = [...new Set([...taggedConnectors, ...state.connectors.filter((c) => inNotes.some((m) => m.kind === 'connector' && m.id === c.id))])]
    // The workspaces mentioned, and the ones the notes were put in, mentioned or not.
    const about = [...new Set([...tagged, ...noteWorkspaces, ...state.workspaces.filter((w) => sent.some((n) => n.workspace === w.id))])]
    const prompt = [lead, sent.length ? pointedAt(sent, name) : '', attached(about, onScreen, ws?.id ?? '', draftName), mentioned(connectors), voiced ? voicedNote(!!state.voice?.speak, heardAs) : ''].filter(Boolean).join('\n\n')
    const done = () => setNotes((n) => n.filter((x) => !sent.includes(x)))
    return { sent, lead, prompt, done }
  }
  /** `/login` on its own (beside the workspaces mentioned) is not for the agent: it signs in to it. */
  const isLogin = (text: string, attachedFiles: Attachment[]) =>
    !attachedFiles.length &&
    /^\/login$/i.test(
      markRanges(text, mentions.map((m) => m.text))
        .reduceRight((t, r) => t.slice(0, r.start) + t.slice(r.end), text)
        .trim(),
    )
  // The agent being signed in to, from /login or a turn that failed for want of it: a card above the box.
  const [signingIn, setSigningIn] = useState<string | null>(null)
  const login = () => {
    if (!sessionId) dropDraft(current)
    const p = providers.find((x) => x.name === activeHarness)
    if (!p?.sign_in && !p?.login_command) return toast(`${harnessName(activeHarness)} has no way to sign in from here.`)
    setSigningIn(activeHarness)
  }
  const signingInto = providers.find((p) => p.name === signingIn)
  /** While the conversation works, a message waits its turn. What it is about is fixed now, as it would be if it went now. */
  const enqueue = (text: string, attachedFiles: Attachment[] = [], now = false, voiced = false, heardAs?: string) => {
    if (!sessionId) return
    if (isLogin(text, attachedFiles)) return login()
    const { sent, lead, prompt, done } = compose(text, attachedFiles, voiced, heardAs)
    const item: Queued = { id: Math.random().toString(36).slice(2, 10), text: text || sent.find((n) => n.note)?.note || lead, prompt, context: prompt.slice(lead.length), files: attachedFiles, model: model || undefined, effort: effort || undefined, permission }
    queue.add(sessionId, item)
    done()
    if (now) void steer(item)
  }
  /**
   * Steers: stops what the agent is doing and sends this message next, ahead of the rest of the
   * queue. Not while a queued message is on its way: the turn it starts is the one that would stop.
   */
  const steer = async (item: Queued) => {
    if (!sessionId || queued.some((x) => x.sending)) return
    const id = sessionId
    queue.steer(id, item.id)
    if (!session.busy) return
    try {
      // A turn just begun may not be known here yet; the engine knows it.
      const run = session.runId ?? (await agents.info(id)).latest_run?.id
      if (!run) throw new Error('No turn to stop')
      await agents.cancel(run)
    } catch (e) {
      queue.unsteer(id, item.id)
      toast(`Could not stop the agent: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const send = async (text: string, attachedFiles: Attachment[] = [], voiced = false, heardAs?: string) => {
    if (isLogin(text, attachedFiles)) return login()
    const { sent, lead, prompt, done } = compose(text, attachedFiles, voiced, heardAs)
    // What is picked always goes: what is known of the session can be out of date (a queued message may have changed it).
    if (sessionId) return session.send(prompt, { model: model || undefined, effort: effort || undefined, permission, attachments: attachedFiles }).then((run) => (done(), void reloadInfo(), run?.id))
    // The new conversation's tab becomes this conversation's, whichever tab is on screen once it has started.
    const from = current
    const name = freshOf(from)
    // Pointed at, it is about the page, not the greeting.
    const welcome = welcomes[from]
    if (!welcome && (greetsAt(from) || (!!onboardingWs && greeted.current.has(from) && !composed.current.has(from))) && !sent.length) return sendOnboarding(text, prompt, attachedFiles, done)
    setStarting(true)
    try {
      // Opened on the agent's word after the first-run screen: it keeps that word, and knows what was made and connected.
      const welcomed: { labels: Record<string, string>; rules: string } = welcome ? { labels: welcome.intro ? { intro: welcome.intro.slice(0, 600) } : {}, rules: welcomeRules({ ...welcome, agentDir: state.agentDir, harness: activeHarness }) } : { labels: {}, rules: '' }
      const r = await agents.start({ prompt, harness: activeHarness, model: model || undefined, effort: effort || undefined, cwd: state.agentDir, permission, attachments: attachedFiles, labels: { kind: 'agent', title: ((untitled(text) !== POINT_SEND && untitled(text)) || sent.find((n) => n.note)?.note || text || lead).replace(/\s+/g, ' ').trim().slice(0, 80), conversation: name, ...(tagged[0] ? { workspace: tagged[0].id } : {}), ...welcomed.labels }, instructions: instructions(state.settings.designSystem) + welcomed.rules })
      startedFrom(from, r.session.id, name)
      done()
      return r.run?.id
    } finally {
      setStarting(false)
    }
  }
  /** Starts the onboarding conversation with this message; or, when it has started or is starting (a connection got there first), sends the message to it. */
  /** `name` is the conversation's draft name, the one its first message already gives the agent. */
  const startOnboarding = async (title: string, message: string, attachedFiles: Attachment[], name = newDraftName()) => {
    let prompt = message
    // The turn the message started, when this starts the conversation.
    let run: string | undefined
    const r = await beginOnboarding(async () => {
      const s = await agents.start({ prompt, harness: activeHarness, model: model || undefined, effort: effort || undefined, cwd: state.agentDir, permission, attachments: attachedFiles, labels: { kind: 'agent', title: title.replace(/\s+/g, ' ').trim().slice(0, 80), conversation: name, onboarding: '1', ...(onboardingWs ? { workspace: onboardingWs.id } : {}) }, instructions: instructions(state.settings.designSystem) + onboardingRules(state.agentDir, activeHarness) })
      run = s.run?.id
      return s.session.id
    })
    if (r.started) {
      setOnboarded(true)
      return { id: r.id, name, run }
    }
    // It joins a conversation that has a draft of its own: the message names that one.
    const theirs = (await agents.info(r.id).catch(() => null))?.session.labels.conversation
    if (theirs && theirs !== name) prompt = prompt.replaceAll(name, theirs)
    queue.add(r.id, { id: Math.random().toString(36).slice(2, 10), text: title, prompt, files: attachedFiles, model: model || undefined, effort: effort || undefined, permission })
    setOnboarded(true)
    return { id: r.id, name: theirs ?? undefined, run: undefined }
  }
  /** The user's first message from the greeting. */
  const sendOnboarding = async (text: string, prompt: string, attachedFiles: Attachment[], done: () => void) => {
    const from = current
    setStarting(true)
    try {
      const r = await startOnboarding(untitled(text) || text, prompt, attachedFiles, freshOf(from))
      startedFrom(from, r.id, r.name)
      done()
      return r.run
    } finally {
      setStarting(false)
    }
  }
  /** A message the app wrote, for a connection made outside the conversation: it starts the onboarding conversation, in place of the greeting's tab when nothing is typed there. Resolves to whether the conversation has it. */
  const onboard = async (text: string) => {
    const from = current
    try {
      const known = onboardingSession()
      if (known) return (tellOnboarding(known, text), true)
      const r = await startOnboarding(text, text, [])
      if (isBlank(from) && !typed(from)) {
        setBlanks((b) => b.filter((x) => x !== from))
        dropDraft(from)
      }
      openConversation(r.id, r.name)
      void reloadList()
      return true
    } catch (e) {
      toast(`The agent did not start: ${e instanceof Error ? e.message : String(e)}. Lynx will try again in a minute.`)
      return false
    }
  }
  /** Takes a queued message back into the box, with its files, ahead of anything typed there. */
  const unqueue = (q: Queued) => {
    if (!sessionId) return
    queue.remove(sessionId, q.id)
    const text = leadOf(q)
    setDraft(draft.trim() ? `${text}\n${draft}` : text)
    files.put(q.files)
    caretNext.current = text.length
  }
  const panelRef = useRef<HTMLElement>(null)
  const fieldEl = () => panelRef.current?.querySelector<HTMLTextAreaElement>('.sb-composer textarea')
  // The keyboard goes to the field, after what is in it.
  const focusField = () => {
    const el = fieldEl()
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }
  // Where the caret is in the field, when nothing is selected.
  const [caret, setCaret] = useState<number | null>(null)
  const onSelect = (e: React.SyntheticEvent) => {
    const el = e.target
    if (el instanceof HTMLTextAreaElement) setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  }
  // Where the caret goes once a change made here is in the field.
  const caretNext = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = caretNext.current
    const el = fieldEl()
    if (at === null || !el) return
    caretNext.current = null
    el.focus()
    el.setSelectionRange(at, at)
    setCaret(at)
  }, [draft])
  /** Replaces part of what is typed, and leaves the caret after what went in. */
  const splice = (start: number, end: number, put: string) => {
    caretNext.current = start + put.length
    setDraft(draft.slice(0, start) + put + draft.slice(end))
  }
  // @ before the caret offers the workspaces and connectors to mention, narrowed by what follows it;
  // Escape puts the offer away until the text changes.
  const typedAt = caret === null ? null : typedMention(draft.slice(0, caret))
  const [mentionAt, setMentionAt] = useState(0)
  const [mentionOff, setMentionOff] = useState<string | null>(null)
  const query = typedAt?.[2]!.toLowerCase() ?? ''
  const mentionMatches = typedAt ? mentions.filter((m) => !inDraft.includes(m) && m.name.toLowerCase().includes(query)).sort((a, b) => Number(!onScreen.includes(a.id)) - Number(!onScreen.includes(b.id))) : []
  const mention = typedAt && mentionMatches.length && draft !== mentionOff ? { matches: mentionMatches, at: Math.min(mentionAt, mentionMatches.length - 1) } : null
  const mentionPick = (m: Mention) => {
    if (caret === null || !typedAt) return
    // The @ and what was typed after it become the mention, with a space after it unless one is there.
    setMentionAt(0)
    splice(caret - typedAt[2]!.length - 1, caret, draft[caret] === ' ' ? m.text : `${m.text} `)
  }
  const mentionKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // A mention goes as a whole: Backspace at its end (or in it) takes it all, and so does Delete at its start.
    const el = e.currentTarget
    if ((e.key === 'Backspace' || e.key === 'Delete') && el.selectionStart === el.selectionEnd && !e.metaKey && !e.altKey && !e.ctrlKey) {
      const at = el.selectionStart
      const hit = ranges.find((r) => (e.key === 'Backspace' ? at > r.start && at <= r.end : at >= r.start && at < r.end))
      if (hit) {
        e.preventDefault()
        return splice(hit.start, hit.end, '')
      }
    }
    if (!mention) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setMentionAt((mention.at + (e.key === 'ArrowDown' ? 1 : -1) + mention.matches.length) % mention.matches.length)
    } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      mentionPick(mention.matches[mention.at]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setMentionOff(draft)
    }
  }
  // A review runs where the template is, on its own instructions. Read-only, it gets no connectors either:
  // the code it reads cannot talk it into running anything or reaching the user's data.
  const review = async (r: ReviewStart) => {
    const conversation = newDraftName()
    const labels = { kind: 'agent', title: r.title, conversation, ...r.labels }
    setStarting(true)
    try {
      const template = r.labels.review?.split(':')
      const s = template
        ? await app<{ session: { id: string } }>('marketplace_review_start', { source: template[0], item: template[1], harness: r.harness, model: r.model, effort: r.effort, conversation })
        : r.readOnly
        ? await call<{ session: { id: string } }>('agents', 'session_start', { harness: r.harness, prompt: r.prompt, cwd: r.cwd, connection_ids: [], labels, config: { permission_mode: 'deny', instructions: r.instructions, ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) } })
        : await agents.start({ prompt: r.prompt, harness: r.harness, model: r.model || undefined, effort: r.effort || undefined, cwd: r.cwd, permission: 'allow', labels, instructions: r.instructions })
      openConversation(s.session.id, conversation)
      void reloadList()
    } catch (e) {
      toast(`The conversation did not start: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setStarting(false)
    }
  }
  // Already in a new conversation (unsent), its tab flashes to say so (floating, the Agent button, which stands for it), and the
  // keyboard goes to its field. Elsewhere, that new conversation shows: what was on screen keeps its tab. One already there
  // flashes the same way, as it is not a new one.
  const [flash, setFlash] = useState(0)
  const newThread = () => {
    if (unsent(current) && !listing) return (focusField(), setFlash((n) => n + 1))
    const there = blanks.find(unsent)
    openConversation(there ?? blankKey())
    if (there) setFlash((n) => n + 1)
  }
  const continueInTerminal = async () => {
    try {
      const s = await agents.providerSession(sessionId!)
      const command = providers.find((p) => p.name === s.harness)?.resume_command
      if (!command) return toast(`${harnessName(s.harness)} has no command to continue a conversation in a terminal.`)
      if (!s.provider_session_id) return toast(`${harnessName(s.harness)} has not started this conversation yet. Try again once it has replied.`)
      await navigator.clipboard.writeText(resumeCommand(command, s.cwd, s.provider_session_id))
      toast('Copied command. Paste in your terminal.')
    } catch (e) {
      toast(`Could not copy the command: ${(e as Error).message}`)
    }
  }
  // Voice mode: what is said goes to this conversation (queued while it works), and its replies are read out.
  /** The small model that corrects what was heard for this conversation's agent: Haiku on Claude, Luna on Codex. */
  const fixModel = () => {
    if (activeHarness === 'claude') return { harness: 'claude', model: 'haiku' }
    if (activeHarness === 'codex') return { harness: 'codex', model: providers.find((p) => p.name === 'codex')?.models?.find((m) => /luna/i.test(m.id))?.id ?? 'gpt-6-luna' }
    return null
  }
  const fixWarned = useRef(false)
  const talking = useVoice().phase !== 'off'
  const voiceOn = !!state.voice?.enabled
  // Sent by hand, what is said is written into the tab's message box; the tabs it was written in send it as said aloud.
  const dictated = useRef(new Set<string>())
  const dictate = (text: string) => {
    setDrafts((d) => {
      const was = d[current] ?? (sessionId ? '' : opening)
      return { ...d, [current]: was.trim() ? `${was.replace(/\s+$/, '')} ${text}` : `${was}${text}` }
    })
    dictated.current.add(current)
    focusField()
  }
  const live = useRef({ send, enqueue, busy, sessionId, session, toast, clear: clearHighlights, speak: state.voice?.speak, state, screenWords, fixer: fixModel(), dictate, dictated: false, tab: current, shown })
  live.current = { send, enqueue, busy, sessionId, session, toast, clear: clearHighlights, speak: state.voice?.speak, state, screenWords, fixer: fixModel(), dictate, dictated: dictated.current.has(current) && !!draft.trim(), tab: current, shown }
  useEffect(
    () =>
      voice.connect({
        heard: async (text, heardAs) => {
          const l = live.current
          if (l.busy && l.sessionId) return void l.enqueue(text, [], false, true, heardAs)
          // In the conversation straight away, corrected: the agent's copy replaces it once the conversation has it.
          const key = outgoing.add(l.tab, text)
          try {
            outgoing.sent(key, (await l.send(text, [], true, heardAs)) ?? undefined)
          } catch (e) {
            outgoing.drop(key)
            throw e
          }
        },
        correct: async (text) => {
          const l = live.current
          const terms = await vocabularyNow(l.state, l.session.events, l.screenWords)
          // A small model puts it right; with none for this conversation's agent (the test agent), the vocabulary does.
          if (!l.fixer) {
            const r = correctHeard(text, terms)
            return r.changes.length ? { text: r.text, heardAs: text } : { text }
          }
          try {
            const fixed = await bridge.voice.fix({ ...l.fixer, text, names: terms.slice(0, 150).map((t) => t.text) })
            return wordsOf(fixed) === wordsOf(text) ? { text } : { text: fixed, heardAs: text }
          } catch (e) {
            if (!fixWarned.current) l.toast(fixFailed(l.fixer.model, e instanceof Error ? e.message : String(e)))
            fixWarned.current = true
            return { text }
          }
        },
        warm: () => {
          const l = live.current
          if (l.fixer) void bridge.voice.warmFix(l.fixer).catch(() => undefined)
        },
        reply: async () => {
          const events = live.current.session.events
          const last = events.findLastIndex((e) => e.type === 'assistant_message')
          if (last < 0 || events.slice(last).some((e) => e.type === 'user_message')) return undefined
          const e = events[last]! as typeof events[number] & { payload_truncated?: boolean }
          return e.payload_truncated ? String((await fullPayload(live.current.sessionId!, e.seq))?.text ?? '') : String(e.payload?.text ?? '')
        },
        speaks: () => !!live.current.speak,
        present: () => document.hasFocus() && live.current.shown,
        listensAway: () => !!live.current.state.voice?.listenAway,
        autoSends: () => live.current.state.voice?.autoSend !== false,
        dictate: (text) => live.current.dictate(text),
        waiting: () => !!live.current.dictated,
        clear: () => live.current.clear(),
        toast: (text) => live.current.toast(text),
      }),
    [],
  )
  // A conversation still loading is not idle yet: it would look like a turn that just ended.
  useEffect(() => {
    if (!sessionId || !session.loading) voice.report(busy)
  }, [busy, session.loading, sessionId])
  useImperativeHandle(ref, () => ({
    // What a workspace asks of the agent (its Ask the agent, a build error's Fix it) is about the workspaces on screen.
    compose: (prompt) => {
      setListing(false)
      if (prompt !== ONBOARDING_REPLY) composed.current.add(current)
      const text = markRanges(prompt, mentions.map((m) => m.text)).length ? prompt : `${opening}${prompt}`
      // Workspace messages can only prepare a draft. Sending requires a user action in this panel.
      setDraft(text)
    },
    sendPoint: () => {
      setListing(false)
      composed.current.add(current)
      const text = `${opening}${POINT_SEND}`
      if (!busy) void send(text).catch(() => setDraft(text))
      else setDraft(text)
    },
    newThread: () => void (starting || newThread()),
    closeTab: () => (strip.length === 1 && sessionId === null ? onClose() : closeTab(current)),
    showTab: (i) => i < strip.length && openConversation(strip[i]!),
    cycleTab: (by) => strip.length > 1 && openConversation(strip[(strip.indexOf(current) + by + strip.length) % strip.length]!),
    review: (r) => void review(r),
    publish: (w, template) => {
      void review(publishOf(w, { harness: activeHarness, model, effort, access: 'full' }, template))
    },
    open: (id, conversation, opts) => {
      setListing(false)
      if (opts?.replaceBlank && isBlank(current) && !typed(current)) setBlanks((b) => b.filter((x) => x !== current))
      openConversation(id, conversation)
    },
    onboard: (text) => onboard(text),
    welcome: (end) => {
      setListing(false)
      const key = blankKey()
      // Not the checklist's greeting: this tab opens on its own word.
      composed.current.add(key)
      setWelcomes((w) => ({ ...w, [key]: { intro: end.intro, made: end.made, connected: end.connected } }))
      if (end.draft) setDrafts((d) => ({ ...d, [key]: end.draft! }))
      // An empty new conversation on screen gives way to this one.
      if (isBlank(current) && !typed(current)) setBlanks((b) => [...b.filter((x) => x !== current), key])
      else setBlanks((b) => [...b, key])
      openConversation(key)
    },
  }))
  const engineReady = state.engine.status === 'ready'
  // Notes can be sent on their own; things only pointed at need a message to say what about them.
  const noted = notes.some((n) => n.note)

  // The strip, left to right: the open conversations, then a new one when there is one.
  // Floating, a new conversation has no tab until its first message goes: the Agent button is its way in.
  const strip = [...tabs, ...blanks].filter((k) => !(floating && !full && isBlank(k)))
  const summary = (id: string) => sessions?.find((s) => s.id === id)
  const titleOf = (id: string) => (isBlank(id) ? said(typed(id)) || 'New tab' : said(summary(id)?.labels.title || (id === sessionId ? info?.session.labels.title : undefined)) || said(summary(id)?.preview) || 'Conversation')
  const working = (id: string) => (id === current ? busy : !isBlank(id) && isBusy(summary(id)?.status ?? ''))
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    stripRef.current?.querySelector('.h-agent-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [current, strip.length, flash])
  // A new conversation on screen is for typing in: the keyboard goes to its field.
  useEffect(() => {
    if (sessionId === null && !listing) focusField()
  }, [current, listing])
  // Opened over the workspace, the keyboard goes to its field.
  useEffect(() => {
    if (floating && shown && !listing) focusField()
  }, [shown])
  const back = floating ? 'Back over the workspace' : 'Back beside the workspace'
  // Floating, the tabs are in the bar along the bottom of the window, and the panel's header names the one on screen.
  const floats = !!floating && !full
  // Docked, drawn again as the window or the sidebar changes, so it leaves the workspace its room.
  useRoom([width, floats, full, shown])
  /** A tab picked in the bar opens the panel on it; the one already open closes it. */
  const pickTab = (id: string) => {
    if (!floats) return openConversation(id)
    if (shown && id === current && !listing) return onClose()
    openConversation(id)
    onShow?.()
  }
  const tabStrip = (
    <div
      ref={stripRef}
      className="h-agent-tabs h-nodrag"
      role="tablist"
      aria-label="Open conversations"
      // A mouse wheel scrolls the strip sideways.
      onWheel={(e) => Math.abs(e.deltaY) > Math.abs(e.deltaX) && (e.currentTarget.scrollLeft += e.deltaY)}
    >
      {strip.map((id, i) => {
        const title = titleOf(id)
        // The only tab, a new conversation, has nothing to close to.
        const closable = !(isBlank(id) && strip.length === 1)
        // ⌘1–8 by place and ⌘9 the last, as App's commands have them.
        const n = i < 8 ? i + 1 : i === strip.length - 1 ? 9 : 0
        const combo = n ? comboFor(`agent-tab-${n}`) : undefined
        return (
          <div key={id === current && flash ? `${id}-${flash}` : id} className={`h-agent-tab${id === current ? ' on' : ''}${id === current && flash ? ' flash' : ''}`} onAnimationEnd={() => setFlash(0)}>
            <button role="tab" aria-selected={id === current} title={titled(title, combo)} onClick={() => pickTab(id)} onAuxClick={(e) => e.button === 1 && closable && closeTab(id)}>
              {working(id) && <span className="sb-spinner" aria-label="Working" />}
              <span className="h-agent-tab-title">{title}</span>
            </button>
            {/* Its shortcut, faint, where the close button is until the pointer comes to it. */}
            {(closable || (combo && id !== current)) && (
              <span className="h-agent-tab-end">
                {combo && id !== current && (
                  <kbd className="h-agent-tab-key" aria-hidden>
                    {keys(combo)}
                  </kbd>
                )}
                {closable && (
                  <button className="h-agent-tab-x" onClick={() => closeTab(id)} aria-label={`Close ${title}`} title={working(id) ? 'Close the tab. It keeps working; History brings it back.' : 'Close the tab. History brings it back.'}>
                    <Icon name="x" size={12} />
                  </button>
                )}
              </span>
            )}
          </div>
        )
      })}
      {/* Floating, the bar's Agent button opens new conversations. */}
      {!floats && (
        <button className="sb-btn sm ghost h-agent-new" onClick={() => newThread()} disabled={starting} aria-label="New conversation" title={titled('New conversation', comboFor('agent-new'))}>
          <Plus size={16} strokeWidth={1.8} />
        </button>
      )}
    </div>
  )
  const titles = strip.map(titleOf)
  useEffect(() => onTabs(titles), [titles.join('\n')])
  useEffect(() => () => onTabs([]), [])

  // The bar along the bottom of the window, floating, is the agent's. From its right end: History, the Agent button, and the
  // tabs of the conversations that have started, the newest nearest the button. The Agent button opens and closes the new
  // conversation, what is typed in it kept; on one that has started, that one keeps its tab and the new one opens.
  const onEmpty = unsent(current) && !listing
  const agentButton = () => {
    if (shown && onEmpty) return onClose()
    if (!onEmpty) newThread()
    onShow?.()
  }
  const bar = floats && (
    <div className="h-agent-bar" role="toolbar" aria-label="Agent">
      {notes.length > 0 && !shown && <span className="h-agent-bar-notes">{notes.length === 1 ? '1 thing pointed at' : `${notes.length} things pointed at`}</span>}
      {tabStrip}
      <button key={flash ? `flash-${flash}` : 'agent'} className={`h-agent-bar-toggle${shown && onEmpty ? ' on' : ''}${flash ? ' flash' : ''}`} onAnimationEnd={() => setFlash(0)} onClick={agentButton} disabled={starting} aria-expanded={shown && onEmpty} title={titled(shown && onEmpty ? 'Close the agent' : 'Open the agent', comboFor('agent'))}>
        <Icon name="spark" size={14} />
        {annotating && !shown ? 'Point, then tell the agent' : 'Agent'}
        <Keys combo={comboFor('agent')} />
      </button>
      <button
        className={`sb-btn sm ghost h-agent-bar-history${shown && listing ? ' on' : ''}`}
        onClick={() => {
          if (shown && listing) return setListing(false)
          setListing(true)
          onShow?.()
        }}
        aria-label="History"
        aria-pressed={shown && listing}
        title="Every conversation"
      >
        <History size={15} strokeWidth={1.7} />
      </button>
    </div>
  )
  const edge = (by: Drag, label: string) => <div className={`h-agent-edge ${by}`} role="separator" aria-label={label} title="Drag to resize. Double-click to reset." onMouseDown={startResize(by)} />

  // The same tree whether it floats or not, so moving it keeps what is typed.
  return (
    <>
      {(!floats || shown) && (
        <aside ref={panelRef} className={`h-agent${full ? ' full' : floats ? ' floating' : ''}${tone ? ` ${tone}` : ''}${files.over ? ' sb-drop-over' : ''}`} style={full ? undefined : floats ? { width: floatSize.w ?? 440, ...(floatSize.h ? { height: floatSize.h } : {}) } : { width: clamp(width) }} {...files.dropProps}>
          {!full && !floats && (
            <div className="h-agent-resize" role="separator" aria-orientation="vertical" aria-label="Resize the agent panel" title="Drag to resize. Double-click to reset." onMouseDown={startResize('dock')} />
          )}
          {floats && (
            <>
              {edge('y', 'Resize the agent up or down')}
              {edge('x', 'Resize the agent left or right')}
              {edge('xy', 'Resize the agent')}
            </>
          )}
          <header key={floats && flash ? `flash-${flash}` : 'head'} className={`h-agent-head${floats && flash ? ' flash' : ''}`}>
            {floats ? <span className="h-agent-title">{listing ? 'Every conversation' : titleOf(current)}</span> : tabStrip}
            <div className="sb-row h-nodrag" style={{ gap: 2, flex: 'none' }}>
              {sessionId && !listing && (
                <button className="sb-btn sm ghost" style={{ width: 30, padding: 0 }} onClick={continueInTerminal} aria-label="Continue in terminal" title={`Continue in terminal (${harnessName(activeHarness)})`}>
                  <Icon name="terminal" size={16} />
                </button>
              )}
              {/* Floating, History is in the bar, beside the Agent button. */}
              {!floats && (
                <button className={`sb-btn sm ghost${listing ? ' on' : ''}`} style={{ width: 30, padding: 0 }} onClick={() => setListing(!listing)} aria-label="History" aria-pressed={listing} title="Every conversation">
                  <History size={16} strokeWidth={1.7} />
                </button>
              )}
              {/* Floating, it minimizes to the bar, its tab and what is typed kept. */}
              {floats && (
                <button className="sb-btn sm ghost" style={{ width: 30, padding: 0 }} onClick={onClose} aria-label="Minimize agent panel" title={titled('Minimize to the bar', comboFor('agent'))}>
                  <Minus size={16} strokeWidth={1.8} />
                </button>
              )}
              <button className="sb-btn sm ghost" style={{ width: 30, padding: 0 }} onClick={() => onFull(!full)} aria-label={full ? back : 'Full screen'} aria-pressed={full} title={titled(full ? back : 'Fill the window', comboFor('agent-full'))}>
                {full ? <Minimize2 size={15} strokeWidth={1.7} /> : <Maximize2 size={15} strokeWidth={1.7} />}
              </button>
              <button className="sb-btn sm ghost" style={{ width: 30, padding: 0 }} onClick={onClose} aria-label="Close agent panel" title={titled('Close', comboFor('agent'))}>
                <Icon name="x" size={16} />
              </button>
            </div>
          </header>
          {listing ? (
            <Conversations sessions={sessions} error={listError} open={tabs} workspaces={state.workspaces} onOpen={(s) => openConversation(s.id, s.labels.conversation)} onBack={() => setListing(false)} />
          ) : sessionId ? (
            // A conversation that cannot be drawn leaves the panel, its tabs and the message box, to go elsewhere or write on.
            <Guard reset={sessionId} name="this conversation" fallback={(error, retry) => (
              <div className="sb-transcript">
                <div className="sb-transcript-inner">
                  <GuardNote name="this conversation" error={error} retry={retry} />
                </div>
              </div>
            )}>
              <Transcript renderMarketplace={(stageId, done) => {
                if (!stageId) return <MarketplaceAccountCard state={state} onComplete={done} />
                const stage = state.remote.publishing.find((s) => s.id === stageId)
                return stage ? <PublishConfirm stage={stage} state={state} onComplete={done} /> : <p className="sb-note muted">This publishing copy is no longer available.</p>
              }} sessionId={sessionId} session={session} marks={marks} onSignIn={login} intro={info?.session.labels.intro ? <Greeting text={info.session.labels.intro} /> : onboardingHere ? <Greeting /> : undefined} outgoing={outgoingHere} resumes={!(onboardingHere && checklistInUse(state))} />
            </Guard>
          ) : welcomes[current] ? (
            <div className="sb-transcript">
              <div className="sb-transcript-inner">
                {welcomes[current]!.intro && <Greeting text={welcomes[current]!.intro} />}
                {outgoingHere}
              </div>
            </div>
          ) : greets ? (
            <div className="sb-transcript">
              <div className="sb-transcript-inner">
                <Greeting />
                <div className="h-greet-picks" aria-label="Products you use">
                  {PRODUCTS.map((p) => {
                    const on = new RegExp(`\\b${p}\\b`, 'i').test(typed(current))
                    return (
                      <button key={p} className={`h-greet-pick${on ? ' on' : ''}`} aria-pressed={on} onClick={() => !on && setDraft(typed(current) ? `${draft.trimEnd()}, ${p}` : `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}I use ${p}`)}>
                        {p}
                      </button>
                    )
                  })}
                </div>
                {outgoingHere}
              </div>
            </div>
          ) : (
            // A new conversation starts empty: just the field to type in.
            <div className="sb-transcript">{outgoingHere && <div className="sb-transcript-inner">{outgoingHere}</div>}</div>
          )}
          {!listing && signingInto && (
            <div className="h-signin-wrap">
              <SignInCard key={signingInto.name} provider={signingInto} onClose={() => setSigningIn(null)} />
            </div>
          )}
          {!listing && queued.length > 0 && (
            // Messages written while the agent works, above the box, in the order they go.
            <div className="h-queue" aria-label="Queued messages">
              {(paused || (queued[0]?.editing && !busy)) && (
                <div className="h-queue-head">
                  <span>{paused ? `${session.status === 'cancelled' ? 'Stopped' : 'The last turn did not finish'}. ${queued.length === 1 ? 'This waits until you send it' : 'These wait until you send them'}.` : `Waits until you save or cancel the edit${queued.length > 1 ? ', and so do the rest' : ''}`}</span>
                  {paused && !queued[0]?.failed && (
                    <button className="sb-btn sm" onClick={() => queue.next(sessionId!, true)}>
                      Send next
                    </button>
                  )}
                </div>
              )}
              {queued.map((q) =>
                q.editing ? (
                  <QueuedEdit key={q.id} session={sessionId!} item={q} onSave={(text) => queue.rewrite(sessionId!, q.id, text)} onCancel={() => queue.editing(sessionId!, q.id, false)} />
                ) : (
                  <div key={q.id} className={`h-queued${q.failed ? ' bad' : ''}`}>
                    {/* A double-click on the words edits them in place. */}
                    <span
                      className="h-queued-body"
                      role={q.sending || q.now ? undefined : 'button'}
                      tabIndex={q.sending || q.now ? undefined : 0}
                      title={q.sending || q.now ? undefined : 'Double-click to edit'}
                      onDoubleClick={() => !q.sending && !q.now && queue.editing(sessionId!, q.id, true)}
                      onKeyDown={(e) => e.key === 'Enter' && !q.sending && !q.now && (e.preventDefault(), queue.editing(sessionId!, q.id, true))}
                    >
                      <span className="h-queued-text">{said(q.text)}</span>
                      {q.files.length > 0 && <small>{q.files.length === 1 ? q.files[0]!.name : `${q.files.length} files`}</small>}
                      {q.failed && <small className="bad">Did not send: {q.failed}</small>}
                      {(q.now || q.sending) && !q.failed && <small>{q.sending || !busy ? 'Sending…' : 'Stopping the agent…'}</small>}
                    </span>
                    <button className="h-queued-icon" onClick={() => unqueue(q)} disabled={q.sending || q.now} aria-label="Back to the box" title="Undo: take it out of the queue, back into the box">
                      <Undo2 size={15} strokeWidth={1.8} />
                    </button>
                    {q.failed ? (
                      <button className="h-queued-send" onClick={() => queue.retry(sessionId!, q.id)} aria-label="Try again" title={`Did not send: ${q.failed}. Try again`}>
                        <RotateCw size={14} strokeWidth={2} />
                      </button>
                    ) : (
                      <button className="h-queued-send" onClick={() => void steer(q)} disabled={q.now || queued.some((x) => x.sending)} aria-label="Send now" title={busy ? 'Send now: stops the agent and sends this' : 'Send now'}>
                        <ArrowUp size={15} strokeWidth={2.2} />
                      </button>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
          {!listing && (
            <div className="h-compose" onSelect={onSelect}>
              <VoiceBar dictating={state.voice?.autoSend === false} />
              {mention && (
                <div className="h-pop start h-mention" role="listbox" aria-label="Mention">
                  {(['workspace', 'connector'] as const).map((kind) => {
                    const group = mention.matches.filter((m) => m.kind === kind)
                    return (
                      group.length > 0 && (
                        <div key={kind} role="group" aria-label={kind === 'workspace' ? 'Workspaces' : 'Connectors'}>
                          <h6>{kind === 'workspace' ? 'Workspaces' : 'Connectors'}</h6>
                          {group.map((m) => {
                            const i = mention.matches.indexOf(m)
                            return (
                              // A press on one leaves the keyboard in the field.
                              <button key={m.id} type="button" role="option" aria-selected={i === mention.at} className={i === mention.at ? 'hi' : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => mentionPick(m)}>
                                <span className="h-pop-check">{m.icon(14)}</span>
                                <span className="h-pop-text">{m.name}</span>
                                {kind === 'workspace' && onScreen.includes(m.id) && <span className="h-pop-hint">On screen</span>}
                              </button>
                            )
                          })}
                        </div>
                      )
                    )
                  })}
                </div>
              )}
              <Composer
                layout="line"
                attachments={files}
                allowEmpty={noted}
                value={draft}
                onChange={setDraft}
                onSend={send}
                onQueue={sessionId ? enqueue : undefined}
                onStop={() => void session.cancel()}
                busy={busy}
                placeholder={!engineReady ? 'Agents are starting…' : busy && sessionId ? `Queue a message, or ${keys({ key: 'enter' })} to send it now…` : noted ? 'Add anything else, or just send' : notes.length ? 'Ask about what you pointed at, or for a change…' : 'Ask anything, @ to mention'}
                autoFocus
                onKeyDown={mentionKey}
                marks={marks}
                trail={
                  (voiceOn || talking) && (
                    <button className={`sb-attach h-voice-toggle${talking ? ' on' : ''}`} onClick={() => void voice.toggle()} disabled={!engineReady} aria-label={talking ? 'Turn voice mode off' : 'Voice mode'} aria-pressed={talking} title={titled(talking ? 'Turn voice mode off' : 'Voice mode: talk to the agent', comboFor('voice'))}>
                      <Mic size={17} strokeWidth={1.7} />
                    </button>
                  )
                }
                top={
                  <>
                    {(notes.length > 0 || annotating) && (
                      <div className="h-tags" aria-label="What you pointed at">
                        {notes.map((n, i) => (
                          <span key={n.id} className="h-note" title={n.note ? `${n.note}\n${where(n)}` : where(n)}>
                            <b>{i + 1}</b>
                            <span>
                              <Marked text={n.note} marks={marks} />
                              {/* With no note, the element is the chip's text itself. */}
                              <small className={n.note ? undefined : 'alone'}>{where(n)}</small>
                            </span>
                            <button onClick={() => setNotes((all) => all.filter((x) => x.id !== n.id))} aria-label="Remove note" title="Remove">
                              <Icon name="x" size={12} />
                            </button>
                          </span>
                        ))}
                        {annotating && notes.length === 0 && <p>Click anything in the workspace to hand it to the agent, with a note if you like. Double-click text to rewrite it.</p>}
                      </div>
                    )}
                  </>
                }
                below={
                  <div className={`h-line p-${permission}`}>
                    <Pick
                      label="Agent"
                      value={activeHarness}
                      locked={!!sessionId || providers.length < 2}
                      title={sessionId ? 'Fixed for this conversation' : 'The agent for this conversation'}
                      choices={(providers.length ? providers.map((p) => p.name) : [activeHarness]).map((h) => ({ value: h, name: harnessName(h), icon: <AgentMark harness={h} /> }))}
                      onPick={(h) => {
                        localStorage.setItem('sb.agent.harness', h)
                        setHarness(h)
                      }}
                    />
                    {models.length > 0 && (
                      <>
                        <i aria-hidden>·</i>
                        <Pick label="Model" heading="Model · from the next message" value={model} choices={[...(models.some((m) => m.id === model) ? [] : [{ value: model, name: model }]), ...models.map((m) => ({ value: m.id, name: m.name, description: m.description }))]} onPick={(id) => pick({ model: id })} />
                      </>
                    )}
                    {efforts.length > 0 && (
                      <>
                        <i aria-hidden>·</i>
                        <Pick label="Effort" heading="How hard it thinks" value={effort} choices={efforts.map((e) => ({ value: e, name: `${effortName(e)} effort` }))} onPick={(e) => pick({ effort: e })} />
                      </>
                    )}
                    {modes.length > 1 && (
                      <>
                        <i aria-hidden>·</i>
                        <Pick className="perm" label="Permissions" heading="Permissions" align="end" value={permission} title={PERMISSIONS[permission].description} choices={[...modes].reverse().map((m) => ({ value: m, name: PERMISSIONS[m].name, hint: PERMISSIONS[m].description, className: `p-${m}` }))} onPick={pickPermission} />
                      </>
                    )}
                    <span className="h-line-keys">{busy && sessionId ? <><kbd>↩</kbd> queue · <kbd>{keys({ key: 'enter' })}</kbd> now</> : <><kbd>↩</kbd> send</>}</span>
                  </div>
                }
              />
            </div>
          )}
        </aside>
      )}
      {bar}
      {/* While dragging, a sheet over the whole window keeps the pointer from falling into the workspace frame. Outside the
          panel: as it floats in, the panel has a transform, and the sheet would be placed in it rather than in the window. */}
      {resizing && <div className={`h-resize-sheet ${resizing.by}`} onPointerMove={resize} onPointerUp={() => setResizing(null)} onPointerLeave={() => setResizing(null)} />}
    </>
  )
})

/** When a conversation began, as the heading it goes under. */
const period = (date: string, now = new Date()) => {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = new Date(date).getTime()
  if (t >= day) return 'Today'
  if (t >= day - 86400000) return 'Yesterday'
  if (t >= day - 6 * 86400000) return 'Previous 7 days'
  if (t >= day - 29 * 86400000) return 'Previous 30 days'
  return new Date(date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** Every conversation with the agent, whichever workspace it was about: the ones working first, then the rest by when they began. */
function Conversations({ sessions, error, open, workspaces, onOpen, onBack }: { sessions?: SessionSummary[]; error?: Error; /** The ones open as tabs. */ open: string[]; workspaces: WorkspaceInfo[]; onOpen: (s: SessionSummary) => void; onBack: () => void }) {
  const [q, setQ] = useState('')
  const workspace = (id?: string) => workspaces.find((w) => w.id === id)
  const title = (s: SessionSummary) => said(s.labels.title) || said(s.preview) || 'Conversation'
  const words = q.trim().toLowerCase()
  const live = (sessions ?? []).filter((s) => !s.archived_at)
  // The workspaces to show the conversations of; none picked is all of them. '' is the ones about no workspace (or one since deleted).
  const [only, setOnly] = useState<string[]>([])
  const about = (s: SessionSummary) => (workspace(s.labels.workspace) ? s.labels.workspace! : '')
  const choices = [...workspaces.filter((w) => live.some((s) => about(s) === w.id)).map((w) => w.id), ...(live.some((s) => !about(s)) ? [''] : [])]
  const picked = only.filter((id) => choices.includes(id))
  const pick = (id: string) => setOnly((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o.filter((x) => choices.includes(x)), id]))
  const shown = live
    .filter((s) => !picked.length || picked.includes(about(s)))
    .filter((s) => !words || `${title(s)} ${said(s.preview) ?? ''} ${workspace(s.labels.workspace)?.name ?? ''}`.toLowerCase().includes(words))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  const groups: { name: string; items: SessionSummary[] }[] = []
  for (const s of shown) {
    const name = isBusy(s.status) ? 'Working' : period(s.created_at)
    const g = groups.find((x) => x.name === name)
    if (g) g.items.push(s)
    else if (name === 'Working') groups.unshift({ name, items: [s] })
    else groups.push({ name, items: [s] })
  }
  const count = live.length
  return (
    <div className="sb-transcript h-convs-scroll">
      <div className="h-convs">
        <div className="h-convs-top">
          <h2>
            Conversations{sessions && count > 0 && <span>{count}</span>}
          </h2>
          <label className="h-convs-search">
            <Search size={15} strokeWidth={1.8} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // Enter opens the best match. Escape empties the search, then goes back to the conversation.
                if (e.key === 'Enter' && words && shown[0]) onOpen(shown[0])
                if (e.key === 'Escape') q ? (e.stopPropagation(), setQ('')) : onBack()
              }}
              placeholder="Search conversations"
              aria-label="Search conversations"
              spellCheck={false}
              autoFocus
            />
            {q && (
              <button onClick={() => setQ('')} aria-label="Clear the search" title="Clear">
                <Icon name="x" size={13} />
              </button>
            )}
          </label>
          {/* Only worth it when the conversations are about more than one thing. Each one picked adds its conversations. */}
          {choices.length > 1 && (
            <div className="h-convs-filter" role="group" aria-label="Show the conversations about">
              <button className={`h-convs-chip${picked.length ? '' : ' on'}`} aria-pressed={!picked.length} onClick={() => setOnly([])}>
                All
              </button>
              {choices.map((id) => {
                const w = workspace(id)
                return (
                  <button key={id} className={`h-convs-chip${picked.includes(id) ? ' on' : ''}`} aria-pressed={picked.includes(id)} onClick={() => pick(id)} title={w ? `Conversations about ${w.name}` : 'Conversations about no workspace'}>
                    {w && <WorkspaceIcon icon={w.icon} color={w.color} size={11} />}
                    <span>{w ? w.name : 'No workspace'}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {error ? (
          <p className="h-convs-note">{error.message}</p>
        ) : !sessions ? (
          <p className="h-convs-note">Loading…</p>
        ) : !shown.length ? (
          <p className="h-convs-note">{words ? `Nothing matches “${q.trim()}”${picked.length ? ' in the workspaces picked' : ''}.` : picked.length ? 'No conversations about the workspaces picked.' : 'No conversations yet. They show up here once you send a message.'}</p>
        ) : (
          groups.map((g) => (
            <section key={g.name} className="h-convs-group" aria-label={g.name}>
              <h3>
                {g.name === 'Working' && <span className="sb-spinner" aria-hidden />}
                {g.name}
              </h3>
              {g.items.map((s) => {
                const w = workspace(s.labels.workspace)
                return (
                  <button key={s.id} className={`h-conv${open.includes(s.id) ? ' open' : ''}`} onClick={() => onOpen(s)} title={open.includes(s.id) ? 'Go to its tab' : 'Open in a new tab'}>
                    <span className="h-conv-title">{title(s)}</span>
                    <span className="h-conv-meta">
                      {w && (
                        <span className="h-conv-ws" title={w.name}>
                          <WorkspaceIcon icon={w.icon} color={w.color} size={11} />
                          <span>{w.name}</span>
                        </span>
                      )}
                      {open.includes(s.id) && <span className="h-conv-open">Open</span>}
                      <time dateTime={s.created_at}>{rel(s.created_at)}</time>
                    </span>
                  </button>
                )
              })}
            </section>
          ))
        )}
      </div>
    </div>
  )
}

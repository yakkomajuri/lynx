// Shapes shared by the main process, the host window and workspace UIs.
import type { LayoutSettings, ModeId, ThemeId } from './themes'
import type { VoiceEvent, VoiceState } from './voice'
import type { ExecutionSettings } from './execution'

export type ConnectorStatus = 'connecting' | 'connected' | 'auth-required' | 'needs-credentials' | 'error' | 'disconnected'

export interface ToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
  /** Best guess (server hint, else the tool's name). Good for display, not for trust. */
  readOnly?: boolean
  /** The server itself declared the tool read-only. The only form of "read-only" consent relies on. */
  declaredReadOnly?: boolean
}

/** How an API connector sends its key: as a bearer token, basic auth, a header of its own or a query parameter. */
export type ApiAuthType = 'none' | 'bearer' | 'basic' | 'header' | 'query'

/** An HTTP API used as a connector (src/main/apiConnector.ts). Its base URL is the connector's `url`. */
export interface ApiConfig {
  /** How the key is sent; `name` is the header or query parameter it goes in. The key itself is in `credentials`. */
  auth: { type: ApiAuthType; name?: string }
  /** Headers sent with every request that are not secret: an API version, Accept. */
  headers?: Record<string, string>
  /** The methods requests may use; unset is every one. `["GET"]` makes it read-only. */
  methods?: string[]
  docsUrl?: string
  /** For agents: what the API is for and how to use it. Part of the request tool's description. */
  notes?: string
  /** A GET path that only answers with a working key, to check it when the connector connects. */
  checkPath?: string
}

/** An API connector's secrets. */
export interface ApiCredentials {
  /** The token or API key (bearer, header and query). */
  key?: string
  username?: string
  password?: string
}

/** What is stored on disk. Secrets (headers, env, credentials) never leave the main process. */
export interface ConnectorSpec {
  id: string
  name: string
  /** native connectors ship with the app: `app` (this application) and `agents` (agentd, the agent backend). */
  native?: boolean
  /** `api` is an HTTP API with no MCP server: the app serves its `request` tool. */
  transport: 'http' | 'stdio' | 'internal' | 'api'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  /** false: the server takes no authentication, so a 401 asks for a token instead of offering a browser sign-in. */
  oauth?: false
  api?: ApiConfig
  credentials?: ApiCredentials
  createdAt: string
  /** The engine connection that lets agents use this connector. */
  agentConnectionId?: string
  agentConnectionUrl?: string
}

export interface ConnectorState {
  id: string
  name: string
  native: boolean
  transport: ConnectorSpec['transport']
  url?: string
  command?: string
  args?: string[]
  hasCredentials: boolean
  /** How it signs in: OAuth (unset until signed in), none at all, or the kind of static headers stored (their names, never their values). */
  auth?: { kind: 'oauth' | 'none' } | { kind: 'bearer' | 'basic' | 'header'; headers: string[] }
  /** An API connector's settings (no secrets). */
  api?: ApiConfig
  createdAt: string
  status: ConnectorStatus
  error?: string
  tools: ToolInfo[]
  /** Pass in `connection_ids` when starting an agent session so the agent can use this connector. */
  agentConnectionId?: string
}

export interface WorkspaceConfig {
  name: string
  /** A Lucide icon name ("chart-line"). */
  icon?: string
  /** One of the icon colours: red, orange, yellow, green, teal, blue, purple, pink, brown. Empty for the default. */
  color?: string
  description?: string
  /** alias used in UI code -> connector id */
  connectors: Record<string, string>
  /**
   * The manifest: every tool this workspace's UI calls, by the connector name its code uses (an
   * alias, or `app`, `agents`, `tools`). "*" is every tool of that connector. Calls not listed
   * here are refused.
   */
  uses: Uses
  /** marketplace item this was forked from */
  origin?: string
  /** Put away: out of the list of workspaces and its shortcuts, with everything it has kept. */
  archived?: boolean
  /** The workspace the app starts with. It is edited like any other, and cannot be deleted. */
  home?: boolean
  /** The checklist a new install starts on: the agent panel greets the user here and is told to get them set up. */
  onboarding?: boolean
  createdAt: string
}

export type Uses = Record<string, '*' | string[]>

export interface BuildState {
  version: number
  status: 'building' | 'ok' | 'error'
  errors: string[]
  builtAt?: string
  /** last runtime error reported by the running UI */
  runtimeError?: string
  /**
   * A newer version than the one on screen, built and waiting: the user is typing in the workspace, and the
   * window puts it on screen once they stop or ask for it. Until then `runtimeError` is the older version's.
   */
  held?: number
}

export interface WorkspaceInfo extends WorkspaceConfig {
  id: string
  dir: string
  build: BuildState
}

export interface MarketplaceRequirement {
  alias: string
  name: string
  /** The server the UI was written against. Without one, any of your connectors can be picked (servers each user runs, such as postgres2mcp). */
  url?: string
  hint?: string
  /** The UI works without it; a fork leaves the alias unbound when you have no such connector. */
  optional?: boolean
}

/** A schedule a marketplace item asks for: its tool runs on this cron once the item is forked. */
export interface MarketplaceSchedule {
  id: string
  tool: string
  cron: string
  args?: Record<string, unknown>
}

export interface MarketplaceItem {
  id: string
  name: string
  description: string
  icon?: string
  color?: string
  author?: string
  /** Where it comes from: your own shelf or the remote marketplace. */
  source: 'local' | 'remote'
  /** Who made it: the Lynx team, anyone with an account, or you. */
  creator: 'official' | 'community' | 'you'
  /** Checked by the Lynx team. */
  verified?: boolean
  /** Who published it to the marketplace. */
  publisher?: { name: string; handle: string }
  tags?: string[]
  /** How many times it was forked from the marketplace. */
  installs?: number
  /** The marketplace version; its files are fetched again when it changes. */
  version?: number
  requires: MarketplaceRequirement[]
  /** The manifest a fork starts with. */
  uses?: Uses
  /** Custom tools shipped in the item's tools/ folder, installed on fork when you have none by that name. */
  tools?: string[]
  /** Each shipped tool's `description` export, by name, read from its file without running it. */
  toolDescriptions?: Record<string, string>
  schedules?: MarketplaceSchedule[]
  /** Set when the item ships preview/mock.js: the page of it the marketplace shows. */
  preview?: { path: string }
  /** Legacy manifest grouping metadata; the marketplace displays all items in one grid. */
  group?: string
  /** Its folder on this machine: what a security review reads. A marketplace item's is filled in when first needed. */
  dir: string
}

/** The remote marketplace as this machine sees it: where it is, whether it answered, who is signed in. */
export interface RemoteMarketplaceState {
  /** The server's base URL; null when none is set up, leaving only your private shelf. */
  api: string | null
  status: 'off' | 'loading' | 'ok' | 'error'
  error?: string
  checkedAt?: string
  /** Signed in to publish. Pulling templates needs no account. */
  account: { email: string; name: string; handle: string | null; official: boolean } | null
  /** Workspaces on their way to the marketplace, newest first. */
  publishing: PublishStage[]
}

/**
 * A workspace on its way to the marketplace: a copy of it, which an agent reviews and cleans up, that
 * the user then sees and publishes, or not. The workspace itself is never changed.
 */
export interface PublishStage {
  /** Immutable destination and account selected before review. */
  update?: { api: string; email: string; id: string; version: number; name: string }
  /** Server/account that received a successful publication. */
  publisher?: { api: string; email: string }
  id: string
  workspace: string
  name: string
  /** The copy: what gets published, as it is when the user says so. */
  dir: string
  /** preparing: the agent is at work · ready: waiting for the user to publish it · published · failed: the upload did not go through. */
  /** Digest of the files the agent submitted for user approval. */
  contentHash?: string
  status: 'preparing' | 'ready' | 'publishing' | 'published' | 'failed'
  createdAt: string
  /** Set each time the agent hands it over, so a second hand-over asks again. */
  readyAt?: string
  /** What the agent changed and found, in its words. */
  report?: string
  /** From its manifest.json, when ready. */
  description?: string
  tags?: string[]
  files?: { path: string; size: number }[]
  error?: string
  /** The marketplace id it was published as. */
  published?: { id: string; version: number }
}

/** A custom tool: JavaScript in the tools folder, callable on the `tools` connector. */
export interface CustomTool {
  name: string
  description: string
  inputSchema: unknown
  /** Set when the file does not load; the tool is then not callable. */
  error?: string
  updatedAt: string
}

export interface ToolSchedule {
  id: string
  tool: string
  args: Record<string, unknown>
  /** Five fields, local time: minute hour day-of-month month day-of-week. */
  cron: string
  enabled: boolean
  nextAt: string | null
  lastAt: string | null
  lastOk: boolean | null
  lastError: string | null
  running: boolean
}

export interface ToolRun {
  id: number
  tool: string
  /** Who started it: `workspace:<id>`, `agent`, `tool:<name>`, `schedule:<id>` or `user`. */
  by: string
  startedAt: string
  ms: number
  ok: boolean
  args: unknown
  result?: unknown
  error?: string
  logs: string[]
  calls: { connector: string; tool: string; ms: number; ok: boolean }[]
}

/** Something a tool, agent or workspace wants the user to know about a workspace. */
export interface AppNotification {
  id: number
  workspace: string
  text: string
  /** Where clicking it goes: a page of the workspace ("/prs/42"), or an http(s) address. */
  link?: string
  /** Who sent it: `workspace:<id>`, `agent`, `tool:<name>` or `user`. */
  by: string
  at: string
  read: boolean
}

export interface AppSettings {
  /** Markdown: the look every workspace should have unless told otherwise. Empty when none is set. */
  designSystem: string
  /** How the app's own pages look (shared/themes.ts). Workspaces other than Home do not follow it. */
  theme: ThemeId
  /** Light, dark, or as the system is: for the whole window, workspaces too. */
  mode: ModeId
  /** Where the list of workspaces and the agent sit in the window. */
  layout: LayoutSettings
  background: BackgroundSettings
  execution: ExecutionSettings
}

/** What the background service (lynxd) does when the window is not open. */
export interface BackgroundSettings {
  /** Quitting Lynx leaves agents, schedules and connectors running. Off: quitting stops them, as it used to. */
  keepRunning: boolean
  /** The service starts when the user logs in, so schedules run without Lynx being opened. */
  startAtLogin: boolean
}

/** The background service as the window sees it. */
export interface ServiceState {
  /** `daemon`: its own process, which outlives the window. `in-process`: inside the window's process (LYNX_DAEMON=0). */
  mode: 'daemon' | 'in-process'
  connected: boolean
  pid?: number
  startedAt?: string
  /** Agent runs and shell commands under way. */
  busy?: number
  /** It runs an older build than the window's, and is replaced once nothing is running. */
  stale?: boolean
  logFile?: string
}

/** Whether a newer Lynx is out, and how far installing it has got (src/main/updates.ts). */
export interface UpdateState {
  /** This copy's version. */
  current: string
  /** An update feed is set; without one nothing is ever checked. */
  configured: boolean
  /** `installing` takes the app out of the download and checks it; `ready` is installed and waiting for a restart. */
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'ready' | 'error'
  /** The newest version, when it is newer than this one. */
  latest?: {
    version: string
    /** Markdown. */
    notes?: string
    date?: string
    /** Every version since this copy's, newest first, the newest among them: what each changed (Markdown). */
    changes: { version: string; notes?: string; date?: string }[]
  }
  /** 0 to 1 while downloading, when the size is known. */
  progress?: number
  /** What went wrong with the last check or install. */
  error?: string
  /** This copy can replace itself (an installed Mac app in a folder it may write); otherwise the update is downloaded by hand. */
  canInstall: boolean
  checkedAt?: string
}

export interface EngineState {
  status: 'starting' | 'ready' | 'error'
  detail?: string
  url?: string
}

export interface AppState {
  engine: EngineState
  connectors: ConnectorState[]
  workspaces: WorkspaceInfo[]
  marketplace: MarketplaceItem[]
  remote: RemoteMarketplaceState
  tools: CustomTool[]
  schedules: ToolSchedule[]
  /** The newest notifications, newest first. */
  notifications: AppNotification[]
  settings: AppSettings
  /** Where custom tools live: one `<name>.js` each. */
  toolsDir: string
  dataDir: string
  /** The agent's own working folder: scratch space, and where files given to it land. */
  agentDir: string
  /** The window draws its close/minimise/zoom buttons over the top-left of the page (a Mac window that is not full screen). */
  windowButtons: boolean
  update: UpdateState
  service: ServiceState
  voice: VoiceState
}

export type AppEvent =
  /** `quiet`: nothing changed but workspaces' builds, so cached reads need not refetch. */
  | { t: 'state'; state: AppState; quiet?: boolean }
  /** External data changed, or a recovered connector can retry failed reads. */
  | { t: 'connector-data-changed'; connector: string; errorsOnly?: boolean }
  | { t: 'built'; workspace: string; build: BuildState }
  /** Bring a workspace on screen: on its own, or beside what is (0 the left pane, 1 the right), at a page in it. */
  | { t: 'open-workspace'; workspace: string; beside?: 0 | 1; path?: string }
  | { t: 'open-connector-dialog'; preset: { name?: string; url?: string; reason?: string; connector?: string } }
  | { t: 'toast'; tone: 'info' | 'good' | 'bad'; text: string }
  /** An agent made a workspace (created, copied or forked from the marketplace): the window offers to go to it. */
  | { t: 'workspace-created'; workspace: string; name: string }
  /** The close keys (⌘W) while the agent has the keyboard (its tab closes) or two workspaces are side by side (the focused pane closes), not the window. */
  | { t: 'close-pane' }
  /** A key pressed while keys are being recorded for a shortcut. */
  | { t: 'key'; press: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean } }
  /** Keys the page never sees (⌘`, which macOS keeps for moving between windows), for whichever shortcut has them. */
  | { t: 'shortcut'; press: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean } }
  /** The find bar: the text typed in it, a step to the next or previous match, or closing it. */
  | { t: 'find'; text: string }
  | { t: 'find-step'; forward: boolean }
  | { t: 'find-close' }
  /** Voice mode: what the speech process heard (src/main/voice.ts). */
  | ({ t: 'voice' } & VoiceEvent)
  /** The app connector asks the window for something only it can do (lay out workspaces, find or highlight what is on screen), and waits for window_reply. */
  | { t: 'window-request'; id: string; op: string; args: Record<string, any> }

/** The find bar's colours, the app theme's, resolved in the window (the bar is a page of its own). */
export interface FindColors {
  scheme: 'light' | 'dark'
  surface: string
  text: string
  muted: string
  line: string
  hover: string
  shadow: string
}
/** Where the find bar goes: over the top right of a workspace's frame, in the window's CSS pixels. Null hides it. */
export type FindPlace = { frame: { x: number; y: number; width: number; height: number }; colors: FindColors; /** Takes the keyboard and selects its text, with this text in it when given. */ focus?: boolean; text?: string } | null
export interface FindResult {
  matches: number
  /** Which match is the current one, from 1; 0 for none. */
  active: number
}

export const NATIVE_APP = 'app'
export const NATIVE_AGENTS = 'agents'
export const NATIVE_TOOLS = 'tools'

export const normUrl = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase()

/** Label the app puts on every conversation a workspace starts. Reserved: nothing else may set it. */
export const OWNER_LABEL = 'sb_owner'
/**
 * Labels the app puts on every conversation as it starts, saying where it came from; whatever the
 * caller sent under these names is replaced. `sb_by` is who started it, as a caller's `by`
 * (`workspace:<id>`, `tool:<name>`, `agent`, `user`); for a custom tool, `sb_via` is what ran the
 * tool (`schedule:<id>`, `workspace:<id>`, …). A conversation an agent schedule starts has
 * `sb_by: schedule`, and the schedule's name and cron in `sb_schedule` and `sb_cron`.
 */
export const BY_LABEL = 'sb_by'
export const VIA_LABEL = 'sb_via'
export const SCHEDULE_LABEL = 'sb_schedule'
export const CRON_LABEL = 'sb_cron'

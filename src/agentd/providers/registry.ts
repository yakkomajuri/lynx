// Every harness agentd can run, in one list. Nothing else names a harness: the worker, discovery,
// the tools' schemas and the app read what they need from here, and decide by capability rather
// than by which agent it is. A new harness is one entry here plus its adapter.
import { claudeExecutable } from './claude-bin'
import { codexBin } from './codex-bin'
import type { AgentSpec, Ask, BrowserSignIn, Emit, ProviderModel } from './types'

/** What a worker gives an adapter. */
export interface SessionIO {
  emit: Emit
  /** Aborted when the run is cancelled, before or during a turn. */
  signal: AbortSignal
  ask: Ask
  /** Values to keep out of anything the adapter reports. */
  secrets: () => string[]
}
/** A provider process serving one session: a warm worker hands it each later message as a turn. */
export interface Session {
  turn: (spec: AgentSpec) => Promise<void>
  close: () => void
  /** Settles when the provider is gone; a warm worker then exits rather than wait for a turn it cannot serve. */
  closed?: Promise<void>
}

export interface Capabilities {
  /** Continues a conversation from its provider session id, in a new process. */
  resume: boolean
  /** One process serves the session's later messages too, keeping its connectors and cache warm. */
  warm: boolean
  /** Asks for approvals and answers through pending inputs. */
  interactive_input: boolean
  /** Uses granted connections as MCP servers. */
  connections: boolean
  input: {
    approvals: boolean
    questions: boolean
    secret_questions: boolean
    arbitrary_dialogs: boolean
    mcp_elicitation: boolean
  }
  permission_modes: AgentSpec['config']['permission_mode'][]
}

export interface Discovered {
  available: boolean
  version: string | null
  /** Whether it is signed in to an account it can run with; null when that could not be told. */
  signed_in?: boolean | null
  error?: string
  models?: ProviderModel[]
}

export interface ProviderDefinition {
  /** Stored on sessions as their `harness`. */
  id: string
  /** What people call it. */
  name: string
  transport: string
  capabilities: Capabilities
  /** The command that goes on with a session in the provider's own CLI, before its provider session id. */
  resume_command?: string[]
  /**
   * The command that signs in to the provider's account, run in a terminal for the user (`/login`).
   * It starts the same install the provider runs, wherever that was found.
   */
  login_command?: () => string[]
  /** Signs in through the browser, with no terminal: preferred over `login_command` when there is one. */
  sign_in?: () => Promise<BrowserSignIn>
  /** False hides the provider entirely. */
  enabled?: () => boolean
  discover: () => Promise<Discovered>
  session: (spec: AgentSpec, io: SessionIO) => Promise<Session>
}

const input = { approvals: true, questions: true, secret_questions: false, arbitrary_dialogs: false, mcp_elicitation: false }
const permission_modes: Capabilities['permission_modes'] = ['deny', 'ask', 'auto', 'allow']

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    transport: 'agent-sdk',
    capabilities: { resume: true, warm: true, interactive_input: true, connections: true, input, permission_modes },
    resume_command: ['claude', '--resume'],
    login_command: () => [claudeExecutable() ?? 'claude', 'auth', 'login'],
    discover: async () => (await import('./claude-discover')).discoverClaude(),
    session: async (spec, io) => (await import('./claude')).claudeSession(spec, io.emit, io.signal, io.ask),
  },
  {
    id: 'codex',
    name: 'Codex',
    transport: 'app-server',
    // Each message starts its own app-server and resumes the thread.
    capabilities: { resume: true, warm: false, interactive_input: true, connections: true, input, permission_modes },
    resume_command: ['codex', 'resume'],
    login_command: () => [codexBin(), 'login'],
    sign_in: async () => (await import('./codex-login')).codexSignIn(),
    discover: async () => (await import('./codex-discover')).discoverCodex(),
    session: async (_spec, io) => {
      const { runCodex } = await import('./codex')
      return { turn: (s) => runCodex(s, io.emit, io.signal, io.ask), close: () => {} }
    },
  },
  {
    id: 'fake',
    name: 'Test agent',
    transport: 'test-worker',
    capabilities: { resume: true, warm: true, interactive_input: true, connections: true, input, permission_modes },
    login_command: () => ['echo', 'signed-in'],
    // A browser sign-in that is done a moment after it starts.
    sign_in: async () => ({ url: 'https://example.com/lynx-test-sign-in', done: new Promise((r) => setTimeout(r, 1000)), cancel: () => {} }),
    enabled: () => process.env.AGENT_ENABLE_FAKE === '1',
    discover: async () => ({ available: true, version: 'test' }),
    session: async (_spec, io) => (await import('./fake')).fakeSession(io),
  },
]

/** The providers this installation offers. */
export const providers = () => PROVIDERS.filter((p) => p.enabled?.() ?? true)
export const providerById = (id: string) => providers().find((p) => p.id === id)

export interface AgentSpec {
  /** A provider id from the registry (`registry.ts`). */
  harness: string
  cwd: string
  prompt: string
  provider_session_id: string | null
  /** Keep the worker for the session's later messages, which arrive as `turn` lines on stdin. */
  warm?: boolean
  /** Read-only copies of the files sent with the message, inside `cwd`. */
  attachments?: { name: string; path: string; size: number; sha256: string }[]
  /** MCP servers the agent may use, named `connection_<id without dashes>`. */
  connections?: { id: string; url: string; headers: Record<string, string> }[]
  config: {
    model?: string
    /** How hard the model thinks: one of the levels its provider lists for the model. */
    effort?: string
    instructions?: string
    /** `auto` leaves each action that changes things to the agent's own reviewer (Claude Code's classifier, Codex's auto review), which may still ask. */
    permission_mode: 'deny' | 'ask' | 'auto' | 'allow'
    timeout_ms?: number
  }
}
export interface AgentEvent {
  type: string
  payload: unknown
  text?: string
}
export type Emit = (event: AgentEvent) => Promise<void>

export interface InputQuestion {
  id: string
  question: string
  options?: string[]
  allow_other?: boolean
}
export interface InputRequest {
  id: string
  kind: 'approval' | 'questions'
  payload: {
    provider: string
    tool_name?: string
    tool_input?: unknown
    method?: string
    questions?: InputQuestion[]
    detail?: unknown
  }
}
export interface InputResponse {
  decision?: 'allow' | 'deny'
  message?: string
  answers?: Readonly<Record<string, readonly string[]>>
}
export type Ask = (kind: InputRequest['kind'], payload: InputRequest['payload'], signal?: AbortSignal) => Promise<InputResponse>

export interface ProviderModel {
  id: string
  name: string
  description?: string
  default?: boolean
  /** The effort levels this model takes, lowest first. Absent when it has none. */
  efforts?: string[]
  /** The level the provider uses when none is given, when it says. */
  default_effort?: string
}

/** A sign-in the user finishes in their browser, while the provider waits for the answer. */
export interface BrowserSignIn {
  /** The address to open. */
  url: string
  /** Settles when the provider has the answer: signed in, or why not. */
  done: Promise<void>
  cancel: () => void
}

export const mcpName = (connectionId: string) => `connection_${connectionId.replaceAll('-', '')}`

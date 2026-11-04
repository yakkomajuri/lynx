// The engine is what runs agents: agentd (Agentd.ts), in this app, on SQLite. The rest of the app
// only ever talks to it as an MCP server (the native `agents` connector) and through its two
// connection admin routes; this is the shape it is reached by.
import { Context } from 'effect'
import type { EngineState } from '@shared/types'

export interface EngineShape {
  readonly state: () => EngineState
  /** Resolves once the API answers; rejects if the engine could not be started. */
  readonly ready: Promise<void>
  readonly url: string
  /** Owner-only REST calls the MCP surface deliberately does not expose (connection credentials). */
  readonly admin: (method: string, path: string, body?: unknown) => Promise<any>
}

export class Engine extends Context.Service<Engine, EngineShape>()('Engine') {}

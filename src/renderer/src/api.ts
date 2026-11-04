// The host window's side of the bridge to the main process, and the kit transport built on it.
import { setTransport, type Attachment } from '@kit/core'
import type { Combo } from '@kit/keys'
import type { AppEvent, AppState, FindPlace, UpdateState } from '@shared/types'
import type { UsageReport } from '@shared/usage'
import type { VoiceModelId, VoiceState } from '@shared/voice'
import type { ReadRequest } from '@shared/reads'

interface Bridge {
  state: () => Promise<AppState>
  call: (req: { workspace?: string; connector: string; tool: string; args?: Record<string, unknown>; read?: ReadRequest }) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>
  runtimeError: (req: { workspace: string; error: string | null }) => Promise<void>
  /** A workspace's new version waits off screen while the user is busy in it (its number), or nothing waits (null). */
  held: (req: { workspace: string; version: number | null }) => Promise<void>
  siteIcon: (url: string) => Promise<string | null>
  openExternal: (url: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  /** Opens a terminal running the agent's own sign-in; answers with the command it runs. */
  agentLogin: (harness: string) => Promise<string>
  /** Asks the update feed now. */
  checkUpdate: () => Promise<UpdateState>
  /** Downloads the newest version and installs it beside this one, while the app carries on. */
  installUpdate: () => Promise<UpdateState>
  /** Once installed: quits, and the new version opens in place of this one. */
  restartUpdate: () => Promise<UpdateState>
  /** Opens the newest version's download in the browser, for a copy that cannot replace itself. */
  downloadUpdate: () => Promise<void>
  /** Keeps the Mac awake for `hours` with macOS's `caffeinate`, in place of a run going, or stops it (null); answers when the run ends (ms), or null. */
  caffeinate: { (hours: number): Promise<number>; (hours: null): Promise<null> }
  /** When the caffeinate run going ends (ms), or null when none is. */
  caffeinateStatus: () => Promise<number | null>
  /** How much of their plans Claude Code and Codex have left; read again with `fresh`, else kept a minute. */
  usage: (fresh?: boolean) => Promise<UsageReport>
  /** Quits Lynx; with `stopAgents` the background service stops too. */
  quit: (opts: { stopAgents: boolean }) => Promise<void>
  /** The keys that close something in the window (the agent's tab, or a pane of two side by side) instead of the window itself, while they do; null otherwise. */
  setCloseHere: (keys: Combo | null) => void
  /** While on, every key press comes as a `key` event and does nothing else, menu keys (⌘W, ⌘M) included: for setting a shortcut's keys. */
  recordKeys: (on: boolean) => void
  /** Finds text in the window (the rest of it made inert by the caller): new text, or a step to the next or previous match. */
  find: (req: { text: string; step?: boolean; forward?: boolean }) => Promise<void>
  /** Shows the find bar over a workspace's frame, or hides it (null). */
  placeFind: (place: FindPlace) => Promise<void>
  /** Closes the find bar and clears what it found. */
  stopFind: () => Promise<void>
  pathForFile: (file: File) => string
  stageFile: (req: { path?: string; name?: string; bytes?: Uint8Array }) => Promise<{ ok: true; data: Attachment } | { ok: false; error: string }>
  /** Voice mode: its settings and models, and a session's microphone (src/main/voice.ts). */
  voice: {
    /** Turns voice mode on or off, picks the model (what is missing downloads), or whether replies are read out. */
    set: (patch: { enabled?: boolean; model?: VoiceModelId; speak?: boolean; autoSend?: boolean; pause?: number; listenAway?: boolean }) => Promise<VoiceState>
    install: (model: VoiceModelId) => Promise<VoiceState>
    remove: (model: VoiceModelId) => Promise<VoiceState>
    /** Stops the download under way. */
    cancel: () => Promise<void>
    /** Checks voice mode can start, asking macOS for the microphone. */
    prepare: () => Promise<void>
    /** Loads the model; samples are taken once it is done, and `voice` events follow. */
    start: () => Promise<void>
    stop: () => Promise<void>
    /** Forgets what was heard so far. */
    reset: () => Promise<void>
    /** Reads the text aloud in the system voice; done when it was said, or cut short. */
    say: (text: string) => Promise<void>
    /** Stops what is being read aloud. */
    hush: () => Promise<void>
    /** 16 kHz mono samples from the microphone. */
    audio: (samples: Float32Array) => void
    /** What was heard, corrected by a small model (Haiku on Claude, Luna on Codex) told the names given. Throws when it has no answer worth taking. */
    fix: (req: { harness: string; model: string; text: string; names: string[] }) => Promise<string>
    /** Starts that model's process ahead of the first sentence. */
    warmFix: (req: { harness: string; model: string }) => Promise<void>
  }
  onEvent: (handler: (e: AppEvent) => void) => () => void
  platform: string
  /** Under test, the first-run screen is not shown. */
  skipFirstRun?: boolean
}
declare global {
  interface Window {
    sb: Bridge
  }
}

export const bridge = window.sb

/** Call a tool on a connector; `workspace` makes aliases resolve through that workspace's bindings. */
export async function call<T = any>(connector: string, tool: string, args: Record<string, unknown> = {}, workspace?: string, read?: ReadRequest): Promise<T> {
  const r = await bridge.call({ workspace, connector, tool, args, read })
  if (!r.ok) throw new Error(r.error)
  return r.data as T
}
export const app = <T = any>(tool: string, args: Record<string, unknown> = {}) => call<T>('app', tool, args)

/** A file dropped, pasted or picked, as one the agent engine can attach: by its path when it has one, else by its bytes. */
export async function stageFile(file: File): Promise<Attachment> {
  const path = bridge.pathForFile(file)
  const r = await bridge.stageFile(path ? { path, name: file.name } : { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
  if (!r.ok) throw new Error(r.error)
  return r.data
}

type HostHandler = (type: string, payload: Record<string, unknown>) => void
let hostHandler: HostHandler = () => {}
export const onKitPost = (h: HostHandler) => (hostHandler = h)

// The host's own panels use the kit too (the agent panel is kit components on a direct transport).
setTransport({ workspace: null, call: (connector, tool, args, read) => call(connector, tool, args, undefined, read), post: (type, payload = {}) => hostHandler(type, payload), stage: stageFile })

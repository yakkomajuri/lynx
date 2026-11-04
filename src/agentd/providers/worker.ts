import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { AgentSpec, Emit } from './types'
import { providerById, type Session } from './registry'
import { claudeProviderSettings } from './claude-settings'
import { envSecrets, headerSecrets, redactValue } from './redact'
import { inputChannel } from './input-channel'

// Inside a desktop app the worker runs on Electron's binary in Node mode. The agent and the
// commands it runs must not inherit that, or any Electron app they start would run as Node too.
delete process.env.ELECTRON_RUN_AS_NODE
// The compile cache is on for this process by now; the agent's own Node programs keep theirs.
delete process.env.NODE_COMPILE_CACHE

const lines = createInterface({ input: process.stdin })
const abort = new AbortController()
process.on('SIGTERM', () => abort.abort())
let secrets: string[] = []
let completed = false
const emit: Emit = async (event) => {
  if (!process.stdout.write(JSON.stringify(redactValue(event, secrets)) + '\n'))
    await once(process.stdout, 'drain')
  if (event.type === 'agent_completed') completed = true
}
const channel = inputChannel(emit, abort.signal)
// "default" names no model: the provider picks its own, as when none is given.
const named = (s: AgentSpec): AgentSpec => (s.config.model === 'default' ? { ...s, config: { ...s.config, model: undefined } } : s)
// A warm worker serves its session's later messages too: each arrives as a `turn` line.
const queued: AgentSpec[] = []
let wake: (() => void) | undefined
let ended = false
const nextTurn = async () => {
  while (!queued.length && !ended) await new Promise<void>((r) => (wake = r))
  return queued.shift()
}
// One synchronous reader from the start: the spec and a cancel can arrive in the same chunk, and
// readline emits both before anything awaiting the first line could start listening for the second.
let gotSpec!: (spec: AgentSpec | undefined) => void
const firstSpec = new Promise<AgentSpec | undefined>((r) => (gotSpec = r))
let started = false
lines.on('close', () => {
  ended = true
  wake?.()
  gotSpec(undefined)
})
lines.on('line', (line) => {
  if (!started) {
    started = true
    return gotSpec(named(JSON.parse(line)))
  }
  const message = JSON.parse(line)
  if (message.type === 'cancel') abort.abort()
  if (message.type === 'turn') {
    queued.push(named(message.spec))
    wake?.()
  }
  if (message.type === 'input_response')
    void channel.respond(message.id, message.response).catch((error) => {
      process.stderr.write(String(error))
      abort.abort()
    })
})

const read = await firstSpec
// Nothing was asked of this worker.
if (!read) process.exit(0)
const spec: AgentSpec = read
secrets = [
  ...headerSecrets((spec.connections ?? []).map((c) => c.headers)),
  ...envSecrets(process.env, claudeProviderSettings().env ?? {}),
]
const definition = providerById(spec.harness)
let live: Session | undefined
try {
  if (!definition) throw new Error('Unsupported harness')
  live = await definition.session(spec, { emit, signal: abort.signal, ask: channel.ask, secrets: () => secrets })
  const gone = live.closed?.then(() => undefined) ?? new Promise<undefined>(() => {})
  for (let next: AgentSpec | undefined = spec; next; next = spec.warm ? await Promise.race([nextTurn(), gone]) : undefined) {
    // A cancel that came while the provider was starting, or between turns, is not lost.
    if (abort.signal.aborted) throw new Error('Cancelled before the turn started')
    completed = false
    secrets = [...new Set([...secrets, ...headerSecrets((next.connections ?? []).map((c) => c.headers))])]
    await live.turn(next)
    if (spec.warm) await emit({ type: 'turn_done', payload: {} })
  }
} catch (e) {
  if (!completed)
    await emit({
      type: 'agent_completed',
      payload: { success: false, error: e instanceof Error ? e.message : String(e) },
    })
  process.exitCode = 1
} finally {
  live?.close()
  lines.close()
  process.stdin.destroy()
}

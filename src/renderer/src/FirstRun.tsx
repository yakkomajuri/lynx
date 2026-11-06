// The first-run screen: before a new install's window shows the app, five steps over all of it.
// Welcome; Lynx runs on the user's own Claude Code or Codex (one installed and signed in lets them
// on); what Lynx does; whether to turn voice input on (its model downloads meanwhile); and connecting the services they use, by picking them or by saying so to an
// agent whose work shows as one line a step and a card per connector, not as a chat. That agent's
// conversation is the onboarding one (onboarding.ts): opening Lynx carries it on in the panel.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Bell, ChevronsUpDown, CircleAlert, CircleCheck, Mic, Moon, Paperclip, Settings, Sun } from 'lucide-react'
import { agents, isBusy, type Provider, type SessionEvent, useSession } from '@kit/agents'
import { call, useConnectors, useTool } from '@kit/core'
import { Icon } from '@kit/icons'
import { toItems } from '@kit/items'
import { ConnectorIcon } from '@kit/toolviews'
import { Modal as KitModal } from '@kit/ui'
import { createPortal } from 'react-dom'
import type { AppState } from '@shared/types'
import { voiceModel } from '@shared/voice'
import { bridge } from './api'
import { instructions, newDraftName } from './AgentPanel'
import { AgentMark } from './ComposerLine'
import { beginOnboarding, FIRST_RUN_RULES, MANUAL, onboardingRules, onboardingSession, tellOnboarding, useOnboardingSessionId } from './onboarding'
import { Toggle } from './Page'
import { useAgentSignIn } from './SignIn'
import { WorkspaceIcon } from './WorkspaceIcon'
import { agentStatus } from './agentStatus'
import { plannedTemplates, type Planned } from './firstRunTemplates'

/** Set once the first-run screen is done with (finished or skipped): it never shows again. */
const DONE = 'sb.firstrun.done'
export const firstRunDone = () => !!localStorage.getItem(DONE) || !!bridge.skipFirstRun

const STEPS = ['welcome', 'agents', 'what', 'voice', 'connect'] as const

/** The speech model the voice step turns on: the balanced one, Settings' default too. */
const FIRST_RUN_VOICE_MODEL = 'parakeet'
/** Its download, as the switch says it: to the nearest 10 MB. */
const FIRST_RUN_VOICE_SIZE = `${Math.round(voiceModel(FIRST_RUN_VOICE_MODEL).download / 1e7) * 10}MB`

/** The two agents Lynx runs, and where each says how to install it. */
const AGENTS = [
  { name: 'claude', title: 'Claude Code', docs: 'https://code.claude.com/docs/en/setup#install-claude-code' },
  { name: 'codex', title: 'Codex', docs: 'https://learn.chatgpt.com/docs/codex/cli#getting-started' },
]

/** Services to pick from, by their MCP servers: examples, not the limit. */
const PICKS: { name: string; url: string; /** Where to make the token it asks for, when it asks for one. */ token?: string }[] = [
  { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', token: 'https://github.com/settings/personal-access-tokens/new' },
  { name: 'PostHog', url: 'https://mcp.posthog.com/mcp' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { name: 'Stripe', url: 'https://mcp.stripe.com' },
  { name: 'Granola', url: 'https://mcp.granola.ai/mcp' },
  { name: 'Mercury', url: 'https://mcp.mercury.com/mcp' },
]

/**
 * Starts the onboarding conversation from the first-run screen (a request typed there, or a
 * connection made before one was), on the agent picked on the screen. Resolves to whether it has it.
 */
export async function startFromFirstRun(state: AppState, prompt: string) {
  // The agent new conversations start with when it can run, else the first that can.
  const { providers } = await call<{ providers: Provider[] }>('agents', 'server_status').catch(() => ({ providers: [] as Provider[] }))
  const runs = (name: string | null) => !!name && providers.some((p) => p.name === name && p.available && p.signed_in !== false)
  const saved = localStorage.getItem('sb.agent.harness')
  const harness = runs(saved) ? saved! : (AGENTS.find((a) => runs(a.name))?.name ?? saved ?? 'claude')
  const onboarding = state.workspaces.find((w) => w.onboarding && !w.archived)
  const r = await beginOnboarding(async () => {
    const started = await agents.start({
      prompt,
      harness,
      cwd: state.agentDir,
      permission: 'allow',
      labels: { kind: 'agent', title: prompt.replace(/\s+/g, ' ').trim().slice(0, 80), conversation: newDraftName(), onboarding: '1', ...(onboarding ? { workspace: onboarding.id } : {}) },
      instructions: instructions(state.settings.designSystem) + onboardingRules(state.agentDir, harness) + FIRST_RUN_RULES,
    })
    return started.session.id
  })
  if (!r.started) tellOnboarding(r.id, prompt)
  return true
}

/** How the first-run screen ended: what was connected and made from templates, and what the agent panel opens on. */
export interface FirstRunEnd {
  /** The services connected, by name. */
  connected: string[]
  /** The workspaces made from templates, as the screen named them. */
  made: string[]
  /** What the agent says first in the conversation the panel opens on, when it made some. */
  intro?: string
  /** The message waiting in the box, for services with no template. */
  draft?: string
}

export function FirstRun({ state, onDone }: { state: AppState; /** Finished or skipped. */ onDone: (end: FirstRunEnd) => void }) {
  const [at, setAt] = useState(0)
  // The steps seen so far: the dots go back to any of them.
  const [seen, setSeen] = useState(0)
  useEffect(() => setSeen((n) => Math.max(n, at)), [at])
  const [agentReady, setAgentReady] = useState(false)
  const slides = STEPS.length
  const step = STEPS[at]
  const last = at === slides - 1
  // Everything connected by now, however: the picks, the agent's, settings.
  const connected = state.connectors.filter((c) => !c.native && c.status === 'connected')
  // With something connected, Open Lynx goes on to a last step that makes workspaces from templates.
  const [preparing, setPreparing] = useState(false)
  const finish = () => {
    if (!connected.length) {
      localStorage.setItem(DONE, '1')
      return onDone({ connected: [], made: [] })
    }
    setPreparing(true)
  }
  const next = () => (last ? finish() : setAt((n) => n + 1))
  // Voice input as the switch on its step has it: put into effect only on going on past the step, so
  // flicking it on and off downloads nothing. On, the model downloads in the background (src/main/voice.ts).
  const [voiceWanted, setVoiceWanted] = useState(state.voice.enabled)
  const from = useRef(at)
  useEffect(() => {
    const left = STEPS[from.current] === 'voice' && at > from.current
    from.current = at
    if (!left || voiceWanted === state.voice.enabled) return
    const fail = (e: unknown) => console.error('[first run] could not change voice input', e)
    if (voiceWanted) void bridge.voice.set({ enabled: true, model: FIRST_RUN_VOICE_MODEL }).catch(fail)
    else void bridge.voice.set({ enabled: false }).then(() => (state.voice.download ? bridge.voice.cancel() : undefined)).catch(fail)
  }, [at])
  const blocked = step === 'agents' && !agentReady
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea')) return
      if ((e.key === 'Enter' || e.key === 'ArrowRight') && !blocked) next()
      else if (e.key === 'ArrowLeft' && at > 0) setAt(at - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const label = at === 0 ? 'Get started' : last ? (connected.length ? `Open Lynx · ${connected.length} connected` : 'Skip for now') : 'Continue'
  if (preparing)
    return (
      <div className="fr" role="dialog" aria-modal="true" aria-label="Preparing your Lynx">
        <div className="fr-titlebar" aria-hidden="true" />
        <div className="fr-stage">
          <Preparing
            state={state}
            onDone={(end) => {
              localStorage.setItem(DONE, '1')
              onDone(end)
            }}
          />
        </div>
      </div>
    )
  return (
    <div className="fr" role="dialog" aria-modal="true" aria-label="Welcome to Lynx">
      {/* The window still moves by its top, as by the title bar. */}
      <div className="fr-titlebar" aria-hidden="true" />
      <ModeButton mode={state.settings.mode} />
      <div className="fr-stage">
        {step === 'welcome' && <Welcome key="welcome" />}
        {step === 'agents' && <Agents key="agents" onReady={setAgentReady} />}
        {step === 'what' && <WhatItDoes key="what" />}
        {step === 'voice' && <VoiceStep key="voice" wanted={voiceWanted} onWant={setVoiceWanted} />}
        {step === 'connect' && <Connect key="connect" state={state} />}
      </div>
      <footer className="fr-foot">
        <div className="fr-dots" role="tablist" aria-label="Steps">
          {Array.from({ length: slides }, (_, i) => (
            <button key={i} className={i === at ? 'on' : ''} aria-label={`Step ${i + 1}`} aria-selected={i === at} role="tab" disabled={i > seen} onClick={() => setAt(i)} />
          ))}
        </div>
        <div className="fr-acts">
          {at > 0 && (
            <button className="fr-btn ghost" onClick={() => setAt(at - 1)}>
              Back
            </button>
          )}
          <button className={`fr-btn${last && !connected.length ? '' : ' primary'}`} disabled={blocked} onClick={next}>
            {label} <kbd>↵</kbd>
          </button>
        </div>
      </footer>
    </div>
  )
}

/**
 * The last step, with something connected: a workspace from the main template of each connected
 * service that has one, a line for each as it is made, then the checklist's ticks and how the agent
 * panel opens: the agent's word on what it made, and a message ready about the rest.
 */
function Preparing({ state, onDone }: { state: AppState; onDone: (end: FirstRunEnd) => void }) {
  const [line, setLine] = useState('Preparing your Lynx')
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
    void (async () => {
      const connectors = state.connectors.filter((c) => !c.native && c.status === 'connected')
      // The initial catalog request may still be running. Use its result (or the last cached list)
      // before planning, so a fresh install does not miss its templates just because the network is slow.
      await call('app', 'marketplace_refresh').catch(() => {})
      const latest = await bridge.state().catch(() => state)
      const plan = plannedTemplates(
        connectors.map((c) => ({ id: c.id, name: c.name, url: c.url, status: c.status, native: c.native })),
        latest.marketplace,
        latest.workspaces,
      )
      await pause(1400)
      const made: Planned[] = []
      for (const p of plan) {
        setLine(`Creating a workspace for ${p.label}`)
        // Each line stays long enough to read, however fast the fork is.
        const [ok] = await Promise.all([
          call('app', 'marketplace_fork', { item: p.item, source: 'remote', connectors: p.connectors }).then(
            () => true,
            (e) => (console.error('[first run] could not fork', p.item, e), false),
          ),
          pause(1100),
        ])
        if (ok) made.push(p)
      }
      // The checklist: connected, and a workspace made.
      const onboarding = state.workspaces.find((w) => w.onboarding)
      if (onboarding) {
        const key = { collection: `ui/${onboarding.id}`, key: 'onboarding.ticks' }
        const ticks = (await call<{ value: Record<string, boolean> | null }>('app', 'db_get', key).catch(() => ({ value: null }))).value ?? {}
        await call('app', 'db_put', { ...key, value: { ...ticks, connect: true, ...(made.length ? { workspace: true } : {}) } }).catch(() => {})
      }
      const covered = new Set(made.flatMap((p) => Object.values(p.connectors)))
      const rest = connectors.filter((c) => !covered.has(c.id)).map((c) => pickOf(c.url)?.name ?? c.name)
      const names = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`)
      const intro = made.length
        ? `I've created workspaces for ${names(made.map((p) => p.label))} from Lynx's templates. Find them in the list of workspaces at the top left, or press ⌘K.${rest.length ? ` Want me to build something for ${names(rest)} too?` : ''}`
        : undefined
      const draft = rest.length ? `I've connected ${names(rest)}, create some useful workspaces for me based on these connectors in the background.` : undefined
      onDone({ connected: connectors.map((c) => pickOf(c.url)?.name ?? c.name), made: made.map((p) => p.label), intro, draft })
    })()
  }, [])
  return (
    <section className="fr-slide fr-preparing">
      <span className="fr-preparing-spin" aria-hidden="true" />
      <h2 key={line} className="fr-in" aria-live="polite">
        {line}
      </h2>
    </section>
  )
}

/** Light or dark, from the top right: the app's own setting (Appearance), so it holds once the app is open. */
function ModeButton({ mode }: { mode: string }) {
  const media = useMemo(() => matchMedia('(prefers-color-scheme: dark)'), [])
  const [systemDark, setSystemDark] = useState(media.matches)
  useEffect(() => {
    const on = () => setSystemDark(media.matches)
    media.addEventListener('change', on)
    return () => media.removeEventListener('change', on)
  }, [media])
  const dark = mode === 'dark' || (mode !== 'light' && systemDark)
  return (
    <button className="fr-mode" onClick={() => void call('app', 'mode_set', { mode: dark ? 'light' : 'dark' })} aria-label={dark ? 'Switch to light' : 'Switch to dark'} title={dark ? 'Light' : 'Dark'}>
      {dark ? <Sun size={15} strokeWidth={1.8} /> : <Moon size={15} strokeWidth={1.8} />}
    </button>
  )
}

function Welcome() {
  return (
    <section className="fr-slide">
      <svg className="fr-mark fr-in" viewBox="0 0 100 100" aria-hidden="true">
        <path fillRule="evenodd" d="M50 88 L30 76 L16 58 L22 34 L24 16 L40 34 L60 34 L76 16 L78 34 L84 58 L70 76 Z M31 50 Q38 44 45 52 Q37 56 31 50 Z M69 50 Q62 44 55 52 Q63 56 69 50 Z M45 62 L55 62 L50 68 Z" />
      </svg>
      <h1>
        {['Welcome', 'to', 'Lynx'].map((w, i) => (
          <Fragment key={w}>
            {i > 0 && ' '}
            <span className="fr-word fr-in" style={{ '--d': 250 + i * 130 } as React.CSSProperties}>
              {w}
            </span>
          </Fragment>
        ))}
      </h1>
      <p className="fr-sub fr-in" style={{ '--d': 900 } as React.CSSProperties}>
        The open-source AI workspace you can fully customize
      </p>
    </section>
  )
}

/** Claude Code and Codex as this Mac has them, asked again every few seconds so an install or a sign-in shows up by itself. */
function Agents({ onReady }: { onReady: (ready: boolean) => void }) {
  const q = useTool<{ providers: Provider[] }>('agents', 'server_status', {}, { refresh: 3000, staleMs: 0 })
  const providers = q.data?.providers ?? []
  const of = (name: string) => providers.find((p) => p.name === name)
  // Signed in unless it says otherwise: an agent that cannot tell is given the benefit of the doubt.
  const isReady = (p?: Provider) => !!p?.available && p.signed_in !== false
  const ready = AGENTS.filter((a) => isReady(of(a.name))).map((a) => a.name)
  useEffect(() => onReady(ready.length > 0), [ready.join()])
  const loading = !q.data
  const none = !loading && AGENTS.every((a) => !of(a.name)?.available)
  const status = agentStatus(
    AGENTS.map((a) => ({ title: a.title, state: !of(a.name)?.available ? 'missing' : of(a.name)!.signed_in === false ? 'out' : 'ready' })),
    loading,
  )
  return (
    <section className="fr-slide fr-anchored fr-agents-step">
      <h2 className="fr-in">
        Lynx runs <u>locally</u>, using your own Claude Code or Codex
      </h2>
      <p className="fr-sub fr-in" style={{ '--d': 200 } as React.CSSProperties}>
        Use your own harnesses with your existing subscriptions.
      </p>
      {!loading && (
        <div className="fr-agents">
          {AGENTS.map((a, i) => (
            <AgentCard key={a.name} agent={a} provider={of(a.name)} delay={i * 120} onChanged={() => void q.reload()} />
          ))}
        </div>
      )}
      {none && (
        <div className="fr-need">
          <span>Installed one already?</span>
          <button className="fr-btn sm" onClick={() => void q.reload()}>
            Check again
          </button>
        </div>
      )}
      {/* Where things stand, under the cards: a check in a circle once one is good to go. */}
      <div className={`fr-status${status.ok === null ? ' now' : ''}`} aria-live="polite">
        {status.ok === null ? <span className="fr-tick" /> : status.ok ? <CircleCheck className="fr-ok" size={17} strokeWidth={2} aria-hidden="true" /> : <CircleAlert className="fr-warn" size={17} strokeWidth={2} aria-hidden="true" />}
        <span>{status.text}</span>
      </div>
    </section>
  )
}


/** One flat row per agent, one height whatever its state: what changes is the line under its name and the slot on the right. */
function AgentCard({ agent, provider, delay, onChanged }: { agent: (typeof AGENTS)[number]; provider?: Provider; delay: number; onChanged: () => void }) {
  const state = !provider?.available ? 'missing' : provider.signed_in === false ? 'out' : 'ready'
  if (state === 'out' && provider) return <SignInRow agent={agent} provider={provider} delay={delay} onChanged={onChanged} />
  return (
    <AgentRow
      agent={agent}
      state={state}
      delay={delay}
      sub={state === 'ready' ? <div className="fr-agent-sub mono">{provider?.version?.replace(/\s*\(.*\)$/, '') ?? ''}</div> : <div className="fr-agent-sub">Not installed · Lynx notices once it is</div>}
      side={
        state === 'ready' ? (
          <span className="fr-pill">
            Signed in
          </span>
        ) : (
          <button className="fr-btn sm" onClick={() => void bridge.openExternal(agent.docs)} aria-label={`Install ${agent.title}`}>
            Install ↗
          </button>
        )
      }
    />
  )
}

function AgentRow({ agent, state, delay, sub, side }: { agent: (typeof AGENTS)[number]; state: string; delay: number; sub: React.ReactNode; side: React.ReactNode }) {
  return (
    <div className={`fr-agent ${state}`} style={{ animationDelay: `${delay}ms` }} role="group" aria-label={agent.title}>
      <span className="fr-agent-logo">
        <AgentMark harness={agent.name} size={20} />
      </span>
      <div className="fr-agent-text">
        <div className="fr-agent-name">{agent.title}</div>
        {sub}
      </div>
      <div className="fr-agent-side">{side}</div>
    </div>
  )
}

/** Signed out: the agent's own sign-in, through the browser or in Terminal; the step asks again as it goes. */
function SignInRow({ agent, provider, delay, onChanged }: { agent: (typeof AGENTS)[number]; provider: Provider; delay: number; onChanged: () => void }) {
  const { browser, state, signIn, cancel, openTerminal } = useAgentSignIn(provider)
  useEffect(() => {
    if (state.at === 'done') onChanged()
  }, [state.at])
  const sub =
    state.at === 'waiting' ? (
      <div className="fr-agent-sub wait">Finish signing in in your browser…</div>
    ) : state.at === 'opened' ? (
      <div className="fr-agent-sub wait">Sign in in Terminal, then come back</div>
    ) : state.at === 'failed' ? (
      <div className="fr-agent-sub bad" title={state.error}>
        {state.error}
      </div>
    ) : state.at === 'copied' ? (
      <div className="fr-agent-sub" title={state.command}>
        Could not open Terminal · copied {state.command}
      </div>
    ) : (
      <div className="fr-agent-sub">Not signed in · {browser ? 'signs in in your browser' : 'signs in from Terminal'}</div>
    )
  const side =
    state.at === 'waiting' ? (
      <button className="fr-btn sm ghost" onClick={cancel}>
        Cancel
      </button>
    ) : browser ? (
      <button className="fr-btn sm primary" disabled={state.at === 'starting'} onClick={() => void signIn()}>
        {state.at === 'failed' ? 'Try again' : 'Sign in'}
      </button>
    ) : (
      <button className="fr-btn sm primary" onClick={() => void openTerminal()}>
        {state.at === 'opened' ? 'Open again' : 'Sign in'}
      </button>
    )
  return <AgentRow agent={agent} state="out" delay={delay} sub={sub} side={side} />
}

function WhatItDoes() {
  return (
    <section className="fr-slide fr-anchored">
      <h2 className="fr-in">Connect your data, build custom UIs, and trigger local agents from them</h2>
      <PointDemo />
    </section>
  )
}

/** Whether to turn voice input on: the agent's message box with voice at work, and a switch. The switch is only a wish until Continue (FirstRun). */
function VoiceStep({ wanted, onWant }: { wanted: boolean; onWant: (on: boolean) => void }) {
  return (
    <section className="fr-slide fr-anchored fr-voice-step">
      <h2 className="fr-in">Enable voice input?</h2>
      <div className="fr-voice-opt fr-in" style={{ '--d': 200 } as React.CSSProperties}>
        <div className="fr-voice-opt-text" onClick={() => onWant(!wanted)}>
          <span className="fr-voice-opt-name">Voice input</span>
          <small>Downloads a {FIRST_RUN_VOICE_SIZE} model in the background, ready in a few minutes.</small>
          <small>Configure voice input any time in Settings.</small>
        </div>
        <Toggle on={wanted} label="Voice input" onChange={onWant} />
      </div>
      <VoiceDemo />
    </section>
  )
}

const VOICE_SAID = ['Show', 'me', "this week's", 'open', 'Linear', 'issues']
/** The agent's message box with voice at work, whatever the switch says: the microphone in it, and what is said writing itself in, again and again. */
function VoiceDemo() {
  const [words, setWords] = useState(0)
  useEffect(() => {
    // A beat of listening, a word at a time, a pause on the whole line, then again.
    let n = 0
    const t = setInterval(() => {
      n = (n + 1) % (VOICE_SAID.length + 6)
      setWords(Math.max(0, Math.min(VOICE_SAID.length, n - 2)))
    }, 380)
    return () => clearInterval(t)
  }, [])
  const said = VOICE_SAID.slice(0, words).join(' ')
  return (
    <div className="fr-voice-demo fr-in" style={{ '--d': 350 } as React.CSSProperties} aria-hidden="true">
      <div className="h-voice listening hearing">
          <span className="h-voice-wave">
            {Array.from({ length: 7 }, (_, i) => (
              <i key={i} style={{ '--i': i } as React.CSSProperties} />
            ))}
          </span>
          <span className="h-voice-label">Listening</span>
      </div>
      <div className="sb-composer line">
        <div className="sb-composer-box">
          <div className="sb-composer-row">
            <span className="sb-attach">
              <Paperclip size={17} strokeWidth={1.7} />
            </span>
            <span className={`fr-voice-field${said ? '' : ' empty'}`}>{said || 'Ask anything, @ to mention'}</span>
            <span className="sb-attach h-voice-toggle on">
              <Mic size={17} strokeWidth={1.7} />
            </span>
            <span className={`sb-send${said ? '' : ' off'}`}>
              <ArrowUp size={18} strokeWidth={2.2} />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// Work an agent could do, and not all of it code. The second is the one picked.
const DEMO_ISSUES = [
  { id: 'GTM-418', title: 'Draft the Q3 board update', status: 'In progress', tone: 'run' },
  { id: 'GTM-412', title: 'Make a sales presentation for Acme Inc.', status: 'Todo', tone: 'todo' },
  { id: 'GTM-407', title: "Summarise last week's customer calls", status: 'Todo', tone: 'todo' },
  { id: 'GTM-401', title: "Research competitors' pricing pages", status: 'Backlog', tone: 'later' },
  { id: 'GTM-396', title: 'Clean up duplicate leads in the CRM', status: 'Backlog', tone: 'later' },
]
const DEMO_ASK = 'Add a button that triggers an agent to do this task'
/** The demo's beats, in ms from the start of a round; then it starts again. */
const BEATS = { reach: 500, point: 1400, toRow: 1800, picked: 2700, typing: 3100, magic: 5600, aim: 7700, click: 8400, running: 8700, again: 12200 }
type Beat = 'idle' | keyof typeof BEATS
const ORDER: Beat[] = ['idle', 'reach', 'point', 'toRow', 'picked', 'typing', 'magic', 'aim', 'click', 'running']
type Spot = { x: number; y: number; bottom: number }
/** The button comes in as pixels: each lights at a random moment, then the button is under them and they go out at random. */
const PIXEL_COLS = 30
const PIXEL_ROWS = 7
const PIXELS = Array.from({ length: PIXEL_COLS * PIXEL_ROWS }, (_, i) => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1
  return { on: Math.round(r(1) * 850), off: 1000 + Math.round(r(2) * 850), tone: r(3) < 0.85 ? 'ink' : 'blue' }
})

/**
 * What Lynx does, played out in a small Lynx on a Linear workspace: Point picks a row and its note
 * asks for a button that gives the task to an agent; the button appears in the row, is clicked, and
 * turns into Claude Code at work.
 */
function PointDemo() {
  const [beat, setBeat] = useState<Beat>('idle')
  const [typed, setTyped] = useState(0)
  const [round, setRound] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const pointButton = useRef<HTMLSpanElement>(null)
  const slot = useRef<HTMLSpanElement>(null)
  const none = { x: 0, y: 0, bottom: 0 }
  const [aimAt, setAimAt] = useState<{ point: Spot; row: Spot; button: Spot }>({ point: none, row: none, button: none })
  // Where things are, as laid out now: the cursor goes to Point in the title bar, then the row, then the new button.
  const measure = () => {
    const at = (el: HTMLElement | null, dx: number): Spot => {
      const b = box.current?.getBoundingClientRect()
      const r = el?.getBoundingClientRect()
      return b && r ? { x: r.left - b.left + dx, y: r.top - b.top + r.height / 2, bottom: r.bottom - b.top } : none
    }
    setAimAt({ point: at(pointButton.current, (pointButton.current?.offsetWidth ?? 60) / 2 - 2), row: at(row.current, (row.current?.offsetWidth ?? 0) * 0.42), button: at(slot.current, Math.max(28, (slot.current?.offsetWidth ?? 60) - 64)) })
  }
  useLayoutEffect(measure, [round])
  useEffect(() => {
    const timers = (Object.entries(BEATS) as [keyof typeof BEATS, number][]).map(([name, ms]) =>
      setTimeout(() => (name === 'again' ? (setBeat('idle'), setTyped(0), setRound((n) => n + 1)) : setBeat(name)), ms),
    )
    return () => timers.forEach(clearTimeout)
  }, [round])
  useEffect(() => {
    if (beat !== 'typing') return
    const t = setInterval(() => setTyped((n) => (n >= DEMO_ASK.length ? n : n + 1)), 34)
    return () => clearInterval(t)
  }, [beat])
  const past = (b: Beat) => ORDER.indexOf(beat) >= ORDER.indexOf(b)
  const pointing = past('point') && !past('magic')
  // The blue box goes with the note, once it is sent.
  const picked = past('picked') && !past('magic')
  // First it turns Point on from the title bar, then picks the row, then clicks the new button.
  const cursor = !past('reach')
    ? { x: (box.current?.offsetWidth ?? 600) - 40, y: (box.current?.offsetHeight ?? 320) - 30, shown: false }
    : past('aim')
      ? { ...aimAt.button, shown: true }
      : past('toRow')
        ? { ...aimAt.row, shown: true }
        : { ...aimAt.point, shown: true }
  // Over a button it is about to click, the cursor is the hand.
  const hand = past('aim') || (past('reach') && !past('toRow'))
  return (
    <div
      className="fr-demo fr-in"
      style={{ '--d': 400 } as React.CSSProperties}
      ref={box}
      role="img"
      aria-label="Lynx on a Linear workspace: Point is turned on, picks an issue and asks for a button that gives it to an agent; the button appears, is clicked, and Claude Code starts on it"
    >
      {/* Lynx's own title bar, in small: the workspace and its switcher, then Point and the agent. */}
      <div className="fr-demo-bar">
        <span className="fr-demo-dots" />
        <span className="fr-demo-crumb">
          <WorkspaceIcon icon="square-kanban" color="purple" size={15} />
          <span className="h-crumb ws on">Linear</span>
          <span className="h-switch">
            <ChevronsUpDown size={14} strokeWidth={1.8} />
          </span>
        </span>
        <span className="fr-demo-acts">
          <span ref={pointButton} className={`sb-btn sm ${pointing ? 'primary' : 'outline'}${beat === 'point' ? ' pressed' : ''}`}>
            <Icon name="pointer" size={13} />
            {pointing ? 'Done' : 'Point'}
            <kbd>⌘E</kbd>
          </span>
          <span className="sb-btn sm">
            Agent
            <kbd>⌘D</kbd>
          </span>
          <span className="fr-demo-icon">
            <Bell size={15} strokeWidth={1.7} />
          </span>
          <span className="fr-demo-icon">
            <Settings size={15} strokeWidth={1.7} />
          </span>
        </span>
      </div>
      <div className="fr-demo-head">
        <b>My issues</b>
        <span>5 open</span>
      </div>
      <div className="fr-demo-list">
        {DEMO_ISSUES.map((issue, i) => {
          const target = i === 1
          return (
            <div key={issue.id} ref={target ? row : undefined} className={`fr-demo-row${target && picked ? ' picked' : ''}${target && beat === 'magic' ? ' magic' : ''}`}>
              {target && picked && <span className="fr-demo-mark">1</span>}
              <span className={`fr-demo-status ${issue.tone}`} />
              <span className="fr-demo-id">{issue.id}</span>
              <span className="fr-demo-name">{issue.title}</span>
              <span className="fr-demo-slot" ref={target ? slot : undefined}>
                {target && past('magic') ? (
                  <span className={`fr-demo-flip${past('running') ? ' over' : ''}${beat === 'click' ? ' pressed' : ''}`}>
                    <b className="fr-demo-pixels" style={{ gridTemplateColumns: `repeat(${PIXEL_COLS}, 1fr)` }} aria-hidden="true">
                      {PIXELS.map((p, n) => (
                        <i key={n} className={p.tone} style={{ '--on': `${p.on}ms`, '--off': `${p.off}ms` } as React.CSSProperties} />
                      ))}
                    </b>
                    <span className="fr-demo-btn">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M7 4.5v15l13-7.5z" />
                      </svg>
                      Run agent
                    </span>
                    <span className="fr-demo-running">
                      <AgentMark harness="claude" size={12} />
                      Claude Code running
                      <span className="sb-spinner" />
                    </span>
                  </span>
                ) : (
                  <span className="fr-demo-tag">{issue.status}</span>
                )}
              </span>
            </div>
          )
        })}
      </div>
      {/* The note, typed under the row as Point takes it. */}
      {past('typing') && !past('magic') && (
        <div className="fr-demo-note" style={{ top: aimAt.row.y + 26 }}>
          {DEMO_ASK.slice(0, typed)}
          <i />
        </div>
      )}
      <span className={`fr-demo-cursor${cursor.shown ? ' on' : ''}${beat === 'click' || beat === 'point' ? ' click' : ''}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }} aria-hidden="true">
        {hand ? (
          <svg className="hand" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M9 11.5V4.8a1.6 1.6 0 0 1 3.2 0v5.4V8.6a1.6 1.6 0 0 1 3.2 0v1.8a1.6 1.6 0 0 1 3.2 0v1.2a1.6 1.6 0 0 1 3.2 0V16c0 3.3-2.6 6-6 6h-1.6c-2 0-3.6-.9-4.8-2.5l-3.5-4.8a1.6 1.6 0 0 1 2.4-2.1L9 13.4z"
              fill="var(--sb-bg)"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 3l7.5 18 2.6-7.4L21.5 11z" fill="currentColor" stroke="var(--sb-bg)" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </div>
  )
}

/** A tool call as a line of what the agent is doing. */
function stepText(name: string, input: unknown, lead?: string): string {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const tool = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '')
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '')
    } catch {
      return u
    }
  }
  if (tool === 'connector_add') return `Adding ${str(a.name) || 'a connector'}${str(a.url) ? ` · ${host(str(a.url))}` : ''}`
  if (tool === 'connector_update' || tool === 'connector_reconnect') return `Setting up ${str(a.connector) || 'a connector'}`
  if (tool === 'connector_list') return 'Checking your connectors'
  if (tool === 'connector_tools' || tool === 'connector_call') return `Trying ${str(a.connector) || 'the connector'}`
  if (tool === 'db_put') return `Noting how to connect ${str((a.value as Record<string, unknown> | undefined)?.name) || str(a.key) || 'it'}`
  if (/^web_?search$/i.test(tool) || tool === 'WebSearch') return `Searching the web for “${str(a.query) || lead || '…'}”`
  if (/fetch/i.test(tool)) return `Reading ${host(str(a.url) || lead || '')}`.trim()
  if (tool.startsWith('marketplace_')) return 'Looking at templates'
  if (tool === 'ToolSearch') return 'Getting its tools ready'
  return tool.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** A service the agent could not connect on its own, as it recorded it (onboarding.ts, MANUAL). */
interface Manual {
  name: string
  reason?: string
  steps?: string[]
  docs_url?: string
}

function Connect({ state }: { state: AppState }) {
  const sessionId = useOnboardingSessionId()
  const session = useSession(sessionId ?? undefined)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  // Picks added here, in order.
  const [picked, setPicked] = useState<{ name: string; connector?: string; adding: boolean }[]>([])
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const t = setTimeout(() => field.current?.focus(), 600)
    return () => clearTimeout(t)
  }, [])

  // What the agent is doing now, from its latest tool call, and the connectors it touched.
  const items = useMemo(() => toItems((session.events ?? []) as SessionEvent[]), [session.events])
  const calls = items.flatMap((it) => (it.kind === 'tools' ? it.steps : []))
  const agentCards = items.flatMap((it) => (it.kind === 'connect' ? [it.connector] : []))
  // Only what reaches a service over the network: a remote MCP server or an HTTP API. A local server is never offered here.
  const remote = (id: string) => !!state.connectors.find((c) => c.id === id && c.url)
  const cards = [...new Set([...picked.flatMap((p) => (p.connector ? [p.connector] : [])), ...agentCards])].filter(remote)
  // What it could not connect, with how the user can.
  const manual = useTool<{ items: { key: string; value: Manual }[] }>('app', 'db_query', { collection: MANUAL }, { refresh: 2500, staleMs: 0 })
  const [dismissed, setDismissed] = useState<string[]>([])
  const manuals = (manual.data?.items ?? []).filter((r) => r.value?.name && !dismissed.includes(r.key) && !cards.some((id) => state.connectors.find((c) => c.id === id)?.name.toLowerCase() === r.value.name.toLowerCase()))

  const adding = picked.find((p) => p.adding)
  const working = session.busy || sending || !!adding
  const last = calls.at(-1)
  const now = adding ? `Adding the ${adding.name} MCP server` : session.busy && last ? stepText(last.name, last.input, last.lead) : working ? 'Thinking…' : ''

  const pick = async (p: (typeof PICKS)[number]) => {
    if (picked.some((x) => x.name === p.name)) return
    setPicked((list) => [...list, { name: p.name, adding: true }])
    try {
      const c = await call<{ id: string }>('app', 'connector_add', { name: p.name.toLowerCase(), url: p.url })
      setPicked((list) => list.map((x) => (x.name === p.name ? { ...x, connector: c.id, adding: false } : x)))
    } catch (e) {
      setPicked((list) => list.filter((x) => x.name !== p.name))
      setError(`Could not add ${p.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const send = async () => {
    const said = text.trim()
    if (!said) return
    setText('')
    setError('')
    setSending(true)
    try {
      if (sessionId && !isBusy(session.status)) await session.send(said)
      else if (sessionId) tellOnboarding(sessionId, said)
      else await startFromFirstRun(state, said)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setText(said)
    } finally {
      setSending(false)
    }
  }
  const usedPick = (name: string) => picked.some((x) => x.name === name) || state.connectors.some((c) => !c.native && c.url && sameSite(c.url, PICKS.find((p) => p.name === name)!.url))

  return (
    <section className="fr-slide fr-anchored fr-connect">
      <h2 className="fr-in">Connect the services you use day-to-day</h2>
      <p className="fr-sub fr-in" style={{ '--d': 120 } as React.CSSProperties}>
        You can connect any MCP or API. Below are just some examples.
      </p>
      <div className="fr-picks fr-in" style={{ '--d': 260 } as React.CSSProperties}>
        {PICKS.map((p) => (
          <button key={p.name} className={`fr-pick${usedPick(p.name) ? ' used' : ''}`} disabled={usedPick(p.name)} onClick={() => void pick(p)}>
            <Favicon url={p.url} name={p.name} />
            {p.name}
          </button>
        ))}
      </div>
      <form
        className="fr-ask fr-in"
        style={{ '--d': 400 } as React.CSSProperties}
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <svg className="fr-spark" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
        </svg>
        <input ref={field} value={text} onChange={(e) => setText(e.target.value)} placeholder="Or say what you use: “GitHub, PostHog and Notion”" aria-label="Services you use" />
        <button className="fr-send" disabled={!text.trim() || sending} aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
      {/* One line, while something is going on: what is being done right now. */}
      <div className="fr-work" aria-live="polite">
        {error ? (
          <div className="fr-step bad">{error}</div>
        ) : (
          now && (
            <div className="fr-step now" key={now}>
              <span className="fr-tick" />
              <span>{now}</span>
            </div>
          )
        )}
      </div>
      {(cards.length > 0 || manuals.length > 0) && (
        <div className="fr-cards">
          {cards.map((id) => (
            <ServiceRow key={id} id={id} />
          ))}
          {manuals.map((r) => (
            <ManualRow key={r.key} manual={r.value} onDismiss={() => setDismissed((d) => [...d, r.key])} />
          ))}
        </div>
      )}
    </section>
  )
}

/** The kit's modal, over the whole screen: drawn at its root, not inside a slide that moves. */
function Modal(props: React.ComponentProps<typeof KitModal>) {
  return createPortal(<KitModal {...props} />, document.querySelector('.fr') ?? document.body)
}

/**
 * A service, as one row of one height like the agents': its state under its name and one thing to do on
 * the right. Signing in (OAuth) is that button; anything more, a key or a token, is asked in a modal.
 */
/** One of the picks, by where its server is. */
const pickOf = (url?: string) => (url ? PICKS.find((p) => sameSite(url, p.url)) : undefined)

function ServiceRow({ id }: { id: string }) {
  const { connectors } = useConnectors()
  const c = connectors.find((x) => x.id === id)
  const title = pickOf(c?.url)?.name ?? c?.name ?? id
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  if (!c) return null
  const status = c.status
  const host = c.url ? c.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : ''
  const api = c.api
  const signIn = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await call<{ status: string; error?: string }>('app', 'connector_reconnect', { connector: id, sign_in: true })
      if (r.status === 'auth-required') setWaiting(true)
      else if (r.status !== 'connected' && r.status !== 'needs-credentials') setError(r.error ?? 'Could not connect')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const sub =
    status === 'connected' ? (
      <div className="fr-agent-sub">Connected · {api ? 'HTTP API' : `${c.tool_count} tools`}</div>
    ) : status === 'connecting' ? (
      <div className="fr-agent-sub wait">Connecting…</div>
    ) : waiting && status === 'auth-required' ? (
      <div className="fr-agent-sub wait">Finish signing in in your browser…</div>
    ) : error || (status === 'error' && c.error) ? (
      <div className="fr-agent-sub bad" title={error || c.error}>
        {error || c.error}
      </div>
    ) : status === 'needs-credentials' ? (
      <div className="fr-agent-sub" title={host}>
        Needs {api?.auth_type === 'basic' ? 'a username and password' : api ? 'an API key' : 'a token'}
      </div>
    ) : (
      <div className="fr-agent-sub" title={host}>
        Sign-in needed
      </div>
    )
  const side =
    status === 'connected' ? (
      <span className="fr-pill">Connected</span>
    ) : status === 'connecting' ? null : status === 'needs-credentials' ? (
      <button className="fr-btn sm primary" onClick={() => setAsking(true)}>
        {api?.auth_type === 'basic' ? 'Sign in' : api ? 'Add key' : 'Add token'}
      </button>
    ) : (
      <button className="fr-btn sm primary" disabled={busy} onClick={() => void signIn()}>
        {waiting ? 'Open again' : status === 'error' ? 'Retry' : 'Sign in'}
      </button>
    )
  return (
    <>
      <div className={`fr-agent fr-service ${status === 'connected' ? 'ready' : 'out'}`} role="group" aria-label={title}>
        <span className="fr-agent-logo">
          <ConnectorIcon connector={id} size={20} />
        </span>
        <div className="fr-agent-text">
          <div className="fr-agent-name">{title}</div>
          {sub}
        </div>
        <div className="fr-agent-side">{side}</div>
      </div>
      {asking && <CredentialsModal id={id} onClose={() => setAsking(false)} />}
    </>
  )
}

/** The key, token or username and password a service asks for, and where to find it, in a modal. */
function CredentialsModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { connectors } = useConnectors()
  const c = connectors.find((x) => x.id === id)
  const pick = pickOf(c?.url)
  const name = pick?.name ?? c?.name ?? id
  const [key, setKey] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (c?.status === 'connected') onClose()
  }, [c?.status])
  if (!c) return null
  const api = c.api
  const basic = api?.auth_type === 'basic'
  const what = basic ? 'username and password' : api ? 'API key' : 'token'
  const sentAs = !api ? 'Sent as a bearer token' : api.auth_type === 'bearer' ? 'Sent as a bearer token' : api.auth_type === 'header' ? `Sent in the ${api.auth_name} header` : api.auth_type === 'query' ? `Sent as the ${api.auth_name} query parameter` : ''
  const submit = async () => {
    if (!key.trim()) return
    setBusy(true)
    setError('')
    try {
      const args = api ? { credentials: basic ? { username: key.trim(), password } : { key: key.trim() } } : { headers: { Authorization: /^(bearer|basic|token) /i.test(key.trim()) ? key.trim() : `Bearer ${key.trim()}` } }
      const r = await call<{ status: string; error?: string }>('app', 'connector_update', { connector: id, sign_in: true, ...args })
      if (r.status === 'connected') onClose()
      else setError(r.error ?? (r.status === 'needs-credentials' ? 'That was not accepted' : 'Could not connect'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={`Connect ${name}`}
      onClose={onClose}
      footer={
        <>
          <button className="fr-btn sm ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="fr-btn sm primary" disabled={!key.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      }
    >
      <form
        className="fr-modal"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <p>
          {name} connects with a {what}. {sentAs ? `${sentAs}. ` : ''}It stays on this Mac: agents use {name} through Lynx and never see it.
        </p>
        {basic ? (
          <>
            <input className="sb-input" autoFocus autoComplete="off" spellCheck={false} placeholder="Username" value={key} onChange={(e) => setKey(e.target.value)} aria-label={`Username for ${name}`} />
            <input className="sb-input" type="password" autoComplete="off" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label={`Password for ${name}`} />
          </>
        ) : (
          <input className="sb-input" autoFocus type="password" autoComplete="off" placeholder={api ? 'Paste the API key' : 'Paste the token'} value={key} onChange={(e) => setKey(e.target.value)} aria-label={`${what} for ${name}`} />
        )}
        {error && <small className="bad">{error}</small>}
        {(pick?.token ?? api?.docs_url) && /^https:\/\//.test(pick?.token ?? api?.docs_url ?? '') && (
          <button type="button" className="fr-link" onClick={() => void bridge.openExternal((pick?.token ?? api?.docs_url)!)}>
            {pick?.token ? `Create a token on ${name} ↗` : 'Where to find it ↗'}
          </button>
        )}
      </form>
    </Modal>
  )
}

/** A service the agent found no automatic way to connect: a row like the others, and how to do it by hand in a modal. */
function ManualRow({ manual, onDismiss }: { manual: Manual; onDismiss: () => void }) {
  const [open, setOpen] = useState(false)
  const steps = (manual.steps ?? []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 6)
  return (
    <>
      <div className="fr-agent fr-service manual" role="group" aria-label={`${manual.name}: connect it yourself`}>
        <span className="fr-agent-logo">
          <span className="fr-fav blank">{manual.name[0]?.toUpperCase()}</span>
        </span>
        <div className="fr-agent-text">
          <div className="fr-agent-name">{manual.name}</div>
          <div className="fr-agent-sub" title={manual.reason}>
            No automatic way to connect it
          </div>
        </div>
        <div className="fr-agent-side">
          <button className="fr-btn sm" onClick={() => setOpen(true)}>
            How to connect
          </button>
          <button className="fr-row-x" onClick={onDismiss} aria-label={`Dismiss ${manual.name}`} title="Dismiss">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>
      {open && (
        <Modal
          title={`Connect ${manual.name}`}
          onClose={() => setOpen(false)}
          footer={
            <>
              {manual.docs_url && /^https:\/\//.test(manual.docs_url) && (
                <button className="fr-btn sm" onClick={() => void bridge.openExternal(manual.docs_url!)}>
                  Open the docs ↗
                </button>
              )}
              <button className="fr-btn sm primary" onClick={() => setOpen(false)}>
                Done
              </button>
            </>
          }
        >
          <div className="fr-modal">
            <p>Lynx could not connect {manual.name} on its own{manual.reason ? `: ${manual.reason.replace(/\.$/, '')}` : ''}. You can connect it yourself:</p>
            {steps.length > 0 && (
              <ol>
                {steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}

function Favicon({ url, name }: { url: string; name: string }) {
  const q = useTool<{ icon?: string }>('app', 'connector_icon', { url }, { staleMs: Infinity })
  const [failed, setFailed] = useState(false)
  const icon = q.data?.icon
  if (!icon || failed) return <span className="fr-fav blank">{name[0]}</span>
  return <img className="fr-fav" src={icon} alt="" onError={() => setFailed(true)} />
}

const sameSite = (a: string, b: string) => {
  try {
    const host = (u: string) => new URL(u).hostname.split('.').slice(-2).join('.')
    return host(a) === host(b)
  } catch {
    return false
  }
}

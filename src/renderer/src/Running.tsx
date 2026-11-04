// The agents running right now, from the title bar: a bot beside the bell whose eyes move while any
// agent works, and which hops when a new one starts. It opens the list of them, by workspace: what
// each is doing, how it started (a page, a tool and what ran it, a schedule, an agent) and how long
// it has run. Conversations in the agent panel are already in view there; they are left out unless
// asked for.
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { ChevronRight, Clock, MousePointerClick, PanelRight, Sparkles, Wrench, Bot as BotIcon } from 'lucide-react'
import { call } from '@kit/core'
import { harnessName, PERMISSIONS, type PermissionMode, type SessionInfo, type SessionSummary } from '@kit/agents'
import { rel } from '@kit/ui'
import { cronWords } from '@shared/cronWords'
import { originOf, workspaceOf, type Origin } from '@shared/provenance'
import type { AppState } from '@shared/types'
import { WorkspaceIcon } from './WorkspaceIcon'

/** A run in any of these is still going. */
const ACTIVE = ['queued', 'starting', 'running', 'waiting_for_input', 'cancelling']
const POLL_MS = 2500
/** How long a finished agent stays in the list. */
const RECENT_MS = 60 * 60 * 1000
const SHOW_PANEL = 'sb.running.panel'

interface Row {
  session: SessionSummary
  origin: Origin
  workspace: string | null
}
interface Done extends Row {
  at: number
  /** How its last run ended, once known. */
  status?: string
}
/** What the list shows once it is open: when the run started, how, and what it is waiting for. */
interface Detail {
  startedAt?: string
  runId?: string
  model?: string | null
  permission?: PermissionMode | null
  need?: string
}

const rowOf = (session: SessionSummary): Row => ({ session, origin: originOf(session.labels), workspace: workspaceOf(session.labels) })

/** The agents running, polled while the engine is up, and the ones that stopped while the app watched. */
function useRunning(ready: boolean) {
  const [live, setLive] = useState<Row[] | null>(null)
  const [recent, setRecent] = useState<Done[]>([])
  const last = useRef<Map<string, Row>>(new Map())
  const tick = useRef<() => void>(() => {})
  useEffect(() => {
    if (!ready) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      clearTimeout(timer)
      try {
        const pages = await Promise.all(ACTIVE.map((status) => call<{ items: SessionSummary[] }>('agents', 'session_list', { status, limit: 200 })))
        if (stop) return
        const now = new Map(pages.flatMap((p) => p.items).map((s) => [s.id, rowOf(s)] as const))
        const gone = [...last.current.values()].filter((r) => !now.has(r.session.id))
        last.current = now
        setLive([...now.values()].sort((a, b) => a.session.created_at.localeCompare(b.session.created_at)))
        if (gone.length) {
          const at = Date.now()
          setRecent((r) => [...gone.map((g) => ({ ...g, at })), ...r].filter((d) => at - d.at < RECENT_MS).slice(0, 20))
          for (const g of gone)
            void call<SessionInfo>('agents', 'session_get', { id: g.session.id })
              .then((info) => setRecent((r) => r.map((d) => (d.session.id === g.session.id ? { ...d, status: info.latest_run?.status } : d))))
              .catch(() => {})
        }
      } catch {
        /* the engine is restarting: try again shortly */
      }
      if (!stop) timer = setTimeout(load, POLL_MS)
    }
    tick.current = () => void load()
    void load()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [ready])
  return { live, recent, reload: () => tick.current() }
}

/** The approval or answer a waiting run needs, in a few words. */
const needOf = (input: { kind: string; payload: any } | undefined) => {
  if (!input) return undefined
  const p = input.payload ?? {}
  if (input.kind === 'questions') return p.questions?.[0]?.question ? `Answer: ${p.questions[0].question}` : 'Answer a question'
  if (p.detail?.command) return `Approve running ${p.detail.command}`
  if (p.tool_name) return `Approve ${p.tool_name}`
  return 'Approve a step'
}

const elapsed = (from: string | undefined, now: number) => {
  if (!from) return ''
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000))
  return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)} h`
}

/** The bot in the title bar: its antenna and eyes drawn apart (Lucide's Bot) so they can move. */
function Bot() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path className="ant" d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <g className="eyes">
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </g>
    </svg>
  )
}

export function RunningAgents({ state, onScreen, onOpen, onConversation, toast, row }: { state: AppState; /** A named row of the sidebar instead of the bot in the title bar. */ row?: boolean; /** Workspaces on screen: their agents come first, and need no button to go there. */ onScreen: string[]; onOpen: (workspace: string) => void; /** Shows a conversation in the agent panel. */ onConversation: (session: SessionSummary) => void; toast: (text: string, tone?: 'good' | 'bad') => void }) {
  const { live, recent, reload } = useRunning(state.engine.status === 'ready')
  const [open, setOpen] = useState(false)
  const [showPanel, setShowPanel] = useState(() => localStorage.getItem(SHOW_PANEL) === '1')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [recentOpen, setRecentOpen] = useState(false)
  const [details, setDetails] = useState<Record<string, Detail>>({})
  const [now, setNow] = useState(Date.now())
  const [hop, setHop] = useState(0)
  const button = useRef<HTMLButtonElement>(null)

  const shown = (r: Row) => showPanel || r.origin.kind !== 'panel'
  const rows = (live ?? []).filter(shown)
  const waiting = rows.filter((r) => r.session.status === 'waiting_for_input').length
  const panelCount = (live ?? []).filter((r) => r.origin.kind === 'panel').length

  // A new agent makes the bot hop; not the ones already running when the app opened.
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!live) return
    const ids = live.filter(shown).map((r) => r.session.id)
    if (seen.current && ids.some((id) => !seen.current!.has(id))) setHop((h) => h + 1)
    seen.current = new Set([...(seen.current ?? []), ...ids])
  }, [live, showPanel])
  useEffect(() => {
    if (!hop) return
    const el = button.current
    el?.classList.remove('hop')
    void el?.offsetWidth
    el?.classList.add('hop')
  }, [hop])

  // Open, the list keeps its clocks running and learns when each run started and what a waiting one needs.
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])
  const ids = rows.map((r) => `${r.session.id}:${r.session.status}`).join(',')
  useEffect(() => {
    if (!open) return
    for (const r of rows) {
      const known = details[r.session.id]
      if (known && !(r.session.status === 'waiting_for_input' && !known.need)) continue
      void (async () => {
        const info = await call<SessionInfo>('agents', 'session_get', { id: r.session.id })
        const run = info.latest_run ? await call<{ started_at: string | null; created_at: string }>('agents', 'run_get', { id: info.latest_run.id }) : null
        const need = r.session.status === 'waiting_for_input' ? needOf((await call<{ items: { kind: string; payload: any }[] }>('agents', 'input_list', { session_id: r.session.id, status: 'pending', limit: 5 })).items[0]) : undefined
        setDetails((d) => ({ ...d, [r.session.id]: { startedAt: run?.started_at ?? run?.created_at, runId: info.latest_run?.id, model: info.session.model, permission: info.session.permission_mode, need } }))
      })().catch(() => {})
    }
  }, [open, ids])

  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (setOpen(false), button.current?.focus())
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open])

  const ws = (id: string | null) => (id ? state.workspaces.find((w) => w.id === id) : undefined)
  const scheduleCron = (id: string) => state.schedules.find((s) => s.id === id)?.cron
  const title = (s: SessionSummary) => s.labels.title?.trim() || s.preview?.replace(/\s+/g, ' ').trim() || 'An agent'
  const wsName = (id: string | null) => ws(id)?.name ?? 'a workspace'

  const stop = async (r: Row) => {
    try {
      const runId = details[r.session.id]?.runId ?? (await call<SessionInfo>('agents', 'session_get', { id: r.session.id })).latest_run?.id
      if (runId) await call('agents', 'run_cancel', { id: runId })
      setExpanded(null)
      reload()
      toast(`Stopped: ${title(r.session)}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad')
    }
  }

  /** How it started, on one line under its title. */
  const how = (r: Row) => {
    const o = r.origin
    if (r.session.status === 'waiting_for_input') {
      const need = details[r.session.id]?.need
      return <span className="h-live-need t">Needs you{need ? `: ${need}` : ''}</span>
    }
    switch (o.kind) {
      case 'panel':
        return r.workspace ? (
          <>
            <WorkspaceIcon icon={ws(r.workspace)?.icon} color={ws(r.workspace)?.color} size={12} />
            <span className="t">In {wsName(r.workspace)}</span>
          </>
        ) : (
          <span className="t">In the agent panel</span>
        )
      case 'workspace':
        return (
          <>
            <MousePointerClick size={12} strokeWidth={1.8} />
            <span className="t">Started by its page</span>
          </>
        )
      case 'tool': {
        const cron = o.via.kind === 'schedule' ? scheduleCron(o.via.id) : undefined
        return (
          <>
            <Wrench size={12} strokeWidth={1.8} />
            <code>{o.tool}</code>
            <i>·</i>
            {o.via.kind === 'schedule' ? (
              <span className="h-live-cron" title={cron}>
                <Clock size={11} strokeWidth={2} />
                {cron ? cronWords(cron) : 'Scheduled'}
              </span>
            ) : (
              <span className="t">{o.via.kind === 'workspace' ? `from the ${wsName(o.via.workspace)} page` : o.via.kind === 'agent' ? 'called by an agent' : o.via.kind === 'tool' ? `called by ${o.via.tool}` : o.via.kind === 'you' ? 'run by you' : 'run'}</span>
            )}
          </>
        )
      }
      case 'schedule':
        return (
          <span className="h-live-cron" title={o.cron}>
            <Clock size={11} strokeWidth={2} />
            {o.cron ? cronWords(o.cron) : 'Scheduled'}
            {o.name ? ` · ${o.name}` : ''}
          </span>
        )
      case 'agent':
        return (
          <>
            <BotIcon size={12} strokeWidth={1.8} />
            <span className="t">Started by an agent</span>
          </>
        )
      case 'you':
        return <span className="t">Started by you</span>
      default:
        return <span className="t">Started outside Lynx</span>
    }
  }

  /** The steps from what the user (or the clock) did to this agent. */
  const chain = (r: Row, started?: string) => {
    const o = r.origin
    const at = started ? new Date(started).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
    const step = (icon: React.ReactNode, body: React.ReactNode, small?: React.ReactNode, cron = false) => (
      <li>
        <span className={`n${cron ? ' cron' : ''}`}>{icon}</span>
        <div>
          {body}
          {small && <small>{small}</small>}
        </div>
      </li>
    )
    const steps: React.ReactNode[] = []
    if (o.kind === 'panel') steps.push(step(<PanelRight size={11} strokeWidth={2} />, 'You asked in the agent panel', [at, r.workspace && `about ${wsName(r.workspace)}`].filter(Boolean).join(' · ')))
    if (o.kind === 'workspace') steps.push(step(<MousePointerClick size={11} strokeWidth={2} />, <>The <b>{wsName(o.workspace)}</b> page started it</>, at))
    if (o.kind === 'schedule') steps.push(step(<Clock size={11} strokeWidth={2} />, <>Agent schedule {o.name ? <b>{o.name}</b> : null} fired</>, [o.cron && <code key="c">{o.cron}</code>, at].filter(Boolean).map((x, i) => <span key={i}>{i ? ' · ' : ''}{x}</span>), true))
    if (o.kind === 'agent') steps.push(step(<BotIcon size={11} strokeWidth={2} />, 'An agent started it', at))
    if (o.kind === 'you') steps.push(step(<Sparkles size={11} strokeWidth={2} />, 'You started it', at))
    if (o.kind === 'tool') {
      const v = o.via
      const cron = v.kind === 'schedule' ? scheduleCron(v.id) : undefined
      if (v.kind === 'schedule') steps.push(step(<Clock size={11} strokeWidth={2} />, <>A schedule ran it: <b>{cron ? cronWords(cron) : 'scheduled'}</b></>, cron ? <code>{cron}</code> : undefined, true))
      if (v.kind === 'workspace') steps.push(step(<MousePointerClick size={11} strokeWidth={2} />, <>The <b>{wsName(v.workspace)}</b> page ran it</>))
      if (v.kind === 'agent') steps.push(step(<BotIcon size={11} strokeWidth={2} />, 'An agent ran it'))
      if (v.kind === 'tool') steps.push(step(<Wrench size={11} strokeWidth={2} />, <>The tool <code>{v.tool}</code> ran it</>))
      if (v.kind === 'you') steps.push(step(<Sparkles size={11} strokeWidth={2} />, 'You ran it'))
      steps.push(step(<Wrench size={11} strokeWidth={2} />, <>The tool <code>{o.tool}</code> started this agent</>, at))
    }
    if (o.kind === 'unknown') steps.push(step(<Sparkles size={11} strokeWidth={2} />, 'Started outside Lynx', at))
    return <ol className="h-live-chain">{steps}</ol>
  }

  const item = (r: Row, done?: Done) => {
    const s = r.session
    const d = details[s.id]
    const isOpen = expanded === s.id
    const waits = s.status === 'waiting_for_input'
    const there = r.workspace && !onScreen.includes(r.workspace) ? ws(r.workspace) : undefined
    const mark = done ? (done.status && ['failed', 'interrupted', 'unknown'].includes(done.status) ? <span className="h-live-state bad">!</span> : done.status === 'cancelled' ? <span className="h-live-state"><i className="h-live-stopped" /></span> : <span className="h-live-state good">✓</span>) : waits ? <span className="h-live-state"><i className="h-live-wait" /></span> : <span className="h-live-state"><i className="h-live-spin" /></span>
    const meta = [harnessName(s.harness), d?.model, d?.permission ? PERMISSIONS[d.permission]?.name : null].filter(Boolean).join(' · ')
    return (
      <div key={s.id} className={`h-live-item${isOpen ? ' open' : ''}`}>
        <button className="h-live-row" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : s.id)}>
          {mark}
          <span className="h-live-main">
            <span className="h-live-title">{title(s)}</span>
            <span className="h-live-how">{how(r)}</span>
          </span>
          <span className="h-live-time">{done ? rel(done.at, now) : elapsed(d?.startedAt ?? s.created_at, now)}</span>
          <ChevronRight className="h-live-chev" size={14} strokeWidth={1.8} />
        </button>
        {isOpen && (
          <div className="h-live-detail">
            {waits && <p className="h-live-now">Waiting for you{d?.need ? <>: <b>{d.need}</b></> : null}</p>}
            <p className="h-live-label">How it started</p>
            {chain(r, d?.startedAt ?? s.created_at)}
            {meta && <p className="h-live-meta">{meta}</p>}
            <div className="h-live-actions">
              {waits && !done && (
                <button className="sb-btn sm warn" onClick={() => (setOpen(false), onConversation(s))}>
                  Review
                </button>
              )}
              {there && (
                <button className="sb-btn sm" onClick={() => (setOpen(false), onOpen(there.id))}>
                  Open {there.name}
                </button>
              )}
              <button className="sb-btn sm ghost" onClick={() => (setOpen(false), onConversation(s))}>
                See the conversation
              </button>
              {!done && (
                <button className="sb-btn sm ghost h-live-stop" onClick={() => void stop(r)}>
                  Stop
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  /** Agent panel chats in a section of their own at the top; the rest by workspace, the one on screen first, then any waiting on the user. */
  const groups = (all: Row[], done?: Done[]) => {
    const chats = all.filter((r) => r.origin.kind === 'panel')
    const rest = all.filter((r) => r.origin.kind !== 'panel')
    const keyOf = (r: Row) => (ws(r.workspace) ? r.workspace! : '')
    const waitsIn = (k: string) => rest.some((r) => keyOf(r) === k && r.session.status === 'waiting_for_input')
    const order = [...new Set(rest.map(keyOf))].sort((a, b) => Number(onScreen.includes(b)) - Number(onScreen.includes(a)) || Number(waitsIn(b)) - Number(waitsIn(a)) || Number(a === '') - Number(b === ''))
    const doneOf = (r: Row) => done?.find((d) => d.session.id === r.session.id)
    const head = (icon: React.ReactNode, name: string, n: number, here = false) => (
      <div className="h-live-ws">
        {icon}
        {name}
        {here && <span className="here">On screen</span>}
        <small>{n}</small>
      </div>
    )
    return (
      <>
        {chats.length > 0 && (
          <div className="h-live-group panel">
            {head(<PanelRight size={13} strokeWidth={1.7} />, 'Agent panel', chats.length)}
            {chats.map((r) => item(r, doneOf(r)))}
          </div>
        )}
        {order.map((k) => {
          const mine = rest.filter((r) => keyOf(r) === k)
          const w = ws(k || null)
          return (
            <div className="h-live-group" key={k || 'none'}>
              {head(w ? <WorkspaceIcon icon={w.icon} color={w.color} size={13} /> : <Sparkles size={13} strokeWidth={1.7} />, w?.name ?? 'Not in a workspace', mine.length, !!w && onScreen.includes(w.id))}
              {mine.map((r) => item(r, doneOf(r)))}
            </div>
          )
        })}
      </>
    )
  }

  const finished = recent.filter(shown)
  const label = rows.length ? `${rows.length} agent${rows.length === 1 ? '' : 's'} running${waiting ? `, ${waiting} waiting for you` : ''}` : 'No agents running'
  return (
    <span className="h-live">
      <button
        ref={button}
        className={`${row ? 'h-item' : 'sb-btn sm ghost'} h-live-btn${rows.length ? '' : ' idle'}${waiting ? ' needs' : ''}${open ? ' on' : ''}`}
        onClick={() => setOpen(!open)}
        onAnimationEnd={(e) => e.animationName === 'h-live-hop' && button.current?.classList.remove('hop')}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {row ? (
          <>
            <span className="h-icon">
              <Bot />
            </span>
            <span className="h-name">Running agents</span>
            {rows.length > 0 && (
              <>
                {/* A grey dot that pulses while any agent works. */}
                <i className="h-live-pulse" aria-hidden />
                <span className={`h-count${waiting ? ' needs' : ''}`}>{rows.length}</span>
              </>
            )}
          </>
        ) : (
          <Bot />
        )}
      </button>
      {open && (
        <>
          <div className="h-scrim" onClick={() => setOpen(false)} />
          <section className="h-live-pop" role="dialog" aria-label="Agents running">
            <header className="h-live-head">
              <h3>Agents</h3>
              <span>{rows.length ? `${rows.length} running${waiting ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}` : ''}</span>
              <span className="grow" />
              <label className="h-live-toggle" title="Conversations you started in the agent panel">
                <span>
                  Agent panel{panelCount ? ` · ${panelCount}` : ''}
                </span>
                <input
                  type="checkbox"
                  checked={showPanel}
                  onChange={(e) => {
                    setShowPanel(e.target.checked)
                    localStorage.setItem(SHOW_PANEL, e.target.checked ? '1' : '0')
                  }}
                />
                <span className="h-live-switch" />
              </label>
            </header>
            <div className="h-live-list">
              {live === null ? (
                <div className="h-live-empty">Loading…</div>
              ) : rows.length ? (
                groups(rows)
              ) : (
                <div className="h-live-empty">
                  <b>Nothing running</b>
                  Agents started by a workspace, a tool or a schedule show here while they work.
                </div>
              )}
              {finished.length > 0 && (
                <>
                  <button className="h-live-recent" aria-expanded={recentOpen} onClick={() => setRecentOpen(!recentOpen)}>
                    <ChevronRight size={12} strokeWidth={1.8} />
                    Finished in the last hour · {finished.length}
                  </button>
                  {recentOpen && <div className="h-live-done">{groups(finished, finished)}</div>}
                </>
              )}
            </div>
          </section>
        </>
      )}
    </span>
  )
}


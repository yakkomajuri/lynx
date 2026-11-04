// Conversation pieces: a transcript rendered from session events, the composer, and the cards for
// what an agent is waiting on. Used by the Chat workspace and by the host's agent panel alike.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { agents, MAX_ATTACHMENTS, type LiveSession, type PendingInput, type SessionEvent } from './agents'
import { call, openExternal, stageFile, useConnectors, type Attachment, type ConnectorInfo } from './core'
import { inFence, splitFences } from './highlight'
import { Icon } from './icons'
import { Guard } from './guard'
import { cardsInTurn, toItems } from './items'
import { comboLabel } from './keys'
import { markRanges } from './marks'
import { callInput, ConnectorIcon, connectorOf, connectorTool, editCounts, fullPayload, ToolBody, ToolIcon, type ToolStep } from './toolviews'
import { Button, Code, CopyButton, Details, Markdown, Spinner } from './ui'

export { fullPayload }

/** A message's text, and its payload in full (history shortens long ones). */
function useMessage(sessionId: string, e: SessionEvent & { payload_truncated?: boolean }): { text: string; payload: any } {
  const [full, setFull] = useState<any>()
  useEffect(() => {
    if (e.payload_truncated) void fullPayload(sessionId, e.seq).then(setFull, () => undefined)
  }, [sessionId, e.seq, e.payload_truncated])
  if (!e.payload_truncated) return { text: String(e.payload?.text ?? ''), payload: e.payload }
  if (full) return { text: String(full?.text ?? ''), payload: full }
  // Until the full text arrives, show what the preview holds of it.
  return { text: String(e.payload?.preview ?? '').replace(/^\{"text":"/, '').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/","attachments":.*$/, ''), payload: {} }
}

const short = (v: unknown, n = 90) => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v.length > n ? v.slice(0, n) + '…' : v
  const o = v as Record<string, unknown>
  if (typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length) return ''
  const lead = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url ?? o.prompt ?? o.tool ?? o.workspace ?? o.connector ?? o.name ?? o.id
  // A file: its name and the folder it is in, not the whole path.
  const file = typeof (o.file_path ?? o.path) === 'string' && lead === (o.file_path ?? o.path) ? String(lead).split('/').filter(Boolean).slice(-2).join('/') : undefined
  const text = file ?? (typeof lead === 'string' ? lead : JSON.stringify(v))
  return text.length > n ? text.slice(0, n) + '…' : text
}
const pretty = (v: unknown) => {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.every((c) => c && typeof c === 'object' && 'text' in c)) return v.map((c: any) => c.text).join('\n')
  return JSON.stringify(v, null, 2)
}

// `code` and ```code``` within a line.
const inlineCode = (text: string) => text.split(/(```[^\n]+?```|`[^`\n]+`)/g).map((piece, i) => (i % 2 ? <code key={i}>{piece.startsWith('```') ? piece.slice(3, -3).trim() : piece.slice(1, -1)}</code> : piece))

const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`)

/** The files that went with a message. */
function SentFiles({ files }: { files: { name: string; size?: number }[] }) {
  return (
    <div className="sb-files sent">
      {files.map((f, i) => (
        <span key={i} className="sb-file" title={f.name}>
          <span className="sb-file-icon">
            <Icon name="file" size={15} />
          </span>
          <span className="sb-file-text">
            <b>{f.name}</b>
            {typeof f.size === 'number' && <small>{fileSize(f.size)}</small>}
          </span>
        </span>
      ))}
    </div>
  )
}

/** A mention that shows as a mark: its whole text ("@Revenue"), the icon drawn over its @, and a tooltip. */
export interface Mark {
  text: string
  icon?: ReactNode
  title?: string
}

export { markRanges }

/** Text with the mentions in it as marks, each with its icon when it has one. */
function withMarks(text: string, marks: Mark[], plain: (t: string) => ReactNode = (t) => t) {
  const ranges = markRanges(text, marks.map((m) => m.text))
  if (!ranges.length) return plain(text)
  const out: ReactNode[] = []
  let at = 0
  ranges.forEach((r, i) => {
    const m = marks.find((x) => x.text === r.mark)!
    if (r.start > at) out.push(<span key={`t${i}`}>{plain(text.slice(at, r.start))}</span>)
    out.push(
      <span key={`m${i}`} className={`sb-mark${m.icon ? '' : ' bare'}`} title={m.title}>
        {m.icon ? (
          <span className="sb-mark-at">
            @<span className="sb-mark-icon">{m.icon}</span>
          </span>
        ) : (
          '@'
        )}
        {m.text.slice(1)}
      </span>,
    )
    at = r.end
  })
  if (at < text.length) out.push(<span key="end">{plain(text.slice(at))}</span>)
  return out
}

/** Text with the mentions in it as marks: a note's, where it is shown short. */
export const Marked = ({ text, marks = [] }: { text: string; marks?: Mark[] }) => <>{withMarks(text, marks)}</>

function UserText({ text, marks = [] }: { text: string; marks?: Mark[] }) {
  const parts = useMemo(() => splitFences(text), [text])
  if (!text) return null
  return (
    <div className="sb-msg user">
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{withMarks(p.text, marks, inlineCode)}</span>
        ) : (
          <Code key={i} language={p.language || undefined} className="sb-msg-code">
            {p.code}
          </Code>
        ),
      )}
    </div>
  )
}

function ToolGroup({ steps, names, active, sessionId }: { steps: ToolStep[]; names: Map<string, string>; active: boolean; sessionId: string }) {
  // mcp__connection_<id>__tool -> "<connector> · tool"; the app's connector_call -> "<connector it called> · tool"
  const label = (s: ToolStep) => {
    const c = connectorTool(s.name)
    if (!c) return s.name
    const on = names.get(c.connection) ?? 'connector'
    const input = s.input as { connector?: unknown; tool?: unknown } | undefined
    if (on === 'app' && c.tool === 'connector_call' && typeof input?.connector === 'string' && typeof input.tool === 'string') return `${input.connector} · ${input.tool}`
    return `${on} · ${c.tool}`
  }
  // A step is running until its result arrives; the ones before it in the same group are done.
  const answered = (s: ToolStep) => s.result !== undefined || !!s.resultRef
  const pending = (s: ToolStep) => active && !answered(s)
  // What a call was about: a shortened one's lead, a connector_call's arguments.
  const about = (s: ToolStep, n?: number) => (s.input === undefined && s.lead ? short(s.lead, n) : short(callInput(s), n))
  const rows = steps.map((s) => {
    const counts = editCounts(s)
    return (
      <Details
        key={s.key}
        summary={
          <span className={`sb-tool${pending(s) ? ' running' : ''}`}>
            <ToolIcon step={s} names={names} />
            <b>{label(s)}</b>
            <span>{about(s)}</span>
            {counts && <em className="sb-tool-counts">{counts}</em>}
            {s.isError ? <i className="sb-dot bad" /> : active && answered(s) ? <Icon name="check" size={13} /> : null}
          </span>
        }
      >
        <ToolBody step={s} pending={pending(s)} sessionId={sessionId} />
      </Details>
    )
  })
  if (steps.length === 1) return <div className="sb-tools">{rows}</div>
  const now = steps.findLast(pending)
  const done = steps.filter(answered).length
  // One picture per connector or kind of tool the group used, in the order they came.
  const faces = [...new Map(steps.map((s) => [connectorOf(s, names) ?? s.kind ?? s.name, s])).values()].slice(0, 4)
  return (
    <div className="sb-tools">
      <Details
        summary={
          <span className={`sb-tool${now ? ' running' : ''}`}>
            {now ? (
              <ToolIcon step={now} names={names} />
            ) : (
              <span className="sb-tool-faces">
                {faces.map((s) => (
                  <ToolIcon key={s.key} step={s} names={names} />
                ))}
              </span>
            )}
            <b>{now ? label(now) : `Used ${steps.length} tools`}</b>
            <span>{now ? `${about(now, 60)}${done ? ` · ${done} done` : ''}` : [...new Set(steps.map((x) => label(x).split(' · ')[0]))].slice(0, 4).join(', ')}</span>
          </span>
        }
      >
        {rows}
      </Details>
    </div>
  )
}

/**
 * The app's agent panel ends a message with what it is about, written for the agent: what the user
 * pointed at, and the workspaces and connectors. The user sees their mentions as marks in the text and
 * what they pointed at as numbered chips under it, each opening to the details the agent got. A message
 * said in voice mode says so.
 */
const ADDED_BLOCK = /(?:^|\n\n)\[(?:I pointed at these parts|Workspace attached: |Connector mentioned: |Said aloud in voice mode)/
export interface Pointed {
  note: string
  /** What the panel wrote about it: element, components, selector, workspace, page. */
  fields: { name: string; value: string }[]
}
const splitAdded = (text: string) => {
  const found = ADDED_BLOCK.exec(text)
  if (!found) return { said: text, names: [], points: [] as Pointed[], voiced: false }
  const added = text.slice(found.index)
  const names = [...added.matchAll(/\[(?:Workspace attached|Connector mentioned): "([^"]*)"/g)].map((m) => m[1]!)
  const points: Pointed[] = []
  const block = /\[I pointed at these parts[^\n]*\n([\s\S]*?)\](?=\n\n\[|\s*$)/.exec(added)?.[1] ?? ''
  for (const line of block.split('\n')) {
    const item = /^(\d+)\. (.*)$/.exec(line)
    const field = /^ {3}(\w+): (.*)$/.exec(line)
    if (item) points.push({ note: item[2] === '(no note)' ? '' : item[2]!, fields: [] })
    else if (field && points.length) points.at(-1)!.fields.push({ name: field[1]!, value: field[2]! })
  }
  return { said: text.slice(0, found.index).trimEnd(), names, points, voiced: added.includes('[Said aloud in voice mode') }
}

/** The element a pointed-at part is, in a few words: its tag and the text it shows. */
const elementOf = (p: Pointed) => {
  const el = p.fields.find((f) => f.name === 'element')?.value ?? ''
  const tag = /^<(\w+)/.exec(el)?.[1] ?? 'element'
  const shows = /showing "([^"]*)"/.exec(el)?.[1]
  const component = p.fields.find((f) => f.name === 'components')?.value.split(' > ').at(-1)
  return `${component ? `${component} · ` : ''}${tag}${shows ? ` “${shows.slice(0, 40)}”` : ''}`
}

/** What a message pointed at, as numbered chips; a click opens one to what the agent was told about it. */
function PointedAt({ points, marks }: { points: Pointed[]; /** The mentions in the notes, as marks. */ marks: Mark[] }) {
  const [open, setOpen] = useState<number | null>(null)
  const shown = open === null ? undefined : points[open]
  return (
    <div className="sb-points">
      <div className="sb-points-row">
        {points.map((p, i) => (
          <button key={i} type="button" className={`sb-point${open === i ? ' on' : ''}`} aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)} title={open === i ? 'Hide the details' : 'What the agent was told about it'}>
            <b>{i + 1}</b>
            <span>{p.note ? withMarks(p.note, marks) : elementOf(p)}</span>
            {p.note && <small>{elementOf(p)}</small>}
          </button>
        ))}
      </div>
      {shown && (
        <div className="sb-point-detail">
          <dl>
            {shown.note && (
              <>
                <dt>Note</dt>
                <dd>{withMarks(shown.note, marks)}</dd>
              </>
            )}
            {shown.fields.map((f) => (
              <Fragment key={f.name}>
                <dt>{f.name[0]!.toUpperCase() + f.name.slice(1)}</dt>
                <dd className={f.name === 'element' || f.name === 'selector' ? 'code' : undefined}>{f.value}</dd>
              </Fragment>
            ))}
          </dl>
          <CopyButton text={() => [`${open! + 1}. ${shown.note || '(no note)'}`, ...shown.fields.map((f) => `   ${f.name}: ${f.value}`)].join('\n')} label="Copy" />
        </div>
      )}
    </div>
  )
}

function Bubble({ sessionId, e, role, actions, marks = [] }: { sessionId: string; e: SessionEvent; role: 'user' | 'assistant'; actions?: boolean; marks?: Mark[] }) {
  const { text, payload } = useMessage(sessionId, e)
  if (role === 'user') {
    const files: { name: string; size?: number }[] = Array.isArray(payload?.attachments) ? payload.attachments : []
    const { said, names, points, voiced } = splitAdded(text)
    // What went with it is marked where it was mentioned, with its icon when the caller knows it.
    const known = names.map((name) => marks.find((m) => m.text === `@${name}`) ?? { text: `@${name}` })
    if (!files.length && !names.length && !points.length && !voiced) return <UserText text={text} marks={marks} />
    return (
      <div className="sb-msg-user">
        {files.length > 0 && <SentFiles files={files} />}
        <UserText text={said} marks={known} />
        {points.length > 0 && <PointedAt points={points} marks={known} />}
        {voiced && (
          <span className="sb-msg-voiced" title="Said aloud in voice mode">
            <Icon name="mic" size={11} />
            Said aloud
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="sb-msg assistant">
      <Markdown>{text}</Markdown>
      {actions && (
        <div className="sb-msg-actions">
          <CopyButton text={text} />
        </div>
      )}
    </div>
  )
}

/** A message said aloud on its way to the agent, drawn as it will be once the conversation has it. */
export function OutgoingMessage({ text, marks }: { text: string; marks?: Mark[] }) {
  return (
    <div className="sb-msg-user outgoing" aria-busy="true">
      <UserText text={text} marks={marks} />
      <span className="sb-msg-voiced" title="Said aloud in voice mode">
        <Icon name="mic" size={11} />
        Said aloud
      </span>
    </div>
  )
}

const STATUS_TEXT: Record<string, string> = { connected: 'Connected', connecting: 'Connecting…', 'auth-required': 'Sign-in needed', 'needs-credentials': 'Needs a token', error: 'Could not connect', disconnected: 'Not connected' }

// What a user fixes from the card. A connector passing through "connecting" on its own is not one.
const NEEDS_USER = ['auth-required', 'needs-credentials', 'error', 'disconnected']

/**
 * A connector, with whatever the user has to do to finish connecting it: sign in through the
 * browser, or paste a token. Shown in a conversation when an agent adds or needs a connector;
 * once connected, the session it appears in is granted the connector, and `onConnected` runs
 * when that happened while the card was on screen.
 */
export function ConnectCard({ connector, sessionId, onConnected }: { connector: string; sessionId?: string; onConnected?: () => void }) {
  const { connectors, loading } = useConnectors()
  const c: ConnectorInfo | undefined = connectors.find((x) => x.id === connector)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [token, setToken] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const granted = useRef(false)
  // Whether it was waiting on the user since the card appeared: one already connected is old news.
  const wasOut = useRef(false)
  const connected = useRef(onConnected)
  connected.current = onConnected
  const status = c?.status ?? 'disconnected'

  useEffect(() => {
    if (!c) return
    if (status !== 'connected') {
      if (NEEDS_USER.includes(status)) wasOut.current = true
      granted.current = false
      return
    }
    setWaiting(false)
    if (sessionId && !granted.current) {
      granted.current = true
      const fresh = wasOut.current
      wasOut.current = false
      void agents.grant(sessionId, connector).then(
        () => fresh && connected.current?.(),
        () => (granted.current = false),
      )
    }
  }, [!!c, status, sessionId, connector])

  const run = async (tool: string, args: Record<string, unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      const r = await call<{ status: string; error?: string }>('app', tool, { connector, sign_in: true, ...args })
      if (r.status === 'auth-required') setWaiting(true)
      // Still wanting credentials after some were given: they were refused.
      else if (r.status === 'needs-credentials' && tool === 'connector_update') setError(r.error ?? 'That was not accepted')
      else if (r.status !== 'connected' && r.status !== 'needs-credentials') setError(r.error ?? STATUS_TEXT[r.status] ?? r.status)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!c) return loading ? null : <div className="sb-connect missing">The connector “{connector}” no longer exists.</div>
  const host = c.url ? c.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : c.transport === 'stdio' ? 'Runs on this machine' : 'Built in'
  // An API connector asks for what its API takes; an MCP server for a token sent as a header.
  const api = c.api
  const basic = api?.auth_type === 'basic'
  const sentAs = !api ? '' : api.auth_type === 'bearer' ? 'Sent as a bearer token' : api.auth_type === 'header' ? `Sent in the ${api.auth_name} header` : api.auth_type === 'query' ? `Sent as the ${api.auth_name} query parameter` : ''
  const submit = () => {
    if (!token.trim()) return
    if (api) void run('connector_update', { credentials: basic ? { username: token.trim(), password } : { key: token.trim() } })
    else void run('connector_update', { headers: { Authorization: /^(bearer|basic|token) /i.test(token.trim()) ? token.trim() : `Bearer ${token.trim()}` } })
  }
  return (
    <div className={`sb-connect ${status}`}>
      <div className="sb-connect-row">
        <span className="sb-connect-icon">
          <ConnectorIcon connector={c.id} />
          {status === 'connected' && (
            <span className="sb-connect-ok">
              <Icon name="check" size={10} />
            </span>
          )}
        </span>
        <div className="sb-connect-text">
          <strong>{c.name === c.id ? c.id : `${c.name}`}</strong>
          <span>{status === 'connected' ? `Connected · ${api ? 'HTTP API' : `${c.tool_count} tools`}${sessionId ? ' · available to this conversation' : ''}` : waiting ? 'Finish signing in in your browser…' : `${host} · ${api && status === 'needs-credentials' ? (basic ? 'Needs a username and password' : 'Needs an API key') : (STATUS_TEXT[status] ?? status)}`}</span>
        </div>
        {status !== 'connected' && status !== 'needs-credentials' && (
          <Button variant="primary" size="sm" busy={busy || status === 'connecting'} onClick={() => void run('connector_reconnect', {})}>
            {waiting ? 'Open again' : status === 'error' ? 'Retry' : 'Connect'}
          </Button>
        )}
      </div>
      {status === 'needs-credentials' && (
        <form
          className="sb-connect-token"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          {basic ? (
            <>
              <input className="sb-input" autoComplete="off" spellCheck={false} placeholder="Username" value={token} onChange={(e) => setToken(e.target.value)} aria-label={`Username for ${c.id}`} />
              <input className="sb-input" type="password" autoComplete="off" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label={`Password for ${c.id}`} />
            </>
          ) : (
            <input className="sb-input" type="password" autoComplete="off" placeholder={api ? 'Paste the API key' : 'Paste an API key or token'} value={token} onChange={(e) => setToken(e.target.value)} aria-label={`Token for ${c.id}`} />
          )}
          <Button variant="primary" size="sm" type="submit" busy={busy} disabled={!token.trim()}>
            Connect
          </Button>
        </form>
      )}
      {status === 'needs-credentials' && (
        <small>
          {sentAs && `${sentAs}. `}Stored on this machine. The agent uses the connector through the app and never sees the {api ? 'key' : 'token'}.
          {api?.docs_url && (
            <>
              {' '}
              <a
                href={api.docs_url}
                onClick={(e) => {
                  e.preventDefault()
                  openExternal(api.docs_url!)
                }}
              >
                Where to find it
              </a>
            </>
          )}
        </small>
      )}
      {(error || (status === 'error' && c.error)) && <small className="bad">{error ?? c.error}</small>}
    </div>
  )
}

/** The conversation so far. Scrolls with new output unless the reader has scrolled up. */
export function Transcript({ sessionId, session, empty, intro, outgoing, resumes = true, marks, onSignIn, renderMarketplace }: { renderMarketplace?: (stage: string | undefined, onComplete: () => void) => ReactNode; sessionId: string; session: LiveSession; empty?: ReactNode; /** Shown above the conversation, as where it began: a greeting it opened on, say. */ intro?: ReactNode; /** A message on its way that the conversation does not have yet, after the rest. */ outgoing?: ReactNode; /** Whether finishing a connection from a card here carries the conversation on. Off where something else tells it (the app's onboarding). */ resumes?: boolean; /** Mentions to show as marks in the user's messages, with their icons. */ marks?: Mark[]; /** Offered where a turn failed because the agent is not signed in. */ onSignIn?: () => void }) {
  const items = useMemo(() => toItems(session.events), [session.events])
  const turnCards = useMemo(() => cardsInTurn(items), [items])
  // Under the last answer's cards, when it asked for several: what to do once they are connected.
  const lastUser = items.findLastIndex((it) => it.kind === 'user')
  const lastCard = items.findLastIndex((it) => it.kind === 'connect')
  const severalAt = lastCard > lastUser && (turnCards.get((items[lastCard] as { connector: string }).connector) ?? 0) > 1 ? lastCard : -1
  const { connectors } = useConnectors()
  const names = useMemo(() => new Map(connectors.filter((c) => c.agent_connection_id).map((c) => [c.agent_connection_id!.replaceAll('-', ''), c.id])), [connectors])
  // Connectors the user finished connecting from a card. Once the agent's turn is over it carries
  // on, unless the user has written since or stopped it.
  const [resume, setResume] = useState<{ sessionId: string; connectors: string[]; after: number }>()
  const seen = useRef(0)
  seen.current = session.events.length
  const connected = useCallback((id: string) => setResume((r) => (r?.sessionId === sessionId ? { ...r, connectors: [...new Set([...r.connectors, id])] } : { sessionId, connectors: [id], after: seen.current })), [sessionId])
  const { send } = session
  useEffect(() => {
    if (!resume || session.loading || session.busy) return
    setResume(undefined)
    if (!resumes) return
    // A card that came with others waits for the user to say when to go on.
    const alone = resume.connectors.filter((id) => (turnCards.get(id) ?? 1) === 1)
    if (!alone.length) return
    if (resume.sessionId !== sessionId || session.status === 'cancelled' || session.events.slice(resume.after).some((e) => e.type === 'user_message')) return
    const named = alone.map((id) => connectors.find((c) => c.id === id)?.name ?? id)
    // Someone else may have sent first (the session is busy then); nothing is lost.
    void send(alone.includes('__marketplace__') ? 'I completed the marketplace card. Check the current status and carry on.' : `I've connected ${named.join(' and ')}. Carry on.`).catch(() => {})
  }, [resume, resumes, turnCards, sessionId, session.loading, session.busy, session.status, session.events, send, connectors])
  const box = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    const inner = content.current
    if (!el || !inner) return
    pinned.current = true
    const follow = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    }
    follow()
    // Follow changes in output, expanded details and the viewport, not unrelated parent renders.
    const observer = new ResizeObserver(follow)
    observer.observe(el)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [sessionId])
  return (
    <div
      className="sb-transcript"
      ref={box}
      onWheel={(e) => {
        const el = e.currentTarget
        if (!pinned.current || e.deltaY >= 0 || e.defaultPrevented || el.scrollTop <= 0) return
        // An inner tool output may consume the wheel without moving the transcript.
        for (let target = e.target instanceof Element ? e.target : null; target && target !== el; target = target.parentElement) {
          const style = getComputedStyle(target)
          if (!/^(auto|scroll)$/.test(style.overflowY)) continue
          if (target.scrollTop > 0 || (target.scrollHeight > target.clientHeight && style.overscrollBehaviorY !== 'auto')) return
        }
        // Release before new output can undo even the first small upward wheel movement.
        pinned.current = false
      }}
      onScroll={(e) => {
        const el = e.currentTarget
        // Allow rounding at the bottom, but let a slow scroll leave it immediately.
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 1
      }}
    >
      <div className="sb-transcript-inner" ref={content}>
        {intro}
        {session.loading && !items.length ? (
          !outgoing && (
            <div className="sb-empty">
              <Spinner />
            </div>
          )
        ) : !items.length ? (
          !outgoing && empty
        ) : (
          // Each part on its own: one that cannot be drawn says so, and the rest of the conversation stays.
          items.map((it, index) => (
            <Guard key={it.kind === 'user' || it.kind === 'assistant' ? it.e.seq : it.key} name="this part of the conversation">
              {it.kind === 'user' || it.kind === 'assistant' ? (
                <Bubble sessionId={sessionId} e={it.e} role={it.kind} marks={marks} actions={it.kind === 'assistant' && it.last && (!session.busy || index < items.length - 1)} />
              ) : it.kind === 'tools' ? (
                <ToolGroup steps={it.steps} names={names} active={session.busy && index === items.length - 1} sessionId={sessionId} />
              ) : it.kind === 'marketplace' ? (
                renderMarketplace?.(it.stage, () => connected('__marketplace__'))
              ) : it.kind === 'connect' ? (
                <>
                  <ConnectCard connector={it.connector} sessionId={sessionId} onConnected={() => connected(it.connector)} />
                  {index === severalAt && <div className="sb-note muted">Connect the ones you want, then tell the agent to carry on.</div>}
                </>
              ) : (
                <div className={`sb-note ${it.tone}`}>
                  {it.text}
                  {it.auth && onSignIn && (
                    <button className="sb-btn sm" style={{ flex: 'none' }} onClick={onSignIn}>
                      Sign in
                    </button>
                  )}
                </div>
              )}
            </Guard>
          ))
        )}
        {outgoing}
        {session.pending.map((p) => (
          // A request that cannot be drawn can still be turned down, so the agent is not left waiting on nothing.
          <Guard key={p.id} name="what the agent is asking" fallback={(error) => <InputFallback error={error} onDeny={() => session.respond(p.id, { decision: 'deny' })} />}>
            <InputCard input={p} onRespond={(r) => session.respond(p.id, r)} />
          </Guard>
        ))}
        {session.streaming && (
          <div className="sb-msg assistant streaming">
            <Markdown>{session.streaming}</Markdown>
          </div>
        )}
        {session.busy && !session.pending.length && !session.streaming && (
          <div className="sb-working" aria-label={session.status === 'queued' ? 'Queued' : 'Working'}>
            <i />
            {session.status === 'queued' && <span>Queued</span>}
          </div>
        )}
        {session.error && <div className="sb-note bad">{session.error.message}</div>}
      </div>
    </div>
  )
}

/** What an approval asks, in words: a heading, why the agent wants it, and the command or input it is for. */
function approvalText(payload: PendingInput['payload']) {
  const detail = (payload.detail && typeof payload.detail === 'object' ? payload.detail : {}) as Record<string, unknown>
  const input = (payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}) as Record<string, unknown>
  const command = (c: unknown) => (Array.isArray(c) ? c.join(' ') : typeof c === 'string' ? c : '')
  const reason = typeof detail.reason === 'string' ? detail.reason : typeof payload.detail === 'string' ? payload.detail : ''
  // Codex asks to run a command or to change files, with its reason.
  if (payload.method?.includes('commandExecution'))
    return { title: 'Run this command?', reason, body: [command(detail.command), typeof detail.cwd === 'string' ? `in ${detail.cwd}` : ''].filter(Boolean).join('\n') }
  if (payload.method?.includes('fileChange')) return { title: 'Allow these file changes?', reason, body: typeof detail.grantRoot === 'string' ? `Write access to ${detail.grantRoot}` : '' }
  // Codex asks before a connector tool that is not read-only, in words of its own.
  if (payload.method?.includes('elicitation')) {
    const meta = (detail._meta ?? {}) as { tool_description?: unknown; tool_params?: unknown }
    const params = meta.tool_params && typeof meta.tool_params === 'object' && Object.keys(meta.tool_params).length ? pretty(meta.tool_params) : ''
    return { title: `Allow ${payload.tool_name ?? 'this connector tool'}?`, reason: typeof meta.tool_description === 'string' ? meta.tool_description : payload.tool_name ? '' : String(detail.message ?? ''), body: params }
  }
  // Claude Code asks to use one of its tools.
  if (payload.tool_name === 'Bash' && typeof input.command === 'string') return { title: 'Run this command?', reason: typeof input.description === 'string' ? input.description : reason, body: input.command }
  const file = input.file_path ?? input.notebook_path
  if (typeof file === 'string') return { title: `${payload.tool_name === 'Write' ? 'Write' : 'Change'} ${file.split('/').filter(Boolean).slice(-2).join('/')}?`, reason, body: pretty(payload.tool_input) }
  const shown = payload.tool_input ?? payload.detail
  // A connector tool is named after its connection; the tool's own name says more.
  return { title: `Allow ${payload.tool_name?.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '') ?? 'this action'}?`, reason: payload.tool_input ? reason : '', body: shown && (typeof shown !== 'object' || Object.keys(shown).length) ? pretty(shown) : '' }
}

/** In place of a request the window could not draw: the agent still waits on it, so it can be declined. */
function InputFallback({ error, onDeny }: { error: Error; onDeny: () => Promise<void> }) {
  const [sent, setSent] = useState(false)
  const deny = () => {
    setSent(true)
    void onDeny().catch(() => setSent(false))
  }
  return (
    <div className="sb-ask">
      <strong>The agent is waiting on something this window could not show.</strong>
      <span className="sb-ask-why">{error.message}</span>
      <div className="sb-row">
        <Button size="sm" busy={sent} onClick={deny}>
          Decline it
        </Button>
      </div>
    </div>
  )
}

/** An approval or a question the agent is blocked on. */
export function InputCard({ input, onRespond }: { input: PendingInput; onRespond: (r: { decision?: 'allow' | 'deny'; answers?: Record<string, string[]> }) => Promise<void> }) {
  const [sent, setSent] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const go = (r: Parameters<typeof onRespond>[0]) => {
    setSent(true)
    void onRespond(r).catch(() => setSent(false))
  }
  if (input.kind === 'approval') {
    const { title, reason, body } = approvalText(input.payload)
    return (
      <div className="sb-ask">
        <strong>{title}</strong>
        {reason && <span className="sb-ask-why">{reason}</span>}
        {body && <pre className="sb-code">{body.slice(0, 1500)}</pre>}
        <div className="sb-row">
          <Button variant="primary" size="sm" busy={sent} onClick={() => go({ decision: 'allow' })}>
            Allow
          </Button>
          <Button size="sm" disabled={sent} onClick={() => go({ decision: 'deny' })}>
            Deny
          </Button>
        </div>
      </div>
    )
  }
  const questions = input.payload.questions ?? []
  return (
    <div className="sb-ask">
      {questions.map((q) => (
        <div key={q.id} className="sb-ask-q">
          <strong>{q.question}</strong>
          <div className="sb-row" style={{ flexWrap: 'wrap' }}>
            {q.options?.map((o) => (
              <button key={o} className={`sb-btn sm${answers[q.id] === o ? ' primary' : ''}`} onClick={() => setAnswers({ ...answers, [q.id]: o })}>
                {o}
              </button>
            ))}
          </div>
          <input className="sb-input" placeholder="Or type an answer" value={q.options?.includes(answers[q.id] ?? '') ? '' : (answers[q.id] ?? '')} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
        </div>
      ))}
      <Button variant="primary" size="sm" busy={sent} disabled={questions.some((q) => !answers[q.id]?.trim())} onClick={() => go({ answers: Object.fromEntries(questions.map((q) => [q.id, [answers[q.id]!]])) })}>
        Answer
      </Button>
    </div>
  )
}

/** The code in a draft, coloured as it will appear once sent. */
function ComposerPreview({ text }: { text: string }) {
  const blocks = splitFences(text).filter((p) => p.kind === 'code' && p.code.trim())
  if (!blocks.length) return null
  return (
    <div className="sb-composer-preview">
      {blocks.map((p, i) =>
        p.kind === 'code' ? (
          <Code key={i} language={p.language || undefined}>
            {p.code}
          </Code>
        ) : null,
      )}
      <small>In a code block, Enter adds a line and Tab indents. Close it with ``` or press {/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter to send.</small>
    </div>
  )
}

export interface AttachmentDraft {
  id: number
  file: File
  /** A thumbnail (data URL), for images. */
  preview?: string
  staged?: Attachment
  error?: string
}
export interface Attachments {
  items: AttachmentDraft[]
  /** Staged and ready to send. */
  ready: Attachment[]
  /** Some are still being staged. */
  pending: boolean
  add: (files: Iterable<File>) => void
  remove: (id: number) => void
  /** Empties the list and returns what was in it, for `restore` if sending fails. */
  take: () => AttachmentDraft[]
  restore: (items: AttachmentDraft[]) => void
  /** Puts back files staged before (a queued message taken back into the box). */
  put: (staged: Attachment[]) => void
  /** Files are being dragged over the drop zone. */
  over: boolean
  /** Spread on the element files can be dropped on (and give it the class `sb-drop-over` while `over`). */
  dropProps: { onDragEnter: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }
}

/** A small picture of an image file, as a data URL (pages may not allow blob: images). */
async function thumbnail(file: File) {
  if (!/^image\/(png|jpe?g|gif|webp|bmp)$/.test(file.type) || file.size > 50 * 1024 ** 2) return undefined
  const bitmap = await createImageBitmap(file)
  const scale = 80 / Math.min(bitmap.width, bitmap.height)
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(bitmap.width * Math.min(1, scale))), height: Math.max(1, Math.round(bitmap.height * Math.min(1, scale))) })
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/png')
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
let draftSeq = 0

/**
 * Files for the next message, dropped, pasted or picked. Pass it to Composer as `attachments`,
 * spread `dropProps` on whatever area should take drops, and send `files` from Composer's onSend
 * with the message (agents.start / send `attachments`).
 */
export function useAttachments(): Attachments {
  const [items, setItems] = useState<AttachmentDraft[]>([])
  const depth = useRef(0)
  const [over, setOver] = useState(false)
  const add = useCallback((files: Iterable<File>) => {
    const fresh: AttachmentDraft[] = [...files].map((file) => ({ id: ++draftSeq, file }))
    setItems((all) => {
      const room = Math.max(0, MAX_ATTACHMENTS - all.length)
      return [...all, ...fresh.slice(0, room), ...fresh.slice(room).map((d) => ({ ...d, error: `At most ${MAX_ATTACHMENTS} files go with one message.` }))]
    })
    for (const d of fresh) {
      void thumbnail(d.file).then(
        (preview) => preview && setItems((all) => all.map((x) => (x.id === d.id ? { ...x, preview } : x))),
        () => undefined,
      )
      void stageFile(d.file).then(
        (staged) => setItems((all) => all.map((x) => (x.id === d.id && !x.error ? { ...x, staged } : x))),
        (e) => setItems((all) => all.map((x) => (x.id === d.id ? { ...x, error: e instanceof Error ? e.message : String(e) } : x))),
      )
    }
  }, [])
  const remove = useCallback((id: number) => setItems((all) => all.filter((d) => d.id !== id)), [])
  const latest = useRef(items)
  latest.current = items
  const take = useCallback(() => {
    const all = latest.current
    setItems([])
    return all
  }, [])
  const restore = useCallback((back: AttachmentDraft[]) => setItems((all) => [...back, ...all]), [])
  const put = useCallback((staged: Attachment[]) => setItems((all) => [...staged.map((a) => ({ id: ++draftSeq, file: new File([], a.name), staged: a })), ...all]), [])
  const dropProps = useMemo<Attachments['dropProps']>(
    () => ({
      onDragEnter: (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current++
        setOver(true)
      },
      onDragOver: (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (e) => {
        if (!hasFiles(e)) return
        if (--depth.current <= 0) {
          depth.current = 0
          setOver(false)
        }
      },
      onDrop: (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        if (e.dataTransfer.files.length) add(e.dataTransfer.files)
      },
    }),
    [add],
  )
  return { items, ready: items.flatMap((d) => (d.staged && !d.error ? [d.staged] : [])), pending: items.some((d) => !d.staged && !d.error), add, remove, take, restore, put, over, dropProps }
}

/** The files waiting to go with the next message. */
function DraftFiles({ attachments }: { attachments: Attachments }) {
  if (!attachments.items.length) return null
  return (
    <div className="sb-files">
      {attachments.items.map((d) => (
        <span key={d.id} className={`sb-file${d.error ? ' bad' : ''}${!d.staged && !d.error ? ' staging' : ''}`} title={d.error ?? d.file.name}>
          <span className="sb-file-icon">{d.preview ? <img src={d.preview} alt="" /> : !d.staged && !d.error ? <Spinner /> : <Icon name="file" size={15} />}</span>
          <span className="sb-file-text">
            <b>{d.file.name || 'Pasted file'}</b>
            <small>{d.error ?? fileSize(d.staged?.size ?? d.file.size)}</small>
          </span>
          <button type="button" onClick={() => attachments.remove(d.id)} aria-label={`Remove ${d.file.name}`} title="Remove">
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
    </div>
  )
}

/**
 * Message box: Enter sends, Shift+Enter breaks the line, and it turns into Stop while the agent
 * works. With `onQueue`, what is sent while it works goes there instead, to be sent after;
 * ⌘Enter (Ctrl+Enter) asks for it to go now, stopping the agent. In a code block, where ⌘Enter is how
 * a message is sent at all, it only queues.
 * Code goes between ``` fences (```js for colours); while one is open the box edits code.
 * With `attachments` (useAttachments) it takes files too: pasted, picked with the paperclip, or
 * dropped where the caller spread `dropProps`. They reach onSend as its second argument.
 * `layout="line"` makes the box only for writing: one row of `lead` (the paperclip unless given),
 * the field and Send, with `top` inside the box above it and `below` under the box. `children`, the
 * bar's controls in the usual layout, are not shown there.
 * With `marks`, the mentions among them in what is typed ("@Revenue") show as marks with their icons.
 * The text stays plain text: a copy of it with the marks is drawn behind the field, letter for letter,
 * and the field's own text is clear, so each mark sits exactly on its words however they wrap.
 */
export function Composer({ onSend, onQueue, onStop, busy, placeholder = 'Message', children, value, onChange, autoFocus, allowEmpty, attachments, layout = 'bar', top, lead, trail, below, onKeyDown, marks }: { onSend: (text: string, files: Attachment[]) => Promise<unknown> | void; /** Takes what is sent while busy, for the caller to send once the agent is done, or `now`, stopping it. */ onQueue?: (text: string, files: Attachment[], now: boolean) => Promise<unknown> | void; onStop?: () => void; busy?: boolean; placeholder?: string; children?: ReactNode; value?: string; onChange?: (v: string) => void; autoFocus?: boolean; /** Send works with nothing typed (the caller attaches something else). */ allowEmpty?: boolean; attachments?: Attachments; layout?: 'bar' | 'line'; /** Inside the box, above the files and the field. */ top?: ReactNode; /** In the line layout, at the start of the row, in place of the paperclip. */ lead?: ReactNode; /** In the line layout, just before Send. */ trail?: ReactNode; /** Under the box. */ below?: ReactNode; /** Sees each key in the field first; one it prevents the default of goes no further. */ onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void; /** The mentions to show as marks where they are typed. */ marks?: Mark[] }) {
  const [own, setOwn] = useState('')
  const text = value ?? own
  const setText = onChange ?? setOwn
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const area = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(220, el.scrollHeight) + 'px'
    // A value set from code leaves the caret at the end; put it back where the edit was, before
    // the next key can land in the wrong place.
    if (caret.current !== null) el.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [text])
  useEffect(() => {
    if (autoFocus) area.current?.focus()
  }, [autoFocus])
  const files = attachments?.ready ?? []
  // Files still on their way hold the message back; with ones ready, there is something to send.
  const canSend = (!!text.trim() || !!allowEmpty || files.length > 0) && !attachments?.pending
  const picker = useRef<HTMLInputElement>(null)
  const submit = async (now = false) => {
    const t = text.trim()
    const queue = busy ? onQueue : undefined
    if (!canSend || sending || (busy && !queue)) return
    setSending(true)
    setError(undefined)
    setText('')
    const taken = attachments?.take() ?? []
    try {
      await (queue ? queue(t, files, now) : onSend(t, files))
    } catch (e) {
      setText(t)
      attachments?.restore(taken)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
      area.current?.focus()
    }
  }
  // Put text where the caret is, and leave the caret after it.
  const insert = (el: HTMLTextAreaElement, piece: string) => {
    caret.current = el.selectionStart + piece.length
    setText(el.value.slice(0, el.selectionStart) + piece + el.value.slice(el.selectionEnd))
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    const el = e.currentTarget
    // Inside a code fence the box behaves like an editor: Enter breaks the line and keeps its
    // indent, Tab indents. Outside one, Enter sends as always.
    const before = el.value.slice(0, el.selectionStart)
    const inCode = inFence(before)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (inCode && !(e.metaKey || e.ctrlKey)) insert(el, `\n${/^[ \t]*/.exec(before.slice(before.lastIndexOf('\n') + 1))![0]}`)
      else void submit((e.metaKey || e.ctrlKey) && !inCode)
    } else if (e.key === 'Tab' && inCode && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      insert(el, '  ')
    }
  }
  // A pasted screenshot or copied file becomes an attachment; pasted text stays text.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachments || !e.clipboardData.files.length) return
    e.preventDefault()
    attachments.add(e.clipboardData.files)
  }
  const coding = useMemo(() => splitFences(text).some((p) => p.kind === 'code'), [text])
  // Code is shown as typed, with no marks.
  const marked = !!marks?.length && !coding
  const copy = useRef<HTMLDivElement>(null)
  // The copy behind the field sets its text exactly as the field does: same font, spacing and padding.
  useLayoutEffect(() => {
    const el = area.current
    const behind = copy.current
    if (!el || !behind) return
    const s = getComputedStyle(el)
    for (const p of ['font', 'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent', 'tabSize', 'textTransform', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] as const) behind.style[p] = s[p]
    behind.scrollTop = el.scrollTop
  })
  const textarea = <textarea ref={area} rows={1} className={coding ? 'code' : marked ? 'marked' : undefined} spellCheck={!coding} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={onPaste} onScroll={(e) => copy.current && (copy.current.scrollTop = e.currentTarget.scrollTop)} />
  const field = marks ? (
    <div className="sb-composer-field">
      {marked && (
        <div ref={copy} className="sb-composer-marks" aria-hidden>
          {withMarks(text, marks)}
          {/* A last line break needs something after it to take up its line, as it does in the field. */}{' '}
        </div>
      )}
      {textarea}
    </div>
  ) : (
    textarea
  )
  const clip = attachments && (
    <>
      <button type="button" className="sb-attach" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach files (or drop or paste them here)">
        <Icon name="paperclip" size={17} />
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) attachments.add(e.target.files)
          e.target.value = ''
          area.current?.focus()
        }}
      />
    </>
  )
  const send = (
    <>
      {busy && onStop ? (
        <div className="sb-row" style={{ gap: 6, flex: 'none' }}>
          {/* Something typed while the agent works can wait in line for it. */}
          {onQueue && canSend && (
            <button className="sb-send queue" disabled={sending} onClick={() => void submit()} aria-label="Queue" title={`Queue: sends when the agent is done. ${comboLabel({ key: 'enter' })} sends it now, stopping the agent.`}>
              <Icon name="arrow-up" size={18} strokeWidth={2.2} />
            </button>
          )}
          <button className="sb-send stop" onClick={onStop} aria-label="Stop" title="Stop">
            <Icon name="stop" size={16} />
          </button>
        </div>
      ) : (
        <button className="sb-send" disabled={!canSend || sending} onClick={() => void submit()} aria-label="Send" title={attachments?.pending ? 'Attaching…' : 'Send'}>
          <Icon name="arrow-up" size={18} strokeWidth={2.2} />
        </button>
      )}
    </>
  )
  if (layout === 'line')
    return (
      <div className="sb-composer line">
        {error && <div className="sb-note bad">{error}</div>}
        <div className="sb-composer-box">
          {top}
          {attachments && <DraftFiles attachments={attachments} />}
          <div className="sb-composer-row">
            {lead ?? clip}
            {field}
            {trail}
            {send}
          </div>
          {coding && <ComposerPreview text={text} />}
        </div>
        {below}
      </div>
    )
  return (
    <div className="sb-composer">
      {error && <div className="sb-note bad">{error}</div>}
      <div className="sb-composer-box">
        {top}
        {attachments && <DraftFiles attachments={attachments} />}
        {field}
        {coding && <ComposerPreview text={text} />}
        <div className="sb-composer-bar">
          <div className="sb-row" style={{ flexWrap: 'wrap', minWidth: 0 }}>
            {clip}
            {children}
          </div>
          {send}
        </div>
      </div>
      {below}
    </div>
  )
}

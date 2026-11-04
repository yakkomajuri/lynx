// What a tool call did, drawn for what it is: a command as a terminal, an edit as a diff, a file
// with its line numbers, a connector's answer as a table. Every view keeps a switch to the raw JSON.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { call, useConnectors, useTool } from './core'
import { Icon, type IconName } from './icons'
import { Code, Markdown, Spinner } from './ui'

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

export interface ToolStep {
  key: string
  name: string
  /** What the tool does whatever the agent calls it (command, file_read, …); missing in older history. */
  kind?: string
  input: unknown
  result?: unknown
  isError?: boolean
  /** History shortened the call (`inputRef`) or its result (`resultRef`): the event to fetch in full, when opened. */
  inputRef?: string
  resultRef?: string
  /** What the shortened call was about (its command, file, …), for the line that sums it up. */
  lead?: string
}

const payloadCache = new Map<string, Promise<any>>()
/** History shortens long payloads; this fetches the original in full. */
export function fullPayload(sessionId: string, seq: string): Promise<any> {
  const key = `${sessionId}:${seq}`
  let p = payloadCache.get(key)
  if (!p) {
    p = (async () => {
      const chunks: Uint8Array[] = []
      for (let offset = 0; ; ) {
        const r = await call<{ size: number; next_offset: number; data: string }>('agents', 'event_payload', { stream_id: sessionId, seq, offset, length: 1048576 })
        chunks.push(Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)))
        if (r.next_offset >= r.size || r.next_offset === offset) break
        offset = r.next_offset
      }
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        bytes.set(c, at)
        at += c.length
      }
      return JSON.parse(new TextDecoder().decode(bytes))
    })()
    payloadCache.set(key, p)
    p.catch(() => payloadCache.delete(key))
  }
  return p
}

/** A tool_invocation payload as a step: every agent reports { id, kind, name, input }; older history kept each one's own shape. */
export const invocationStep = (p: any): Pick<ToolStep, 'name' | 'kind' | 'input'> => (typeof p?.kind === 'string' ? { name: p.name, kind: p.kind, input: p.input } : { name: p?.name ?? p?.type ?? p?.tool ?? 'tool', input: p?.input ?? p?.arguments ?? p?.command ?? (p?.preview ? p.preview : p) })
/** A tool_result payload: { id, output, is_error }, or before that Claude Code's tool_result block or Codex's whole item. */
export const resultStep = (p: any): Pick<ToolStep, 'result' | 'isError'> => ({ result: p && typeof p === 'object' && 'output' in p ? p.output : (p?.content ?? p), isError: !!p?.is_error })

/** A string field near the start of a shortened payload's JSON (`"name":"…"`), when the cut left it whole. */
export function previewField(preview: string, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const m = preview.match(new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`))
    if (m)
      try {
        return JSON.parse(`"${m[1]}"`)
      } catch {
        return m[1]
      }
  }
  return undefined
}

/** mcp__connection_<id>__tool: the connection's id, and the tool. */
export const connectorTool = (name: string) => {
  const m = name.match(/^mcp__connection_([0-9a-f]{32})__(.+)$/)
  return m ? { connection: m[1]!, tool: m[2]! } : undefined
}

/** The app's own mark (resources/icon.svg without the plate), for the built-in `app` connector. */
const LynxMark = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
    <path fill="currentColor" fillRule="evenodd" d="M50 88 L30 76 L16 58 L22 34 L24 16 L40 34 L60 34 L76 16 L78 34 L84 58 L70 76 Z M31 50 Q38 44 45 52 Q37 56 31 50 Z M69 50 Q62 44 55 52 Q63 56 69 50 Z M45 62 L55 62 L50 68 Z" />
  </svg>
)

/**
 * The service's own icon, fetched by the app from its site. The app's built-in connectors have no
 * site and wear their own marks; anything else without an icon gets the plug (a terminal when it
 * runs on this machine).
 */
export function ConnectorIcon({ connector, size = 20 }: { connector: string; size?: number }) {
  const { connectors } = useConnectors()
  const c = connectors.find((x) => x.id === connector)
  const q = useTool<{ icon: string | null }>('app', 'connector_icon', { connector }, { staleMs: Infinity })
  const [failed, setFailed] = useState(false)
  const icon = q.data?.icon
  if (icon && !failed) return <img className="sb-connect-favicon" src={icon} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setFailed(true)} />
  if (connector === 'app') return <LynxMark size={size} />
  if (c?.native) return <Icon name={connector === 'agents' ? 'spark' : 'wrench'} size={size - 2} />
  return <Icon name={c && !c.url ? 'terminal' : 'plug'} size={size - 2} />
}

/**
 * The connector a call is about: the one it ran on, except for the app connector's own connector_*
 * tools (connector_call, connector_tools, …), which are about the connector named in their input.
 */
export function connectorOf(step: ToolStep, names: Map<string, string>): string | undefined {
  const c = connectorTool(step.name)
  const on = c && names.get(c.connection)
  const named = (step.input as { connector?: unknown } | undefined)?.connector
  return on === 'app' && c!.tool.startsWith('connector_') && typeof named === 'string' && named ? named : on
}

const KIND_ICON: Record<string, IconName> = { command: 'terminal', file_read: 'file', file_change: 'compose', search: 'search', web: 'link', agent: 'spark', mcp: 'plug' }
const NAME_KIND: Record<string, string> = { Bash: 'command', BashOutput: 'command', KillShell: 'command', Read: 'file_read', Edit: 'file_change', MultiEdit: 'file_change', Write: 'file_change', NotebookEdit: 'file_change', Grep: 'search', Glob: 'search', WebFetch: 'web', WebSearch: 'web', Task: 'agent', Agent: 'agent' }
const kindOf = (s: ToolStep) => (s.name.startsWith('mcp__') ? 'mcp' : (NAME_KIND[s.name] ?? s.kind ?? 'other'))

/** The small picture before a tool's name: the connector's icon, or one for what the tool does. */
export function ToolIcon({ step, names }: { step: ToolStep; names: Map<string, string> }) {
  const connector = connectorOf(step, names)
  return <span className="sb-tool-icon">{connector ? <ConnectorIcon connector={connector} size={14} /> : <Icon name={step.name === 'TodoWrite' ? 'check' : (KIND_ICON[kindOf(step)] ?? 'wrench')} size={13} />}</span>
}

// ── reading results ─────────────────────────────────────────────────────────

type Block = { type?: string; text?: string; tool_name?: string; data?: string; mimeType?: string; source?: { data?: string; media_type?: string } }
const isBlocks = (v: unknown): v is Block[] => Array.isArray(v) && v.length > 0 && v.every((c) => c && typeof c === 'object' && typeof (c as Block).type === 'string')

/** A result as text: content blocks joined, a string as it is. */
export const resultText = (v: unknown): string => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  // tool_reference blocks (what ToolSearch found) read as the tools' names.
  if (isBlocks(v)) return v.map((c) => c.text ?? c.tool_name ?? '').join('\n')
  if (typeof v === 'object' && 'content' in v && isBlocks((v as any).content)) return resultText((v as any).content)
  return JSON.stringify(v, null, 2)
}

/** A result as data: its structured content, or its text when that is JSON. Undefined when it is prose. */
const resultData = (v: unknown): unknown => {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'structuredContent' in v) return (v as any).structuredContent
  if (v && typeof v === 'object' && !isBlocks(v)) return v
  const text = resultText(v).trim()
  if (!/^[[{]/.test(text)) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const images = (v: unknown) => (isBlocks(v) ? v.flatMap((c) => (c.type === 'image' && (c.data || c.source?.data) ? [`data:${c.mimeType ?? c.source?.media_type ?? 'image/png'};base64,${c.data ?? c.source?.data}`] : [])) : [])

const LIMIT = 6000

/** Long output is cut at `n` (characters, lines, rows); the button under it shows the rest, and cuts it again. */
function useMore(total: number, n: number, unit: string) {
  const [all, setAll] = useState(false)
  const over = total > n
  return {
    limit: over && !all ? n : total,
    cut: over && !all,
    more: over ? (
      <button type="button" className="sb-tv-more" onClick={() => setAll(!all)}>
        {all ? 'Show less' : `Show all · ${(total - n).toLocaleString()} more ${unit}`}
      </button>
    ) : null,
  }
}

/** Text in a block, cut when long. */
function ClipPre({ text, className, n = LIMIT }: { text: string; className?: string; n?: number }) {
  const m = useMore(text.length, n, 'characters')
  return (
    <>
      <pre className={cx('sb-tv-pre', className)}>{m.cut ? `${text.slice(0, m.limit)}…` : text}</pre>
      {m.more}
    </>
  )
}

/** Code, coloured, cut by lines when long. */
function ClipCode({ text, n = 400, ...code }: { text: string; n?: number; language?: string; numbered?: boolean; start?: number; className?: string }) {
  const lines = text.split('\n')
  const m = useMore(lines.length, n, 'lines')
  return (
    <>
      <Code {...code}>{m.cut ? lines.slice(0, m.limit).join('\n') : text}</Code>
      {m.more}
    </>
  )
}
const plain = (v: unknown) => (v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const LANGS: Record<string, string> = { ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', css: 'css', html: 'xml', xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', sh: 'bash', zsh: 'bash', bash: 'bash', sql: 'sql', diff: 'diff', patch: 'diff' }
const langOf = (path: string) => LANGS[path.split('.').pop()?.toLowerCase() ?? '']
const str = (v: unknown) => (typeof v === 'string' ? v : '')

// ── data as tables ──────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const scalar = (v: unknown) => v === null || typeof v !== 'object'
const ROWS = 50

function Cell({ v }: { v: unknown }) {
  if (v === null || v === undefined || v === '') return <span className="sb-tv-faint">–</span>
  if (typeof v === 'boolean') return <span className={cx('sb-tv-bool', v && 'on')}>{String(v)}</span>
  if (typeof v === 'number') return <span className="sb-tv-num">{v.toLocaleString()}</span>
  if (typeof v === 'string') return <CellText text={v} />
  if (Array.isArray(v) && v.every(scalar)) return <CellText text={v.map(plain).join(', ')} />
  return <CellText text={JSON.stringify(v)} n={60} mono />
}
/** A cell's text: cut when long, and whole when clicked. */
function CellText({ text, n = 80, mono }: { text: string; n?: number; mono?: boolean }) {
  const [all, setAll] = useState(false)
  if (text.length <= n) return <span className={mono ? 'sb-tv-faint sb-tv-mono' : undefined}>{text}</span>
  return (
    <button type="button" className={cx('sb-tv-cell-more', all && 'all', mono && 'sb-tv-faint sb-tv-mono')} onClick={() => setAll(!all)} title={all ? 'Show less' : 'Show all'}>
      {all ? text : `${text.slice(0, n)}…`}
    </button>
  )
}

/** Rows of objects as a table, with the columns the first rows have. */
function RowsTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = useMemo(() => [...new Set(rows.slice(0, 20).flatMap((r) => Object.keys(r)))], [rows])
  const shownColumns = columns.slice(0, 10)
  const m = useMore(rows.length, ROWS, 'rows')
  return (
    <div className="sb-tv-table">
      <table>
        <thead>
          <tr>
            {shownColumns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, m.limit).map((r, i) => (
            <tr key={i}>
              {shownColumns.map((c) => (
                <td key={c}>
                  <Cell v={r[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(m.more || columns.length > shownColumns.length) && (
        <div className="sb-tv-table-foot">
          {columns.length > shownColumns.length && <small>{columns.length - shownColumns.length} more columns in Raw JSON</small>}
          {m.more}
        </div>
      )}
    </div>
  )
}

/** Any JSON value, drawn: lists of records as tables, records as names beside values. */
export function DataView({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (scalar(value)) return typeof value === 'string' ? <TextValue text={value} /> : <Cell v={value} />
  if (Array.isArray(value)) {
    if (!value.length) return <span className="sb-tv-faint">Empty list</span>
    if (value.every(isRecord)) return <RowsTable rows={value} />
    if (value.every(scalar)) return <Cell v={value} />
    if (depth > 1) return <Cell v={value} />
    return <ListView items={value} depth={depth} />
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return <span className="sb-tv-faint">Empty</span>
  return (
    <div className="sb-tv-kv">
      {entries.map(([k, v]) => (
        <div key={k} className={cx('sb-tv-kv-row', ((!scalar(v) && depth < 2) || (typeof v === 'string' && (v.includes('\n') || v.length > 160))) && 'block')}>
          <span className="sb-tv-key">{k}</span>
          <div className="sb-tv-val">{depth < 2 ? <DataView value={v} depth={depth + 1} /> : <Cell v={v} />}</div>
        </div>
      ))}
    </div>
  )
}

function ListView({ items, depth }: { items: unknown[]; depth: number }) {
  const m = useMore(items.length, ROWS, 'items')
  return (
    <div className="sb-tv-list">
      {items.slice(0, m.limit).map((v, i) => (
        <DataView key={i} value={v} depth={depth + 1} />
      ))}
      {m.more}
    </div>
  )
}

/** A string value: short ones inline, ones with lines in a block. */
function TextValue({ text }: { text: string }) {
  if (!text) return <span className="sb-tv-faint">–</span>
  if (!text.includes('\n') && text.length <= 160) return <span className="sb-tv-text">{text}</span>
  return <ClipPre text={text} n={2000} />
}

// ── the views ───────────────────────────────────────────────────────────────

/** A file's text as the Read tool returns it, `   12→code` or `   12\tcode` per line: the lines, and the first one's number. */
export function numberedLines(text: string): { start: number; code: string } | undefined {
  const lines = text.replace(/\n+$/, '').split('\n')
  const m = lines[0]?.match(/^\s*(\d+)[→\t]/)
  if (!m || !lines.every((l) => /^\s*\d+[→\t]/.test(l) || l === '')) return undefined
  return { start: Number(m[1]), code: lines.map((l) => l.replace(/^\s*\d+[→\t]/, '')).join('\n') }
}

/** Line diff of two texts, by longest common subsequence; one side alone when they are too long to compare. */
export function diffLines(before: string, after: string): { op: ' ' | '-' | '+'; text: string }[] {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  if (a.length * b.length > 250000) return [...a.map((text) => ({ op: '-' as const, text })), ...b.map((text) => ({ op: '+' as const, text }))]
  const n = a.length
  const m = b.length
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
  const out: { op: ' ' | '-' | '+'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ op: ' ', text: a[i++]! }), j++
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ op: '-', text: a[i++]! })
    else out.push({ op: '+', text: b[j++]! })
  }
  while (i < n) out.push({ op: '-', text: a[i++]! })
  while (j < m) out.push({ op: '+', text: b[j++]! })
  return out
}

function Diff({ lines }: { lines: { op: ' ' | '-' | '+'; text: string }[] }) {
  const m = useMore(lines.length, 400, 'lines')
  return (
    <>
    <pre className="sb-tv-diff">
      {lines.slice(0, m.limit).map((l, i) => (
        <span key={i} className={l.op === '+' ? 'add' : l.op === '-' ? 'del' : undefined}>
          <i>{l.op}</i>
          {l.text || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
    {m.more}
    </>
  )
}

/** A unified diff (a patch) as text: its lines coloured by their first character. */
const patchLines = (patch: string) => patch.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).map((l) => ({ op: (l[0] === '+' ? '+' : l[0] === '-' ? '-' : ' ') as ' ' | '-' | '+', text: l.startsWith('@@') ? l : l.slice(1) }))

const editLines = (input: any): { op: ' ' | '-' | '+'; text: string }[] => {
  if (Array.isArray(input?.edits)) return input.edits.flatMap((e: any, i: number) => [...(i ? [{ op: ' ' as const, text: '⋯' }] : []), ...diffLines(str(e?.old_string), str(e?.new_string))])
  if (typeof input?.old_string === 'string' || typeof input?.new_string === 'string') return diffLines(str(input.old_string), str(input.new_string))
  if (typeof input?.content === 'string') return diffLines('', input.content)
  return []
}

/** Lines an edit adds and takes away, for the line that sums it up. */
export function editCounts(step: ToolStep): string | undefined {
  if (kindOf(step) !== 'file_change') return undefined
  const fromInput = editLines(step.input)
  const lines = fromInput.length ? fromInput : typeof step.result === 'string' ? patchLines(step.result) : []
  const add = lines.filter((l) => l.op === '+').length
  const del = lines.filter((l) => l.op === '-').length
  return add || del ? `+${add} −${del}` : undefined
}

function Terminal({ input, result, isError, pending }: { input: any; result: unknown; isError?: boolean; pending: boolean }) {
  const command = typeof input === 'string' ? input : str(input?.command)
  const output = resultText(result).replace(/\n+$/, '')
  return (
    <div className={cx('sb-tv-term', isError && 'bad')}>
      {(input?.description || input?.cwd) && <div className="sb-tv-term-head">{input.description ?? input.cwd}</div>}
      <Code language="bash" className="sb-tv-term-cmd">
        {command}
      </Code>
      {result !== undefined ? output ? <ClipPre className="sb-tv-term-out" text={output} /> : <div className="sb-tv-term-out sb-tv-faint">No output</div> : pending ? <div className="sb-tv-term-out sb-tv-faint">Running…</div> : null}
    </div>
  )
}

function FileHead({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <div className="sb-tv-file">
      <Icon name="file" size={13} />
      <b>{path.split('/').pop()}</b>
      {path.includes('/') && <span title={path}>{`\u200e${path.slice(0, path.lastIndexOf('/') + 1)}\u200e`}</span>}
      {children}
    </div>
  )
}

function ReadView({ input, result, isError }: { input: any; result: unknown; isError?: boolean }) {
  const path = str(input?.file_path ?? input?.path)
  const text = resultText(result)
  const lines = numberedLines(text)
  const pics = images(result)
  const range = typeof input?.offset === 'number' && typeof input?.limit === 'number' ? `lines ${input.offset}–${input.offset + input.limit - 1}` : typeof input?.offset === 'number' ? `from line ${input.offset}` : typeof input?.limit === 'number' ? `first ${input.limit} lines` : undefined
  return (
    <div className="sb-tv-box">
      <FileHead path={path}>{range && <small>{range}</small>}</FileHead>
      {pics.map((src, i) => (
        <img key={i} className="sb-tv-img" src={src} alt="" />
      ))}
      {result === undefined ? null : isError ? (
        <ClipPre className="bad" text={text} />
      ) : lines ? (
        <ClipCode numbered start={lines.start} language={langOf(path)} className="sb-tv-flush" text={lines.code} />
      ) : text && !pics.length ? (
        <ClipCode language={langOf(path)} className="sb-tv-flush" text={text} />
      ) : null}
    </div>
  )
}

function EditView({ step }: { step: ToolStep }) {
  const input = step.input as any
  const path = str(input?.file_path ?? input?.path ?? input?.notebook_path)
  const fromInput = editLines(input)
  const patch = !fromInput.length && typeof step.result === 'string' && /^(@@|[-+])/m.test(step.result) ? patchLines(step.result) : []
  const counts = editCounts(step)
  return (
    <div className="sb-tv-box">
      <FileHead path={path}>{counts && <small>{counts}</small>}</FileHead>
      {step.name === 'Write' && typeof input?.content === 'string' ? (
        <ClipCode numbered language={langOf(path)} className="sb-tv-flush" text={input.content} />
      ) : fromInput.length || patch.length ? (
        <Diff lines={fromInput.length ? fromInput : patch} />
      ) : Array.isArray(input?.changes) ? (
        <div className="sb-tv-changes">
          {input.changes.map((c: any, i: number) => (
            <div key={i}>
              <span className="sb-tv-badge">{str(c?.kind?.type ?? c?.kind) || 'edit'}</span> {str(c?.path)}
            </div>
          ))}
        </div>
      ) : null}
      {step.isError && <ClipPre className="bad" text={resultText(step.result)} />}
    </div>
  )
}

function TodoView({ input }: { input: any }) {
  const todos: { content?: string; status?: string; activeForm?: string }[] = Array.isArray(input?.todos) ? input.todos : []
  return (
    <ul className="sb-tv-todos">
      {todos.map((t, i) => (
        <li key={i} className={t.status}>
          <span className="sb-tv-check">{t.status === 'completed' && <Icon name="check" size={11} />}</span>
          {t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}
        </li>
      ))}
    </ul>
  )
}

function SearchView({ input, result, isError }: { input: any; result: unknown; isError?: boolean }) {
  const text = resultText(result).replace(/\n+$/, '')
  const hits = text ? text.split('\n') : []
  const m = useMore(hits.length, 200, 'lines')
  return (
    <div className="sb-tv-box">
      <div className="sb-tv-search">
        <Icon name="search" size={12} />
        <code>{str(input?.pattern ?? input?.query)}</code>
        {(input?.path || input?.glob || input?.type) && <small>in {[input.path, input.glob, input.type].filter(Boolean).join(' · ')}</small>}
      </div>
      {result === undefined ? null : isError ? (
        <ClipPre className="bad" text={text} />
      ) : (
        <pre className="sb-tv-pre sb-tv-hits">{hits.length ? hits.slice(0, m.limit).join('\n') : 'Nothing found'}</pre>
      )}
      {!isError && m.more}
    </div>
  )
}

/** A result in words, read as Markdown: what a sub-agent or a web page said. */
function Prose({ result, isError }: { result: unknown; isError?: boolean }) {
  const text = resultText(result)
  const m = useMore(text.length, 12000, 'characters')
  if (result === undefined) return null
  if (isError) return <ClipPre className="bad" text={text} />
  return (
    <>
      <div className="sb-tv-prose">
        <Markdown>{m.cut ? `${text.slice(0, m.limit)}…` : text}</Markdown>
      </div>
      {m.more}
    </>
  )
}

function WebView({ step }: { step: ToolStep }) {
  const input = step.input as any
  const url = str(input?.url)
  return (
    <div className="sb-tv-box">
      <div className="sb-tv-search">
        <Icon name={url ? 'link' : 'search'} size={12} />
        {url ? <span title={url}>{url}</span> : <code>{str(input?.query)}</code>}
      </div>
      {input?.prompt && <div className="sb-tv-ask">{input.prompt}</div>}
      {typeof step.result === 'string' || isBlocks(step.result) ? <Prose result={step.result} isError={step.isError} /> : step.result !== undefined && <DataView value={step.result} />}
    </div>
  )
}

function AgentView({ step }: { step: ToolStep }) {
  const input = step.input as any
  return (
    <div className="sb-tv-box">
      {(input?.description || input?.subagent_type) && (
        <div className="sb-tv-search">
          <Icon name="spark" size={12} />
          <span>{[input.subagent_type, input.description].filter(Boolean).join(' · ')}</span>
        </div>
      )}
      {input?.prompt && <AskText text={str(input.prompt)} />}
      <Prose result={step.result} isError={step.isError} />
    </div>
  )
}

/** What a sub-agent was asked, cut when long. */
function AskText({ text }: { text: string }) {
  const m = useMore(text.length, 600, 'characters')
  return (
    <div className="sb-tv-ask">
      {m.cut ? `${text.slice(0, m.limit)}…` : text}
      {m.more}
    </div>
  )
}

/**
 * What a connector answered, as the data itself: the app's connector_call wraps the connector's
 * own result ({ result: { content, structuredContent } }), and the text of a content block is
 * often JSON. Undefined when it is not data.
 */
export function answerOf(v: unknown, depth = 0): unknown {
  if (depth > 4) return v
  if (isRecord(v) && Object.keys(v).length === 1 && 'result' in v) return answerOf(v.result, depth + 1)
  if (isRecord(v) && (isBlocks(v.content) || 'structuredContent' in v)) {
    const inner = v.structuredContent ?? resultData(v.content)
    return inner === undefined || inner === null ? resultText(v.content) : answerOf(inner, depth + 1)
  }
  if (isBlocks(v)) {
    const inner = resultData(v)
    return inner === undefined ? resultText(v) : answerOf(inner, depth + 1)
  }
  if (typeof v === 'string') {
    const inner = resultData(v)
    return inner === undefined ? v : answerOf(inner, depth + 1)
  }
  return v
}

/** Images anywhere in a connector's answer, the app's connector_call wrapping included. */
const imagesOf = (v: unknown, depth = 0): string[] => (depth > 4 ? [] : isBlocks(v) ? images(v) : isRecord(v) ? [...imagesOf(v.content, depth + 1), ...('result' in v ? imagesOf(v.result, depth + 1) : [])] : [])

/** The app's connector_call: what was asked of the connector it called is its arguments. */
const isConnectorCall = (s: ToolStep) => /(^|__)connector_call$/.test(s.name) && isRecord(s.input) && typeof s.input.connector === 'string'
export const callInput = (s: ToolStep): unknown => (isConnectorCall(s) ? ((s.input as Record<string, unknown>).arguments ?? {}) : s.input)

/** A connector's tool, or any other: what it was asked, and what it answered as data when it is data. */
function CallView({ step }: { step: ToolStep }) {
  const input = callInput(step)
  const value = step.result === undefined || step.isError ? undefined : answerOf(step.result)
  // { result: "…" } and the like: the one string is the answer.
  const only = isRecord(value) && Object.keys(value).length === 1 ? Object.values(value)[0] : undefined
  const text = typeof value === 'string' ? value : typeof only === 'string' ? only : resultText(step.result)
  const data = typeof value === 'string' || typeof only === 'string' ? undefined : value
  const pics = imagesOf(step.result)
  const args = isRecord(input) ? Object.entries(input).filter(([, v]) => v !== undefined) : []
  return (
    <>
      {isRecord(input) ? (
        args.length > 0 && (
          <div className="sb-tv-section">
            <span className="sb-tv-label">Input</span>
            <DataView value={input} />
          </div>
        )
      ) : (
        input !== undefined && input !== '' && <DataView value={input} />
      )}
      {step.result !== undefined && (
        <div className="sb-tv-section">
          <span className="sb-tv-label">{step.isError ? 'Error' : 'Result'}</span>
          {pics.map((src, i) => (
            <img key={i} className="sb-tv-img" src={src} alt="" />
          ))}
          {step.isError ? <ClipPre className="bad" text={text} /> : data !== undefined ? <DataView value={data} /> : text.trim() ? <ClipPre text={text} /> : !pics.length && <span className="sb-tv-faint">No output</span>}
        </div>
      )}
    </>
  )
}

const raw = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

function Raw({ step }: { step: ToolStep }) {
  return (
    <>
      <ClipCode language={typeof step.input === 'string' ? undefined : 'json'} text={raw(step.input)} />
      {step.result !== undefined && <ClipCode className={step.isError ? 'bad' : undefined} language={/^\s*[[{]/.test(raw(step.result)) ? 'json' : undefined} text={raw(step.result)} />}
    </>
  )
}

/** The step in full: what history shortened, fetched once it is opened. */
function useFullStep(sessionId: string | undefined, step: ToolStep): { step: ToolStep; loading: boolean; error?: string } {
  const need = !!sessionId && !!(step.inputRef || step.resultRef)
  const [got, setGot] = useState<{ key: string; input?: any; result?: any; error?: string }>()
  const key = `${sessionId}:${step.inputRef ?? ''}:${step.resultRef ?? ''}`
  useEffect(() => {
    if (!need) return
    let live = true
    Promise.all([step.inputRef ? fullPayload(sessionId!, step.inputRef) : undefined, step.resultRef ? fullPayload(sessionId!, step.resultRef) : undefined]).then(
      ([input, result]) => live && setGot({ key, input, result }),
      (e) => live && setGot({ key, error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, [key, need])
  if (!need) return { step, loading: false }
  if (got?.key !== key) return { step, loading: true }
  if (got.error) return { step, loading: false, error: got.error }
  return { loading: false, step: { ...step, ...(got.input ? invocationStep(got.input) : {}), ...(got.result ? resultStep(got.result) : {}), inputRef: undefined, resultRef: undefined } }
}

/** A tool call opened up: its own view, with a switch to the JSON it was made of. */
export function ToolBody({ step: shortened, pending, sessionId }: { step: ToolStep; pending: boolean; sessionId?: string }) {
  const [showRaw, setShowRaw] = useState(false)
  const { step, loading, error } = useFullStep(sessionId, shortened)
  const kind = kindOf(step)
  if (loading)
    return (
      <div className="sb-tv sb-tv-loading">
        <Spinner />
      </div>
    )
  if (error) return <div className="sb-tv sb-tv-pre bad">Could not load this call in full: {error}</div>
  const view =
    step.name === 'TodoWrite' ? (
      <TodoView input={step.input} />
    ) : kind === 'command' && step.name !== 'KillShell' && (typeof step.input === 'string' || typeof (step.input as any)?.command === 'string') ? (
      <Terminal input={step.input} result={step.result} isError={step.isError} pending={pending} />
    ) : kind === 'file_read' ? (
      <ReadView input={step.input} result={step.result} isError={step.isError} />
    ) : kind === 'file_change' ? (
      <EditView step={step} />
    ) : kind === 'search' ? (
      <SearchView input={step.input} result={step.result} isError={step.isError} />
    ) : kind === 'web' ? (
      <WebView step={step} />
    ) : kind === 'agent' ? (
      <AgentView step={step} />
    ) : (
      <CallView step={step} />
    )
  return (
    <div className="sb-tv">
      {showRaw ? <Raw step={step} /> : view}
      <button type="button" className={cx('sb-tv-raw', showRaw && 'on')} onClick={() => setShowRaw(!showRaw)} title={showRaw ? 'Show formatted' : 'Show the raw JSON'}>
        {showRaw ? 'Formatted' : 'Raw JSON'}
      </button>
    </div>
  )
}

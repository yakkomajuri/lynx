// Plain, theme-aware building blocks. Workspace code is free to ignore all of this and write its
// own markup and CSS; these exist so a useful page is twenty lines.
import { useMemo, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { askAgent, useNow, workspace } from './core'
import { highlight } from './highlight'
import { Icon } from './icons'

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

export function Page({ title, subtitle, actions, children, wide }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; wide?: boolean }) {
  return (
    <div className={cx('sb-page', wide && 'wide')}>
      {(title || actions) && (
        <header className="sb-page-head">
          <div>
            {title && <h1>{title}</h1>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="sb-row">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  )
}

export function Card({ title, actions, children, pad = true, style }: { title?: ReactNode; actions?: ReactNode; children?: ReactNode; pad?: boolean; style?: CSSProperties }) {
  return (
    <section className="sb-card" style={style}>
      {(title || actions) && (
        <header className="sb-card-head">
          <h2>{title}</h2>
          {actions && <div className="sb-row">{actions}</div>}
        </header>
      )}
      <div className={cx('sb-card-body', !pad && 'flush')}>{children}</div>
    </section>
  )
}

export const Row = ({ children, gap = 8, align = 'center', wrap, style }: { children?: ReactNode; gap?: number; align?: CSSProperties['alignItems']; wrap?: boolean; style?: CSSProperties }) => <div style={{ display: 'flex', alignItems: align, gap, flexWrap: wrap ? 'wrap' : undefined, ...style }}>{children}</div>
export const Stack = ({ children, gap = 12, style }: { children?: ReactNode; gap?: number; style?: CSSProperties }) => <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>{children}</div>
export const Grid = ({ children, min = 240, gap = 12 }: { children?: ReactNode; min?: number; gap?: number }) => <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap }}>{children}</div>

type Tone = 'neutral' | 'good' | 'bad' | 'warn' | 'live' | 'accent'
export const Badge = ({ children, tone = 'neutral' }: { children?: ReactNode; tone?: Tone }) => <span className={cx('sb-badge', tone)}>{children}</span>

export function Button({ variant = 'default', size, busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger'; size?: 'sm'; busy?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || busy} className={cx('sb-btn', variant, size, rest.className)}>
      {busy && <Spinner />}
      {children}
    </button>
  )
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx('sb-input', p.className)} />
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx('sb-input', p.className)} />
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx('sb-input sb-select', p.className)} />
export const Field = ({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) => (
  <label className="sb-field">
    <span>{label}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>
)

export const Spinner = () => <span className="sb-spinner" aria-label="Loading" />
export const Empty = ({ title, children, action }: { title?: ReactNode; children?: ReactNode; action?: ReactNode }) => (
  <div className="sb-empty">
    {title && <strong>{title}</strong>}
    {children && <p>{children}</p>}
    {action}
  </div>
)
/** The prompt "Ask the agent to fix it" drafts: what went wrong, and where. */
const fixPrompt = (message: string, context?: string) => {
  const name = workspace().name
  return `${name ? `The ${name} workspace` : 'This workspace'} shows this error${context ? ` (${context})` : ''}. Find out why and fix it.\n\n${message.slice(0, 3000)}`
}

/**
 * An error, with Retry when there is something to retry and "Ask the agent to fix it", which
 * opens the agent panel with an unsent workspace-repair draft. `fix` is extra context for the agent (what the page
 * was doing), or false where an agent cannot help (the user typed something invalid).
 */
export const ErrorNote = ({ error, retry, fix }: { error?: Error | string | null; retry?: () => void; fix?: string | false }) => {
  if (!error) return null
  const message = typeof error === 'string' ? error : error.message
  return (
    <div className="sb-error">
      <span>{message}</span>
      {(retry || fix !== false) && (
        <span className="sb-error-acts">
          {retry && (
            <button className="sb-btn sm ghost" onClick={retry}>
              Retry
            </button>
          )}
          {fix !== false && (
            <button className="sb-btn sm ghost" onClick={() => askAgent(fixPrompt(message, fix || undefined))}>
              Ask the agent to fix it
            </button>
          )}
        </span>
      )}
    </div>
  )
}

/** Loading, error and empty handling for a `useTool` result in one place. */
export function Query<T>({ q, empty, children }: { q: { data: T | undefined; error?: Error; loading: boolean; reload: () => unknown }; empty?: ReactNode; children: (data: T) => ReactNode }) {
  if (q.loading)
    return (
      <div className="sb-empty">
        <Spinner />
      </div>
    )
  if (q.error && q.data === undefined) return <ErrorNote error={q.error} retry={() => void q.reload()} />
  if (q.data === undefined || q.data === null || (Array.isArray(q.data) && !q.data.length)) return <>{empty ?? <Empty title="Nothing here" />}</>
  return <>{children(q.data)}</>
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="sb-stat">
      <span className="sb-stat-label">{label}</span>
      <span className={cx('sb-stat-value', tone)}>{value}</span>
      {hint && <span className="sb-stat-hint">{hint}</span>}
    </div>
  )
}

export interface Column<T> {
  key: string
  title?: ReactNode
  render?: (row: T) => ReactNode
  width?: number | string
  align?: 'left' | 'right'
}
export function Table<T extends Record<string, any>>({ rows, columns, onRow, rowKey }: { rows: T[]; columns: Column<T>[]; onRow?: (row: T) => void; rowKey?: (row: T, i: number) => string | number }) {
  return (
    <table className="sb-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} style={{ width: c.width, textAlign: c.align }}>
              {c.title ?? c.key}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey ? rowKey(row, i) : i} onClick={onRow ? () => onRow(row) : undefined} className={onRow ? 'click' : undefined}>
            {columns.map((c) => (
              <td key={c.key} style={{ textAlign: c.align, whiteSpace: c.width ? 'nowrap' : undefined }}>
                {c.render ? c.render(row) : String(row[c.key] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="sb-tabs" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Modal({ title, onClose, children, footer, width = 480 }: { title?: ReactNode; onClose: () => void; children?: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <div className="sb-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sb-modal" style={{ width }} role="dialog">
        {title && <h2>{title}</h2>}
        <div className="sb-modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

const textOf = (node: any): string => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.props?.children ? textOf(node.props.children) : '')

/** Copies text and shows a tick for a moment. */
export function CopyButton({ text, label }: { text: string | (() => string); label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="sb-copy"
      title="Copy"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={15} />
      {label && <span>{done ? 'Copied' : label}</span>}
    </button>
  )
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const language = /language-([\w+#.-]+)/.exec((children as any)?.props?.className ?? '')?.[1]
  const text = textOf(children).replace(/\n$/, '')
  const html = useMemo(() => highlight(text, language), [text, language])
  return (
    <div className="sb-codeblock">
      <div className="sb-codeblock-head">
        <span>{language ?? 'text'}</span>
        <CopyButton text={text} label="Copy" />
      </div>
      {html === null ? <pre>{children}</pre> : <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>}
    </div>
  )
}

export const Markdown = ({ children }: { children: string }) => (
  <div className="sb-md">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" />, pre: CodeBlock }}>
      {children}
    </ReactMarkdown>
  </div>
)

/**
 * A block of code or output. With `language` (js, ts, json, python, bash, sql, css, html, yaml,
 * diff, go, rust, java, ruby, markdown) a string is syntax-coloured; `numbered` adds line numbers
 * and stops long lines wrapping.
 */
export function Code({ children, language, numbered, start = 1, className }: { children: ReactNode; language?: string; numbered?: boolean; /** The first line's number, when `numbered`. */ start?: number; className?: string }) {
  const text = typeof children === 'string' ? children : null
  const html = useMemo(() => (text === null ? null : highlight(text, language)), [text, language])
  const body = html === null ? <code>{children}</code> : <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
  if (!numbered || text === null) return <pre className={cx('sb-code', className)}>{html === null ? children : body}</pre>
  return (
    <pre className={cx('sb-code numbered', className)}>
      <span className="sb-code-gutter" aria-hidden>
        {text.split('\n').map((_, i) => i + start).join('\n')}
      </span>
      {body}
    </pre>
  )
}

/** Collapsed-by-default detail. */
export function Details({ summary, children, open: initial }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(!!initial)
  return (
    <div className={cx('sb-details', open && 'open')}>
      <button onClick={() => setOpen(!open)}>
        <span className="sb-caret">›</span>
        {summary}
      </button>
      {open && <div className="sb-details-body">{children}</div>}
    </div>
  )
}

// ── formatting ──────────────────────────────────────────────────────────────
export function rel(date: string | number | Date | null | undefined, now = Date.now()) {
  if (!date) return ''
  const s = Math.round((now - new Date(date).getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
export function Time({ value }: { value: string | number | Date | null | undefined }) {
  const now = useNow()
  return value ? <time title={new Date(value).toLocaleString()}>{rel(value, now)}</time> : null
}
export const fmt = (n: number | null | undefined, opts: Intl.NumberFormatOptions = {}) => (n === null || n === undefined || Number.isNaN(n) ? '–' : new Intl.NumberFormat(undefined, { notation: Math.abs(n) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1, ...opts }).format(n))

// ── small charts (import recharts in your own code for anything richer) ─────
export interface Series {
  name?: string
  values: number[]
  color?: string
}
const PALETTE = ['var(--sb-accent)', 'var(--sb-blue)', 'var(--sb-good)', 'var(--sb-violet)', 'var(--sb-bad)']

export function LineChart({ series, labels, height = 180, area = true }: { series: Series[]; labels?: string[]; height?: number; area?: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = Math.max(0, ...series.map((s) => s.values.length))
  const all = series.flatMap((s) => s.values)
  if (!n || !all.length) return <Empty>No data</Empty>
  const max = Math.max(...all, 0) || 1
  const min = Math.min(...all, 0)
  const W = 600
  const H = height
  const pad = { l: 6, r: 6, t: 10, b: labels ? 20 : 6 }
  const x = (i: number) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1))
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b)
  const path = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const ticks = labels ? [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i) : []
  return (
    <div className="sb-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setHover(Math.max(0, Math.min(n - 1, Math.round((((e.clientX - r.left) / r.width) * W - pad.l) / ((W - pad.l - pad.r) / Math.max(1, n - 1))))))
        }}
      >
        {[0, 0.5, 1].map((t) => (
          <line key={t} x1={pad.l} x2={W - pad.r} y1={pad.t + t * (H - pad.t - pad.b)} y2={pad.t + t * (H - pad.t - pad.b)} className="sb-chart-grid" />
        ))}
        {series.map((s, si) => {
          const color = s.color ?? PALETTE[si % PALETTE.length]
          return (
            <g key={si}>
              {area && series.length === 1 && <path d={`${path(s.values)}L${x(s.values.length - 1)},${H - pad.b}L${x(0)},${H - pad.b}Z`} fill={color} opacity={0.1} />}
              <path d={path(s.values)} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          )
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="sb-chart-cursor" vectorEffect="non-scaling-stroke" />}
      </svg>
      {labels && (
        <div className="sb-chart-axis">
          {ticks.map((i) => (
            <span key={i}>{labels[i]}</span>
          ))}
        </div>
      )}
      <div className="sb-chart-legend">
        {hover !== null && labels?.[hover] && <strong>{labels[hover]}</strong>}
        {series.map((s, si) => (
          <span key={si}>
            <i style={{ background: s.color ?? PALETTE[si % PALETTE.length] }} />
            {s.name ?? `Series ${si + 1}`}
            {hover !== null && <b>{fmt(s.values[hover])}</b>}
          </span>
        ))}
      </div>
    </div>
  )
}

export function BarChart({ data, height = 180, color }: { data: { label: string; value: number }[]; height?: number; color?: string }) {
  if (!data.length) return <Empty>No data</Empty>
  const max = Math.max(...data.map((d) => d.value), 0) || 1
  return (
    <div className="sb-bars" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="sb-bar" title={`${d.label}: ${fmt(d.value)}`}>
          <span className="sb-bar-value">{fmt(d.value)}</span>
          <div style={{ height: `${Math.max(1, (d.value / max) * 100)}%`, background: color ?? 'var(--sb-accent)' }} />
          <span className="sb-bar-label">{d.label}</span>
        </div>
      ))}
    </div>
  )
}

export function Sparkline({ values, width = 96, height = 24, color = 'var(--sb-accent)' }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return <svg width={width} height={height} />
  const max = Math.max(...values)
  const min = Math.min(...values)
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / (max - min || 1)) * (height - 4)).toFixed(1)}`).join('')
  return (
    <svg width={width} height={height} className="sb-spark">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  )
}

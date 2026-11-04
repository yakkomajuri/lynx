// The settings pages for tools, schedules, runs and the store, laid out the way postgres2mcp lays
// out its own: a page header with one primary action, titled sections, bordered lists of rows, and
// a drawer that slides over the page for the row that is open.
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** The card a page lives in. The drawer goes over the page, not beside it. */
export function Page({ title, sub, actions, drawer, wide, fill, children }: { title: string; sub?: ReactNode; actions?: ReactNode; drawer?: ReactNode; /** Room for a table that wants it. */ wide?: boolean; /** The page is exactly as tall as the card, and its last child takes what is left. */ fill?: boolean; children: ReactNode }) {
  return (
    <div className="h-pcard">
      <div className="h-pscroll">
        <div className={cx('h-ppage', wide && 'wide', fill && 'fill')}>
          <header className="h-phead">
            <div>
              <h1>{title}</h1>
              {sub && <p>{sub}</p>}
            </div>
            {actions && <div className="h-pactions">{actions}</div>}
          </header>
          {children}
        </div>
      </div>
      {drawer}
    </div>
  )
}

export const Search = ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) => (
  <input className="h-psearch" type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} spellCheck={false} />
)

/** A section's title, with what it holds said beside it. */
export const SectionHead = ({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) => (
  <div className="h-psec">
    <h2>{title}</h2>
    {hint && <span>{hint}</span>}
    {children}
  </div>
)

export const List = ({ children }: { children: ReactNode }) => <div className="h-plist">{children}</div>

/** One row. With `onOpen` the row is a button that opens it; `actions` sit at its right end. */
export function Item({ onOpen, actions, dim, label, children }: { onOpen?: () => void; actions?: ReactNode; dim?: boolean; /** What the row is, for its button. */ label?: string; children: ReactNode }) {
  return (
    <div className={cx('h-pitem', dim && 'dim')}>
      {onOpen ? (
        <button className="h-prow" onClick={onOpen} aria-label={label}>
          {children}
        </button>
      ) : (
        <div className="h-prow still">{children}</div>
      )}
      {actions && <div className="h-pacts">{actions}</div>}
    </div>
  )
}

/** The name column of a row: the name, and a line under it. */
export const Name = ({ children, sub, mono = true }: { children: ReactNode; sub?: ReactNode; mono?: boolean }) => (
  <span className={cx('h-pname', mono && 'mono')}>
    <b>{children}</b>
    {sub && <span>{sub}</span>}
  </span>
)

/** The middle of a row: a line of text and, optionally, a monospaced line under it. */
export const Body = ({ children, sub }: { children: ReactNode; sub?: ReactNode }) => (
  <span className="h-pbody">
    <span>{children}</span>
    {sub && <code>{sub}</code>}
  </span>
)

export const Empty = ({ children }: { children: ReactNode }) => <div className="h-pempty">{children}</div>

/** An on/off switch. */
export const Toggle = ({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) => (
  <button className={cx('h-toggle', on && 'on')} role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!on)} />
)

export function Drawer({ eyebrow, title, meta, actions, onClose, children }: { eyebrow: string; title: ReactNode; meta?: ReactNode; actions?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('textarea, input, select') && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="h-pscrim" onClick={onClose} />
      <aside className="h-pdrawer" role="dialog" aria-label={typeof title === 'string' ? title : eyebrow}>
        <header className="h-pdhead">
          <small>{eyebrow}</small>
          <h2>{title}</h2>
          {meta && <div className="h-pdmeta">{meta}</div>}
          <div className="h-pdacts">
            {actions}
            <button className="h-dicon" aria-label="Close" title="Close" onClick={onClose}>
              <X size={16} strokeWidth={1.7} />
            </button>
          </div>
        </header>
        <div className="h-pdbody">{children}</div>
      </aside>
    </>
  )
}

export const DrawerSection = ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) => (
  <section className="h-pdsec">
    <h3>
      <span>{title}</span>
      {actions}
    </h3>
    {children}
  </section>
)

/** Name and value pairs, one per line. */
export const Facts = ({ rows }: { rows: [string, ReactNode][] }) => (
  <dl className="h-pfacts">
    {rows.map(([k, v]) => (
      <div key={k}>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </div>
    ))}
  </dl>
)

// The title bar's word that a newer Lynx is out. It opens on the new version and what changed, with
// the button that installs it. Skipping versions, it shows what each of them changed, newest first. Installing goes on in the background (the card can be put away, and the
// button's border fills clockwise with the download); once it is in, the button says Restart.
// The checking and installing are the main process's (updates.ts).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CircleArrowUp, RotateCw } from 'lucide-react'
import { Markdown } from '@kit/ui'
import type { UpdateState } from '@shared/types'
import { bridge } from './api'

export function UpdateButton({ update, busy, onError }: { update: UpdateState; /** Agent runs and shell commands under way, which restarting stops. */ busy: number; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const latest = update.latest
  if (!latest) return null
  const working = update.status === 'downloading' || update.status === 'installing'
  const ready = update.status === 'ready'
  const pct = update.status === 'installing' ? 100 : Math.round((update.progress ?? 0) * 100)
  const act = (f: () => Promise<unknown>) => void f().catch(onError)
  const label = ready ? 'Restart' : update.status === 'installing' ? 'Installing…' : working ? 'Updating…' : 'Update'
  const title = ready ? `Lynx ${latest.version} is installed: restart to finish` : working ? `Updating to Lynx ${latest.version}: ${update.status === 'installing' ? 'installing' : `${pct}% downloaded`}` : `Lynx ${latest.version} is available`
  // The versions since this one that say what they changed. Only the newest's own notes keep the plain
  // look; anything else is headed by its version, so older notes never read as the newest's.
  const changes = latest.changes.filter((c) => c.notes)
  const plain = changes.length === 1 && changes[0]!.version === latest.version
  const skipped = latest.changes.length
  const restartNote = busy > 0 && <p className="h-update-hint">Restarting stops {busy === 1 ? 'the agent or command' : `the ${busy} agents and commands`} at work now.</p>
  return (
    <div className="h-menu-anchor">
      <button className={`sb-btn sm h-update${open ? ' on' : ''}${ready ? ' ready' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" title={title}>
        {ready ? <RotateCw size={15} strokeWidth={1.9} /> : <CircleArrowUp size={16} strokeWidth={1.8} />}
        {label}
        {working && <Ring pct={pct} />}
      </button>
      {open && (
        <>
          {/* Clicking away puts the card away; a download carries on. */}
          <div className="h-scrim" onClick={() => setOpen(false)} />
          <div className="h-update-card" role="dialog" aria-label="Update Lynx">
            {ready ? (
              <>
                <header>
                  <strong>Installation of version {latest.version} complete</strong>
                  <span>Restart to complete the update.</span>
                </header>
                {restartNote}
                <div className="h-update-actions">
                  <button className="sb-btn sm ghost" onClick={() => setOpen(false)}>
                    Later
                  </button>
                  <button className="sb-btn sm primary" onClick={() => act(() => bridge.restartUpdate())}>
                    Restart
                  </button>
                </div>
              </>
            ) : (
              <>
                <header>
                  <strong>Lynx {latest.version} is available</strong>
                  <span>
                    You have {update.current}
                    {skipped > 1 ? ` · ${skipped} new versions` : latest.date && ` · released ${latest.date}`}
                  </span>
                </header>
                {plain ? (
                  <div className="h-update-notes">
                    <Markdown>{changes[0]!.notes!}</Markdown>
                  </div>
                ) : changes.length > 0 && (
                  <div className="h-update-notes many">
                    {changes.map((c) => (
                      <section key={c.version} className="h-update-version">
                        <h4>
                          <span>{c.version}</span>
                          {c.version === latest.version && <em>Newest</em>}
                          {c.date && <time dateTime={c.date}>{c.date}</time>}
                        </h4>
                        <Markdown>{c.notes!}</Markdown>
                      </section>
                    ))}
                  </div>
                )}
                {working ? (
                  <div className="h-update-progress" role="status">
                    <span>{update.status === 'installing' ? 'Installing…' : update.progress != null ? `Downloading… ${pct}%` : 'Downloading…'}</span>
                    <div className="h-update-bar">
                      <i style={{ width: `${pct}%` }} />
                    </div>
                    <span className="h-update-hint">You can keep working: the button says Restart when it’s ready.</span>
                  </div>
                ) : (
                  <>
                    {update.status === 'error' && update.error && <p className="h-update-error">{update.error}</p>}
                    {!update.canInstall && <p className="h-update-hint">This copy can’t replace itself. Download the new version, drag it to Applications in place of this one, then open it again.</p>}
                    <div className="h-update-actions">
                      <button className="sb-btn sm ghost" onClick={() => setOpen(false)}>
                        Later
                      </button>
                      {update.canInstall ? (
                        <button className="sb-btn sm primary" onClick={() => act(() => bridge.installUpdate())}>
                          {update.status === 'error' ? 'Try again' : 'Install'}
                        </button>
                      ) : (
                        <button className="sb-btn sm primary" onClick={() => act(() => bridge.downloadUpdate())}>
                          Download
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** The button's border as a progress ring: from the top middle, clockwise, as far as `pct`. */
function Ring({ pct }: { pct: number }) {
  const ref = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const button = ref.current?.parentElement
    if (!button) return
    const measure = () => setSize({ w: button.offsetWidth, h: button.offsetHeight })
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(button)
    return () => watch.disconnect()
  }, [])
  const s = 1 // half the stroke, so the ring sits on the border
  const d = size && (() => {
    const { w, h } = size
    const r = h / 2 - s
    const [x0, y0, x1, y1] = [s, s, w - s, h - s]
    return `M ${w / 2} ${y0} H ${x1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} H ${x0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} Z`
  })()
  return (
    <svg ref={ref} className="h-update-ring" width={size?.w ?? 0} height={size?.h ?? 0} aria-hidden>
      {d && (
        <>
          <path d={d} pathLength={100} className="track" />
          <path d={d} pathLength={100} className="done" strokeDasharray={`${pct} 100`} />
        </>
      )}
    </svg>
  )
}

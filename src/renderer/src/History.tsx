// A workspace's history: every change published to it, newest first, and the drafts agents have in
// progress. Any change can be undone on its own, as a new change that reverses it.
import { useEffect, useState } from 'react'
import { Modal, rel } from '@kit/ui'
import type { WorkspaceInfo } from '@shared/types'
import { app } from './api'

interface Change {
  commit: string
  by: string
  at: string
  message: string
  files: string[]
}
interface Draft {
  draft: string
  ahead: number
  behind: number
}

export function HistoryDialog({ ws, onClose, toast }: { ws: WorkspaceInfo; onClose: () => void; toast: (text: string, tone?: 'info' | 'good' | 'bad') => void }) {
  const [data, setData] = useState<{ changes: Change[]; drafts: Draft[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undoing, setUndoing] = useState<string | null>(null)
  const load = () =>
    app('workspace_history', { workspace: ws.id }).then(
      (r) => (setData(r), setError(null)),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    )
  useEffect(() => void load(), [ws.id])

  const undo = async (c: Change) => {
    if (!confirm(`Undo “${c.message}”? Later changes stay.`)) return
    setUndoing(c.commit)
    try {
      const r = await app('workspace_revert', { workspace: ws.id, commit: c.commit })
      toast(r.reverted ? `Undid “${c.message}”` : r.reason, r.reverted ? 'good' : 'bad')
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad')
    } finally {
      setUndoing(null)
    }
  }

  return (
    <Modal title={`History of ${ws.name}`} onClose={onClose} width={560} footer={<button className="sb-btn sm" onClick={onClose}>Close</button>}>
      {error ? (
        <p className="h-history-note bad">{error}</p>
      ) : !data ? (
        <p className="h-history-note">Loading…</p>
      ) : (
        <>
          {data.drafts.length > 0 && (
            <section className="h-history-drafts">
              <h3>In progress</h3>
              {data.drafts.map((d) => (
                <div key={d.draft} className="h-history-draft">
                  <code>{d.draft}</code>
                  <span>{d.ahead ? `${d.ahead} unpublished` : 'nothing unpublished'}{d.behind ? ` · ${d.behind} behind` : ''}</span>
                </div>
              ))}
            </section>
          )}
          <ol className="h-history">
            {data.changes.map((c, i) => (
              <li key={c.commit}>
                <div className="h-history-main">
                  <strong>{c.message}</strong>
                  <span>
                    {c.by} · <time title={new Date(c.at).toLocaleString()}>{rel(c.at)}</time>
                    {c.files.length ? ` · ${c.files.length === 1 ? c.files[0] : `${c.files.length} files`}` : ''}
                  </span>
                </div>
                {/* The first change is where the history starts; there is nothing before it to go back to. */}
                {i < data.changes.length - 1 && (
                  <button className="sb-btn sm ghost" disabled={!!undoing} onClick={() => void undo(c)} title="Undo this change, keeping the ones after it">
                    {undoing === c.commit ? 'Undoing…' : 'Undo'}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </Modal>
  )
}

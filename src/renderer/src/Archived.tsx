// Workspaces that were put away: out of the list and its shortcuts, with everything they have kept.
import { ArchiveRestore, Trash2 } from 'lucide-react'
import { Empty } from '@kit/ui'
import type { WorkspaceInfo } from '@shared/types'
import { WorkspaceIcon } from './WorkspaceIcon'

export function ArchivedView({ workspaces, onOpen, onRestore, onDelete }: { workspaces: WorkspaceInfo[]; onOpen: (id: string) => void; onRestore: (w: WorkspaceInfo) => void; onDelete: (w: WorkspaceInfo) => void }) {
  return (
    <div className="h-scroll">
      <div className="sb-page">
        <p className="h-lead">Archived workspaces keep their files, data and conversations. Bring one back to put it in the list again.</p>
        {workspaces.length ? (
          <div className="sb-card">
            {workspaces.map((w) => (
              <div key={w.id} className="h-arch">
                <button className="h-arch-main" onClick={() => onOpen(w.id)} title={`Open ${w.name}`}>
                  <span className="h-icon">
                    <WorkspaceIcon icon={w.icon} color={w.color} />
                  </span>
                  <strong>{w.name}</strong>
                  {w.description && <span className="h-arch-about">{w.description}</span>}
                </button>
                <button className="sb-btn sm ghost" onClick={() => onRestore(w)}>
                  <ArchiveRestore size={14} strokeWidth={1.7} />
                  Unarchive
                </button>
                {!w.home && (
                  <button className="sb-btn sm ghost danger" onClick={() => onDelete(w)}>
                    <Trash2 size={14} strokeWidth={1.7} />
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty title="Nothing is archived">Archive a workspace from the list of workspaces: hover it and press the archive button.</Empty>
        )}
      </div>
    </div>
  )
}

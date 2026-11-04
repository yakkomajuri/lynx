// What Point's note box, inside a workspace's frame, can @ mention: the same workspaces and connectors
// as the agent's message box. The frame draws plain DOM, so each comes with its icon already drawn.
import { useEffect, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Globe, Plug, SquareTerminal } from 'lucide-react'
import type { ConnectorState, WorkspaceInfo } from '@shared/types'
import type { PointMention } from '@kit/annotate'
import { WorkspaceIcon } from './WorkspaceIcon'

/** The glyph an added connector shows when it has no site icon. */
export const glyphOf = (c: Pick<ConnectorState, 'url' | 'api'>) => (!c.url ? SquareTerminal : c.api ? Globe : Plug)

/**
 * The mentions, the workspace the frame shows first. They go to `onList` at once, connectors with their
 * glyphs, and again as each site icon comes: a slow site holds up only its own icon. Returns a stop.
 */
export function pointMentions(workspaces: WorkspaceInfo[], connectors: ConnectorState[], here: string, siteIcon: (c: ConnectorState) => Promise<string | null>, onList: (list: PointMention[]) => void) {
  let live = true
  const ws = [...workspaces]
    .sort((a, b) => Number(b.id === here) - Number(a.id === here))
    .map((w): PointMention => ({ kind: 'workspace', id: w.id, name: w.name, svg: renderToStaticMarkup(<WorkspaceIcon icon={w.icon} color={w.color} size={14} />) }))
  const cx = connectors.map((c): PointMention => {
    const Glyph = glyphOf(c)
    return { kind: 'connector', id: c.id, name: c.name, svg: renderToStaticMarkup(<Glyph size={13} strokeWidth={1.8} aria-hidden />) }
  })
  onList([...ws, ...cx])
  connectors.forEach((c, i) =>
    void siteIcon(c)
      .catch(() => null)
      .then((img) => {
        if (!live || !img) return
        cx[i] = { kind: 'connector', id: c.id, name: c.name, img }
        onList([...ws, ...cx])
      }),
  )
  return () => {
    live = false
  }
}

/** The mentions, refreshed as workspaces and connectors change. */
export function usePointMentions(workspaces: WorkspaceInfo[], connectors: ConnectorState[], here: string, siteIcon: (c: ConnectorState) => Promise<string | null>): PointMention[] {
  const shown = workspaces.filter((w) => !w.archived)
  const added = connectors.filter((c) => !c.native)
  const key = JSON.stringify([here, shown.map((w) => [w.id, w.name, w.icon, w.color]), added.map((c) => [c.id, c.name, c.url, c.api ? 1 : 0])])
  const [list, setList] = useState<PointMention[]>([])
  useEffect(() => pointMentions(shown, added, here, siteIcon, setList), [key])
  return list
}

// The workspaces the first-run screen makes from templates: one main template for each connected
// service with an official template on the remote marketplace. Checked without a window.
import { parseOrigin } from '@shared/templates'

/** Each service's main template, and how the screen names the workspace it makes. */
export const MAIN_TEMPLATES: { item: string; label: string }[] = [
  { item: 'github-pulls', label: 'GitHub PRs' },
  { item: 'posthog-web-analytics', label: 'PostHog' },
  { item: 'stripe-payments', label: 'Stripe payments' },
  { item: 'linear-team-issues', label: 'Linear issues' },
  { item: 'sentry-issues', label: 'Sentry issues' },
  { item: 'granola-notes', label: 'Granola notes' },
  { item: 'mercury-home', label: 'Mercury' },
  { item: 'oneleet-soc2', label: 'SOC 2 with Oneleet' },
  { item: 'deepwiki', label: 'DeepWiki' },
  { item: 'research', label: 'Exa research' },
]

interface Requirement {
  alias: string
  url?: string
  optional?: boolean
}
interface Item {
  id: string
  name: string
  source: string
  creator: string
  requires: Requirement[]
}
interface Connector {
  id: string
  name: string
  url?: string
  status: string
  native?: boolean
}
interface Workspace {
  origin?: string
}
export interface Planned {
  item: string
  label: string
  /** The service it is for, by its connector's name. */
  service: string
  /** alias -> connector, for marketplace_fork. */
  connectors: Record<string, string>
}

const site = (u: string) => {
  try {
    return new URL(u).hostname.split('.').slice(-2).join('.')
  } catch {
    return u
  }
}

/**
 * The workspaces to make: for each connected connector, the main template whose required server is
 * that connector's, once each, and none that is already a workspace. Optional servers it also takes
 * are bound when one of them is connected too.
 */
export function plannedTemplates(connectors: Connector[], items: Item[], workspaces: Workspace[]): Planned[] {
  const connected = connectors.filter((c) => !c.native && c.status === 'connected' && c.url)
  const made = new Set(workspaces.flatMap((w) => w.origin ? [parseOrigin(w.origin).id] : []))
  const out: Planned[] = []
  for (const main of MAIN_TEMPLATES) {
    if (made.has(main.item)) continue
    const item = items.find((i) => i.id === main.item && i.source === 'remote' && i.creator === 'official')
    if (!item) continue
    const needed = item.requires.filter((r) => !r.optional)
    if (!needed.length) continue
    const binding: Record<string, string> = {}
    for (const r of item.requires) {
      const c = r.url ? connected.find((x) => site(x.url!) === site(r.url!)) : undefined
      if (c) binding[r.alias] = c.id
    }
    if (!needed.every((r) => binding[r.alias])) continue
    out.push({ item: item.id, label: main.label, service: connected.find((c) => c.id === binding[needed[0]!.alias])!.name, connectors: binding })
  }
  return out
}

// Finding templates: the connectors each one uses, and the filters the marketplace page and the
// marketplace_list tool share. The remote API filters the same way (see marketplaceApi.ts), so a long
// list can move to the server without the page changing.
import type { AppState, MarketplaceItem, WorkspaceInfo } from './types'

/** Connectors that come with Lynx, by the name a manifest's `uses` gives them. */
const NATIVE: Record<string, string> = { agents: 'Agents', app: 'Lynx' }

export interface TemplateConnector {
  /** What a filter matches on: the server's host, or the name when it has none. */
  key: string
  name: string
  url?: string
  native?: boolean
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^(www|mcp|api)\./, '')
  } catch {
    return url
  }
}

/** The connectors a template needs or calls, each once. */
export function connectorsOf(item: Pick<MarketplaceItem, 'requires' | 'uses'>): TemplateConnector[] {
  const out = new Map<string, TemplateConnector>()
  for (const r of item.requires) {
    const key = r.url ? hostOf(r.url) : r.name.toLowerCase()
    if (!out.has(key)) out.set(key, { key, name: r.name, url: r.url })
  }
  for (const alias of Object.keys(item.uses ?? {})) if (NATIVE[alias] && !out.has(alias)) out.set(alias, { key: alias, name: NATIVE[alias], native: true })
  return [...out.values()]
}

export interface TemplateFilter {
  /** Words in the name, description or tags. */
  q?: string
  /** Every one of these tags. */
  tags?: string[]
  /** A connector's key (connectorsOf). */
  connector?: string
  creator?: MarketplaceItem['creator']
}

export function matches(item: MarketplaceItem, f: TemplateFilter): boolean {
  if (f.creator && item.creator !== f.creator) return false
  if (f.tags?.length && !f.tags.every((t) => item.tags?.includes(t))) return false
  if (f.connector && !connectorsOf(item).some((c) => c.key === f.connector)) return false
  const words = f.q?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []
  const text = `${item.name} ${item.description} ${(item.tags ?? []).join(' ')} ${item.publisher?.handle ?? ''}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

/** The picker matches any choice within a facet, and every active facet. */
export interface TemplateFacets {
  q?: string
  /** Creator groups or exact publisher handles, prefixed with @. */
  creators?: (MarketplaceItem['creator'] | `@${string}`)[]
  connectors?: string[]
  categories?: string[]
}

export function matchesFacets(item: MarketplaceItem, f: TemplateFacets): boolean {
  if (f.creators?.length && !f.creators.some((creator) => creator.startsWith('@') ? !!item.publisher?.handle && item.publisher.handle.toLowerCase() === creator.slice(1).toLowerCase() : creator === item.creator)) return false
  if (f.connectors?.length && !connectorsOf(item).some((c) => f.connectors?.includes(c.key))) return false
  if (f.categories?.length && !f.categories.some((t) => item.tags?.includes(t))) return false
  return matches(item, { q: f.q })
}

/**
 * Where a forked workspace came from, as its `origin` records it: a template id on this machine's shelves,
 * or remote:<id>@<server> for the marketplace. The server is part of it because another server's template
 * of the same id is other code: a workspace only updates from the server it came from.
 */
export const remoteOrigin = (api: string, id: string) => `remote:${id}@${api}`

export function parseOrigin(origin: string): { remote: false; id: string } | { remote: true; id: string; api?: string } {
  if (!origin.startsWith('remote:')) return { remote: false, id: origin }
  // Ids never hold an @, so the first one starts the server's address.
  const rest = origin.slice(7)
  const at = rest.indexOf('@')
  return at < 0 ? { remote: true, id: rest } : { remote: true, id: rest.slice(0, at), api: rest.slice(at + 1) }
}

/** Whether "Update from marketplace" can find the template a workspace came from, with this server set up. */
export const canUpdateFrom = (origin: string | undefined, api: string | null) => {
  if (!origin) return false
  const o = parseOrigin(origin)
  return !o.remote || (!!api && o.api === api)
}

/** Old bundled templates used plain IDs, like private shelf items. Only official remote entries
 * may replace those, and a private item of the same name keeps its existing precedence. */
export function templateForOrigin<T extends { id: string; source: string; creator?: string }>(origin: string | undefined, api: string | null, items: T[]): T | undefined {
  if (!origin || !canUpdateFrom(origin, api)) return
  const o = parseOrigin(origin)
  if (o.remote) return items.find((i) => i.id === o.id && i.source === 'remote')
  return items.find((i) => i.id === o.id && i.source === 'local') ?? (api ? items.find((i) => i.id === o.id && i.source === 'remote' && i.creator === 'official') : undefined)
}

/** Whether the workspace's template is still available from the configured marketplace or shelf. */
export const hasUpdateSource = (origin: string | undefined, api: string | null, items: { id: string; source: string; creator?: string }[]) => !!templateForOrigin(origin, api, items)

/** Whether publishing this workspace will update a listing owned by the current account. */
export function ownedPublication(workspace: WorkspaceInfo, state: Pick<AppState, 'marketplace' | 'remote'>): MarketplaceItem | undefined {
  const { api, account, publishing } = state.remote
  if (!api || !account?.handle) return
  const prior = publishing.filter((s) => s.workspace === workspace.id && s.published && s.publisher?.api === api && s.publisher.email === account.email).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const origin = workspace.origin ? parseOrigin(workspace.origin) : undefined
  const id = prior?.published?.id ?? (origin?.remote && origin.api === api ? origin.id : undefined)
  return state.marketplace.find((item) => item.source === 'remote' && item.id === id && item.publisher?.handle === account.handle)
}

// The transport of a marketplace preview: the item's own UI, with every call answered by its
// preview/mock.js and, where that has nothing to say, by stand-ins for the app: an in-memory store,
// every connector connected, no agents. Nothing in a preview reaches a real connector.
import { setTransport, type WorkspaceMeta } from './core'

type Mock = (connector: string, tool: string, args: Record<string, any>) => unknown

interface Rec {
  key: string
  value: unknown
  created_at: string
  updated_at: string
}

const field = (v: any, path: string) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), v)
const holds = (v: unknown, op: string, want: any) => {
  const a = v as any
  switch (op) {
    case '!=':
      return a !== want
    case '<':
      return a < want
    case '<=':
      return a <= want
    case '>':
      return a > want
    case '>=':
      return a >= want
    case 'in':
      return Array.isArray(want) && want.includes(a)
    default:
      return a === want
  }
}

function stand(meta: WorkspaceMeta, aliases: { alias: string; name: string; url?: string }[]): Mock {
  const db = new Map<string, Map<string, Rec>>()
  const files = new Map<string, { name: string; text?: string; base64?: string; content_type: string; updated_at: string }>()
  const coll = (name: string) => db.get(name) ?? db.set(name, new Map()).get(name)!
  const now = () => new Date().toISOString()
  return (connector, tool, a) => {
    if (connector === 'app') {
      switch (tool) {
        case 'db_get':
          return { value: coll(a.collection).get(a.key)?.value ?? null }
        case 'db_put': {
          const c = coll(a.collection)
          const old = c.get(a.key)
          if (old && a.if_absent) return { ...old, created: false }
          const rec = { key: a.key, value: a.value, created_at: old?.created_at ?? now(), updated_at: now() }
          c.set(a.key, rec)
          return { ...rec, created: !old }
        }
        case 'db_delete':
          return { deleted: coll(a.collection).delete(a.key) }
        case 'db_query': {
          let items = [...coll(a.collection).values()].filter((r) => (!a.prefix || r.key.startsWith(a.prefix)) && (!a.updated_since || r.updated_at >= a.updated_since) && (a.where ?? []).every((w: any) => holds(field(r.value, w.field), w.op ?? '=', w.value)))
          const by = a.order_by ?? 'key'
          const of = (r: Rec) => (by === 'key' || by === 'updated_at' || by === 'created_at' ? (r as any)[by] : field(r.value, by))
          items.sort((x, y) => (of(x) < of(y) ? -1 : of(x) > of(y) ? 1 : 0) * (a.desc ? -1 : 1))
          const offset = a.offset ?? 0
          const limit = Math.min(a.limit ?? 100, 1000)
          return { items: items.slice(offset, offset + limit), more: items.length > offset + limit }
        }
        case 'db_collections':
          return { collections: [...db].map(([name, c]) => ({ name, count: c.size })) }
        case 'files_put':
          files.set(a.name, { name: a.name, text: a.text, base64: a.base64, content_type: a.content_type ?? 'text/plain', updated_at: now() })
          return { name: a.name }
        case 'files_get': {
          const f = files.get(a.name)
          if (!f) throw new Error(`No file named ${a.name}`)
          return { ...f, size: (f.text ?? f.base64 ?? '').length }
        }
        case 'files_list':
          return { files: [...files.values()].filter((f) => !a.prefix || f.name.startsWith(a.prefix)).map((f) => ({ name: f.name, size: (f.text ?? f.base64 ?? '').length, content_type: f.content_type, updated_at: f.updated_at })) }
        case 'files_delete':
          return { deleted: files.delete(a.name) }
        case 'connector_list':
          return { connectors: aliases.map((r) => ({ id: meta.connectors[r.alias], name: r.name, status: 'connected', url: r.url ?? '', tool_count: 1, native: false })) }
        case 'notification_list':
          return { notifications: [] }
        case 'notification_send':
        case 'notification_read':
        case 'notification_delete':
          return { ok: true }
      }
      return undefined
    }
    if (connector === 'agents') {
      if (tool === 'session_list') return { items: [], next_cursor: null, has_more: false }
      if (tool === 'server_status') return { providers: [], supervisor: null }
      throw new Error('Agents do not run in a preview. Create a workspace from the template to use them.')
    }
    if (connector === 'tools') return {}
    return undefined
  }
}

/** Installed before the item's own modules run, so their first call already goes to the mock. */
export function installPreview(mock: Mock | undefined, item: { id: string; name: string; requires: { alias: string; name: string; url?: string }[] }) {
  const meta: WorkspaceMeta = { id: `preview-${item.id}`, name: item.name, dir: '/preview', connectors: Object.fromEntries(item.requires.map((r) => [r.alias, r.alias])) }
  const fallback = stand(meta, item.requires)
  // A tile in the marketplace's grid is only to look at. A page that focuses something as it loads
  // (chat's composer) would take the keyboard from the window, and one that scrolls something into view
  // would scroll the grid along with it: either way the window jumps to the tile.
  const tile = new URLSearchParams(location.search).has('tile')
  if (tile) {
    HTMLElement.prototype.focus = () => undefined
    Element.prototype.scrollIntoView = () => undefined
  }
  setTransport({
    workspace: meta,
    // The frame sits inside the marketplace, which has nothing to do with what a workspace asks of the
    // window. Only the app's shortcuts go up, so they work from inside the template's page as anywhere else.
    post: (type, payload) => void ((type === 'ready' || type === 'shortcut') && !tile && window.parent.postMessage({ sb: 1, type, ...payload }, '*')),
    call: async (connector, tool, args) => {
      const own = mock ? await mock(connector, tool, args ?? {}) : undefined
      if (own !== undefined) return own
      const std = fallback(connector, tool, args ?? {})
      if (std !== undefined) return std
      throw new Error(`The preview has no data for ${connector}.${tool}`)
    },
  })
}

// Notifications: short messages addressed to a workspace. Whatever notices something worth the
// user's attention (a scheduled tool, an agent, a workspace's own UI) sends one; the window shows
// how many are unread beside the workspace and lists them in a drawer. Each may carry a link to
// the page of the workspace it is about.
import { Context, Effect, Layer } from 'effect'
import type { AppNotification } from '@shared/types'
import { Data } from './Data'
import { Events } from './Events'

const KEEP = 500
export const MAX_TEXT = 500

export interface NotificationsShape {
  readonly send: (input: { workspace: string; text: string; link?: string; by: string }) => AppNotification
  readonly list: (filter?: { workspace?: string; unread?: boolean; limit?: number }) => AppNotification[]
  /** One by id, all of a workspace, or with neither every one. Returns how many changed. */
  readonly markRead: (which?: { id?: number; workspace?: string }) => number
  readonly remove: (which?: { id?: number; workspace?: string }) => number
  /** Hears each one as it is sent (the background service shows it on the desktop when no window is open). */
  readonly listen: (f: (n: AppNotification) => void) => () => void
}

export class Notifications extends Context.Service<Notifications, NotificationsShape>()('Notifications') {}

/** A link is a page of the workspace, or a web address. Anything else is refused rather than guessed at. */
export function cleanLink(link: unknown): string | undefined {
  if (link === undefined || link === null || link === '') return undefined
  const text = String(link).trim()
  if (text.length > 2000) throw new Error('link is too long')
  if (/^https?:\/\/\S+$/i.test(text)) return text
  if (/^\/(?!\/)\S*$/.test(text)) return text
  throw new Error(`link must be a page of the workspace starting with "/" (for example "/prs/42") or an http(s) address; got "${text.slice(0, 80)}"`)
}

export const NotificationsLive = Layer.effect(Notifications)(
  Effect.gen(function* () {
    const { sql } = yield* Data
    const events = yield* Events
    const changed = () => Effect.runSync(events.changed)
    const listeners = new Set<(n: AppNotification) => void>()

    sql.exec(`
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, text TEXT NOT NULL, link TEXT, by TEXT NOT NULL, at TEXT NOT NULL, read_at TEXT);
      CREATE INDEX IF NOT EXISTS notifications_workspace ON notifications (workspace, id);
    `)
    const view = (r: any): AppNotification => ({ id: r.id, workspace: r.workspace, text: r.text, ...(r.link ? { link: r.link } : {}), by: r.by, at: r.at, read: !!r.read_at })
    const where = (which: { id?: number; workspace?: string } = {}) => {
      // With both, the notification must be that workspace's: a caller allowed one workspace cannot reach another's by id.
      if (which.id !== undefined && which.workspace !== undefined) return { clause: 'WHERE id = ? AND workspace = ?', args: [Number(which.id), String(which.workspace)] }
      if (which.id !== undefined) return { clause: 'WHERE id = ?', args: [Number(which.id)] }
      if (which.workspace !== undefined) return { clause: 'WHERE workspace = ?', args: [String(which.workspace)] }
      return { clause: '', args: [] as (string | number)[] }
    }

    return Notifications.of({
      send: (input) => {
        const text = String(input.text ?? '').trim()
        if (!text) throw new Error('A notification needs text')
        if (text.length > MAX_TEXT) throw new Error(`A notification is at most ${MAX_TEXT} characters (this one is ${text.length}); say the short version and link to the rest`)
        const link = cleanLink(input.link)
        const { lastInsertRowid } = sql.prepare('INSERT INTO notifications (workspace, text, link, by, at) VALUES (?, ?, ?, ?, ?)').run(input.workspace, text, link ?? null, input.by, new Date().toISOString())
        sql.prepare('DELETE FROM notifications WHERE id <= ? - ?').run(Number(lastInsertRowid), KEEP)
        changed()
        const sent = view(sql.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(lastInsertRowid)))
        for (const l of listeners) l(sent)
        return sent
      },
      list: (filter = {}) => {
        const clauses = [filter.workspace !== undefined ? 'workspace = ?' : '', filter.unread ? 'read_at IS NULL' : ''].filter(Boolean)
        const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 100)), KEEP)
        return (sql.prepare(`SELECT * FROM notifications ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...(filter.workspace !== undefined ? [filter.workspace] : []), limit) as any[]).map(view)
      },
      markRead: (which) => {
        const { clause, args } = where(which)
        const n = Number(sql.prepare(`UPDATE notifications SET read_at = ? ${clause ? `${clause} AND` : 'WHERE'} read_at IS NULL`).run(new Date().toISOString(), ...args).changes)
        if (n) changed()
        return n
      },
      remove: (which) => {
        const { clause, args } = where(which)
        const n = Number(sql.prepare(`DELETE FROM notifications ${clause}`).run(...args).changes)
        if (n) changed()
        return n
      },
      listen: (f) => {
        listeners.add(f)
        return () => listeners.delete(f)
      },
    })
  }),
)

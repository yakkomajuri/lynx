// One store for the whole app: JSON records in named collections, and files. It is global on
// purpose: workspaces, custom tools and agents all read and write the same data, and keep out of
// each other's way by how they name collections.
//
// Every write is also appended to a log, in the same transaction, with who made it. The current
// state is what the log adds up to, so any moment inside the retention window can be read or
// restored, for one key, one collection or everything. File contents are stored by hash; the log
// holds name -> hash, which gives files the same history.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Effect, Layer } from 'effect'
import { Config } from './Config'

export const RETENTION_DAYS = 30
const MAX_VALUE_BYTES = 1_000_000
const MAX_FILE_BYTES = 25_000_000

export interface DbRecord {
  key: string
  value: unknown
  created_at: string
  updated_at: string
}
export type WhereOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'in'
export interface QueryInput {
  collection: string
  where?: { field: string; op?: WhereOp; value: unknown }[]
  /** Keys starting with this. */
  prefix?: string
  /** `key`, `updated_at`, `created_at`, or a field of the value ("author.login"). */
  order_by?: string
  desc?: boolean
  limit?: number
  offset?: number
  updated_since?: string
}
export interface Version {
  at: string
  by: string
  /** Absent when this entry is a deletion. */
  value?: unknown
  deleted?: true
}
export interface FileMeta {
  name: string
  size: number
  content_type: string
  updated_at: string
}

export interface DataShape {
  /** The database itself, for the services that keep their own tables beside the store (runs, schedules). */
  readonly sql: DatabaseSync
  readonly get: (collection: string, key: string, at?: string) => unknown
  readonly put: (collection: string, key: string, value: unknown, opts: { ifAbsent?: boolean; by: string }) => { created: boolean; value: unknown }
  readonly remove: (collection: string, key: string, by: string) => boolean
  readonly query: (q: QueryInput) => { items: DbRecord[]; more: boolean }
  readonly collections: () => { collection: string; count: number; updated_at: string }[]
  readonly history: (collection: string, key: string, limit?: number) => Version[]
  /** Put records back as they were at `at`. Without a collection, every collection; with a key, that record only. */
  readonly restore: (input: { at: string; collection?: string; key?: string; by: string }) => { changed: number }
  readonly filePut: (name: string, data: Buffer, contentType: string | undefined, by: string) => FileMeta
  readonly fileGet: (name: string, at?: string) => (FileMeta & { data: Buffer }) | null
  readonly fileList: (prefix?: string) => FileMeta[]
  readonly fileRemove: (name: string, by: string) => boolean
  readonly fileHistory: (name: string, limit?: number) => Version[]
  readonly fileRestore: (input: { at: string; name?: string; by: string }) => { changed: number }
}

export class Data extends Context.Service<Data, DataShape>()('Data') {}

const DB = 'db'
const FILE = 'file'
const FIELD = /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/
const OPS: Record<WhereOp, string> = { '=': '=', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=', in: 'IN' }
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-ndjson|yaml))|\+(json|xml)$/
export const isTextual = (contentType: string) => TEXTUAL.test(contentType)

const name = (what: string, v: unknown, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) throw new Error(`${what} must be a non-empty string of at most ${max} characters`)
  return v
}
const moment = (at: unknown) => {
  const d = new Date(String(at))
  if (typeof at !== 'string' || Number.isNaN(d.getTime())) throw new Error('at must be a date and time, e.g. "2026-10-11T09:30:00Z"')
  return d.toISOString()
}

/** Open (or create) the store in `dir`. Separate from the layer so it can be exercised without the app. */
export function openData(dir: string, opts: { retentionDays?: number } = {}): DataShape & { close: () => void } {
  mkdirSync(dir, { recursive: true })
  const blobs = join(dir, 'blobs')
  mkdirSync(blobs, { recursive: true })
  const sql = new DatabaseSync(join(dir, 'data.db'))
  sql.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (space TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (space, collection, key)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, space TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT, by TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS log_key ON log (space, collection, key, seq);
    CREATE INDEX IF NOT EXISTS log_at ON log (at);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
  `)
  const one = <T>(q: string, ...p: any[]) => sql.prepare(q).get(...p) as T | undefined
  const all = <T>(q: string, ...p: any[]) => sql.prepare(q).all(...p) as T[]
  const run = (q: string, ...p: any[]) => sql.prepare(q).run(...p)
  const tx = <A>(f: () => A): A => {
    sql.exec('BEGIN IMMEDIATE')
    try {
      const out = f()
      sql.exec('COMMIT')
      return out
    } catch (e) {
      sql.exec('ROLLBACK')
      throw e
    }
  }

  // Log times never go backwards, whatever the system clock does: "as it was at T" is then always
  // a prefix of the log, and the newest entry at or before T is simply the highest seq there.
  let last = one<{ at: string }>('SELECT max(at) at FROM log')?.at ?? ''
  const stamp = () => {
    const now = new Date().toISOString()
    return (last = now > last ? now : last)
  }

  /** The one write path. `value: null` deletes. */
  const write = (space: string, collection: string, key: string, value: string | null, by: string) => {
    const at = stamp()
    run('INSERT INTO log (at, space, collection, key, value, by) VALUES (?, ?, ?, ?, ?, ?)', at, space, collection, key, value, by)
    if (value === null) run('DELETE FROM records WHERE space = ? AND collection = ? AND key = ?', space, collection, key)
    else run('INSERT INTO records (space, collection, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', space, collection, key, value, at, at)
    return at
  }
  const current = (space: string, collection: string, key: string) => one<{ value: string; created_at: string; updated_at: string }>('SELECT value, created_at, updated_at FROM records WHERE space = ? AND collection = ? AND key = ?', space, collection, key)
  const horizon = () => one<{ v: string }>("SELECT v FROM meta WHERE k = 'pruned_before'")?.v ?? ''
  const within = (at: string) => {
    if (at < horizon()) throw new Error(`History is kept for ${opts.retentionDays ?? RETENTION_DAYS} days; ${at} is older than that`)
    return at
  }
  const asOf = (space: string, collection: string, key: string, at: string) => one<{ value: string | null; at: string }>('SELECT value, at FROM log WHERE space = ? AND collection = ? AND key = ? AND at <= ? ORDER BY seq DESC LIMIT 1', space, collection, key, within(at))

  const versions = (space: string, collection: string, key: string, limit = 50): Version[] =>
    all<{ at: string; by: string; value: string | null }>('SELECT at, by, value FROM log WHERE space = ? AND collection = ? AND key = ? ORDER BY seq DESC LIMIT ?', space, collection, key, Math.min(Math.max(1, Math.floor(limit)), 500)).map((v) => (v.value === null ? { at: v.at, by: v.by, deleted: true } : { at: v.at, by: v.by, value: JSON.parse(v.value) }))

  const restore = (space: string, at: string, collection: string | undefined, key: string | undefined, by: string) =>
    tx(() => {
      const scope = [space, ...(collection === undefined ? [] : [collection]), ...(key === undefined ? [] : [key])]
      const where = `space = ?${collection === undefined ? '' : ' AND collection = ?'}${key === undefined ? '' : ' AND key = ?'}`
      const then = new Map<string, { collection: string; key: string; value: string | null }>()
      for (const r of all<{ collection: string; key: string; value: string | null }>(`SELECT l.collection, l.key, l.value FROM log l JOIN (SELECT max(seq) seq FROM log WHERE ${where} AND at <= ? GROUP BY collection, key) m ON l.seq = m.seq`, ...scope, within(at))) then.set(`${r.collection}\n${r.key}`, r)
      // Anything there now that did not exist then goes too.
      for (const r of all<{ collection: string; key: string }>(`SELECT collection, key FROM records WHERE ${where}`, ...scope)) if (!then.has(`${r.collection}\n${r.key}`)) then.set(`${r.collection}\n${r.key}`, { ...r, value: null })
      let changed = 0
      for (const r of then.values()) {
        if ((current(space, r.collection, r.key)?.value ?? null) === r.value) continue
        write(space, r.collection, r.key, r.value, by)
        changed++
      }
      return { changed }
    })

  // ── files: contents by hash on disk, name -> hash in the store
  const blob = (hash: string) => join(blobs, hash)
  const fileMeta = (key: string, value: string, updated_at: string): FileMeta & { hash: string } => ({ name: key, updated_at, ...(JSON.parse(value) as { hash: string; size: number; content_type: string }) })

  // ── retention: keep everything inside the window, and for each key the one entry that says how
  // it stood when the window began.
  const prune = () => {
    const before = new Date(Date.now() - (opts.retentionDays ?? RETENTION_DAYS) * 86400000).toISOString()
    tx(() => {
      run('DELETE FROM log WHERE at < ? AND seq NOT IN (SELECT max(seq) FROM log WHERE at < ? GROUP BY space, collection, key)', before, before)
      // What is left from before the window is the latest per key; a deletion there says nothing "absent" does not.
      run('DELETE FROM log WHERE at < ? AND value IS NULL', before)
      run("INSERT INTO meta (k, v) VALUES ('pruned_before', ?) ON CONFLICT DO UPDATE SET v = excluded.v", before)
    })
    const kept = new Set(all<{ hash: string }>("SELECT DISTINCT json_extract(value, '$.hash') hash FROM log WHERE space = ? AND value IS NOT NULL", FILE).map((r) => r.hash))
    for (const f of readdirSync(blobs)) if (!kept.has(f)) unlinkSync(blob(f))
  }
  prune()
  const pruning = setInterval(prune, 6 * 3600000)
  pruning.unref()

  return {
    sql,
    close: () => {
      clearInterval(pruning)
      sql.close()
    },
    get: (collection, key, at) => {
      const v = at === undefined ? current(DB, name('collection', collection), name('key', key))?.value : asOf(DB, name('collection', collection), name('key', key), moment(at))?.value
      return v ? JSON.parse(v) : null
    },
    put: (collection, key, value, o) => {
      if (value === undefined || value === null) throw new Error('value must be JSON and not null; use db_delete to remove a record')
      const text = JSON.stringify(value)
      if (Buffer.byteLength(text) > MAX_VALUE_BYTES) throw new Error(`A record can be at most ${MAX_VALUE_BYTES / 1e6} MB; store larger content as a file`)
      return tx(() => {
        const had = current(DB, name('collection', collection), name('key', key))
        if (had && o.ifAbsent) return { created: false, value: JSON.parse(had.value) }
        if (had?.value !== text) write(DB, collection, key, text, o.by)
        return { created: !had, value }
      })
    },
    remove: (collection, key, by) =>
      tx(() => {
        if (!current(DB, name('collection', collection), name('key', key))) return false
        write(DB, collection, key, null, by)
        return true
      }),
    query: (q) => {
      const params: any[] = [DB, name('collection', q.collection)]
      let where = 'space = ? AND collection = ?'
      if (q.prefix) {
        where += " AND key LIKE ? ESCAPE '\\'"
        params.push(`${String(q.prefix).replace(/[\\%_]/g, '\\$&')}%`)
      }
      if (q.updated_since) {
        where += ' AND updated_at >= ?'
        params.push(moment(q.updated_since))
      }
      const path = (field: unknown) => {
        if (typeof field !== 'string' || !FIELD.test(field)) throw new Error(`Bad field "${String(field)}": use a name or a dotted path such as "author.login"`)
        return `$.${field}`
      }
      // json_extract gives SQL values: booleans come out as 1 and 0.
      const bind = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v))
      for (const w of q.where ?? []) {
        const op = OPS[w.op ?? '=']
        if (!op) throw new Error(`Unknown operator "${String(w.op)}": use =, !=, <, <=, >, >= or in`)
        params.push(path(w.field))
        if (w.value === null) where += ` AND json_extract(value, ?) IS ${op === '!=' ? 'NOT ' : ''}NULL`
        else if (op === 'IN') {
          if (!Array.isArray(w.value) || !w.value.length) throw new Error('"in" takes a non-empty list')
          where += ` AND json_extract(value, ?) IN (${w.value.map(() => '?').join(', ')})`
          params.push(...w.value.map(bind))
        } else {
          where += ` AND json_extract(value, ?) ${op} ?`
          params.push(bind(w.value))
        }
      }
      let order = 'key'
      if (q.order_by === 'updated_at' || q.order_by === 'created_at') order = q.order_by
      else if (q.order_by && q.order_by !== 'key') {
        order = 'json_extract(value, ?)'
        params.push(path(q.order_by))
      }
      const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 100)), 1000)
      const rows = all<{ key: string; value: string; created_at: string; updated_at: string }>(`SELECT key, value, created_at, updated_at FROM records WHERE ${where} ORDER BY ${order} ${q.desc ? 'DESC' : 'ASC'}, key LIMIT ? OFFSET ?`, ...params, limit + 1, Math.max(0, Math.floor(q.offset ?? 0)))
      return { items: rows.slice(0, limit).map((r) => ({ ...r, value: JSON.parse(r.value) })), more: rows.length > limit }
    },
    collections: () => all('SELECT collection, count(*) count, max(updated_at) updated_at FROM records WHERE space = ? GROUP BY collection ORDER BY collection', DB),
    history: (collection, key, limit) => versions(DB, name('collection', collection), name('key', key), limit),
    restore: (i) => restore(DB, moment(i.at), i.collection === undefined ? undefined : name('collection', i.collection), i.key === undefined ? undefined : name('key', i.key), i.by),

    filePut: (file, data, contentType, by) => {
      if (data.byteLength > MAX_FILE_BYTES) throw new Error(`A file can be at most ${MAX_FILE_BYTES / 1e6} MB`)
      const hash = createHash('sha256').update(data).digest('hex')
      if (!existsSync(blob(hash))) writeFileSync(blob(hash), data)
      const value = JSON.stringify({ hash, size: data.byteLength, content_type: contentType || 'application/octet-stream' })
      return tx(() => {
        const had = current(FILE, '', name('name', file, 300))
        const at = had?.value === value ? had.updated_at : write(FILE, '', file, value, by)
        const { hash: _h, ...meta } = fileMeta(file, value, at)
        return meta
      })
    },
    fileGet: (file, at) => {
      const row = at === undefined ? current(FILE, '', name('name', file, 300)) : asOf(FILE, '', name('name', file, 300), moment(at))
      if (!row?.value) return null
      const { hash, ...meta } = fileMeta(file, row.value, 'updated_at' in row ? row.updated_at : row.at)
      return { ...meta, data: readFileSync(blob(hash)) }
    },
    fileList: (prefix) =>
      all<{ key: string; value: string; updated_at: string }>("SELECT key, value, updated_at FROM records WHERE space = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT 5000", FILE, `${String(prefix ?? '').replace(/[\\%_]/g, '\\$&')}%`).map((r) => {
        const { hash: _h, ...meta } = fileMeta(r.key, r.value, r.updated_at)
        return meta
      }),
    fileRemove: (file, by) =>
      tx(() => {
        if (!current(FILE, '', name('name', file, 300))) return false
        write(FILE, '', file, null, by)
        return true
      }),
    fileHistory: (file, limit) => versions(FILE, '', name('name', file, 300), limit).map((v) => (v.value ? { ...v, value: (({ hash: _h, ...m }) => m)(v.value as { hash: string }) } : v)),
    fileRestore: (i) => restore(FILE, moment(i.at), '', i.name === undefined ? undefined : name('name', i.name, 300), i.by),
  }
}

export const DataLive = Layer.effect(Data)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const data = openData(join(cfg.dataDir, 'data'))
    yield* Effect.addFinalizer(() => Effect.sync(() => data.close()))
    return Data.of(data)
  }),
)

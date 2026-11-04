// Store: what workspaces, tools and agents keep, laid out like a database browser.
// Records: collections down the side, the open one as a table whose columns are the stored JSON's
// own fields, and a drawer with the whole record. Files: one table with download and delete.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, Braces, Brackets, Calendar, CaseSensitive, Check, ChevronLeft, ChevronRight, CircleSlash, Copy, Database, Download, File, FileImage, FileText, Hash, Pencil, RefreshCw, Search, SearchX, Shapes, Table2, ToggleLeft, Trash2 } from 'lucide-react'
import { call, useTool } from '@kit/core'
import { Code, rel } from '@kit/ui'
import type { AppState } from '@shared/types'
import { Drawer, DrawerSection, Page } from './Page'

interface Collection {
  collection: string
  count: number
  updated_at: string
}
interface Record_ {
  key: string
  value: unknown
  updated_at: string
}
interface FileMeta {
  name: string
  size: number
  content_type: string
  updated_at: string
}
type Kind = 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'null' | 'mixed'
interface Column {
  field: string
  kind: Kind
}
type Sort = { field: string; desc: boolean }

const PAGE = 50
/** The column for values that are not objects, shown whole. */
const WHOLE = '\u0000value'
const MISSING = Symbol('missing')
const KIND_ICON = { string: CaseSensitive, number: Hash, boolean: ToggleLeft, date: Calendar, object: Braces, array: Brackets, null: CircleSlash, mixed: Shapes }

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v))
const kindOf = (v: unknown): Kind => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v === 'string' ? (isDate(v) ? 'date' : 'string') : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'mixed')
const cell = (value: unknown, field: string): unknown => {
  if (field === WHOLE) return isObject(value) ? MISSING : value
  if (isObject(value) && field in value) return value[field]
  const dot = field.indexOf('.')
  if (dot < 0 || !isObject(value)) return MISSING
  const parent = value[field.slice(0, dot)]
  return isObject(parent) && field.slice(dot + 1) in parent ? parent[field.slice(dot + 1)] : MISSING
}

/** The columns of what is on screen: each top-level field in the order it first appears, typed by its
 *  values. A field that is always a small object gets a column per field of it instead, one level down. */
function columnsOf(records: Record_[]): Column[] {
  // Values that are not objects (a string, a list) show whole, in a column of their own.
  const loose = records.filter((r) => !isObject(r.value)).map((r) => kindOf(r.value))
  const whole: Column[] = loose.length ? [{ field: WHOLE, kind: merge(loose) }] : []
  const seen = new Map<string, unknown[]>()
  for (const r of records) if (isObject(r.value)) for (const [k, v] of Object.entries(r.value)) seen.set(k, [...(seen.get(k) ?? []), v])
  return [...whole, ...[...seen].flatMap(([field, values]): Column[] => {
    const objects = values.filter(isObject)
    const inner = [...new Set(objects.flatMap((o) => Object.keys(o)))]
    if (objects.length && objects.length === values.filter((v) => v !== null && v !== undefined).length && inner.length && inner.length <= 6)
      return inner.map((k) => ({ field: `${field}.${k}`, kind: merge(objects.map((o) => kindOf(o[k]))) }))
    return [{ field, kind: merge(values.map(kindOf)) }]
  })]
}
function merge(kinds: Kind[]): Kind {
  const real = new Set(kinds.filter((k) => k !== 'null'))
  return real.size === 0 ? 'null' : real.size === 1 ? [...real][0]! : 'mixed'
}

/** One stored value, drawn for its type. `wrap` is the drawer's reading mode: text wraps and nested values show whole. */
function Cell({ value, wrap }: { value: unknown; wrap?: boolean }) {
  if (value === MISSING) return <span className="h-st-none">—</span>
  if (value === null || value === undefined) return <span className="h-st-lit">null</span>
  if (typeof value === 'boolean') return <span className={cx('h-st-bool', value ? 'yes' : 'no')}>{value ? 'TRUE' : 'FALSE'}</span>
  if (typeof value === 'number') return <span className="h-st-num">{String(value)}</span>
  if (typeof value === 'string') {
    if (value === '') return <span className="h-st-lit">""</span>
    if (isDate(value)) {
      const d = new Date(value)
      return (
        <time dateTime={value} title={value}>
          {/^\d{4}-\d{2}-\d{2}$/.test(value) ? d.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' }) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      )
    }
    return <span className={wrap ? 'h-st-wrap' : undefined} title={!wrap && value.length > 40 ? value : undefined}>{value}</span>
  }
  if (wrap) return <pre className="h-st-pre">{JSON.stringify(value, null, 2)}</pre>
  if (Array.isArray(value) && value.length && value.length <= 4 && value.every((v) => typeof v === 'string' || typeof v === 'number'))
    return (
      <span className="h-st-chips">
        {value.map((v, i) => (
          <span key={i}>{String(v)}</span>
        ))}
      </span>
    )
  const Icon = Array.isArray(value) ? Brackets : Braces
  const preview = Array.isArray(value) ? count(value.length, 'item') : Object.keys(value as object).slice(0, 4).join(', ') + (Object.keys(value as object).length > 4 ? ', …' : '')
  return (
    <span className="h-st-nested">
      <Icon size={12} strokeWidth={1.75} />
      <span>{preview || 'empty'}</span>
    </span>
  )
}

const label = (field: string) => (field === WHOLE ? 'value' : field)

function Header({ text, icon, numeric, sort, field, onSort }: { text: string; icon?: ReactNode; numeric?: boolean; sort: Sort; field?: string; onSort: (field: string) => void }) {
  const on = field !== undefined && sort.field === field
  const inner = (
    <span className={cx('h-st-th', numeric && 'num')}>
      {icon}
      <span>{text.includes('.') ? (<><i>{text.slice(0, text.indexOf('.') + 1)}</i>{text.slice(text.indexOf('.') + 1)}</>) : text}</span>
      {on && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
    </span>
  )
  return <th>{field === undefined ? inner : <button onClick={() => onSort(field)}>{inner}</button>}</th>
}

function Records({ collection, total, picked, onPick, version }: { collection: string; total: number; picked: string | null; onPick: (r: Record_) => void; version: number }) {
  const [text, setText] = useState('')
  const [prefix, setPrefix] = useState('')
  const [sort, setSort] = useState<Sort>({ field: 'updated_at', desc: true })
  const [page, setPage] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => (setPrefix(text.trim()), setPage(0)), 250)
    return () => clearTimeout(t)
  }, [text])
  useEffect(() => (setText(''), setPrefix(''), setPage(0), setSort({ field: 'updated_at', desc: true })), [collection])
  const q = useTool<{ items: Record_[]; more: boolean }>('app', 'db_query', { collection, prefix: prefix || undefined, order_by: sort.field, desc: sort.desc, limit: PAGE, offset: page * PAGE }, { staleMs: 0 })
  useEffect(() => void q.reload(), [version])
  const records = q.data?.items ?? []
  const columns = columnsOf(records)
  // A field sorts by itself on the server; the key and the time have their own names.
  const onSort = (field: string) => (setPage(0), setSort((s) => (s.field === field ? { field, desc: !s.desc } : { field, desc: field === 'updated_at' })))
  const start = page * PAGE + 1
  return (
    <div className="h-st-main">
      <div className="h-st-bar">
        <div className="h-st-title">
          <h2>{collection}</h2>
          <span>{prefix ? `${count(records.length + page * PAGE, 'record')}${q.data?.more ? '+' : ''} matching` : count(total, 'record')}</span>
          <button className="h-dicon" title="Refresh" aria-label="Refresh" onClick={() => void q.reload()}>
            <RefreshCw size={14} strokeWidth={1.7} className={q.fetching ? 'h-st-spin' : undefined} />
          </button>
        </div>
        <label className="h-st-search">
          <Search size={13} aria-hidden="true" />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Keys starting with…" aria-label="Find records by key" spellCheck={false} />
        </label>
      </div>
      {q.error && !q.data ? (
        <div className="h-st-blank bad">{q.error.message}</div>
      ) : !q.data ? (
        <div className="h-st-skel">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i}>
              {[12, 26, 18, 22].map((w, j) => (
                <span key={j} style={{ width: `${w}%` }} />
              ))}
            </div>
          ))}
        </div>
      ) : !records.length ? (
        <div className="h-st-blank">
          <SearchX size={20} strokeWidth={1.5} />
          {prefix ? 'No key starts with that.' : 'This collection is empty.'}
        </div>
      ) : (
        <div className={cx('h-st-scroll', q.fetching && 'busy')}>
          <table className="h-st-table">
            <thead>
              <tr>
                <Header text="key" sort={sort} field="key" onSort={onSort} />
                {columns.map((c) => {
                  const Icon = KIND_ICON[c.kind]
                  return <Header key={c.field} text={label(c.field)} icon={<Icon size={13} strokeWidth={1.75} aria-label={c.kind} />} numeric={c.kind === 'number'} sort={sort} field={c.field === WHOLE || c.field.includes('.') ? undefined : c.field} onSort={onSort} />
                })}
                <Header text="updated" numeric sort={sort} field="updated_at" onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.key} className={picked === r.key ? 'on' : undefined} onClick={() => onPick(r)}>
                  <td title={r.key}>
                    <div>{r.key}</div>
                  </td>
                  {columns.map((c) => (
                    <td key={c.field} className={c.kind === 'number' ? 'num' : undefined}>
                      <div>
                        <Cell value={cell(r.value, c.field)} />
                      </div>
                    </td>
                  ))}
                  <td className="num">
                    <span className="h-st-when" title={new Date(r.updated_at).toLocaleString()}>
                      {rel(r.updated_at)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {records.length > 0 && (
        <div className="h-st-pager">
          <span>
            {start.toLocaleString()}–{(start + records.length - 1).toLocaleString()}
            {prefix ? '' : ` of ${total.toLocaleString()}`}
          </span>
          <button className="sb-btn sm" disabled={page === 0 || q.fetching} onClick={() => setPage(page - 1)}>
            <ChevronLeft size={14} /> Previous
          </button>
          <button className="sb-btn sm" disabled={!q.data?.more || q.fetching} onClick={() => setPage(page + 1)}>
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

/** The whole record: its fields for reading, the JSON, and editing or deleting it. */
function RecordDrawer({ collection, record, onClose, onChanged }: { collection: string; record: Record_; onClose: () => void; onChanged: (gone?: boolean) => void }) {
  const pretty = JSON.stringify(record.value, null, 2) ?? 'null'
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [draft, setDraft] = useState(pretty)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => (setMode('view'), setDraft(pretty), setError(null)), [record])
  const fields = isObject(record.value) ? Object.entries(record.value) : []
  const save = async () => {
    let value: unknown
    try {
      value = JSON.parse(draft)
    } catch (e) {
      return setError(`Not valid JSON: ${(e as Error).message}`)
    }
    if (value === null) return setError('A record cannot be null. Delete it instead.')
    setBusy(true)
    await call('app', 'db_put', { collection, key: record.key, value }).then(
      () => (setMode('view'), setError(null), onChanged()),
      (e) => setError((e as Error).message),
    )
    setBusy(false)
  }
  const remove = async () => {
    setBusy(true)
    await call('app', 'db_delete', { collection, key: record.key }).then(
      () => onChanged(true),
      (e) => (setError((e as Error).message), setMode('view')),
    )
    setBusy(false)
  }
  return (
    <Drawer eyebrow={collection} title={<code className="h-st-key">{record.key}</code>} meta={<span className="h-pfaint">Updated {rel(record.updated_at)}</span>} onClose={onClose}>
      {error && <p className="h-st-error">{error}</p>}
      {mode === 'edit' ? (
        <DrawerSection title="Value (JSON)">
          <textarea className="sb-input h-st-edit" value={draft} onChange={(e) => (setDraft(e.target.value), setError(null))} spellCheck={false} rows={22} autoFocus />
        </DrawerSection>
      ) : (
        <>
          {fields.length > 0 && (
            <DrawerSection title="Fields">
              <dl className="h-st-fields">
                {fields.map(([k, v]) => (
                  <div key={k}>
                    <dt title={k}>{k}</dt>
                    <dd>
                      <Cell value={v} wrap />
                    </dd>
                  </div>
                ))}
              </dl>
            </DrawerSection>
          )}
          <DrawerSection
            title="JSON"
            actions={
              <button className="sb-btn sm ghost" onClick={() => void navigator.clipboard.writeText(pretty).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
              </button>
            }
          >
            <Code language="json">{pretty}</Code>
          </DrawerSection>
        </>
      )}
      <footer className="h-st-foot">
        {mode === 'delete' ? (
          <>
            <span>Delete this record? The store keeps its history for 30 days.</span>
            <button className="sb-btn sm ghost" disabled={busy} onClick={() => setMode('view')}>
              Cancel
            </button>
            <button className="sb-btn sm danger" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={13} /> Delete record
            </button>
          </>
        ) : mode === 'edit' ? (
          <>
            <span>{draft !== pretty ? 'Unsaved changes' : 'Editing'}</span>
            <button className="sb-btn sm ghost" disabled={busy} onClick={() => (setDraft(pretty), setError(null), setMode('view'))}>
              Cancel
            </button>
            <button className="sb-btn sm primary" disabled={busy || draft === pretty} onClick={() => void save()}>
              Save changes
            </button>
          </>
        ) : (
          <>
            <button className="sb-btn sm ghost h-st-danger" onClick={() => setMode('delete')}>
              <Trash2 size={13} /> Delete
            </button>
            <button className="sb-btn sm" onClick={() => setMode('edit')}>
              <Pencil size={13} /> Edit JSON
            </button>
          </>
        )}
      </footer>
    </Drawer>
  )
}

function RecordsTab({ collections, error, reload }: { collections: Collection[] | undefined; error?: Error; reload: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [find, setFind] = useState('')
  const [picked, setPicked] = useState<Record_ | null>(null)
  const [version, setVersion] = useState(0)
  const list = collections ?? []
  const current = list.find((c) => c.collection === open) ?? list[0]
  useEffect(() => setPicked(null), [current?.collection])
  if (!collections) return <div className="h-st-box h-st-blank">{error ? error.message : 'Loading the store…'}</div>
  if (!list.length || !current)
    return (
      <div className="h-st-empty">
        <span>
          <Database size={16} strokeWidth={1.75} />
        </span>
        <h3>Nothing stored yet</h3>
        <p>Whatever your workspaces, tools and agents keep shows up here, one collection at a time.</p>
        <pre>await db.put('todos', 'todo-1', {'{'} title: 'Ship it' {'}'})</pre>
      </div>
    )
  const needle = find.trim().toLowerCase()
  const shown = list.filter((c) => !needle || c.collection.toLowerCase().includes(needle))
  return (
    <>
      <div className="h-st-box h-st-browser">
        <nav className="h-st-rail" aria-label="Collections">
          <div className="h-st-railhead">
            <h3>Collections</h3>
            <span>{list.length}</span>
          </div>
          {list.length > 8 && (
            <label className="h-st-search h-st-railfind">
              <Search size={12} aria-hidden="true" />
              <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a collection" aria-label="Find a collection" spellCheck={false} />
            </label>
          )}
          <ul>
            {shown.map((c) => (
              <li key={c.collection}>
                <button className={c.collection === current.collection ? 'on' : undefined} aria-current={c.collection === current.collection ? 'true' : undefined} onClick={() => setOpen(c.collection)}>
                  <Table2 size={13} strokeWidth={1.75} />
                  <span title={c.collection}>{c.collection}</span>
                  <small>{c.count.toLocaleString()}</small>
                </button>
              </li>
            ))}
            {!shown.length && <li className="h-st-railnone">No collection matches.</li>}
          </ul>
        </nav>
        <Records collection={current.collection} total={current.count} picked={picked?.key ?? null} onPick={setPicked} version={version} />
      </div>
      {picked && (
        <RecordDrawer
          collection={current.collection}
          record={picked}
          onClose={() => setPicked(null)}
          onChanged={(gone) => {
            setVersion((v) => v + 1)
            reload()
            if (gone) setPicked(null)
            else void call<{ value: unknown }>('app', 'db_get', { collection: current.collection, key: picked.key }).then((r) => setPicked({ ...picked, value: r.value, updated_at: new Date().toISOString() }))
          }}
        />
      )}
    </>
  )
}

const fileIcon = (type: string) => (type.startsWith('image/') ? FileImage : type.startsWith('text/') || /json|xml|javascript|yaml|csv|markdown/.test(type) ? FileText : File)

function FilesTab({ files, error, reload }: { files: FileMeta[] | undefined; error?: Error; reload: () => void }) {
  const [find, setFind] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  if (!files) return <div className="h-st-box h-st-blank">{error ? error.message : 'Loading files…'}</div>
  if (!files.length)
    return (
      <div className="h-st-empty">
        <span>
          <File size={16} strokeWidth={1.75} />
        </span>
        <h3>No files yet</h3>
        <p>Files your workspaces, tools and agents save show up here.</p>
      </div>
    )
  const needle = find.trim().toLowerCase()
  const shown = files.filter((f) => !needle || f.name.toLowerCase().includes(needle))
  const total = files.reduce((n, f) => n + f.size, 0)
  const download = async (f: FileMeta) => {
    setBusy(f.name)
    setFailure(null)
    try {
      const got = await call<{ base64: string }>('app', 'files_get', { name: f.name, encoding: 'base64' })
      const bytes = Uint8Array.from(atob(got.base64), (c) => c.charCodeAt(0))
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([bytes], { type: f.content_type }))
      a.download = f.name.split('/').pop() || f.name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    } catch (e) {
      setFailure((e as Error).message)
    }
    setBusy(null)
  }
  const remove = async (f: FileMeta) => {
    setBusy(f.name)
    setFailure(null)
    await call('app', 'files_delete', { name: f.name }).then(reload, (e) => setFailure((e as Error).message))
    setConfirm(null)
    setBusy(null)
  }
  return (
    <>
      <div className="h-st-filebar">
        <label className="h-st-search">
          <Search size={13} aria-hidden="true" />
          <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a file" aria-label="Find a file" spellCheck={false} />
        </label>
        <span>
          {count(files.length, 'file')} · {size(total)}
        </span>
      </div>
      {failure && <p className="h-st-error">{failure}</p>}
      <div className="h-st-box">
        <table className="h-st-table h-st-files">
          <thead>
            <tr>
              <th>Name</th>
              <th className="wide">Type</th>
              <th className="num">Size</th>
              <th className="wide">Updated</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => {
              const Icon = fileIcon(f.content_type)
              return (
                <tr key={f.name} className="still">
                  <td>
                    <div className="h-st-fname">
                      <Icon size={13} strokeWidth={1.75} />
                      <span title={f.name}>{f.name}</span>
                    </div>
                  </td>
                  <td className="wide h-st-faint">{f.content_type}</td>
                  <td className="num h-st-num">{size(f.size)}</td>
                  <td className="wide h-st-faint" title={new Date(f.updated_at).toLocaleString()}>
                    {rel(f.updated_at)}
                  </td>
                  <td className="h-st-acts">
                    {confirm === f.name ? (
                      <>
                        <button className="sb-btn sm ghost" disabled={busy === f.name} onClick={() => setConfirm(null)}>
                          Cancel
                        </button>
                        <button className="sb-btn sm danger" disabled={busy === f.name} onClick={() => void remove(f)}>
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="h-dicon" title="Download" aria-label={`Download ${f.name}`} disabled={busy === f.name} onClick={() => void download(f)}>
                          <Download size={14} strokeWidth={1.7} />
                        </button>
                        <button className="h-dicon danger" title="Delete" aria-label={`Delete ${f.name}`} onClick={() => setConfirm(f.name)}>
                          <Trash2 size={14} strokeWidth={1.7} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
            {!shown.length && (
              <tr className="still">
                <td colSpan={5} className="h-st-blank">
                  No file matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function StoreView({ state }: { state: AppState }) {
  const store = useTool<{ collections: Collection[] }>('app', 'db_collections', {}, { staleMs: 0, refresh: 10000 })
  const files = useTool<{ files: FileMeta[] }>('app', 'files_list', {}, { staleMs: 0, refresh: 10000 })
  useEffect(() => (void store.reload(), void files.reload()), [state.tools])
  const [tab, setTab] = useState<'records' | 'files'>('records')
  return (
    <Page title="Store" sub="Records and files your workspaces, tools and agents keep. One store for all of them; every change is kept for 30 days." wide fill>
      <div className="h-cx-tabs" role="tablist" aria-label="Store">
        {(['records', 'files'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'records' ? 'Records' : 'Files'}
            <span className="h-cx-count">{t === 'records' ? (store.data?.collections.length ?? '') : (files.data?.files.length ?? '')}</span>
          </button>
        ))}
      </div>
      {tab === 'records' ? <RecordsTab collections={store.data?.collections} error={store.error} reload={() => void store.reload()} /> : <FilesTab files={files.data?.files} error={files.error} reload={() => void files.reload()} />}
    </Page>
  )
}

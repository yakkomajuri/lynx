// Tools: the custom tools every workspace, agent and schedule can call. A list of them; a tool opens
// in the drawer (what it is, its code, its input, its schedules, a box to try it, its runs), and
// Edit, or New tool, opens the workbench: the code on the left, the input and schedules on the right,
// and what the last run returned underneath.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, UIEvent } from 'react'
import { FolderOpen, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useTool } from '@kit/core'
import { highlight } from '@kit/highlight'
import { Code, CopyButton, rel } from '@kit/ui'
import { cronWords } from '@shared/cronWords'
import type { AppState, CustomTool, ToolRun, ToolSchedule } from '@shared/types'
import type { Toast } from './App'
import { app, bridge, call } from './api'
import { IconAction } from './IconAction'
import { Body, Drawer, DrawerSection, Empty, Item, List, Name, Page, Search, SectionHead, Toggle } from './Page'
import { Runs, soon, took } from './Runs'
import { ScheduleForm } from './Schedules'

type ToastFn = (text: string, tone?: Toast['tone']) => void
type Param = { name: string; type: string; description?: string; required: boolean }

const NAME = /^[a-z][a-z0-9_]*$/
const TEMPLATE = `export const description = 'What this tool does, in one line.'
export const input = {
  name: { type: 'string', description: 'Who to greet' },
}

export default async function ({ name = 'world' }) {
  // call('connector', 'tool', { ... }) calls any connector; db.put and db.get keep data in the store.
  return { hello: name }
}
`

/** The input a tool takes, from its JSON Schema. */
export function paramsOf(schema: unknown): Param[] {
  const s = (schema ?? {}) as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
  const required = new Set(s.required ?? [])
  return Object.entries(s.properties ?? {}).map(([name, p]) => ({ name, type: p?.type ?? 'any', description: p?.description, required: required.has(name) }))
}
const signature = (t: CustomTool) => `(${paramsOf(t.inputSchema).map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ')})`
/** A starting point for the arguments box: every required argument, with a value of the right type. */
const example = (t: CustomTool) => {
  const out: Record<string, unknown> = {}
  for (const p of paramsOf(t.inputSchema)) if (p.required) out[p.name] = p.type === 'number' || p.type === 'integer' ? 0 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {} : ''
  return JSON.stringify(out, null, 2)
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How each tool has been doing, from the last couple of hundred runs of any tool. */
function useStats(state: AppState) {
  const recent = useTool<{ runs: ToolRun[] }>('app', 'tool_runs', { limit: 200 }, { staleMs: 0, refresh: 10000 })
  useEffect(() => void recent.reload(), [state.tools, state.schedules])
  return useMemo(() => {
    const by = new Map<string, ToolRun>()
    for (const r of recent.data?.runs ?? []) if (!by.has(r.tool)) by.set(r.tool, r)
    return by
  }, [recent.data])
}

/** The tool's JavaScript as it is on disk, coloured and numbered. */
function Source({ tool }: { tool: CustomTool }) {
  const q = useTool<{ source: string }>('app', 'tool_get', { name: tool.name }, { staleMs: 0 })
  useEffect(() => void q.reload(), [tool.updatedAt])
  if (!q.data) return <div className="h-pnone">{q.error ? q.error.message : 'Loading…'}</div>
  const source = q.data.source.replace(/\n$/, '')
  return (
    <div className="h-source">
      <div className="h-source-head">
        <span>
          {tool.name}.js · {source.split('\n').length} lines
        </span>
        <CopyButton text={source} label="Copy" />
      </div>
      <Code language="javascript" numbered>
        {source}
      </Code>
    </div>
  )
}

type Outcome = { phase: 'idle' } | { phase: 'running' } | { phase: 'error'; message: string; run?: ToolRun } | { phase: 'ok'; ms: number; data: unknown; run?: ToolRun }

/** Call a tool and fetch the run it made, for its logs and calls. */
async function attempt(name: string, args: Record<string, unknown>): Promise<Outcome> {
  const t0 = performance.now()
  const latest = async () => (await app<{ runs: ToolRun[] }>('tool_runs', { tool: name, limit: 1 }).catch(() => ({ runs: [] }))).runs[0]
  try {
    const data = await call('tools', name, args)
    return { phase: 'ok', ms: Math.round(performance.now() - t0), data, run: await latest() }
  } catch (e) {
    return { phase: 'error', message: message(e), run: await latest() }
  }
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  if (outcome.phase === 'idle') return null
  if (outcome.phase === 'running') return <p className="h-pnone">Running…</p>
  const logs = outcome.run?.logs ?? []
  return (
    <div className="h-poutcome">
      {outcome.phase === 'ok' ? (
        <>
          <p>
            <span className="sb-badge good">ok</span> Returned in {took(outcome.run?.ms ?? outcome.ms)}
            {outcome.run && outcome.run.calls.length > 0 && ` · ${outcome.run.calls.length} ${outcome.run.calls.length === 1 ? 'call' : 'calls'}`}
          </p>
          <Code language="json">{JSON.stringify(outcome.data, null, 2) ?? 'undefined'}</Code>
        </>
      ) : (
        <>
          <p>
            <span className="sb-badge bad">failed</span>
          </p>
          <pre className="sb-code h-perror">{outcome.message}</pre>
        </>
      )}
      {logs.length > 0 && <pre className="sb-code">{logs.join('\n')}</pre>}
    </div>
  )
}

/** Arguments as JSON, a Call button, and what came back. */
function TryIt({ tool }: { tool: CustomTool }) {
  const [args, setArgs] = useState(() => example(tool))
  const [outcome, setOutcome] = useState<Outcome>({ phase: 'idle' })
  const run = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(args.trim() || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    } catch {
      return setOutcome({ phase: 'error', message: 'The arguments are a JSON object.' })
    }
    setOutcome({ phase: 'running' })
    setOutcome(await attempt(tool.name, parsed as Record<string, unknown>))
  }
  return (
    <DrawerSection
      title="Try it"
      actions={
        <button className="sb-btn sm primary" onClick={() => void run()} disabled={outcome.phase === 'running' || !!tool.error}>
          <Play size={13} strokeWidth={1.8} />
          Call
        </button>
      }
    >
      <textarea className="sb-input mono h-pargs" aria-label="Arguments as JSON" value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} rows={Math.min(8, Math.max(3, args.split('\n').length))} />
      <p className="h-pnote">This runs the tool for real, with everything it can reach.</p>
      <OutcomeView outcome={outcome} />
    </DrawerSection>
  )
}

/** A tool's schedules, each with a switch, and a way to add one. */
function ToolSchedules({ state, tool, toast, onSchedule }: { state: AppState; tool: string; toast: ToastFn; onSchedule?: (id: string) => void }) {
  const [adding, setAdding] = useState(false)
  const mine = state.schedules.filter((s) => s.tool === tool)
  const act = (f: () => Promise<unknown>) => void f().catch((e) => toast(message(e), 'bad'))
  const toggle = (s: ToolSchedule) => act(() => app('schedule_save', { id: s.id, tool: s.tool, cron: s.cron, args: s.args, enabled: !s.enabled }))
  return (
    <>
      {mine.length > 0 && (
        <div className="h-pmini">
          {mine.map((s) => (
            <div key={s.id}>
              <i className={`sb-dot ${s.running ? 'live' : !s.enabled ? '' : s.lastOk === false ? 'bad' : 'good'}`} />
              {onSchedule ? (
                <button className="h-plink" onClick={() => onSchedule(s.id)} title={s.cron}>
                  {cronWords(s.cron)}
                </button>
              ) : (
                <b title={s.cron}>{cronWords(s.cron)}</b>
              )}
              <span>
                {s.enabled ? `next ${soon(s.nextAt)}` : 'paused'}
                {Object.keys(s.args).length ? ` · ${JSON.stringify(s.args)}` : ''}
              </span>
              <Toggle on={s.enabled} label={s.enabled ? `Pause ${s.id}` : `Resume ${s.id}`} onChange={() => toggle(s)} />
              <IconAction label={`Remove ${s.id}`} danger onClick={() => confirm(`Remove the schedule ${s.id}?`) && act(() => app('schedule_delete', { id: s.id }))}>
                <Trash2 size={14} strokeWidth={1.7} />
              </IconAction>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <ScheduleForm state={state} tool={tool} toast={toast} onDone={() => setAdding(false)} />
      ) : (
        <>
          {!mine.length && <p className="h-pnone">It runs only when something calls it.</p>}
          <button className="sb-btn sm" onClick={() => setAdding(true)}>
            <Plus size={13} strokeWidth={1.8} />
            Add a schedule
          </button>
        </>
      )}
    </>
  )
}

/** Code you can type in, coloured as you type: a transparent textarea over its highlighted copy. */
function CodeEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const back = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const html = useMemo(() => highlight(value + (value.endsWith('\n') ? ' ' : ''), 'javascript') ?? '', [value])
  const lines = value.split('\n').length
  const sync = (e: UIEvent<HTMLTextAreaElement>) => {
    back.current?.scrollTo(e.currentTarget.scrollLeft, e.currentTarget.scrollTop)
    if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
  }
  return (
    <div className="h-editor">
      <div className="h-editor-gutter" ref={gutter} aria-hidden>
        {Array.from({ length: lines }, (_, i) => i + 1).join('\n')}
      </div>
      <div className="h-editor-text">
        <pre ref={back} aria-hidden className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        <textarea
          value={value}
          spellCheck={false}
          aria-label="Code"
          onScroll={sync}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Tab indents instead of leaving the editor.
            if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
              e.preventDefault()
              const t = e.currentTarget
              const { selectionStart: a, selectionEnd: b } = t
              onChange(value.slice(0, a) + '  ' + value.slice(b))
              requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2))
            }
            // Everything else, the run and save keys included, goes on to the workbench.
          }}
        />
      </div>
    </div>
  )
}

/** The workbench: write or change a tool, try it, schedule it. `name` is null for a new one. */
function Workbench({ state, name, toast, onClose, onSaved }: { state: AppState; name: string | null; toast: ToastFn; onClose: () => void; onSaved: (name: string) => void }) {
  const tool = name ? state.tools.find((t) => t.name === name) : undefined
  const q = useTool<{ source: string }>('app', 'tool_get', { name: name ?? '' }, { staleMs: 0, enabled: !!name })
  const [base, setBase] = useState<string | null>(name ? null : '')
  const [draft, setDraft] = useState(name ? '' : TEMPLATE)
  const [newName, setNewName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [rail, setRail] = useState<'input' | 'schedules'>('input')
  const [outcome, setOutcome] = useState<Outcome>({ phase: 'idle' })
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (q.data && base === null) (setBase(q.data.source), setDraft(q.data.source))
  }, [q.data])
  const dirty = base !== null && draft !== base
  const finalName = name ?? newName.trim()
  const nameError = !name && newName.trim() && !NAME.test(newName.trim()) ? 'Lower-case letters, digits and underscores, starting with a letter.' : !name && state.tools.some((t) => t.name === newName.trim()) ? `There is already a tool called ${newName.trim()}.` : null
  const canSave = !!finalName && !nameError && !saving && (dirty || !name)
  const params = paramsOf(tool?.inputSchema)

  const save = async (): Promise<boolean> => {
    if (!canSave) return !!name && !dirty
    setSaving(true)
    try {
      await app('tool_save', { name: finalName, source: draft })
      setBase(draft)
      if (!name) onSaved(finalName)
      else toast(`Saved ${finalName}`, 'good')
      return true
    } catch (e) {
      setOutcome({ phase: 'error', message: message(e) })
      return false
    } finally {
      setSaving(false)
    }
  }
  const run = async () => {
    if (!finalName || nameError || outcome.phase === 'running') return
    if ((dirty || !name) && !(await save())) return
    const args: Record<string, unknown> = {}
    for (const p of params) {
      const raw = (values[p.name] ?? '').trim()
      if (!raw) continue
      if (p.type === 'string') args[p.name] = raw
      else
        try {
          args[p.name] = JSON.parse(raw)
        } catch {
          args[p.name] = raw
        }
    }
    setOutcome({ phase: 'running' })
    setOutcome(await attempt(finalName, args))
  }
  const leave = () => (!dirty || confirm('Leave without saving your changes?')) && onClose()
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.key === 'Enter') (e.preventDefault(), void run())
    else if (e.key.toLowerCase() === 's') (e.preventDefault(), void save())
  }
  const mod = bridge.platform === 'darwin' ? '⌘' : 'Ctrl+'

  return (
    <div className="h-pcard h-wb" onKeyDown={keys}>
      <header className="h-wbhead">
        <button className="sb-btn sm ghost" onClick={leave}>
          Tools
        </button>
        <span className="h-pfaint">/</span>
        {name ? (
          <b className="mono">{name}</b>
        ) : (
          <input className="sb-input mono h-wbname" autoFocus placeholder="tool_name" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Tool name" spellCheck={false} />
        )}
        <span className="h-pfaint h-wbstate">{dirty || !name ? <i className="h-wbdot" title="Unsaved" /> : null}{!name ? 'New tool' : dirty ? 'Unsaved changes' : tool ? `saved ${rel(tool.updatedAt)}` : ''}</span>
        <span className="h-wbsp" />
        <button className="sb-btn sm" onClick={() => void run()} disabled={!finalName || !!nameError || outcome.phase === 'running' || saving} title={dirty || !name ? 'Saves, then runs' : undefined}>
          <Play size={13} strokeWidth={1.8} />
          {dirty || !name ? 'Save and run' : 'Run'}
          <kbd className="h-kbd">{mod}↵</kbd>
        </button>
        <button className="sb-btn sm primary" onClick={() => void save()} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>
      {nameError && <div className="h-wberror">{nameError}</div>}
      {tool?.error && !dirty && <div className="h-wberror">This version does not load: {tool.error.split('\n')[0]}</div>}
      <div className="h-wbmain">
        {base === null ? <div className="h-pnone h-wbloading">{q.error ? q.error.message : 'Loading…'}</div> : <CodeEditor value={draft} onChange={setDraft} />}
        <aside className="h-wbrail">
          <div className="h-wbtabs" role="tablist">
            <button role="tab" aria-selected={rail === 'input'} className={rail === 'input' ? 'on' : ''} onClick={() => setRail('input')}>
              Input
            </button>
            <button role="tab" aria-selected={rail === 'schedules'} className={rail === 'schedules' ? 'on' : ''} onClick={() => setRail('schedules')}>
              Schedules
            </button>
          </div>
          <div className="h-wbpane">
            {rail === 'input' ? (
              !name ? (
                <p className="h-pnone">Save the tool to fill in its input here. The input is what `export const input` says.</p>
              ) : !params.length ? (
                <p className="h-pnone">This tool takes no input.</p>
              ) : (
                params.map((p) => (
                  <label key={p.name} className="h-wbparam">
                    <span>
                      <code>{p.name}</code> <span className="h-pfaint">{p.type}{p.required ? '' : ' · optional'}</span>
                    </span>
                    {p.description && <small>{p.description}</small>}
                    <input className="sb-input mono" value={values[p.name] ?? ''} placeholder="test value" spellCheck={false} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} />
                  </label>
                ))
              )
            ) : name ? (
              <ToolSchedules state={state} tool={name} toast={toast} />
            ) : (
              <p className="h-pnone">Save the tool first, then put it on a schedule.</p>
            )}
          </div>
        </aside>
      </div>
      <div className="h-wbdock">{outcome.phase === 'idle' ? <p className="h-pnone">Run it to see what it returns. {mod}↵ runs, {mod}S saves.</p> : <OutcomeView outcome={outcome} />}</div>
    </div>
  )
}

export function ToolsView({ state, toast, focus, onSchedule }: { state: AppState; toast: ToastFn; /** A tool to open straight away. */ focus?: string; /** Opens a schedule on the Schedules page. */ onSchedule?: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(focus ?? null)
  // The workbench: a tool's name, '' for a new tool, or null when the list is showing.
  const [editing, setEditing] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  useEffect(() => void (focus && setOpen(focus)), [focus])
  const last = useStats(state)
  const act = (f: () => Promise<unknown>) => void f().catch((e) => toast(message(e), 'bad'))
  const schedulesOf = (t: CustomTool) => state.schedules.filter((s) => s.tool === t.name)
  const remove = (t: CustomTool) => confirm(`Delete the tool ${t.name}? Its schedules stay and fail until you remove them or save the tool again.`) && act(() => app('tool_delete', { name: t.name }).then(() => (setOpen(null), toast(`Deleted ${t.name}`))))
  const needle = filter.trim().toLowerCase()
  const tools = state.tools.filter((t) => !needle || t.name.includes(needle) || t.description.toLowerCase().includes(needle))
  const status = (t: CustomTool) => {
    const r = last.get(t.name)
    return t.error ? <span className="sb-badge bad">does not load</span> : schedulesOf(t).some((s) => s.running) ? <span className="sb-badge live">running</span> : !r ? <span className="sb-badge">never run</span> : r.ok ? <span className="sb-badge good">ok</span> : <span className="sb-badge bad">failing</span>
  }
  const scheduled = (t: CustomTool) => {
    const live = schedulesOf(t).filter((s) => s.enabled)
    if (!schedulesOf(t).length) return null
    return <span className="sb-badge h-pwide" title={live.map((s) => s.cron).join(', ')}>{live.length ? cronWords(live[0]!.cron) + (live.length > 1 ? ` +${live.length - 1}` : '') : 'schedule paused'}</span>
  }

  if (editing !== null)
    return (
      <Workbench
        key={editing}
        state={state}
        name={editing || null}
        toast={toast}
        onClose={() => setEditing(null)}
        onSaved={(n) => {
          toast(`Created ${n}`, 'good')
          setEditing(n)
        }}
      />
    )

  const t = state.tools.find((x) => x.name === open)
  const r = t && last.get(t.name)
  const drawer = t && (
    <Drawer
      key={t.name}
      eyebrow="custom tool"
      title={<code>{t.name}</code>}
      meta={
        <>
          {status(t)}
          {scheduled(t) ?? <span className="sb-badge">on demand</span>}
        </>
      }
      actions={
        <IconAction label={`Delete ${t.name}`} danger onClick={() => remove(t)}>
          <Trash2 size={15} strokeWidth={1.7} />
        </IconAction>
      }
      onClose={() => setOpen(null)}
    >
      <DrawerSection title="Description">
        <p className="h-pprose">{t.description || 'No description. Whoever picks a tool from a list will have only its name to go on.'}</p>
      </DrawerSection>
      {t.error ? (
        <DrawerSection title="Does not load">
          <pre className="sb-code h-perror">{t.error}</pre>
        </DrawerSection>
      ) : (
        r &&
        !r.ok && (
          <DrawerSection title={`Last run failed · ${rel(r.startedAt)}`}>
            <pre className="sb-code h-perror">{r.error}</pre>
          </DrawerSection>
        )
      )}
      <DrawerSection
        title={`Code · saved ${rel(t.updatedAt)}`}
        actions={
          <button className="sb-btn sm" onClick={() => setEditing(t.name)}>
            <Pencil size={13} strokeWidth={1.8} />
            Edit
          </button>
        }
      >
        <Source tool={t} />
      </DrawerSection>
      <DrawerSection title="Input">
        {paramsOf(t.inputSchema).length ? (
          <div className="h-pparams">
            {paramsOf(t.inputSchema).map((p) => (
              <div key={p.name}>
                <span>
                  <code>{p.name}</code>
                  <small>
                    {p.type}
                    {p.required ? '' : ' · optional'}
                  </small>
                </span>
                <span>{p.description ?? 'No description.'}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="h-pnone">This tool takes no input.</p>
        )}
      </DrawerSection>
      <DrawerSection title="Schedules">
        <ToolSchedules state={state} tool={t.name} toast={toast} onSchedule={onSchedule} />
      </DrawerSection>
      <TryIt key={t.updatedAt} tool={t} />
      <DrawerSection title="Recent runs">
        <Runs tool={t.name} stamp={r?.id} />
      </DrawerSection>
    </Drawer>
  )

  return (
    <Page
      title="Tools"
      sub="The custom tools your workspaces, agents and schedules can call. Each is a JavaScript file that calls your connectors."
      actions={
        <>
          <button className="sb-btn sm ghost" onClick={() => void bridge.openPath(state.toolsDir)}>
            <FolderOpen size={14} strokeWidth={1.7} />
            Open folder
          </button>
          <button className="sb-btn sm primary" onClick={() => setEditing('')}>
            <Plus size={15} strokeWidth={1.8} />
            New tool
          </button>
        </>
      }
      drawer={drawer}
    >
      <Search value={filter} onChange={setFilter} placeholder="Search tools by name or description" />
      <SectionHead title="Custom tools" hint="Write one here, or ask an agent: “make a tool that checks for new pull requests and run it every ten minutes”." />
      {!state.tools.length ? (
        <Empty>No custom tools yet. Press New tool to write one, or ask an agent in any workspace.</Empty>
      ) : !tools.length ? (
        <Empty>No tool's name or description matches “{filter.trim()}”.</Empty>
      ) : (
        <List>
          {tools.map((x) => (
            <Item
              key={x.name}
              onOpen={() => setOpen(x.name)}
              label={x.name}
              actions={
                <>
                  <IconAction label={`Edit ${x.name}`} onClick={() => setEditing(x.name)}>
                    <Pencil size={14} strokeWidth={1.7} />
                  </IconAction>
                  <IconAction label={`Delete ${x.name}`} danger onClick={() => remove(x)}>
                    <Trash2 size={14} strokeWidth={1.7} />
                  </IconAction>
                </>
              }
            >
              <Name sub={`saved ${rel(x.updatedAt)}`}>{x.name}</Name>
              <Body sub={x.error ? undefined : signature(x)}>{x.error ? <span className="h-pbad">Does not load: {x.error.split('\n')[0]}</span> : x.description || 'No description'}</Body>
              {scheduled(x)}
              {status(x)}
            </Item>
          ))}
        </List>
      )}
    </Page>
  )
}

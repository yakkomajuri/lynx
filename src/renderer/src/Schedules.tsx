// Schedules: everything that runs on its own. Custom tools on a cron (kept by this app), and
// agents started on a schedule (kept by the agent engine), as two lists. A schedule opens in the
// drawer with what it runs and the runs it started; tool schedules can be made and changed there.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Pencil, Plus, Trash2, Zap } from 'lucide-react'
import { useTool } from '@kit/core'
import { rel } from '@kit/ui'
import { cronWords } from '@shared/cronWords'
import type { AppState, ToolSchedule } from '@shared/types'
import type { Toast } from './App'
import { app, call } from './api'
import { IconAction } from './IconAction'
import { Body, Drawer, DrawerSection, Empty, Facts, Item, List, Name, Page, Search, SectionHead, Toggle } from './Page'
import { Runs, soon } from './Runs'

type ToastFn = (text: string, tone?: Toast['tone']) => void
interface AgentSchedule {
  id: string
  name: string
  cron: string | null
  run_at: string | null
  timezone: string
  enabled: boolean
  next_fire_at: string | null
  launch: { prompt?: string; session_id?: string; harness?: string }
}

const exact = (at: string | null) => (at ? new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', month: 'short', day: 'numeric' }) : undefined)
const icon = { size: 15, strokeWidth: 1.7 }
const PRESETS: [string, string][] = [
  ['Every 10 minutes', '*/10 * * * *'],
  ['Every hour', '0 * * * *'],
  ['Every day at 08:00', '0 8 * * *'],
  ['Weekdays at 09:00', '0 9 * * 1-5'],
]

/** Make a schedule for a tool, or change one. */
export function ScheduleForm({ state, tool, schedule, toast, onDone }: { state: AppState; /** Fixed when the form is opened from a tool. */ tool?: string; schedule?: ToolSchedule; toast: ToastFn; onDone: (id?: string) => void }) {
  const tools = state.tools.filter((t) => !t.error)
  const [name, setName] = useState(schedule?.tool ?? tool ?? tools[0]?.name ?? '')
  const [cron, setCron] = useState(schedule?.cron ?? '*/10 * * * *')
  const [args, setArgs] = useState(schedule && Object.keys(schedule.args).length ? JSON.stringify(schedule.args, null, 2) : '{}')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const words = cronWords(cron.trim())
  const save = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(args.trim() || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    } catch {
      return setError('The arguments are a JSON object, like {"repo": "owner/name"}.')
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await app<ToolSchedule>('schedule_save', { id: schedule?.id, tool: name, cron: cron.trim(), args: parsed, enabled: schedule?.enabled ?? true })
      toast(schedule ? 'Schedule saved' : `${name} now runs ${cronWords(saved.cron).toLowerCase()}`, 'good')
      onDone(saved.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="h-pform">
      {!tool && !schedule && (
        <label className="sb-field">
          <span>Tool</span>
          <select className="sb-input" value={name} onChange={(e) => setName(e.target.value)}>
            {tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="sb-field">
        <span>When</span>
        <input className="sb-input mono" value={cron} onChange={(e) => setCron(e.target.value)} spellCheck={false} aria-describedby="h-cron-words" />
        <small id="h-cron-words">{words !== cron.trim() ? words : 'Five fields, local time: minute hour day month weekday. Six with seconds first.'}</small>
      </label>
      <div className="h-pchips">
        {PRESETS.map(([label, expr]) => (
          <button key={expr} className={`h-pchip${cron.trim() === expr ? ' on' : ''}`} onClick={() => setCron(expr)}>
            {label}
          </button>
        ))}
      </div>
      <label className="sb-field">
        <span>Arguments</span>
        <textarea className="sb-input mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
      </label>
      {error && <pre className="sb-code h-perror">{error}</pre>}
      <div className="h-pform-acts">
        <button className="sb-btn sm ghost" onClick={() => onDone()}>
          Cancel
        </button>
        <button className="sb-btn sm primary" disabled={saving || !name || !cron.trim()} onClick={() => void save()}>
          {saving ? 'Saving…' : schedule ? 'Save' : 'Add schedule'}
        </button>
      </div>
    </div>
  )
}

export function SchedulesView({ state, toast, focus, onTools }: { state: AppState; toast: ToastFn; /** A tool schedule to open straight away, by its id. */ focus?: string; onTools: (tool?: string) => void }) {
  // The open drawer: a tool schedule, an agent schedule, or the form for a new one.
  const [open, setOpen] = useState<string | null>(focus ? `tool:${focus}` : null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  // "in 12 s" has to keep counting down.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const engine = state.engine.status === 'ready'
  const agents = useTool<{ items: AgentSchedule[] }>('agents', 'schedule_list', {}, { staleMs: 0, enabled: engine, refresh: 30000 })
  const act = (f: () => Promise<unknown>) => void f().catch((e) => toast(e instanceof Error ? e.message : String(e), 'bad'))
  const exists = (s: ToolSchedule) => state.tools.some((t) => t.name === s.tool && !t.error)
  const runNow = (s: ToolSchedule) => {
    setBusy(s.id)
    void call('tools', s.tool, s.args)
      .then(
        () => toast(`${s.tool} ran`, 'good'),
        (e) => toast(e instanceof Error ? e.message.split('\n')[0]! : String(e), 'bad'),
      )
      .finally(() => setBusy(null))
  }
  const toggle = (s: ToolSchedule) => act(() => app('schedule_save', { id: s.id, tool: s.tool, cron: s.cron, args: s.args, enabled: !s.enabled }))
  const remove = (s: ToolSchedule) => confirm(`Remove the schedule ${s.id}?`) && act(() => app('schedule_delete', { id: s.id }).then(() => setOpen(null)))
  const toggleAgent = (s: AgentSchedule) => act(() => call('agents', 'schedule_update', { id: s.id, enabled: !s.enabled }).then(() => agents.reload()))
  const removeAgent = (s: AgentSchedule) => confirm(`Remove the schedule ${s.name}?`) && act(() => call('agents', 'schedule_delete', { id: s.id }).then(() => (agents.reload(), setOpen(null))))

  const needle = filter.trim().toLowerCase()
  const has = (...texts: (string | null | undefined)[]) => !needle || texts.some((t) => t?.toLowerCase().includes(needle))
  const tools = state.schedules.filter((s) => has(s.id, s.tool, s.cron, cronWords(s.cron), JSON.stringify(s.args)))
  const agentSchedules = (agents.data?.items ?? []).filter((s) => has(s.name, s.cron, s.launch?.prompt))
  const badge = (s: ToolSchedule) =>
    !exists(s) ? <span className="sb-badge bad">tool missing</span> : s.running ? <span className="sb-badge live">running</span> : !s.enabled ? <span className="sb-badge">paused</span> : s.lastOk === false ? <span className="sb-badge bad">failing</span> : s.lastOk ? <span className="sb-badge good">ok</span> : <span className="sb-badge">not run yet</span>
  const next = (s: ToolSchedule) => (s.running ? 'Running now' : !s.enabled ? 'Paused' : `Next ${soon(s.nextAt, now)}`)
  const actionsOf = (s: ToolSchedule) => (
    <>
      <Toggle on={s.enabled} label={s.enabled ? `Pause ${s.id}` : `Resume ${s.id}`} onChange={() => toggle(s)} />
      <IconAction label="Run now" disabled={!exists(s) || s.running || busy === s.id} onClick={() => runNow(s)}>
        <Zap {...icon} />
      </IconAction>
      <IconAction label="Remove" danger onClick={() => remove(s)}>
        <Trash2 {...icon} />
      </IconAction>
    </>
  )

  const close = () => (setOpen(null), setEditing(false))
  const selected = state.schedules.find((s) => `tool:${s.id}` === open)
  const selectedAgent = (agents.data?.items ?? []).find((s) => `agent:${s.id}` === open)
  const drawer =
    open === 'new' ? (
      <Drawer eyebrow="new schedule" title="Run a tool on a schedule" onClose={close}>
        <DrawerSection title="Schedule">
          {state.tools.some((t) => !t.error) ? <ScheduleForm state={state} toast={toast} onDone={(id) => setOpen(id ? `tool:${id}` : null)} /> : <p className="h-pnone">There are no custom tools to schedule yet.</p>}
        </DrawerSection>
      </Drawer>
    ) : selected ? (
      <Drawer
        key={open}
        eyebrow="tool schedule"
        title={cronWords(selected.cron)}
        meta={
          <>
            {badge(selected)}
            <span className="sb-badge">
              <code>{selected.cron}</code>
            </span>
          </>
        }
        actions={actionsOf(selected)}
        onClose={close}
      >
        {editing ? (
          <DrawerSection title="Change it">
            <ScheduleForm state={state} schedule={selected} toast={toast} onDone={() => setEditing(false)} />
          </DrawerSection>
        ) : (
          <DrawerSection
            title="What it runs"
            actions={
              <button className="sb-btn sm" onClick={() => setEditing(true)}>
                <Pencil size={13} strokeWidth={1.8} />
                Edit
              </button>
            }
          >
            <Facts
              rows={[
                [
                  'Tool',
                  <button className="h-plink" onClick={() => onTools(selected.tool)}>
                    <code>{selected.tool}</code>
                  </button>,
                ],
                ['Arguments', Object.keys(selected.args).length ? <code>{JSON.stringify(selected.args)}</code> : <span className="h-pfaint">None</span>],
                ['Next run', selected.enabled && selected.nextAt ? `${soon(selected.nextAt, now)} · ${exact(selected.nextAt)}` : <span className="h-pfaint">Paused</span>],
                ['Last run', !selected.lastAt ? <span className="h-pfaint">Not yet</span> : `${rel(selected.lastAt, now)}${selected.lastOk === false ? ', failed' : ''}`],
              ]}
            />
          </DrawerSection>
        )}
        {selected.lastOk === false && selected.lastError && (
          <DrawerSection title="Last error">
            <pre className="sb-code h-perror">{selected.lastError}</pre>
          </DrawerSection>
        )}
        <DrawerSection title="Runs started by this schedule">
          <Runs tool={selected.tool} by={`schedule:${selected.id}`} stamp={`${selected.lastAt}:${selected.running}`} />
        </DrawerSection>
      </Drawer>
    ) : selectedAgent ? (
      <Drawer
        key={open}
        eyebrow="agent schedule"
        title={selectedAgent.cron ? cronWords(selectedAgent.cron) : `Once, ${exact(selectedAgent.run_at)}`}
        meta={<span className={`sb-badge${selectedAgent.enabled && selectedAgent.next_fire_at ? ' good' : ''}`}>{!selectedAgent.enabled ? 'paused' : selectedAgent.next_fire_at ? 'on' : 'done'}</span>}
        actions={
          <>
            <Toggle on={selectedAgent.enabled} label={selectedAgent.enabled ? 'Pause' : 'Resume'} onChange={() => toggleAgent(selectedAgent)} />
            <IconAction label="Remove" danger onClick={() => removeAgent(selectedAgent)}>
              <Trash2 {...icon} />
            </IconAction>
          </>
        }
        onClose={close}
      >
        <DrawerSection title="What it starts">
          <Facts
            rows={[
              ['Name', selectedAgent.name],
              ['Starts', selectedAgent.launch?.session_id ? 'Continues a conversation' : `A new ${selectedAgent.launch?.harness ?? 'agent'} conversation`],
              ...(selectedAgent.cron ? ([['Expression', <><code>{selectedAgent.cron}</code> <span className="h-pfaint">{selectedAgent.timezone}</span></>]] as [string, ReactNode][]) : []),
              ['Next run', selectedAgent.enabled && selectedAgent.next_fire_at ? `${soon(selectedAgent.next_fire_at, now)} · ${exact(selectedAgent.next_fire_at)}` : <span className="h-pfaint">—</span>],
            ]}
          />
        </DrawerSection>
        {selectedAgent.launch?.prompt && (
          <DrawerSection title="Prompt">
            <div className="h-pprose">{selectedAgent.launch.prompt}</div>
          </DrawerSection>
        )}
      </Drawer>
    ) : null

  return (
    <Page
      title="Schedules"
      sub="What runs on its own: custom tools on a timer, and agents the engine starts."
      actions={
        <button className="sb-btn sm primary" onClick={() => setOpen('new')} disabled={!state.tools.some((t) => !t.error)}>
          <Plus size={15} strokeWidth={1.8} />
          New schedule
        </button>
      }
      drawer={drawer}
    >
      <Search value={filter} onChange={setFilter} placeholder="Search schedules by tool, time or arguments" />
      <SectionHead title="Tools" hint="Run while Lynx is open. One missed while it was closed runs once at the next launch." />
      {!state.schedules.length ? (
        <Empty>Nothing is scheduled. Press New schedule, or ask an agent: “check for new pull requests every ten minutes and notify me”.</Empty>
      ) : !tools.length ? (
        <Empty>No schedule matches “{filter.trim()}”.</Empty>
      ) : (
        <List>
          {tools.map((s) => {
            const args = Object.keys(s.args).length ? JSON.stringify(s.args) : 'no arguments'
            return (
              <Item key={s.id} onOpen={() => setOpen(`tool:${s.id}`)} dim={!s.enabled} label={`${cronWords(s.cron)}: ${s.tool}`} actions={actionsOf(s)}>
                <Name mono={false} sub={<code title={s.cron}>{s.cron}</code>}>
                  {cronWords(s.cron)}
                </Name>
                <Body sub={args}>
                  <code>{s.tool}</code>
                  {s.id !== s.tool && <span className="h-pfaint"> · {s.id}</span>}
                </Body>
                <span className="h-pnext" title={exact(s.nextAt)}>
                  {next(s)}
                </span>
                {badge(s)}
              </Item>
            )
          })}
        </List>
      )}
      {agentSchedules.length > 0 && (
        <>
          <SectionHead title="Agents" hint="Started by the agent engine with a prompt, without a custom tool." />
          <List>
            {agentSchedules.map((s) => (
              <Item
                key={s.id}
                onOpen={() => setOpen(`agent:${s.id}`)}
                dim={!s.enabled}
                label={s.name}
                actions={
                  <>
                    <Toggle on={s.enabled} label={s.enabled ? `Pause ${s.name}` : `Resume ${s.name}`} onChange={() => toggleAgent(s)} />
                    <IconAction label="Remove" danger onClick={() => removeAgent(s)}>
                      <Trash2 {...icon} />
                    </IconAction>
                  </>
                }
              >
                <Name mono={false} sub={s.cron ? <code>{s.cron}</code> : undefined}>
                  {s.cron ? cronWords(s.cron) : `Once, ${exact(s.run_at)}`}
                </Name>
                <Body>
                  {s.name}
                  <span className="h-pfaint"> · {s.launch?.prompt ?? (s.launch?.session_id ? 'Continues a conversation' : '')}</span>
                </Body>
                <span className="h-pnext">{!s.enabled ? 'Paused' : s.next_fire_at ? `Next ${soon(s.next_fire_at, now)}` : 'Done'}</span>
              </Item>
            ))}
          </List>
        </>
      )}
    </Page>
  )
}

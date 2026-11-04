// Runs: every time a custom tool ran, who started it and how it went. The page is an audit log
// under a strip of the last day's runs, hour by hour; a run opens in the drawer with its input,
// result, the calls it made and what it logged. `Runs` is the short list the other drawers show.
import { useEffect, useMemo, useState } from 'react'
import { useTool } from '@kit/core'
import { Code, rel } from '@kit/ui'
import type { AppState, ToolRun } from '@shared/types'
import { Body, Drawer, DrawerSection, Empty, Facts, Item, List, Name, Page, Search } from './Page'

export const who = (by: string) => (by.startsWith('schedule:') ? `schedule ${by.slice(9)}` : by.startsWith('workspace:') ? `workspace ${by.slice(10)}` : by.startsWith('tool:') ? `tool ${by.slice(5)}` : by === 'user' ? 'you' : `an ${by}`)
export const soon = (at: string | null, now = Date.now()) => {
  if (!at) return 'paused'
  const secs = Math.round((new Date(at).getTime() - now) / 1000)
  const mins = Math.round(secs / 60)
  return secs <= 0 ? 'due now' : secs < 60 ? `in ${secs} s` : mins < 60 ? `in ${mins} min` : mins < 1440 ? `in ${Math.round(mins / 60)} h` : `on ${new Date(at).toLocaleDateString()}`
}
export const took = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
export const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const json = (v: unknown) => JSON.stringify(v, null, 2) ?? 'undefined'

/** Everything about one run: what went in, what came out, the calls it made, what it logged. */
export function RunDetail({ run }: { run: ToolRun }) {
  return (
    <>
      <DrawerSection title="Run">
        <Facts
          rows={[
            ['Status', run.ok ? <span className="sb-badge good">ok</span> : <span className="sb-badge bad">failed</span>],
            ['Started', `${new Date(run.startedAt).toLocaleString()} · ${rel(run.startedAt)}`],
            ['Started by', who(run.by)],
            ['Took', took(run.ms)],
          ]}
        />
      </DrawerSection>
      <DrawerSection title="Input">
        <Code language="json">{json(run.args)}</Code>
      </DrawerSection>
      {run.ok ? (
        <DrawerSection title="Result">
          <Code language="json">{json(run.result)}</Code>
        </DrawerSection>
      ) : (
        <DrawerSection title="Error">
          <pre className="sb-code h-perror">{run.error}</pre>
        </DrawerSection>
      )}
      {run.calls.length > 0 && (
        <DrawerSection title={`Calls · ${run.calls.length}`}>
          <div className="h-pmini">
            {run.calls.map((c, i) => (
              <div key={i}>
                <i className={`sb-dot ${c.ok ? 'good' : 'bad'}`} />
                <code>
                  {c.connector}.{c.tool}
                </code>
                <span>{took(c.ms)}</span>
              </div>
            ))}
          </div>
        </DrawerSection>
      )}
      {run.logs.length > 0 && (
        <DrawerSection title="Logs">
          <pre className="sb-code">{run.logs.join('\n')}</pre>
        </DrawerSection>
      )}
    </>
  )
}

/** Recent runs of a tool, one line each, opening in place; with `by`, only the ones that caller started (a schedule, say). */
export function Runs({ tool, by, stamp }: { tool: string; by?: string; /** Changes when there may be new runs. */ stamp?: unknown }) {
  const q = useTool<{ runs: ToolRun[] }>('app', 'tool_runs', { tool, limit: by ? 100 : 30 }, { staleMs: 0 })
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => void q.reload(), [stamp])
  const runs = (q.data?.runs ?? []).filter((r) => !by || r.by === by).slice(0, 30)
  if (!runs.length) return <div className="h-pnone">{q.loading ? 'Loading…' : 'It has not run yet.'}</div>
  return (
    <div className="h-runs">
      {runs.map((r) => (
        <div key={r.id} className="h-run">
          <button className="h-run-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
            <i className={`sb-dot ${r.ok ? 'good' : 'bad'}`} />
            <span title={new Date(r.startedAt).toLocaleString()}>{rel(r.startedAt)}</span>
            <span className="h-pfaint">{clock(r.startedAt)}</span>
            {!by && <span className="h-pfaint">{who(r.by)}</span>}
            <span className={r.ok ? 'h-pfaint' : 'h-run-error'}>{r.ok ? `${r.calls.length} ${r.calls.length === 1 ? 'call' : 'calls'}` : r.error?.split('\n')[0]}</span>
            <span className="h-pnum">{took(r.ms)}</span>
          </button>
          {open === r.id && <pre className="sb-code h-run-detail">{[`input   ${JSON.stringify(r.args)}`, r.ok ? `result  ${JSON.stringify(r.result)}` : `error   ${r.error}`, ...r.calls.map((c) => `call    ${c.connector}.${c.tool}  ${c.ok ? 'ok' : 'failed'}  ${c.ms} ms`), ...r.logs.map((l) => `log     ${l}`)].join('\n')}</pre>}
        </div>
      ))}
    </div>
  )
}

/** The last day of runs, an hour to a bar; failures are the red part of their hour. */
function Day({ runs }: { runs: ToolRun[] }) {
  const now = Date.now()
  const hours = useMemo(() => {
    const out = Array.from({ length: 24 }, () => ({ ok: 0, bad: 0 }))
    for (const r of runs) {
      const ago = Math.floor((now - new Date(r.startedAt).getTime()) / 3_600_000)
      if (ago >= 0 && ago < 24) out[23 - ago]![r.ok ? 'ok' : 'bad']++
    }
    return out
  }, [runs])
  const top = Math.max(1, ...hours.map((h) => h.ok + h.bad))
  const total = hours.reduce((n, h) => n + h.ok + h.bad, 0)
  const failed = hours.reduce((n, h) => n + h.bad, 0)
  return (
    <div className="h-pday">
      <div className="h-pday-bars" role="img" aria-label={`${total} runs in the last 24 hours, ${failed} failed`}>
        {hours.map((h, i) => (
          <span key={i} title={`${24 - i} h ago: ${h.ok + h.bad} runs${h.bad ? `, ${h.bad} failed` : ''}`}>
            {h.bad > 0 && <i className="bad" style={{ height: `${(h.bad / top) * 100}%` }} />}
            {h.ok > 0 && <i style={{ height: `${(h.ok / top) * 100}%` }} />}
          </span>
        ))}
      </div>
      <div className="h-pday-axis">
        <span>24 h ago</span>
        <span>
          {total} {total === 1 ? 'run' : 'runs'}
          {failed > 0 && <b> · {failed} failed</b>}
        </span>
        <span>now</span>
      </div>
    </div>
  )
}

export function RunsView({ state }: { state: AppState }) {
  const q = useTool<{ runs: ToolRun[] }>('app', 'tool_runs', { limit: 200 }, { staleMs: 0, refresh: 5000 })
  useEffect(() => void q.reload(), [state.tools, state.schedules])
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const runs = q.data?.runs ?? []
  const needle = filter.trim().toLowerCase()
  const shown = runs.filter((r) => !needle || r.tool.toLowerCase().includes(needle) || who(r.by).toLowerCase().includes(needle) || (!r.ok && r.error?.toLowerCase().includes(needle)))
  const run = runs.find((r) => r.id === open)
  return (
    <Page
      title="Runs"
      sub="Every time a custom tool ran: who started it, how long it took and how it went. The last 200 are kept here."
      drawer={
        run && (
          <Drawer eyebrow="run" title={<code>{run.tool}</code>} meta={run.ok ? <span className="sb-badge good">ok</span> : <span className="sb-badge bad">failed</span>} onClose={() => setOpen(null)}>
            <RunDetail run={run} />
          </Drawer>
        )
      }
    >
      <Day runs={runs} />
      <Search value={filter} onChange={setFilter} placeholder="Search by tool, who started it, or error" />
      {!runs.length ? (
        <Empty>{q.loading ? 'Loading…' : 'Nothing has run yet. Runs show up here as soon as a workspace, an agent or a schedule calls a custom tool.'}</Empty>
      ) : !shown.length ? (
        <Empty>No run matches “{filter.trim()}”.</Empty>
      ) : (
        <List>
          {shown.map((r) => (
            <Item key={r.id} onOpen={() => setOpen(r.id)} label={`${r.tool}, ${rel(r.startedAt)}`}>
              <Name mono={false} sub={clock(r.startedAt)}>
                {rel(r.startedAt)}
              </Name>
              <Body sub={r.ok ? `${r.calls.length} ${r.calls.length === 1 ? 'call' : 'calls'}` : r.error?.split('\n')[0]}>
                <code>{r.tool}</code> <span className="h-pfaint">· {who(r.by)}</span>
              </Body>
              <span className="h-pnum">{took(r.ms)}</span>
              {r.ok ? <span className="sb-badge good">ok</span> : <span className="sb-badge bad">failed</span>}
            </Item>
          ))}
        </List>
      )}
    </Page>
  )
}

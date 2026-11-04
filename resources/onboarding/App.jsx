import { useEffect, useState } from 'react'
import { Modal, agents, askAgent, chooseModel, isTerminal, openCommandBar, openConnectorDialog, openWorkspace, showConnectors, showSchedules, showTemplates, togglePoint, useConnectors, useProviders, useSession, useStored, useTool, workspace } from 'lynx'
import './onboarding.css'

// Onboarding: five things to do in a new Lynx, as a checklist. Each item ticks itself once it is done
// (a connector connected, a workspace made, a schedule set up), and a click ticks or unticks it by hand.
// "Show more" under each says how. This page is App.jsx in the Onboarding workspace's folder; ask the
// agent to change it into whatever you want this workspace to be.

const TOOLS = [
  { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' },
  { name: 'PostHog', url: 'https://mcp.posthog.com/mcp' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { name: 'Stripe', url: 'https://mcp.stripe.com' },
]

const SCHEDULES = [
  'Every weekday at 9am, summarize what changed overnight in my tools',
  'Every Friday at 4pm, write me a report on the week',
  'Every hour, check for anything urgent and notify me',
]

// The to-do list in the agent step: some of it plainly matters more than the rest.
const TODOS = [
  'Water the office plants',
  'Fix the checkout bug that is losing us sales',
  'Reply to the investor asking about the round, due today',
  'Reorganise the shared drive folders',
  'Renew the SSL certificate that expires tomorrow',
  'Pick a new theme for the team Slack',
]
const PRIORITIES = ['P0', 'P1', 'P2', 'P3']

// What to ask of the card in the point step.
const ASK = 'Make this card blue'

export default function App() {
  const { connectors } = useConnectors()
  // Added is not connected: one waiting for a sign-in or a key, or failing, is still to finish.
  const added = connectors.filter((c) => !c.native)
  const connected = added.filter((c) => c.status === 'connected')
  const spaces = useTool('app', 'workspace_list', {}, { refresh: 10000 })
  const others = (spaces.data?.workspaces ?? []).filter((w) => w.id !== workspace().id && !w.archived)
  const toolSchedules = useTool('app', 'schedule_list', {}, { refresh: 15000 })
  const agentSchedules = useTool('agents', 'schedule_list', {}, { refresh: 15000 })
  const scheduled = (toolSchedules.data?.schedules?.length ?? 0) + (agentSchedules.data?.items?.length ?? 0) > 0
  // What was ticked or unticked by hand wins over what is seen to be done.
  const [ticks, setTicks] = useStored('onboarding.ticks', {})
  const [open, setOpen] = useState(null)
  const [trying, setTrying] = useState(false)
  const [sorted, setSorted] = useStored('onboarding.sorted', false)
  const seen = { connect: connected.length > 0, workspace: others.length > 0, agent: sorted, point: false, schedule: scheduled }
  const done = (id) => ticks[id] ?? seen[id]
  const tick = (id) => setTicks((t) => ({ ...t, [id]: !done(id) }))

  const items = [
    { id: 'connect', title: 'Connect your data sources', line: 'Linear, GitHub, PostHog, or any MCP server or API.', more: <ConnectMore added={added} /> },
    { id: 'workspace', title: 'Create a new workspace', line: 'From a template, or described in your own words.', more: <WorkspaceMore /> },
    { id: 'agent', title: 'Trigger an agent from a workspace', line: 'A button on a page that hands the work to your local agent.', try: () => setTrying(true) },
    { id: 'point', title: 'Edit with the point tool', line: 'Click any part of a page and say what to change.', more: <PointMore /> },
    { id: 'schedule', title: 'Create a schedule', line: 'An agent that runs on its own, every morning or every hour.', more: <ScheduleMore /> },
  ]
  const count = items.filter((it) => done(it.id)).length

  return (
    <div className="ob">
      <header className="ob-head">
        <Mark />
        <div className="ob-head-text">
          <h1>Welcome to your first Lynx workspace</h1>
          <p>We prepared this for you but you can customize it as you wish</p>
        </div>
        <Ring done={count} of={items.length} />
      </header>

      <ol className="ob-list">
        {items.map((it, i) => (
          <Item key={it.id} n={i + 1} item={it} done={!!done(it.id)} open={open === it.id} onTick={() => tick(it.id)} onToggle={() => setOpen(open === it.id ? null : it.id)} />
        ))}
      </ol>

      {others.length > 0 && <Workspaces list={others} />}
      <Schedules tools={toolSchedules.data?.schedules ?? []} agents={agentSchedules.data?.items ?? []} />
      {trying && <Priorities onClose={() => setTrying(false)} onSorted={() => setSorted(true)} />}
    </div>
  )
}

function Item({ n, item, done, open, onTick, onToggle }) {
  return (
    <li className={`ob-item${done ? ' done' : ''}${open ? ' open' : ''}`}>
      <div className="ob-row">
        <button className="ob-tick" onClick={onTick} role="checkbox" aria-checked={done} aria-label={item.title} title={done ? 'Mark as not done' : 'Mark as done'}>
          <span className="ob-box">{done ? <CheckIcon /> : <span className="ob-n">{n}</span>}</span>
          <span className="ob-text">
            <span className="ob-title">{item.title}</span>
            <span className="ob-line">{item.line}</span>
          </span>
        </button>
        {item.try ? (
          <button className="ob-more-btn ob-try-btn" onClick={item.try}>
            Try
            <ArrowIcon />
          </button>
        ) : (
          <button className="ob-more-btn" onClick={onToggle} aria-expanded={open}>
            {open ? 'Show less' : 'Show more'}
            <ChevronIcon />
          </button>
        )}
      </div>
      {open && <div className="ob-more">{item.more}</div>}
    </li>
  )
}

function ConnectMore({ added }) {
  return (
    <>
      <p className="ob-lead">
        The quickest way is to <b>just say it in the chat</b>: tell the agent which products you use, and it finds each one's server, adds it and asks you to
        sign in right there in the conversation. Once one is connected, agents start building workspaces from it in the background.
      </p>
      <div className="ob-actions">
        <button className="ob-btn primary" onClick={() => askAgent('I use ')}>
          <SparkIcon /> Tell the agent what you use
        </button>
      </div>
      <p className="ob-sub">Or add one yourself:</p>
      <div className="ob-tools">
        {TOOLS.map((t) => {
          const mine = added.filter((c) => c.url && sameSite(c.url, t.url))
          const on = mine.some((c) => c.status === 'connected')
          // Added but not connected yet: the dialog opens on it, to sign in or give its key.
          const pending = !on && mine[0]
          return (
            <button
              key={t.name}
              className={`ob-tool${on ? ' on' : pending ? ' pending' : ''}`}
              onClick={() => (on ? showConnectors() : pending ? openConnectorDialog({ connector: pending.id }) : openConnectorDialog({ name: t.name.toLowerCase(), url: t.url }))}
              title={pending ? `${t.name} is not connected yet: finish connecting it` : undefined}
            >
              <Favicon url={t.url} name={t.name} />
              <span>{t.name}</span>
              {on ? <CheckIcon /> : pending ? <small>Finish</small> : <PlusIcon />}
            </button>
          )
        })}
        <button className="ob-tool" onClick={() => openConnectorDialog()}>
          <span className="ob-fav blank">
            <PlusIcon />
          </span>
          <span>Any MCP server or API</span>
        </button>
      </div>
    </>
  )
}

function WorkspaceMore() {
  return (
    <>
      <p className="ob-lead">Every workspace is an app of its own, made of your connectors. There are two ways in, wherever you are in Lynx:</p>
      <div className="ob-ways">
        <div className="ob-way">
          <Keys keys={['⌥', '⌘', 'N']} />
          <span>
            <b>New workspace</b>: pick a template, or start blank and describe it.
          </span>
        </div>
        <div className="ob-way">
          <Keys keys={['⌘', 'K']} />
          <span>
            <b>The command bar</b>: type “new” and press Return. Everything in Lynx is in there.
          </span>
        </div>
      </div>
      <div className="ob-bar" aria-hidden="true">
        <div className="ob-bar-field">
          <SearchIcon /> new<i className="ob-caret" />
        </div>
        <div className="ob-bar-row lit">
          <PlusIcon /> New workspace (marketplace) <span className="ob-bar-keys">⌥⌘N</span>
        </div>
        <div className="ob-bar-row">
          <SparkIcon /> New agent conversation <span className="ob-bar-keys">⌘T</span>
        </div>
      </div>
      <div className="ob-actions">
        <button className="ob-btn primary" onClick={showTemplates}>
          <PlusIcon /> New workspace
        </button>
        <button className="ob-btn" onClick={openCommandBar}>
          Open the command bar <kbd>⌘K</kbd>
        </button>
      </div>
    </>
  )
}

function PointMore() {
  return (
    <>
      <div className="ob-steps">
        <figure>
          <div className="mk">
            <div className="mk-bar">
              <span className="mk-dots" />
              <span className="mk-pill lit">
                <PointerIcon /> Point
              </span>
            </div>
            <div className="mk-body">
              <div className="mk-line w60" />
              <div className="mk-line w40" />
              <div className="mk-card" />
            </div>
          </div>
          <figcaption>
            <b>1</b> Press <kbd>⌘E</kbd>, or Point in the title bar
          </figcaption>
        </figure>
        <figure>
          <div className="mk">
            <div className="mk-bar">
              <span className="mk-dots" />
            </div>
            <div className="mk-body">
              <div className="mk-line w60" />
              <div className="mk-card picked">
                <span className="mk-mark">1</span>
                <div className="mk-line w50" />
                <div className="mk-line w70" />
              </div>
              <span className="mk-cursor">
                <CursorIcon />
              </span>
            </div>
          </div>
          <figcaption>
            <b>2</b> Click the part you want changed
          </figcaption>
        </figure>
        <figure>
          <div className="mk">
            <div className="mk-bar">
              <span className="mk-dots" />
            </div>
            <div className="mk-body">
              <div className="mk-card picked">
                <span className="mk-mark">1</span>
                <div className="mk-line w50" />
              </div>
              <div className="mk-note">{ASK}</div>
            </div>
          </div>
          <figcaption>
            <b>3</b> Say what to change, and send
          </figcaption>
        </figure>
      </div>
      <p className="ob-sub">
        Try it: turn on Point, click the card below and ask for <b>“{ASK}”</b>.
      </p>
      <div className="ob-big">Change me to blue</div>
      <div className="ob-actions">
        <button className="ob-btn primary" onClick={togglePoint}>
          <PointerIcon /> Turn on Point <kbd>⌘E</kbd>
        </button>
      </div>
    </>
  )
}

function ScheduleMore() {
  return (
    <>
      <p className="ob-lead">
        A schedule runs an agent or a tool on its own: every morning, every hour, every Friday. There is nothing to fill in: <b>ask for one in the chat</b>, the way
        you would ask a person, and the agent sets it up. It can notify you when it finds something.
      </p>
      <div className="ob-prompts">
        {SCHEDULES.map((p) => (
          <button key={p} className="ob-prompt" onClick={() => askAgent(p)}>
            <ClockIcon />
            <span>{p}</span>
          </button>
        ))}
      </div>
      <div className="ob-actions">
        <button className="ob-btn primary" onClick={() => askAgent('Set up a schedule that ')}>
          <SparkIcon /> Ask the agent
        </button>
      </div>
    </>
  )
}

// The agent step's try-out: a to-do list the user can edit, and a button that has the local agent
// give each item a priority and sort them. It is an ordinary agents.start from this page; any
// workspace can do the same.
function Priorities({ onClose, onSorted }) {
  const [todos, setTodos] = useStored('onboarding.todos', TODOS.map((text, i) => ({ id: String(i + 1), text })))
  const [sessionId, setSessionId] = useState(null)
  const [error, setError] = useState(null)
  const session = useSession(sessionId)
  const { providers, loading } = useProviders()
  // Claude Code when it is here, else the other agent.
  const provider = providers.find((p) => p.name === 'claude' && p.signed_in !== false) ?? providers.find((p) => p.signed_in !== false) ?? providers[0]
  const choice = provider ? chooseModel(provider) : null
  const modelName = provider?.models?.find((m) => m.id === choice?.model)?.name ?? choice?.model ?? 'its default model'
  const agentName = provider?.display_name ?? 'agent'
  const running = !!sessionId && !isTerminal(session.status) && !(session.status === 'idle' && session.events.length)

  // The answer is a JSON list of { id, priority }; the list takes them and sorts by them.
  useEffect(() => {
    if (!sessionId || running) return
    const reply = [...session.events].reverse().find((e) => e.type === 'assistant_message')
    const text = String(reply?.payload?.text ?? '')
    const json = text.match(/\[[\s\S]*\]/)?.[0]
    try {
      if (!json) throw new Error('no answer')
      const given = new Map(JSON.parse(json).map((r) => [String(r.id), r.priority]))
      setTodos((list) => [...list.map((t) => ({ ...t, priority: PRIORITIES.includes(given.get(t.id)) ? given.get(t.id) : t.priority }))].sort((a, b) => PRIORITIES.indexOf(a.priority ?? 'P3') - PRIORITIES.indexOf(b.priority ?? 'P3')))
      onSorted()
    } catch {
      setError('The agent did not answer with priorities. Try again.')
    }
    setSessionId(null)
  }, [sessionId, running, session.events, session.status])

  const assign = async () => {
    setError(null)
    const list = todos.filter((t) => t.text.trim()).map((t) => ({ id: t.id, text: t.text.trim() }))
    try {
      const effort = provider?.models?.find((m) => m.id === choice?.model)?.efforts?.includes('low') ? 'low' : choice?.effort
      const { session: s } = await agents.start({
        harness: provider?.name ?? 'claude',
        ...(choice?.model ? { model: choice.model } : {}),
        ...(effort ? { effort } : {}),
        permission: 'deny',
        labels: { kind: 'onboarding-priorities', title: 'Assign priorities to a to-do list' },
        prompt: `Give each of these to-dos a priority from P0 (most urgent and important) to P3 (can wait). Judge by what each one says. Answer with only a JSON array of {"id", "priority"}, nothing else.\n\n${JSON.stringify(list)}`,
      })
      setSessionId(s.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const edit = (id, text) => setTodos((list) => list.map((t) => (t.id === id ? { ...t, text, priority: undefined } : t)))
  const remove = (id) => setTodos((list) => list.filter((t) => t.id !== id))
  const add = () => setTodos((list) => [...list, { id: String(Math.max(0, ...list.map((t) => Number(t.id) || 0)) + 1), text: '' }])

  return (
    <Modal title="Trigger an agent from a workspace" onClose={onClose} width={520}>
      <p className="ob-try-lead">A to-do list, in this workspace. Edit it as you like, then have your agent sort it.</p>
      <ul className={`ob-todos${running ? ' busy' : ''}`}>
        {todos.map((t) => (
          <li key={t.id}>
            <span className={`ob-prio ${t.priority ?? ''}`}>{t.priority ?? '–'}</span>
            <input value={t.text} onChange={(e) => edit(t.id, e.target.value)} placeholder="Something to do" aria-label="To-do" disabled={running} />
            <button className="ob-todo-x" onClick={() => remove(t.id)} aria-label="Remove" title="Remove" disabled={running}>
              <XIcon />
            </button>
          </li>
        ))}
      </ul>
      <button className="ob-todo-add" onClick={add} disabled={running}>
        <PlusIcon /> Add a to-do
      </button>
      <div className="ob-try-bar">
        <button className="ob-btn primary" onClick={assign} disabled={running || loading || !provider || !todos.some((t) => t.text.trim())}>
          {running ? <span className="ob-spin" /> : <SparkIcon />} {running ? 'Assigning priorities…' : 'Assign priorities with an agent'}
        </button>
        {provider && (
          <span className="ob-model">
            {running ? (
              <>
                <b>{modelName}</b> running using your local {agentName}
              </>
            ) : (
              <>
                Runs <b>{modelName}</b> using your local {agentName}
              </>
            )}
          </span>
        )}
      </div>
      {error && <p className="ob-try-error">{error}</p>}
      <p className="ob-try-note">Any button in a workspace can start an agent like this. Ask the agent to add one where you want it.</p>
    </Modal>
  )
}

// The workspaces there are besides this one: the ones agents are building in the background turn up here.
function Workspaces({ list }) {
  return (
    <section className="ob-spaces">
      <h2>Your workspaces</h2>
      <div className="ob-space-grid">
        {list.map((w) => (
          <button key={w.id} className="ob-space" onClick={() => openWorkspace(w.id)}>
            <span className="ob-space-name">{w.name}</span>
            <span className={`ob-space-state ${w.build?.status ?? ''}`}>{w.build?.status === 'building' ? 'Building…' : w.build?.status === 'error' ? 'Needs a fix' : 'Open'}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

// What runs on its own: the custom tools' schedules and the scheduled agents, once there are any. A row opens them in settings.
function Schedules({ tools, agents }) {
  const when = (at, enabled = true) => (!enabled ? 'Paused' : at ? `Next ${new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Scheduled')
  const rows = [
    ...agents.map((s) => ({ id: `agent:${s.id}`, name: s.name || s.launch?.prompt?.slice(0, 60) || 'An agent', what: 'Agent', when: when(s.next_fire_at, s.enabled) })),
    ...tools.map((s) => ({ id: `tool:${s.id}`, name: s.tool, what: 'Tool', when: when(s.nextAt, s.enabled) })),
  ]
  if (!rows.length) return null
  return (
    <section className="ob-spaces">
      <h2>Your schedules</h2>
      <div className="ob-space-grid">
        {rows.map((r) => (
          <button key={r.id} className="ob-space" onClick={showSchedules} title={`${r.what}: ${r.name}`}>
            <span className="ob-space-name">{r.name}</span>
            <span className="ob-space-state">{r.when}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function Ring({ done, of }) {
  const r = 17
  const c = 2 * Math.PI * r
  return (
    <div className="ob-ring" aria-label={`${done} of ${of} done`}>
      <svg viewBox="0 0 40 40" width="44" height="44" aria-hidden="true">
        <circle cx="20" cy="20" r={r} className="ob-ring-track" />
        <circle cx="20" cy="20" r={r} className="ob-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - done / of)} />
      </svg>
      <span>{done === of ? 'All done' : `${done} of ${of}`}</span>
    </div>
  )
}

function Keys({ keys }) {
  return (
    <span className="ob-keys">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  )
}

function Favicon({ url, name }) {
  const q = useTool('app', 'connector_icon', { url }, { staleMs: Infinity })
  const [failed, setFailed] = useState(false)
  const icon = q.data?.icon
  if (!icon || failed) return <span className="ob-fav blank">{name[0]}</span>
  return <img className="ob-fav" src={icon} alt="" onError={() => setFailed(true)} />
}

const sameSite = (a, b) => {
  try {
    const host = (u) => new URL(u).hostname.split('.').slice(-2).join('.')
    return host(a) === host(b)
  } catch {
    return false
  }
}

function Mark() {
  return (
    <svg className="ob-mark" viewBox="0 0 100 100" aria-hidden="true">
      <path fillRule="evenodd" d="M50 88 L30 76 L16 58 L22 34 L24 16 L40 34 L60 34 L76 16 L78 34 L84 58 L70 76 Z M31 50 Q38 44 45 52 Q37 56 31 50 Z M69 50 Q62 44 55 52 Q63 56 69 50 Z M45 62 L55 62 L50 68 Z" />
    </svg>
  )
}

const svg = (d, props = {}) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {d}
  </svg>
)
const PointerIcon = () => svg(<path d="M4 4l7 17 2.5-7.5L21 11z" />)
const CursorIcon = () => svg(<path d="M4 4l7 17 2.5-7.5L21 11z" fill="currentColor" />, { width: 20, height: 20, strokeWidth: 1.4 })
const SparkIcon = () => svg(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />)
const CheckIcon = () => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, { strokeWidth: 2.4 })
const PlusIcon = () => svg(<path d="M12 5v14M5 12h14" />)
const ChevronIcon = () => svg(<path d="M6 9l6 6 6-6" />, { width: 14, height: 14 })
const SearchIcon = () => svg(<path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5" />, { width: 14, height: 14 })
const ArrowIcon = () => svg(<path d="M5 12h14M13 6l6 6-6 6" />, { width: 14, height: 14 })
const XIcon = () => svg(<path d="M6 6l12 12M18 6L6 18" />, { width: 13, height: 13 })
const ClockIcon = () => svg(<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2" />)

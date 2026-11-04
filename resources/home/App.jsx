import { useState } from 'react'
import { askAgent, openConnectorDialog, showConnectors, showTemplates, toggleAgent, togglePoint, useConnectors, useTool } from 'lynx'
import './home.css'

// Home: three steps through what Lynx does. This page is App.jsx in the Home workspace's folder;
// ask the agent to change it into whatever you want Home to be.

const MAC = /Mac/.test(navigator.platform)
const key = (k) => (MAC ? `⌘${k}` : `Ctrl ${k}`)

const TOOLS = [
  { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { name: 'Stripe', url: 'https://mcp.stripe.com' },
  { name: 'PostHog', url: 'https://mcp.posthog.com/mcp' },
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
]

const PROMPTS = ['Make the sample card green', 'Add today’s date under the title', 'Turn the checklist into a progress ring']

// Which steps have been tried, kept in this page's own storage.
function useDone() {
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem('lynx.home.done') || '{}')
    } catch {
      return {}
    }
  }
  const [done, setDone] = useState(read)
  const mark = (step) =>
    setDone((d) => {
      const next = { ...d, [step]: true }
      try {
        localStorage.setItem('lynx.home.done', JSON.stringify(next))
      } catch {}
      return next
    })
  return [done, mark]
}

export default function App() {
  const [done, mark] = useDone()
  const { connectors } = useConnectors()
  const added = connectors.filter((c) => !c.native)
  const steps = { point: !!done.point, agent: !!done.agent, connect: added.length > 0 }
  const count = Object.values(steps).filter(Boolean).length

  return (
    <div className="hm">
      <header className="hm-head">
        <Mark />
        <div>
          <h1>Welcome to Lynx</h1>
          <p>Apps your agents build and use with you.</p>
        </div>
        <div className="hm-progress" aria-label={`${count} of 3 done`}>
          {Object.entries(steps).map(([k, v]) => (
            <i key={k} className={v ? 'on' : ''} />
          ))}
          <span>{count === 3 ? 'All done' : `${count} of 3`}</span>
        </div>
      </header>

      <Step n={1} done={steps.point} title="Point at anything" line="Turn on Point, click the card, say what to change." visual={<PointVisual />}>
        <button className="hm-btn primary" onClick={() => (mark('point'), togglePoint())}>
          <PointerIcon /> Point <kbd>{key('E')}</kbd>
        </button>
        <SampleCard />
      </Step>

      <Step n={2} done={steps.agent} title="Let the agent change it" line="It edits this page while you watch." visual={<AgentVisual />}>
        <button className="hm-btn primary" onClick={() => (mark('agent'), toggleAgent())}>
          <SparkIcon /> Agent <kbd>{key('T')}</kbd>
        </button>
        <div className="hm-prompts">
          {PROMPTS.map((p) => (
            <button key={p} className="hm-prompt" onClick={() => (mark('agent'), askAgent(p))}>
              “{p}”
            </button>
          ))}
        </div>
      </Step>

      <Step n={3} done={steps.connect} title="Connect your tools" line="Agents and workspaces can then read and act on them." visual={null}>
        <div className="hm-tools">
          {TOOLS.map((t) => {
            const on = added.some((c) => c.url && sameSite(c.url, t.url))
            return (
              <button key={t.name} className={`hm-tool${on ? ' on' : ''}`} onClick={() => (on ? showConnectors() : openConnectorDialog({ name: t.name.toLowerCase(), url: t.url }))}>
                <Favicon url={t.url} name={t.name} />
                <span>{t.name}</span>
                {on ? <CheckIcon /> : <PlusIcon />}
              </button>
            )
          })}
          <button className="hm-tool more" onClick={() => openConnectorDialog()}>
            <span className="hm-fav blank">
              <PlusIcon />
            </span>
            <span>Any MCP server</span>
          </button>
        </div>
      </Step>

      <footer className="hm-next">
        <span>Then make one of your own</span>
        <button className="hm-btn" onClick={showTemplates}>
          Templates <kbd>{key('N')}</kbd>
        </button>
        <button className="hm-btn" onClick={() => askAgent('Build me a new workspace that ')}>
          Describe it to the agent
        </button>
      </footer>
    </div>
  )
}

function Step({ n, done, title, line, visual, children }) {
  return (
    <section className={`hm-step${done ? ' done' : ''}`}>
      <div className="hm-step-text">
        <div className="hm-step-title">
          <span className="hm-n">{done ? <CheckIcon /> : n}</span>
          <h2>{title}</h2>
        </div>
        <p>{line}</p>
        <div className="hm-step-do">{children}</div>
      </div>
      {visual && <div className="hm-visual" aria-hidden="true">{visual}</div>}
    </section>
  )
}

// Something to point at and change. The agent will edit this when asked to.
function SampleCard() {
  const items = [
    { text: 'Point at this card', done: false },
    { text: 'Ask for a change', done: false },
    { text: 'Connect a tool', done: false },
  ]
  return (
    <div className="hm-sample">
      <div className="hm-sample-head">
        <b>Sample card</b>
        <span>Try it on me</span>
      </div>
      {items.map((it) => (
        <div key={it.text} className={`hm-sample-row${it.done ? ' done' : ''}`}>
          <i />
          {it.text}
        </div>
      ))}
    </div>
  )
}

// A small window: the Point button lit, a card outlined with its marker, and the note being typed.
function PointVisual() {
  return (
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
        <div className="mk-card picked">
          <span className="mk-mark">1</span>
          <div className="mk-line w50" />
          <div className="mk-line w70" />
        </div>
        <div className="mk-cursor">
          <CursorIcon />
        </div>
        <div className="mk-note">Make this green</div>
      </div>
    </div>
  )
}

// The page and the agent beside it: the request, the agent at work, and the card it changed.
function AgentVisual() {
  return (
    <div className="mk">
      <div className="mk-bar">
        <span className="mk-dots" />
        <span className="mk-pill lit">
          <SparkIcon /> Agent
        </span>
      </div>
      <div className="mk-split">
        <div className="mk-body">
          <div className="mk-line w60" />
          <div className="mk-card changed">
            <div className="mk-line w50" />
            <div className="mk-line w70" />
          </div>
        </div>
        <div className="mk-agent">
          <div className="mk-bubble">Make this green</div>
          <div className="mk-work">
            <i />
            <i />
            <i />
          </div>
          <div className="mk-reply">Done: the card is green.</div>
        </div>
      </div>
    </div>
  )
}

function Favicon({ url, name }) {
  const q = useTool('app', 'connector_icon', { url }, { staleMs: Infinity })
  const [failed, setFailed] = useState(false)
  const icon = q.data?.icon
  if (!icon || failed) return <span className="hm-fav blank">{name[0]}</span>
  return <img className="hm-fav" src={icon} alt="" onError={() => setFailed(true)} />
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
    <svg className="hm-mark" viewBox="0 0 100 100" aria-hidden="true">
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
const CursorIcon = () => svg(<path d="M4 4l7 17 2.5-7.5L21 11z" fill="currentColor" />, { width: 22, height: 22, strokeWidth: 1.4 })
const SparkIcon = () => svg(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />)
const CheckIcon = () => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, { strokeWidth: 2.2 })
const PlusIcon = () => svg(<path d="M12 5v14M5 12h14" />)

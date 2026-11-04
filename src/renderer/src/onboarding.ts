// The onboarding conversation: the one the agent opens on beside the Onboarding checklist of a new
// install, greeting the user and getting their data sources connected. There is one: once it has
// started, other conversations there are ordinary ones, and whoever else would start it (the user's
// first message, a connection) waits for the start under way and goes to it. While the checklist is
// in use, every connector that comes to be connected is told to it once, from here, however it was
// connected (the agent's connect card, the checklist's buttons, settings) and whether or not the
// conversation is on screen; its connect cards leave that to this. A connector the agent asked for
// along with others (several cards in one answer) is not told: the user says when to go on.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionEvent } from '@kit/agents'
import { call } from '@kit/core'
import { cardsInTurn, toItems } from '@kit/items'
import type { AppState, ConnectorState } from '@shared/types'
import { queue } from './agentQueue'

/** What the agent says first beside the onboarding checklist, before the user has written anything. */
export const GREETING = "Welcome to Lynx. Let's get your data sources connected so we can build useful workspaces. What products do you use day to day? Linear? GitHub? PostHog? Lynx can connect to any MCP server or API."
/** Offered under the greeting: each click names one more in the message. */
export const PRODUCTS = ['Linear', 'GitHub', 'PostHog', 'Notion', 'Sentry', 'Stripe', 'Slack']
/** What the checklist's "Tell the agent what you use" puts in the box: a reply to the greeting, unlike anything else a page asks. */
export const ONBOARDING_REPLY = 'I use '

/** The onboarding conversation's id, once it has started. */
const SESSION = 'sb.onboarding.session'
/** The connectors the onboarding conversation has been told of, or was there before: each is told once. One is
 * written here only once the conversation has it (started with it, or its message in the queue, which keeps). */
const TOLD = 'sb.onboarding.told'
/** Connectors whose telling failed (the conversation did not start) and wait to be tried again: never written down as
 * told meanwhile, not even when the checklist is put away. Kept, so they still wait at the next launch. */
const WAITING = 'sb.onboarding.waiting'

export const onboardingSession = () => localStorage.getItem(SESSION)
const sessionListeners = new Set<() => void>()
/** The onboarding conversation's id as it changes: none, then the one that started. */
export const useOnboardingSessionId = () =>
  useSyncExternalStore(
    (l) => (sessionListeners.add(l), () => void sessionListeners.delete(l)),
    onboardingSession,
  )

/** Whether the checklist is still in use: there, and not archived. While it is, connections are told to the onboarding conversation from here; after, its connect cards carry it on, as in any conversation. */
export const checklistInUse = (state: AppState | null) => !!state?.workspaces.some((w) => w.onboarding && !w.archived)

/** The onboarding conversation being started, while it is. */
let starting: Promise<string> | null = null

/**
 * Starts the onboarding conversation with `run` (which starts the session and returns its id), unless
 * it has started or is starting: then that one's id, and `started` false, for the caller to send its
 * message to instead.
 */
export async function beginOnboarding(run: () => Promise<string>): Promise<{ id: string; started: boolean }> {
  const known = onboardingSession()
  if (known) return { id: known, started: false }
  if (starting) return { id: await starting, started: false }
  const begun = run().then((id) => {
    localStorage.setItem(SESSION, id)
    sessionListeners.forEach((l) => l())
    return id
  })
  starting = begun
  try {
    return { id: await begun, started: true }
  } finally {
    starting = null
  }
}

/** A message the app writes to the onboarding conversation, going when it is done with what it is doing. */
export const tellOnboarding = (id: string, text: string) => queue.add(id, { id: Math.random().toString(36).slice(2, 10), text, prompt: text, files: [] })

/** Where the first-run agent records services it could not connect on its own, with how the user can: one record per service. */
export const MANUAL = 'onboarding/manual'

/** Added to the onboarding conversation's instructions when it starts on the first-run screen, before the app is open. */
export const FIRST_RUN_RULES = `

The user is not in this conversation yet: they are on Lynx's first-run screen, which shows a line for what you are doing and a card for each connector you add, and nothing you write. Until they say they have opened Lynx:
- Connect what they name, without asking anything (when a name is unclear, take the likely service), and start nothing else.
- Only ever add a remote MCP server (an https URL, the service's official one) or the service's HTTP API with connector_add. Never add a local server (a command), never install anything, and never write a server or script of your own to stand in for a service.
- When a service has neither (a database such as Postgres, a mail account such as Gmail, an app with no public API), do not connect it. Record it instead with db_put on the app connector: collection "${MANUAL}", key the service's name in lowercase, value { "name": its name, "reason": one short line on why it could not be set up automatically, "steps": two to four short steps the user can follow to connect it themselves in Lynx (for a database, running postgres2mcp or a similar MCP server and adding it in Settings › Connectors), "docs_url": the page that explains it, when there is one }. The screen shows it as a card with those steps.
Then go on as below.`

/** How an agent builds workspaces in the background: from a template where one fits, by agents of their own, and what makes one worth having. */
export const backgroundBuilds = (agentDir: string, harness: string) =>
  `Before building from scratch, look at marketplace_list: where a template fits, fork it yourself with marketplace_fork (binding the user's connector) and have the agent make it theirs; otherwise create the workspace yourself with workspace_create (name, icon, colour) and have the agent build it. Start each agent with session_start on the agents connector: harness "${harness}", cwd "${agentDir}", connection_ids every connector's agent_connection_id from connector_list, labels { "title": what it builds }, config { "permission_mode": "allow" }, and a prompt that is the whole brief, since it knows nothing of this conversation: the workspace id, the connector and what it holds for this user, what to show, and how to work (read KIT.md in its draft; workspace_draft, workspace_build and workspace_publish on the app connector, publishing in steps; look at real responses with connector_call before rendering them; real loading, empty and error states).
   What to build: workspaces that show the user's own data well (charts of trends, lists that can be filtered, what needs attention now) with agent interactions built in where an agent helps, not everywhere: a button on an issue that asks the agent to triage it or draft a fix, a summary of the week written on request, a "why did this move?" beside a chart. Those use askAgent or the agents API from the kit.`

const names = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`)

/**
 * Added to the instructions of the conversation the app opens once the first-run screen is done:
 * what it connected, which workspaces it made from templates, and what the agent said first.
 */
export const welcomeRules = (o: { intro?: string; made: string[]; connected: string[]; agentDir: string; harness: string }) => `

The user has just finished Lynx's first-run screen.${o.connected.length ? ` They connected ${names(o.connected)}.` : ''}${o.made.length ? ` Lynx made workspaces from its templates for ${names(o.made)}: do not make those again.` : ''}${o.intro ? ` This conversation opened with you saying: "${o.intro}"` : ''}
When they ask for workspaces from what they connected, build them in the background, a couple per connector, each a different useful view, and say in a line or two what is being built (they can watch from the running agents list in the title bar). ${backgroundBuilds(o.agentDir, o.harness)}
Keep replies short.`

/** Added to the instructions of the onboarding conversation. */
export const onboardingRules = (agentDir: string, harness: string) => `

Onboarding. This is the user's first conversation in Lynx. It opened beside the Onboarding workspace (a checklist: connect your data sources, create a new workspace, edit with the point tool, create a schedule), with you saying:
"${GREETING}"
Their first message answers that, or says what they have already connected themselves. Get them set up, in this order:
1. Connect what they name, all of them, with connector_add on the app connector (the official remote MCP server where there is one; look its URL up when you are not sure; its HTTP API when there is none). A connect card shows here for each, where they sign in or give a key. Having added several, end your reply by asking them to tell you once they have connected the ones they want: nothing carries you on until they do. If they named nothing they use, suggest a few. When they say they connected one themselves, it is there already: check connector_list.
2. As soon as a connector is connected (connector_list says so), and without waiting for the user, start background agents that build workspaces from it: about two per connector, three or four in all, each a different useful view. ${backgroundBuilds(agentDir, harness)}
3. Tell the user in a line or two what is being built (they can watch the agents from the running agents list in the title bar), then ask what they want to build themselves. Build that with them here, in a workspace of its own.
4. Along the way, point them at the rest of the checklist where it fits: a new workspace (⌥⌘N, or "New workspace" in the command bar, ⌘K), Point (⌘E) to change any part of a page by clicking it, and a schedule: offer one from what they connected (a morning digest, a weekly report) and make it here (schedule_save for a custom tool, schedule_create on the agents connector for an agent).
Keep each reply short: this is their first look at Lynx.`

const ids = (key: string): string[] | null => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}
const told = () => ids(TOLD)
const waiting = () => ids(WAITING) ?? []
const setWaiting = (list: string[]) => (list.length ? localStorage.setItem(WAITING, JSON.stringify(list)) : localStorage.removeItem(WAITING))
const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** How long until connections that could not be told (the agent did not start) are tried again. */
const RETRY_MS = 60000
/** Connectors being told right now, so a second look while the first is under way does not start another conversation. */
const telling = new Set<string>()

/**
 * Tells the onboarding conversation of these connectors, or starts it with them when it has not
 * begun; `start` resolves to whether it did. Resolves to whether the conversation has them now.
 */
async function tell(connectors: ConnectorState[], start: (text: string) => Promise<boolean>) {
  // One being started gets it once it has.
  const id = onboardingSession() ?? (await starting?.catch(() => null)) ?? null
  if (!id) return start(`I've connected ${list(connectors.map((c) => c.name))}.`)
  // One the agent asked for along with others waits for the user to say when to go on (written down all the same).
  const turns = await cardTurns(id).catch(() => new Map<string, number>())
  const alone = connectors.filter((c) => (turns.get(c.id) ?? 1) === 1)
  if (alone.length) tellOnboarding(id, `I've connected ${list(alone.map((c) => c.name))}. Carry on.`)
  return true
}

/** How many connect cards came with each connector's card in a conversation (see cardsInTurn). */
async function cardTurns(sessionId: string) {
  const events: SessionEvent[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page++) {
    const r = await call<{ items: SessionEvent[]; next_cursor: string; has_more: boolean }>('agents', 'session_history', { id: sessionId, limit: 500, ...(after ? { after } : {}) })
    events.push(...r.items)
    if (!r.has_more) break
    after = r.next_cursor
  }
  return cardsInTurn(toItems(events))
}

/**
 * One look at the connectors that are connected: the ones the onboarding conversation has not been
 * told of go to it (through `tell`). Resolves to false when they could not be and must be tried
 * again; they are only written down as told once they went. The first look writes down what is
 * there already, which is left alone.
 */
export async function lookAtConnections(connected: ConnectorState[], start: (text: string) => Promise<boolean>) {
  const before = told()
  if (before === null) return localStorage.setItem(TOLD, JSON.stringify(connected.map((c) => c.id))), true
  const fresh = connected.filter((c) => !before.includes(c.id) && !telling.has(c.id))
  if (!fresh.length) return true
  for (const c of fresh) telling.add(c.id)
  try {
    const done = await tell(fresh, start).catch((e) => (console.error('[onboarding]', e), false))
    const these = fresh.map((c) => c.id)
    if (done) localStorage.setItem(TOLD, JSON.stringify([...new Set([...(told() ?? []), ...these])]))
    setWaiting(done ? waiting().filter((id) => !these.includes(id)) : [...new Set([...waiting(), ...these])])
    return done
  } finally {
    for (const c of fresh) telling.delete(c.id)
  }
}

/**
 * With the checklist put away, the cards tell the conversation of what is connected meanwhile: that is written down as
 * told, so it is not told again should the checklist come back. Those being told right now, or waiting on a start that
 * failed, are not: they are still owed to the onboarding conversation, and go to it if the checklist comes back.
 */
export function putAway(connected: ConnectorState[]) {
  const before = told()
  if (!before) return
  const owed = new Set([...telling, ...waiting()])
  const now = connected.map((c) => c.id).filter((id) => !owed.has(id))
  if (now.some((id) => !before.includes(id))) localStorage.setItem(TOLD, JSON.stringify([...new Set([...before, ...now])]))
}

/**
 * While the onboarding checklist is in use, a connector that comes to be connected, however it was
 * added, is told to the onboarding conversation once. `start` begins that conversation with a
 * message (through beginOnboarding) and resolves to whether it did; when it did not (no agent to
 * run it, say), the connectors wait and are tried again a minute later, and at the next launch.
 */
export function useOnboardingConnections(state: AppState | null, start: (text: string) => Promise<boolean>) {
  const inUse = checklistInUse(state)
  const active = inUse && state?.engine.status === 'ready'
  const connected = (state?.connectors ?? []).filter((c) => !c.native && c.status === 'connected')
  const ids = connected.map((c) => c.id).sort().join('\n')
  // Bumped to look again after a failed start.
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!inUse) putAway(connected)
    if (!active) return
    void lookAtConnections(connected, start).then((done) => done || void setTimeout(() => setRetry((n) => n + 1), RETRY_MS))
  }, [active, inUse, ids, retry])
}

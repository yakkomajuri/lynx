# Writing a Lynx custom tool

A custom tool is one JavaScript file that calls other tools. It is global: once saved it is a tool
on the `tools` connector, callable by every workspace UI, every agent, other custom tools, and
schedules. Use one when several tool calls belong together, when the result of one decides the
next, or when something should happen on a schedule without an agent in the loop.

```js
// check_new_prs
export const description = 'Start a review agent for each open PR that has not been reviewed yet.'
export const input = {
  repo: { type: 'string', description: 'owner/name' },
}

export default async function ({ repo }) {
  const [owner, name] = repo.split('/')
  const prs = await call('github', 'list_pull_requests', { owner, repo: name, state: 'open' })
  const started = []
  for (const pr of prs) {
    // Claim the PR first: created is false when a previous run already took it.
    const { created } = await db.put('pr-reviews/seen', `${repo}#${pr.number}`, { title: pr.title }, { ifAbsent: true })
    if (!created) continue
    const { session } = await call('agents', 'session_start', { harness: 'claude', prompt: `Review PR #${pr.number} in ${repo}.` })
    started.push({ pr: pr.number, session: session.id })
  }
  console.log(`${prs.length} open, ${started.length} new`)
  return { started }
}
```

Save it with `tool_save` on the `app` connector (`{ name, source }`). It is refused, with the
reason, if the code does not load. Tools are files in the tools folder (`tool_list` returns `dir`),
one `<name>.js` each; editing a file there works too.

## The file

- `export default` an async function. It receives the input object and its return value (any JSON)
  is the tool's result.
- `export const description`: what the tool does, for whoever picks it from a list.
- `export const input`: the input's properties as JSON Schema, or a whole schema
  (`{ type: 'object', properties, required }`) when some are required.
- The name is lower-case letters, digits and underscores: `check_new_prs`.

## What the code can do

Plain modern JavaScript, with no network, files, timers, imports or Node. The only way out is:

- `call(connector, tool, args)` → the tool's data, exactly what `connector_call` on the `app`
  connector returns. `connector` is a connector **id** (`connector_list`); there are no workspace
  aliases here. It throws an `Error` with the tool's message when the tool fails.
- `db.get(collection, key)`, `db.put(collection, key, value, { ifAbsent })`,
  `db.delete(collection, key)`, `db.query(collection, { where, prefix, order_by, desc, limit })`.
- `files.get(name)`, `files.put(name, text)`, `files.list(prefix)`, `files.delete(name)`.
- `tools.other_tool(args)`: another custom tool.
- `notify(workspace, text, link)`: tell the user. It adds to the unread count beside that workspace
  (its **id**) and to the notifications drawer; `link` is optional, a page of that workspace
  (`"/prs/42"`) or an http(s) address, opened when the notification is clicked.
- `console.log(...)`: kept with the run.

**Never guess what a tool returns.** Look first: `connector_tools` for the input schema, then
`connector_call` for a real response. Many servers answer with text, not JSON.

Limits: 15 minutes per run (one connector call gives up after 5 minutes without progress, 10 at
most), 200 calls per run, about a second of computing between calls, 64 MB of memory, tools calling
tools at most 4 deep. Nothing is kept in memory between runs; what must
survive goes in the store.

## The store

`db` and `files` are one store for the whole app, shared with every workspace and agent. Name
collections for what they hold (`pr-reviews/seen`, `standup/notes`), so a workspace UI can show
what a tool recorded. Every write is kept in a history for 30 days: `db_history` shows who changed
a record, and `db_restore` puts a record, a collection or everything back as it was at a moment.

A schedule can run a tool twice for the same thing (the app was closed, a run was slow). Make that
harmless: claim work with `db.put(..., { ifAbsent: true })` before doing it, as above.

## Telling the user

A scheduled tool runs with nobody watching. When it finds something, `notify` says so where the
user will see it, and takes them to it:

```js
if (started.length) await notify('pr-reviews', `${started.length} new pull requests are being reviewed`, '/reviews')
```

Notify about outcomes, not about every run: a check that found nothing stays quiet.

## Testing

Run the tool once through the `tools` connector (or `connector_call` with `connector: "tools"`).
A failure comes back with the error, where in the code it happened, and what the code printed.
`tool_runs` lists recent runs with who started each, the result or error, console output and every
call made: look there when a scheduled tool misbehaves.

## Schedules

`schedule_save` on the `app` connector: `{ tool, cron, args }`. `cron` is five fields in local
time (`minute hour day-of-month month day-of-week`): `*/10 * * * *` every ten minutes,
`0 9 * * 1-5` weekdays at nine. For anything more often than once a minute, put a seconds field
first (six fields): `*/5 * * * * *` every five seconds, `* * * * * *` every second. A tool that runs
that often should do little and return fast: a run that is still going when the next is due makes
that one wait, and a schedule more often than once a minute also rests for as long as its last run
took. Schedules run while Lynx is open; one that came due while it
was closed runs once at the next launch. A schedule never overlaps itself. `schedule_list` shows
when each runs next and how the last run went.

## Using a tool from a workspace

List it in the workspace's manifest (`"uses": { "tools": ["check_new_prs"] }` in `workspace.json`),
then `call('tools', 'check_new_prs', { repo })` or `useTool('tools', …)` in UI code.

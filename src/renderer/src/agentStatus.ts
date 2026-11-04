// The first-run screen's line under the agents (FirstRun.tsx), on its own so it can be checked without a window.

/** The line under the agents: who is ready, and what the others still need; ok is null while still looking. */
export function agentStatus(agents: { title: string; state: 'ready' | 'out' | 'missing' }[], loading: boolean): { ok: boolean | null; text: string } {
  if (loading) return { ok: null, text: 'Looking for agents on this Mac…' }
  const names = (list: typeof agents) => list.map((a) => a.title).join(' and ')
  const ready = agents.filter((a) => a.state === 'ready')
  const out = agents.filter((a) => a.state === 'out')
  const missing = agents.filter((a) => a.state === 'missing')
  if (ready.length) {
    const rest = [out.length ? `${names(out)} ${out.length > 1 ? "aren't" : "isn't"} signed in yet.` : '', missing.length ? `${names(missing)} ${missing.length > 1 ? "aren't" : "isn't"} installed.` : ''].filter(Boolean).join(' ')
    return { ok: true, text: `${names(ready)} ${ready.length > 1 ? 'are' : 'is'} ready.${rest ? ` ${rest}` : ''}` }
  }
  if (out.length) return { ok: false, text: `Sign in to ${out.map((a) => a.title).join(' or ')} to continue.` }
  return { ok: false, text: 'Lynx needs Claude Code or Codex to be installed and logged in on this Mac to work.' }
}

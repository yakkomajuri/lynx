// Shared by every UI frame, agent and custom tool. Nothing here persists credentials or results.
import { createHash } from 'node:crypto'
import { readRequest, type ReadRequest } from '../shared/reads'
import { isRateLimited } from './connectorTrace'

export interface ResponsePolicy {
  ok: boolean
  retryMs?: number
}

/** Honor upstream delays. MCP servers often include Retry-After in their error text instead. */
export function retryDelay(error: unknown, headers: Record<string, string> = {}, status?: number, now = Date.now()): number | undefined {
  if (status !== undefined && status !== 429 && status !== 403) return undefined
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error)
  // HTTP status is authoritative: successful bodies may discuss rate limits or issue #429.
  const evidence = isRateLimited(error) || isRateLimited(text)
  const limited = status === undefined ? evidence : status === 429 || (status === 403 && (evidence || headers['x-ratelimit-remaining'] === '0' || !!headers['retry-after']))
  if (!limited) return undefined
  const delays: number[] = []
  const after = headers['retry-after']
  if (after) {
    const ms = /^\d+(\.\d+)?$/.test(after.trim()) ? Number(after) * 1000 : Date.parse(after) - now
    if (Number.isFinite(ms)) delays.push(ms)
  }
  if (headers['x-ratelimit-remaining'] === '0' && headers['x-ratelimit-reset']) {
    const ms = Number(headers['x-ratelimit-reset']) * 1000 - now
    if (Number.isFinite(ms)) delays.push(ms)
  }
  const hint = /retry[ -]after\s*:?\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?|minutes?|m)\b/i.exec(text ?? '')
  if (hint) delays.push(Number(hint[1]) * (hint[2] === 'ms' ? 1 : /^(m|minute)/.test(hint[2]!) ? 60_000 : 1000))
  return delays.length ? Math.max(1000, ...delays) : 60_000
}

interface Answer { at: number; json: string; bytes: number }
interface State {
  answers: Map<string, Answer>
  pending: Map<string, Promise<unknown>>
  until: number
  strikes: number
  writes: number
}

export function externalRequests(opts: { now?: () => number; maxEntries?: number; maxBytes?: number } = {}) {
  const now = opts.now ?? Date.now
  const states = new Map<string, State>()
  const lru = new Map<Answer, { state: State; key: string }>()
  let bytes = 0
  const stateOf = (id: string) => {
    let s = states.get(id)
    if (!s) states.set(id, (s = { answers: new Map(), pending: new Map(), until: 0, strikes: 0, writes: 0 }))
    return s
  }
  const clear = (s: State) => {
    for (const a of s.answers.values()) { bytes -= a.bytes; lru.delete(a) }
    s.answers.clear()
    // Existing calls may finish, but new reads must not join a pre-mutation request.
    s.pending.clear()
  }
  const check = (id: string) => {
    const remaining = stateOf(id).until - now()
    if (remaining > 0) throw new Error(`${id} is rate limited. Retry after ${Math.ceil(remaining / 1000)} seconds.`)
  }
  const limit = (id: string, retryMs: number) => {
    const s = stateOf(id)
    // Concurrent failures belong to one cooldown; repeated failures after it expires back off.
    const delay = now() < s.until ? retryMs : Math.max(retryMs, Math.min(15 * 60_000, retryMs * 2 ** Math.min(s.strikes++, 10)))
    s.until = Math.max(s.until, now() + Math.max(1000, delay))
    clear(s)
  }
  const reset = (id: string) => {
    const s = states.get(id)
    if (s) clear(s)
    states.delete(id)
  }
  const keyOf = (tool: string, args: Record<string, unknown>) => createHash('sha256').update(JSON.stringify([tool, args], (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v)).digest('hex')

  return {
    check, limit, reset,
    observe: (id: string) => {
      const s = stateOf(id)
      return (retryMs: number) => { if (states.get(id) === s) limit(id, retryMs) }
    },
    remaining: (id: string) => Math.max(0, stateOf(id).until - now()),
    async run<T>(id: string, tool: string, args: Record<string, unknown>, readOnly: boolean, read: ReadRequest | undefined, run: () => Promise<T>, inspect: (result: T) => ResponsePolicy): Promise<T> {
      check(id)
      const s = stateOf(id)
      const key = keyOf(tool, args)
      const query = readRequest(read)
      if (readOnly) {
        const answer = s.answers.get(key)
        if (query && !query.fresh && answer && now() - answer.at < query.staleMs) {
          lru.delete(answer); lru.set(answer, { state: s, key })
          return JSON.parse(answer.json) as T
        }
        const pending = s.pending.get(key)
        if (pending) return structuredClone(await pending) as T
      } else {
        clear(s)
        s.writes++
      }
      let work: Promise<T>
      work = Promise.resolve().then(run).then((result) => {
        const policy = inspect(result)
        // A reconfigured connector's old requests cannot populate caches or apply old cooldowns.
        if (states.get(id) !== s) return result
        if (policy.retryMs !== undefined) limit(id, policy.retryMs)
        else if (policy.ok && now() >= s.until) s.strikes = 0
        if (readOnly && policy.ok && !s.writes && s.pending.get(key) === work && now() >= s.until) {
          const json = JSON.stringify(result)
          const size = Buffer.byteLength(json)
          if (size <= (opts.maxBytes ?? 8 * 1024 * 1024)) {
            const previous = s.answers.get(key)
            if (previous) { bytes -= previous.bytes; lru.delete(previous) }
            const answer = { at: now(), json, bytes: size }
            s.answers.set(key, answer); lru.set(answer, { state: s, key }); bytes += size
            while (lru.size > (opts.maxEntries ?? 128) || bytes > (opts.maxBytes ?? 8 * 1024 * 1024)) {
              const [oldest, location] = lru.entries().next().value!
              lru.delete(oldest); location.state.answers.delete(location.key); bytes -= oldest.bytes
            }
          }
        }
        return result
      }, (error) => {
        const delay = retryDelay(error, {}, undefined, now())
        if (delay !== undefined && states.get(id) === s) limit(id, delay)
        throw error
      }).finally(() => {
        if (s.pending.get(key) === work) s.pending.delete(key)
        if (!readOnly) { clear(s); s.writes-- }
      })
      if (readOnly) s.pending.set(key, work)
      return work
    },
  }
}

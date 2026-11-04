// A conversation's events as the items its transcript draws: messages, runs of tool calls, notes,
// and the cards to finish connecting a connector an agent touched.
import type { SessionEvent } from './agents'
import { invocationStep, previewField, resultStep, type ToolStep } from './toolviews'

export type Item =
  | { kind: 'user'; e: SessionEvent }
  | { kind: 'assistant'; e: SessionEvent; last?: boolean }
  | { kind: 'tools'; key: string; steps: ToolStep[] }
  | { kind: 'note'; key: string; tone: 'bad' | 'muted'; text: string; /** It failed for want of a sign-in. */ auth?: boolean }
  | { kind: 'connect'; key: string; connector: string }
  | { kind: 'marketplace'; key: string; stage?: string }

const CONNECTOR_TOOL = /(^|__)connector_(add|update|reconnect)$/
const resultJson = (v: unknown): any => {
  // A result that kept structured content beside its blocks: the blocks are what the tool said.
  if (v && typeof v === 'object' && !Array.isArray(v) && 'structuredContent' in v) return (v as any).structuredContent != null ? (v as any).structuredContent : resultJson((v as any).content)
  const text = typeof v === 'string' ? v : Array.isArray(v) ? v.map((c: any) => c?.text ?? '').join('') : ''
  try {
    return text ? JSON.parse(text) : v
  } catch {
    return null
  }
}

export function toItems(events: SessionEvent[]): Item[] {
  const items: Item[] = []
  const byId = new Map<string, ToolStep>()
  const stageByStep = new Map<string, string>()
  // A connect card goes right after the call that first touched the connector, and stays there for
  // the rest of the conversation: one card per connector, however often it is touched again.
  const connects = new Set<string>()
  const marketplaceCards = new Set<string>()
  const placeConnect = (connector: string, seq: string) => {
    if (connects.has(connector)) return
    connects.add(connector)
    items.push({ kind: 'connect', key: `connect-${seq}`, connector })
  }
  for (const e of events) {
    const p = e.payload ?? {}
    if (e.type === 'user_message') items.push({ kind: 'user', e })
    else if (e.type === 'assistant_message') items.push({ kind: 'assistant', e })
    else if (e.type === 'tool_invocation') {
      // History shortens a long call to a preview of its JSON: what it was is read off the start,
      // and the rest is fetched when it is opened.
      const cut = (e as { payload_truncated?: boolean }).payload_truncated && typeof p.preview === 'string' ? (p.preview as string) : undefined
      const step: ToolStep = cut
        ? {
            key: e.seq,
            name: previewField(cut, 'name') ?? 'tool',
            kind: previewField(cut, 'kind'),
            input: undefined,
            inputRef: e.seq,
            lead: previewField(cut, 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'connector', 'tool'),
          }
        : { key: e.seq, ...invocationStep(p) }
      const id = cut ? previewField(cut, 'id') : p.id
      if (id) byId.set(id, step)
      if (/(^|__)marketplace_submit$/.test(step.name)) {
        const stage = cut ? previewField(cut, 'stage') : resultJson(step.input)?.stage
        if (typeof stage === 'string') stageByStep.set(step.key, stage)
      }
      const last = items.at(-1)
      if (last?.kind === 'tools') last.steps.push(step)
      else items.push({ kind: 'tools', key: e.seq, steps: [step] })
    } else if (e.type === 'tool_result') {
      // { id, output, is_error }, or before that Claude Code's tool_result block or Codex's whole item.
      const cut = (e as { payload_truncated?: boolean }).payload_truncated && typeof p.preview === 'string' ? (p.preview as string) : undefined
      const step = byId.get(cut ? (previewField(cut, 'id', 'tool_use_id') ?? '') : (p.tool_use_id ?? p.id))
      if (step && cut) {
        // A long result: fetched in full when the call is opened.
        step.resultRef = e.seq
        step.isError = /"is_error":true/.test(cut)
      } else if (step) {
        Object.assign(step, resultStep(p))
        // An agent touched a connector: show the card the user finishes connecting with.
        const id = CONNECTOR_TOOL.test(step.name) && !step.isError ? resultJson(step.result)?.id : undefined
        if (typeof id === 'string') placeConnect(id, e.seq)
      }
      // The host reads current stage state, not the tool's report. Long reports are truncated in
      // history; the short invocation still identifies the stage whose approval card belongs here.
      if (step && !step.isError && /(^|__)marketplace_(account|submit)$/.test(step.name)) {
        const data = resultJson(step.result)
        const stage = /marketplace_submit$/.test(step.name) ? stageByStep.get(step.key) ?? data?.id : undefined
        const key = stage ?? 'account'
        if ((typeof stage === 'string' || /marketplace_account$/.test(step.name)) && !marketplaceCards.has(key)) {
          marketplaceCards.add(key)
          items.push({ kind: 'marketplace', key: `marketplace-${e.seq}`, stage })
        }
      }
    } else if (e.type === 'failed' || e.type === 'unknown')
      items.push({ kind: 'note', key: e.seq, tone: 'bad', text: p.error?.message ?? (e.type === 'unknown' ? 'The run was interrupted and its outcome is unknown.' : 'The run failed.'), auth: p.error?.code === 'auth' })
    else if (e.type === 'cancelled' || e.type === 'interrupted') items.push({ kind: 'note', key: e.seq, tone: 'muted', text: e.type === 'cancelled' ? 'Stopped.' : 'Interrupted.' })
  }
  // The copy action belongs to the last message of each answer.
  let answer: Extract<Item, { kind: 'assistant' }> | null = null
  for (const it of items) {
    if (it.kind === 'assistant') answer = it
    else if (it.kind === 'user') {
      if (answer) answer.last = true
      answer = null
    }
  }
  if (answer) answer.last = true
  const ordered: Item[] = []
  let cards: Item[] = []
  for (const item of items) {
    if (item.kind === 'user') { ordered.push(...cards); cards = [] }
    if (item.kind === 'marketplace') cards.push(item)
    else ordered.push(item)
  }
  return [...ordered, ...cards]
}

/**
 * For each connector with a card, how many cards the answer it appeared in showed (the cards between
 * two of the user's messages). A card alone carries the conversation on once it connects; when an
 * answer asked for several, the user says when to go on.
 */
export function cardsInTurn(items: Item[]): Map<string, number> {
  const out = new Map<string, number>()
  let turn: string[] = []
  const close = () => {
    for (const id of turn) out.set(id, turn.length)
    turn = []
  }
  for (const it of items) {
    if (it.kind === 'user') close()
    else if (it.kind === 'connect') turn.push(it.connector)
  }
  close()
  return out
}

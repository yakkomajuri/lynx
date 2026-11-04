// Voice mode's model correction: what speech-to-text heard, put right by a small, fast model that is
// told the names Lynx knows (Haiku through the user's Claude Code, or Codex's Luna). The model runs
// in a process kept warm between sentences, so a correction costs the model's answer and no start-up.
// Anything that goes wrong (not signed in, too slow, a strange answer) leaves the words as heard.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeExecutable } from '../agentd/providers/claude-bin'
import { claudeProviderSettings } from '../agentd/providers/claude-settings'
import { codexBin } from '../agentd/providers/codex-bin'

const SYSTEM =
  'You fix speech-to-text transcripts. The user spoke a request to Lynx, a desktop app where an AI agent works with their workspaces and connectors; they often address it by name ("Hey Lynx"), which is easily misheard ("links", "Pay links"). Some words may be misheard, above all product, project and people names; the names the app knows are listed. Replace misheard words only when a known name clearly fits by sound and by meaning, and fix obvious mishearings of ordinary words. Change nothing else: keep their wording, order and tone. Reply with the corrected transcript only, with no quotes, notes or explanation.'
/** LYNX_VOICE_DEBUG=1: each correction in the log, with how long it took. */
const debug = process.env.LYNX_VOICE_DEBUG === '1'
/** Past this, the words go as heard. */
const PATIENCE = 6000

export interface Fixer {
  fix: (prompt: string) => Promise<string>
  close: () => void
}

/** Haiku in a Claude Code process waiting for its next message. It is replaced after a few, so its conversation stays short. */
function claudeFixer(model: string): Fixer {
  const claude = claudeExecutable()
  if (!claude) throw new Error('Claude Code is not installed')
  let uses = 0
  let current: { push: (m: SDKUserMessage) => void; next: () => Promise<IteratorResult<any>>; abort: AbortController } | undefined
  const start = () => {
    const abort = new AbortController()
    let push!: (m: SDKUserMessage) => void
    const waiting: SDKUserMessage[] = []
    let wake: (() => void) | undefined
    push = (m) => {
      waiting.push(m)
      wake?.()
    }
    const inbox = (async function* () {
      while (!abort.signal.aborted) {
        if (!waiting.length) await new Promise<void>((r) => ((wake = r), abort.signal.addEventListener('abort', () => r(), { once: true })))
        const m = waiting.shift()
        if (m) yield m
      }
    })()
    const conversation = query({
      prompt: inbox,
      options: { model, pathToClaudeCodeExecutable: claude, cwd: tmpdir(), settingSources: [], settings: claudeProviderSettings(), strictMcpConfig: true, tools: [], systemPrompt: SYSTEM, persistSession: false, thinking: { type: 'disabled' }, abortController: abort },
    })
    const it = conversation[Symbol.asyncIterator]()
    current = { push, next: () => it.next(), abort }
    uses = 0
  }
  start()
  let line = Promise.resolve('')
  return {
    // One at a time: answers come back in the order asked.
    fix: (prompt) =>
      (line = line.catch(() => '').then(async () => {
        if (!current || uses >= 6) (current?.abort.abort(), start())
        uses++
        const c = current!
        c.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' })
        for (;;) {
          const { value, done } = await c.next()
          if (done) throw new Error('Claude Code stopped')
          if (value?.type === 'result') {
            if (value.subtype !== 'success') throw new Error(String(value.errors?.[0] ?? value.subtype))
            // A usage limit or an API error comes back as a successful result whose text is the error.
            if (value.is_error) throw new Error(String(value.result || 'Claude returned an error'))
            return String(value.result ?? '')
          }
        }
      })),
    close: () => current?.abort.abort(),
  }
}

/** Codex's app-server, kept running; each correction is a thread of its own that is not saved. */
function codexFixer(model: string): Fixer {
  let child: ChildProcessWithoutNullStreams | undefined
  let ready: Promise<void> | undefined
  let id = 1
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  const listeners = new Set<(m: any) => void>()
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const n = id++
      pending.set(n, { resolve, reject })
      child!.stdin.write(JSON.stringify({ id: n, method, params }) + '\n')
    })
  const start = () => {
    const c = spawn(codexBin(), ['-c', 'features.apps=false', '-c', 'features.plugins=false', 'app-server', '--stdio'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    child = c
    c.stderr.resume()
    const gone = (e: Error) => {
      for (const p of pending.values()) p.reject(e)
      pending.clear()
      if (child === c) (child = undefined), (ready = undefined)
    }
    c.on('error', gone)
    c.on('exit', () => gone(new Error('Codex stopped')))
    createInterface({ input: c.stdout }).on('line', (line) => {
      let m: any
      try {
        m = JSON.parse(line)
      } catch {
        return
      }
      if (m.id !== undefined && !m.method) {
        const p = pending.get(Number(m.id))
        pending.delete(Number(m.id))
        if (m.error) p?.reject(new Error(JSON.stringify(m.error)))
        else p?.resolve(m.result)
      } else listeners.forEach((l) => l(m))
    })
    ready = request('initialize', { clientInfo: { name: 'lynx_voice', title: 'Lynx voice', version: '1' } }).then(() => void c.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n'))
  }
  start()
  return {
    fix: async (prompt) => {
      if (!child) start()
      await ready
      const { thread } = await request('thread/start', { model, cwd: tmpdir(), approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: SYSTEM, ephemeral: true, config: { mcp_servers: {}, features: { apps: false, plugins: false } } })
      const answer = new Promise<string>((resolve, reject) => {
        let text = ''
        const l = (m: any) => {
          if (m.params?.threadId !== thread.id) return
          if (m.method === 'item/completed' && m.params.item?.type === 'agentMessage') text = String(m.params.item.text ?? '')
          if (m.method === 'turn/completed') {
            listeners.delete(l)
            if (m.params.turn?.status === 'completed') resolve(text)
            else reject(new Error(m.params.turn?.error?.message ?? 'Codex did not answer'))
          }
        }
        listeners.add(l)
      })
      await request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt, text_elements: [] }], effort: 'low' })
      return answer
    },
    close: () => child?.kill(),
  }
}

/** The corrector in use, made for the agent and model asked for; another asked for replaces it. */
export function makeVoiceFix() {
  let current: { key: string; fixer: Fixer } | undefined
  const fixerFor = (harness: string, model: string) => {
    const key = `${harness}:${model}`
    if (current?.key !== key) {
      current?.fixer.close()
      current = { key, fixer: harness === 'codex' ? codexFixer(model) : claudeFixer(model) }
    }
    return current.fixer
  }
  return {
    /** Starts the model's process before the first sentence needs it. */
    warm: (harness: string, model: string) => void fixerFor(harness, model),
    /** What was heard, corrected; it throws when there is no answer worth taking, and the caller keeps the words as heard. */
    fix: async (req: { harness: string; model: string; text: string; names: string[] }) => {
      const fixer = fixerFor(req.harness, req.model)
      const began = Date.now()
      const prompt = `${req.names.length ? `Known names: ${req.names.join(', ')}\n` : ''}Transcript: ${req.text}`
      let timer: NodeJS.Timeout | undefined
      try {
        const out = await Promise.race([
          fixer.fix(prompt),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Its late answer would be taken for the next sentence's: the next one starts afresh.
              if (current?.fixer === fixer) (fixer.close(), (current = undefined))
              reject(new Error('The model took too long'))
            }, PATIENCE)
          }),
        ])
        const text = out.trim().split('\n')[0]!.replace(/^["“”']+|["“”']+$/g, '').replace(/^Transcript:\s*/i, '').trim()
        // An answer, not a reply to the request: about as long as what was said.
        if (!text || text.length > req.text.length * 1.6 + 30 || text.length < req.text.length * 0.5) throw new Error('The model answered something else')
        if (debug) console.error(`[voice] model ${req.model} in ${Date.now() - began}ms: ${JSON.stringify(req.text)} -> ${text === req.text ? 'unchanged' : JSON.stringify(text)}`)
        return text
      } catch (e) {
        if (debug) console.error(`[voice] model ${req.model} gave up after ${Date.now() - began}ms: ${e instanceof Error ? e.message : String(e)}`)
        throw e
      } finally {
        clearTimeout(timer)
      }
    },
    dispose: () => current?.fixer.close(),
  }
}

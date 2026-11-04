import type { AgentEvent } from './types'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' && value.length > 0

function validRequest(value: unknown) {
  if (!record(value) || typeof value.id !== 'string' || !UUID.test(value.id) || !['approval', 'questions'].includes(value.kind)) return false
  const payload = value.payload
  if (!record(payload) || !text(payload.provider)) return false
  const questions = payload.questions
  if (questions === undefined) return value.kind !== 'questions'
  if (!Array.isArray(questions) || !questions.length) return false
  if (questions.some((q) => !record(q) || !text(q.id) || !text(q.question) || (q.options !== undefined && (!Array.isArray(q.options) || q.options.some((o: unknown) => typeof o !== 'string'))))) return false
  return new Set(questions.map((q) => q.id)).size === questions.length
}

/** Check worker-owned control messages before they can change stored state. */
export function validEvent(value: unknown): value is AgentEvent {
  if (!record(value) || !text(value.type) || !('payload' in value)) return false
  if (value.text !== undefined && typeof value.text !== 'string') return false
  const payload = value.payload
  switch (value.type) {
    case 'provider_session':
      return record(payload) && text(payload.id)
    case 'agent_completed':
      return record(payload) && typeof payload.success === 'boolean'
    case 'input_ack':
      return record(payload) && typeof payload.id === 'string' && UUID.test(payload.id)
    case 'input_stale':
      return record(payload) && typeof payload.id === 'string' && UUID.test(payload.id) && typeof payload.reason === 'string'
    case 'input_request':
      return validRequest(payload)
    default:
      // Provider-specific events stay open-ended.
      return true
  }
}

/** Splits worker output into lines, bounded so one runaway line cannot exhaust memory. */
export class WorkerLines {
  private parts: string[] = []
  private bytes = 0
  private dropping = false
  constructor(
    private readonly limit: number,
    private readonly line: (line: string) => void,
    private readonly oversized: (preview: string) => void,
    private readonly fragment: (text: string) => void,
  ) {}
  write(text: string) {
    let start = 0
    for (;;) {
      const newline = text.indexOf('\n', start)
      const part = text.slice(start, newline < 0 ? undefined : newline)
      if (!this.dropping) {
        this.bytes += Buffer.byteLength(part)
        if (this.bytes > this.limit) {
          const preview = (this.parts.join('') + part).slice(0, 1024)
          this.parts = []
          this.bytes = 0
          this.dropping = true
          this.oversized(preview)
        } else this.parts.push(part)
      }
      if (newline < 0) return
      if (!this.dropping) this.line(this.parts.join(''))
      this.parts = []
      this.bytes = 0
      this.dropping = false
      start = newline + 1
    }
  }
  end() {
    if (!this.dropping && this.bytes) this.fragment(this.parts.join(''))
    this.parts = []
    this.bytes = 0
  }
}

import { randomUUID } from 'node:crypto'
import type { Ask, Emit, InputResponse } from './types'

/** Responses travel over stdin; only this live worker can acknowledge delivery. */
export function inputChannel(emit: Emit, runSignal: AbortSignal) {
  const pending = new Map<
    string,
    { resolve: (response: InputResponse) => void; reject: (error: Error) => void; cleanup: () => void }
  >()
  const ask: Ask = async (kind, payload, signal = runSignal) => {
    if (signal.aborted || runSignal.aborted) throw new Error('Input request cancelled')
    const id = randomUUID()
    let resolve!: (response: InputResponse) => void, reject!: (error: Error) => void
    const response = new Promise<InputResponse>((yes, no) => {
      resolve = yes
      reject = no
    })
    // Cancellation may happen while the request is being flushed.
    response.catch(() => {})
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      runSignal.removeEventListener('abort', abort)
    }
    const abort = () => {
      pending.delete(id)
      cleanup()
      reject(new Error('Input request cancelled'))
      void emit({ type: 'input_stale', payload: { id, reason: 'Provider cancelled the request' } }).catch(
        () => {},
      )
    }
    pending.set(id, { resolve, reject, cleanup })
    signal.addEventListener('abort', abort, { once: true })
    runSignal.addEventListener('abort', abort, { once: true })
    try {
      await emit({ type: 'input_request', payload: { id, kind, payload } })
      return await response
    } finally {
      pending.delete(id)
      cleanup()
    }
  }
  return {
    ask,
    respond: async (id: string, response: InputResponse) => {
      const waiter = pending.get(id)
      if (!waiter) {
        await emit({ type: 'input_stale', payload: { id, reason: 'Worker no longer has this request' } })
        return
      }
      pending.delete(id)
      try {
        // Keep cancellation wired while acknowledgement is flushing. A failed
        // acknowledgement must reject the provider waiter rather than orphan it.
        await emit({ type: 'input_ack', payload: { id } })
        waiter.resolve(response)
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)))
        throw error
      } finally {
        waiter.cleanup()
      }
    },
  }
}

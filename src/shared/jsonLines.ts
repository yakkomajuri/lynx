// Newline-delimited JSON between processes. JSON.stringify leaves U+2028 and U+2029 (line and
// paragraph separators) as they are, and Node's readline ends a line at each of them, so a message
// with one pasted in gets cut in two. Lines are written with them escaped and read split on \n only.
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g')

/** One message as a line: JSON with the separators escaped, ending in \n. */
export const jsonLine = (value: unknown) => JSON.stringify(value).replace(SEPARATORS, (c) => '\\u' + c.charCodeAt(0).toString(16)) + '\n'

export interface LineReader extends EventEmitter {
  /** Stops reading: no more lines, then 'close'. */
  close(): void
}

/** Like readline's interface for 'line', 'close' and close(), but a line ends only at \n (or \r\n). */
export function readLines(input: Readable): LineReader {
  const out = new EventEmitter() as LineReader
  const decoder = new StringDecoder('utf8')
  let rest = ''
  let closed = false
  const take = (text: string) => {
    rest += text
    let start = 0
    for (let end = rest.indexOf('\n'); end >= 0 && !closed; end = rest.indexOf('\n', start)) {
      const line = rest.slice(start, end)
      start = end + 1
      out.emit('line', line.endsWith('\r') ? line.slice(0, -1) : line)
    }
    rest = rest.slice(start)
  }
  const onData = (chunk: Buffer | string) => take(typeof chunk === 'string' ? chunk : decoder.write(chunk))
  const finish = (flush: boolean) => {
    if (closed) return
    if (flush) {
      take(decoder.end())
      if (rest && !closed) out.emit('line', rest)
    }
    closed = true
    rest = ''
    input.off('data', onData)
    input.off('end', onEnd)
    input.off('close', onEnd)
    out.emit('close')
  }
  const onEnd = () => finish(true)
  out.close = () => {
    finish(false)
    input.pause()
  }
  input.on('data', onData)
  input.on('end', onEnd)
  input.on('close', onEnd)
  return out
}

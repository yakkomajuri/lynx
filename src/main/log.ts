// What the processes say, kept with the time, so a slow or failed start can be read afterwards. The
// window, opened from the Finder, has nowhere to print: its lines go to <data>/lynx.log. lynxd prints
// to lynxd.log already (its output is that file); its lines get the time too, and a note when its event
// loop stalls (a service that stops answering looks stuck to the window, which replaces it).
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { format } from 'node:util'

const MAX = 2 * 1024 * 1024
const LEVELS = ['log', 'info', 'warn', 'error'] as const

/** Every console line also goes to `file`, as `<time> <name>[pid] <line>`. */
export function keepLog(file: string, name: string) {
  try {
    if (existsSync(file) && statSync(file).size > MAX) renameSync(file, `${file}.1`)
  } catch {
    /* logs are best effort */
  }
  for (const level of LEVELS) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try {
        appendFileSync(file, `${new Date().toISOString()} ${name}[${process.pid}] ${format(...args)}\n`)
      } catch {
        /* a full disk must not take the app down */
      }
    }
  }
}

/** Console lines start with the time. */
export function stampConsole() {
  for (const level of LEVELS) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => original(new Date().toISOString(), ...args)
  }
}

/** Says when the event loop was held up for more than `ms` (checked every second). */
export function watchStalls(name: string, ms = 2000) {
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const late = now - last - 1000
    if (late > ms) console.error(`[${name}] the event loop was blocked for ${(late / 1000).toFixed(1)}s`)
    last = now
  }, 1000).unref()
}

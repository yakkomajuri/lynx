// Caffeinate in the command bar: macOS's own `caffeinate`, run in the background for some hours so
// the Mac does not sleep. It is its own process and outlives the app (an update's restart included);
// a small file remembers which one is ours (its pid, and when that process started and what it runs), so a
// later window can show it and stop it, and never mistakes another process that got the pid for it.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_HOURS, MIN_HOURS } from '@shared/caffeinate'

/** The `caffeinate` arguments for a run: idle and system sleep held off for `hours`. */
export const caffeinateArgs = (hours: number) => ['-ims', '-t', String(Math.round(hours * 3600))]

const CAFFEINATE = '/usr/bin/caffeinate'

/** What tells a process apart from a later one with its pid: when it started, and the program it runs; null when there is none. */
export function identity(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,comm='], { encoding: 'utf8', timeout: 2000 }).trim()
    return out || null
  } catch {
    return null
  }
}

export function makeCaffeinate(dataDir: string) {
  const file = join(dataDir, 'caffeinate.json')
  const read = (): { pid: number; until: number; id: string } | null => {
    try {
      const r = JSON.parse(readFileSync(file, 'utf8'))
      return typeof r?.pid === 'number' && typeof r?.until === 'number' && typeof r?.id === 'string' ? r : null
    } catch {
      return null
    }
  }
  /** The run recorded, while it is still going: its end not passed, and its pid still the very process started (not one that got the pid after it ended, or after a restart). */
  const going = () => {
    const r = read()
    return r && r.until > Date.now() && identity(r.pid) === r.id ? r : null
  }
  /** When the run going ends (ms since the epoch); null when none is, the record of one that is over cleared. */
  const status = (): number | null => {
    const r = going()
    if (r) return r.until
    rmSync(file, { force: true })
    return null
  }
  const stop = (): null => {
    const r = going()
    if (r) {
      try {
        process.kill(r.pid, 'SIGTERM')
      } catch {}
    }
    rmSync(file, { force: true })
    return null
  }
  /** Starts a run of `hours`, in place of one going; answers when it ends. */
  const start = (hours: number): Promise<number> => {
    if (!(hours >= MIN_HOURS && hours <= MAX_HOURS)) return Promise.reject(new Error(`Pick between 1 minute and ${MAX_HOURS} hours`))
    stop()
    return new Promise((resolve, reject) => {
      const child = spawn(CAFFEINATE, caffeinateArgs(hours), { detached: true, stdio: 'ignore' })
      child.once('error', (e) => reject(new Error(`caffeinate did not start: ${e.message}`)))
      child.once('spawn', () => {
        child.unref()
        const until = Date.now() + Math.round(hours * 3600) * 1000
        const id = identity(child.pid!)
        // What is not caffeinate under its pid by now (gone already) is no run to remember.
        if (!id?.endsWith(` ${CAFFEINATE}`)) return reject(new Error('caffeinate ended as soon as it started'))
        writeFileSync(file, JSON.stringify({ pid: child.pid, until, id }))
        resolve(until)
      })
    })
  }
  return { status, start, stop }
}

// Folders the app follows for changes made outside it (agents writing files, a settings file edited by hand). On macOS a
// folder is watched through FSEvents, which the whole system shares: when it runs short (many apps and tools watching
// at once) a watch fails with EMFILE, when it starts or later as an 'error' event, and unhandled that took the whole
// process down. Here a watch that fails is started again a little later, and what it may have missed meanwhile is
// reported as a change with no file name: anything may have changed.
import { watch, type FSWatcher } from 'node:fs'

export interface Following {
  close: () => void
}

/** Calls `onChange` with the file that changed (relative to `path`), or null when it is not known which. */
export function follow(path: string, opts: { recursive?: boolean; label: string; retryMs?: number; start?: typeof watch }, onChange: (file: string | null) => void): Following {
  const start = opts.start ?? watch
  let watcher: FSWatcher | undefined
  let timer: NodeJS.Timeout | undefined
  let closed = false
  let failing = false
  const begin = () => {
    if (closed) return
    try {
      watcher = start(path, { recursive: !!opts.recursive }, (_event, file) => onChange(file == null ? null : String(file)))
      watcher.on('error', fail)
    } catch (e) {
      return fail(e)
    }
    if (failing) {
      failing = false
      console.error(`[watch] ${opts.label}: following again`)
      onChange(null)
    }
  }
  function fail(e: unknown) {
    watcher?.close()
    watcher = undefined
    if (closed) return
    if (!failing) console.error(`[watch] ${opts.label}: ${e instanceof Error ? e.message : String(e)}; trying again`)
    failing = true
    clearTimeout(timer)
    timer = setTimeout(begin, opts.retryMs ?? 2000)
    timer.unref?.()
  }
  begin()
  return {
    close: () => {
      closed = true
      clearTimeout(timer)
      watcher?.close()
    },
  }
}

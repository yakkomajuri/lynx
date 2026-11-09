// A workspace runs in its own frame on its own origin (sbw://<id>), so its code, styles and
// crashes stay its own. This is the other end of the kit's postMessage transport.
// A new version loads in a second frame, out of sight and unable to take the keyboard, while the one
// before stays on screen; once it is up it takes that one's place, and the old one fades out over it.
import { useEffect, useRef, useState } from 'react'
import { onAppChange } from '@kit/core'
import { bridge, stageFile } from './api'
import { boundCombos, onShortcuts } from './keymap'

const routeKey = (workspace: string) => `sb.route.${workspace}`
const savedRoute = (workspace: string) => localStorage.getItem(routeKey(workspace)) ?? '/'
/** Forgets the page each workspace not among these was on: one made later under the same id starts at its own first page. */
export const forgetRoutes = (workspaces: string[]) => {
  const keep = new Set(workspaces.map(routeKey))
  for (const key of Object.keys(localStorage)) if (key.startsWith(routeKey('')) && !keep.has(key)) localStorage.removeItem(key)
}
const src = (workspace: string, version: number) => `sbw://${workspace}/?v=${version}#${savedRoute(workspace)}`

/** How long a frame has to say whether it is busy; one built with an older kit never says, and is not. */
const ASK_MS = 300
/** How often a held version looks again for a moment it can go on screen. */
const RECHECK_MS = 1000
/** From a new version saying it is up to it going on screen: its first render lands meanwhile. */
const SETTLE_MS = 120
/** A new version that loads but never says it is up (a page that failed to build its bundle) goes on screen after this. */
const SILENT_MS = 1500
/** How long the old version takes to fade out over the new one (host.css, .h-ghost.leaving). */
const FADE_MS = 160
/** How many times a loading version follows the user to another page before it goes on screen anyway, and how long it has to get there each time. */
const FOLLOW_TRIES = 5
const FOLLOW_MS = 1000
/** After a change-over, how long the keyboard the new version takes by itself is given back. */
const GRACE_MS = 1000

/** One version's frame: on screen, loading out of sight, or fading out over the one that replaced it. */
interface Page {
  key: number
  src: string
  phase: 'shown' | 'loading' | 'leaving'
  /** Where it sits while it is not the one on screen: over that one, exactly. */
  rect?: { left: number; top: number; width: number; height: number }
}
const rectOf = (el: HTMLElement) => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

export interface FrameHandle {
  send: (type: string, payload?: Record<string, unknown>) => void
  /** Puts a held version on screen now. */
  update: () => void
  /** Where the frame on screen is, in the window. */
  rect: () => DOMRect | null
}

export function Frame({ workspace, version, mayHold, pinned, onHeld, onPost, onRoute, handle }: { workspace: string; version: number; /** Whether a new version may wait while the user is busy in the frame; not while the keyboard is in the agent panel. */ mayHold: boolean; /** A new version waits whatever else: Point is on. */ pinned: boolean; /** A new version waits (its number), or none does (null). */ onHeld?: (version: number | null) => void; onPost: (type: string, payload: Record<string, any>) => void; onRoute?: (path: string, above: string[]) => void; handle?: { current: FrameHandle | null } }) {
  const [pages, setPages] = useState<Page[]>(() => [{ key: 0, src: src(workspace, version), phase: 'shown' }])
  const els = useRef(new Map<number, HTMLIFrameElement>())
  const keys = useRef(0)
  const shownKey = useRef(0)
  // The version loading out of sight, if one is, and what it said that is for the page on screen (its
  // title, say): the window hears that once it is the one on screen.
  const loadingKey = useRef<number | null>(null)
  const loadingVersion = useRef(0)
  // Asked for (Update now): it goes on screen whatever the user is doing.
  const loadingForced = useRef(false)
  const saidWhileLoading = useRef<[string, Record<string, any>][]>([])
  // The page the loading version is at, as it last said: it only counts once that version is on screen, and
  // the user may have gone to another page in the one on screen meanwhile.
  const loadingRoute = useRef<{ path: string; above: string[] } | null>(null)
  const routeWaiter = useRef<((path: string) => void) | null>(null)
  const shownEl = () => els.current.get(shownKey.current) ?? null
  const ours = (el: Element | null) => [...els.current.values()].some((f) => f === el)
  // Where the keyboard was, outside the workspace, when a new version began loading: a page that takes the
  // keyboard as it starts (a chat's message box) gives it back, until a while after it is on screen.
  const keep = useRef<{ el: HTMLElement; until: number } | null>(null)
  // Whether the page on screen is up (has said so).
  const ready = useRef(false)
  const [loaded, setLoaded] = useState(version)
  // A version built while the user was busy in the frame: the one before stays on screen until they are not.
  const [held, setHeld] = useState<number | null>(null)
  // As last reported; undefined until the first page is up, which then reports that nothing waits (a window
  // closed while a version waited would otherwise leave the service thinking it still does).
  const heldRef = useRef<number | null | undefined>(undefined)
  const may = useRef(mayHold)
  may.current = mayHold
  const pin = useRef(pinned)
  pin.current = pinned
  const onHeldRef = useRef(onHeld)
  onHeldRef.current = onHeld
  const reportHeld = (v: number | null) => {
    if (heldRef.current === v) return
    heldRef.current = v
    setHeld(v)
    onHeldRef.current?.(v)
    void bridge.held({ workspace, version: v })
  }
  const answers = useRef(new Map<number, (busy: boolean) => void>())
  const asked = useRef(0)
  /** Whether the user is in the middle of something in the frame that a reload would lose. */
  const busy = () =>
    new Promise<boolean>((resolve) => {
      const win = shownEl()?.contentWindow
      if (!win || !ready.current) return resolve(false)
      const id = ++asked.current
      const timer = setTimeout(() => (answers.current.delete(id), resolve(false)), ASK_MS)
      answers.current.set(id, (b) => (clearTimeout(timer), answers.current.delete(id), resolve(b)))
      win.postMessage({ sb: 1, type: 'busy?', id }, '*')
    })
  const dropLoading = () => {
    loadingKey.current = null
    saidWhileLoading.current = []
    loadingRoute.current = null
    keep.current = null
    setPages((ps) => ps.filter((p) => p.phase !== 'loading'))
  }
  const load = (v: number, forced = false) => {
    if (typeof heldRef.current === 'number') reportHeld(null)
    setLoaded(v)
    const el = shownEl()
    // Nothing on screen yet worth keeping up: load in its place.
    if (!el || !ready.current) {
      dropLoading()
      if (el) el.src = src(workspace, v)
      return
    }
    const key = ++keys.current
    loadingKey.current = key
    loadingVersion.current = v
    loadingForced.current = forced
    saidWhileLoading.current = []
    loadingRoute.current = null
    const at = document.activeElement
    keep.current = at instanceof HTMLElement && at !== document.body && !ours(at) ? { el: at, until: Infinity } : null
    setPages((ps) => [...ps.filter((p) => p.phase !== 'loading'), { key, src: src(workspace, v), phase: 'loading', rect: rectOf(el) }])
  }
  /**
   * A version that loaded out of sight goes on screen, unless the user started typing in the one on screen,
   * or turned Point on, while it loaded: then it waits like any other.
   */
  const settle = async (key: number) => {
    if (loadingKey.current !== key) return
    // Sent to the user's page first: that can take a while, and they may start typing meanwhile.
    await followNavigation(key)
    if (loadingKey.current !== key) return
    const wait = !loadingForced.current && (pin.current || (may.current && (await busy())))
    if (loadingKey.current !== key) return
    if (!wait) return swap(key)
    const v = loadingVersion.current
    dropLoading()
    reportHeld(v)
  }
  /** The user went to another page while a version loaded: it goes there too, before it is seen. */
  const followNavigation = async (key: number) => {
    // The user may move on again while it gets there: then it follows again.
    for (let tries = 0; tries < FOLLOW_TRIES && loadingKey.current === key; tries++) {
      if (!loadingRoute.current || loadingRoute.current.path === savedRoute(workspace)) return
      await followOnce(key)
    }
  }
  const followOnce = (key: number) =>
    new Promise<void>((resolve) => {
      const want = savedRoute(workspace)
      const win = els.current.get(key)?.contentWindow
      // A workspace without pages never says where it is.
      if (!win || !loadingRoute.current || loadingRoute.current.path === want) return resolve()
      const timer = setTimeout(() => ((routeWaiter.current = null), resolve()), FOLLOW_MS)
      routeWaiter.current = (path) => path === want && (clearTimeout(timer), (routeWaiter.current = null), resolve())
      // In place of where it is: that is not a page the user went to, so not one for Back.
      win.postMessage({ sb: 1, type: 'navigate', to: want, replace: true }, '*')
    })
  /** The version that loaded out of sight goes on screen; the one before fades out over it. */
  const swap = (key: number) => {
    if (loadingKey.current !== key) return
    loadingKey.current = null
    const said = saidWhileLoading.current
    saidWhileLoading.current = []
    const at = loadingRoute.current
    loadingRoute.current = null
    const old = shownEl()
    const oldKey = shownKey.current
    const hadKeys = !!old && document.activeElement === old
    const rect = old ? rectOf(old) : undefined
    shownKey.current = key
    ready.current = true
    if (keep.current) keep.current.until = Date.now() + GRACE_MS
    setPages((ps) => ps.flatMap((p): Page[] => (p.key === key ? [{ key, src: p.src, phase: 'shown' as const }] : p.key === oldKey && rect ? [{ ...p, phase: 'leaving' as const, rect }] : [])))
    setTimeout(() => setPages((ps) => ps.filter((p) => p.key !== oldKey)), FADE_MS + 60)
    // The keyboard was in the old version: it goes on in the new one.
    if (hadKeys) requestAnimationFrame(() => els.current.get(key)?.focus())
    reportHeld(null)
    // Where it is is now where the workspace is; still not where the user is (they kept moving), it goes there.
    const win = els.current.get(key)?.contentWindow
    if (at && at.path === savedRoute(workspace)) route.current?.(at.path, at.above)
    else if (at) win?.postMessage({ sb: 1, type: 'navigate', to: savedRoute(workspace), replace: true }, '*')
    // On screen now: it takes up the pages the user went through, for Back.
    win?.postMessage({ sb: 1, type: 'shown' }, '*')
    for (const [type, m] of said) post.current(type, m)
    post.current('ready', {})
  }
  const post = useRef(onPost)
  post.current = onPost
  const route = useRef(onRoute)
  route.current = onRoute
  // The keys the frame hands over to the window rather than keeping: every shortcut's.
  const sendShortcuts = (win = shownEl()?.contentWindow) => win?.postMessage({ sb: 1, type: 'shortcuts', combos: boundCombos() }, '*')
  if (handle) handle.current = { send: (type, payload = {}) => shownEl()?.contentWindow?.postMessage({ sb: 1, type, ...payload }, '*'), update: () => typeof heldRef.current === 'number' && load(heldRef.current, true), rect: () => shownEl()?.getBoundingClientRect() ?? null }

  useEffect(() => {
    if (version === loaded) return
    // The first page load already waited for the first build; do not load it twice.
    if (loaded === 0 && ready.current) return void setLoaded(version)
    let gone = false
    void (async () => {
      const wait = pin.current || (may.current && (await busy()))
      if (gone) return
      if (wait) {
        // An older version on its way in would take what the user is typing with it.
        dropLoading()
        reportHeld(version)
      } else load(version)
    })()
    return () => void (gone = true)
  }, [version, loaded, workspace])

  // While a version waits it goes on screen as soon as the user is not busy, or the keyboard moves to the agent; never while Point is on.
  useEffect(() => {
    if (held === null || pinned) return
    if (!mayHold) return void load(held)
    let gone = false
    const look = () => void busy().then((b) => !b && !gone && heldRef.current === held && load(held))
    look()
    const timer = setInterval(look, RECHECK_MS)
    return () => {
      gone = true
      clearInterval(timer)
    }
  }, [held, mayHold, pinned])
  useEffect(() => {
    const giveBack = () =>
      setTimeout(() => {
        const k = keep.current
        if (!k || Date.now() > k.until || !k.el.isConnected) return void (keep.current = null)
        if (ours(document.activeElement)) k.el.focus()
      })
    // A press anywhere in the window is the user's own move.
    const pressed = () => void (keep.current = null)
    window.addEventListener('blur', giveBack)
    document.addEventListener('focusin', giveBack, true)
    document.addEventListener('pointerdown', pressed, true)
    return () => {
      window.removeEventListener('blur', giveBack)
      document.removeEventListener('focusin', giveBack, true)
      document.removeEventListener('pointerdown', pressed, true)
    }
  }, [])
  // A version still waiting when the frame goes is not on screen anywhere: it loads when the workspace is shown again.
  useEffect(() => () => void (typeof heldRef.current === 'number' && bridge.held({ workspace, version: null })), [workspace])

  useEffect(() => {
    const keyOf = (w: MessageEventSource | null) => [...els.current].find(([, el]) => el.contentWindow === w)?.[0]
    const onMessage = (e: MessageEvent) => {
      const key = keyOf(e.source)
      const win = e.source as Window | null
      const m = e.data
      if (key === undefined || !win || !m || m.sb !== 1) return
      const shown = key === shownKey.current
      if (!shown && key !== loadingKey.current) {
        // The user went to another page just as the version they were on gave way: the new one follows.
        if (m.type === 'route' && String(m.path) !== savedRoute(workspace)) {
          localStorage.setItem(routeKey(workspace), String(m.path))
          shownEl()?.contentWindow?.postMessage({ sb: 1, type: 'navigate', to: String(m.path) }, '*')
        }
        // Otherwise a version fading out has nothing more to say.
        return
      }
      if (m.type === 'call') {
        void bridge
          .call({ workspace, connector: String(m.connector), tool: String(m.tool), args: m.args ?? {}, read: m.read })
          .catch((err) => ({ ok: false as const, error: String(err?.message ?? err) }))
          .then((r) => win.postMessage({ sb: 1, type: 'result', id: m.id, ...r }, '*'))
      } else if (m.type === 'stage') {
        // A file the user dropped or pasted in the workspace, for its agent.
        void (m.file instanceof File ? stageFile(m.file) : Promise.reject(new Error('Not a file')))
          .then(
            (data) => ({ ok: true as const, data }),
            (err) => ({ ok: false as const, error: String(err?.message ?? err) }),
          )
          .then((r) => win.postMessage({ sb: 1, type: 'result', id: m.id, ...r }, '*'))
      } else if (m.type === 'busy') answers.current.get(Number(m.id))?.(!!m.busy)
      else if (m.type === 'ready' && !shown) {
        // A crash while it renders comes after this, and is its own.
        void bridge.runtimeError({ workspace, error: null })
        // Dressed before it is seen: the keys it hands over.
        sendShortcuts(win)
        setTimeout(() => void settle(key), SETTLE_MS)
      } else if (m.type === 'ready') {
        ready.current = true
        // A fresh page is the newest version: nothing waits.
        reportHeld(null)
        void bridge.runtimeError({ workspace, error: null })
        sendShortcuts()
        win.postMessage({ sb: 1, type: 'shown' }, '*')
        post.current('ready', m)
      } else if (m.type === 'error') void bridge.runtimeError({ workspace, error: String(m.error).slice(0, 4000) })
      else if (m.type === 'route' && !shown) {
        loadingRoute.current = { path: String(m.path), above: Array.isArray(m.above) ? m.above.map(String) : [] }
        routeWaiter.current?.(loadingRoute.current.path)
      } else if (m.type === 'route') {
        localStorage.setItem(routeKey(workspace), String(m.path))
        route.current?.(String(m.path), Array.isArray(m.above) ? m.above.map(String) : [])
      } else if (m.type === 'pointer' && m.how === 'press') {
        keep.current = null
        if (shown) post.current(m.type, m)
      } else if (m.type === 'pointer' && keep.current && Date.now() <= keep.current.until) {
        // The page took the keyboard by itself as it started: that is not the user moving to it.
      } else if (m.type === 'warning' || m.type === 'pointer') {
        // Nothing for the window: a promise nobody caught, or the page taking the keyboard as it loaded.
        if (shown && m.type === 'pointer') post.current(m.type, m)
      } else if (shown) post.current(m.type, m)
      else saidWhileLoading.current.push([m.type, m])
    }
    window.addEventListener('message', onMessage)
    const off = onAppChange((change) => els.current.forEach((el) => el.contentWindow?.postMessage({ sb: 1, type: 'changed', ...change }, '*')))
    const offKeys = onShortcuts(() => sendShortcuts())
    return () => {
      window.removeEventListener('message', onMessage)
      off()
      offKeys()
    }
  }, [workspace])

  // In the order they were made, whatever their phase: moving a frame in the page reloads it.
  return (
    <>
      {pages.map((p) => (
        <iframe
          key={p.key}
          ref={(el) => void (el ? els.current.set(p.key, el) : els.current.delete(p.key))}
          className={`${p.phase === 'shown' ? 'h-frame' : `h-ghost ${p.phase}`}`}
          style={p.rect}
          // Out of sight it cannot be clicked or tabbed to (its code can still take the keyboard: see `keep`).
          inert={p.phase !== 'shown'}
          aria-hidden={p.phase !== 'shown' || undefined}
          data-workspace={p.phase === 'shown' ? workspace : undefined}
          title={workspace}
          src={p.src}
          onLoad={p.phase === 'loading' ? () => setTimeout(() => void settle(p.key), SILENT_MS) : undefined}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
          allow="clipboard-write"
        />
      ))}
    </>
  )
}

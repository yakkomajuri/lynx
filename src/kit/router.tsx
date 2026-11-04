// Pages inside a workspace. A workspace has an address like a URL (/users/42?tab=events): lists
// link to detail pages, Back works, and the address survives rebuilds and restarts.
import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type ComponentType, type ReactNode } from 'react'
import { getTransport } from './core'

const read = () => {
  const raw = location.hash.replace(/^#/, '') || '/'
  return raw.startsWith('/') ? raw : `/${raw}`
}
const subscribe = (l: () => void) => {
  window.addEventListener('hashchange', l)
  return () => window.removeEventListener('hashchange', l)
}
// Every route pattern the workspace has declared, so the window can tell which parts of an
// address are pages of their own and offer them as breadcrumbs.
const patterns = new Set<string>()
/** The pages above this one: for /wiki/acme/web/topic/auth, ["/wiki/acme/web"] when that is a route. */
function above(path: string): string[] {
  const parts = path.split('?')[0]!.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) {
    const p = `/${parts.slice(0, i).join('/')}`
    if ([...patterns].some((pattern) => !pattern.includes('*') && matchPath(pattern, p))) out.push(p)
  }
  return out
}
let reporting = false
function report() {
  if (reporting) return
  reporting = true
  const post = () => getTransport().post('route', { path: read(), above: above(read()) })
  window.addEventListener('hashchange', post)
  window.addEventListener('message', (e) => {
    const m = e.data
    if (e.source !== window.parent || !m || m.sb !== 1) return
    // `replace`: a version loading out of sight sent where the user is, which is not a page of its own.
    if (m.type === 'navigate') navigate(String(m.to), { replace: !!m.replace })
    else if (m.type === 'back') history.back()
  })
  post()
}

/** Name the current page. The window's breadcrumbs show it instead of the raw address, here and on pages below this one. */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    getTransport().post('title', { title: title ?? '', path: read() })
  }, [title])
}

/** Go to a page of this workspace. `to` is a path like "/users/42" or "/users?plan=pro". */
export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const target = `#${to.startsWith('/') ? to : `/${to}`}`
  if (opts.replace) {
    // The same address changes nothing, and says nothing.
    replacing = target !== location.hash
    location.replace(target)
  } else location.hash = target
}

// The pages the user went through, kept where a new version of the workspace finds them: its frame is a new
// one, with no history of its own, but the same session storage. A frame only keeps them there once the
// window says it is the one on screen (a new version loads out of sight first, and the user may go on
// through pages in the one on screen meanwhile); then it takes them up, and starts with the same Back.
const HISTORY = 'sb.history'
let replacing = false
export function keepHistory() {
  let stack = [read()]
  let at = 0
  let onScreen = false
  history.replaceState({ sbAt: 0 }, '')
  const save = () => {
    if (!onScreen) return
    try {
      sessionStorage.setItem(HISTORY, JSON.stringify({ stack, at }))
    } catch {
      /* storage refused: Back after an update starts afresh */
    }
  }
  const takeUp = () => {
    if (onScreen) return
    onScreen = true
    const here = read()
    try {
      const saved = JSON.parse(sessionStorage.getItem(HISTORY) ?? 'null')
      // Only when they end where this page is, and it has no pages of its own yet: a frame opened elsewhere
      // starts a history of its own.
      if (at === 0 && Array.isArray(saved?.stack) && Number.isInteger(saved.at) && saved.at > 0 && saved.stack[saved.at] === here) {
        stack = saved.stack.slice(0, saved.at + 1).map(String)
        at = saved.at
        history.replaceState({ sbAt: 0 }, '', `#${stack[0]}`)
        for (let i = 1; i <= at; i++) history.pushState({ sbAt: i }, '', `#${stack[i]}`)
      }
    } catch {
      /* none kept */
    }
    save()
  }
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && e.data?.sb === 1 && e.data.type === 'shown') takeUp()
  })
  window.addEventListener('hashchange', () => {
    const i = history.state?.sbAt
    if (replacing) replacing = false
    // Back or forward to a page already in the list.
    else if (typeof i === 'number') at = i
    else stack = stack.slice(0, ++at)
    stack[at] = read()
    history.replaceState({ sbAt: at }, '')
    save()
  })
}
export const back = () => history.back()

/** `/users/:id` against `/users/42` -> { id: '42' }; null when it does not match. A trailing `*` matches the rest. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean)
  const have = path.split('?')[0]!.split('/').filter(Boolean)
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!
    if (w === '*') {
      params['*'] = have.slice(i).map(decodeURIComponent).join('/')
      return params
    }
    const h = have[i]
    if (h === undefined) return null
    if (w.startsWith(':')) params[w.slice(1)] = decodeURIComponent(h)
    else if (w !== h) return null
  }
  return want.length === have.length ? params : null
}

export interface Route {
  /** e.g. "/users/42" */
  path: string
  /** e.g. { tab: 'events' } */
  query: Record<string, string>
  navigate: typeof navigate
  back: () => void
  /** Update query parameters in place (null removes one) without adding a history entry. */
  setQuery: (patch: Record<string, string | null>) => void
}
export function useRoute(): Route {
  const full = useSyncExternalStore(subscribe, read)
  useEffect(report, [])
  const [path = '/', search = ''] = full.split('?')
  const query = Object.fromEntries(new URLSearchParams(search))
  return {
    path,
    query,
    navigate,
    back,
    setQuery: (patch) => {
      const next = new URLSearchParams(search)
      for (const [k, v] of Object.entries(patch)) v === null ? next.delete(k) : next.set(k, v)
      const s = next.toString()
      navigate(s ? `${path}?${s}` : path, { replace: true })
    },
  }
}

/**
 * Render the page for the current address.
 *   <Routes routes={{ '/': Home, '/users': Users, '/users/:id': User }} />
 * Each page receives its path parameters as props, plus `query`.
 */
export function Routes({ routes, fallback }: { routes: Record<string, ComponentType<any>>; fallback?: ReactNode }) {
  for (const pattern of Object.keys(routes)) patterns.add(pattern)
  const route = useRoute()
  for (const [pattern, Page] of Object.entries(routes)) {
    const params = matchPath(pattern, route.path)
    if (params) return <Page {...params} query={route.query} />
  }
  return <>{fallback ?? <div className="sb-empty">No page at {route.path}</div>}</>
}

/** A link to another page of this workspace. */
export function Link({ to, replace, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean }) {
  return (
    <a
      {...rest}
      href={`#${to}`}
      onClick={(e) => {
        rest.onClick?.(e)
        if (e.defaultPrevented || e.metaKey || e.ctrlKey) return
        e.preventDefault()
        navigate(to, { replace })
      }}
    >
      {children}
    </a>
  )
}

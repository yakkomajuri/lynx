// ⌘F: the browser's own find, over the workspace on screen. A page's find counts the text in its own fields, so
// the bar is a small page of its own laid over the window; the window keeps the find to the workspace's frame
// itself (src/renderer/src/find.ts). Typing in the bar goes to the window, which runs the find through here.
import { BrowserWindow, ipcMain, WebContentsView, type WebContents } from 'electron'
import type { AppEvent, FindPlace, FindResult } from '@shared/types'

/** The bar's page, with room around it for its shadow. */
const WIDTH = 380
const HEIGHT = 64
const PAD = 12
/** From the frame's top right corner to the bar. */
const INSET = 10

interface Bar {
  win: BrowserWindow
  view: WebContentsView | null
  loaded: Promise<unknown>
  /** The finds the window waits on, by request. */
  waiting: Map<number, () => void>
  /** The latest result, which an update without a count or a current match carries on from. */
  last: FindResult
}
const bars = new Map<WebContents, Bar>()
const barOf = (view: WebContents) => [...bars.values()].find((b) => b.view?.webContents === view)

export function attachFind(win: BrowserWindow) {
  const wc = win.webContents
  const bar: Bar = { win, view: null, loaded: Promise.resolve(), waiting: new Map(), last: { matches: 0, active: 0 } }
  bars.set(wc, bar)
  wc.on('found-in-page', (_e, r) => {
    const result = { matches: r.matches >= 0 ? r.matches : bar.last.matches, active: r.activeMatchOrdinal >= 0 ? r.activeMatchOrdinal : bar.last.active }
    bar.last = result
    bar.view?.webContents.send('find:result', result)
    if (r.finalUpdate) settle(bar, r.requestId)
  })
  win.on('closed', () => {
    bars.delete(wc)
    if (bar.view && !bar.view.webContents.isDestroyed()) bar.view.webContents.close()
  })
}

/** Made the first time it is wanted. */
function viewOf(bar: Bar, preload: string) {
  if (bar.view) return bar.view
  const view = new WebContentsView({ webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  view.webContents.on('will-navigate', (e) => e.preventDefault())
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  bar.win.contentView.addChildView(view)
  bar.loaded = view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch((e) => console.error(`[find] the bar did not load: ${e}`))
  return (bar.view = view)
}

const settle = (bar: Bar, request?: number) => {
  for (const [id, done] of bar.waiting) if (request === undefined || id === request) done(), bar.waiting.delete(id)
}

/** Shows the bar over a frame, or hides it (null). */
export async function placeFind(wc: WebContents, p: FindPlace, preload: string) {
  const bar = bars.get(wc)
  if (!bar) return
  if (!p) return void bar.view?.setVisible(false)
  const view = viewOf(bar, preload)
  await bar.loaded
  if (view.webContents.isDestroyed()) return
  const z = wc.getZoomFactor()
  view.webContents.setZoomFactor(z)
  const { x, y, width } = p.frame
  const w = Math.min(WIDTH, width + PAD * 2 - INSET * 2)
  view.setBounds({ x: Math.round((x + width - INSET + PAD - w) * z), y: Math.round((y + INSET - PAD) * z), width: Math.round(w * z), height: Math.round(HEIGHT * z) })
  view.webContents.send('find:show', { colors: p.colors, focus: !!p.focus, text: p.text, result: bar.last })
  view.setVisible(true)
  if (p.focus) view.webContents.focus()
}

/** Finds text in the window: the first match from the top for new text, or the next or previous one. Done once the matches are counted. */
export function find(wc: WebContents, req: { text: string; step?: boolean; forward?: boolean }) {
  const bar = bars.get(wc)
  if (!bar) return
  if (!req.text) {
    wc.stopFindInPage('clearSelection')
    bar.last = { matches: 0, active: 0 }
    bar.view?.webContents.send('find:result', bar.last)
    return
  }
  // findNext starts a new search (Electron's name for it), which new text is; a step goes on with the one there is.
  const id = wc.findInPage(req.text, { forward: req.forward ?? true, findNext: !req.step })
  return new Promise<void>((done) => {
    bar.waiting.set(id, done)
    // A find that never finishes must not leave the window waiting (and the rest of it inert).
    setTimeout(() => settle(bar, id), 1500)
  })
}

/** Closes the bar: the highlights go, and the keyboard goes back to the window. */
export function stopFind(wc: WebContents) {
  const bar = bars.get(wc)
  if (!bar) return
  wc.stopFindInPage('keepSelection')
  settle(bar)
  bar.last = { matches: 0, active: 0 }
  if (bar.view) {
    const focused = bar.view.webContents.isFocused()
    bar.view.setVisible(false)
    if (focused) wc.focus()
  }
}

// What the bar's page says goes to the window it is over, which does the finding.
const fromBar = (channel: string, event: (arg: unknown) => AppEvent) =>
  ipcMain.on(channel, (e, arg) => {
    const bar = barOf(e.sender)
    if (bar && !bar.win.isDestroyed()) bar.win.webContents.send('sb:event', event(arg))
  })
fromBar('find:query', (text) => ({ t: 'find', text: String(text ?? '') }))
fromBar('find:step', (forward) => ({ t: 'find-step', forward: !!forward }))
fromBar('find:close', () => ({ t: 'find-close' }))

const icon = (paths: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { --surface: #fff; --text: #111; --muted: #666; --line: rgba(0,0,0,.12); --hover: rgba(0,0,0,.06); --shadow: 0 8px 28px rgba(0,0,0,.16); }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { padding: ${PAD}px; box-sizing: border-box; font: 13px ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: var(--text); -webkit-user-select: none; user-select: none; }
  form { display: flex; align-items: center; gap: 2px; height: 100%; box-sizing: border-box; padding: 0 4px 0 10px; background: var(--surface); border-radius: 10px; box-shadow: var(--shadow); }
  .lens { color: var(--muted); display: flex; margin-right: 6px; }
  input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: inherit; font: inherit; padding: 0; }
  input::placeholder { color: var(--muted); }
  output { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; padding: 0 6px; font-size: 12px; }
  .sep { width: 1px; align-self: stretch; margin: 9px 2px; background: var(--line); }
  button { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: 7px; background: none; color: var(--muted); padding: 0; cursor: default; }
  button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
  button:disabled { opacity: .4; }
</style></head>
<body>
<form autocomplete="off" role="search" aria-label="Find in the workspace">
  <span class="lens" aria-hidden="true">${icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')}</span>
  <input id="q" type="text" placeholder="Find in the workspace" spellcheck="false" aria-label="Find">
  <output id="n" aria-live="polite"></output>
  <span class="sep"></span>
  <button type="button" id="prev" title="Previous match (⇧↩)" aria-label="Previous match">${icon('<path d="m18 15-6-6-6 6"/>')}</button>
  <button type="button" id="next" title="Next match (↩)" aria-label="Next match">${icon('<path d="m6 9 6 6 6-6"/>')}</button>
  <button type="button" id="close" title="Close (Esc)" aria-label="Close">${icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')}</button>
</form>
<script>
  const bar = window.findBar, q = document.getElementById('q'), n = document.getElementById('n')
  const prev = document.getElementById('prev'), next = document.getElementById('next')
  let result = { matches: 0, active: 0 }
  const show = () => {
    n.textContent = !q.value ? '' : result.matches ? result.active + ' of ' + result.matches : 'No matches'
    prev.disabled = next.disabled = !q.value || !result.matches
  }
  q.addEventListener('input', () => { result = { matches: 0, active: 0 }; show(); bar.query(q.value) })
  document.querySelector('form').addEventListener('submit', (e) => e.preventDefault())
  prev.addEventListener('click', () => bar.step(false))
  next.addEventListener('click', () => bar.step(true))
  document.getElementById('close').addEventListener('click', () => bar.close())
  addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Escape') bar.close()
    else if (e.key === 'Enter' && !mod) q.value && bar.step(!e.shiftKey)
    else if (mod && e.key.toLowerCase() === 'g') q.value && bar.step(!e.shiftKey)
    else if (mod && e.key.toLowerCase() === 'f') q.select()
    else return
    e.preventDefault()
  })
  bar.onShow((m) => {
    const c = m.colors, root = document.documentElement.style
    root.colorScheme = c.scheme
    for (const k of ['surface', 'text', 'muted', 'line', 'hover', 'shadow']) root.setProperty('--' + k, c[k])
    if (typeof m.text === 'string' && m.text !== q.value) q.value = m.text
    result = m.result
    show()
    if (m.focus) { q.focus(); q.select() }
  })
  bar.onResult((r) => { result = r; show() })
</script>
</body></html>`

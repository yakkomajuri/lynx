// A template's files, to read before forking it, or a workspace's own, laid out the way VS Code lays out a folder:
// the explorer down the left, tabs and breadcrumbs over Monaco, a status bar under it. Read-only. Every file is a
// model of its own, so going to a definition crosses files as it would in an editor. A search looks through names
// and contents, and marks what it finds in the file on screen. Light or dark as the app is, in VS Code's colours.
// Loaded only when someone opens it: Monaco is big.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import { Braces, ChevronRight, ChevronsDownUp, CodeXml, File as FileIcon, FileCode2, FileImage, FileText, FolderOpen, Hash, Lock, Search, X } from 'lucide-react'
import { comboOf, sameCombo, type Combo } from '@kit/keys'
import type { MarketplaceItem, WorkspaceInfo } from '@shared/types'
import { app } from './api'
import { boundCombos } from './keymap'

self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === 'typescript' || label === 'javascript' ? new TsWorker() : label === 'json' ? new JsonWorker() : label === 'css' || label === 'scss' || label === 'less' ? new CssWorker() : label === 'html' ? new HtmlWorker() : new EditorWorker(),
}
// Templates are JSX: read as JavaScript with JSX, and without errors for imports it cannot see.
const ts = (monaco.languages as any).typescript
ts?.javascriptDefaults?.setCompilerOptions({ jsx: ts.JsxEmit?.Preserve ?? 1, allowJs: true, allowNonTsExtensions: true, target: ts.ScriptTarget?.ESNext ?? 99, module: ts.ModuleKind?.ESNext ?? 99 })
ts?.javascriptDefaults?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })

// VS Code's Dark Modern and Light Modern, for the editor; the chrome around it takes the same colours (host.css, .h-code).
monaco.editor.defineTheme('lynx-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1f1f1f',
    'editor.foreground': '#cccccc',
    'editor.lineHighlightBorder': '#282828',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#cccccc',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorStickyScroll.background': '#1f1f1f',
    'editorStickyScrollHover.background': '#2a2d2e',
    'editorWidget.background': '#202020',
    'editorWidget.border': '#313131',
    'minimap.background': '#1f1f1f',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464b3',
    'scrollbarSlider.activeBackground': '#bfbfbf66',
    focusBorder: '#0078d4',
  },
})
monaco.editor.defineTheme('lynx-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#3b3b3b',
    'editor.lineHighlightBorder': '#eeeeee',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#171184',
    'editorIndentGuide.background1': '#d3d3d3',
    'editorIndentGuide.activeBackground1': '#939393',
    'editorStickyScroll.background': '#ffffff',
    'editorStickyScrollHover.background': '#f2f2f2',
    'editorWidget.background': '#f8f8f8',
    'editorWidget.border': '#e5e5e5',
    'minimap.background': '#ffffff',
    focusBorder: '#005fb8',
  },
})

interface File {
  path: string
  text: string | null
  size: number
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
// Light or dark, as the app is: its theme says so (--sb-dark), whatever the system is.
const darkNow = (el: Element | null) => getComputedStyle(el ?? document.documentElement).getPropertyValue('--sb-dark').trim() === '1'
// The files a template ships, its code first: the manifest, the UI, then tools and the preview's data.
// A workspace has no manifest, so its App.jsx comes first.
const rank = (p: string) => (p === 'manifest.json' ? 0 : p === 'App.jsx' ? 1 : !p.includes('/') ? 2 : p.startsWith('tools/') ? 4 : p.startsWith('preview/') ? 5 : 3)
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const extOf = (p: string) => (nameOf(p).includes('.') ? nameOf(p).slice(nameOf(p).lastIndexOf('.') + 1).toLowerCase() : '')
// Every folder above a path, the nearest last: a/b/c.js has a and a/b.
const parents = (p: string) => dirOf(p).split('/').filter(Boolean).map((_, i, all) => all.slice(0, i + 1).join('/'))

// An icon and colour per kind of file, as VS Code's file icon theme gives them.
function KindIcon({ path }: { path: string }) {
  const ext = extOf(path)
  const [Icon, color] =
    ext === 'jsx' || ext === 'tsx' ? [FileCode2, '#4fc1ff']
    : ext === 'js' || ext === 'mjs' || ext === 'cjs' ? [FileCode2, '#e8c547']
    : ext === 'ts' || ext === 'mts' ? [FileCode2, '#3c8fd6']
    : ext === 'json' ? [Braces, '#d2b43c']
    : ext === 'css' || ext === 'scss' ? [Hash, '#519aba']
    : ext === 'html' || ext === 'svg' ? [CodeXml, '#e37933']
    : ext === 'md' || ext === 'txt' ? [FileText, '#519aba']
    : /^(png|jpe?g|gif|webp|ico|avif)$/.test(ext) ? [FileImage, '#a074c4']
    : [FileIcon, 'var(--vs-muted)']
  return <Icon size={15} strokeWidth={1.8} className="h-code-kind" style={{ color }} aria-hidden="true" />
}

// What Monaco calls a language, as the status bar names it.
const LANGUAGES: Record<string, string> = { javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', css: 'CSS', scss: 'SCSS', html: 'HTML', markdown: 'Markdown', plaintext: 'Plain Text', yaml: 'YAML', xml: 'XML', shell: 'Shell Script', python: 'Python' }
const languageName = (id: string, path: string) => (id === 'javascript' && extOf(path) === 'jsx' ? 'JavaScript JSX' : id === 'typescript' && extOf(path) === 'tsx' ? 'TypeScript JSX' : (LANGUAGES[id] ?? id))

/** What the app asks of an open inspector: ⌘F and ⌘G find in its code, not in the workspace hidden behind it, and
 * moving between panes (⌘⌥←/→) gives it the keyboard. */
export interface InspectorHandle {
  focus: () => void
  find: () => void
  step: (forward: boolean) => void
}

/** Either a marketplace item or a workspace: whose files to read. */
export type Inspected = { item: MarketplaceItem } | { ws: WorkspaceInfo }

export default function CodeInspector({
  onShortcut,
  onOpenFolder,
  handle,
  ...of
}: Inspected & {
  /** A shortcut of the app pressed in the editor: the app's, not Monaco's. */
  onShortcut: (combo: Combo) => void
  /** Shows the folder in Finder: a button in the explorer's header. */
  onOpenFolder?: () => void
  /** Filled in while the editor is up. */
  handle?: { current: InspectorHandle | null }
}) {
  const [files, setFiles] = useState<File[] | null>(null)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<string>('')
  // The files open in tabs, in the order they were opened.
  const [tabs, setTabs] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [shut, setShut] = useState<Set<string>>(new Set())
  const [dark, setDark] = useState(() => darkNow(null))
  const [cursor, setCursor] = useState({ line: 1, column: 1, selected: 0 })
  const box = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const marks = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const name = 'item' in of ? of.item.name : of.ws.name

  // Opening a file shows it in a tab of its own, after the others.
  const show = (path: string) => {
    setOpen(path)
    setTabs((t) => (t.includes(path) ? t : [...t, path]))
  }
  const closeTab = (path: string) => {
    const at = tabs.indexOf(path)
    const rest = tabs.filter((t) => t !== path)
    setTabs(rest)
    if (path === open) setOpen(rest[Math.min(at, rest.length - 1)] ?? '')
  }

  const refocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const path = refocus.current
    refocus.current = null
    if (path !== null) box.current?.querySelector<HTMLElement>(`.h-code-tabs [role="tab"][data-path="${CSS.escape(path)}"]`)?.focus()
  }, [tabs])

  // Left and right (Home and End) open the tab beside, and take the keyboard there; Delete closes the one focused.
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const at = (e.target as HTMLElement).dataset.path
    const list = e.currentTarget
    if (at === undefined) return
    const i = tabs.indexOf(at)
    const to = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : null
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      const rest = tabs.filter((t) => t !== at)
      closeTab(at)
      // Focused, the closed tab leaves the page: the keyboard goes to the one beside once it has.
      refocus.current = at === open ? (rest[Math.min(i, rest.length - 1)] ?? null) : open
      return
    }
    if (!to) return
    e.preventDefault()
    setOpen(to)
    list.querySelector<HTMLElement>(`[role="tab"][data-path="${CSS.escape(to)}"]`)?.focus()
  }

  // One model per file, under a path of its own, for as long as the inspector is open.
  const base = 'item' in of ? `inmemory://template/${of.item.source}/${of.item.id}/` : `inmemory://workspace/${of.ws.id}/`
  useEffect(() => {
    let live = true
    const load = 'item' in of ? app<{ files: File[] }>('marketplace_files', { item: of.item.id, source: of.item.source }) : app<{ files: File[] }>('workspace_files', { workspace: of.ws.id })
    load.then(
      (r) => {
        if (!live) return
        const sorted = [...r.files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path))
        setFiles(sorted)
        const first = sorted[0]?.path ?? ''
        setOpen(first)
        setTabs(first ? [first] : [])
      },
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => void (live = false)
  }, [base])

  useEffect(() => {
    if (!files) return
    const models = files.filter((f) => f.text !== null).map((f) => monaco.editor.createModel(f.text!, undefined, monaco.Uri.parse(base + f.path)))
    return () => models.forEach((m) => m.dispose())
  }, [files, base])

  // The app's theme can change while it is open: its mode, the system's, or a theme that is always dark.
  useEffect(() => {
    const retheme = () => setDark(darkNow(box.current))
    retheme()
    const scheme = matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', retheme)
    const watch = new MutationObserver(retheme)
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sb-theme'] })
    return () => {
      scheme.removeEventListener('change', retheme)
      watch.disconnect()
    }
  }, [])
  useEffect(() => monaco.editor.setTheme(dark ? 'lynx-dark' : 'lynx-light'), [dark])

  useEffect(() => {
    if (!host.current || !files) return
    const ed = monaco.editor.create(host.current, {
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      theme: darkNow(box.current) ? 'lynx-dark' : 'lynx-light',
      fontFamily: "Menlo, Monaco, 'SF Mono', 'Courier New', monospace",
      fontSize: 12.5,
      lineHeight: 19,
      padding: { top: 4 },
      minimap: { enabled: true, renderCharacters: false, showSlider: 'mouseover' },
      stickyScroll: { enabled: true },
      bracketPairColorization: { enabled: true },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      renderLineHighlight: 'all',
      scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 10, useShadows: false },
      overviewRulerBorder: false,
      fixedOverflowWidgets: true,
      model: null,
    })
    editor.current = ed
    marks.current = ed.createDecorationsCollection()
    if (handle)
      handle.current = {
        // The editor, or with a file that is not text on screen, its tab.
        focus: () => (host.current?.hidden ? box.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], .h-code-search input')?.focus() : ed.focus()),
        find: () => {
          ed.focus()
          void ed.getAction('actions.find')?.run()
        },
        step: (forward) => {
          ed.focus()
          void ed.getAction(forward ? 'editor.action.nextMatchFindAction' : 'editor.action.previousMatchFindAction')?.run()
        },
      }
    const moved = ed.onDidChangeCursorSelection((e) => {
      const s = e.selection
      setCursor({ line: s.positionLineNumber, column: s.positionColumn, selected: ed.getModel()?.getValueLengthInRange(s) ?? 0 })
    })
    // Go to definition into another file opens that file here.
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor: (_src, uri, at) => {
        const path = uri.toString().startsWith(base) ? uri.toString().slice(base.length) : null
        if (!path) return false
        show(path)
        setTimeout(() => {
          if (!at) return
          const r = 'startLineNumber' in at ? at : { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: at.lineNumber, endColumn: at.column }
          ed.setSelection(r)
          ed.revealRangeInCenter(r)
        })
        return true
      },
    })
    return () => {
      moved.dispose()
      opener.dispose()
      ed.dispose()
      editor.current = null
      if (handle) handle.current = null
    }
  }, [files, base])

  // The file on screen, and what the search found in it.
  const needle = query.trim()
  useEffect(() => {
    const ed = editor.current
    if (!ed || !files) return
    const model = monaco.editor.getModel(monaco.Uri.parse(base + open))
    if (ed.getModel() !== model) {
      ed.setModel(model)
      setCursor({ line: 1, column: 1, selected: 0 })
    }
    if (!model) return
    const found = needle ? model.findMatches(needle, false, false, false, null, false) : []
    marks.current?.set(found.map((m) => ({ range: m.range, options: { inlineClassName: 'h-code-hit', overviewRuler: { color: '#f5b400', position: monaco.editor.OverviewRulerLane.Center } } })))
    if (found[0]) ed.revealRangeInCenter(found[0].range)
  }, [open, needle, files, base])

  // The app's shortcuts win over Monaco's (⌘K starts a chord there): taken before the editor sees them.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      const combo = comboOf(e)
      if (!combo || !boundCombos().some((b) => sameCombo(b, combo))) return
      e.preventDefault()
      e.stopPropagation()
      onShortcut(combo)
    }
    el.addEventListener('keydown', onKey, true)
    return () => el.removeEventListener('keydown', onKey, true)
  }, [onShortcut])

  // By name or by what is in it; a file found by its contents says how many times.
  const hits = useMemo(() => {
    const q = needle.toLowerCase()
    if (!files || !q) return null
    const out = new Map<string, number>()
    for (const f of files) {
      const inName = f.path.toLowerCase().includes(q)
      let n = 0
      if (f.text) for (let i = f.text.toLowerCase().indexOf(q); i >= 0; i = f.text.toLowerCase().indexOf(q, i + q.length)) n++
      if (inName || n) out.set(f.path, n)
    }
    return out
  }, [files, needle])
  const shown = files?.filter((f) => !hits || hits.has(f.path)) ?? []
  // A tree, as the explorer shows a folder: folders first, then files, each by name; the top level keeps the
  // files' own order (the code first).
  const folders = [...new Set(shown.flatMap((f) => parents(f.path)))].sort()
  const current = files?.find((f) => f.path === open)
  const model = current && current.text !== null ? monaco.editor.getModel(monaco.Uri.parse(base + current.path)) : null
  const toggle = (dir: string) => setShut((s) => (s.has(dir) ? new Set([...s].filter((x) => x !== dir)) : new Set([...s, dir])))

  const level = (dir: string, depth: number): React.ReactNode => {
    const subs = folders.filter((d) => dirOf(d) === dir)
    const own = shown.filter((f) => dirOf(f.path) === dir)
    if (dir) own.sort((a, b) => a.path.localeCompare(b.path))
    return (
      <>
        {subs.map((d) => {
          const closed = !hits && shut.has(d)
          return (
            <div key={d} role="group" className="h-code-dir">
              <button className="h-code-folder" style={{ '--depth': depth } as React.CSSProperties} aria-expanded={!closed} onClick={() => toggle(d)} title={d}>
                <ChevronRight size={16} strokeWidth={1.6} className={closed ? '' : 'open'} aria-hidden="true" />
                <span>{nameOf(d)}</span>
              </button>
              {!closed && level(d, depth + 1)}
            </div>
          )
        })}
        {own.map((f) => (
          <button key={f.path} className={`h-code-file${f.path === open ? ' on' : ''}${dir ? ' nested' : ''}`} style={{ '--depth': depth } as React.CSSProperties} onClick={() => show(f.path)} title={`${f.path} · ${kb(f.size)}`}>
            <KindIcon path={f.path} />
            <span>{nameOf(f.path)}</span>
            {hits?.get(f.path) ? <span className="h-code-count">{hits.get(f.path)}</span> : null}
          </button>
        ))}
      </>
    )
  }

  return (
    <div ref={box} className={`h-code${dark ? ' dark' : ''}`}>
      <div className="h-code-body">
        <nav className="h-code-files" aria-label="Files">
          <header className="h-code-pane-title">
            <span>Explorer</span>
            <span className="h-code-actions">
              <button onClick={() => setShut(new Set(folders))} aria-label="Collapse folders" title="Collapse folders">
                <ChevronsDownUp size={15} strokeWidth={1.7} />
              </button>
              {onOpenFolder && (
                <button onClick={onOpenFolder} aria-label="Open folder" title="Open folder in Finder">
                  <FolderOpen size={15} strokeWidth={1.7} />
                </button>
              )}
            </span>
          </header>
          <label className="h-code-search">
            <Search size={13} strokeWidth={1.8} aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))} placeholder="Search files and code" aria-label="Search files and code" spellCheck={false} />
          </label>
          <div className="h-code-root" title={name}>
            <ChevronRight size={16} strokeWidth={1.6} className="open" aria-hidden="true" />
            <span>{name}</span>
          </div>
          {error && <div className="sb-error">{error}</div>}
          {!files && !error && <p className="h-code-note">Loading files…</p>}
          {files && !shown.length && <p className="h-code-note">Nothing matches.</p>}
          <div className="h-code-list">{level('', 0)}</div>
        </nav>
        <div className="h-code-main">
          {/* Tabs as VS Code's: one in the tab order (the open one), arrows move between them, Delete closes one. */}
          <div className="h-code-tabs" role="tablist" aria-label="Open files" onKeyDown={onTabKey}>
            {tabs.map((t) => (
              <div key={t} role="presentation" className={`h-code-tab${t === open ? ' on' : ''}`} onAuxClick={(e) => e.button === 1 && closeTab(t)}>
                <button role="tab" aria-selected={t === open} tabIndex={t === open ? 0 : -1} data-path={t} title={t} aria-keyshortcuts="Delete" onClick={() => setOpen(t)}>
                  <KindIcon path={t} />
                  <span>{nameOf(t)}</span>
                </button>
                <button className="h-code-tab-close" tabIndex={-1} aria-label={`Close ${nameOf(t)}`} title="Close (Delete)" onClick={() => closeTab(t)}>
                  <X size={14} strokeWidth={1.8} />
                </button>
              </div>
            ))}
          </div>
          {current && (
            <div className="h-code-crumbs" aria-label="Path">
              {current.path.split('/').map((s, i, all) => (
                <span key={i} className="h-code-crumb">
                  {i === all.length - 1 ? <KindIcon path={current.path} /> : null}
                  {s}
                  {i < all.length - 1 && <ChevronRight size={14} strokeWidth={1.6} aria-hidden="true" />}
                </span>
              ))}
            </div>
          )}
          {current && current.text === null && <p className="h-code-note">{current.path} is not text ({kb(current.size)}), so it is not shown.</p>}
          {files && !current && <p className="h-code-empty">Pick a file in the explorer to read it.</p>}
          <div ref={host} className="h-code-editor" hidden={!current || current.text === null} />
        </div>
      </div>
      <footer className="h-code-status">
        <span className="h-code-status-item">
          <Lock size={12} strokeWidth={2} aria-hidden="true" />
          Read-only
        </span>
        {files && <span className="h-code-status-item">{files.length === 1 ? '1 file' : `${files.length} files`}</span>}
        {model && current && (
          <span className="h-code-status-end">
            <span className="h-code-status-item">
              Ln {cursor.line}, Col {cursor.column}
              {cursor.selected ? ` (${cursor.selected} selected)` : ''}
            </span>
            <span className="h-code-status-item">
              {model.getOptions().insertSpaces ? 'Spaces' : 'Tab Size'}: {model.getOptions().tabSize}
            </span>
            <span className="h-code-status-item">UTF-8</span>
            <span className="h-code-status-item">{model.getEOL() === '\r\n' ? 'CRLF' : 'LF'}</span>
            <span className="h-code-status-item">{kb(current.size)}</span>
            <span className="h-code-status-item">{languageName(model.getLanguageId(), current.path)}</span>
          </span>
        )}
      </footer>
    </div>
  )
}

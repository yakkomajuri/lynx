// Settings that hold for the whole app. The first is the design system: markdown, written by the
// user, that says how workspaces should look. It is a plain file so it can be edited by hand too,
// and agents read it (design_system_get) before they write UI. The rest (the app's theme and layout, and what
// the background service does when the window is closed) is in settings.json beside it.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Effect, Layer } from 'effect'
import { AGENT_PLACES, DEFAULT_LAYOUT, DEFAULT_MODE, DEFAULT_THEME, MODES, THEMES, WORKSPACE_PLACES, isAgentPlace, isMode, isTheme, isWorkspacePlace, type LayoutSettings, type ModeId, type ThemeId } from '@shared/themes'
import { follow } from '../watch'
import type { AppSettings, BackgroundSettings } from '@shared/types'
import { Config } from './Config'
import { Events } from './Events'
import { executionFromEnv, isExecutionLimit, MAX_EXECUTION, readExecution, type ExecutionSettings } from '@shared/execution'

const MAX_DESIGN = 60000

export interface SettingsShape {
  readonly get: () => AppSettings
  /** Where the design system is kept, and when it last changed (null when there is none). */
  readonly designFile: string
  readonly designUpdatedAt: () => string | null
  readonly setDesignSystem: (markdown: string) => AppSettings
  readonly setTheme: (theme: string) => AppSettings
  readonly setMode: (mode: string) => AppSettings
  readonly setBackground: (patch: Partial<BackgroundSettings>) => AppSettings
  readonly setLayout: (patch: Partial<LayoutSettings>) => AppSettings
  readonly setExecution: (patch: Partial<ExecutionSettings>) => AppSettings
  readonly onExecutionChanged: (f: (limits: ExecutionSettings) => void) => () => void
}

export const DEFAULT_BACKGROUND: BackgroundSettings = { keepRunning: true, startAtLogin: false }

export class Settings extends Context.Service<Settings, SettingsShape>()('Settings') {}

export const SettingsLive = Layer.effect(Settings)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const events = yield* Events
    const designFile = join(cfg.dataDir, 'design-system.md')
    const read = () => {
      try {
        return readFileSync(designFile, 'utf8')
      } catch {
        return ''
      }
    }
    let design = read()
    const settingsFile = join(cfg.dataDir, 'settings.json')
    const readFile = (): Record<string, any> => {
      try {
        const saved = JSON.parse(readFileSync(settingsFile, 'utf8'))
        return saved && typeof saved === 'object' ? saved : {}
      } catch {
        return {}
      }
    }
    // A theme this version does not know (a hand edit, a newer version's file) is the default one.
    const readTheme = (): ThemeId => {
      const theme = readFile().theme
      return isTheme(theme) ? theme : DEFAULT_THEME
    }
    const readMode = (): ModeId => {
      const mode = readFile().mode
      return isMode(mode) ? mode : DEFAULT_MODE
    }
    const readBackground = (): BackgroundSettings => {
      const saved = readFile().background ?? {}
      return { keepRunning: typeof saved.keepRunning === 'boolean' ? saved.keepRunning : DEFAULT_BACKGROUND.keepRunning, startAtLogin: typeof saved.startAtLogin === 'boolean' ? saved.startAtLogin : DEFAULT_BACKGROUND.startAtLogin }
    }
    // A place this version does not know is the default one.
    const readLayout = (): LayoutSettings => {
      const saved = readFile().layout ?? {}
      return { workspaces: isWorkspacePlace(saved.workspaces) ? saved.workspaces : DEFAULT_LAYOUT.workspaces, agent: isAgentPlace(saved.agent) ? saved.agent : DEFAULT_LAYOUT.agent }
    }
    // The workspaces were in the title bar unless chosen until the sidebar became the default. An install
    // from then (it has saved settings or made workspaces) that never chose keeps them there. Either way
    // the place is saved on this first launch, so a new install's own workspaces do not later make it look old.
    const installedBefore = () => {
      if (existsSync(settingsFile)) return true
      try {
        return readdirSync(cfg.workspacesDir, { withFileTypes: true }).some((e) => e.isDirectory())
      } catch {
        return false
      }
    }
    const unchosen = !isWorkspacePlace(readFile().layout?.workspaces)
    const keepTitleBar = unchosen && installedBefore()
    let theme = readTheme()
    let mode = readMode()
    let background = readBackground()
    let layout = readLayout()
    if (keepTitleBar) layout = { ...layout, workspaces: 'top' }
    // A saved choice takes precedence over launch-time environment overrides.
    const executionFallback = executionFromEnv(process.env)
    const readLimits = () => readExecution(readFile().execution, executionFallback)
    let execution = readLimits()
    const executionListeners = new Set<(limits: ExecutionSettings) => void>()
    const executionChanged = () => executionListeners.forEach((f) => f(execution))
    // Keep execution as written on disk unless explicitly chosen, so other settings do not
    // turn environment fallbacks into saved overrides (including for partially saved limits).
    // Keys this version does not know are kept.
    const save = (limits?: ExecutionSettings) => writeFileSync(settingsFile, JSON.stringify({ ...readFile(), theme, mode, layout, background, ...(limits ? { execution: limits } : {}) }, null, 2) + '\n')
    if (unchosen) save()
    // The files may be edited outside the app; what agents and the settings page see follows them.
    let timer: NodeJS.Timeout | undefined
    const watcher = follow(cfg.dataDir, { label: 'settings' }, (file) => {
      if (file !== null && file !== 'design-system.md' && file !== 'settings.json') return
      clearTimeout(timer)
      timer = setTimeout(() => {
        const next = read()
        const nextTheme = readTheme()
        const nextMode = readMode()
        const nextBackground = readBackground()
        const nextLayout = readLayout()
        const nextExecution = readLimits()
        const limitsChanged = nextExecution.agents !== execution.agents || nextExecution.shell !== execution.shell
        if (next === design && nextTheme === theme && nextMode === mode && JSON.stringify(nextBackground) === JSON.stringify(background) && JSON.stringify(nextLayout) === JSON.stringify(layout) && !limitsChanged) return
        design = next
        theme = nextTheme
        mode = nextMode
        background = nextBackground
        layout = nextLayout
        execution = nextExecution
        if (limitsChanged) executionChanged()
        Effect.runSync(events.changed)
      }, 150)
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearTimeout(timer)
        watcher.close()
      }),
    )
    const get = (): AppSettings => ({ designSystem: design, theme, mode, layout, background, execution })
    return Settings.of({
      get,
      designFile,
      onExecutionChanged: (f) => {
        executionListeners.add(f)
        return () => executionListeners.delete(f)
      },
      setExecution: (patch) => {
        for (const [k, v] of Object.entries(patch)) {
          if (k !== 'agents' && k !== 'shell') throw new Error(`No execution setting named ${JSON.stringify(k)}. They are: agents, shell`)
          if (v !== undefined && !isExecutionLimit(k, v)) throw new Error(`${k} must be a whole number from 1 to ${MAX_EXECUTION[k]}`)
        }
        const next = { ...execution, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
        const changed = next.agents !== execution.agents || next.shell !== execution.shell
        execution = next
        save(next)
        if (changed) executionChanged()
        Effect.runSync(events.changed)
        return get()
      },
      designUpdatedAt: () => (design && existsSync(designFile) ? statSync(designFile).mtime.toISOString() : null),
      setDesignSystem: (markdown) => {
        if (typeof markdown !== 'string') throw new Error('markdown must be text')
        if (markdown.length > MAX_DESIGN) throw new Error(`The design system is at most ${MAX_DESIGN} characters (this is ${markdown.length}); agents read all of it every time they build`)
        design = markdown.trim() ? markdown : ''
        writeFileSync(designFile, design)
        Effect.runSync(events.changed)
        return get()
      },
      setTheme: (next) => {
        if (!isTheme(next)) throw new Error(`No theme named ${JSON.stringify(next)}. The themes are: ${THEMES.map((t) => t.id).join(', ')}`)
        theme = next
        save()
        Effect.runSync(events.changed)
        return get()
      },
      setMode: (next) => {
        if (!isMode(next)) throw new Error(`No mode named ${JSON.stringify(next)}. The modes are: ${MODES.map((m) => m.id).join(', ')}`)
        mode = next
        save()
        Effect.runSync(events.changed)
        return get()
      },
      setBackground: (patch) => {
        for (const [k, v] of Object.entries(patch)) {
          if (!(k in DEFAULT_BACKGROUND)) throw new Error(`No background setting named ${JSON.stringify(k)}. They are: ${Object.keys(DEFAULT_BACKGROUND).join(', ')}`)
          if (v !== undefined && typeof v !== 'boolean') throw new Error(`${k} is true or false`)
        }
        background = { ...background, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
        save()
        Effect.runSync(events.changed)
        return get()
      },
      setLayout: (patch) => {
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) continue
          if (k === 'workspaces' && !isWorkspacePlace(v)) throw new Error(`The workspaces go in one of: ${WORKSPACE_PLACES.map((p) => p.id).join(', ')}`)
          else if (k === 'agent' && !isAgentPlace(v)) throw new Error(`The agent goes in one of: ${AGENT_PLACES.map((p) => p.id).join(', ')}`)
          else if (!(k in DEFAULT_LAYOUT)) throw new Error(`No layout setting named ${JSON.stringify(k)}. They are: ${Object.keys(DEFAULT_LAYOUT).join(', ')}`)
        }
        layout = { ...layout, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
        save()
        Effect.runSync(events.changed)
        return get()
      },
    })
  }),
)

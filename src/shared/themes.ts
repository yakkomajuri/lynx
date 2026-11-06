// The app's themes. A theme colours what is Lynx's own (the window, the agent panel, settings,
// menus) and leaves every workspace alone, Home included, so the two can be told apart at a
// glance. The colours themselves are in src/kit/themes.css, under the same ids.
export const THEMES = [
  { id: 'classic', name: 'Classic', about: 'Neutral greys, the same as your workspaces.' },
  { id: 'slate', name: 'Slate', about: 'Cool blue-grey.' },
  { id: 'sage', name: 'Sage', about: 'Quiet green.' },
  { id: 'sand', name: 'Sand', about: 'Warm paper.' },
  { id: 'iris', name: 'Iris', about: 'Soft violet.' },
  { id: 'ink', name: 'Ink', about: 'Always dark, in light mode too.' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']
export const DEFAULT_THEME: ThemeId = 'classic'
export const isTheme = (id: unknown): id is ThemeId => THEMES.some((t) => t.id === id)

// Light or dark, for the whole app: its own pages and every workspace in it. "system" follows the OS.
export const MODES = [
  { id: 'system', name: 'System' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
] as const

export type ModeId = (typeof MODES)[number]['id']
export const DEFAULT_MODE: ModeId = 'system'
export const isMode = (id: unknown): id is ModeId => MODES.some((m) => m.id === id)

// Where things sit in the window. The list of workspaces is under the carets beside a workspace's name
// in the title bar, or a column down the left, which then also has the agents running, notifications and
// settings. The agent is a panel beside the workspace, or floats over it, its tabs in a bar along the bottom.
export const WORKSPACE_PLACES = [
  { id: 'top', name: 'Title bar', about: 'A list under the workspace’s name.' },
  { id: 'side', name: 'Sidebar', about: 'A column on the left, with the agents running, notifications and settings.' },
] as const
export const AGENT_PLACES = [
  { id: 'panel', name: 'Beside', about: 'A panel beside the workspace.' },
  { id: 'float', name: 'Floating', about: 'Over the workspace at its right, resizable, opened from a bar along the bottom that holds its tabs and History.' },
] as const

export type WorkspacePlace = (typeof WORKSPACE_PLACES)[number]['id']
export type AgentPlace = (typeof AGENT_PLACES)[number]['id']
export interface LayoutSettings {
  workspaces: WorkspacePlace
  agent: AgentPlace
}
// A new install has the sidebar; installs from before it was the default keep the title bar (Settings.ts).
export const DEFAULT_LAYOUT: LayoutSettings = { workspaces: 'side', agent: 'panel' }
export const isWorkspacePlace = (id: unknown): id is WorkspacePlace => WORKSPACE_PLACES.some((p) => p.id === id)
export const isAgentPlace = (id: unknown): id is AgentPlace => AGENT_PLACES.some((p) => p.id === id)

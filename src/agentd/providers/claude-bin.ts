import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// Claude Code runs from the user's own install (with their login, settings and version), never the
// copy the Agent SDK ships. AGENT_CLAUDE_BIN wins; then PATH; then where the installers put it,
// since an app started from the Dock may not see the shell's PATH.
const KNOWN = [join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin']

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The installed Claude Code, or undefined when there is none. */
export function claudeExecutable(): string | undefined {
  if (process.env.AGENT_CLAUDE_BIN) return process.env.AGENT_CLAUDE_BIN
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...KNOWN]
  return dirs.map((dir) => join(dir, 'claude')).find(executable)
}

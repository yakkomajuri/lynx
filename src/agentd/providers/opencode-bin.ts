import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Use the user's OpenCode install, including apps launched without a shell PATH. */
export function opencodeBin() {
  if (process.env.AGENT_OPENCODE_BIN) return process.env.AGENT_OPENCODE_BIN
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.opencode/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  return dirs.filter(Boolean).map((dir) => join(dir, 'opencode')).find((file) => {
    try { accessSync(file, constants.X_OK); return true } catch { return false }
  }) ?? 'opencode'
}

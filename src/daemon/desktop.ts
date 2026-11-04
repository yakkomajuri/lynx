// What lynxd does on the desktop with no window of its own: start at login, keep the Mac awake while
// agents work, and show notifications nobody is in the app to see.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LOGIN_LABEL = 'dev.lynx.service'

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The launchd job that starts lynxd at login. A crash brings it back; a clean exit (stopped, or another copy already running) does not. */
export function loginPlist(opts: { program: string[]; env: Record<string, string>; log: string }) {
  const strings = (items: string[]) => items.map((s) => `\t\t<string>${xml(s)}</string>`).join('\n')
  const env = Object.entries(opts.env)
    .map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LOGIN_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings(opts.program)}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>LimitLoadToSessionType</key>
\t<string>Aqua</string>
\t<key>StandardOutPath</key>
\t<string>${xml(opts.log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(opts.log)}</string>
</dict>
</plist>
`
}

/** The environment a login-started lynxd gets: what it needs, plus the overrides this one was started
 * with that choose the agent backend and where the agents are (LYNX_*, AGENT_*, AGENTD_*). */
export function loginEnv(from: NodeJS.ProcessEnv, needed: Record<string, string>): Record<string, string> {
  const overrides = Object.entries(from).filter((e): e is [string, string] => typeof e[1] === 'string' && /^(LYNX_|AGENT_|AGENTD_)/.test(e[0]) && !/^LYNX_(DAEMON_|E2E)/.test(e[0]))
  return { ...Object.fromEntries(overrides), ...needed }
}

/** Writes or removes the login item. Only the file: launchd reads it at the next login, and taking a
 * loaded job out now would stop the very service that is running. */
export function syncLoginItem(enabled: boolean, plist: string, dir = join(homedir(), 'Library', 'LaunchAgents')) {
  if (process.platform !== 'darwin') return
  const file = join(dir, `${LOGIN_LABEL}.plist`)
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (enabled && current !== plist) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, plist)
  }
  if (!enabled && current !== null) unlinkSync(file)
}

/** Keeps the Mac from idle sleep while agents work (lid-closed sleep still happens). */
export function stayAwake() {
  let child: ChildProcess | undefined
  return (busy: boolean) => {
    if (process.platform !== 'darwin') return
    if (busy && !child) {
      child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
      child.once('exit', () => (child = undefined))
      child.once('error', () => (child = undefined))
    }
    if (!busy && child) child.kill()
  }
}

/** A notification on the desktop. AppleScript's, as lynxd is not an app macOS knows; text goes in as arguments, never as script. */
export function desktopNotify(text: string, title: string) {
  execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', text, title], () => undefined)
}

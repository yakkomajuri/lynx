// lynxd: Lynx's background service, in its own process so that quitting the window leaves agents,
// schedules and connectors running. The window starts it (or launchd, at login) on Electron's binary
// in Node mode, and talks to it over loopback HTTP (service.ts).
//
//   LYNX_DAEMON_DATA     the data folder (the window's userData)
//   LYNX_DAEMON_ROOT     the app's root: resources/, src/kit
import { join } from 'node:path'
import { fixPath } from '../main/env'
import { stampConsole, watchStalls } from '../main/log'
import { daemonAddress } from '../main/services/Config'
import { desktopNotify, loginEnv, loginPlist, stayAwake, syncLoginItem } from './desktop'
import { EXIT_PORT_TAKEN, dataTag, runningService } from './pid'
import { startService } from './service'

const dataDir = process.env.LYNX_DAEMON_DATA
const appRoot = process.env.LYNX_DAEMON_ROOT
if (!dataDir || !appRoot) {
  console.error('[lynxd] LYNX_DAEMON_DATA and LYNX_DAEMON_ROOT are needed')
  process.exit(2)
}
stampConsole()
watchStalls('lynxd')
const outDir = import.meta.dirname
fixPath()

const log = join(dataDir, 'lynxd.log')
const program = [process.execPath, join(outDir, 'lynxd.js'), dataTag(dataDir)]
const env = loginEnv(process.env, { ELECTRON_RUN_AS_NODE: '1', LYNX_DAEMON_DATA: dataDir, LYNX_DAEMON_ROOT: appRoot })
// Test runs leave the user's login items alone.
const managesLogin = !process.env.LYNX_E2E
const awake = stayAwake()
// The login item is brought in step when the choice changes, and once at start (paths may have moved).
let loginWanted: boolean | undefined

const { port, token } = await daemonAddress(dataDir)
const startedAt = Date.now()
console.error(`[lynxd] starting on ${port} (pid ${process.pid}, ${outDir})`)
const service = startService(
  { dataDir, appRoot, outDir, port, token },
  {
    onBusy: (busy) => !process.env.LYNX_E2E && awake(busy),
    onUnseenNotification: (text, workspace) => (process.env.LYNX_E2E ? console.error(`[lynxd] notification: ${workspace}: ${text}`) : desktopNotify(text, `Lynx · ${workspace}`)),
    onSettings: (settings) => {
      if (!managesLogin || settings.background.startAtLogin === loginWanted) return
      loginWanted = settings.background.startAtLogin
      try {
        syncLoginItem(settings.background.startAtLogin, loginPlist({ program, env, log }))
      } catch (e) {
        console.error('[lynxd] login item', e)
      }
    },
  },
)
service.ready.then(
  () => console.error(`[lynxd] ready on ${port} (pid ${process.pid}) after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`),
  (e) => {
    // The port is taken. By the service for this data (busy, maybe slow to answer): this one is not
    // needed. By anything else: say so, and the window picks another port.
    if (e?.code === 'EADDRINUSE') {
      const other = runningService(dataDir)
      console.error(other ? `[lynxd] already running (pid ${other})` : `[lynxd] port ${port} is taken by something else`)
      process.exit(other ? 0 : EXIT_PORT_TAKEN)
    }
    console.error('[lynxd] could not start', e)
    process.exit(1)
  },
)
service.stopped.then(() => process.exit(0))
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void service.close())
// One failing call must not take every agent with it.
process.on('uncaughtException', (e) => console.error('[lynxd] uncaught', e))
process.on('unhandledRejection', (e) => console.error('[lynxd] unhandled', e))

import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('sb', {
  state: () => ipcRenderer.invoke('sb:state'),
  call: (req: unknown) => ipcRenderer.invoke('sb:call', req),
  runtimeError: (req: unknown) => ipcRenderer.invoke('sb:runtime-error', req),
  held: (req: unknown) => ipcRenderer.invoke('sb:held', req),
  siteIcon: (url: string) => ipcRenderer.invoke('sb:site-icon', url),
  openExternal: (url: string) => ipcRenderer.invoke('sb:open-external', url),
  openPath: (path: string) => ipcRenderer.invoke('sb:open-path', path),
  agentLogin: (harness: string) => ipcRenderer.invoke('sb:agent-login', harness),
  quit: (opts: { stopAgents: boolean }) => ipcRenderer.invoke('sb:quit', opts),
  // Where a dropped file lives on disk; empty for one with no file behind it (pasted, or from a browser).
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  stageFile: (req: unknown) => ipcRenderer.invoke('sb:stage-file', req),
  checkUpdate: () => ipcRenderer.invoke('sb:update-check'),
  installUpdate: () => ipcRenderer.invoke('sb:update-install'),
  restartUpdate: () => ipcRenderer.invoke('sb:update-restart'),
  downloadUpdate: () => ipcRenderer.invoke('sb:update-download'),
  caffeinate: (hours: number | null) => ipcRenderer.invoke('sb:caffeinate', { hours }),
  caffeinateStatus: () => ipcRenderer.invoke('sb:caffeinate-status'),
  usage: (fresh?: boolean) => ipcRenderer.invoke('sb:usage', { fresh }),
  setCloseHere: (keys: unknown) => ipcRenderer.send('sb:close-here', keys),
  recordKeys: (on: boolean) => ipcRenderer.send('sb:record-keys', on),
  find: (req: unknown) => ipcRenderer.invoke('sb:find', req),
  placeFind: (place: unknown) => ipcRenderer.invoke('sb:find-place', place),
  stopFind: () => ipcRenderer.invoke('sb:find-stop'),
  voice: {
    set: (patch: unknown) => ipcRenderer.invoke('sb:voice-set', patch),
    install: (model: string) => ipcRenderer.invoke('sb:voice-install', model),
    remove: (model: string) => ipcRenderer.invoke('sb:voice-remove', model),
    cancel: () => ipcRenderer.invoke('sb:voice-cancel'),
    prepare: () => ipcRenderer.invoke('sb:voice-prepare'),
    start: () => ipcRenderer.invoke('sb:voice-start'),
    stop: () => ipcRenderer.invoke('sb:voice-stop'),
    reset: () => ipcRenderer.invoke('sb:voice-reset'),
    say: (text: string) => ipcRenderer.invoke('sb:voice-say', text),
    hush: () => ipcRenderer.invoke('sb:voice-hush'),
    audio: (samples: Float32Array) => ipcRenderer.send('sb:voice-audio', samples),
    fix: (req: unknown) => ipcRenderer.invoke('sb:voice-fix', req),
    warmFix: (req: unknown) => ipcRenderer.invoke('sb:voice-fix-warm', req),
  },
  onEvent: (handler: (e: unknown) => void) => {
    const l = (_e: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on('sb:event', l)
    return () => {
      ipcRenderer.removeListener('sb:event', l)
    }
  },
  platform: process.platform,
  /** Under test: the first-run screen stays away (see the window's additionalArguments). */
  skipFirstRun: process.argv.includes('--lynx-skip-first-run'),
})

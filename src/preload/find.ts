// The find bar's page (src/main/find.ts): what it types and presses goes to the window, and the matches come back.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('findBar', {
  query: (text: string) => ipcRenderer.send('find:query', text),
  step: (forward: boolean) => ipcRenderer.send('find:step', forward),
  close: () => ipcRenderer.send('find:close'),
  onShow: (handler: (m: unknown) => void) => void ipcRenderer.on('find:show', (_e, m) => handler(m)),
  onResult: (handler: (m: unknown) => void) => void ipcRenderer.on('find:result', (_e, m) => handler(m)),
})

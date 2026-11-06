// Voice mode in the window's process: the models on disk (downloaded when the user picks one in
// settings), and the speech process that runs one while a voice session is on. The microphone is
// the window's page's; its samples come here and go on to the speech process, and what it hears
// goes back to the page as `voice` events.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { app, systemPreferences, utilityProcess, type UtilityProcess } from 'electron'
import { DEFAULT_PAUSE, DEFAULT_VOICE_MODEL, DICTATION_PAUSE, isVoiceModel, isVoicePause, VOICE_PAUSES, VAD_URL, VOICE_MODELS, voiceModel, type VoiceEvent, type VoiceModelId, type VoiceState } from '@shared/voice'

const run = promisify(execFile)
/** How long a loaded model stays in memory after a session ends, so starting again is instant. */
const KEEP_LOADED = 3 * 60_000

export function makeVoice({ dataDir, outDir, onChange, onEvent }: { dataDir: string; outDir: string; onChange: () => void; onEvent: (e: VoiceEvent) => void }) {
  const root = join(dataDir, 'voice')
  const modelsDir = join(root, 'models')
  const vadFile = join(root, 'silero_vad.onnx')
  const settingsFile = join(root, 'voice.json')
  mkdirSync(modelsDir, { recursive: true })
  const saved = (() => {
    try {
      return JSON.parse(readFileSync(settingsFile, 'utf8'))
    } catch {
      return {}
    }
  })()
  let enabled = saved.enabled === true
  let speak = saved.speak === true
  // Off unless chosen: what is said is written into the message box, and the user sends it.
  let autoSend = saved.autoSend === true
  let listenAway = saved.listenAway === true
  let pause = isVoicePause(saved.pause) ? saved.pause : DEFAULT_PAUSE
  /** The quiet that ends what was said: the one picked, or a short one when it is written in to send by hand. */
  const quiet = () => (autoSend ? pause : DICTATION_PAUSE)
  let model: VoiceModelId = isVoiceModel(saved.model) ? saved.model : DEFAULT_VOICE_MODEL
  let download: VoiceState['download']
  let error: string | undefined
  let aborting: AbortController | undefined
  const save = () => writeFileSync(settingsFile, JSON.stringify({ enabled, model, speak, autoSend, pause, listenAway }, null, 2) + '\n')

  // A model is there once it unpacked whole: the marker is written last.
  const dirOf = (id: VoiceModelId) => join(modelsDir, id)
  const installed = (id: VoiceModelId) => existsSync(join(dirOf(id), '.ready')) && existsSync(vadFile)
  const state = (): VoiceState => ({ enabled, model, speak, autoSend, pause, listenAway, installed: VOICE_MODELS.map((m) => m.id).filter(installed), ...(download ? { download } : {}), ...(error ? { error } : {}) })

  let reported = 0
  const progress = (next: VoiceState['download']) => {
    download = next
    // The bar moves a few times a second, not on every chunk.
    if (Date.now() - reported < 250 && next?.phase === 'downloading') return
    reported = Date.now()
    onChange()
  }

  const fetchTo = async (url: string, file: string, signal: AbortSignal, onBytes?: (received: number, total: number) => void) => {
    const res = await fetch(url, { signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status} ${res.statusText})`)
    const total = Number(res.headers.get('content-length')) || 0
    let received = 0
    const body = Readable.fromWeb(res.body as any)
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      onBytes?.(received, total)
    })
    await pipeline(body, createWriteStream(file), { signal })
  }

  /** Downloads a model (and the speech detector, the first time), and unpacks it. One at a time. */
  const install = async (id: VoiceModelId) => {
    if (!isVoiceModel(id)) throw new Error(`No voice model named ${JSON.stringify(id)}`)
    if (download) throw new Error(`${voiceModel(download.model).name} is still downloading`)
    if (installed(id)) return state()
    const m = voiceModel(id)
    const controller = (aborting = new AbortController())
    const archive = join(root, `${id}.download`)
    const unpack = join(root, `${id}.unpacking`)
    error = undefined
    progress({ model: id, received: 0, total: m.download, phase: 'downloading' })
    try {
      if (!existsSync(vadFile)) {
        await fetchTo(VAD_URL, `${vadFile}.download`, controller.signal)
        renameSync(`${vadFile}.download`, vadFile)
      }
      await fetchTo(m.url, archive, controller.signal, (received, total) => progress({ model: id, received, total: total || m.download, phase: 'downloading' }))
      progress({ model: id, received: m.download, total: m.download, phase: 'unpacking' })
      rmSync(unpack, { recursive: true, force: true })
      mkdirSync(unpack, { recursive: true })
      await run('tar', ['xjf', archive, '-C', unpack])
      rmSync(dirOf(id), { recursive: true, force: true })
      renameSync(join(unpack, m.folder), dirOf(id))
      writeFileSync(join(dirOf(id), '.ready'), new Date().toISOString())
    } catch (e) {
      error = controller.signal.aborted ? undefined : `${m.name} did not download: ${e instanceof Error ? e.message : String(e)}`
      if (error) console.error(`[voice] ${error}`)
    } finally {
      rmSync(archive, { force: true })
      rmSync(unpack, { recursive: true, force: true })
      rmSync(`${vadFile}.download`, { force: true })
      download = undefined
      aborting = undefined
      onChange()
    }
    return state()
  }

  /** Settings: voice mode on or off, and the model. Turning it on, or picking a model, downloads what is missing. */
  const set = (patch: { enabled?: boolean; model?: VoiceModelId; speak?: boolean; autoSend?: boolean; pause?: number; listenAway?: boolean }) => {
    if (patch.model !== undefined) {
      if (!isVoiceModel(patch.model)) throw new Error(`No voice model named ${JSON.stringify(patch.model)}`)
      if (patch.model !== model) unload()
      model = patch.model
    }
    if (patch.enabled !== undefined) enabled = !!patch.enabled
    if (patch.speak !== undefined) speak = !!patch.speak
    if (patch.listenAway !== undefined) listenAway = !!patch.listenAway
    const was = quiet()
    if (patch.autoSend !== undefined) autoSend = !!patch.autoSend
    if (patch.pause !== undefined) {
      if (!isVoicePause(patch.pause)) throw new Error(`The pause is one of ${VOICE_PAUSES.join(', ')} seconds`)
      pause = patch.pause
    }
    // A session under way hears the new quiet from its next words.
    if (quiet() !== was) proc?.postMessage({ t: 'pause', seconds: quiet() })
    save()
    onChange()
    if (enabled && !installed(model) && !download) void install(model)
    return state()
  }

  const remove = (id: VoiceModelId) => {
    if (!isVoiceModel(id)) throw new Error(`No voice model named ${JSON.stringify(id)}`)
    if (download?.model === id) aborting?.abort()
    if (id === model) unload()
    rmSync(dirOf(id), { recursive: true, force: true })
    onChange()
    return state()
  }

  // ── the speech process
  // LYNX_VOICE_DEBUG=1: what reaches the speech process, a line a second (chunks, and the loudest), and what it hears.
  const debug = process.env.LYNX_VOICE_DEBUG === '1'
  let flow = { chunks: 0, peak: 0, dropped: 0 }
  if (debug)
    setInterval(() => {
      if (flow.chunks) console.error(`[voice] audio ${flow.chunks} chunks${flow.dropped ? `, ${flow.dropped} dropped (not listening)` : ''}, loudest ${flow.peak.toFixed(3)}`)
      flow = { chunks: 0, peak: 0, dropped: 0 }
    }, 1000).unref()
  let proc: UtilityProcess | undefined
  let loading: Promise<void> | undefined
  let idle: NodeJS.Timeout | undefined
  let listening = false
  const unload = () => {
    clearTimeout(idle)
    proc?.kill()
    proc = undefined
    loading = undefined
  }
  const load = () =>
    (loading ??= new Promise<void>((resolve, reject) => {
      const p = utilityProcess.fork(join(outDir, 'voice.js'), [], { serviceName: 'Lynx Voice', stdio: 'pipe' })
      proc = p
      p.stderr?.on('data', (d: Buffer) => console.error(`[voice] ${d.toString().trim()}`))
      let ready = false
      p.on('message', (e: VoiceEvent) => {
        if (e.e === 'ready') return (ready = true), resolve()
        if (!ready && e.e === 'error') return reject(new Error(e.error))
        if (debug) console.error(`[voice] ${e.e}${e.e === 'heard' ? ` ${JSON.stringify(e.text)}` : e.e === 'error' ? ` ${e.error}` : ''}`)
        if (listening) onEvent(e)
      })
      p.on('exit', (code) => {
        if (proc !== p) return
        proc = undefined
        loading = undefined
        if (!ready) reject(new Error(`The speech process stopped (${code})`))
        else if (listening) onEvent({ e: 'error', error: 'The speech process stopped. Start voice mode again.' })
      })
      p.postMessage({ t: 'load', model, dir: dirOf(model), vad: vadFile, pause: quiet() })
    }))

  /** Before a session: voice mode is on, its model is here, and the microphone is allowed. */
  /** Asks macOS for the microphone, when it has not been allowed yet; throws, saying where to allow it, when it is refused. Needs no model: the first run asks as soon as voice is switched on. */
  const askMic = async () => {
    // Under test the microphone is a file Chromium plays (--use-fake-device-for-media-stream): macOS is not asked.
    const fake = app.commandLine.hasSwitch('use-fake-device-for-media-stream')
    if (process.platform === 'darwin' && !fake && systemPreferences.getMediaAccessStatus('microphone') !== 'granted' && !(await systemPreferences.askForMediaAccess('microphone')))
      // Started from a terminal (a dev build), macOS asks on the terminal's behalf, and the permission is the terminal's.
      throw new Error(app.isPackaged ? 'Lynx may not use the microphone. Allow it in System Settings, Privacy & Security, Microphone.' : 'The microphone is not allowed. This Lynx was started from a terminal, so macOS gives that permission to the terminal: allow your terminal app in System Settings, Privacy & Security, Microphone, then quit it and start Lynx again.')
  }
  const prepare = async () => {
    if (!enabled) throw new Error('Voice mode is off. Turn it on in Settings, Voice.')
    if (!installed(model)) throw new Error(download ? `${voiceModel(model).name} is still downloading` : `${voiceModel(model).name} is not downloaded. Download it in Settings, Voice.`)
    await askMic()
  }
  /** A voice session begins: the model is loaded (the page holds what it hears meanwhile), and samples are taken from then on. */
  // Each session's number: a stop while the model loads is not undone when it is loaded.
  let session = 0
  const start = async () => {
    const mine = ++session
    await prepare()
    clearTimeout(idle)
    await load()
    if (mine !== session) return
    proc?.postMessage({ t: 'reset' })
    listening = true
  }
  const stop = () => {
    session++
    listening = false
    proc?.postMessage({ t: 'reset' })
    clearTimeout(idle)
    idle = setTimeout(unload, KEEP_LOADED)
  }
  const audio = (samples: Float32Array) => {
    if (debug) {
      if (!listening) flow.dropped++
      flow.chunks++
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
      flow.peak = Math.max(flow.peak, Math.sqrt(sum / samples.length))
    }
    if (listening) proc?.postMessage({ t: 'audio', samples })
  }
  /** Forgets what was heard so far: while Lynx itself speaks, its voice is not the user's. */
  const reset = () => {
    if (debug) console.error('[voice] reset')
    proc?.postMessage({ t: 'reset' })
  }

  // ── reading replies aloud
  // Through macOS's own `say`, which speaks in the voice picked in System Settings, Accessibility, Spoken
  // Content, at its rate. Chromium's speechSynthesis lists neither that choice nor the Siri voices.
  let talking: ChildProcess | undefined
  const hush = () => {
    talking?.kill()
    talking = undefined
  }
  /** Says the text, done when it was said (or cut short by `hush`, or `say` failed). */
  const say = (text: string) =>
    new Promise<void>((resolve) => {
      hush()
      if (typeof text !== 'string' || !text.trim()) return resolve()
      const p = spawn('/usr/bin/say', ['-f', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
      talking = p
      p.stderr?.on('data', (d: Buffer) => console.error(`[voice] say: ${d.toString().trim()}`))
      p.on('error', (e) => (console.error(`[voice] say: ${e.message}`), resolve()))
      p.on('exit', () => {
        if (talking === p) talking = undefined
        resolve()
      })
      p.stdin?.on('error', () => {})
      p.stdin?.end(text)
    })

  // A download cut short by quitting leaves pieces; they go on the next start.
  for (const m of VOICE_MODELS) {
    rmSync(join(root, `${m.id}.download`), { force: true })
    rmSync(join(root, `${m.id}.unpacking`), { recursive: true, force: true })
  }

  return { state, set, install, remove, cancel: () => aborting?.abort(), askMic, prepare, start, stop, audio, reset, say, hush, dispose: () => (hush(), unload()) }
}

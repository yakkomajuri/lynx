// Voice mode: talking to the agent. Pressed once, it listens; when the user stops talking, what they
// said goes to the agent; when the agent is done, its reply is read out and it listens again, for a
// minute, before it turns itself off. Speech is turned into text on this computer (src/main/voice.ts).
// The session lives here, not in the agent panel: the panel is mounted anew whenever what is on screen
// changes (which the agent may do itself, opening a workspace beside), and the session goes on across that.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { spoken } from '@shared/voice'
import { bridge } from './api'
import { Keys } from './CommandBar'
import { comboFor } from './keymap'
import workletUrl from './voice-worklet.ts?worker&url'

/** How long it listens after the agent is done, or after it starts, before it turns itself off. */
export const QUIET = 60_000

export type VoicePhase = 'off' | 'starting' | 'listening' | 'working' | 'speaking'
export interface VoiceView {
  phase: VoicePhase
  /** The user is talking now. */
  hearing: boolean
  /** What they said last (corrected, when it was). */
  heard?: string
  /** What the microphone heard, when correcting changed it. */
  heardAs?: string
  /** While listening: when it turns itself off. */
  endsAt?: number
}

/** What the agent panel on screen does for a session: send what was heard, read the reply, and the rest. */
export interface VoicePanel {
  /** Sends what was said to the agent (or queues it while the agent works). */
  heard: (text: string, heardAs?: string) => Promise<void>
  /** Puts right what was heard (Settings › Voice): the words to send, and what was heard when they differ. */
  correct: (text: string) => Promise<{ text: string; heardAs?: string }>
  /** Gets the correcting model ready, when there is one, before the first sentence. */
  warm: () => void
  /** The agent's last reply in the conversation, as text. */
  reply: () => Promise<string | undefined>
  /** Replies are read out (Settings, Voice); otherwise it listens again as soon as the agent is done. */
  speaks: () => boolean
  /** The conversation is in front of the user: Lynx has the focus and the agent panel shows. When it is not, it does not listen again after the agent's turn, unless Settings › Voice says to. */
  present: () => boolean
  /** Listens again after the agent's turn even when the conversation is not in front (Settings, Voice). */
  listensAway: () => boolean
  /** Sends what is said when the user stops talking (Settings, Voice); otherwise it is written into the message box. */
  autoSends: () => boolean
  /** Writes what was said into the message box, after what is there, to send by hand. */
  dictate: (text: string) => void
  /** Something said is waiting in the message box to be sent. */
  waiting: () => boolean
  /** Takes away what the agent highlighted on screen. */
  clear: () => void
  toast: (text: string, tone?: 'info' | 'good' | 'bad') => void
}

let view: VoiceView = { phase: 'off', hearing: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<VoiceView>) => {
  // Seen in the log with LYNX_VOICE_DEBUG=1 (the window passes on what starts with [voice]).
  if (patch.phase && patch.phase !== view.phase) console.info(`[voice] phase ${patch.phase}${busy ? ' (agent busy)' : ''}${muted ? ' (muted)' : ''}`)
  if (patch.hearing !== undefined && patch.hearing !== view.hearing) console.info(`[voice] hearing ${patch.hearing}`)
  view = { ...view, ...patch }
  listeners.forEach((l) => l())
}
/** How loud the microphone is, 0 to about 0.3, for the meter: read on animation frames, not rendered. */
export const micLevel = { current: 0 }

let panel: VoicePanel | null = null
let mic: { stream: MediaStream; ctx: AudioContext } | null = null
let offEvents: (() => void) | null = null
// While Lynx speaks, the microphone hears Lynx: what it hears is dropped.
let muted = false
let busy = false
// The agent has been working since voice mode came on (or since its last reply was read): when it stops, there is a reply to read.
let turn = false
let quiet: ReturnType<typeof setTimeout> | undefined
let stuck: ReturnType<typeof setTimeout> | undefined

/** A short rising tone when it starts listening, falling when it stops. */
const chime = (up: boolean) => {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(up ? 660 : 880, ctx.currentTime)
    o.frequency.linearRampToValueAtTime(up ? 880 : 520, ctx.currentTime + 0.14)
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.24)
    o.onended = () => void ctx.close()
  } catch {
    /* no sound is fine */
  }
}

const listen = () => {
  clearTimeout(quiet)
  if (view.phase === 'off') return
  // Back from the agent's turn: anything half-heard meanwhile is dropped.
  if (view.phase !== 'listening') void bridge.voice.reset()
  set({ phase: 'listening', endsAt: Date.now() + QUIET })
  const end = () => {
    // What was said and is waiting in the message box keeps it listening until it is sent.
    if (panel?.waiting()) return void (quiet = setTimeout(end, QUIET))
    voice.stop('Voice mode is off: a minute went by with nothing said.')
  }
  quiet = setTimeout(end, QUIET)
}

/** While the agent works it does not listen: what is said then is neither sent nor queued. */
const deaf = () => muted || view.phase === 'working'

const speak = async (text: string) => {
  if (!text) return
  muted = true
  void bridge.voice.reset()
  set({ phase: 'speaking', hearing: false })
  // In the system voice (src/main/voice.ts); done when it was said, skipped, or `say` failed.
  await bridge.voice.say(text).catch(() => undefined)
  muted = false
  void bridge.voice.reset()
}

/** Voice mode was turned off meanwhile (read fresh: an await may have passed). */
const ended = () => view.phase === 'off'

const afterTurn = async () => {
  const text = panel?.speaks() ? await panel.reply().catch(() => undefined) : undefined
  if (ended()) return
  if (text) await speak(spoken(text))
  if (ended()) return
  if (busy) set({ phase: 'working' })
  // Away from the conversation (another app in front, the panel hidden), it does not open the microphone again on its own.
  else if (panel && !panel.present() && !panel.listensAway()) voice.stop('Voice mode is off: the agent finished while you were away.')
  else listen()
}

/** What the user said, as a command for voice mode itself, when it is one. */
const ENDS = /^(stop listening|that'?s all|goodbye|bye|end voice( mode)?|turn off voice( mode)?)[.!]*$/i

const onHeard = async (text: string) => {
  set({ hearing: false })
  // Noise, a cough, a breath: nothing to send.
  if (!/[a-z0-9]/i.test(text)) return view.phase === 'listening' && listen()
  if (ENDS.test(text)) return voice.stop()
  if (!panel) return voice.stop('Voice mode is off: the agent panel closed.')
  // Sent by hand: written into the message box, and it goes on listening.
  if (!panel.autoSends()) {
    const fixed = await panel.correct(text).catch(() => ({ text, heardAs: undefined }))
    if (ended() || !panel) return
    console.info(`[voice] writing ${JSON.stringify(fixed.text)}${fixed.heardAs ? ` (heard ${JSON.stringify(fixed.heardAs)})` : ''}`)
    panel.dictate(fixed.text)
    set({ heard: fixed.text, heardAs: fixed.heardAs })
    return listen()
  }
  clearTimeout(quiet)
  set({ heard: text, heardAs: undefined, phase: 'working', endsAt: undefined })
  // Sent, the agent should be working within moments; if it never is, go back to listening.
  clearTimeout(stuck)
  if (!busy) stuck = setTimeout(() => !busy && view.phase === 'working' && listen(), 15000)
  if (!panel) return voice.stop('Voice mode is off: the agent panel closed.')
  const fixed = await panel.correct(text).catch(() => ({ text, heardAs: undefined }))
  if (ended() || !panel) return
  // In the log with LYNX_VOICE_DEBUG=1: what was sent, and what it was heard as.
  console.info(`[voice] sending ${JSON.stringify(fixed.text)}${fixed.heardAs ? ` (heard ${JSON.stringify(fixed.heardAs)})` : ''}`)
  if (fixed.heardAs) set({ heard: fixed.text, heardAs: fixed.heardAs })
  panel.heard(fixed.text, fixed.heardAs).catch((e) => {
    panel?.toast(`Could not send what you said: ${e instanceof Error ? e.message : String(e)}`, 'bad')
    listen()
  })
}

const teardown = () => {
  clearTimeout(quiet)
  clearTimeout(stuck)
  offEvents?.()
  offEvents = null
  mic?.stream.getTracks().forEach((t) => t.stop())
  void mic?.ctx.close()
  mic = null
  micLevel.current = 0
  muted = false
  turn = false
  void bridge.voice.hush()
}

export const voice = {
  start: async () => {
    if (view.phase !== 'off') return
    set({ phase: 'starting', hearing: false, heard: undefined, endsAt: undefined })
    try {
      offEvents = bridge.onEvent((e) => {
        if (e.t !== 'voice' || view.phase === 'off' || (deaf() && e.e !== 'error')) return
        if (e.e === 'speech') {
          clearTimeout(quiet)
          set({ hearing: true, endsAt: undefined })
        } else if (e.e === 'heard') onHeard(e.text)
        else if (e.e === 'error') voice.stop(e.error)
      })
      await bridge.voice.prepare()
      // The model loads while the microphone opens: what is said meanwhile is held, and goes once it is ready.
      const loading = bridge.voice.start()
      // Awaited below; until then a failure is not reported twice.
      loading.catch(() => undefined)
      let held: Float32Array[] | null = []
      // The context runs at the models' rate: the browser resamples the microphone to it.
      const ctx = new AudioContext({ sampleRate: 16000 })
      await ctx.audioWorklet.addModule(workletUrl)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      mic = { stream, ctx }
      const node = new AudioWorkletNode(ctx, 'lynx-mic')
      node.port.onmessage = (e: MessageEvent<{ samples: Float32Array; level: number }>) => {
        micLevel.current = deaf() ? 0 : e.data.level
        if (deaf() || ended()) return
        if (held) held.push(e.data.samples)
        else bridge.voice.audio(e.data.samples)
      }
      ctx.createMediaStreamSource(stream).connect(node)
      node.connect(ctx.destination)
      if (ended()) return teardown()
      chime(true)
      panel?.warm()
      turn = busy
      if (busy) set({ phase: 'working' })
      else listen()
      await loading
      if (ended()) return
      for (const samples of held) bridge.voice.audio(samples)
      held = null
    } catch (e) {
      teardown()
      void bridge.voice.stop()
      set({ phase: 'off', hearing: false })
      panel?.toast(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), 'bad')
    }
  },
  /** Turns voice mode off, saying why when it was not the user's doing. */
  stop: (why?: string) => {
    if (view.phase === 'off') return
    teardown()
    void bridge.voice.stop()
    panel?.clear()
    set({ phase: 'off', hearing: false, endsAt: undefined })
    chime(false)
    if (why) panel?.toast(why)
  },
  toggle: () => (view.phase === 'off' ? voice.start() : voice.stop()),
  /** Stops reading the reply out. */
  skip: () => void bridge.voice.hush(),
  /** The agent panel on screen hands itself over; the session ends when no panel takes over from one that went. */
  connect: (p: VoicePanel) => {
    panel = p
    return () => {
      if (panel !== p) return
      panel = null
      setTimeout(() => !panel && voice.stop(), 1000)
    }
  },
  /** The panel's conversation is working, or not. A turn that ends while voice mode is on has its reply read. */
  report: (working: boolean) => {
    if (working === busy) return
    busy = working
    if (view.phase === 'off' || view.phase === 'starting') return
    if (working) {
      turn = true
      clearTimeout(quiet)
      clearTimeout(stuck)
      if (view.phase !== 'speaking') set({ phase: 'working', endsAt: undefined })
    } else if (turn) {
      turn = false
      void afterTurn()
    }
  },
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
export const useVoice = () => useSyncExternalStore(subscribe, () => view)

/** How long until it turns itself off, as a clock: 0:42. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const BARS = 7

/**
 * The strip over the composer while voice mode is on: a small waveform that follows the microphone
 * (or Lynx's own voice), what it is doing, what was said last, how long it waits, and the way out.
 * The waveform and the clock move on animation frames, outside React.
 */
export function VoiceBar({ dictating = false }: { /** What is said is written into the message box, to send by hand. */ dictating?: boolean }) {
  const v = useVoice()
  const wave = useRef<HTMLSpanElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    let smooth = 0
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      const phase = view.phase
      // How much there is to show: the microphone, eased; Lynx's voice while it speaks; a breath while it waits.
      const live = phase === 'speaking' ? 0.45 + 0.25 * Math.sin(t / 180) : Math.min(1, micLevel.current * 10)
      smooth = smooth * 0.75 + live * 0.25
      const bars = wave.current?.children
      if (bars)
        for (let i = 0; i < bars.length; i++) {
          const shape = 0.55 + 0.45 * Math.sin(t / 140 + i * 1.7)
          const rest = 0.18 + 0.06 * Math.sin(t / 600 + i * 0.9)
          ;(bars[i] as HTMLElement).style.transform = `scaleY(${Math.min(1, rest + smooth * shape).toFixed(3)})`
        }
      if (time.current) time.current.textContent = view.endsAt && !view.hearing ? clock(view.endsAt - Date.now()) : ''
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  if (v.phase === 'off') return null
  const label = v.phase === 'starting' ? 'Starting' : v.phase === 'working' ? 'Working' : v.phase === 'speaking' ? 'Speaking' : 'Listening'
  const sub =
    v.phase === 'working' ? (v.heard && !dictating ? `“${v.heard}”` : 'Listens again when the agent is done')
    : dictating ? (v.hearing ? '' : v.heard ? '↩ to send' : 'Speak to write · ↩ to send')
    : v.heard ? `“${v.heard}”`
    : v.phase === 'listening' && !v.hearing ? 'Pause to send' : ''
  const combo = comboFor('voice')
  return (
    <div className={`h-voice ${v.phase}${v.hearing ? ' hearing' : ''}`} role="status" aria-live="polite" aria-label={`Voice mode: ${label}`}>
      {v.phase === 'working' || v.phase === 'starting' ? (
        <span className="h-voice-busy" aria-hidden>
          <span className="sb-spinner" />
        </span>
      ) : (
        <span ref={wave} className="h-voice-wave" aria-hidden>
          {Array.from({ length: BARS }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      )}
      <span className="h-voice-label">{label}</span>
      {sub && (
        <span className="h-voice-sub" title={v.heardAs ? `Heard “${v.heardAs}”` : v.heard}>
          {sub}
        </span>
      )}
      {v.heardAs && (
        <span className="h-voice-fixed" title={`Heard “${v.heardAs}”`}>
          corrected
        </span>
      )}
      <span className="h-voice-gap" />
      <span ref={time} className="h-voice-time" title="Voice mode turns off after a minute with nothing said" />
      {v.phase === 'speaking' && (
        <button className="h-voice-btn" onClick={voice.skip} title="Stop reading the reply">
          Skip
        </button>
      )}
      <button className="h-voice-btn" onClick={() => voice.stop()} title="Turn voice mode off">
        End
        <Keys combo={combo} />
      </button>
    </div>
  )
}

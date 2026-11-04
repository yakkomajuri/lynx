// The speech process: a utility process of the window's, so a model's gigabytes and its blocking
// decode stay out of the window's main process. It takes the microphone as 16 kHz samples, hears
// when the user starts and stops talking (Silero VAD), and turns each thing said into text.
import { createRequire } from 'node:module'
import { recognizerConfig, VOICE_RATE, type VoiceEvent, type VoiceModelId } from '@shared/voice'

const require = createRequire(import.meta.url)

type In = { t: 'load'; model: VoiceModelId; dir: string; vad: string; pause: number } | { t: 'audio'; samples: Float32Array } | { t: 'reset' } | { t: 'pause'; seconds: number }

const port = process.parentPort
const say = (e: VoiceEvent) => port.postMessage(e)

/** Silero takes the microphone in windows of this many samples. */
const WINDOW = 512

let recognizer: any
let vad: any
let vadModel = ''
/** A quiet this long, in seconds, ends what was said; a breath, or a moment to think, does not. */
const listen = (seconds: number) => {
  const sherpa = require('sherpa-onnx-node')
  vad = new sherpa.Vad({ sileroVad: { model: vadModel, threshold: 0.5, minSilenceDuration: seconds, minSpeechDuration: 0.25, maxSpeechDuration: 60, windowSize: WINDOW }, sampleRate: VOICE_RATE, numThreads: 1, debug: 0 }, 90)
  pending = new Float32Array(0)
  talking = false
}
let pending = new Float32Array(0)
let talking = false

const load = (m: Extract<In, { t: 'load' }>) => {
  const sherpa = require('sherpa-onnx-node')
  recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: VOICE_RATE, featureDim: 80 }, modelConfig: { ...recognizerConfig(m.model, m.dir), numThreads: 4, debug: 0 } })
  vadModel = m.vad
  listen(m.pause)
  say({ e: 'ready' })
}

const transcribe = (samples: Float32Array) => {
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: VOICE_RATE, samples })
  recognizer.decode(stream)
  return String(recognizer.getResult(stream).text ?? '').trim()
}

const hear = (samples: Float32Array) => {
  if (!vad) return
  const all = new Float32Array(pending.length + samples.length)
  all.set(pending)
  all.set(samples, pending.length)
  let at = 0
  for (; at + WINDOW <= all.length; at += WINDOW) {
    vad.acceptWaveform(all.subarray(at, at + WINDOW))
    const now = vad.isDetected()
    if (now && !talking) say({ e: 'speech' })
    talking = now
    while (!vad.isEmpty()) {
      // A copy: the samples of the segment itself are freed with it.
      const segment = vad.front(false)
      vad.pop()
      say({ e: 'heard', text: transcribe(segment.samples) })
    }
  }
  pending = all.slice(at)
}

port.on('message', (e: { data: In }) => {
  const m = e.data
  try {
    if (m.t === 'load') load(m)
    else if (m.t === 'audio') hear(m.samples)
    else if (m.t === 'pause') listen(m.seconds)
    else if (m.t === 'reset') {
      vad?.reset()
      pending = new Float32Array(0)
      talking = false
    }
  } catch (err) {
    say({ e: 'error', error: err instanceof Error ? err.message : String(err) })
  }
})

// Voice mode: the speech models Lynx can run on this computer, and what the window knows about them.
// Everything is local: a model is downloaded once from the sherpa-onnx releases, then speech never
// leaves the machine. Silero VAD hears when the user starts and stops talking; the model picked turns
// what was said into text.

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models'

export type VoiceModelId = 'moonshine' | 'parakeet' | 'cohere'

export interface VoiceModel {
  id: VoiceModelId
  /** What the choice is, in a word. */
  tier: string
  name: string
  about: string
  languages: string
  /** Bytes to download, and on disk once unpacked. */
  download: number
  disk: number
  /** Roughly how much memory it takes while voice mode is on. */
  memory: number
  url: string
  /** The folder the archive unpacks into. */
  folder: string
}

export const VOICE_MODELS: VoiceModel[] = [
  {
    id: 'moonshine',
    tier: 'Light',
    name: 'Moonshine Base',
    about: 'Fastest and smallest. Good for short commands.',
    languages: 'English',
    download: 111_266_225,
    disk: 141_000_000,
    memory: 550_000_000,
    url: `${RELEASES}/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`,
    folder: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27',
  },
  {
    id: 'parakeet',
    tier: 'Balanced',
    name: 'NVIDIA Parakeet TDT 0.6B v2',
    about: 'Very accurate English with punctuation, and still quick.',
    languages: 'English',
    download: 482_500_000,
    disk: 661_000_000,
    memory: 1_900_000_000,
    url: `${RELEASES}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    folder: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
  },
  {
    id: 'cohere',
    tier: 'Most accurate',
    name: 'Cohere Transcribe',
    about: 'The most accurate. Slower to start, and needs plenty of memory.',
    languages: 'English',
    download: 1_699_800_000,
    disk: 2_890_000_000,
    memory: 3_700_000_000,
    url: `${RELEASES}/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01.tar.bz2`,
    folder: 'sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01',
  },
]

/** How long a quiet ends what was said, to pick from; the default is 1.5 s. */
export const VOICE_PAUSES = [0.8, 1, 1.5, 2, 3]
export const DEFAULT_PAUSE = 1.5
/** Sending by hand, what is said is written in as soon as there is a short quiet. */
export const DICTATION_PAUSE = 0.8
export const isVoicePause = (v: unknown): v is number => VOICE_PAUSES.includes(v as number)

export const DEFAULT_VOICE_MODEL: VoiceModelId = 'parakeet'
export const VAD_URL = `${RELEASES}/silero_vad.onnx`
export const isVoiceModel = (id: unknown): id is VoiceModelId => VOICE_MODELS.some((m) => m.id === id)
export const voiceModel = (id: VoiceModelId) => VOICE_MODELS.find((m) => m.id === id)!

/** The sherpa-onnx recognizer's model config for a model unpacked in `dir`. */
export const recognizerConfig = (id: VoiceModelId, dir: string) => {
  switch (id) {
    case 'moonshine':
      return { moonshine: { encoder: `${dir}/encoder_model.ort`, mergedDecoder: `${dir}/decoder_model_merged.ort` }, tokens: `${dir}/tokens.txt` }
    case 'parakeet':
      return { transducer: { encoder: `${dir}/encoder.int8.onnx`, decoder: `${dir}/decoder.int8.onnx`, joiner: `${dir}/joiner.int8.onnx` }, modelType: 'nemo_transducer', tokens: `${dir}/tokens.txt` }
    case 'cohere':
      return { cohereTranscribe: { encoder: `${dir}/encoder.int8.onnx`, decoder: `${dir}/decoder.int8.onnx`, language: 'en', usePunct: 1, useItn: 1 }, tokens: `${dir}/tokens.txt` }
  }
}

/** Voice mode as the window sees it: whether it is on, the model, and what is on disk. */
export interface VoiceState {
  /** Turned on in settings: the agent panel offers voice mode. */
  enabled: boolean
  model: VoiceModelId
  /** The agent's replies are read out. Off: they are only shown, and it listens again at once. */
  speak: boolean
  /** What is said goes when the user stops talking. Off, it is written into the message box, to send by hand. */
  autoSend: boolean
  /** Seconds of quiet that end what was said. */
  pause: number
  /** When the agent is done and Lynx is not in front (or the agent panel is hidden), it listens again all the same. Off: voice mode turns off instead. */
  listenAway: boolean
  installed: VoiceModelId[]
  /** A model on its way. */
  download?: { model: VoiceModelId; received: number; total: number; phase: 'downloading' | 'unpacking' }
  /** What went wrong with the last download. */
  error?: string
}

/** What the speech process says while a voice session runs. */
export type VoiceEvent =
  | { e: 'ready' }
  | { e: 'error'; error: string }
  /** The user started talking. */
  | { e: 'speech' }
  /** The user stopped talking: what they said. Empty when it was only noise. */
  | { e: 'heard'; text: string }

/** Samples a second, the rate the window sends the microphone at and the models take. */
export const VOICE_RATE = 16000

/** A reply as it should sound: no code, no markup, links by their words, and not too long. */
export const spoken = (md: string) => {
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= 600) return text
  const cut = text.slice(0, 600)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return end > 200 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

/** The correcting model by name: Haiku, Luna. */
const fixerName = (model: string) => (/luna/i.test(model) ? 'Luna' : /haiku/i.test(model) ? 'Haiku' : model)

/**
 * What to tell the user when the model correcting what was heard fails. A usage or rate limit is the
 * account's, shared with the agent: it is not voice mode's (speech is turned into text on this computer).
 */
export const fixFailed = (model: string, error: string) => {
  const why = error.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim()
  return /usage limit|quota|rate.?limit|too many requests|hit your limit|credit balance|out of credits|\b429\b/i.test(why)
    ? `${fixerName(model)}, the model that corrects what was heard, hit your account's usage limit (${why}), so what you said went as heard. Voice mode still works; the agent may be limited too.`
    : `Could not correct what was heard, so it went as heard: ${why}`
}

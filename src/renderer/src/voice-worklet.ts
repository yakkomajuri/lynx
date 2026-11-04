// The microphone, in the audio thread: its samples (the context runs at 16 kHz, the rate the speech
// models take) gathered into tenths of a second, each with how loud it was, for the page to send on.
declare const registerProcessor: (name: string, processor: unknown) => void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

const CHUNK = 1600

class Mic extends AudioWorkletProcessor {
  buf = new Float32Array(CHUNK)
  at = 0
  process(inputs: Float32Array[][]) {
    const input = inputs[0]?.[0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      this.buf[this.at++] = input[i]!
      if (this.at < CHUNK) continue
      let sum = 0
      for (let j = 0; j < CHUNK; j++) sum += this.buf[j]! * this.buf[j]!
      this.port.postMessage({ samples: this.buf, level: Math.sqrt(sum / CHUNK) }, [this.buf.buffer])
      this.buf = new Float32Array(CHUNK)
      this.at = 0
    }
    return true
  }
}

registerProcessor('lynx-mic', Mic)

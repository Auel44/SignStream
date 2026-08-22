// Audio-thread PCM tap: resamples tab audio to 16 kHz mono and emits one
// ready-to-send Int16 frame per FRAME_MS.
//
// Replaces ScriptProcessorNode, which is deprecated because it runs on the main
// thread — every buffer competes with rendering and React, so a busy page shows
// up as dropped audio and gaps in the transcript. An AudioWorklet runs on the
// realtime audio thread instead and cannot be starved by page work.
//
// This file MUST stay import-free. Chrome loads worklet modules in a scope that
// does not support `import`, so anything shared has to arrive through
// `processorOptions` rather than a module import. That is why the frame size
// and target rate are passed in rather than read from shared/types.ts.
//
// All the per-frame work (resample → frame → Int16 → RMS) happens here on
// purpose. The worklet is called with 128-sample blocks, so forwarding raw
// blocks would mean ~375 postMessage calls per second; doing the framing here
// makes it 4 — one per finished 250 ms frame, with its buffer transferred
// rather than copied.

// ── Worklet globals (not present in the DOM lib) ────────────────────────────
declare const sampleRate: number;
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessorLike,
): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
interface AudioWorkletProcessorLike {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

/** One finished frame, posted to the offscreen document. */
export interface PcmFrameMessage {
  pcm: Int16Array;
  rms: number;
  samples: number;
}

class PcmFramer extends AudioWorkletProcessor {
  private readonly frameSamples: number;
  /** Input samples consumed per output sample, e.g. 48000/16000 = 3. */
  private readonly ratio: number;

  /** Input samples carried over so resampling is continuous across blocks. */
  private tail = new Float32Array(0);
  /** Fractional read position within `tail`+block. Preserved across calls. */
  private cursor = 0;

  private frame: Float32Array;
  private filled = 0;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const opts = (options?.processorOptions ?? {}) as {
      targetSampleRate?: number;
      frameMs?: number;
    };
    const targetRate = opts.targetSampleRate ?? 16000;
    this.frameSamples = Math.round((targetRate * (opts.frameMs ?? 250)) / 1000);
    this.ratio = sampleRate / targetRate;
    this.frame = new Float32Array(this.frameSamples);
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    // No input yet (or the source disconnected) — stay alive and wait.
    if (!channel || channel.length === 0) return true;

    // Resample across the block boundary, not within it.
    //
    // The previous implementation resampled each buffer independently. At a
    // 48k→16k ratio of 3 that is lossless-ish for a 4096 buffer, but a worklet
    // block is 128 samples: independent resampling would discard the remainder
    // every block and drift the audio clock, which a streaming ASR hears as
    // clicks and dropped phonemes. Carrying `tail` + `cursor` across calls
    // makes the stream continuous.
    const buf = new Float32Array(this.tail.length + channel.length);
    buf.set(this.tail);
    buf.set(channel, this.tail.length);

    let pos = this.cursor;
    while (pos + 1 < buf.length) {
      const i0 = pos | 0;
      const frac = pos - i0;
      this.frame[this.filled++] = buf[i0] * (1 - frac) + buf[i0 + 1] * frac;
      if (this.filled === this.frameSamples) this.flush();
      pos += this.ratio;
    }

    // `pos` can land past the end of the block — at 96 kHz the step is 6 while
    // a block is 128 samples, so the next output routinely falls beyond it.
    // Clamping is what keeps the phase: without it `buf.slice(pos)` returns
    // empty AND `pos - pos` resets the cursor to 0, silently discarding the
    // leftover offset every block. That over-produces samples (~3% at 96 kHz),
    // which the ASR hears as audio running fast, and leaves `tail` growing
    // without bound. Clamping carries the overshoot into `cursor` instead, so
    // the next block starts at the right sub-sample position.
    const consumed = Math.min(pos | 0, buf.length);
    this.tail = buf.slice(consumed);
    this.cursor = pos - consumed;
    return true;
  }

  /** Convert the completed frame to Int16 and hand it to the main thread. */
  private flush(): void {
    const pcm = new Int16Array(this.frameSamples);
    let sumSquares = 0;
    for (let i = 0; i < this.frameSamples; i++) {
      const s = Math.max(-1, Math.min(1, this.frame[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSquares += s * s;
    }

    const message: PcmFrameMessage = {
      pcm,
      rms: Math.sqrt(sumSquares / this.frameSamples),
      samples: this.frameSamples,
    };
    // Transfer the buffer instead of copying it — this runs on the realtime
    // audio thread, where an avoidable allocation copy risks an underrun.
    this.port.postMessage(message, [pcm.buffer]);
    this.filled = 0;
  }
}

registerProcessor("pcm-framer", PcmFramer);

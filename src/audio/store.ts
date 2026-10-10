// ============================================================================
// Sample store.
//
// Owns the decoded audio for every take: the raw import, and the cleaned
// version once processing has been applied. Everything else in the app refers
// to samples by id and asks here for audio, so there is exactly one copy of
// each take in memory and one place that knows how to get it.
// ============================================================================

import { decodeWav, isWav } from '../dsp/wav';
import { toMono, computePeaks } from '../dsp/analyze';

export interface LoadedAudio {
  channels: Float32Array[];
  sampleRate: number;
  frames: number;
  /** Mono mixdown, cached because every analyser wants it. */
  mono: Float32Array;
  /** Interleaved min/max pairs for drawing. */
  peaks: Float32Array;
  /** Loop points found in the file's own smpl chunk, if any. */
  fileLoop?: { start: number; end: number };
  fileRootMidi?: number;
}

const PEAK_BUCKETS = 2048;

class SampleStore {
  private raw = new Map<string, LoadedAudio>();
  private processed = new Map<string, LoadedAudio>();
  private ctx: AudioContext | null = null;

  private audioContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** Wrap raw channel data with the derived views the app needs. */
  static wrap(
    channels: Float32Array[],
    sampleRate: number,
    extra: Partial<LoadedAudio> = {},
  ): LoadedAudio {
    const mono = toMono(channels);
    return {
      channels,
      sampleRate,
      frames: channels[0]?.length ?? 0,
      mono,
      peaks: computePeaks(mono, PEAK_BUCKETS),
      ...extra,
    };
  }

  /**
   * Decode arbitrary audio bytes.
   * WAV goes through our own parser so the smpl chunk survives; everything else
   * goes to the platform decoder, which handles mp3/m4a/ogg/flac.
   */
  async decode(bytes: ArrayBuffer): Promise<LoadedAudio> {
    if (isWav(bytes)) {
      const w = decodeWav(bytes);
      const loop = w.loops[0];
      return SampleStore.wrap(w.channels, w.sampleRate, {
        fileLoop: loop ? { start: loop.start, end: loop.end } : undefined,
        fileRootMidi: w.rootMidi,
      });
    }
    // decodeAudioData detaches the buffer it is given, so hand it a copy.
    const buf = await this.audioContext().decodeAudioData(bytes.slice(0));
    const channels: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
    return SampleStore.wrap(channels, buf.sampleRate);
  }

  set(id: string, audio: LoadedAudio): void {
    this.raw.set(id, audio);
  }

  setProcessed(id: string, audio: LoadedAudio | null): void {
    if (audio) this.processed.set(id, audio);
    else this.processed.delete(id);
  }

  /** Cleaned audio when it exists, otherwise the original. */
  get(id: string): LoadedAudio | null {
    return this.processed.get(id) ?? this.raw.get(id) ?? null;
  }

  getRaw(id: string): LoadedAudio | null {
    return this.raw.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.raw.has(id);
  }

  delete(id: string): void {
    this.raw.delete(id);
    this.processed.delete(id);
  }

  clear(): void {
    this.raw.clear();
    this.processed.clear();
  }

  /** Build a Web Audio buffer for playback, on the engine's own context. */
  toAudioBuffer(id: string, ctx: BaseAudioContext): AudioBuffer | null {
    const a = this.get(id);
    if (!a) return null;
    const buf = ctx.createBuffer(a.channels.length, a.frames, a.sampleRate);
    // set() rather than copyToChannel(): the latter's typing pins the backing
    // buffer to ArrayBuffer, which our channel arrays do not promise.
    for (let c = 0; c < a.channels.length; c++) buf.getChannelData(c).set(a.channels[c]);
    return buf;
  }
}

export const sampleStore = new SampleStore();
export { SampleStore };

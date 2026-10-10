// ============================================================================
// Native voice renderer.
//
// Renders the instrument into raw float buffers for RtAudio (WASAPI / ASIO /
// DirectSound). Pure DSP with no DOM and no Web Audio, so it runs in the audio
// host process and is directly testable.
//
// Selection is shared with the Web Audio engine via ../audio/select, so both
// paths pick the same zones and the same round robins. Only the rendering
// differs.
// ============================================================================

import type { Instrument, Zone, Group } from '../core/types';
import {
  RoundRobinState,
  selectZones,
  keyswitchAt,
  normalizeVelocity,
  playbackRate,
  voiceGain,
  micGain,
  micOf,
} from './select';

export interface RenderSample {
  channels: Float32Array[];
  sampleRate: number;
}

type EnvStage = 'attack' | 'decay' | 'sustain' | 'release' | 'done';

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  // Per-channel direct-form-II state.
  z1: number[];
  z2: number[];
}

interface Voice {
  key: number;
  zone: Zone;
  group: Group;
  sample: RenderSample;
  /** Fractional read position in source frames. */
  pos: number;
  step: number;
  gain: number;
  panL: number;
  panR: number;
  stopFrame: number;

  env: number;
  stage: EnvStage;
  attackInc: number;
  decayCoef: number;
  sustain: number;
  releaseCoef: number;

  filter: Biquad | null;
  chokeGroup: number;
  releasing: boolean;
}

const SILENCE = 1e-5;

function makeBiquad(
  type: 'lowpass' | 'highpass' | 'bandpass',
  freq: number,
  q: number,
  sampleRate: number,
  channels: number,
): Biquad {
  // RBJ cookbook. Clamped below Nyquist or the filter goes unstable and the
  // output turns to noise, which is a very loud way to fail.
  const f = Math.max(20, Math.min(freq, sampleRate * 0.45));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(0.1, q));

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    z1: new Array(channels).fill(0),
    z2: new Array(channels).fill(0),
  };
}

/** Catmull-Rom interpolation — cheap, and audibly cleaner than linear when a
 *  zone is stretched, which is most of the time. */
function interpolate(data: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const t = pos - i;
  const x0 = data[i - 1] ?? data[i] ?? 0;
  const x1 = data[i] ?? 0;
  const x2 = data[i + 1] ?? x1;
  const x3 = data[i + 2] ?? x2;
  const a = 2 * x1;
  const b = x2 - x0;
  const c = 2 * x0 - 5 * x1 + 4 * x2 - x3;
  const d = -x0 + 3 * x1 - 3 * x2 + x3;
  return 0.5 * (a + b * t + c * t * t + d * t * t * t);
}

export class NativeRenderer {
  private instrument: Instrument | null = null;
  private samples = new Map<string, RenderSample>();
  private voices: Voice[] = [];
  private rr = new RoundRobinState();
  private activeArticulation: string | null = null;
  private held = new Set<number>();
  private pedalHeld = new Set<number>();
  private sustainPedal = false;
  private masterGain = 1;
  private peak = 0;

  constructor(
    public sampleRate: number,
    public channels: number = 2,
  ) {}

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.allNotesOff();
  }

  /** Pick the articulation that notes sound until a keyswitch changes it. */
  setArticulation(id: string | null): void {
    this.activeArticulation = id;
  }

  get currentArticulation(): string | null {
    return this.activeArticulation;
  }

  setInstrument(inst: Instrument | null): void {
    this.instrument = inst;
    this.rr.reset();
    this.allNotesOff();
    this.masterGain = inst ? Math.pow(10, inst.master.gainDb / 20) : 1;
  }

  addSample(id: string, channels: Float32Array[], sampleRate: number): void {
    this.samples.set(id, { channels, sampleRate });
  }

  removeSample(id: string): void {
    this.samples.delete(id);
    this.voices = this.voices.filter((v) => v.sample !== this.samples.get(id));
  }

  clearSamples(): void {
    this.samples.clear();
    this.voices = [];
  }

  hasSample(id: string): boolean {
    return this.samples.has(id);
  }

  /** Peak since the last call, for the UI meter. */
  takePeak(): number {
    const p = this.peak;
    this.peak = 0;
    return p;
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  // -------------------------------------------------------------------------

  noteOn(key: number, velocity = 100): void {
    const inst = this.instrument;
    if (!inst) return;

    const ks = keyswitchAt(inst, key);
    if (ks) {
      this.activeArticulation = ks.id;
      return;
    }

    this.held.add(key);
    const vNorm = normalizeVelocity(inst, velocity);
    for (const { zone, group } of selectZones(
      inst,
      this.rr,
      key,
      velocity,
      this.activeArticulation,
      'attack',
    )) {
      this.startVoice(zone, group, key, vNorm);
    }

    const limit = inst.master.polyphony;
    if (limit > 0) {
      while (this.voices.filter((v) => !v.releasing).length > limit) {
        const oldest = this.voices.find((v) => !v.releasing);
        if (!oldest) break;
        this.releaseVoice(oldest);
      }
    }
  }

  noteOff(key: number): void {
    const inst = this.instrument;
    this.held.delete(key);
    if (this.sustainPedal) {
      this.pedalHeld.add(key);
      return;
    }
    if (inst) {
      for (const { zone, group } of selectZones(
        inst,
        this.rr,
        key,
        64,
        this.activeArticulation,
        'release',
      )) {
        this.startVoice(zone, group, key, 0.5);
      }
    }
    for (const v of this.voices) if (v.key === key && !v.releasing) this.releaseVoice(v);
  }

  setSustainPedal(down: boolean): void {
    this.sustainPedal = down;
    if (down) return;
    for (const key of this.pedalHeld) {
      if (this.held.has(key)) continue;
      for (const v of this.voices) if (v.key === key && !v.releasing) this.releaseVoice(v);
    }
    this.pedalHeld.clear();
  }

  allNotesOff(): void {
    this.voices = [];
    this.held.clear();
    this.pedalHeld.clear();
  }

  private releaseVoice(v: Voice): void {
    v.releasing = true;
    v.stage = 'release';
  }

  private startVoice(zone: Zone, group: Group, key: number, vNorm: number): void {
    const inst = this.instrument;
    const sample = this.samples.get(zone.sampleId);
    if (!inst || !sample || !sample.channels.length) return;

    if (group.chokeGroup > 0) {
      for (const v of this.voices)
        if (v.chokeGroup === group.chokeGroup && !v.releasing) {
          // Choked voices need a fast fade, not a hard stop, or they click.
          v.releasing = true;
          v.stage = 'release';
          v.releaseCoef = Math.exp(-1 / (0.004 * this.sampleRate));
        }
    }

    const e = group.ampEnv;
    const pan = Math.max(-1, Math.min(1, zone.pan + group.pan + (micOf(inst, zone)?.pan ?? 0)));
    // Equal-power pan: a centre-panned voice must not be louder than a hard one.
    const angle = ((pan + 1) / 2) * (Math.PI / 2);

    const rate = playbackRate(inst, zone, key) * (sample.sampleRate / this.sampleRate);
    const attackFrames = Math.max(1, e.attack * this.sampleRate);

    let filter: Biquad | null = null;
    if (group.filter.type !== 'off') {
      const keyOct = ((key - 60) / 12) * group.filter.keyTrack;
      const velOct = vNorm * group.filter.velAmount * 4;
      filter = makeBiquad(
        group.filter.type,
        group.filter.cutoff * Math.pow(2, keyOct + velOct),
        group.filter.resonance,
        this.sampleRate,
        this.channels,
      );
    }

    this.voices.push({
      key,
      zone,
      group,
      sample,
      pos: zone.startFrame,
      step: rate,
      gain: voiceGain(zone, group, vNorm) * micGain(inst, zone),
      panL: Math.cos(angle),
      panR: Math.sin(angle),
      stopFrame:
        zone.loop.mode === 'off' && zone.endFrame > zone.startFrame
          ? zone.endFrame
          : sample.channels[0].length,
      env: 0,
      stage: 'attack',
      attackInc: 1 / attackFrames,
      decayCoef: Math.exp(-1 / (Math.max(0.001, e.decay) * this.sampleRate)),
      sustain: e.sustain,
      releaseCoef: Math.exp(-1 / (Math.max(0.001, e.release) * this.sampleRate)),
      filter,
      chokeGroup: group.chokeGroup,
      releasing: false,
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Render `frames` into planar output buffers. Buffers are overwritten, not
   * added to, so the caller never has to zero them.
   */
  render(out: Float32Array[], frames: number): void {
    for (const ch of out) ch.fill(0, 0, frames);

    for (let vi = this.voices.length - 1; vi >= 0; vi--) {
      const v = this.voices[vi];
      const src = v.sample.channels;
      const srcChannels = src.length;
      const loop = v.zone.loop;
      const looping = loop.mode !== 'off' && loop.end > loop.start;

      for (let i = 0; i < frames; i++) {
        // --- envelope ---
        if (v.stage === 'attack') {
          v.env += v.attackInc;
          if (v.env >= 1) {
            v.env = 1;
            v.stage = v.sustain >= 0.999 ? 'sustain' : 'decay';
          }
        } else if (v.stage === 'decay') {
          v.env = v.sustain + (v.env - v.sustain) * v.decayCoef;
          if (v.env - v.sustain < SILENCE) v.stage = 'sustain';
        } else if (v.stage === 'release') {
          v.env *= v.releaseCoef;
          if (v.env < SILENCE) {
            v.stage = 'done';
            break;
          }
        }

        // --- position ---
        if (looping) {
          while (v.pos >= loop.end) v.pos -= loop.end - loop.start;
        } else if (v.pos >= v.stopFrame - 1) {
          v.stage = 'done';
          break;
        }

        const amp = v.env * v.gain;
        for (let c = 0; c < this.channels; c++) {
          const srcCh = src[Math.min(c, srcChannels - 1)];
          let s = interpolate(srcCh, v.pos) * amp;

          if (v.filter) {
            const f = v.filter;
            const w = s - f.a1 * f.z1[c] - f.a2 * f.z2[c];
            s = f.b0 * w + f.b1 * f.z1[c] + f.b2 * f.z2[c];
            f.z2[c] = f.z1[c];
            f.z1[c] = w;
          }

          // Mono sources are panned; stereo sources keep their own image.
          const panned = srcChannels === 1 ? s * (c === 0 ? v.panL : v.panR) : s;
          out[c][i] += panned;
        }
        v.pos += v.step;
      }

      if (v.stage === 'done') this.voices.splice(vi, 1);
    }

    // Master gain and peak metering in one pass.
    let peak = this.peak;
    for (let c = 0; c < this.channels; c++) {
      const ch = out[c];
      for (let i = 0; i < frames; i++) {
        const s = ch[i] * this.masterGain;
        ch[i] = s > 1 ? 1 : s < -1 ? -1 : s;
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
      }
    }
    this.peak = peak;
  }

  /** Render straight to an interleaved float buffer, which is what RtAudio
   *  wants for RTAUDIO_FLOAT32. */
  renderInterleaved(target: Float32Array, frames: number, scratch: Float32Array[]): void {
    this.render(scratch, frames);
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < this.channels; c++) target[i * this.channels + c] = scratch[c][i];
  }
}

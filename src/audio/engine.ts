// ============================================================================
// Audition engine.
//
// Plays the instrument using the same selection rules the exporters describe:
// articulation → group → key/velocity zone → round-robin slot. That agreement
// is the whole point — an audition that flatters the instrument by using
// different rules than the exported file is worse than no audition at all.
//
// Web Audio, one AudioBufferSourceNode per voice. At the scale this app works
// with (a few dozen simultaneous voices) that is comfortably enough, and it
// keeps the engine small enough to stay obviously correct.
// ============================================================================

import type { Instrument, Group, Zone } from '../core/types';
import { sampleStore } from './store';
import { dbToGain } from '../dsp/analyze';
import {
  RoundRobinState,
  selectZones,
  keyswitchAt,
  normalizeVelocity,
  playbackRate,
  voiceGain,
} from './select';

interface Voice {
  key: number;
  source: AudioBufferSourceNode;
  amp: GainNode;
  filter: BiquadFilterNode | null;
  group: Group;
  releaseSeconds: number;
  chokeGroup: number;
  stopped: boolean;
}

export class AuditionEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private voices: Voice[] = [];
  private rr = new RoundRobinState();
  private activeArticulation: string | null = null;
  private held = new Set<number>();
  private sustainPedal = false;
  private pedalHeld = new Set<number>();

  instrument: Instrument | null = null;

  /** Started lazily — browsers require a gesture before audio can run. */
  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.analyser = analyser;
  }

  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setInstrument(inst: Instrument | null): void {
    this.instrument = inst;
    this.buffers.clear();
    this.allNotesOff();
    if (inst) this.master?.gain.setTargetAtTime(dbToGain(inst.master.gainDb), this.now(), 0.01);
  }

  /** Peak level of the master bus, 0..1, for the meter. */
  level(): number {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private bufferFor(sampleId: string): AudioBuffer | null {
    if (!this.ctx) return null;
    let buf = this.buffers.get(sampleId);
    if (!buf) {
      const made = sampleStore.toAudioBuffer(sampleId, this.ctx);
      if (!made) return null;
      buf = made;
      this.buffers.set(sampleId, buf);
    }
    return buf;
  }

  /** Drop cached buffers for a sample after it has been reprocessed. */
  invalidate(sampleId: string): void {
    this.buffers.delete(sampleId);
  }

  /** The live context, so the output facade can retarget it with setSinkId. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  // -------------------------------------------------------------------------
  // Note handling
  //
  // Selection is delegated to audio/select, which the native RtAudio renderer
  // also uses. Two copies of this would drift, and an audition that picks
  // different zones than the export is worse than no audition at all.
  // -------------------------------------------------------------------------

  noteOn(key: number, velocity = 100): void {
    const inst = this.instrument;
    if (!inst || !this.ctx || !this.master) return;

    const ks = keyswitchAt(inst, key);
    if (ks) {
      this.activeArticulation = ks.id;
      return;
    }

    this.held.add(key);
    const t = this.now();
    const vNorm = normalizeVelocity(inst, velocity);

    for (const { zone, group } of selectZones(
      inst,
      this.rr,
      key,
      velocity,
      this.activeArticulation,
      'attack',
    )) {
      this.playZone(zone, group, key, vNorm, t);
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
      // Release-triggered groups fire on the way up — key noise, string damping.
      for (const { zone, group } of selectZones(
        inst,
        this.rr,
        key,
        64,
        this.activeArticulation,
        'release',
      )) {
        this.playZone(zone, group, key, 0.5, this.now());
      }
    }
    this.releaseVoices(key);
  }

  setSustainPedal(down: boolean): void {
    this.sustainPedal = down;
    if (!down) {
      for (const key of this.pedalHeld) if (!this.held.has(key)) this.releaseVoices(key);
      this.pedalHeld.clear();
    }
  }

  private releaseVoices(key: number): void {
    const t = this.now();
    for (const v of this.voices) {
      if (v.key !== key || v.stopped) continue;
      v.stopped = true;
      const r = Math.max(0.005, v.releaseSeconds);
      v.amp.gain.cancelScheduledValues(t);
      v.amp.gain.setValueAtTime(v.amp.gain.value, t);
      v.amp.gain.setTargetAtTime(0, t, r / 4);
      try {
        v.source.stop(t + r + 0.05);
      } catch {
        /* already stopped */
      }
    }
  }

  private playZone(zone: Zone, group: Group, key: number, vNorm: number, t: number): void {
    const ctx = this.ctx;
    const inst = this.instrument;
    if (!ctx || !this.master || !inst) return;
    const buffer = this.bufferFor(zone.sampleId);
    if (!buffer) return;

    // Choke groups cut anything already sounding in the same group.
    if (group.chokeGroup > 0) {
      for (const v of this.voices) {
        if (v.chokeGroup === group.chokeGroup && !v.stopped) {
          v.stopped = true;
          v.amp.gain.cancelScheduledValues(t);
          v.amp.gain.setTargetAtTime(0, t, 0.004);
          try {
            v.source.stop(t + 0.05);
          } catch {
            /* already stopped */
          }
        }
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    source.playbackRate.value = playbackRate(inst, zone, key);

    if (zone.loop.mode !== 'off' && zone.loop.end > zone.loop.start) {
      source.loop = true;
      source.loopStart = zone.loop.start / buffer.sampleRate;
      source.loopEnd = zone.loop.end / buffer.sampleRate;
    }

    const amp = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, zone.pan + group.pan));

    let node: AudioNode = amp;
    let filter: BiquadFilterNode | null = null;
    if (group.filter.type !== 'off') {
      filter = ctx.createBiquadFilter();
      filter.type = group.filter.type;
      // Key tracking and velocity both open the filter, in octaves.
      const keyOctaves = ((key - 60) / 12) * group.filter.keyTrack;
      const velOctaves = vNorm * group.filter.velAmount * 4;
      const cutoff = group.filter.cutoff * Math.pow(2, keyOctaves + velOctaves);
      filter.frequency.value = Math.max(20, Math.min(20000, cutoff));
      filter.Q.value = group.filter.resonance;
      amp.connect(filter);
      node = filter;
    }
    node.connect(pan);
    pan.connect(this.master);

    const peak = voiceGain(zone, group, vNorm);

    const e = group.ampEnv;
    const attack = Math.max(0.0005, e.attack);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + attack);
    if (e.sustain < 1) {
      amp.gain.setTargetAtTime(peak * e.sustain, t + attack, Math.max(0.005, e.decay) / 3);
    }

    const startOffset = zone.startFrame / buffer.sampleRate;
    const duration =
      zone.loop.mode === 'off' && zone.endFrame > zone.startFrame
        ? (zone.endFrame - zone.startFrame) / buffer.sampleRate / source.playbackRate.value
        : undefined;

    try {
      if (duration != null) source.start(t, startOffset, duration);
      else source.start(t, startOffset);
    } catch {
      return;
    }

    const voice: Voice = {
      key,
      source,
      amp,
      filter,
      group,
      releaseSeconds: e.release,
      chokeGroup: group.chokeGroup,
      stopped: false,
    };
    this.voices.push(voice);
    source.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
      try {
        pan.disconnect();
        amp.disconnect();
        filter?.disconnect();
      } catch {
        /* already torn down */
      }
    };

    // Voice stealing: oldest first, and only when a limit is set.
    const limit = inst.master.polyphony;
    if (limit > 0 && this.voices.length > limit) {
      const oldest = this.voices.find((v) => !v.stopped);
      if (oldest) this.releaseVoices(oldest.key);
    }
  }

  allNotesOff(): void {
    const t = this.now();
    for (const v of this.voices) {
      try {
        v.amp.gain.cancelScheduledValues(t);
        v.amp.gain.setTargetAtTime(0, t, 0.01);
        v.source.stop(t + 0.08);
      } catch {
        /* already stopped */
      }
    }
    this.voices = [];
    this.held.clear();
    this.pedalHeld.clear();
  }

  /** Preview one sample directly, ignoring the map. Used by the take browser. */
  previewSample(sampleId: string, startFrame = 0, endFrame = -1): void {
    if (!this.ctx || !this.master) return;
    const buffer = this.bufferFor(sampleId);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = 1;
    src.connect(g);
    g.connect(this.master);
    const t = this.now();
    const start = startFrame / buffer.sampleRate;
    const dur = endFrame > startFrame ? (endFrame - startFrame) / buffer.sampleRate : undefined;
    try {
      if (dur != null) src.start(t, start, dur);
      else src.start(t, start);
    } catch {
      /* ignore */
    }
    src.onended = () => {
      try {
        g.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }
}

export const engine = new AuditionEngine();

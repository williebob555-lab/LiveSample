// ============================================================================
// The processing pipeline: import → analyse → clean → loop → fill gaps.
//
// Every operation here is destructive only in the store's "processed" slot; the
// original decode is always kept, so cleanup can be re-run with different
// settings without re-importing. That matters because the right threshold for a
// phone recording is not the right threshold for a close-mic'd take, and you
// find that out by trying.
// ============================================================================

import {
  type Instrument,
  type Sample,
  type Group,
  newId,
} from './types';
import { sampleStore, SampleStore, type LoadedAudio } from '../audio/store';
import { detectPitch, midiToHz } from '../dsp/pitch';
import {
  levelStats,
  findOnsetAndTail,
  splitOnSilence,
  removeDcOffset,
  applyGain,
  sliceChannels,
  dbToGain,
  toMono,
} from '../dsp/analyze';
import { findLoop, applyLoopCrossfade } from '../dsp/loop';
import { repitch, repitchFormant } from '../dsp/resample';

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Pull note, velocity layer and round robin out of a filename. */
export function parseFilename(name: string): {
  midi?: number;
  velLayer?: number;
  rrIndex?: number;
} {
  const base = name.replace(/\.[^.]+$/, '');
  const out: { midi?: number; velLayer?: number; rrIndex?: number } = {};

  // Note names like C3, F#2, Bb-1, As4 — the common conventions across
  // libraries. Guarded by boundaries so "Take3" is not read as a note.
  const note = base.match(/(?:^|[_\-. ])([A-Ga-g])([#sb]?)(-?\d)(?:$|[_\-. ])/);
  if (note) {
    const letters: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
    let pc = letters[note[1].toLowerCase()];
    if (note[2] === '#' || note[2] === 's') pc += 1;
    else if (note[2] === 'b') pc -= 1;
    const octave = parseInt(note[3], 10);
    const midi = (octave + 1) * 12 + pc;
    if (midi >= 0 && midi <= 127) out.midi = midi;
  }

  const vel = base.match(/(?:^|[_\-. ])(?:v|vel|layer)(\d{1,3})(?:$|[_\-. ])/i);
  if (vel) out.velLayer = parseInt(vel[1], 10);

  const rr = base.match(/(?:^|[_\-. ])(?:rr|rob|take|t)(\d{1,2})(?:$|[_\-. ])/i);
  if (rr) out.rrIndex = parseInt(rr[1], 10);

  return out;
}

export interface ImportedSample {
  sample: Sample;
  audio: LoadedAudio;
}

/** Decode one file's bytes into a sample, seeding metadata from its name. */
export async function importAudio(
  name: string,
  bytes: ArrayBuffer,
  path?: string,
): Promise<ImportedSample> {
  const audio = await sampleStore.decode(bytes);
  const hints = parseFilename(name);
  const sample: Sample = {
    id: newId('smp'),
    name: name.replace(/\.[^.]+$/, ''),
    path,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    frames: audio.frames,
    analysis: {},
    capture: {
      targetMidi: hints.midi ?? audio.fileRootMidi,
      velLayer: hints.velLayer,
      rrIndex: hints.rrIndex,
      takenAt: Date.now(),
    },
  };
  sampleStore.set(sample.id, audio);
  return { sample, audio };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  onsetThresholdDb?: number;
  preRollMs?: number;
  /** Restrict pitch search around the expected note, when one is known. */
  useTargetHint?: boolean;
}

/** Fill in a sample's analysis: levels, usable span, and pitch. */
export function analyzeSample(sample: Sample, opts: AnalyzeOptions = {}): void {
  const audio = sampleStore.getRaw(sample.id);
  if (!audio) return;

  const stats = levelStats(audio.mono);
  const { onsetFrame, tailFrame } = findOnsetAndTail(
    audio.mono,
    audio.sampleRate,
    opts.onsetThresholdDb ?? 12,
    opts.preRollMs ?? 6,
  );

  // Searching a narrow band around the expected note removes octave errors
  // almost entirely, which is the failure mode that ruins an auto-map.
  let minHz = 27.5;
  let maxHz = 4200;
  if (opts.useTargetHint !== false && sample.capture.targetMidi != null) {
    const centre = midiToHz(sample.capture.targetMidi);
    minHz = centre / 1.6;
    maxHz = centre * 1.6;
  }

  const pitch = detectPitch(audio.mono, audio.sampleRate, onsetFrame, tailFrame, { minHz, maxHz });

  sample.analysis = {
    rootMidi: pitch.midi,
    cents: pitch.cents,
    confidence: pitch.confidence,
    peakDb: stats.peakDb,
    rmsDb: stats.rmsDb,
    noiseFloorDb: stats.noiseFloorDb,
    onsetFrame,
    tailFrame,
  };
}

export function analyzeAll(samples: Sample[], opts: AnalyzeOptions = {}): void {
  for (const s of samples) analyzeSample(s, opts);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export interface CleanupOptions {
  trim?: boolean;
  removeDc?: boolean;
  /** Normalise each sample to this peak, in dBFS. Null leaves levels alone. */
  normalizePeakDb?: number | null;
  /** Match levels across the set rather than per sample. */
  matchLevels?: boolean;
  fadeInMs?: number;
  fadeOutMs?: number;
}

/**
 * Apply cleanup to a set of samples, writing results into the store's processed
 * slot. Level matching runs across the whole set, which is the part that
 * actually sells a sampled instrument — inconsistent level between neighbouring
 * zones is more audible than almost any other flaw.
 */
export function cleanupSamples(samples: Sample[], opts: CleanupOptions = {}): void {
  const trim = opts.trim ?? true;
  const removeDc = opts.removeDc ?? true;

  const staged: { sample: Sample; channels: Float32Array[]; sampleRate: number; rmsDb: number }[] = [];

  for (const sample of samples) {
    const raw = sampleStore.getRaw(sample.id);
    if (!raw) continue;

    const start = trim ? (sample.analysis.onsetFrame ?? 0) : 0;
    const end = trim ? (sample.analysis.tailFrame ?? raw.frames) : raw.frames;
    const channels = sliceChannels(raw.channels, start, end);
    if (removeDc) removeDcOffset(channels);

    const mono = toMono(channels);
    staged.push({
      sample,
      channels,
      sampleRate: raw.sampleRate,
      rmsDb: levelStats(mono).rmsDb,
    });
  }

  // Level matching: bring every take to the set's median loudness, so no single
  // loud or quiet take drags the whole instrument.
  let targetRms: number | null = null;
  if (opts.matchLevels && staged.length > 1) {
    const rmsValues = staged.map((s) => s.rmsDb).filter(Number.isFinite).sort((a, b) => a - b);
    if (rmsValues.length) targetRms = rmsValues[rmsValues.length >> 1];
  }

  for (const item of staged) {
    if (targetRms != null && Number.isFinite(item.rmsDb)) {
      applyGain(item.channels, dbToGain(targetRms - item.rmsDb));
    }
    if (opts.normalizePeakDb != null) {
      let peak = 0;
      for (const ch of item.channels)
        for (let i = 0; i < ch.length; i++) {
          const a = Math.abs(ch[i]);
          if (a > peak) peak = a;
        }
      if (peak > 1e-6) applyGain(item.channels, dbToGain(opts.normalizePeakDb) / peak);
    }

    const sr = item.sampleRate;
    const fadeIn = Math.floor(((opts.fadeInMs ?? 0) / 1000) * sr);
    const fadeOut = Math.floor(((opts.fadeOutMs ?? 3) / 1000) * sr);
    if (fadeIn || fadeOut) {
      const n = item.channels[0]?.length ?? 0;
      for (const ch of item.channels) {
        for (let i = 0; i < Math.min(fadeIn, n); i++) ch[i] *= i / fadeIn;
        for (let i = 0; i < Math.min(fadeOut, n); i++) ch[n - 1 - i] *= i / fadeOut;
      }
    }

    sampleStore.setProcessed(item.sample.id, SampleStore.wrap(item.channels, sr));
    item.sample.frames = item.channels[0]?.length ?? 0;
    item.sample.processed = true;
    // Offsets were baked in by the trim, so the window is now the whole file.
    item.sample.analysis.onsetFrame = 0;
    item.sample.analysis.tailFrame = item.sample.frames;
  }
}

// ---------------------------------------------------------------------------
// Long-take splitting
// ---------------------------------------------------------------------------

/**
 * Split one long recording into individual takes.
 * The phone-recording path: play notes one at a time, drop the file in, get an
 * instrument back.
 */
export async function splitLongTake(
  source: Sample,
  opts: { thresholdDb?: number; minSilenceMs?: number; minTakeMs?: number } = {},
): Promise<ImportedSample[]> {
  const audio = sampleStore.get(source.id);
  if (!audio) return [];

  const regions = splitOnSilence(audio.mono, audio.sampleRate, opts);
  const out: ImportedSample[] = [];

  regions.forEach((region, i) => {
    const channels = sliceChannels(audio.channels, region.start, region.end);
    const wrapped = SampleStore.wrap(channels, audio.sampleRate);
    const sample: Sample = {
      id: newId('smp'),
      name: `${source.name} ${String(i + 1).padStart(2, '0')}`,
      sampleRate: audio.sampleRate,
      channels: channels.length,
      frames: wrapped.frames,
      analysis: {},
      capture: { rrIndex: 1, takenAt: Date.now() },
    };
    sampleStore.set(sample.id, wrapped);
    out.push({ sample, audio: wrapped });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

export interface LoopOptions {
  minLoopMs?: number;
  maxLoopMs?: number;
  /** Bake the crossfade into the audio rather than relying on the player. */
  bakeCrossfade?: boolean;
  /** Skip zones whose best loop scores below this. */
  minScore?: number;
}

/** Find and apply loops for every zone in a group. Returns how many succeeded. */
export function autoLoop(instrument: Instrument, group: Group, opts: LoopOptions = {}): number {
  const minScore = opts.minScore ?? 0.7;
  let found = 0;

  for (const zone of group.zones) {
    const audio = sampleStore.get(zone.sampleId);
    const sample = instrument.samples.find((s) => s.id === zone.sampleId);
    if (!audio || !sample) continue;

    const hz =
      sample.analysis.rootMidi != null
        ? midiToHz(sample.analysis.rootMidi + (sample.analysis.cents ?? 0) / 100)
        : null;

    const candidate = findLoop(audio.mono, audio.sampleRate, {
      from: zone.startFrame,
      to: zone.endFrame,
      fundamentalHz: hz,
      minLoopMs: opts.minLoopMs,
      maxLoopMs: opts.maxLoopMs,
    });

    if (!candidate || candidate.score < minScore) {
      zone.loop.mode = 'off';
      continue;
    }

    zone.loop = {
      mode: 'forward',
      start: candidate.start,
      end: candidate.end,
      crossfade: candidate.crossfade,
    };

    if (opts.bakeCrossfade && candidate.crossfade > 0) {
      const channels = audio.channels.map((c) => c.slice());
      applyLoopCrossfade(channels, candidate.start, candidate.end, candidate.crossfade);
      sampleStore.setProcessed(zone.sampleId, SampleStore.wrap(channels, audio.sampleRate));
      zone.loop.crossfade = 0;
    }
    found++;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Gap filling by repitch
// ---------------------------------------------------------------------------

export interface FillOptions {
  /** Target spacing in semitones. 1 = fully chromatic. */
  step: number;
  /** Preserve formants. Right for voice and wind, too much for struck sounds. */
  formantCorrect: boolean;
  formantStrength?: number;
  /** Never generate a note further than this from a real recording. */
  maxDistance?: number;
}

export interface FillResult {
  created: ImportedSample[];
  skipped: number;
}

/**
 * Render new samples at intermediate pitches so the instrument can be denser
 * than the session was. This is what turns a 12-note recording into a
 * chromatic instrument without stretching anything at playback time.
 */
export function fillGapsByRepitch(
  instrument: Instrument,
  group: Group,
  opts: FillOptions,
): FillResult {
  const maxDistance = opts.maxDistance ?? 3;
  const created: ImportedSample[] = [];
  let skipped = 0;

  // Work per velocity layer: a layer with fewer notes still needs filling.
  const layers = new Map<string, typeof group.zones>();
  for (const z of group.zones) {
    const key = `${z.velLow}-${z.velHigh}-${z.micId ?? ''}-${z.rrIndex}`;
    const list = layers.get(key) ?? [];
    list.push(z);
    layers.set(key, list);
  }

  for (const zones of layers.values()) {
    const roots = [...new Set(zones.map((z) => z.rootKey))].sort((a, b) => a - b);
    if (roots.length < 1) continue;
    const template = zones[0];

    for (let note = roots[0]; note <= roots[roots.length - 1]; note += opts.step) {
      if (roots.includes(note)) continue;

      // Nearest real recording wins; ties go to the lower note, which stretches
      // upward and generally sounds better than the reverse.
      let nearest = roots[0];
      for (const r of roots) if (Math.abs(r - note) < Math.abs(nearest - note)) nearest = r;
      const distance = note - nearest;
      if (Math.abs(distance) > maxDistance) {
        skipped++;
        continue;
      }

      const sourceZone = zones.find((z) => z.rootKey === nearest);
      if (!sourceZone) continue;
      const audio = sampleStore.get(sourceZone.sampleId);
      const sourceSample = instrument.samples.find((s) => s.id === sourceZone.sampleId);
      if (!audio || !sourceSample) continue;

      const channels = opts.formantCorrect
        ? repitchFormant(audio.channels, distance, opts.formantStrength ?? 1)
        : repitch(audio.channels, distance);

      const wrapped = SampleStore.wrap(channels, audio.sampleRate);
      const sample: Sample = {
        id: newId('smp'),
        name: `${sourceSample.name} →${distance > 0 ? '+' : ''}${distance}`,
        sampleRate: audio.sampleRate,
        channels: channels.length,
        frames: wrapped.frames,
        analysis: {
          rootMidi: note,
          cents: 0,
          confidence: 1,
          onsetFrame: 0,
          tailFrame: wrapped.frames,
        },
        capture: {
          targetMidi: note,
          velLayer: sourceSample.capture.velLayer,
          rrIndex: sourceSample.capture.rrIndex,
          micId: sourceSample.capture.micId,
          takenAt: Date.now(),
        },
        derivedFrom: {
          sampleId: sourceSample.id,
          semitones: distance,
          formantPreserved: opts.formantCorrect,
        },
      };
      sampleStore.set(sample.id, wrapped);
      created.push({ sample, audio: wrapped });
      void template;
    }
  }

  return { created, skipped };
}

// ============================================================================
// Level, onset and tail analysis.
//
// Everything here works off a short-window RMS envelope rather than raw
// samples, because single-sample peaks are a terrible guide to where a note
// audibly starts and stops.
// ============================================================================

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => (g <= 1e-9 ? -Infinity : 20 * Math.log10(g));

/** Average channels down to mono. Analysis always runs on mono. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const inv = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

/** RMS envelope in dBFS, one value per `hop` frames. */
export function rmsEnvelope(mono: Float32Array, windowFrames: number, hop: number): Float32Array {
  const count = Math.max(1, Math.ceil(mono.length / hop));
  const env = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const start = i * hop;
    const end = Math.min(mono.length, start + windowFrames);
    let sum = 0;
    for (let j = start; j < end; j++) sum += mono[j] * mono[j];
    const n = Math.max(1, end - start);
    env[i] = gainToDb(Math.sqrt(sum / n));
  }
  return env;
}

export interface LevelStats {
  peakDb: number;
  rmsDb: number;
  noiseFloorDb: number;
  /** True when any sample reached full scale — a clipping warning. */
  clipped: boolean;
  dcOffset: number;
}

export function levelStats(mono: Float32Array): LevelStats {
  let peak = 0;
  let sumSq = 0;
  let sum = 0;
  let clipped = false;
  for (let i = 0; i < mono.length; i++) {
    const s = mono[i];
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped = true;
    sumSq += s * s;
    sum += s;
  }
  const n = Math.max(1, mono.length);

  // Noise floor: the 5th percentile of the RMS envelope. Using the minimum
  // would lock onto a single dead window; the mean would be dragged up by the
  // note itself.
  const env = rmsEnvelope(mono, 1024, 512);
  const finite = Array.from(env).filter((d) => Number.isFinite(d));
  finite.sort((a, b) => a - b);
  const noiseFloorDb = finite.length ? finite[Math.floor(finite.length * 0.05)] : -120;

  return {
    peakDb: gainToDb(peak),
    rmsDb: gainToDb(Math.sqrt(sumSq / n)),
    noiseFloorDb,
    clipped,
    dcOffset: sum / n,
  };
}

export interface OnsetResult {
  /** Where the note starts, already backed off to keep the transient intact. */
  onsetFrame: number;
  /** Where the tail has fallen into the noise for good. */
  tailFrame: number;
}

/**
 * Find the usable span of a take.
 *
 * `thresholdDb` is relative to the measured noise floor, not absolute, so the
 * same settings work for a quiet room and a loud one. The onset is deliberately
 * rewound by `preRollMs` — trimming exactly to the first loud sample shaves the
 * attack and is the most common way to ruin a sampled instrument.
 */
export function findOnsetAndTail(
  mono: Float32Array,
  sampleRate: number,
  thresholdDb = 12,
  preRollMs = 6,
  releaseMs = 120,
): OnsetResult {
  const hop = 128;
  const win = 512;
  const env = rmsEnvelope(mono, win, hop);
  const { noiseFloorDb } = levelStats(mono);
  const gate = Math.max(noiseFloorDb + thresholdDb, -90);

  let first = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > gate) {
      first = i;
      break;
    }
  }
  if (first < 0) return { onsetFrame: 0, tailFrame: mono.length };

  let last = first;
  for (let i = env.length - 1; i >= first; i--) {
    if (env[i] > gate) {
      last = i;
      break;
    }
  }

  const preRoll = Math.floor((preRollMs / 1000) * sampleRate);
  const release = Math.floor((releaseMs / 1000) * sampleRate);
  return {
    onsetFrame: Math.max(0, first * hop - preRoll),
    tailFrame: Math.min(mono.length, last * hop + win + release),
  };
}

/**
 * Split one long recording into individual takes on silence.
 * This is the phone-recording path: play notes one at a time into a voice memo,
 * drop the file in, and get back one region per note.
 */
export function splitOnSilence(
  mono: Float32Array,
  sampleRate: number,
  opts: {
    thresholdDb?: number;
    minSilenceMs?: number;
    minTakeMs?: number;
    preRollMs?: number;
    releaseMs?: number;
  } = {},
): { start: number; end: number }[] {
  const thresholdDb = opts.thresholdDb ?? 12;
  const minSilence = ((opts.minSilenceMs ?? 250) / 1000) * sampleRate;
  const minTake = ((opts.minTakeMs ?? 120) / 1000) * sampleRate;
  const preRoll = ((opts.preRollMs ?? 6) / 1000) * sampleRate;
  const release = ((opts.releaseMs ?? 150) / 1000) * sampleRate;

  const hop = 128;
  const env = rmsEnvelope(mono, 512, hop);
  const { noiseFloorDb } = levelStats(mono);
  const gate = Math.max(noiseFloorDb + thresholdDb, -90);

  const regions: { start: number; end: number }[] = [];
  let inNote = false;
  let noteStart = 0;
  let quietRun = 0;

  for (let i = 0; i < env.length; i++) {
    const loud = env[i] > gate;
    if (loud) {
      if (!inNote) {
        inNote = true;
        noteStart = i * hop;
      }
      quietRun = 0;
    } else if (inNote) {
      quietRun += hop;
      if (quietRun >= minSilence) {
        const end = i * hop - quietRun + release;
        if (end - noteStart >= minTake)
          regions.push({
            start: Math.max(0, Math.floor(noteStart - preRoll)),
            end: Math.min(mono.length, Math.floor(end)),
          });
        inNote = false;
        quietRun = 0;
      }
    }
  }
  if (inNote && mono.length - noteStart >= minTake)
    regions.push({
      start: Math.max(0, Math.floor(noteStart - preRoll)),
      end: mono.length,
    });

  return regions;
}

/**
 * Min/max peak pairs for waveform drawing, at `buckets` resolution.
 * Returns interleaved [min0, max0, min1, max1, ...].
 */
export function computePeaks(mono: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  const per = mono.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(mono.length, Math.floor((b + 1) * per));
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end; i++) {
      const s = mono[i];
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cleanup operations
// ---------------------------------------------------------------------------

/** Remove DC offset in place. Cheap, and it prevents clicks at zone edges. */
export function removeDcOffset(channels: Float32Array[]): void {
  for (const ch of channels) {
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i];
    const dc = sum / Math.max(1, ch.length);
    if (Math.abs(dc) < 1e-6) continue;
    for (let i = 0; i < ch.length; i++) ch[i] -= dc;
  }
}

/** Scale all channels by a linear gain, preserving the stereo image. */
export function applyGain(channels: Float32Array[], gain: number): void {
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
}

/** Equal-power-ish fades at the edges of a region, in place. */
export function applyFades(channels: Float32Array[], fadeIn: number, fadeOut: number): void {
  const n = channels[0]?.length ?? 0;
  for (const ch of channels) {
    for (let i = 0; i < Math.min(fadeIn, n); i++) ch[i] *= i / fadeIn;
    for (let i = 0; i < Math.min(fadeOut, n); i++) ch[n - 1 - i] *= i / fadeOut;
  }
}

export function sliceChannels(channels: Float32Array[], start: number, end: number): Float32Array[] {
  return channels.map((ch) => ch.slice(Math.max(0, start), Math.min(ch.length, end)));
}

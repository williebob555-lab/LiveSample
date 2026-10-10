// ============================================================================
// Automatic mapping.
//
// Turns a pile of analysed takes into zones. The rules are deliberately the
// ones a careful person would apply by hand:
//
//   - a zone's root is its detected pitch, falling back to the note the capture
//     session asked for when detection was not confident
//   - key ranges meet at the midpoint between neighbouring roots, so every
//     sample is stretched as little as possible
//   - velocity layers split the 1..127 range by measured loudness order
//   - takes that share a note and layer become round robins of each other
// ============================================================================

import {
  type Instrument,
  type Sample,
  type Zone,
  type Group,
  type Midi,
  defaultLoop,
  newId,
} from './types';

export interface AutoMapOptions {
  /** Below this pitch confidence, trust the capture target instead. */
  confidenceFloor?: number;
  /** Correct each zone's tuning to exact pitch using the detected cents. */
  tuneToExactPitch?: boolean;
  /** Extend the lowest and highest zones to the ends of the keyboard. */
  extendEdges?: boolean;
  /** Assign velocity layers from measured RMS rather than capture metadata. */
  velocityFromLevel?: boolean;
  /** Velocity layers to split into when inferring from level. */
  velocityLayers?: number;
}

interface Placed {
  sample: Sample;
  root: number;
  cents: number;
  velLayer: number;
  rrIndex: number;
}

/** The root note we will actually use for a take. */
function resolveRoot(s: Sample, confidenceFloor: number): { root: Midi; cents: number } | null {
  const a = s.analysis;
  const confident = a.rootMidi != null && (a.confidence ?? 0) >= confidenceFloor;
  if (confident) return { root: a.rootMidi as number, cents: a.cents ?? 0 };
  // Detection failed or was unsure — the session knows what it asked for.
  if (s.capture.targetMidi != null) return { root: s.capture.targetMidi, cents: 0 };
  if (a.rootMidi != null) return { root: a.rootMidi, cents: a.cents ?? 0 };
  return null;
}

/**
 * Build zones for one group from a set of samples.
 * Existing zones on the group are replaced.
 */
export function autoMap(samples: Sample[], group: Group, opts: AutoMapOptions = {}): Zone[] {
  const confidenceFloor = opts.confidenceFloor ?? 0.6;
  const tuneToExact = opts.tuneToExactPitch ?? true;
  const extendEdges = opts.extendEdges ?? true;
  const velocityLayers = opts.velocityLayers ?? 1;

  const placed: Placed[] = [];
  for (const s of samples) {
    const r = resolveRoot(s, confidenceFloor);
    if (!r) continue;
    placed.push({
      sample: s,
      root: r.root,
      cents: r.cents,
      velLayer: s.capture.velLayer ?? 1,
      rrIndex: s.capture.rrIndex ?? 1,
    });
  }
  if (!placed.length) return [];

  // Infer velocity layers from loudness when capture metadata does not carry
  // them — this is the import-a-folder path, where all we have is the audio.
  if (opts.velocityFromLevel && velocityLayers > 1) {
    const byNote = new Map<number, Placed[]>();
    for (const p of placed) {
      const list = byNote.get(p.root) ?? [];
      list.push(p);
      byNote.set(p.root, list);
    }
    for (const list of byNote.values()) {
      list.sort((a, b) => (a.sample.analysis.rmsDb ?? -120) - (b.sample.analysis.rmsDb ?? -120));
      const per = Math.max(1, Math.ceil(list.length / velocityLayers));
      list.forEach((p, i) => {
        p.velLayer = Math.min(velocityLayers, Math.floor(i / per) + 1);
      });
    }
  }

  const layerCount = Math.max(1, ...placed.map((p) => p.velLayer));
  const zones: Zone[] = [];

  // Each velocity layer gets its own independent key map, so a layer with
  // fewer notes still covers the whole keyboard.
  for (let layer = 1; layer <= layerCount; layer++) {
    const inLayer = placed.filter((p) => p.velLayer === layer);
    if (!inLayer.length) continue;

    const { lowVel, highVel } = velocityRange(layer, layerCount);

    // Group by root: same note + same layer means round robins.
    const byRoot = new Map<number, Placed[]>();
    for (const p of inLayer) {
      const list = byRoot.get(p.root) ?? [];
      list.push(p);
      byRoot.set(p.root, list);
    }
    const roots = [...byRoot.keys()].sort((a, b) => a - b);

    roots.forEach((root, i) => {
      // Split at the midpoint with each neighbour. The lower zone takes the
      // floor of the midpoint so the two never overlap or leave a gap.
      const prev = i > 0 ? roots[i - 1] : null;
      const next = i < roots.length - 1 ? roots[i + 1] : null;
      let keyLow = prev == null ? root : Math.floor((prev + root) / 2) + 1;
      let keyHigh = next == null ? root : Math.floor((root + next) / 2);
      if (extendEdges) {
        if (prev == null) keyLow = 0;
        if (next == null) keyHigh = 127;
      }

      const takes = byRoot.get(root) as Placed[];
      takes.sort((a, b) => a.rrIndex - b.rrIndex);
      takes.forEach((p, rr) => {
        zones.push({
          id: newId('zn'),
          sampleId: p.sample.id,
          micId: p.sample.capture.micId,
          keyLow,
          keyHigh,
          rootKey: root,
          velLow: lowVel,
          velHigh: highVel,
          rrIndex: rr + 1,
          // Detected pitch sits `cents` above the note; correcting means
          // pulling the sample back down by that amount.
          tuneCents: tuneToExact ? -p.cents : 0,
          gainDb: 0,
          pan: 0,
          startFrame: p.sample.analysis.onsetFrame ?? 0,
          endFrame: p.sample.analysis.tailFrame ?? p.sample.frames,
          loop: defaultLoop(),
          fadeInFrames: 0,
          fadeOutFrames: 0,
        });
      });
    });
  }

  group.zones = zones;
  return zones;
}

/** Evenly split 1..127 into `count` layers, returning the one at `index`. */
export function velocityRange(index: number, count: number): { lowVel: number; highVel: number } {
  if (count <= 1) return { lowVel: 1, highVel: 127 };
  const per = 127 / count;
  const lowVel = Math.floor((index - 1) * per) + 1;
  const highVel = index === count ? 127 : Math.floor(index * per);
  return { lowVel, highVel };
}

/**
 * Which notes a capture plan should ask for.
 * Always includes the top note even when the step does not divide evenly —
 * leaving the top of the range unsampled is a common and audible mistake.
 */
export function planNotes(lowNote: Midi, highNote: Midi, step: number): Midi[] {
  const notes: Midi[] = [];
  for (let n = lowNote; n <= highNote; n += step) notes.push(n);
  if (notes[notes.length - 1] !== highNote) notes.push(highNote);
  return notes;
}

/** Gaps in the mapping — notes no zone covers. Surfaced as a warning. */
export function findGaps(instrument: Instrument): { low: Midi; high: Midi }[] {
  const covered = new Uint8Array(128);
  for (const g of instrument.groups)
    for (const z of g.zones)
      for (let k = Math.max(0, z.keyLow); k <= Math.min(127, z.keyHigh); k++) covered[k] = 1;

  const gaps: { low: Midi; high: Midi }[] = [];
  let start = -1;
  for (let k = 0; k < 128; k++) {
    if (!covered[k] && start < 0) start = k;
    else if (covered[k] && start >= 0) {
      gaps.push({ low: start, high: k - 1 });
      start = -1;
    }
  }
  if (start >= 0) gaps.push({ low: start, high: 127 });
  return gaps;
}

/**
 * Largest stretch any zone asks of its sample, in semitones, measured only
 * across the span that was actually sampled.
 *
 * The outermost zones are deliberately extended to key 0 and 127 so the
 * instrument responds across the whole keyboard, which would otherwise dominate
 * this number and make it meaningless — an edge zone always reads as 60+
 * semitones. What matters for quality is how far a sample is stretched *between*
 * recorded notes, so the tails beyond the outermost roots are excluded.
 */
export function maxStretch(instrument: Instrument): number {
  const zones = instrument.groups.flatMap((g) => g.zones);
  if (!zones.length) return 0;

  const roots = zones.map((z) => z.rootKey);
  const lowestRoot = Math.min(...roots);
  const highestRoot = Math.max(...roots);

  let worst = 0;
  for (const z of zones) {
    const low = Math.max(z.keyLow, lowestRoot);
    const high = Math.min(z.keyHigh, highestRoot);
    if (low > high) continue; // entirely in an extended tail
    worst = Math.max(worst, Math.abs(low - z.rootKey), Math.abs(high - z.rootKey));
  }
  return worst;
}

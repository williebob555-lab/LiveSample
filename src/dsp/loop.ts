// ============================================================================
// Loop point finding.
//
// Normally the most tedious part of building a sustained instrument, and the
// part most often done badly — a loop that breathes or thumps is immediately
// audible. The search maximises normalised cross-correlation between the audio
// following the loop start and the audio following the loop end, which is
// exactly the continuity condition a splice needs.
//
// When the fundamental is known the candidate loop lengths are snapped to whole
// periods. That single constraint is what separates a loop that locks from one
// that phases, because a loop of non-integer periods restarts the waveform out
// of phase with itself every pass.
// ============================================================================

export interface LoopCandidate {
  start: number;
  /** Exclusive. */
  end: number;
  /** -1..1 normalised cross-correlation at the splice. Above ~0.9 is good. */
  score: number;
  /** Suggested crossfade length in frames. */
  crossfade: number;
}

export interface LoopSearchOptions {
  /** Restrict the search to this span (normally the sustain). */
  from?: number;
  to?: number;
  /** Fundamental in Hz. When given, loop lengths snap to whole periods. */
  fundamentalHz?: number | null;
  /** Comparison window length in frames. */
  windowFrames?: number;
  minLoopMs?: number;
  maxLoopMs?: number;
  /** How many end positions to evaluate. Higher is slower but finds more. */
  candidates?: number;
}

/** Normalised cross-correlation of two equal-length spans. */
function ncc(x: Float32Array, a: number, b: number, len: number): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const va = x[a + i];
    const vb = x[b + i];
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  const denom = Math.sqrt(na * nb);
  return denom < 1e-12 ? 0 : dot / denom;
}

/**
 * Find the best loop within a sustained sample.
 * Returns null when nothing scores well enough to be worth using.
 */
export function findLoop(
  mono: Float32Array,
  sampleRate: number,
  opts: LoopSearchOptions = {},
): LoopCandidate | null {
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(mono.length, opts.to ?? mono.length);
  const windowFrames = opts.windowFrames ?? Math.floor(sampleRate * 0.04);
  const minLoop = Math.floor(((opts.minLoopMs ?? 60) / 1000) * sampleRate);
  const maxLoop = Math.floor(((opts.maxLoopMs ?? 1200) / 1000) * sampleRate);
  const candidates = opts.candidates ?? 400;

  const span = to - from;
  if (span < minLoop + windowFrames * 2) return null;

  // Start a little way into the sustain so the attack is never inside the loop,
  // and leave room for the comparison window past the end.
  const loopStart = from + Math.floor(span * 0.35);
  const maxEnd = to - windowFrames;
  const minEnd = loopStart + minLoop;
  if (maxEnd <= minEnd) return null;

  const period = opts.fundamentalHz ? sampleRate / opts.fundamentalHz : 0;
  const usableMax = Math.min(maxEnd, loopStart + maxLoop);
  if (usableMax <= minEnd) return null;

  let best: LoopCandidate | null = null;
  const evaluate = (end: number): void => {
    if (end <= minEnd || end > usableMax) return;
    if (end + windowFrames > mono.length) return;
    const score = ncc(mono, loopStart, end, windowFrames);
    // Slight preference for longer loops at equal quality: long loops sound
    // less static, and a short loop that scores marginally better still reveals
    // itself as a repeating cycle within a second or two.
    const lengthBonus = ((end - loopStart) / usableMax) * 0.02;
    const total = score + lengthBonus;
    if (!best || total > best.score) {
      best = { start: loopStart, end, score: total, crossfade: 0 };
    }
  };

  if (period >= 8) {
    // Snap to whole periods — walk period-multiples across the usable range.
    const firstN = Math.ceil(minLoop / period);
    const lastN = Math.floor((usableMax - loopStart) / period);
    const stride = Math.max(1, Math.floor((lastN - firstN) / candidates));
    for (let n = firstN; n <= lastN; n += stride) evaluate(loopStart + Math.round(n * period));
  } else {
    const stride = Math.max(1, Math.floor((usableMax - minEnd) / candidates));
    for (let end = minEnd; end <= usableMax; end += stride) evaluate(end);
  }

  if (!best) return null;
  const found = best as LoopCandidate;

  // Refine: search ±1 period (or ±2ms) around the winner at single-frame
  // resolution. The coarse pass finds the right cycle, this finds the right
  // frame within it.
  const refineRange = Math.round(period >= 8 ? period : sampleRate * 0.002);
  let refinedEnd = found.end;
  let refinedScore = ncc(mono, loopStart, found.end, windowFrames);
  for (let d = -refineRange; d <= refineRange; d++) {
    const end = found.end + d;
    if (end <= minEnd || end + windowFrames > mono.length) continue;
    const s = ncc(mono, loopStart, end, windowFrames);
    if (s > refinedScore) {
      refinedScore = s;
      refinedEnd = end;
    }
  }

  if (refinedScore < 0.5) return null;

  // Crossfade a fraction of the loop, capped — long fades on a short loop blur
  // the sound rather than hiding the splice.
  const loopLen = refinedEnd - loopStart;
  const crossfade = Math.min(Math.floor(loopLen * 0.25), Math.floor(sampleRate * 0.05), loopStart);

  return { start: loopStart, end: refinedEnd, score: refinedScore, crossfade };
}

/**
 * Bake a crossfade into the loop so the splice is seamless in players that do
 * not crossfade themselves (most of them). The region before the loop end is
 * blended with the region before the loop start, which is the standard
 * destructive loop crossfade.
 */
export function applyLoopCrossfade(
  channels: Float32Array[],
  loopStart: number,
  loopEnd: number,
  crossfade: number,
): void {
  if (crossfade <= 0 || loopStart - crossfade < 0) return;
  for (const ch of channels) {
    if (loopEnd > ch.length) continue;
    for (let i = 0; i < crossfade; i++) {
      const t = i / crossfade;
      // Equal-power blend keeps perceived level constant through the splice.
      const fadeOut = Math.cos((t * Math.PI) / 2);
      const fadeIn = Math.sin((t * Math.PI) / 2);
      const outIdx = loopEnd - crossfade + i;
      const inIdx = loopStart - crossfade + i;
      ch[outIdx] = ch[outIdx] * fadeOut + ch[inIdx] * fadeIn;
    }
  }
}

/**
 * How audible a loop is likely to be, as a 0..1 quality score.
 * Surfaced in the UI so a bad loop can be rejected without listening to all of
 * them — but it is a hint, not a verdict.
 */
export function loopQuality(mono: Float32Array, loop: LoopCandidate, windowFrames: number): number {
  const raw = ncc(mono, loop.start, loop.end, Math.min(windowFrames, mono.length - loop.end));
  return Math.max(0, Math.min(1, (raw - 0.5) / 0.5));
}

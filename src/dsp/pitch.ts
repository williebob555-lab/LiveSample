// ============================================================================
// Pitch detection (YIN).
//
// Used to work out a take's root note and how far it sits from equal
// temperament. Both matter: the note decides where the sample maps, and the
// cents offset is what lets the app tune a whole set to pitch so zone
// crossings do not wobble.
//
// De Cheveigné & Kawahara (2002), steps 1-5. Step 6 (best local estimate) is
// replaced by taking the median across several analysis windows, which is more
// robust on decaying acoustic material than a single window would be.
// ============================================================================

export interface PitchResult {
  hz: number | null;
  midi: number | null;
  /** Signed deviation from the nearest equal-tempered semitone, -50..50. */
  cents: number;
  /** 0..1. Below about 0.6 the reading should be treated as a guess. */
  confidence: number;
}

const EMPTY: PitchResult = { hz: null, midi: null, cents: 0, confidence: 0 };

export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiName(m: number): string {
  const n = Math.round(m);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

const LETTER_PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/**
 * Parse a note name into a MIDI number. Accepts the spellings people actually
 * type — `C3`, `f#4`, `Bb2`, `A-1`, `Gs5` — and a bare MIDI number, so pasting
 * a value from somewhere else still works.
 *
 * Returns null when it is not a note, which callers use to reject the edit and
 * restore the previous value rather than silently writing a wrong pitch.
 */
export function parseNote(text: string): number | null {
  const s = text.trim();
  if (!s) return null;

  if (/^\d{1,3}$/.test(s)) {
    const n = Number(s);
    return n >= 0 && n <= 127 ? n : null;
  }

  const m = s.match(/^([A-Ga-g])\s*([#♯sb♭]?)\s*(-?\d{1,2})$/);
  if (!m) return null;

  let pc = LETTER_PITCH[m[1].toLowerCase()];
  const accidental = m[2];
  if (accidental === '#' || accidental === '♯' || accidental === 's') pc += 1;
  else if (accidental === 'b' || accidental === '♭') pc -= 1;

  const midi = (parseInt(m[3], 10) + 1) * 12 + pc;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/**
 * One YIN pass over a single window.
 * Returns frequency in Hz, plus the aperiodicity at the chosen lag.
 */
function yinWindow(
  x: Float32Array,
  offset: number,
  windowSize: number,
  sampleRate: number,
  minHz: number,
  maxHz: number,
  threshold: number,
): { hz: number; aperiodicity: number } | null {
  const maxTau = Math.min(Math.floor(sampleRate / minHz), windowSize >> 1);
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  if (maxTau <= minTau || offset + windowSize + maxTau > x.length) return null;

  const diff = new Float32Array(maxTau + 1);
  for (let tau = minTau; tau <= maxTau; tau++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const d = x[offset + j] - x[offset + j + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  // Cumulative mean normalised difference — this is what makes YIN robust to
  // amplitude changes, and what turns the raw difference into a 0..1 score.
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += diff[tau];
    cmnd[tau] = running === 0 ? 1 : (diff[tau] * tau) / running;
  }

  // First dip below threshold, walked down to its local minimum. Taking the
  // *first* rather than the global minimum is what avoids octave errors.
  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate < 0) {
    let best = minTau;
    for (let tau = minTau; tau <= maxTau; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
    // Nothing crossed the threshold, so this window is probably unpitched.
    if (cmnd[best] > 0.8) return null;
    tauEstimate = best;
  }

  // Parabolic interpolation around the minimum for sub-sample precision —
  // without this the reading quantises badly at high pitches.
  let refined = tauEstimate;
  if (tauEstimate > minTau && tauEstimate < maxTau) {
    const a = cmnd[tauEstimate - 1];
    const b = cmnd[tauEstimate];
    const c = cmnd[tauEstimate + 1];
    const denom = 2 * (2 * b - a - c);
    if (denom !== 0) refined = tauEstimate + (c - a) / denom;
  }

  return { hz: sampleRate / refined, aperiodicity: cmnd[tauEstimate] };
}

export interface PitchOptions {
  minHz?: number;
  maxHz?: number;
  threshold?: number;
  windowSize?: number;
  /** How many windows to sample across the analysis region. */
  passes?: number;
  /** Skip this fraction of the region at the start (attacks are noisy). */
  skipHead?: number;
}

/**
 * Detect the pitch of a mono signal by taking the median of several YIN
 * windows spread across the steady part of the note.
 */
export function detectPitch(
  mono: Float32Array,
  sampleRate: number,
  from = 0,
  to = -1,
  opts: PitchOptions = {},
): PitchResult {
  const minHz = opts.minHz ?? 27.5; // A0
  const maxHz = opts.maxHz ?? 4200; // ~C8
  const threshold = opts.threshold ?? 0.15;
  const windowSize = opts.windowSize ?? 2048;
  const passes = opts.passes ?? 7;
  const skipHead = opts.skipHead ?? 0.15;

  const end = to < 0 ? mono.length : Math.min(to, mono.length);
  const maxTau = Math.floor(sampleRate / minHz);
  const need = windowSize + maxTau;
  let start = from + Math.floor((end - from) * skipHead);
  if (end - start < need) start = Math.max(0, end - need);
  const span = end - start - need;
  if (span < 0) return EMPTY;

  const results: { hz: number; aperiodicity: number }[] = [];
  for (let i = 0; i < passes; i++) {
    const off = start + (passes === 1 ? 0 : Math.floor((span * i) / (passes - 1)));
    const r = yinWindow(mono, off, windowSize, sampleRate, minHz, maxHz, threshold);
    if (r && Number.isFinite(r.hz)) results.push(r);
  }
  if (!results.length) return EMPTY;

  // Median in the log domain: octave outliers pull a linear mean badly.
  const cents = results.map((r) => 1200 * Math.log2(r.hz));
  cents.sort((a, b) => a - b);
  const medianCents = cents[cents.length >> 1];
  const hz = Math.pow(2, medianCents / 1200);

  // Agreement between windows is a better confidence signal than any single
  // aperiodicity — a stable reading across the note is what we actually want.
  const spread =
    cents.reduce((acc, c) => acc + Math.abs(c - medianCents), 0) / cents.length;
  const meanAperiodicity =
    results.reduce((acc, r) => acc + r.aperiodicity, 0) / results.length;
  const agreement = Math.max(0, 1 - spread / 50);
  const confidence = Math.max(0, Math.min(1, (1 - meanAperiodicity) * 0.5 + agreement * 0.5));

  const midiFloat = hzToMidi(hz);
  const midi = Math.round(midiFloat);
  return {
    hz,
    midi: midi >= 0 && midi <= 127 ? midi : null,
    cents: (midiFloat - midi) * 100,
    confidence,
  };
}

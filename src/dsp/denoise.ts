// ============================================================================
// Spectral-gating noise reduction.
//
// The recipe is the classic one: STFT, learn what the noise looks like per
// frequency bin, attenuate every bin that does not rise clearly above it, and
// overlap-add back. The details that matter are the ones that keep it from
// sounding like a denoiser:
//
//   * The profile comes from the *quietest frames of the take itself* (the
//     room before the onset, or the tail after the note has died). A take is
//     the only place its own noise is guaranteed to be found, and no separate
//     "noise only" recording is needed.
//   * Gain is reduced to a floor (the strength), never to zero, and is a soft
//     function of how far a bin sits above the threshold. A hard on/off gate
//     flips individual bins from frame to frame, which is exactly the warbling
//     "musical noise" this is trying to avoid.
//   * Gain is then smoothed across frequency and, asymmetrically, across time:
//     opening is instant (never dull an attack), closing is slow (never chop a
//     decay). The time smoothing runs both forwards and backwards so the gate
//     also opens slightly *before* a transient instead of pre-ringing late.
//
// Length and timing are preserved exactly: the signal is padded so every output
// sample is covered by four full windows, and the padding is cut off again.
// ============================================================================

import { FFT, hann } from './fft';

export interface DenoiseOptions {
  /** How far to pull noise down, in dB (positive). */
  strengthDb?: number;
  /** Bins must exceed the learned noise magnitude times this to pass untouched. */
  threshold?: number;
  /** STFT size; hop is always a quarter of it (75% overlap). */
  fftSize?: number;
  /** Fraction of the quietest frames the noise profile is averaged over. */
  profileFraction?: number;
  /** How slowly the gate closes, in milliseconds. */
  releaseMs?: number;
}

export const DEFAULT_DENOISE: Required<DenoiseOptions> = {
  strengthDb: 18,
  threshold: 2,
  fftSize: 2048,
  profileFraction: 0.1,
  releaseMs: 60,
};

/** Denoise one channel. Returns a new array of identical length. */
export function denoiseChannel(
  input: Float32Array,
  sampleRate: number,
  opts: DenoiseOptions = {},
): Float32Array {
  const o = { ...DEFAULT_DENOISE, ...opts };
  const N = o.fftSize;
  const hop = N / 4;
  const bins = N / 2 + 1;
  const len = input.length;
  // Too short to hold even a handful of frames: nothing meaningful to learn.
  if (len < N || o.strengthDb <= 0) return input.slice();

  const fft = new FFT(N);
  const win = hann(N);

  // Pad N-hop samples either side so the first and last real samples are each
  // covered by four windows; otherwise the edges would be under-reconstructed.
  const pad = N - hop;
  const total = len + 2 * pad;
  const frames = Math.floor((total - N) / hop) + 1;
  const padded = new Float32Array(frames * hop + N);
  padded.set(input, pad);

  const re = new Float32Array(N);
  const im = new Float32Array(N);

  // Pass 1: complex spectra (kept) and magnitudes.
  const specRe: Float32Array[] = [];
  const specIm: Float32Array[] = [];
  const mags: Float32Array[] = [];
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = padded[off + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    const r = re.slice(0, bins);
    const m = im.slice(0, bins);
    const mag = new Float32Array(bins);
    let e = 0;
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.hypot(r[k], m[k]);
      e += mag[k] * mag[k];
    }
    energy[f] = e;
    specRe.push(r);
    specIm.push(m);
    mags.push(mag);
  }

  // Noise profile: mean magnitude over the quietest frames. Frames that are
  // mostly the zero padding are excluded or they would drag the profile to 0.
  const usable: number[] = [];
  for (let f = 0; f < frames; f++) {
    const start = f * hop - pad;
    if (start >= 0 && start + N <= len) usable.push(f);
  }
  usable.sort((a, b) => energy[a] - energy[b]);
  const take = Math.max(3, Math.round(usable.length * o.profileFraction));
  const profile = new Float32Array(bins);
  const used = usable.slice(0, take);
  for (const f of used) for (let k = 0; k < bins; k++) profile[k] += mags[f][k];
  for (let k = 0; k < bins; k++) profile[k] = (profile[k] / used.length) * o.threshold;

  // Pass 2: per-bin gain, soft knee between 1x and 2x the threshold.
  const floor = Math.pow(10, -o.strengthDb / 20);
  const gains: Float32Array[] = [];
  for (let f = 0; f < frames; f++) {
    const g = new Float32Array(bins);
    const mag = mags[f];
    for (let k = 0; k < bins; k++) {
      const t = profile[k];
      const x = t > 0 ? Math.min(1, Math.max(0, mag[k] / t - 1)) : 1;
      // smoothstep so the knee has no corner
      g[k] = floor + (1 - floor) * (x * x * (3 - 2 * x));
    }
    // Frequency smoothing: 5-tap binomial. A lone surviving bin is the
    // signature of musical noise, so isolated peaks get spread and reduced.
    const s = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const a = g[Math.max(0, k - 2)];
      const b = g[Math.max(0, k - 1)];
      const d = g[Math.min(bins - 1, k + 1)];
      const e = g[Math.min(bins - 1, k + 2)];
      s[k] = (a + 4 * b + 6 * g[k] + 4 * d + e) / 16;
    }
    // Smoothing must never *lower* a bin that is clearly signal.
    for (let k = 0; k < bins; k++) s[k] = Math.max(s[k], g[k] > 0.99 ? g[k] : 0);
    gains.push(s);
  }

  // Time smoothing: instant attack, exponential release, forwards and back.
  const rel = Math.exp(-hop / ((o.releaseMs / 1000) * sampleRate));
  const fwd = gains.map((g) => g.slice());
  for (let f = 1; f < frames; f++)
    for (let k = 0; k < bins; k++) fwd[f][k] = Math.max(fwd[f][k], fwd[f - 1][k] * rel);
  const bwd = gains.map((g) => g.slice());
  for (let f = frames - 2; f >= 0; f--)
    for (let k = 0; k < bins; k++) bwd[f][k] = Math.max(bwd[f][k], bwd[f + 1][k] * rel);

  // Pass 3: apply, inverse transform, overlap-add with the same Hann window.
  // Hann^2 at 75% overlap sums to 1.5 everywhere, hence the normalisation.
  const out = new Float32Array(padded.length);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < bins; k++) {
      const g = Math.max(fwd[f][k], bwd[f][k]);
      re[k] = specRe[f][k] * g;
      im[k] = specIm[f][k] * g;
    }
    for (let k = 1; k < N / 2; k++) {
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    fft.transform(re, im, true);
    const off = f * hop;
    for (let i = 0; i < N; i++) out[off + i] += re[i] * win[i] / 1.5;
  }
  return out.slice(pad, pad + len);
}

/** Denoise every channel independently, keeping length and channel count. */
export function denoise(
  channels: Float32Array[],
  sampleRate: number,
  opts: DenoiseOptions = {},
): Float32Array[] {
  return channels.map((c) => denoiseChannel(c, sampleRate, opts));
}

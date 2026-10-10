// ============================================================================
// Resampling and repitching — "fill the gaps".
//
// Two different jobs share this file:
//
//   repitch()         plain resample. Changes pitch, length and formants
//                     together, exactly like playing a tape faster. This is
//                     what every sampler does at playback time.
//
//   repitchFormant()  resample, then push the spectral envelope back where it
//                     started. Formants are what make a voice sound like a
//                     voice at any pitch; shifting them is what produces the
//                     chipmunk effect. Correcting them is what lets you sample
//                     every 4th note and still ship a chromatic instrument.
//
// The resampler is windowed-sinc (Blackman-windowed, 32 taps). Linear
// interpolation is cheap but its aliasing is plainly audible on bright material
// pitched down, which is exactly the case we care about.
// ============================================================================

import { FFT, hann } from './fft';

const TAPS = 16; // taps either side of the sample point

function sinc(x: number): number {
  if (Math.abs(x) < 1e-9) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Blackman window evaluated at t in -1..1. */
function blackman(t: number): number {
  const x = (t + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

/**
 * Resample one channel by `ratio` (output length = input length / ratio).
 * A ratio above 1 plays faster and therefore higher.
 */
export function resampleChannel(input: Float32Array, ratio: number): Float32Array {
  if (ratio === 1) return input.slice();
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);

  // When downsampling, the sinc has to be stretched to act as the anti-alias
  // filter for the new, lower Nyquist. Upsampling needs no such correction.
  const cutoff = ratio > 1 ? 1 / ratio : 1;

  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const center = Math.floor(pos);
    const frac = pos - center;
    let sum = 0;
    let norm = 0;
    for (let t = -TAPS + 1; t <= TAPS; t++) {
      const idx = center + t;
      if (idx < 0 || idx >= input.length) continue;
      const dist = t - frac;
      const w = blackman(dist / TAPS) * sinc(dist * cutoff) * cutoff;
      sum += input[idx] * w;
      norm += w;
    }
    out[i] = norm > 1e-9 ? sum / norm : 0;
  }
  return out;
}

/** Plain repitch by a number of semitones (positive = up). */
export function repitch(channels: Float32Array[], semitones: number): Float32Array[] {
  if (semitones === 0) return channels.map((c) => c.slice());
  const ratio = Math.pow(2, semitones / 12);
  return channels.map((c) => resampleChannel(c, ratio));
}

// ---------------------------------------------------------------------------
// Formant-corrected repitch
// ---------------------------------------------------------------------------

/**
 * Spectral envelope of one magnitude frame, via cepstral liftering.
 * Low quefrency = the smooth envelope (formants); high = the harmonics.
 */
function spectralEnvelope(mag: Float32Array, fft: FFT, quefrency: number): Float32Array {
  const n = fft.size;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.log(Math.max(mag[i], 1e-7));

  fft.transform(re, im, true);
  for (let i = quefrency; i < n - quefrency; i++) {
    re[i] = 0;
    im[i] = 0;
  }
  fft.transform(re, im, false);

  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.exp(re[i]);
  return env;
}

/**
 * Repitch while holding the formants in place.
 *
 * The sample is resampled first (which moves pitch and formants together), then
 * each STFT frame is re-shaped so its spectral envelope matches the envelope
 * the original had at the same absolute frequency.
 *
 * `strength` 0..1 blends between plain repitch and full correction — full
 * correction is right for voice and wind, but too much of it makes struck and
 * plucked material sound synthetic, so it is worth exposing.
 */
export function repitchFormant(
  channels: Float32Array[],
  semitones: number,
  strength = 1,
  frameSize = 2048,
): Float32Array[] {
  if (semitones === 0) return channels.map((c) => c.slice());
  const shifted = repitch(channels, semitones);
  if (strength <= 0) return shifted;

  const ratio = Math.pow(2, semitones / 12);
  const fft = new FFT(frameSize);
  const win = hann(frameSize);
  const hop = frameSize / 4;
  const quefrency = 40;

  return shifted.map((sig, ch) => {
    const original = channels[ch];
    const out = new Float32Array(sig.length);
    const norm = new Float32Array(sig.length);

    const re = new Float32Array(frameSize);
    const im = new Float32Array(frameSize);
    const mag = new Float32Array(frameSize);
    const origRe = new Float32Array(frameSize);
    const origIm = new Float32Array(frameSize);
    const origMag = new Float32Array(frameSize);

    for (let pos = 0; pos + frameSize <= sig.length; pos += hop) {
      for (let i = 0; i < frameSize; i++) {
        re[i] = sig[pos + i] * win[i];
        im[i] = 0;
      }
      fft.transform(re, im, false);
      for (let i = 0; i < frameSize; i++) mag[i] = Math.hypot(re[i], im[i]);

      // The same moment in the untouched signal, so we can read the envelope
      // the sound is supposed to have.
      const origPos = Math.min(
        Math.max(0, Math.round(pos * ratio)),
        Math.max(0, original.length - frameSize),
      );
      for (let i = 0; i < frameSize; i++) {
        origRe[i] = (original[origPos + i] ?? 0) * win[i];
        origIm[i] = 0;
      }
      fft.transform(origRe, origIm, false);
      for (let i = 0; i < frameSize; i++) origMag[i] = Math.hypot(origRe[i], origIm[i]);

      const shiftedEnv = spectralEnvelope(mag, fft, quefrency);
      const targetEnv = spectralEnvelope(origMag, fft, quefrency);

      for (let i = 0; i < frameSize; i++) {
        const from = shiftedEnv[i];
        const to = targetEnv[i];
        if (from < 1e-7) continue;
        const correction = Math.pow(to / from, strength);
        // Clamp: cepstral ratios blow up in near-silent bins and would turn
        // noise into whistles.
        const g = Math.max(0.05, Math.min(20, correction));
        re[i] *= g;
        im[i] *= g;
      }

      fft.transform(re, im, true);
      for (let i = 0; i < frameSize; i++) {
        out[pos + i] += re[i] * win[i];
        norm[pos + i] += win[i] * win[i];
      }
    }

    for (let i = 0; i < out.length; i++) {
      out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : sig[i];
    }
    return out;
  });
}

/**
 * How far a sample can be stretched before it stops sounding like itself.
 * Rough guidance, exposed in the UI so a capture plan can be chosen before the
 * session rather than regretted after it.
 */
export const STRETCH_GUIDANCE: { label: string; maxSemitones: number; step: number }[] = [
  { label: 'Voice, solo winds', maxSemitones: 2, step: 2 },
  { label: 'Bowed strings, brass', maxSemitones: 3, step: 3 },
  { label: 'Piano, plucked strings', maxSemitones: 4, step: 4 },
  { label: 'Mallets, bells', maxSemitones: 6, step: 6 },
  { label: 'Pads, drones, synths', maxSemitones: 12, step: 12 },
];

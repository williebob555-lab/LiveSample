// ============================================================================
// Reference tones for capture sessions.
//
// A sine is a poor pitch reference: with no harmonics the ear has nothing to
// anchor the octave to, and at the top and bottom of the range — exactly where
// matching pitch is hardest — it becomes genuinely ambiguous. These presets are
// additive stacks with real harmonic content, synthesised at any pitch, so they
// work from the first note of a session before anything has been recorded.
//
// Built from oscillators rather than sample data: no assets to ship, correct at
// every pitch, and cheap enough to fire between takes without a thought.
// ============================================================================

import { midiToHz } from '../dsp/pitch';

export type RefPreset = 'sine' | 'triangle' | 'organ' | 'piano' | 'pluck' | 'reed';

export const REF_PRESETS: { value: RefPreset; label: string; hint: string }[] = [
  { value: 'piano', label: 'Piano', hint: 'Decaying harmonic stack. Unambiguous octave, gets out of the way quickly.' },
  { value: 'organ', label: 'Organ', hint: 'Sustained drawbar tone. Easiest to tune against.' },
  { value: 'pluck', label: 'Pluck', hint: 'Short and percussive. Good when you need the cue to end fast.' },
  { value: 'reed', label: 'Reed', hint: 'Odd harmonics, hollow. Carries well against loud sources.' },
  { value: 'triangle', label: 'Triangle', hint: 'Soft, few harmonics. A gentler sine.' },
  { value: 'sine', label: 'Sine', hint: 'Pure tone. Octave is ambiguous at the extremes.' },
];

/** Relative partial levels, indexed from the fundamental. */
const PARTIALS: Record<RefPreset, number[]> = {
  sine: [1],
  triangle: [1, 0, 0.11, 0, 0.04, 0, 0.02],
  // Drawbar-ish: fundamental, octave, fifth, double octave.
  organ: [1, 0.55, 0.35, 0.28, 0.12, 0.09, 0.05],
  piano: [1, 0.42, 0.26, 0.14, 0.09, 0.05, 0.03, 0.02],
  pluck: [1, 0.6, 0.38, 0.24, 0.15, 0.1, 0.06],
  // Odd harmonics only — the clarinet-like hollow that cuts through noise.
  reed: [1, 0, 0.4, 0, 0.22, 0, 0.13, 0, 0.08],
};

interface Shape {
  attack: number;
  /** Seconds for the whole cue. */
  duration: number;
  /** Exponential decay time constant; 0 means sustain then release. */
  decay: number;
  sustain: boolean;
}

const SHAPES: Record<RefPreset, Shape> = {
  sine: { attack: 0.02, duration: 0.9, decay: 0, sustain: true },
  triangle: { attack: 0.02, duration: 0.9, decay: 0, sustain: true },
  organ: { attack: 0.015, duration: 0.9, decay: 0, sustain: true },
  piano: { attack: 0.004, duration: 1.1, decay: 0.42, sustain: false },
  pluck: { attack: 0.002, duration: 0.55, decay: 0.16, sustain: false },
  reed: { attack: 0.03, duration: 0.9, decay: 0, sustain: true },
};

/**
 * Play a reference note. Returns how long it will sound, in seconds, so the
 * caller can hold off arming its onset detector until the cue has finished —
 * otherwise the session records its own reference.
 */
export function playRefTone(
  ctx: AudioContext,
  preset: RefPreset,
  midi: number,
  level = 0.18,
): number {
  const hz = midiToHz(midi);
  const partials = PARTIALS[preset] ?? PARTIALS.sine;
  const shape = SHAPES[preset] ?? SHAPES.sine;
  const t = ctx.currentTime;

  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);

  // Roll off the top a little at high pitches so the cue never sounds harsh.
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = Math.min(16000, Math.max(2000, hz * 12));
  tone.Q.value = 0.7;
  tone.connect(out);

  const nodes: OscillatorNode[] = [];
  let total = 0;
  for (const p of partials) if (p > 0) total += p;
  const norm = total > 0 ? 1 / total : 1;

  partials.forEach((amp, i) => {
    if (amp <= 0) return;
    const freq = hz * (i + 1);
    // Above Nyquist a partial would alias into an audible wrong pitch.
    if (freq >= ctx.sampleRate / 2) return;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const g = ctx.createGain();
    const peak = amp * norm * level;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + shape.attack);

    if (shape.sustain) {
      g.gain.setValueAtTime(peak, t + shape.duration - 0.12);
      g.gain.linearRampToValueAtTime(0, t + shape.duration);
    } else {
      // Higher partials decay faster, which is what makes a struck sound read
      // as struck rather than as a filtered organ.
      const decay = shape.decay / (1 + i * 0.35);
      g.gain.setTargetAtTime(0, t + shape.attack, decay);
      g.gain.setValueAtTime(0, t + shape.duration);
    }

    osc.connect(g);
    g.connect(tone);
    osc.start(t);
    osc.stop(t + shape.duration + 0.05);
    nodes.push(osc);
  });

  const last = nodes[nodes.length - 1];
  if (last) {
    last.onended = () => {
      try {
        tone.disconnect();
        out.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }

  return shape.duration;
}

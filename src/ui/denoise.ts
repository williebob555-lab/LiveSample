// ============================================================================
// Denoise dialog: strength and threshold for spectral-gating noise reduction.
// ============================================================================

import { app, modal, toast } from './app';
import { el } from './dom';
import { audio } from '../audio/output';
import { denoiseSamples } from '../core/pipeline';
import { DEFAULT_DENOISE } from '../dsp/denoise';
import type { Sample } from '../core/types';

export function openDenoise(samples: Sample[]): void {
  if (!samples.length) return toast('Nothing to denoise', 'err');

  let strengthDb = DEFAULT_DENOISE.strengthDb;
  let threshold = DEFAULT_DENOISE.threshold;

  const slider = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, set: (v: number) => void) => {
    const readout = el('span', { class: 'status', style: 'width:64px;text-align:right', text: fmt(value) });
    const input = el('input', { type: 'range', min, max, step, value: String(value), style: 'flex:1' });
    input.addEventListener('input', () => {
      set(Number(input.value));
      readout.textContent = fmt(Number(input.value));
    });
    return el('div', { style: 'display:flex;gap:10px;align-items:center;margin:8px 0' }, [
      el('span', { text: label, style: 'width:90px' }),
      input,
      readout,
    ]);
  };

  const body = el('div', { style: 'min-width:420px' }, [
    el('div', {
      class: 'notice',
      text:
        'Learns the noise from the quietest part of each take (the room before the note or after it ' +
        'has died) and turns down everything that does not rise clearly above it. Length and timing ' +
        'are unchanged. It processes the take in place — to start over from the untouched original, ' +
        'use Clean up, which always re-reads the original.',
    }),
    slider('Reduction', 3, 36, 1, strengthDb, (v) => `${v} dB`, (v) => (strengthDb = v)),
    slider('Threshold', 1, 3, 0.1, threshold, (v) => `${v.toFixed(1)}×`, (v) => (threshold = v)),
    el('div', { class: 'status', text: 'Raise the threshold if hiss remains; lower it or reduce strength if the tail sounds watery.' }),
  ]);

  modal({
    title: `Denoise ${samples.length} take${samples.length === 1 ? '' : 's'}`,
    body,
    confirmLabel: 'Denoise',
    onConfirm: () => {
      denoiseSamples(samples, { strengthDb, threshold });
      for (const s of samples) audio.invalidate(s.id);
      app.touch();
      toast(`Denoised ${samples.length} take${samples.length === 1 ? '' : 's'}`);
    },
  });
}

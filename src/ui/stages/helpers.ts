// ============================================================================
// Stage helpers — small builders shared by the stage modules.
// ============================================================================

import { app } from '../app';
import { el } from '../dom';
import { Knob } from '../primitives';

export function textField(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = el('input', { type: 'text', value });
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

export function knobRow(...knobs: Knob[]): HTMLElement {
  return el('div', { class: 'knob-row' }, knobs.map((k) => k.root));
}

export function envKnob(
  label: string,
  value: number,
  min: number,
  max: number,
  set: (v: number) => void,
  commit: () => void,
): Knob {
  return new Knob({
    label,
    min,
    max,
    value: Math.max(value, min),
    curve: 'log',
    format: (v) => (v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`),
    onChange: (v) => {
      set(v);
      commit();
    },
  });
}

export function targetSamples() {
  const inst = app.instrument;
  return app.selectedSamples.length
    ? inst.samples.filter((s) => app.selectedSamples.includes(s.id))
    : inst.samples;
}

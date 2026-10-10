// ============================================================================
// Mic mixer.
//
// A small dialog listing the instrument's mic positions with a level fader and
// a mute each. Levels and mutes live on the model (MicBus), so the audition
// engines and the exporters all read the same numbers.
// ============================================================================

import { app, modal } from './app';
import { el, formatDb } from './dom';

export function openMixer(): void {
  const inst = app.instrument;
  const body = el('div', { style: 'min-width:420px' });

  body.append(
    el('div', {
      class: 'notice',
      text:
        'Zones for different mics of the same note play together, mixed by these levels. ' +
        'SFZ and DecentSampler exports get one group per mic carrying its level; muted mics are not exported.',
    }),
  );

  for (const mic of inst.mics) {
    const readout = el('span', { class: 'status', style: 'width:64px;text-align:right', text: `${formatDb(mic.gainDb)} dB` });
    const fader = el('input', {
      type: 'range',
      min: -24,
      max: 12,
      step: 0.5,
      value: String(mic.gainDb),
      style: 'flex:1',
      title: 'Level in dB (double-click to reset)',
    });
    fader.addEventListener('input', () => {
      mic.gainDb = Number(fader.value);
      readout.textContent = `${formatDb(mic.gainDb)} dB`;
      app.touch();
    });
    fader.addEventListener('dblclick', () => {
      mic.gainDb = 0;
      fader.value = '0';
      readout.textContent = `${formatDb(0)} dB`;
      app.touch();
    });

    const mute = el('button', { class: `sm ${mic.muted ? 'danger' : 'ghost'}`, text: mic.muted ? 'Muted' : 'Mute' });
    mute.addEventListener('click', () => {
      mic.muted = !mic.muted;
      mute.className = `sm ${mic.muted ? 'danger' : 'ghost'}`;
      mute.textContent = mic.muted ? 'Muted' : 'Mute';
      app.touch();
    });

    const used = inst.groups.reduce((n, g) => n + g.zones.filter((z) => z.micId === mic.id).length, 0);
    body.append(
      el('div', { style: 'display:flex;gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--s3)' }, [
        el('span', { text: mic.name, style: 'width:110px' }),
        el('span', { class: 'status', text: `${used} zone${used === 1 ? '' : 's'}`, style: 'width:64px' }),
        fader,
        readout,
        mute,
      ]),
    );
  }

  modal({ title: 'Mic mixer', body, cancelLabel: 'Done' });
}

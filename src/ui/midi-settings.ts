// ============================================================================
// MIDI settings: which inputs feed the audition keyboard, on which channel,
// and what ports exist for driving a capture session. Shows a live activity
// light so "is my keyboard even talking to the app?" is answerable at a glance.
// ============================================================================

import { modal } from './app';
import { el, clear } from './dom';
import { field, selectBox } from './primitives';
import { midi, type MidiPort } from '../audio/midi';

const portLabel = (p: MidiPort): string => (p.connected ? p.name : `${p.name} (disconnected)`);

export function openMidiSettings(): void {
  const section = el('div', { class: 'section' });
  const body = el('div', {}, [section]);
  const dot = el('span', {
    style: 'display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--s3);margin-right:8px',
  });
  const activityText = document.createTextNode('Waiting for MIDI input');
  const activity = el('div', { class: 'status' }, [dot, activityText]);

  const render = (): void => {
    clear(section);
    section.append(el('h3', { text: 'MIDI' }));

    if (!midi.ready) {
      section.append(
        el('div', { class: 'notice warn' }, [
          el('strong', { text: 'MIDI is unavailable. ' }),
          midi.error ?? 'Requesting access…',
          midi.available
            ? ''
            : ' Use the desktop app, or a browser with Web MIDI (Chrome, Edge) and allow MIDI when asked.',
        ]),
        el('button', {
          class: 'sm',
          text: 'Try again',
          onclick: () => void midi.init().then(render),
        }),
      );
      return;
    }

    const inputOptions = [
      { value: 'all', label: 'All inputs' },
      ...midi.inputs.map((p) => ({ value: p.id, label: portLabel(p) })),
    ];
    // A remembered device that is not plugged in must still show as selected.
    if (!inputOptions.some((o) => o.value === midi.selectedInput))
      inputOptions.push({ value: midi.selectedInput, label: 'Saved input (not found)' });

    const list = (kind: string, ports: MidiPort[]): HTMLElement =>
      el('div', {
        class: 'status',
        text: `${ports.length} ${kind}${ports.length === 1 ? '' : 's'}: ${
          ports.map(portLabel).join(', ') || 'none found'
        }`,
      });

    section.append(
      field('Input', selectBox(inputOptions, midi.selectedInput, (v) => midi.setInput(v))),
      field(
        'Channel',
        selectBox(
          [
            { value: '0', label: 'Omni (all channels)' },
            ...Array.from({ length: 16 }, (_, i) => ({ value: String(i + 1), label: `Channel ${i + 1}` })),
          ],
          String(midi.channel),
          (v) => midi.setChannel(Number(v)),
        ),
      ),
      field('Activity', activity),
      list('input', midi.inputs),
      list('output', midi.outputs),
      el('div', {
        class: 'notice',
        text: 'Notes and the sustain pedal play the instrument. Outputs are used by capture sessions set to play each note over MIDI.',
      }),
    );
  };

  // The activity light polls a timestamp rather than re-rendering the form on
  // every message, which would steal focus from the dropdowns.
  let raf = 0;
  const tick = (): void => {
    const live = midi.lastActivity > 0 && performance.now() - midi.lastActivity < 250;
    dot.style.background = live ? 'var(--accent)' : 'var(--s3)';
    if (midi.lastActivity > 0) activityText.textContent = live ? 'Receiving' : 'Idle';
    raf = requestAnimationFrame(tick);
  };

  const unsubscribe = midi.onChange(render);
  void midi.init().then(render);
  render();
  raf = requestAnimationFrame(tick);

  modal({
    title: 'MIDI',
    body,
    cancelLabel: 'Close',
    onClose: () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    },
  });
}

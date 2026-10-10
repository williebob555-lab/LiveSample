// ============================================================================
// Articulation editor.
//
// A dialog rather than an inspector tab: articulations are an instrument-level
// concern (they own groups and decide what the keyboard does), not something
// belonging to the selected zone, and the edits are structural enough that
// seeing the whole list at once is the point.
// ============================================================================

import { app, modal, toast } from './app';
import { el, clear } from './dom';
import { noteField } from './notes';
import { numberField, selectBox } from './primitives';
import { audio } from '../audio/output';
import { activeArticulation } from '../audio/select';
import type { Articulation, ArticSelect } from '../core/types';
import {
  addArticulation,
  articulationIssues,
  defaultSelect,
  deleteArticulation,
  groupsOf,
  moveArticulation,
  moveGroupTo,
} from '../core/articulations';

const MODE_LABELS: { value: ArticSelect['mode']; label: string }[] = [
  { value: 'always', label: 'Always on' },
  { value: 'keyswitch', label: 'Keyswitch' },
  { value: 'cc', label: 'CC range' },
  { value: 'velocity', label: 'Velocity range' },
];

export function openArticulations(): void {
  const body = el('div', { style: 'min-width:560px' });

  const refresh = () => {
    clear(body);
    body.append(build());
  };
  // Every edit goes through here so the audition engines and other panels see it.
  const changed = () => {
    app.touch();
    refresh();
  };

  function build(): HTMLElement {
    const inst = app.instrument;
    const current = activeArticulation(inst, audio.auditionArticulation)?.id;
    const root = el('div');

    root.append(
      el('div', {
        class: 'notice',
        text:
          'Each articulation owns groups. A keyswitch key picks it when played; "Always on" sounds ' +
          'under every articulation. Audition chooses which one the keyboard plays right now.',
      }),
    );

    inst.articulations.forEach((a, i) => {
      const isActive = a.id === current;
      const groups = groupsOf(inst, a.id);

      const name = el('input', { type: 'text', value: a.name, style: 'width:140px' });
      name.addEventListener('change', () => {
        a.name = name.value.trim() || a.name;
        changed();
      });

      const modeSel = selectBox(MODE_LABELS, a.select.mode, (mode) => {
        a.select = defaultSelect(inst, mode);
        changed();
      });

      const row = el('div', {
        class: 'field',
        style: `align-items:center;gap:6px;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--s3);${isActive ? 'background:var(--s2)' : ''}`,
      }, [
        el('button', {
          class: `sm ${isActive ? 'primary' : 'ghost'}`,
          text: isActive ? 'Auditioning' : 'Audition',
          title: 'Play this articulation from the keyboard',
          onclick: () => {
            audio.setArticulation(a.id);
            refresh();
          },
        }),
        name,
        modeSel,
        selectControls(a, changed),
        el('button', { class: 'sm ghost', text: '↑', title: 'Move up', onclick: () => moveArticulation(inst, a.id, -1) && changed() }),
        el('button', { class: 'sm ghost', text: '↓', title: 'Move down', onclick: () => moveArticulation(inst, a.id, 1) && changed() }),
        el('button', {
          class: 'sm danger',
          text: 'Delete',
          disabled: inst.articulations.length <= 1 ? 'true' : undefined,
          title: inst.articulations.length <= 1 ? 'An instrument needs at least one articulation' : 'Delete',
          onclick: () => askDelete(a, changed),
        }),
      ]);
      void i;
      root.append(row);

      // Groups under this articulation, each movable to another one.
      const list = el('div', { style: 'padding:0 0 6px 12px;font-size:12px' });
      if (!groups.length) list.append(el('span', { class: 'status', text: 'No groups' }));
      for (const g of groups) {
        list.append(
          el('div', { style: 'display:flex;gap:8px;align-items:center;margin:2px 0' }, [
            el('span', { text: `${g.name} (${g.zones.length} zone${g.zones.length === 1 ? '' : 's'})`, style: 'flex:1' }),
            el('span', { class: 'status', text: 'move to' }),
            selectBox(
              inst.articulations.map((x) => ({ value: x.id, label: x.name })),
              a.id,
              (to) => {
                moveGroupTo(inst, g.id, to);
                changed();
              },
            ),
          ]),
        );
      }
      root.append(list);
    });

    root.append(
      el('div', { style: 'margin-top:8px;display:flex;gap:8px' }, [
        el('button', {
          class: 'sm',
          text: 'Add articulation',
          onclick: () => {
            addArticulation(inst, `Articulation ${inst.articulations.length + 1}`);
            changed();
          },
        }),
      ]),
    );

    const issues = articulationIssues(inst);
    for (const msg of issues) root.append(el('div', { class: 'notice', text: msg }));
    return root;
  }

  refresh();
  modal({ title: 'Articulations', body, cancelLabel: 'Done', wide: true });
}

/** The mode-specific controls: a note, a CC and range, or a velocity range. */
function selectControls(a: Articulation, changed: () => void): HTMLElement {
  const s = a.select;
  const wrap = el('span', { style: 'display:inline-flex;gap:4px;align-items:center' });
  const num = (v: number, set: (n: number) => void, min: number, max: number) =>
    numberField(v, (n) => {
      set(Math.max(min, Math.min(max, Math.round(n))));
      changed();
    }, { min, max, width: 56 });

  if (s.mode === 'keyswitch') {
    wrap.append(
      noteField(s.key, (key) => {
        a.select = { mode: 'keyswitch', key };
        changed();
      }),
    );
  } else if (s.mode === 'cc') {
    wrap.append(
      'CC',
      num(s.cc, (cc) => (a.select = { ...s, cc }), 0, 127),
      num(s.low, (low) => (a.select = { ...s, low }), 0, 127),
      '–',
      num(s.high, (high) => (a.select = { ...s, high }), 0, 127),
    );
  } else if (s.mode === 'velocity') {
    wrap.append(
      num(s.low, (low) => (a.select = { ...s, low }), 1, 127),
      '–',
      num(s.high, (high) => (a.select = { ...s, high }), 1, 127),
    );
  }
  return wrap;
}

/** Deleting an articulation with groups must say where they go. */
function askDelete(a: Articulation, done: () => void): void {
  const inst = app.instrument;
  const groups = groupsOf(inst, a.id);
  const others = inst.articulations.filter((x) => x.id !== a.id);

  const finish = (moveTo: string | null) => {
    const r = deleteArticulation(inst, a.id, moveTo);
    if (!r.ok) return toast('Could not delete that articulation', 'err');
    // Drop an audition choice that no longer exists.
    if (audio.auditionArticulation === a.id) audio.setArticulation(null);
    app.selectedZones = app.selectedZones.filter((id) => app.zoneById(id));
    done();
    toast(`Deleted "${a.name}"`);
  };

  if (!groups.length) return finish(null);

  let target = others[0].id;
  let mode: 'move' | 'delete' = 'move';
  const body = el('div', {}, [
    el('p', {
      text: `"${a.name}" has ${groups.length} group${groups.length === 1 ? '' : 's'} ` +
        `(${groups.reduce((n, g) => n + g.zones.length, 0)} zones). What should happen to them?`,
    }),
  ]);
  const radio = (value: 'move' | 'delete', label: string, extra?: Node) => {
    const input = el('input', { type: 'radio', name: 'art-del', checked: value === mode });
    input.addEventListener('change', () => (mode = value));
    return el('label', { class: 'check', style: 'display:flex;gap:6px;margin:6px 0;align-items:center' }, [input, label, extra]);
  };
  body.append(
    radio('move', 'Move them to', selectBox(others.map((x) => ({ value: x.id, label: x.name })), target, (v) => (target = v))),
    radio('delete', 'Delete the groups and their zones (the takes stay in the pool)'),
  );

  modal({
    title: 'Delete articulation',
    body,
    confirmLabel: 'Delete',
    onConfirm: () => finish(mode === 'move' ? target : null),
  });
}

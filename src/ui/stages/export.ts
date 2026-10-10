// ============================================================================
// Export stage — target picker, the instrument inspector, and the export run.
// ============================================================================

import { app, section, toast, progressModal } from '../app';
import { el, clear, formatDb, clamp } from '../dom';
import { Knob, field, checkbox, numberField } from '../primitives';
import { sampleStore } from '../../audio/store';
import { midiName } from '../../dsp/pitch';
import { findGaps, maxStretch } from '../../core/automap';
import { native, hasNative, baseName, downloadInBrowser } from '../../core/native';
import { TARGETS, exportWarnings, buildBundle, type AudioSource } from '../../export';
import { textField, knobRow } from './helpers';

export function buildExportPanel(): HTMLElement {
  const inst = app.instrument;
  const chosen = new Set(['sfz', 'wav']);
  const warnHost = el('div');

  const refreshWarnings = () => {
    clear(warnHost);
    for (const id of chosen) {
      const target = TARGETS.find((t) => t.id === id);
      if (!target) continue;
      const warnings = exportWarnings(target, inst);
      if (!warnings.length) continue;
      warnHost.append(
        el('div', { class: 'notice warn' }, [
          el('strong', { text: `${target.name}: ` }),
          warnings.join(' '),
        ]),
      );
    }
    const gaps = findGaps(inst).filter((g) => g.high - g.low > 2);
    if (gaps.length)
      warnHost.append(
        el('div', { class: 'notice warn' }, [
          el('strong', { text: 'Unmapped keys: ' }),
          gaps.map((g) => `${midiName(g.low)}–${midiName(g.high)}`).join(', '),
        ]),
      );
    const stretch = maxStretch(inst);
    if (stretch > 6)
      warnHost.append(
        el('div', { class: 'notice warn' }, [
          el('strong', { text: 'Wide stretch: ' }),
          `Some zones stretch their sample by ${stretch} semitones. Consider filling gaps by repitch first.`,
        ]),
      );
  };

  const targetRows = TARGETS.map((t) =>
    el('div', { class: 'section', style: 'padding:10px 12px' }, [
      checkbox(t.name, chosen.has(t.id), (on) => {
        if (on) chosen.add(t.id);
        else chosen.delete(t.id);
        refreshWarnings();
      }),
      el('div', { class: 'status', style: 'margin-top:4px;line-height:1.6', text: t.description }),
    ]),
  );

  const body = el('div', { class: 'panel-body pad' }, [
    el('div', { class: 'notice' }, [
      el('strong', { text: 'What gets written. ' }),
      'Samples are written once and shared by every format, with root note, tuning and loop points baked into each file.',
    ]),
    ...targetRows,
    warnHost,
    el('div', { style: 'display:flex;gap:8px;margin-top:16px' }, [
      el('button', {
        class: 'primary',
        text: 'Export…',
        onclick: () => runExport([...chosen]),
      }),
    ]),
  ]);
  refreshWarnings();

  return el('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' }, [
    el('div', { class: 'panel-head' }, [el('span', { class: 'panel-title', text: 'Export' })]),
    body,
  ]);
}

export function buildInstrumentInspector(): HTMLElement {
  const inst = app.instrument;
  const m = inst.master;
  const commit = () => app.touch();
  return el('div', {}, [
    section(
      'Instrument',
      field('Author', textField(inst.author, (v) => {
        inst.author = v;
        commit();
      })),
      el('textarea', {
        rows: 4,
        placeholder: 'Description',
        oninput: (e: Event) => {
          inst.description = (e.target as HTMLTextAreaElement).value;
          app.noteEdit();
        },
      }),
    ),
    section(
      'Master',
      knobRow(
        new Knob({
          label: 'Gain',
          min: -24,
          max: 12,
          value: m.gainDb,
          default: 0,
          format: (v) => formatDb(v),
          onChange: (v) => {
            m.gainDb = v;
            commit();
          },
        }),
        new Knob({
          label: 'Tune',
          min: -100,
          max: 100,
          value: m.tuneCents,
          default: 0,
          format: (v) => `${v.toFixed(0)}¢`,
          onChange: (v) => {
            m.tuneCents = v;
            commit();
          },
        }),
        new Knob({
          label: 'Vel curve',
          min: 0.3,
          max: 3,
          value: m.velocityCurve,
          default: 1,
          format: (v) => v.toFixed(2),
          onChange: (v) => {
            m.velocityCurve = v;
            commit();
          },
        }),
      ),
      field(
        'Bend range',
        numberField(m.bendRangeSemis, (v) => {
          m.bendRangeSemis = clamp(Math.round(v), 0, 24);
          commit();
        }, { min: 0, max: 24, width: 70 }),
        el('span', { class: 'status', text: 'semitones' }),
      ),
      field(
        'Polyphony',
        numberField(m.polyphony, (v) => {
          m.polyphony = Math.max(0, Math.round(v));
          commit();
        }, { min: 0, max: 256, width: 70 }),
        el('span', { class: 'status', text: '0 = unlimited' }),
      ),
    ),
  ]);
}

async function runExport(targets: string[]): Promise<void> {
  if (!targets.length) return toast('Pick at least one format', 'err');
  const inst = app.instrument;
  if (!inst.samples.length) return toast('Nothing to export', 'err');

  const source: AudioSource = {
    async get(sampleId) {
      const a = sampleStore.get(sampleId);
      return a ? { channels: a.channels, sampleRate: a.sampleRate } : null;
    },
  };

  if (!hasNative || !native) {
    const files = await buildBundle(inst, source, { targets });
    for (const f of files)
      if (!f.path.startsWith('samples/')) downloadInBrowser(baseName(f.path), f.data);
    toast('Presets downloaded — samples need the desktop app');
    return;
  }

  const dir = await native.chooseDir('Choose export folder');
  if (!dir) return;

  const prog = progressModal('Exporting');
  const files = await buildBundle(inst, source, {
    targets,
    onProgress: (d, t, label) => prog.update(d, t, label),
  });
  for (const f of files) await native.write(await native.join(dir, ...f.path.split('/')), f.data);
  prog.close();
  toast(`Exported ${files.length} files`);
}

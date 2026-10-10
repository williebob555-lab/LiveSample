// ============================================================================
// Map stage — the zone grid, the zone inspector, and mapping actions.
// ============================================================================

import { app, section, toast, modal, progressModal } from '../app';
import { el, formatDb, clamp } from '../dom';
import { Knob, field, checkbox, selectBox, numberField } from '../primitives';
import { NoteRange, noteField } from '../notes';
import { openArticulations } from '../articulations';
import { openMixer } from '../mixer';
import { STRETCH_GUIDANCE } from '../../dsp/resample';
import { autoMap } from '../../core/automap';
import { fillGapsByRepitch } from '../../core/pipeline';
import { type StageContext } from './context';
import { knobRow } from './helpers';

/** Map: the zone grid, a coverage band, and the selected sample. */
export function mapBody(ctx: StageContext): HTMLElement {
  const inst = app.instrument;
  const zones = inst.groups.reduce((acc, g) => acc + g.zones.length, 0);

  const host = el('div', { class: 'stage-body' });

  if (!zones) {
    // A blank grid tells you nothing. Say what is missing and offer the fix.
    host.append(
      el('div', { class: 'empty-cta' }, [
        el('h2', { text: inst.samples.length ? 'Nothing is mapped yet' : 'No takes to map' }),
        el('p', {
          text: inst.samples.length
            ? `${inst.samples.length} take${inst.samples.length === 1 ? '' : 's'} are waiting. Auto-map places each one at its detected pitch and splits the key ranges at the midpoints between them.`
            : 'Record a capture session or import audio on the Takes stage first.',
        }),
        inst.samples.length
          ? el('button', { class: 'primary', text: 'Auto-map takes', onclick: () => runAutoMap() })
          : el('button', { class: 'primary', text: 'Go to Takes', onclick: () => ctx.setStage('takes') }),
      ]),
    );
    return host;
  }

  ctx.coverage.setInstrument(inst);
  ctx.coverage.setRange(ctx.keyboard.getRange());

  host.append(
    ctx.zoneMap.root,
    el('div', { class: 'coverage-wrap' }, [
      el('div', { class: 'coverage-label', text: 'Coverage' }),
      ctx.coverage.root,
    ]),
    el('div', { class: 'waveform-panel' }, [
      el('div', { class: 'panel-head' }, [el('span', { class: 'panel-title', text: 'Sample' })]),
      ctx.waveform.root,
    ]),
  );
  return host;
}

/** Toolbar buttons for the Map stage's centre panel. */
export function mapActions(): Node[] {
  return [
    el('button', { class: 'sm ghost', text: 'Auto-map', onclick: () => runAutoMap() }),
    el('button', { class: 'sm ghost', text: 'Fill gaps', onclick: () => runFillGaps() }),
    el('button', { class: 'sm ghost', text: 'Articulations', onclick: () => openArticulations() }),
    el('button', { class: 'sm ghost', text: 'Mics', onclick: () => openMixer() }),
  ];
}

export function buildZoneInspector(ctx: StageContext): HTMLElement {
  const host = el('div');
  const sel = app.selectedZones[0] ? app.zoneById(app.selectedZones[0]) : null;
  if (!sel) {
    host.append(
      el('div', { class: 'empty' }, [
        'Select a zone to edit it.',
        el('br'),
        el('br'),
        'Drag zone edges to resize, bodies to move. Click empty space to audition.',
      ]),
    );
    return host;
  }
  const { zone } = sel;
  const sample = app.sampleById(zone.sampleId);

  const commit = () => app.touch();

  host.append(
    section(
      'Sample',
      field('Take', el('span', { class: 'row-name', text: sample?.name ?? 'missing' })),
    ),
    section(
      'Placement',
      field(
        'Key range',
        new NoteRange({
          low: zone.keyLow,
          high: zone.keyHigh,
          min: 0,
          max: 127,
          onInput: (low, high) => {
            zone.keyLow = low;
            zone.keyHigh = high;
            ctx.zoneMap.setInstrument(app.instrument);
          },
          onChange: (low, high) => {
            zone.keyLow = low;
            zone.keyHigh = high;
            commit();
          },
        }).root,
      ),
      field(
        'Root',
        noteField(zone.rootKey, (v) => {
          zone.rootKey = v;
          commit();
        }),
        el('span', { class: 'status', text: 'unstretched at this note' }),
      ),
      field(
        'Velocity',
        numberField(zone.velLow, (v) => {
          zone.velLow = clamp(Math.round(v), 1, zone.velHigh);
          commit();
        }, { min: 1, max: 127, width: 62 }),
        numberField(zone.velHigh, (v) => {
          zone.velHigh = clamp(Math.round(v), zone.velLow, 127);
          commit();
        }, { min: 1, max: 127, width: 62 }),
      ),
      field(
        'Round robin',
        numberField(zone.rrIndex, (v) => {
          zone.rrIndex = Math.max(1, Math.round(v));
          commit();
        }, { min: 1, max: 32, width: 62 }),
      ),
    ),
    section(
      'Tuning and level',
      knobRow(
        new Knob({
          label: 'Tune',
          min: -100,
          max: 100,
          value: zone.tuneCents,
          default: 0,
          format: (v) => `${v.toFixed(0)}¢`,
          onChange: (v) => {
            zone.tuneCents = v;
            commit();
          },
        }),
        new Knob({
          label: 'Gain',
          min: -24,
          max: 12,
          value: zone.gainDb,
          default: 0,
          format: (v) => `${formatDb(v)}`,
          onChange: (v) => {
            zone.gainDb = v;
            commit();
          },
        }),
        new Knob({
          label: 'Pan',
          min: -1,
          max: 1,
          value: zone.pan,
          default: 0,
          format: (v) => (Math.abs(v) < 0.01 ? 'C' : `${v > 0 ? 'R' : 'L'}${Math.abs(v * 100).toFixed(0)}`),
          onChange: (v) => {
            zone.pan = v;
            commit();
          },
        }),
      ),
    ),
    section(
      'Loop',
      field(
        'Mode',
        selectBox(
          [
            { value: 'off', label: 'Off' },
            { value: 'forward', label: 'Forward' },
            { value: 'pingpong', label: 'Ping-pong' },
            { value: 'sustain', label: 'Sustain only' },
          ],
          zone.loop.mode,
          (v) => {
            zone.loop.mode = v;
            if (v !== 'off' && zone.loop.end <= zone.loop.start) {
              zone.loop.start = Math.floor((zone.endFrame - zone.startFrame) * 0.4 + zone.startFrame);
              zone.loop.end = Math.floor((zone.endFrame - zone.startFrame) * 0.8 + zone.startFrame);
            }
            commit();
          },
        ),
      ),
      field(
        'Crossfade',
        numberField(zone.loop.crossfade, (v) => {
          zone.loop.crossfade = Math.max(0, Math.round(v));
          commit();
        }, { min: 0, width: 90 }),
        el('span', { class: 'status', text: 'frames' }),
      ),
    ),
  );
  return host;
}

function runAutoMap(): void {
  const inst = app.instrument;
  const group = app.group();
  if (!group) return;
  if (!inst.samples.length) return toast('Import some takes first', 'err');

  let layers = Math.max(1, ...inst.samples.map((s) => s.capture.velLayer ?? 1));
  let fromLevel = layers === 1;
  let tune = true;

  const body = el('div', {}, [
    el('div', { class: 'notice' }, [
      'Key ranges meet at the midpoint between neighbouring roots, so every sample stretches as little as possible.',
    ]),
    field(
      'Velocity layers',
      numberField(layers, (v) => (layers = Math.max(1, Math.round(v))), { min: 1, max: 16, width: 70 }),
    ),
    checkbox('Infer layers from loudness', fromLevel, (v) => (fromLevel = v)),
    el('br'),
    checkbox('Tune each zone to exact pitch', tune, (v) => (tune = v)),
  ]);

  modal({
    title: 'Auto-map',
    body,
    confirmLabel: 'Map',
    onConfirm: () => {
      const zones = autoMap(inst.samples, group, {
        velocityLayers: layers,
        velocityFromLevel: fromLevel,
        tuneToExactPitch: tune,
      });
      app.selectedZones = [];
      app.stage = 'map';
      app.touch();
      toast(`Mapped ${zones.length} zones`);
    },
  });
}

function runFillGaps(): void {
  const inst = app.instrument;
  const group = app.group();
  if (!group?.zones.length) return toast('Map some zones first', 'err');

  let step = 1;
  let formant = true;
  let maxDistance = 3;

  const guidance = el(
    'select',
    {},
    STRETCH_GUIDANCE.map((g) =>
      el('option', { value: String(g.maxSemitones), text: `${g.label} — up to ${g.maxSemitones} st` }),
    ),
  );
  guidance.addEventListener('change', () => {
    maxDistance = Number(guidance.value);
  });

  const body = el('div', {}, [
    el('div', { class: 'notice' }, [
      'Renders new samples at the missing pitches so nothing has to stretch at playback time. ',
      el('strong', { text: 'Formant correction ' }),
      'keeps voices and winds sounding natural; turn it off for struck and plucked sounds.',
    ]),
    field('Material', guidance),
    field(
      'Spacing',
      numberField(step, (v) => (step = clamp(Math.round(v), 1, 12)), { min: 1, max: 12, width: 70 }),
      el('span', { class: 'status', text: 'semitones' }),
    ),
    checkbox('Preserve formants', formant, (v) => (formant = v)),
  ]);

  modal({
    title: 'Fill gaps by repitch',
    body,
    confirmLabel: 'Generate',
    onConfirm: () => {
      const prog = progressModal('Rendering');
      prog.update(0, 1, 'analysing map');
      const result = fillGapsByRepitch(inst, group, {
        step,
        formantCorrect: formant,
        maxDistance,
      });
      for (const c of result.created) inst.samples.push(c.sample);
      if (result.created.length) autoMap(inst.samples, group, { velocityFromLevel: false });
      prog.close();
      app.touch();
      toast(
        result.created.length
          ? `Generated ${result.created.length} samples${result.skipped ? `, skipped ${result.skipped} too far from a recording` : ''}`
          : 'Nothing to fill',
      );
    },
  });
}

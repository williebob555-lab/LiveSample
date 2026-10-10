// ============================================================================
// Refine stage — envelope, filter and loops, and the group inspector.
// ============================================================================

import { app, section, toast } from '../app';
import { el, clamp } from '../dom';
import { Knob, Slider, field, selectBox, numberField } from '../primitives';
import { audio } from '../../audio/output';
import { midiName } from '../../dsp/pitch';
import { createGroup, type Group, type RoundRobinMode, type TriggerMode, type FilterType } from '../../core/types';
import { autoLoop } from '../../core/pipeline';
import { type StageContext } from './context';
import { textField, knobRow, envKnob } from './helpers';

/** Refine: envelope, filter, and the loop status of every zone. */
export function refineBody(ctx: StageContext): HTMLElement {
  const group = app.group();
  const host = el('div', { class: 'stage-body refine-body' });

  if (!group || !group.zones.length) {
    host.append(
      el('div', { class: 'empty-cta' }, [
        el('h2', { text: 'Nothing mapped to refine' }),
        el('p', {
          text: 'Envelopes, filters and loops apply to mapped zones. Map your takes first and they will show up here.',
        }),
        el('button', { class: 'primary', text: 'Go to Map', onclick: () => ctx.setStage('map') }),
      ]),
    );
    return host;
  }

  ctx.envelopeView.show(group.ampEnv);
  ctx.filterView.show(group.filter);

  host.append(
    el('div', { class: 'refine-panel grow' }, [
      el('div', { class: 'panel-head' }, [
        el('span', { class: 'panel-title', text: 'Envelope' }),
        el('div', { class: 'spacer' }),
        el('span', { class: 'status', text: group.name }),
      ]),
      ctx.envelopeView.root,
    ]),
    el('div', { class: 'refine-panel', style: 'height:150px' }, [
      el('div', { class: 'panel-head' }, [
        el('span', { class: 'panel-title', text: 'Filter' }),
        el('span', {
          class: 'panel-sub',
          text: group.filter.type === 'off' ? 'Off' : group.filter.type,
        }),
      ]),
      ctx.filterView.root,
    ]),
    buildLoopPanel(group),
  );
  return host;
}

/** Which zones loop, how well, and what to do about the ones that do not. */
function buildLoopPanel(group: Group): HTMLElement {
  const looped = group.zones.filter((z) => z.loop.mode !== 'off');
  const body = el('div', { class: 'panel-body loop-list' });

  const sorted = [...group.zones].sort((a, b) => a.rootKey - b.rootKey || a.velLow - b.velLow);
  for (const zone of sorted) {
    const sample = app.sampleById(zone.sampleId);
    const on = zone.loop.mode !== 'off';
    const lengthMs =
      on && sample?.sampleRate
        ? Math.round(((zone.loop.end - zone.loop.start) / sample.sampleRate) * 1000)
        : 0;

    body.append(
      el(
        'div',
        {
          class: `row ${app.selectedZones.includes(zone.id) ? 'selected' : ''}`,
          onclick: () => {
            app.selectedZones = [zone.id];
            app.selectedSamples = [zone.sampleId];
            app.touch(false);
          },
          ondblclick: () => {
            audio.noteOn(zone.rootKey, 100);
            setTimeout(() => audio.noteOff(zone.rootKey), 1400);
          },
        },
        [
          el('span', { class: 'row-name', text: midiName(zone.rootKey) }),
          el('span', {
            class: `badge ${on ? 'ok' : ''}`,
            text: on ? zone.loop.mode : 'no loop',
          }),
          el('span', { class: 'row-meta', text: on ? `${lengthMs} ms` : '—' }),
        ],
      ),
    );
  }

  return el('div', { class: 'refine-panel', style: 'height:190px' }, [
    el('div', { class: 'panel-head' }, [
      el('span', { class: 'panel-title', text: 'Loops' }),
      el('span', {
        class: 'panel-sub',
        text: `${looped.length}/${group.zones.length}`,
      }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'sm ghost', text: 'Find loops', onclick: () => runAutoLoop() }),
      el('button', {
        class: 'sm ghost',
        text: 'Clear',
        onclick: () => {
          for (const z of group.zones) z.loop.mode = 'off';
          app.touch();
        },
      }),
    ]),
    body,
  ]);
}

export function buildGroupInspector(): HTMLElement {
  const host = el('div');
  const inst = app.instrument;
  const group = app.group();
  if (!group) return host;

  const commit = () => app.touch();

  host.append(
    section(
      'Groups',
      el(
        'div',
        { class: 'list' },
        inst.groups.map((g) =>
          el(
            'div',
            {
              class: `row ${g.id === group.id ? 'selected' : ''}`,
              onclick: () => {
                app.activeGroupId = g.id;
                app.touch(false);
              },
            },
            [
              el('span', { class: 'row-name', text: g.name }),
              el('span', { class: 'row-meta', text: String(g.zones.length) }),
            ],
          ),
        ),
      ),
      el('button', {
        class: 'sm',
        text: 'Add group',
        style: 'margin-top:8px',
        onclick: () => {
          const g = createGroup(inst.articulations[0].id, `Group ${inst.groups.length + 1}`);
          inst.groups.push(g);
          app.activeGroupId = g.id;
          app.touch();
        },
      }),
    ),
    section(
      'Behaviour',
      field('Name', textField(group.name, (v) => {
        group.name = v;
        commit();
      })),
      field(
        'Trigger',
        selectBox<TriggerMode>(
          [
            { value: 'attack', label: 'Attack' },
            { value: 'release', label: 'Release' },
            { value: 'legato', label: 'Legato' },
          ],
          group.trigger,
          (v) => {
            group.trigger = v;
            commit();
          },
        ),
      ),
      field(
        'Round robin',
        selectBox<RoundRobinMode>(
          [
            { value: 'off', label: 'Off' },
            { value: 'sequential', label: 'Sequential' },
            { value: 'random', label: 'Random' },
            { value: 'randomNoRepeat', label: 'Random, no repeat' },
          ],
          group.roundRobin,
          (v) => {
            group.roundRobin = v;
            commit();
          },
        ),
      ),
      field(
        'Choke group',
        numberField(group.chokeGroup, (v) => {
          group.chokeGroup = Math.max(0, Math.round(v));
          commit();
        }, { min: 0, max: 32, width: 70 }),
        el('span', { class: 'status', text: '0 = none' }),
      ),
      field(
        'Vel crossfade',
        numberField(group.velCrossfade, (v) => {
          group.velCrossfade = clamp(Math.round(v), 0, 64);
          commit();
        }, { min: 0, max: 64, width: 70 }),
      ),
    ),
    section(
      'Amplitude envelope',
      knobRow(
        envKnob('Attack', group.ampEnv.attack, 0, 4, (v) => (group.ampEnv.attack = v), commit),
        envKnob('Decay', group.ampEnv.decay, 0.001, 8, (v) => (group.ampEnv.decay = v), commit),
        new Knob({
          label: 'Sustain',
          min: 0,
          max: 1,
          value: group.ampEnv.sustain,
          default: 1,
          format: (v) => v.toFixed(2),
          onChange: (v) => {
            group.ampEnv.sustain = v;
            commit();
          },
        }),
        envKnob('Release', group.ampEnv.release, 0.001, 8, (v) => (group.ampEnv.release = v), commit),
      ),
      field(
        'Vel → level',
        new Slider({
          min: 0,
          max: 1,
          value: group.velToGain,
          step: 0.01,
          format: (v) => `${Math.round(v * 100)}%`,
          onChange: (v) => {
            group.velToGain = v;
            commit();
          },
        }).root,
      ),
    ),
    section(
      'Filter',
      field(
        'Type',
        selectBox<FilterType>(
          [
            { value: 'off', label: 'Off' },
            { value: 'lowpass', label: 'Low pass' },
            { value: 'highpass', label: 'High pass' },
            { value: 'bandpass', label: 'Band pass' },
          ],
          group.filter.type,
          (v) => {
            group.filter.type = v;
            commit();
          },
        ),
      ),
      group.filter.type !== 'off'
        ? knobRow(
            new Knob({
              label: 'Cutoff',
              min: 20,
              max: 20000,
              value: group.filter.cutoff,
              curve: 'log',
              default: 12000,
              format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`),
              onChange: (v) => {
                group.filter.cutoff = v;
                commit();
              },
            }),
            new Knob({
              label: 'Res',
              min: 0.1,
              max: 18,
              value: group.filter.resonance,
              default: 0.7,
              format: (v) => v.toFixed(1),
              onChange: (v) => {
                group.filter.resonance = v;
                commit();
              },
            }),
            new Knob({
              label: 'Key trk',
              min: 0,
              max: 1,
              value: group.filter.keyTrack,
              default: 0,
              format: (v) => `${Math.round(v * 100)}%`,
              onChange: (v) => {
                group.filter.keyTrack = v;
                commit();
              },
            }),
            new Knob({
              label: 'Vel',
              min: 0,
              max: 1,
              value: group.filter.velAmount,
              default: 0,
              format: (v) => `${Math.round(v * 100)}%`,
              onChange: (v) => {
                group.filter.velAmount = v;
                commit();
              },
            }),
          )
        : null,
    ),
  );
  return host;
}

function runAutoLoop(): void {
  const group = app.group();
  if (!group?.zones.length) return toast('Map some zones first', 'err');
  const found = autoLoop(app.instrument, group, { bakeCrossfade: true });
  for (const z of group.zones) audio.invalidate(z.sampleId);
  app.touch();
  toast(
    found
      ? `Looped ${found} of ${group.zones.length} zones`
      : 'No confident loops found — try longer sustains',
  );
}

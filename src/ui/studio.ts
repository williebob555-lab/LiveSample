// ============================================================================
// Studio — the desk screen. Dense, precise, mouse-driven.
//
// Layout is fixed rather than dockable. A sampler builder has a small number of
// known screens, so they can be designed; the sibling node-editor project is
// dockable because its content is arbitrary, and that is exactly why it was
// hard to make look finished.
// ============================================================================

import { app, panel, section, toast, modal, progressModal } from './app';
import { el, clear, formatDb, clamp } from './dom';
import { Knob, Slider, Meter, field, checkbox, selectBox, numberField, segmented } from './primitives';
import { NoteRange, noteField } from './notes';
import { ZoneMap } from './zonemap';
import { Keyboard } from './keyboard';
import { WaveformView } from './waveform';
import { EnvelopeView, FilterView } from './curves';
import { CoverageStrip } from './coverage';
import { audio } from '../audio/output';
import { openAudioSettings } from './audio-settings';
import { sampleStore } from '../audio/store';
import { midiName } from '../dsp/pitch';
import { STRETCH_GUIDANCE } from '../dsp/resample';
import {
  createGroup,
  type Zone,
  type Group,
  type RoundRobinMode,
  type TriggerMode,
  type FilterType,
} from '../core/types';
import { autoMap, findGaps, maxStretch } from '../core/automap';
import {
  importAudio,
  analyzeAll,
  cleanupSamples,
  autoLoop,
  fillGapsByRepitch,
  splitLongTake,
} from '../core/pipeline';
import { native, hasNative, baseName, pickFilesInBrowser, downloadInBrowser } from '../core/native';
import { saveProject, loadProject, rememberProject } from '../core/project';
import { TARGETS, exportWarnings, buildBundle, type AudioSource } from '../export';

export class Studio {
  readonly root: HTMLElement;
  private leftBody: HTMLElement;
  private centerHost: HTMLElement;
  private rightBody: HTMLElement;
  private rightHead: HTMLElement;
  private zoneMap: ZoneMap;
  private keyboard: Keyboard;
  private waveform: WaveformView;
  private keyboardStrip: HTMLElement;
  private coverage = new CoverageStrip();
  private envelopeView: EnvelopeView;
  private filterView = new FilterView();
  private meter = new Meter(140, 8);
  private retakeBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private deviceEl: HTMLElement;

  constructor() {
    this.retakeBtn = el('button', {
      class: 'ghost sm',
      text: 'Re-record',
      title: 'Record these notes again, replacing the audio but keeping the map',
      onclick: () => this.retakeSelected(),
    });

    const left = panel('Takes', [
      this.retakeBtn,
      el('button', { class: 'ghost sm', text: 'Import', onclick: () => this.importFiles() }),
      el('button', { class: 'ghost sm', text: 'Folder', onclick: () => this.importFolder() }),
    ]);
    this.leftBody = left.body;
    left.root.classList.add('col-left');

    this.zoneMap = new ZoneMap({
      onSelect: (ids) => {
        app.selectedZones = ids;
        const first = ids[0] ? app.zoneById(ids[0]) : null;
        if (first) app.selectedSamples = [first.zone.sampleId];
        app.touch(false);
      },
      onChange: () => app.touch(),
      onAudition: (midi, vel) => {
        audio.noteOn(midi, vel);
        setTimeout(() => audio.noteOff(midi), 700);
      },
    });

    this.waveform = new WaveformView({
      onChange: (patch) => {
        const sel = app.selectedZones[0] ? app.zoneById(app.selectedZones[0]) : null;
        if (!sel) return;
        const z = sel.zone;
        if (patch.startFrame != null) z.startFrame = patch.startFrame;
        if (patch.endFrame != null) z.endFrame = patch.endFrame;
        if (patch.loopStart != null) z.loop.start = patch.loopStart;
        if (patch.loopEnd != null) z.loop.end = patch.loopEnd;
        app.touch();
      },
      onScrub: (frame) => {
        const id = app.selectedSamples[0];
        if (id) audio.previewSample(id, frame);
      },
    });

    this.envelopeView = new EnvelopeView(() => app.touch());

    this.keyboard = new Keyboard({
      onNoteOn: (m, v) => audio.noteOn(m, v),
      onNoteOff: (m) => audio.noteOff(m),
    });

    this.centerHost = el('div', {
      class: 'panel col-center',
      style: 'display:flex;flex-direction:column;min-height:0',
    });

    const right = panel('Inspector');
    this.rightBody = right.body;
    this.rightHead = right.head;
    right.root.classList.add('col-right');

    this.statusEl = el('div', { class: 'status' });

    this.deviceEl = el('div', { class: 'status' });

    const transport = el('div', { class: 'transport' }, [
      el('button', {
        class: 'sm',
        text: 'Audio',
        onclick: async () => {
          const ok = await audio.start();
          toast(ok ? 'Audio running' : (audio.lastError ?? 'Audio failed to start'), ok ? 'info' : 'err');
        },
      }),
      el('button', { class: 'sm ghost', text: 'Devices…', onclick: () => openAudioSettings() }),
      el('button', { class: 'sm ghost', text: 'Panic', onclick: () => audio.allNotesOff() }),
      this.meter.root,
      this.deviceEl,
      el('div', { class: 'spacer' }),
      this.statusEl,
    ]);

    audio.onChange(() => this.renderDeviceStatus());

    // The keyboard lives inside the centre column rather than spanning the
    // window, so it sits directly under the zone map and shares its exact note
    // projection. A ruler that does not line up with what it measures is worse
    // than no ruler.
    this.keyboardStrip = el('div', { class: 'keyboard-strip' }, [this.keyboard.root]);

    this.root = el('div', { class: 'shell' }, [
      el('div', { class: 'workspace' }, [left.root, this.centerHost, right.root]),
      transport,
    ]);

    app.onChange(() => this.render());
    this.installKeyboardShortcuts();

    const tick = () => {
      this.meter.draw(audio.running ? audio.level() : 0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Backend, driver and latency, so what you are hearing is never a mystery. */
  private renderDeviceStatus(): void {
    clear(this.deviceEl);
    if (audio.backend === 'native') {
      const s = audio.status;
      this.deviceEl.append(
        el('span', { class: `badge ${s?.running ? 'ok' : 'warn'}`, text: s?.api || 'native' }),
        el('span', {
          class: 'num',
          style: 'margin-left:8px',
          text: s?.running
            ? `${s.latencyEstimated ? '≈' : ''}${s.latencyMs.toFixed(1)} ms · ${s.frameSize}`
            : 'stopped',
        }),
      );
    } else {
      this.deviceEl.append(
        el('span', { class: `badge ${audio.running ? 'ok' : 'warn'}`, text: 'system' }),
        el('span', {
          class: 'num',
          style: 'margin-left:8px',
          text: audio.running ? `${audio.latencyMs.toFixed(1)} ms` : 'stopped',
        }),
      );
    }
  }

  render(): void {
    audio.setInstrument(app.instrument);
    this.renderDeviceStatus();
    this.renderTakes();
    this.renderCenter();
    this.renderInspector();
    this.renderStatus();
    this.zoneMap.setInstrument(app.instrument);
    this.zoneMap.setSelection(app.selectedZones);
  }

  private renderStatus(): void {
    const inst = app.instrument;
    const zones = inst.groups.reduce((n, g) => n + g.zones.length, 0);
    const stretch = maxStretch(inst);
    // An unmapped instrument is one big "gap"; reporting that is just noise.
    const gaps = zones ? findGaps(inst).filter((g) => g.high - g.low > 0) : [];
    clear(this.statusEl);
    this.statusEl.append(
      el('span', {}, [
        el('span', { class: 'num', text: String(inst.samples.length) }),
        ' takes · ',
        el('span', { class: 'num', text: String(zones) }),
        ' zones · max stretch ',
        el('span', { class: 'num', text: `${stretch}` }),
        ' st',
        gaps.length ? ` · ${gaps.length} gap${gaps.length > 1 ? 's' : ''}` : '',
        app.dirty ? ' · unsaved' : '',
      ]),
    );
  }

  /** Re-record the selected takes, or every take when nothing is selected. */
  private retakeSelected(): void {
    const samples = this.targetSamples();
    if (!samples.length) return toast('Nothing to re-record', 'err');
    if (!app.requestCapture) return toast('Capture is not available here', 'err');
    app.requestCapture(samples);
  }

  private renderTakes(): void {
    clear(this.leftBody);
    const inst = app.instrument;
    this.retakeBtn.disabled = !inst.samples.length;
    this.retakeBtn.textContent = app.selectedSamples.length
      ? `Re-record ${app.selectedSamples.length}`
      : 'Re-record';
    if (!inst.samples.length) {
      this.leftBody.append(
        el('div', { class: 'empty' }, [
          'No takes yet.',
          el('br'),
          el('br'),
          'Import audio, drop a folder, or run a capture session.',
        ]),
      );
      return;
    }

    const list = el('div', { class: 'list' });
    for (const s of inst.samples) {
      const selected = app.selectedSamples.includes(s.id);
      const root = s.analysis.rootMidi;
      const conf = s.analysis.confidence ?? 0;
      const missing = !sampleStore.has(s.id);

      const meta = missing
        ? 'missing'
        : root != null
          ? `${midiName(root)}${Math.abs(s.analysis.cents ?? 0) > 4 ? `${(s.analysis.cents ?? 0) > 0 ? '+' : ''}${Math.round(s.analysis.cents ?? 0)}¢` : ''}`
          : '—';

      const row = el(
        'div',
        {
          class: `row ${selected ? 'selected' : ''} ${conf > 0 && conf < 0.6 ? 'warn' : ''}`,
          onclick: (e: Event) => {
            const me = e as MouseEvent;
            if (me.shiftKey && app.selectedSamples.length) {
              const ids = inst.samples.map((x) => x.id);
              const a = ids.indexOf(app.selectedSamples[app.selectedSamples.length - 1]);
              const b = ids.indexOf(s.id);
              app.selectedSamples = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
            } else if (me.ctrlKey || me.metaKey) {
              app.selectedSamples = selected
                ? app.selectedSamples.filter((x) => x !== s.id)
                : [...app.selectedSamples, s.id];
            } else {
              app.selectedSamples = [s.id];
            }
            app.touch(false);
          },
          ondblclick: () => audio.previewSample(s.id),
        },
        [
          el('span', { class: 'row-name', text: s.name, title: s.name }),
          s.derivedFrom ? el('span', { class: 'badge accent', text: 'gen' }) : null,
          el('span', { class: 'row-meta', text: meta }),
        ],
      );
      list.append(row);
    }
    this.leftBody.append(list);
  }

  /** One line saying what this stage is for. Both middle stages used to render
   *  the same thing, which is why neither looked like it did anything. */
  private stageBlurb(): string {
    switch (app.stage) {
      case 'takes':
        return 'Record or import takes, then analyse and clean them up.';
      case 'map':
        return 'Place each take in key and velocity space. Drag zone edges to resize, bodies to move.';
      case 'refine':
        return 'Shape how it plays — amplitude envelope, filter, and sustain loops.';
      default:
        return '';
    }
  }

  private renderCenter(): void {
    clear(this.centerHost);
    if (app.stage === 'export') {
      this.centerHost.append(this.buildExportPanel(), this.keyboardStrip);
      requestAnimationFrame(() => this.keyboard.draw());
      return;
    }

    const title =
      app.stage === 'takes' ? 'Waveform' : app.stage === 'map' ? 'Zone map' : 'Voice';

    this.centerHost.append(
      el('div', { class: 'panel-head' }, [
        el('span', { class: 'panel-title', text: title }),
        el('div', { class: 'spacer' }),
        ...this.centerActions(),
      ]),
      el('div', { class: 'stage-blurb', text: this.stageBlurb() }),
    );

    if (app.stage === 'takes') {
      // waveform.root is already a .canvas-wrap — wrapping it again would give
      // it a block parent of auto height, collapsing the canvas to its
      // intrinsic 300x150 instead of filling the panel.
      this.centerHost.append(this.waveform.root);
    } else if (app.stage === 'map') {
      this.centerHost.append(this.mapBody());
    } else {
      this.centerHost.append(this.refineBody());
    }

    this.centerHost.append(this.keyboardStrip);
    this.syncWaveform();

    requestAnimationFrame(() => {
      this.zoneMap.draw();
      this.waveform.draw();
      this.keyboard.draw();
      this.coverage.draw();
      this.envelopeView.draw();
      this.filterView.draw();
    });
  }

  /** Map: the zone grid, a coverage band, and the selected sample. */
  private mapBody(): HTMLElement {
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
            ? el('button', { class: 'primary', text: 'Auto-map takes', onclick: () => this.runAutoMap() })
            : el('button', { class: 'primary', text: 'Go to Takes', onclick: () => this.setStage('takes') }),
        ]),
      );
      return host;
    }

    this.coverage.setInstrument(inst);
    this.coverage.setRange(this.keyboard.getRange());

    host.append(
      this.zoneMap.root,
      el('div', { class: 'coverage-wrap' }, [
        el('div', { class: 'coverage-label', text: 'Coverage' }),
        this.coverage.root,
      ]),
      el('div', { class: 'waveform-panel' }, [
        el('div', { class: 'panel-head' }, [el('span', { class: 'panel-title', text: 'Sample' })]),
        this.waveform.root,
      ]),
    );
    return host;
  }

  /** Refine: envelope, filter, and the loop status of every zone. */
  private refineBody(): HTMLElement {
    const group = app.group();
    const host = el('div', { class: 'stage-body refine-body' });

    if (!group || !group.zones.length) {
      host.append(
        el('div', { class: 'empty-cta' }, [
          el('h2', { text: 'Nothing mapped to refine' }),
          el('p', {
            text: 'Envelopes, filters and loops apply to mapped zones. Map your takes first and they will show up here.',
          }),
          el('button', { class: 'primary', text: 'Go to Map', onclick: () => this.setStage('map') }),
        ]),
      );
      return host;
    }

    this.envelopeView.show(group.ampEnv);
    this.filterView.show(group.filter);

    host.append(
      el('div', { class: 'refine-panel grow' }, [
        el('div', { class: 'panel-head' }, [
          el('span', { class: 'panel-title', text: 'Envelope' }),
          el('div', { class: 'spacer' }),
          el('span', { class: 'status', text: group.name }),
        ]),
        this.envelopeView.root,
      ]),
      el('div', { class: 'refine-panel', style: 'height:150px' }, [
        el('div', { class: 'panel-head' }, [
          el('span', { class: 'panel-title', text: 'Filter' }),
          el('span', {
            class: 'panel-sub',
            text: group.filter.type === 'off' ? 'Off' : group.filter.type,
          }),
        ]),
        this.filterView.root,
      ]),
      this.buildLoopPanel(group),
    );
    return host;
  }

  /** Which zones loop, how well, and what to do about the ones that do not. */
  private buildLoopPanel(group: Group): HTMLElement {
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
        el('button', { class: 'sm ghost', text: 'Find loops', onclick: () => this.runAutoLoop() }),
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

  /** Point the waveform at whatever is selected. */
  private syncWaveform(): void {
    const zoneSel = app.selectedZones[0] ? app.zoneById(app.selectedZones[0]) : null;
    const sampleId = zoneSel?.zone.sampleId ?? app.selectedSamples[0] ?? null;

    if (zoneSel) {
      const z = zoneSel.zone;
      this.waveform.show(z.sampleId, {
        startFrame: z.startFrame,
        endFrame: z.endFrame,
        loopStart: z.loop.start,
        loopEnd: z.loop.end,
        loopEnabled: z.loop.mode !== 'off',
      });
    } else if (sampleId) {
      const sample = app.sampleById(sampleId);
      this.waveform.show(sampleId, {
        startFrame: sample?.analysis.onsetFrame ?? 0,
        endFrame: sample?.analysis.tailFrame ?? sample?.frames ?? 0,
      });
    } else {
      this.waveform.show(null, {});
    }
  }

  private centerActions(): Node[] {
    if (app.stage === 'takes') {
      return [
        el('button', { class: 'sm ghost', text: 'Analyze', onclick: () => this.runAnalyze() }),
        el('button', { class: 'sm ghost', text: 'Clean up', onclick: () => this.runCleanup() }),
        el('button', { class: 'sm ghost', text: 'Split take', onclick: () => this.runSplit() }),
      ];
    }
    if (app.stage === 'map') {
      return [
        el('button', { class: 'sm ghost', text: 'Auto-map', onclick: () => this.runAutoMap() }),
        el('button', { class: 'sm ghost', text: 'Fill gaps', onclick: () => this.runFillGaps() }),
      ];
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Inspector
  // -------------------------------------------------------------------------

  private renderInspector(): void {
    clear(this.rightBody);
    const titleEl = this.rightHead.querySelector('.panel-title');
    if (titleEl)
      titleEl.textContent =
        app.stage === 'takes' ? 'Take' : app.stage === 'refine' ? 'Group' : app.stage === 'export' ? 'Export' : 'Zone';

    if (app.stage === 'takes') this.rightBody.append(this.buildTakeInspector());
    else if (app.stage === 'refine') this.rightBody.append(this.buildGroupInspector());
    else if (app.stage === 'map') this.rightBody.append(this.buildZoneInspector());
    else this.rightBody.append(this.buildInstrumentInspector());
  }

  private buildTakeInspector(): HTMLElement {
    const ids = app.selectedSamples;
    const host = el('div');
    if (!ids.length) {
      host.append(el('div', { class: 'empty', text: 'Select a take.' }));
      return host;
    }
    if (ids.length > 1) {
      host.append(
        section(
          `${ids.length} takes selected`,
          el('div', { class: 'notice', text: 'Cleanup and analysis apply to the whole selection.' }),
        ),
      );
      return host;
    }

    const s = app.sampleById(ids[0]);
    if (!s) return host;
    const a = s.analysis;
    const conf = a.confidence ?? 0;

    host.append(
      section(
        'Take',
        field('Name', this.textField(s.name, (v) => {
          s.name = v;
          app.touch();
        })),
        field('Length', el('span', { class: 'num', text: `${(s.frames / s.sampleRate).toFixed(2)} s` })),
        field('Format', el('span', { class: 'num', text: `${s.sampleRate} Hz · ${s.channels}ch` })),
      ),
      section(
        'Analysis',
        field(
          'Detected',
          el('span', { class: 'num', text: a.rootMidi != null ? midiName(a.rootMidi) : 'none' }),
          a.rootMidi != null
            ? el('span', {
                class: `badge ${conf >= 0.75 ? 'ok' : conf >= 0.6 ? 'warn' : 'danger'}`,
                text: `${Math.round(conf * 100)}%`,
              })
            : null,
        ),
        field('Offset', el('span', { class: 'num', text: `${(a.cents ?? 0).toFixed(1)} ¢` })),
        field('Peak', el('span', { class: 'num', text: `${formatDb(a.peakDb ?? -Infinity)} dB` })),
        field('RMS', el('span', { class: 'num', text: `${formatDb(a.rmsDb ?? -Infinity)} dB` })),
        field('Noise floor', el('span', { class: 'num', text: `${formatDb(a.noiseFloorDb ?? -Infinity)} dB` })),
        (a.peakDb ?? -99) > -0.2
          ? el('div', { class: 'notice danger', text: 'This take is clipped. Re-record it if you can.' })
          : null,
        conf > 0 && conf < 0.6
          ? el('div', {
              class: 'notice warn',
              text: 'Low pitch confidence. The capture target will be used for mapping instead.',
            })
          : null,
      ),
      section(
        'Capture',
        field(
          'Target note',
          noteField(s.capture.targetMidi ?? 60, (v) => {
            s.capture.targetMidi = v;
            app.touch();
          }),
        ),
        field(
          'Velocity layer',
          numberField(s.capture.velLayer ?? 1, (v) => {
            s.capture.velLayer = Math.max(1, Math.round(v));
            app.touch();
          }, { min: 1, max: 16, width: 70 }),
        ),
        field(
          'Round robin',
          numberField(s.capture.rrIndex ?? 1, (v) => {
            s.capture.rrIndex = Math.max(1, Math.round(v));
            app.touch();
          }, { min: 1, max: 32, width: 70 }),
        ),
      ),
      section(
        'Actions',
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
          el('button', { class: 'sm', text: 'Preview', onclick: () => audio.previewSample(s.id) }),
          el('button', {
            class: 'sm',
            text: 'Re-record',
            onclick: () => app.requestCapture?.([s]),
          }),
          el('button', {
            class: 'sm danger',
            text: 'Remove',
            onclick: () => {
              app.instrument.samples = app.instrument.samples.filter((x) => x.id !== s.id);
              for (const g of app.instrument.groups)
                g.zones = g.zones.filter((z) => z.sampleId !== s.id);
              sampleStore.delete(s.id);
              app.selectedSamples = [];
              app.touch();
            },
          }),
        ]),
      ),
    );
    return host;
  }

  private buildZoneInspector(): HTMLElement {
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
              this.zoneMap.setInstrument(app.instrument);
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
        this.knobRow(
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

  private buildGroupInspector(): HTMLElement {
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
        field('Name', this.textField(group.name, (v) => {
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
        this.knobRow(
          this.envKnob('Attack', group.ampEnv.attack, 0, 4, (v) => (group.ampEnv.attack = v), commit),
          this.envKnob('Decay', group.ampEnv.decay, 0.001, 8, (v) => (group.ampEnv.decay = v), commit),
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
          this.envKnob('Release', group.ampEnv.release, 0.001, 8, (v) => (group.ampEnv.release = v), commit),
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
          ? this.knobRow(
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

  private buildInstrumentInspector(): HTMLElement {
    const inst = app.instrument;
    const m = inst.master;
    const commit = () => app.touch();
    return el('div', {}, [
      section(
        'Instrument',
        field('Author', this.textField(inst.author, (v) => {
          inst.author = v;
          commit();
        })),
        el('textarea', {
          rows: 4,
          placeholder: 'Description',
          oninput: (e: Event) => {
            inst.description = (e.target as HTMLTextAreaElement).value;
            app.dirty = true;
          },
        }),
      ),
      section(
        'Master',
        this.knobRow(
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

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  private buildExportPanel(): HTMLElement {
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
          onclick: () => this.runExport([...chosen]),
        }),
      ]),
    ]);
    refreshWarnings();

    return el('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' }, [
      el('div', { class: 'panel-head' }, [el('span', { class: 'panel-title', text: 'Export' })]),
      body,
    ]);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async importFiles(): Promise<void> {
    if (hasNative && native) {
      const paths = await native.openAudio();
      if (!paths?.length) return;
      await this.ingestPaths(paths);
    } else {
      const files = await pickFilesInBrowser('audio/*', true);
      await this.ingestFiles(files);
    }
  }

  async importFolder(): Promise<void> {
    if (!hasNative || !native) {
      toast('Folder import needs the desktop app', 'err');
      return;
    }
    const paths = await native.openFolder();
    if (!paths?.length) return;
    await this.ingestPaths(paths);
  }

  private async ingestPaths(paths: string[]): Promise<void> {
    const prog = progressModal('Importing');
    let failed = 0;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      prog.update(i, paths.length, baseName(p));
      try {
        const bytes = await native!.read(p);
        const { sample } = await importAudio(baseName(p), bytes, p);
        app.instrument.samples.push(sample);
      } catch {
        failed++;
      }
    }
    prog.close();
    analyzeAll(app.instrument.samples.filter((s) => !s.analysis.rootMidi));
    app.touch();
    toast(`Imported ${paths.length - failed} take${paths.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`);
  }

  private async ingestFiles(files: File[]): Promise<void> {
    for (const f of files) {
      try {
        const { sample } = await importAudio(f.name, await f.arrayBuffer());
        app.instrument.samples.push(sample);
      } catch {
        /* skip unreadable file */
      }
    }
    analyzeAll(app.instrument.samples.filter((s) => !s.analysis.rootMidi));
    app.touch();
  }

  private targetSamples() {
    const inst = app.instrument;
    return app.selectedSamples.length
      ? inst.samples.filter((s) => app.selectedSamples.includes(s.id))
      : inst.samples;
  }

  private runAnalyze(): void {
    const samples = this.targetSamples();
    if (!samples.length) return toast('Nothing to analyze', 'err');
    analyzeAll(samples);
    app.touch();
    const unsure = samples.filter((s) => (s.analysis.confidence ?? 0) < 0.6).length;
    toast(`Analyzed ${samples.length}${unsure ? ` — ${unsure} uncertain` : ''}`);
  }

  private runCleanup(): void {
    const samples = this.targetSamples();
    if (!samples.length) return toast('Nothing to clean', 'err');

    let trim = true;
    let match = true;
    let normalize = true;
    const body = el('div', {}, [
      el('div', { class: 'notice' }, [
        'Trimming keeps a few milliseconds of pre-roll so attacks stay intact. ',
        'Level matching is what makes neighbouring zones sound like one instrument.',
      ]),
      checkbox('Trim silence', trim, (v) => (trim = v)),
      el('br'),
      checkbox('Match levels across the set', match, (v) => (match = v)),
      el('br'),
      checkbox('Normalize peaks to -1 dBFS', normalize, (v) => (normalize = v)),
    ]);

    modal({
      title: `Clean up ${samples.length} take${samples.length === 1 ? '' : 's'}`,
      body,
      confirmLabel: 'Clean up',
      onConfirm: () => {
        cleanupSamples(samples, {
          trim,
          matchLevels: match,
          normalizePeakDb: normalize ? -1 : null,
          fadeOutMs: 3,
        });
        for (const s of samples) audio.invalidate(s.id);
        app.touch();
        toast(`Cleaned ${samples.length} take${samples.length === 1 ? '' : 's'}`);
      },
    });
  }

  private async runSplit(): Promise<void> {
    const id = app.selectedSamples[0];
    const source = id ? app.sampleById(id) : null;
    if (!source) return toast('Select the long recording first', 'err');

    const results = await splitLongTake(source);
    if (!results.length) return toast('No separate notes found', 'err');

    const inst = app.instrument;
    inst.samples = inst.samples.filter((s) => s.id !== source.id);
    sampleStore.delete(source.id);
    for (const r of results) inst.samples.push(r.sample);
    analyzeAll(results.map((r) => r.sample), { useTargetHint: false });
    app.selectedSamples = [];
    app.touch();
    toast(`Split into ${results.length} takes`);
  }

  private runAutoMap(): void {
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

  private runAutoLoop(): void {
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

  private runFillGaps(): void {
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

  private async runExport(targets: string[]): Promise<void> {
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

  async saveAs(): Promise<void> {
    if (!hasNative || !native) {
      await saveProject(app.instrument, '');
      return;
    }
    const dir = await native.chooseDir('Choose a folder for this instrument');
    if (!dir) return;
    const target = await native.join(dir, `${app.instrument.name}.sinst`);
    const prog = progressModal('Saving');
    await saveProject(app.instrument, target, (d, t) => prog.update(d, t));
    prog.close();
    app.projectPath = target;
    app.dirty = false;
    rememberProject(target);
    app.touch(false);
    toast('Saved');
  }

  async save(): Promise<void> {
    if (!app.projectPath) return this.saveAs();
    const prog = progressModal('Saving');
    await saveProject(app.instrument, app.projectPath, (d, t) => prog.update(d, t));
    prog.close();
    app.dirty = false;
    app.touch(false);
    toast('Saved');
  }

  async open(): Promise<void> {
    if (!hasNative || !native) return toast('Opening needs the desktop app', 'err');
    const dir = await native.chooseDir('Open a .sinst folder');
    if (!dir) return;
    const prog = progressModal('Opening');
    const inst = await loadProject(dir, (d, t) => prog.update(d, t));
    prog.close();
    if (!inst) return toast('That folder is not a .sinst project', 'err');
    app.setInstrument(inst);
    app.projectPath = dir;
    rememberProject(dir);
    toast(`Opened ${inst.name}`);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private textField(value: string, onChange: (v: string) => void): HTMLInputElement {
    const input = el('input', { type: 'text', value });
    input.addEventListener('change', () => onChange(input.value));
    return input;
  }

  private knobRow(...knobs: Knob[]): HTMLElement {
    return el('div', { class: 'knob-row' }, knobs.map((k) => k.root));
  }

  private envKnob(
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

  /** QWERTY playing, so the instrument is playable without any hardware. */
  private installKeyboardShortcuts(): void {
    const layout = 'zsxdcvgbhnjm,l.;/q2w3er5t6y7ui9o0p';
    const held = new Set<string>();
    let octave = 4;

    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void (e.shiftKey ? this.saveAs() : this.save());
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void this.open();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === 'ArrowLeft' && e.shiftKey) return void (octave = Math.max(0, octave - 1));
      if (e.key === 'ArrowRight' && e.shiftKey) return void (octave = Math.min(8, octave + 1));

      const idx = layout.indexOf(e.key.toLowerCase());
      if (idx < 0 || held.has(e.key)) return;
      held.add(e.key);
      const midi = 12 * octave + idx;
      if (midi >= 0 && midi <= 127) {
        void audio.start().then(() => audio.noteOn(midi, 100));
        this.keyboard.noteOn(midi);
      }
    });

    document.addEventListener('keyup', (e) => {
      const idx = layout.indexOf(e.key.toLowerCase());
      if (idx < 0) return;
      held.delete(e.key);
      const midi = 12 * octave + idx;
      audio.noteOff(midi);
      this.keyboard.noteOff(midi);
    });
  }

  setStage(stage: import('./app').Stage): void {
    app.stage = stage;
    app.touch(false);
  }

  /** Exposed so the session screen can hand focus back cleanly. */
  refresh(): void {
    this.render();
  }

  get zoneMapView(): ZoneMap {
    return this.zoneMap;
  }

  get keyboardView(): Keyboard {
    return this.keyboard;
  }

  /** Used by the shell for the segmented stage control. */
  static stageOptions(): { value: import('./app').Stage; label: string }[] {
    return [
      { value: 'takes', label: 'Takes' },
      { value: 'map', label: 'Map' },
      { value: 'refine', label: 'Refine' },
      { value: 'export', label: 'Export' },
    ];
  }

  /** Kept for the shell's stage rail, which builds its own buttons. */
  static segmentedStages(current: import('./app').Stage, onChange: (s: import('./app').Stage) => void) {
    return segmented(Studio.stageOptions(), current, onChange);
  }

  /** Zones for a group, used by the session screen when filing takes. */
  static zonesOf(group: Group): Zone[] {
    return group.zones;
  }
}

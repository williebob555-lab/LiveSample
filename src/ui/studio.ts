// ============================================================================
// Studio — the desk screen. Dense, precise, mouse-driven.
//
// Layout is fixed rather than dockable. A sampler builder has a small number of
// known screens, so they can be designed; the sibling node-editor project is
// dockable because its content is arbitrary, and that is exactly why it was
// hard to make look finished.
// ============================================================================

import { app, panel, toast } from './app';
import { el, clear } from './dom';
import { Meter, segmented } from './primitives';
import { ZoneMap } from './zonemap';
import { Keyboard } from './keyboard';
import { WaveformView } from './waveform';
import { EnvelopeView, FilterView } from './curves';
import { CoverageStrip } from './coverage';
import { audio } from '../audio/output';
import { openAudioSettings } from './audio-settings';
import { openMidiSettings } from './midi-settings';
import { type Zone, type Group } from '../core/types';
import { findGaps, maxStretch } from '../core/automap';
import { retakeSelected, renderTakes, takesBody, takesActions, buildTakeInspector } from './stages/takes';
import { mapBody, mapActions, buildZoneInspector } from './stages/map';
import { refineBody, buildGroupInspector } from './stages/refine';
import { buildExportPanel, buildInstrumentInspector } from './stages/export';
import { importFiles, importFolder, saveAs, save, open, openPath } from './project-actions';
import type { StageContext } from './stages/context';

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
  private ctx: StageContext;

  constructor() {
    this.retakeBtn = el('button', {
      class: 'ghost sm',
      text: 'Re-record',
      title: 'Record these notes again, replacing the audio but keeping the map',
      onclick: () => retakeSelected(),
    });

    const left = panel('Takes', [
      this.retakeBtn,
      el('button', { class: 'ghost sm', text: 'Import', onclick: () => importFiles() }),
      el('button', { class: 'ghost sm', text: 'Folder', onclick: () => importFolder() }),
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
      el('button', { class: 'sm ghost', text: 'MIDI…', onclick: () => openMidiSettings() }),
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

    this.ctx = {
      zoneMap: this.zoneMap,
      keyboard: this.keyboard,
      waveform: this.waveform,
      coverage: this.coverage,
      envelopeView: this.envelopeView,
      filterView: this.filterView,
      setStage: (stage) => this.setStage(stage),
    };

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
    renderTakes(this.leftBody, this.retakeBtn);
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
      this.centerHost.append(buildExportPanel(), this.keyboardStrip);
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
      this.centerHost.append(takesBody(this.ctx));
    } else if (app.stage === 'map') {
      this.centerHost.append(mapBody(this.ctx));
    } else {
      this.centerHost.append(refineBody(this.ctx));
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
    if (app.stage === 'takes') return takesActions();
    if (app.stage === 'map') return mapActions();
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

    if (app.stage === 'takes') this.rightBody.append(buildTakeInspector());
    else if (app.stage === 'refine') this.rightBody.append(buildGroupInspector());
    else if (app.stage === 'map') this.rightBody.append(buildZoneInspector(this.ctx));
    else this.rightBody.append(buildInstrumentInspector());
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

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
        void (e.shiftKey ? saveAs() : save());
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void open();
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

  async importFiles(): Promise<void> {
    return importFiles();
  }

  async importFolder(): Promise<void> {
    return importFolder();
  }

  async saveAs(): Promise<void> {
    return saveAs();
  }

  async save(): Promise<void> {
    return save();
  }

  async open(): Promise<void> {
    return open();
  }

  /** Open a known project folder (Open, Open Recent, the welcome card). */
  async openPath(dir: string): Promise<void> {
    return openPath(dir);
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

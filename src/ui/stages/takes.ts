// ============================================================================
// Takes stage — the take list, the take inspector, and import-side actions.
// ============================================================================

import { app, section, toast, modal } from '../app';
import { el, clear, formatDb } from '../dom';
import { field, checkbox, numberField } from '../primitives';
import { noteField } from '../notes';
import { markSvg } from '../brand';
import { openDenoise } from '../denoise';
import { audio } from '../../audio/output';
import { sampleStore } from '../../audio/store';
import { midiName } from '../../dsp/pitch';
import { analyzeAll, cleanupSamples, splitLongTake } from '../../core/pipeline';
import { recentProjects } from '../../core/project';
import { type StageContext } from './context';
import { textField, targetSamples } from './helpers';
import { importFiles, open, openPath } from '../project-actions';

/** Re-record the selected takes, or every take when nothing is selected. */
export function retakeSelected(): void {
  const samples = targetSamples();
  if (!samples.length) return toast('Nothing to re-record', 'err');
  if (!app.requestCapture) return toast('Capture is not available here', 'err');
  app.requestCapture(samples);
}

export function renderTakes(leftBody: HTMLElement, retakeBtn: HTMLButtonElement): void {
  clear(leftBody);
  const inst = app.instrument;
  retakeBtn.disabled = !inst.samples.length;
  retakeBtn.textContent = app.selectedSamples.length
    ? `Re-record ${app.selectedSamples.length}`
    : 'Re-record';
  if (!inst.samples.length) {
    leftBody.append(
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
  leftBody.append(list);
}

/** Centre body for Takes: the waveform, or the welcome card with no takes. */
export function takesBody(ctx: StageContext): Node {
  if (!app.instrument.samples.length) {
    // Nothing to show a waveform of; a first-run welcome is more useful than
    // an empty canvas. It vanishes as soon as there is a take.
    return welcomeCard();
  }
  // waveform.root is already a .canvas-wrap — wrapping it again would give
  // it a block parent of auto height, collapsing the canvas to its
  // intrinsic 300x150 instead of filling the panel.
  return ctx.waveform.root;
}

/** Empty-instrument welcome: the three ways to start. */
function welcomeCard(): HTMLElement {
  const svg = markSvg(72);

  const action = (title: string, sub: string, run: () => void, primary = false) =>
    el('button', { class: `welcome-action ${primary ? 'primary' : ''}`, onclick: run }, [
      el('span', { class: 'welcome-action-title', text: title }),
      el('span', { class: 'welcome-action-sub', text: sub }),
    ]);

  const recents = recentProjects().slice(0, 5);
  const recentList = el('div', { class: 'welcome-recents' });
  if (!recents.length) {
    recentList.append(el('div', { class: 'welcome-none', text: 'No recent projects yet' }));
  }
  for (const r of recents) {
    recentList.append(
      el('button', { class: 'welcome-recent', title: r.path, onclick: () => void openPath(r.path) }, [
        el('span', { class: 'welcome-recent-name', text: r.name }),
        el('span', { class: 'welcome-recent-path', text: r.path }),
      ]),
    );
  }

  return el('div', { class: 'welcome' }, [
    el('div', { class: 'welcome-card' }, [
      svg,
      el('h2', { text: 'Welcome to LiveSample' }),
      el('p', { text: 'Build a multisampled instrument: bring in recordings or play the notes yourself.' }),
      el('div', { class: 'welcome-actions' }, [
        action('Import samples', 'Audio files or a long take', () => void importFiles()),
        action(
          'Start a capture session',
          'Record each note as you play',
          () => (app.requestCapture ? app.requestCapture() : toast('Capture is not available here', 'err')),
          true,
        ),
        action('Open recent', recents.length ? 'Pick up where you left off' : 'Open a .sinst folder', () => {
          if (!recents.length) void open();
          else recentList.scrollIntoView({ block: 'nearest' });
        }),
      ]),
      recentList,
    ]),
  ]);
}

/** Toolbar buttons for the Takes stage's centre panel. */
export function takesActions(): Node[] {
  return [
    el('button', { class: 'sm ghost', text: 'Analyze', onclick: () => runAnalyze() }),
    el('button', { class: 'sm ghost', text: 'Clean up', onclick: () => runCleanup() }),
    el('button', { class: 'sm ghost', text: 'Denoise', onclick: () => openDenoise(targetSamples()) }),
    el('button', { class: 'sm ghost', text: 'Split take', onclick: () => runSplit() }),
  ];
}

export function buildTakeInspector(): HTMLElement {
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
      field('Name', textField(s.name, (v) => {
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
            // Audio stays in the store so undo can bring the take back whole.
            app.selectedSamples = [];
            app.touch();
          },
        }),
      ]),
    ),
  );
  return host;
}

function runAnalyze(): void {
  const samples = targetSamples();
  if (!samples.length) return toast('Nothing to analyze', 'err');
  analyzeAll(samples);
  app.touch();
  const unsure = samples.filter((s) => (s.analysis.confidence ?? 0) < 0.6).length;
  toast(`Analyzed ${samples.length}${unsure ? ` — ${unsure} uncertain` : ''}`);
}

function runCleanup(): void {
  const samples = targetSamples();
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

async function runSplit(): Promise<void> {
  const id = app.selectedSamples[0];
  const source = id ? app.sampleById(id) : null;
  if (!source) return toast('Select the long recording first', 'err');

  const results = await splitLongTake(source);
  if (!results.length) return toast('No separate notes found', 'err');

  const inst = app.instrument;
  inst.samples = inst.samples.filter((s) => s.id !== source.id);
  // Source audio is kept in the store so undoing the split works.
  for (const r of results) inst.samples.push(r.sample);
  analyzeAll(results.map((r) => r.sample), { useTargetHint: false });
  app.selectedSamples = [];
  app.touch();
  toast(`Split into ${results.length} takes`);
}

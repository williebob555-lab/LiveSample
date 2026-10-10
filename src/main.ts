import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles/tokens.css';
import './styles/app.css';

import { app, toast, modal } from './ui/app';
import { el } from './ui/dom';
import { Studio } from './ui/studio';
import { SessionScreen, type MidiDrive } from './ui/session';
import { audio } from './audio/output';
import { sampleStore } from './audio/store';
import { openAudioSettings } from './ui/audio-settings';
import { midi } from './audio/midi';
import type { Stage } from './ui/app';
import type { CapturePlan, CaptureStep, Sample } from './core/types';
import { native, hasNative } from './core/native';
import { markSvg } from './ui/brand';
import { autoMap } from './core/automap';
import { recentProjects } from './core/project';
import { writeRecovery, findRecovery, loadRecovery, clearRecovery } from './core/recovery';
import { checkForUpdates, checkForUpdatesQuietly, onUpdateAvailable } from './ui/updates';

const host = document.getElementById('app');
if (!host) throw new Error('#app is missing from index.html');

const studio = new Studio();

// --- Top bar ---------------------------------------------------------------

const nameInput = el('input', {
  class: 'inst-name',
  type: 'text',
  value: app.instrument.name,
  spellcheck: false,
});
nameInput.addEventListener('change', () => {
  app.instrument.name = nameInput.value.trim() || 'Untitled instrument';
  app.touch();
});

const STAGES: { value: Stage; label: string }[] = [
  { value: 'takes', label: 'Takes' },
  { value: 'map', label: 'Map' },
  { value: 'refine', label: 'Refine' },
  { value: 'export', label: 'Export' },
];

const stageRail = el('div', { class: 'stages' });
const stageButtons = STAGES.map((s, i) => {
  const b = el('button', { class: 'stage' }, [
    el('span', { class: 'step-no', text: String(i + 1) }),
    s.label,
  ]);
  b.addEventListener('click', () => {
    app.stage = s.value;
    app.touch(false);
  });
  stageRail.append(b);
  return { stage: s.value, node: b };
});

function syncStageRail(): void {
  for (const { stage, node } of stageButtons) node.classList.toggle('active', app.stage === stage);
  if (nameInput.value !== app.instrument.name && document.activeElement !== nameInput)
    nameInput.value = app.instrument.name;
}

/** The mark and name. The meter-i of the full wordmark does not survive at
 *  topbar size, so it is set as plain text here (brand/README.md). */
function brandMark(): HTMLElement {
  const span = el('span', { class: 'brand', title: 'LiveSample' });
  span.append(markSvg(18), el('span', {}, ['Live', el('b', { text: 'Sample' })]));
  return span;
}

const updateButton = el('button', {
  class: 'sm ghost',
  text: 'Updates',
  title: 'Check for updates',
  onclick: () => void checkForUpdates(),
});
onUpdateAvailable((version) => {
  updateButton.textContent = `Update to ${version}`;
  updateButton.classList.add('update-available');
});

// --- Undo / redo -----------------------------------------------------------

const undoBtn = el('button', {
  class: 'sm ghost',
  text: 'Undo',
  title: 'Undo (Ctrl+Z)',
  onclick: () => doUndo(),
});
const redoBtn = el('button', {
  class: 'sm ghost',
  text: 'Redo',
  title: 'Redo (Ctrl+Shift+Z)',
  onclick: () => doRedo(),
});

// The capture session holds live references into the instrument (the take it
// is about to file, the plan it is running), so swapping the document under it
// would corrupt the session. History is simply off until it ends.
function doUndo(): void {
  if (!session) app.undo();
}
function doRedo(): void {
  if (!session) app.redo();
}

function syncHistoryButtons(): void {
  undoBtn.disabled = !!session || !app.canUndo;
  redoBtn.disabled = !!session || !app.canRedo;
}

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const t = e.target as HTMLElement | null;
  // In a text field Ctrl+Z belongs to the field's own undo.
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) doUndo();
  else if ((k === 'z' && e.shiftKey) || k === 'y') doRedo();
  else return;
  e.preventDefault();
});

// --- Open Recent -----------------------------------------------------------

const recentBtn = el('button', { class: 'sm ghost', text: 'Recent ▾', title: 'Open a recent project' });
const recentMenu = el('div', { class: 'menu', style: 'display:none' });
const recentWrap = el('div', { class: 'menu-wrap' }, [recentBtn, recentMenu]);

function closeRecent(): void {
  recentMenu.style.display = 'none';
}

recentBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (recentMenu.style.display !== 'none') return closeRecent();
  // Rebuilt on every open: another window or a save may have changed the list.
  recentMenu.replaceChildren();
  const list = recentProjects().slice(0, 12);
  if (!list.length) recentMenu.append(el('div', { class: 'menu-empty', text: 'No recent projects' }));
  for (const r of list) {
    recentMenu.append(
      el(
        'button',
        {
          class: 'menu-item',
          title: r.path,
          onclick: () => {
            closeRecent();
            void studio.openPath(r.path);
          },
        },
        [el('span', { class: 'menu-name', text: r.name }), el('span', { class: 'menu-path', text: r.path })],
      ),
    );
  }
  recentMenu.style.display = 'block';
});
document.addEventListener('click', closeRecent);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeRecent();
});

const topbar = el('div', { class: 'topbar' }, [
  brandMark(),
  nameInput,
  el('div', { class: 'spacer' }),
  stageRail,
  el('div', { class: 'spacer' }),
  el('button', {
    class: 'sm',
    text: 'Capture…',
    onclick: () => startSession(),
  }),
  el('button', { class: 'sm ghost', text: 'Audio…', onclick: () => openAudioSettings() }),
  undoBtn,
  redoBtn,
  el('button', { class: 'sm ghost', text: 'Open', onclick: () => void studio.open() }),
  recentWrap,
  el('button', { class: 'sm ghost', text: 'Save', onclick: () => void studio.save() }),
  updateButton,
]);

host.append(topbar, studio.root);

// --- Session mode ----------------------------------------------------------

let session: SessionScreen | null = null;

async function launchSession(plan: CapturePlan, steps?: CaptureStep[], drive?: MidiDrive | null): Promise<void> {
  // Auditioning and capturing at the same time would bleed one into the other,
  // so the engine stands down for the duration.
  audio.allNotesOff();
  midi.releaseAll();
  midi.auditionEnabled = false;
  const screen = new SessionScreen(() => {
    screen.root.remove();
    session = null;
    midi.auditionEnabled = true;
    app.stage = 'takes';
    app.touch(false);
    syncHistoryButtons();
    toast('Session ended');
  });
  session = screen;
  syncHistoryButtons();
  studio.root.append(screen.root);
  const ok = await screen.start(plan, steps, drive);
  if (!ok) {
    screen.root.remove();
    session = null;
    syncHistoryButtons();
    midi.auditionEnabled = true;
  }
}

function startSession(retakeOf?: Sample[]): void {
  if (session) return;
  if (retakeOf?.length) {
    SessionScreen.retake(retakeOf, (plan, steps) => void launchSession(plan, steps));
  } else {
    SessionScreen.configure((plan, drive) => void launchSession(plan, undefined, drive));
  }
}

// Anything that can start a capture goes through here.
app.requestCapture = startSession;

// --- Boot ------------------------------------------------------------------

// Light the on-screen keys for notes arriving over MIDI, and start listening.
// Failure (no permission, no Web MIDI) is surfaced in the MIDI dialog, not here.
midi.onNote((n, on) => (on ? studio.keyboardView.noteOn(n) : studio.keyboardView.noteOff(n)));
void midi.init();

app.onChange(syncStageRail);
app.onChange(syncHistoryButtons);
syncStageRail();
syncHistoryButtons();
studio.refresh();

// Test-only handle, present only when the preload set the SAMPLER_TEST_CAPTURE
// flag (scripts/test-capture.cjs). Gives the end-to-end test the same entry
// points the UI buttons use, minus the native dialogs.
if ((window as unknown as { samplerTest?: { capture?: boolean } }).samplerTest?.capture) {
  (window as unknown as Record<string, unknown>).__sampler = {
    app,
    studio,
    audio,
    startSession,
    autoMap,
    sampleStore,
  };
}

// Dev-only handle for poking at state from the console.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).sampler = { app, studio, audio, sampleStore };
}

// Closing the window.
//
// A `beforeunload` handler that calls preventDefault does NOT prompt in
// Electron — it silently refuses to close, and the app becomes unquittable.
// The unsaved check has to live in the main process, which owns the window and
// can show a real dialog. All the renderer does is keep main informed and do
// what it is told.
// Declared before first use: startAutosave() runs below at boot, and a const
// that is still in its temporal dead zone throws and aborts the rest of boot
// (recovery prompt, close-to-save handler).
const AUTOSAVE_MS = 60_000;

if (hasNative && native) {
  const host = native;
  // After the window has settled, so a slow network never delays startup.
  setTimeout(() => void checkForUpdatesQuietly(), 5000);
  app.onDirtyChange((dirty) => host.setDirty(dirty));
  host.setDirty(app.dirty);

  startAutosave(host);
  void offerRecovery();

  host.onCloseRequest(async (action) => {
    if (action === 'save') {
      try {
        await studio.save();
      } catch {
        // A failed save must not trap the user in an app they cannot close.
        toast('Save failed — closing anyway', 'err');
      }
    }
    host.closeReady();
  });
}

// --- Autosave and crash recovery -------------------------------------------


// Not a plain setInterval body: a slow disk must not stack up overlapping
// writes into the same folder, so one write at a time and the next tick skips.
function startAutosave(_host: unknown): void {
  let busy = false;
  let lastRev = -1;
  setInterval(async () => {
    // Mid-capture the instrument is changing under a live recording and the
    // disk should be left free for it; the session saves its own takes.
    if (busy || session || !app.dirty || app.rev === lastRev) return;
    busy = true;
    const rev = app.rev;
    try {
      await writeRecovery(app.instrument, app.projectPath);
      lastRev = rev;
    } catch {
      // Autosave is a safety net. Failing quietly beats interrupting the work
      // it exists to protect; the next tick tries again.
    } finally {
      busy = false;
    }
  }, AUTOSAVE_MS);
}

async function offerRecovery(): Promise<void> {
  const marker = await findRecovery();
  if (!marker) return;
  const when = new Date(marker.savedAt).toLocaleString();
  modal({
    title: 'Recover unsaved work?',
    body: el('p', {
      text: `LiveSample didn't close cleanly — restore unsaved work from ${when}?${
        marker.name ? ` (${marker.name})` : ''
      }`,
    }),
    confirmLabel: 'Restore',
    cancelLabel: 'Discard',
    onConfirm: async () => {
      const inst = await loadRecovery();
      if (!inst) return void toast('The recovery copy could not be read', 'err');
      app.setInstrument(inst);
      app.projectPath = marker.originalPath;
      // It is, by definition, not what is on disk. Autosave keeps it safe from
      // here on and the close prompt will ask about it.
      app.dirty = true;
      app.touch(false);
      toast('Recovered unsaved work');
    },
    // Closing the dialog any other way (Esc, clicking out) is not a decision,
    // so only the explicit Discard button throws the copy away.
    onCancel: () => void clearRecovery(),
  });
}

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles/tokens.css';
import './styles/app.css';

import { app, toast } from './ui/app';
import { el } from './ui/dom';
import { Studio } from './ui/studio';
import { SessionScreen } from './ui/session';
import { audio } from './audio/output';
import { openAudioSettings } from './ui/audio-settings';
import type { Stage } from './ui/app';
import type { CapturePlan, CaptureStep, Sample } from './core/types';
import { native, hasNative } from './core/native';
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
  span.innerHTML =
    '<svg viewBox="0 0 256 256" width="18" height="18" aria-hidden="true">' +
    '<rect width="256" height="256" rx="56" fill="#14161a"/>' +
    '<path d="M118 192 H162 C190 192 206 178 206 156 C206 134 188 127 164 123 C140 119 124 110 124 92 C124 74 140 64 162 64 H198" fill="none" stroke="#5fb2ff" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M58 64 V192 H118" fill="none" stroke="#e8a13d" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg><span>Live<b>Sample</b></span>';
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
  el('button', { class: 'sm ghost', text: 'Open', onclick: () => void studio.open() }),
  el('button', { class: 'sm ghost', text: 'Save', onclick: () => void studio.save() }),
  updateButton,
]);

host.append(topbar, studio.root);

// --- Session mode ----------------------------------------------------------

let session: SessionScreen | null = null;

async function launchSession(plan: CapturePlan, steps?: CaptureStep[]): Promise<void> {
  // Auditioning and capturing at the same time would bleed one into the other,
  // so the engine stands down for the duration.
  audio.allNotesOff();
  const screen = new SessionScreen(() => {
    screen.root.remove();
    session = null;
    app.stage = 'takes';
    app.touch(false);
    toast('Session ended');
  });
  session = screen;
  studio.root.append(screen.root);
  const ok = await screen.start(plan, steps);
  if (!ok) {
    screen.root.remove();
    session = null;
  }
}

function startSession(retakeOf?: Sample[]): void {
  if (session) return;
  if (retakeOf?.length) {
    SessionScreen.retake(retakeOf, (plan, steps) => void launchSession(plan, steps));
  } else {
    SessionScreen.configure((plan) => void launchSession(plan));
  }
}

// Anything that can start a capture goes through here.
app.requestCapture = startSession;

// --- Boot ------------------------------------------------------------------

app.onChange(syncStageRail);
syncStageRail();
studio.refresh();

// Dev-only handle for poking at state from the console.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).sampler = { app, studio, audio };
}

// Closing the window.
//
// A `beforeunload` handler that calls preventDefault does NOT prompt in
// Electron — it silently refuses to close, and the app becomes unquittable.
// The unsaved check has to live in the main process, which owns the window and
// can show a real dialog. All the renderer does is keep main informed and do
// what it is told.
if (hasNative && native) {
  const host = native;
  // After the window has settled, so a slow network never delays startup.
  setTimeout(() => void checkForUpdatesQuietly(), 5000);
  app.onDirtyChange((dirty) => host.setDirty(dirty));
  host.setDirty(app.dirty);

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

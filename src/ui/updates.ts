// ============================================================================
// In-app updates (renderer half).
//
// The main process owns electron-updater; this owns the conversation: check →
// offer → download with progress → restart. Two entry points:
//
//   checkForUpdates()        the topbar button. Always answers, including
//                            "up to date" and why a check failed.
//   checkForUpdatesQuietly() once at startup. Speaks only when there is
//                            something newer, so a plain launch stays silent.
// ============================================================================

import { app, modal, toast } from './app';
import { el } from './dom';
import { native, type UpdateCheck } from '../core/native';

const mb = (n: number): string => (n / 1048576).toFixed(1) + ' MB';

/** Release notes arrive as GitHub HTML; show them as plain text. */
function notesToText(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function message(title: string, text: string): void {
  modal({ title, body: el('div', { text }), cancelLabel: 'OK' });
}

let onAvailable: ((version: string) => void) | null = null;

/** Lets the topbar mark itself when a startup check finds an update. */
export function onUpdateAvailable(fn: (version: string) => void): void {
  onAvailable = fn;
}

export async function checkForUpdates(): Promise<void> {
  if (!native) {
    message('Updates', 'Updates are available in the desktop app only.');
    return;
  }
  toast('Checking for updates…');
  const r = await native.updatesCheck();

  switch (r.state) {
    case 'unsupported':
      message(
        'Updates',
        `Version ${r.current}, running from source. Update with git pull and npm run build — ` +
          'in-app updates are for the installed app (Windows installer or Linux AppImage).',
      );
      return;
    case 'error':
      message('Updates', `Could not reach the update server.\n\n${r.error ?? ''}`);
      return;
    case 'none':
      message('Updates', `Version ${r.current} is the latest.`);
      return;
    case 'downloaded':
      offerRestart(r.version ?? '');
      return;
    case 'available':
      offerDownload(r);
      return;
  }
}

export async function checkForUpdatesQuietly(): Promise<void> {
  if (!native) return;
  let r: UpdateCheck;
  try {
    r = await native.updatesCheck();
  } catch {
    return; // offline at launch is not worth a dialog
  }
  if (r.state !== 'available' || !r.version) return;
  onAvailable?.(r.version);
  toast(`Version ${r.version} is available — click Update in the top bar.`, 'info', 8000);
}

function offerDownload(r: UpdateCheck): void {
  const notes = r.notes ? notesToText(r.notes) : '';
  const body = el('div', {}, [
    el('div', { text: `You have ${r.current}.` }),
    notes ? el('div', { class: 'update-notes', text: notes }) : null,
  ]);
  modal({
    title: `Version ${r.version} is available`,
    body,
    cancelLabel: 'Later',
    confirmLabel: 'Download',
    onConfirm: () => void download(r.version ?? ''),
  });
}

async function download(version: string): Promise<void> {
  const label = el('div', { text: 'Starting download…' });
  const close = modal({ title: 'Downloading update', body: label, cancelLabel: 'Hide' });
  const off = native!.onUpdateProgress((p) => {
    label.textContent = `${Math.round(p.percent)}% — ${mb(p.transferred)} of ${mb(p.total)}`;
  });
  const res = await native!.updatesDownload();
  off();
  close();
  if (!res.ok) {
    message('Update failed', res.error ?? 'The download did not complete.');
    return;
  }
  offerRestart(res.version || version);
}

function offerRestart(version: string): void {
  const what = version ? `Version ${version}` : 'The update';
  modal({
    title: 'Update ready',
    body: el('div', {
      text: `${what} has been downloaded. The app will close, install it and reopen. If you choose Later, it installs the next time you quit.`,
    }),
    cancelLabel: 'Later',
    confirmLabel: 'Restart now',
    onConfirm: async () => {
      // Restarting skips the unsaved-changes prompt, so refuse rather than
      // throw work away.
      if (app.dirty) {
        toast('Save the instrument first, then restart to update.', 'err', 5000);
        return;
      }
      const res = await native!.updatesInstall();
      if (!res.ok) message('Update failed', res.error ?? 'Could not start the installer.');
    },
  });
}

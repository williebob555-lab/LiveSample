// ============================================================================
// Project actions — import, open and save. None of these touch the layout;
// they work on the app state and report through toasts.
// ============================================================================

import { app, toast, progressModal } from './app';
import { importAudio, analyzeAll } from '../core/pipeline';
import { native, hasNative, baseName, pickFilesInBrowser } from '../core/native';
import { saveProject, loadProject, rememberProject, forgetProject } from '../core/project';
import { clearRecovery } from '../core/recovery';

export async function importFiles(): Promise<void> {
  if (hasNative && native) {
    const paths = await native.openAudio();
    if (!paths?.length) return;
    await ingestPaths(paths);
  } else {
    const files = await pickFilesInBrowser('audio/*', true);
    await ingestFiles(files);
  }
}

export async function importFolder(): Promise<void> {
  if (!hasNative || !native) {
    toast('Folder import needs the desktop app', 'err');
    return;
  }
  const paths = await native.openFolder();
  if (!paths?.length) return;
  await ingestPaths(paths);
}

async function ingestPaths(paths: string[]): Promise<void> {
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

async function ingestFiles(files: File[]): Promise<void> {
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

export async function saveAs(): Promise<void> {
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
  void clearRecovery();
  app.touch(false);
  toast('Saved');
}

export async function save(): Promise<void> {
  if (!app.projectPath) return saveAs();
  const prog = progressModal('Saving');
  await saveProject(app.instrument, app.projectPath, (d, t) => prog.update(d, t));
  prog.close();
  app.dirty = false;
  rememberProject(app.projectPath);
  void clearRecovery();
  app.touch(false);
  toast('Saved');
}

export async function open(): Promise<void> {
  if (!hasNative || !native) return toast('Opening needs the desktop app', 'err');
  const dir = await native.chooseDir('Open a .sinst folder');
  if (!dir) return;
  await openPath(dir);
}

/** Open a known project folder (Open, Open Recent, the welcome card). */
export async function openPath(dir: string): Promise<void> {
  if (!hasNative || !native) return toast('Opening needs the desktop app', 'err');
  // Recents outlive the folders they point at; say so and tidy the list
  // rather than showing a generic "not a project" error.
  if (!(await native.exists(await native.join(dir, 'instrument.json')))) {
    forgetProject(dir);
    app.touch(false);
    return toast(`${baseName(dir)} no longer exists — removed from recent projects`, 'err');
  }
  const prog = progressModal('Opening');
  const inst = await loadProject(dir, (d, t) => prog.update(d, t));
  prog.close();
  if (!inst) return toast('That folder is not a .sinst project', 'err');
  app.setInstrument(inst);
  app.projectPath = dir;
  rememberProject(dir);
  // Whatever was unsaved before this is gone now; a recovery copy of it
  // would only be offered back after the next crash, confusingly.
  void clearRecovery();
  toast(`Opened ${inst.name}`);
}

// ============================================================================
// Crash recovery.
//
//   <userData>/recovery/
//     project/          a normal .sinst folder, written by saveProject
//     marker.json       { originalPath, savedAt, name }
//
// The marker is written last, so a crash half-way through an autosave leaves a
// folder with no marker, which is treated as nothing to recover. The copy is
// removed by main on orderly exit and by the renderer on a successful save, so
// finding one at startup means the last run did not finish cleanly.
// ============================================================================

import type { Instrument } from './types';
import { native, hasNative } from './native';
import { saveProject, loadProject } from './project';

export interface RecoveryMarker {
  originalPath: string | null;
  savedAt: number;
  name: string;
}

const enc = new TextEncoder();

async function paths() {
  if (!hasNative || !native) return null;
  const root = await native.join(await native.userData(), 'recovery');
  return {
    root,
    project: await native.join(root, 'project'),
    marker: await native.join(root, 'marker.json'),
  };
}

/** Write a recovery copy. A no-op in a plain browser. */
export async function writeRecovery(
  instrument: Instrument,
  originalPath: string | null,
): Promise<void> {
  const p = await paths();
  if (!p || !native) return;
  // Start clean so samples deleted since the last autosave do not linger, and
  // so a partial write never leaves an old marker pointing at new content.
  await native.remove(p.root);
  // saveProject rewrites sample.path to the folder it writes to; do that to a
  // copy so the live instrument keeps pointing at the user's own files.
  await saveProject(structuredClone(instrument), p.project);
  const marker: RecoveryMarker = { originalPath, savedAt: Date.now(), name: instrument.name };
  await native.write(p.marker, enc.encode(JSON.stringify(marker)));
}

export async function clearRecovery(): Promise<void> {
  try {
    const p = await paths();
    if (p && native && (await native.exists(p.root))) await native.remove(p.root);
  } catch {
    /* nothing useful to do about a failed cleanup */
  }
}

export async function findRecovery(): Promise<RecoveryMarker | null> {
  try {
    const p = await paths();
    if (!p || !native || !(await native.exists(p.marker))) return null;
    const m = JSON.parse(new TextDecoder().decode(await native.read(p.marker))) as RecoveryMarker;
    return typeof m.savedAt === 'number' ? m : null;
  } catch {
    return null;
  }
}

export async function loadRecovery(
  onProgress?: (done: number, total: number) => void,
): Promise<Instrument | null> {
  const p = await paths();
  return p ? loadProject(p.project, onProgress) : null;
}

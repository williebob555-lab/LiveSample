// ============================================================================
// .sinst projects.
//
// A project is a folder, not a file:
//
//   MyPiano.sinst/
//     instrument.json     the model
//     samples/*.wav       the audio
//
// A folder rather than a zip because these run to hundreds of megabytes and
// repacking the whole archive on every save would make saving something you
// avoid doing. The zip only exists for sharing.
// ============================================================================

import type { Instrument } from './types';
import { sampleStore, SampleStore } from '../audio/store';
import { native, hasNative, baseName, downloadInBrowser } from './native';
import { encodeWav } from '../dsp/wav';
import { buildFileMap } from '../export/context';

export interface SaveResult {
  path: string | null;
  written: number;
}

const enc = new TextEncoder();

/** Write a project folder. `dir` should end in `.sinst` by convention. */
export async function saveProject(
  instrument: Instrument,
  dir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<SaveResult> {
  if (!hasNative || !native) {
    // Browser fallback: the model only. Audio stays in memory, which is enough
    // for UI work but is not a real save.
    downloadInBrowser('instrument.json', JSON.stringify(instrument, null, 2));
    return { path: null, written: 1 };
  }

  instrument.modifiedAt = Date.now();
  await native.mkdir(dir);
  await native.mkdir(await native.join(dir, 'samples'));

  const fileMap = buildFileMap(instrument);
  const total = instrument.samples.length + 1;
  let written = 0;

  for (const sample of instrument.samples) {
    const audio = sampleStore.get(sample.id);
    onProgress?.(written, total);
    if (!audio) continue;
    const rel = fileMap.get(sample.id) ?? `${sample.id}.wav`;
    const zone = instrument.groups.flatMap((g) => g.zones).find((z) => z.sampleId === sample.id);
    const data = encodeWav(audio.channels, audio.sampleRate, {
      bitDepth: 24,
      rootMidi: zone?.rootKey ?? sample.analysis.rootMidi ?? null,
      cents: zone ? zone.tuneCents : -(sample.analysis.cents ?? 0),
      loop:
        zone && zone.loop.mode !== 'off'
          ? { start: Math.round(zone.loop.start), end: Math.round(zone.loop.end) }
          : null,
    });
    await native.write(await native.join(dir, 'samples', rel), data);
    // The saved project references its own copy from now on.
    sample.path = await native.join(dir, 'samples', rel);
    written++;
  }

  await native.write(
    await native.join(dir, 'instrument.json'),
    enc.encode(JSON.stringify(instrument, null, 2)),
  );
  written++;
  onProgress?.(total, total);
  return { path: dir, written };
}

/** Read a project folder back, decoding every sample it references. */
export async function loadProject(
  dir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Instrument | null> {
  if (!hasNative || !native) return null;

  const jsonPath = await native.join(dir, 'instrument.json');
  if (!(await native.exists(jsonPath))) return null;

  const bytes = await native.read(jsonPath);
  const instrument = JSON.parse(new TextDecoder().decode(bytes)) as Instrument;
  if (!instrument || instrument.version !== 1) return null;

  sampleStore.clear();
  const total = instrument.samples.length;
  let done = 0;

  for (const sample of instrument.samples) {
    onProgress?.(done++, total);
    let path = sample.path;
    if (!path || !(await native.exists(path))) {
      // Relocate by name — projects get moved and copied, and a missing path
      // should not lose the audio when the file is sitting right there.
      const guess = await native.join(dir, 'samples', `${sample.name}.wav`);
      path = (await native.exists(guess)) ? guess : undefined;
    }
    if (!path) continue;
    try {
      const data = await native.read(path);
      const audio = await sampleStore.decode(data);
      sampleStore.set(sample.id, audio);
      sample.path = path;
      sample.frames = audio.frames;
    } catch {
      // A sample that will not decode should not stop the whole project from
      // opening; it shows as missing in the take list instead.
    }
  }
  onProgress?.(total, total);
  return instrument;
}

/** Everything the UI needs to offer "open recent" without a full load. */
export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}

const RECENTS_KEY = 'sampler.recents';

export function recentProjects(): RecentEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as RecentEntry[];
    return Array.isArray(list) ? list.filter((r) => r && typeof r.path === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberProject(path: string): void {
  const list = recentProjects().filter((r) => r.path !== path);
  list.unshift({ path, name: baseName(path).replace(/\.sinst$/i, ''), openedAt: Date.now() });
  saveRecents(list.slice(0, 12));
}

/** Drop an entry, e.g. when the folder it points at no longer exists. */
export function forgetProject(path: string): void {
  saveRecents(recentProjects().filter((r) => r.path !== path));
}

function saveRecents(list: RecentEntry[]): void {
  // Storage can be blocked or full; losing the recents list is not worth an
  // exception in the middle of a save.
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** Re-wrap raw channel data after an external edit, keeping ids stable. */
export function replaceAudio(
  sampleId: string,
  channels: Float32Array[],
  sampleRate: number,
): void {
  sampleStore.setProcessed(sampleId, SampleStore.wrap(channels, sampleRate));
}

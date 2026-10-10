import type { Instrument, Group, Zone, MicBus } from '../core/types';

/**
 * What every exporter is handed: the instrument, plus a resolver from sample id
 * to the relative path that sample will have in the written bundle. Exporters
 * never invent filenames themselves, so all targets in one export agree.
 */
export interface ExportContext {
  instrument: Instrument;
  fileFor(sampleId: string): string;
}

/**
 * Filesystem-safe, stable, human-readable names.
 * Readable names matter: the folder is part of the deliverable, and
 * `Rhodes_C3_v2_rr1.wav` tells you more than a hash ever will.
 */
export function sanitize(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 96) || 'sample'
  );
}

const NOTE_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];

export function noteFileName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * Build the id → filename map for a whole instrument.
 * Names encode note, velocity layer, round robin and mic so the folder reads as
 * an instrument even outside this app; collisions fall back to a counter.
 */
export function buildFileMap(instrument: Instrument): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  const base = sanitize(instrument.name).replace(/\s+/g, '_');

  for (const sample of instrument.samples) {
    const parts: string[] = [base];

    const zone = instrument.groups.flatMap((g) => g.zones).find((z) => z.sampleId === sample.id);
    const root = zone?.rootKey ?? sample.analysis.rootMidi ?? sample.capture.targetMidi;
    if (root != null) parts.push(noteFileName(root));

    if (sample.capture.velLayer != null) parts.push(`v${sample.capture.velLayer}`);
    if (sample.capture.rrIndex != null && sample.capture.rrIndex > 1)
      parts.push(`rr${sample.capture.rrIndex}`);

    const mic = instrument.mics.find((mm) => mm.id === sample.capture.micId);
    if (mic && instrument.mics.length > 1) parts.push(sanitize(mic.name).replace(/\s+/g, '_'));

    let name = parts.join('_');
    if (used.has(name.toLowerCase())) {
      let n = 2;
      while (used.has(`${name}_${n}`.toLowerCase())) n++;
      name = `${name}_${n}`;
    }
    used.add(name.toLowerCase());
    map.set(sample.id, `${name}.wav`);
  }
  return map;
}

export function makeContext(instrument: Instrument): ExportContext {
  const map = buildFileMap(instrument);
  return {
    instrument,
    fileFor: (id) => map.get(id) ?? `${id}.wav`,
  };
}

/**
 * Split a group's zones by mic, so exporters can emit one group per mic with
 * that mic's level on it. Muted mics are omitted entirely — a muted mic in the
 * app must not come back to life in the player. Zones with no mic (or a mic id
 * that no longer exists) form one unity-gain partition.
 */
export function micPartitions(
  inst: Instrument,
  group: Group,
): { mic: MicBus | null; zones: Zone[] }[] {
  const parts = new Map<string, { mic: MicBus | null; zones: Zone[] }>();
  for (const z of group.zones) {
    const mic = (z.micId && inst.mics.find((m) => m.id === z.micId)) || null;
    if (mic?.muted) continue;
    const key = mic?.id ?? '';
    const part = parts.get(key) ?? { mic, zones: [] };
    part.zones.push(z);
    parts.set(key, part);
  }
  return [...parts.values()];
}

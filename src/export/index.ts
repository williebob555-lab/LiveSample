// ============================================================================
// Export targets.
//
// Each target declares what it can and cannot carry, so the app can warn about
// what an export will drop *before* writing rather than leaving it to be
// discovered in the DAW. Every target is a lossy projection of the model; being
// explicit about the loss is the whole point of this registry.
// ============================================================================

import type { Instrument } from '../core/types';
import { makeContext, type ExportContext } from './context';
import { exportSfz } from './sfz';
import { exportDecentSampler } from './decentsampler';
import { encodeWav } from '../dsp/wav';

export type Capability =
  | 'keyRanges'
  | 'velocityLayers'
  | 'velocityCrossfade'
  | 'roundRobin'
  | 'articulations'
  | 'releaseTriggers'
  | 'chokeGroups'
  | 'loops'
  | 'loopCrossfade'
  | 'filters'
  | 'envelopes'
  | 'micBuses'
  | 'customUI';

export interface ExportTarget {
  id: string;
  name: string;
  /** Extension of the preset file, or null when the target is just audio. */
  extension: string | null;
  description: string;
  capabilities: Set<Capability>;
  render?: (ctx: ExportContext) => string;
}

const caps = (...c: Capability[]): Set<Capability> => new Set(c);

export const TARGETS: ExportTarget[] = [
  {
    id: 'sfz',
    name: 'SFZ',
    extension: '.sfz',
    description:
      'Open text format. The most capable target, and playable as a VST3 through sfizz.',
    capabilities: caps(
      'keyRanges',
      'velocityLayers',
      'velocityCrossfade',
      'roundRobin',
      'articulations',
      'releaseTriggers',
      'chokeGroups',
      'loops',
      'filters',
      'envelopes',
    ),
    render: exportSfz,
  },
  {
    id: 'decentsampler',
    name: 'DecentSampler',
    extension: '.dspreset',
    description: 'Free cross-platform player with a skinnable interface. Best for sharing.',
    capabilities: caps(
      'keyRanges',
      'velocityLayers',
      'roundRobin',
      'articulations',
      'releaseTriggers',
      'chokeGroups',
      'loops',
      'loopCrossfade',
      'envelopes',
      'customUI',
    ),
    render: exportDecentSampler,
  },
  {
    id: 'wav',
    name: 'WAV folder',
    extension: null,
    description:
      'Cleaned audio with root note, tuning and loop points written into each file. ' +
      'Ableton Sampler reads these when a folder is dropped onto its zone view, so this ' +
      'is also the Ableton path until native .adg writing lands.',
    capabilities: caps('keyRanges', 'loops'),
  },
];

/** What this target will silently discard about this particular instrument. */
export function exportWarnings(target: ExportTarget, inst: Instrument): string[] {
  const warnings: string[] = [];
  const has = (c: Capability) => target.capabilities.has(c);

  const rrGroups = inst.groups.filter(
    (g) => g.roundRobin !== 'off' && g.zones.some((z) => z.rrIndex > 1),
  );
  if (rrGroups.length && !has('roundRobin'))
    warnings.push('Round robins will collapse to a single take per zone.');

  const layers = new Set(inst.groups.flatMap((g) => g.zones.map((z) => `${z.velLow}-${z.velHigh}`)));
  if (layers.size > 1 && !has('velocityLayers'))
    warnings.push('Velocity layers will be flattened.');

  if (inst.groups.some((g) => g.velCrossfade > 0) && !has('velocityCrossfade'))
    warnings.push('Velocity crossfades will become hard boundaries.');

  if (inst.articulations.length > 1 && !has('articulations'))
    warnings.push('Only the first articulation will be exported.');

  if (inst.groups.some((g) => g.trigger === 'release') && !has('releaseTriggers'))
    warnings.push('Release-triggered groups will be dropped.');

  if (inst.groups.some((g) => g.chokeGroup > 0) && !has('chokeGroups'))
    warnings.push('Choke groups will be ignored — notes will not cut each other off.');

  if (inst.groups.some((g) => g.zones.some((z) => z.loop.mode !== 'off')) && !has('loops'))
    warnings.push('Loops will be dropped; long notes will stop at the end of the sample.');

  if (inst.groups.some((g) => g.filter.type !== 'off') && !has('filters'))
    warnings.push('Filter settings will be dropped.');

  if (inst.mics.length > 1 && !has('micBuses'))
    warnings.push(
      `${inst.mics.length} mic positions will be exported as separate zones rather than a blendable bus.`,
    );

  return warnings;
}

// ---------------------------------------------------------------------------
// Bundle writing
// ---------------------------------------------------------------------------

export interface AudioSource {
  /** Rendered, cleaned audio for a sample, ready to be written to disk. */
  get(sampleId: string): Promise<{ channels: Float32Array[]; sampleRate: number } | null>;
}

export interface WriteFile {
  /** Path relative to the export root. */
  path: string;
  data: Uint8Array;
}

export interface BundleOptions {
  targets: string[];
  bitDepth?: 16 | 24 | 32;
  /** Include the app's own instrument.json so the bundle round-trips. */
  includeProject?: boolean;
  onProgress?: (done: number, total: number, label: string) => void;
}

const enc = new TextEncoder();

/**
 * Produce every file an export consists of, in memory.
 * Writing them is the caller's job — Electron writes to disk, the browser
 * fallback zips them.
 */
export async function buildBundle(
  instrument: Instrument,
  audio: AudioSource,
  opts: BundleOptions,
): Promise<WriteFile[]> {
  const ctx = makeContext(instrument);
  const files: WriteFile[] = [];
  const bitDepth = opts.bitDepth ?? 24;

  // Zones tell us the root note and loop for each sample, which is what goes
  // into the smpl chunk. A sample used by several zones takes the first.
  const zoneFor = new Map<string, ReturnType<typeof firstZone>>();
  function firstZone(sampleId: string) {
    for (const g of instrument.groups) for (const z of g.zones) if (z.sampleId === sampleId) return z;
    return null;
  }
  for (const s of instrument.samples) zoneFor.set(s.id, firstZone(s.id));

  const total = instrument.samples.length + opts.targets.length;
  let done = 0;

  for (const sample of instrument.samples) {
    const rendered = await audio.get(sample.id);
    opts.onProgress?.(done++, total, sample.name);
    if (!rendered) continue;
    const zone = zoneFor.get(sample.id);
    const loop =
      zone && zone.loop.mode !== 'off'
        ? {
            start: Math.round(zone.loop.start),
            end: Math.round(zone.loop.end),
            type: zone.loop.mode === 'pingpong' ? ('pingpong' as const) : ('forward' as const),
          }
        : null;

    const data = encodeWav(rendered.channels, rendered.sampleRate, {
      bitDepth,
      rootMidi: zone?.rootKey ?? sample.analysis.rootMidi ?? sample.capture.targetMidi ?? null,
      cents: zone ? zone.tuneCents : -(sample.analysis.cents ?? 0),
      loop,
    });
    files.push({ path: `samples/${ctx.fileFor(sample.id)}`, data });
  }

  const safeName = instrument.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Instrument';
  for (const id of opts.targets) {
    const target = TARGETS.find((t) => t.id === id);
    opts.onProgress?.(done++, total, target?.name ?? id);
    if (!target?.render || !target.extension) continue;
    files.push({
      path: `${safeName}${target.extension}`,
      data: enc.encode(target.render(ctx)),
    });
  }

  if (opts.includeProject !== false) {
    files.push({
      path: 'instrument.json',
      data: enc.encode(JSON.stringify(instrument, null, 2)),
    });
  }

  files.push({ path: 'README.txt', data: enc.encode(readme(instrument, opts.targets)) });
  return files;
}

function readme(inst: Instrument, targets: string[]): string {
  const lines: string[] = [
    inst.name,
    '='.repeat(inst.name.length),
    '',
  ];
  if (inst.author) lines.push(`By ${inst.author}`, '');
  if (inst.description) lines.push(inst.description, '');

  const zoneCount = inst.groups.reduce((n, g) => n + g.zones.length, 0);
  lines.push(
    `${inst.samples.length} samples, ${zoneCount} zones, ${inst.groups.length} groups, ` +
      `${inst.articulations.length} articulation(s).`,
    '',
    'Contents',
    '--------',
    'samples/         The audio. Root note, tuning and loop points are written into',
    '                 each file, so these map themselves in most samplers.',
  );
  for (const id of targets) {
    const t = TARGETS.find((x) => x.id === id);
    if (t?.extension) lines.push(`*${t.extension.padEnd(16)}${t.description}`);
  }
  lines.push(
    'instrument.json  This app\'s own project data. Open it to keep editing.',
    '',
    'Ableton Live',
    '------------',
    'Drag the samples/ folder onto the zone view of a Sampler instance. Live reads the',
    'root note and loop from each file and lays the map out automatically.',
    '',
  );
  return lines.join('\n');
}

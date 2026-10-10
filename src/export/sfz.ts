// ============================================================================
// SFZ export.
//
// The primary target. SFZ is plain text, open, and expresses essentially
// everything the model holds — round robins, keyswitches, velocity crossfades,
// release triggers, choke groups, per-group filters and envelopes. It is also
// the route to a plugin: sfizz ships as a free VST3, so a good .sfz is a
// playable instrument in any DAW without writing a line of plugin code.
// ============================================================================

import type { Instrument, Group, Zone, Articulation } from '../core/types';
import type { ExportContext } from './context';

const fx = (n: number, digits = 3): string => {
  const r = Number(n.toFixed(digits));
  return Number.isFinite(r) ? String(r) : '0';
};

/** Opcodes shared by every region in a group. */
function groupOpcodes(group: Group, artic: Articulation | undefined, inst: Instrument): string[] {
  const ops: string[] = [];

  if (group.trigger === 'release') ops.push('trigger=release');
  else if (group.trigger === 'legato') ops.push('trigger=legato');

  if (group.chokeGroup > 0) {
    // In SFZ a region silences others via group/off_by sharing an id.
    ops.push(`group=${group.chokeGroup}`, `off_by=${group.chokeGroup}`, 'off_mode=fast');
  }

  if (group.gainDb !== 0) ops.push(`volume=${fx(group.gainDb)}`);
  if (group.pan !== 0) ops.push(`pan=${fx(group.pan * 100)}`);

  const e = group.ampEnv;
  ops.push(
    `ampeg_attack=${fx(e.attack)}`,
    `ampeg_decay=${fx(e.decay)}`,
    `ampeg_sustain=${fx(e.sustain * 100)}`,
    `ampeg_release=${fx(e.release)}`,
  );

  // amp_veltrack is a percentage: 100 is full velocity-to-level, 0 is flat.
  ops.push(`amp_veltrack=${fx(group.velToGain * 100)}`);

  if (group.filter.type !== 'off') {
    const type = group.filter.type === 'lowpass' ? 'lpf_2p' : group.filter.type === 'highpass' ? 'hpf_2p' : 'bpf_2p';
    ops.push(`fil_type=${type}`, `cutoff=${fx(group.filter.cutoff)}`, `resonance=${fx(group.filter.resonance)}`);
    if (group.filter.keyTrack !== 0) ops.push(`fil_keytrack=${Math.round(group.filter.keyTrack * 100)}`);
    if (group.filter.velAmount !== 0) ops.push(`fil_veltrack=${Math.round(group.filter.velAmount * 9600)}`);
    if (group.filter.envAmount !== 0) {
      const fe = group.filterEnv;
      ops.push(
        `fileg_depth=${Math.round(group.filter.envAmount * 1200)}`,
        `fileg_attack=${fx(fe.attack)}`,
        `fileg_decay=${fx(fe.decay)}`,
        `fileg_sustain=${fx(fe.sustain * 100)}`,
        `fileg_release=${fx(fe.release)}`,
      );
    }
  }

  // Articulation selection applies to every region in the group.
  if (artic) {
    const sel = artic.select;
    if (sel.mode === 'keyswitch') {
      const keys = inst.articulations
        .filter((a) => a.select.mode === 'keyswitch')
        .map((a) => (a.select as { mode: 'keyswitch'; key: number }).key);
      const lo = Math.min(...keys);
      const hi = Math.max(...keys);
      ops.push(`sw_lokey=${lo}`, `sw_hikey=${hi}`, `sw_last=${sel.key}`, `sw_label=${artic.name}`);
    } else if (sel.mode === 'cc') {
      ops.push(`locc${sel.cc}=${sel.low}`, `hicc${sel.cc}=${sel.high}`);
    }
    // 'velocity' selection is folded into each region's own lovel/hivel below.
  }

  return ops;
}

/** How many round-robin slots share this zone's key/velocity space. */
function rrCount(group: Group, zone: Zone): number {
  let n = 0;
  for (const z of group.zones)
    if (
      z.keyLow === zone.keyLow &&
      z.keyHigh === zone.keyHigh &&
      z.velLow === zone.velLow &&
      z.velHigh === zone.velHigh &&
      z.micId === zone.micId
    )
      n++;
  return n;
}

function zoneOpcodes(zone: Zone, group: Group, inst: Instrument, ctx: ExportContext): string[] {
  // Forward slashes: every current player (sfizz, sforzando, LinuxSampler)
  // accepts them on every OS, whereas backslashes only work where the player
  // happens to translate them.
  const ops: string[] = [`sample=${ctx.fileFor(zone.sampleId).replace(/\\/g, '/')}`];

  ops.push(`lokey=${zone.keyLow}`, `hikey=${zone.keyHigh}`, `pitch_keycenter=${zone.rootKey}`);

  // Fold a velocity-selected articulation into the region's velocity window.
  const artic = inst.articulations.find((a) => a.id === group.articulationId);
  let lovel = zone.velLow;
  let hivel = zone.velHigh;
  if (artic && artic.select.mode === 'velocity') {
    lovel = Math.max(lovel, artic.select.low);
    hivel = Math.min(hivel, artic.select.high);
  }
  ops.push(`lovel=${lovel}`, `hivel=${hivel}`);

  if (group.velCrossfade > 0) {
    const x = group.velCrossfade;
    if (lovel > 1) ops.push(`xfin_lovel=${Math.max(1, lovel - x)}`, `xfin_hivel=${lovel}`);
    if (hivel < 127) ops.push(`xfout_lovel=${hivel}`, `xfout_hivel=${Math.min(127, hivel + x)}`);
  }

  const total = rrCount(group, zone);
  if (total > 1 && group.roundRobin !== 'off') {
    if (group.roundRobin === 'sequential') {
      ops.push(`seq_length=${total}`, `seq_position=${zone.rrIndex}`);
    } else {
      // Random selection: each slot claims an equal slice of the 0..1 draw.
      const lo = (zone.rrIndex - 1) / total;
      const hi = zone.rrIndex / total;
      ops.push(`lorand=${fx(lo, 4)}`, `hirand=${fx(hi, 4)}`);
    }
  }

  if (zone.tuneCents !== 0) {
    // SFZ `tune` is limited to ±100 cents; anything beyond moves whole
    // semitones via transpose.
    const semis = Math.trunc(zone.tuneCents / 100);
    const rest = zone.tuneCents - semis * 100;
    if (semis !== 0) ops.push(`transpose=${semis}`);
    if (Math.abs(rest) > 0.01) ops.push(`tune=${Math.round(rest)}`);
  }
  if (zone.gainDb !== 0) ops.push(`volume=${fx(zone.gainDb)}`);
  if (zone.pan !== 0) ops.push(`pan=${fx(zone.pan * 100)}`);

  if (zone.startFrame > 0) ops.push(`offset=${Math.round(zone.startFrame)}`);
  const sample = inst.samples.find((s) => s.id === zone.sampleId);
  if (sample && zone.endFrame > 0 && zone.endFrame < sample.frames)
    ops.push(`end=${Math.round(zone.endFrame)}`);

  if (zone.loop.mode !== 'off') {
    const mode = zone.loop.mode === 'sustain' ? 'loop_sustain' : 'loop_continuous';
    ops.push(`loop_mode=${mode}`, `loop_start=${Math.round(zone.loop.start)}`, `loop_end=${Math.round(zone.loop.end)}`);
  } else {
    ops.push('loop_mode=no_loop');
  }

  return ops;
}

export function exportSfz(ctx: ExportContext): string {
  const inst = ctx.instrument;
  const lines: string[] = [];

  lines.push(`// ${inst.name}`);
  if (inst.author) lines.push(`// ${inst.author}`);
  if (inst.description) for (const l of inst.description.split('\n')) lines.push(`// ${l}`);
  lines.push(`// Generated ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');

  lines.push('<control>');
  lines.push('default_path=samples/');
  lines.push('');

  lines.push('<global>');
  const m = inst.master;
  if (m.gainDb !== 0) lines.push(`volume=${fx(m.gainDb)}`);
  if (m.tuneCents !== 0) lines.push(`tune=${Math.round(m.tuneCents)}`);
  lines.push(`bend_up=${m.bendRangeSemis * 100}`, `bend_down=${-m.bendRangeSemis * 100}`);
  if (m.polyphony > 0) lines.push(`polyphony=${m.polyphony}`);
  if (m.glideSeconds > 0) lines.push(`glis_rate=1`, `polyphony=1`);
  lines.push('');

  for (const group of inst.groups) {
    if (!group.zones.length) continue;
    const artic = inst.articulations.find((a) => a.id === group.articulationId);
    lines.push(`// ---- ${group.name}${artic ? ` (${artic.name})` : ''} ----`);
    lines.push('<group>');
    for (const op of groupOpcodes(group, artic, inst)) lines.push(op);
    lines.push('');

    // Sorting by key then velocity then round robin keeps generated files
    // diffable, which matters once these are in version control.
    const sorted = [...group.zones].sort(
      (a, b) => a.keyLow - b.keyLow || a.velLow - b.velLow || a.rrIndex - b.rrIndex,
    );
    for (const zone of sorted) {
      lines.push('<region>');
      for (const op of zoneOpcodes(zone, group, inst, ctx)) lines.push(op);
      lines.push('');
    }
  }

  return lines.join('\n');
}

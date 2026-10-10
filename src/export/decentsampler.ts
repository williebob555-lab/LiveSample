// ============================================================================
// DecentSampler (.dspreset) export.
//
// Less expressive than SFZ, but its player is free on every platform and the
// preset can carry a skinned interface — which makes it the right format for
// handing an instrument to someone else.
// ============================================================================

import type { Zone, Group, Articulation } from '../core/types';
import { micPartitions, type ExportContext } from './context';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fx = (n: number, d = 4): string => String(Number(n.toFixed(d)));

function sampleTag(
  zone: Zone,
  ctx: ExportContext,
  seqPosition: number | null,
  artic: Articulation | undefined,
): string {
  const inst = ctx.instrument;
  const sample = inst.samples.find((s) => s.id === zone.sampleId);
  const attrs: string[] = [
    `path="samples/${esc(ctx.fileFor(zone.sampleId))}"`,
    `rootNote="${zone.rootKey}"`,
    `loNote="${zone.keyLow}"`,
    `hiNote="${zone.keyHigh}"`,
  ];
  // A velocity-selected articulation is a velocity window; DecentSampler has no
  // other way to express it, so fold it into each sample like the SFZ exporter.
  let loVel = zone.velLow;
  let hiVel = zone.velHigh;
  if (artic?.select.mode === 'velocity') {
    loVel = Math.max(loVel, artic.select.low);
    hiVel = Math.min(hiVel, artic.select.high);
  }
  attrs.push(`loVel="${loVel}"`, `hiVel="${hiVel}"`);

  if (zone.startFrame > 0) attrs.push(`start="${Math.round(zone.startFrame)}"`);
  if (sample && zone.endFrame > 0 && zone.endFrame < sample.frames)
    attrs.push(`end="${Math.round(zone.endFrame)}"`);

  if (zone.loop.mode !== 'off') {
    attrs.push(
      'loopEnabled="true"',
      `loopStart="${Math.round(zone.loop.start)}"`,
      `loopEnd="${Math.round(zone.loop.end)}"`,
    );
    if (zone.loop.crossfade > 0) attrs.push(`loopCrossfade="${Math.round(zone.loop.crossfade)}"`);
  }

  if (zone.gainDb !== 0) attrs.push(`volume="${fx(zone.gainDb, 2)}dB"`);
  if (zone.pan !== 0) attrs.push(`pan="${fx(zone.pan * 100, 1)}"`);
  // DecentSampler tuning is in semitones, not cents.
  if (zone.tuneCents !== 0) attrs.push(`tuning="${fx(zone.tuneCents / 100)}"`);
  if (seqPosition != null) attrs.push(`seqPosition="${seqPosition}"`);

  return `      <sample ${attrs.join(' ')} />`;
}

/** Round-robin slots present in a group, so seqMode can be set correctly. */
function maxRr(group: Group): number {
  return group.zones.reduce((m, z) => Math.max(m, z.rrIndex), 1);
}

export function exportDecentSampler(ctx: ExportContext): string {
  const inst = ctx.instrument;
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<DecentSampler minVersion="1.11.0">`);
  out.push(`  <!-- ${esc(inst.name)}${inst.author ? ` — ${esc(inst.author)}` : ''} -->`);

  const usesRoundRobin = inst.groups.some((g) => g.roundRobin !== 'off' && maxRr(g) > 1);
  const seqMode =
    inst.groups.find((g) => g.roundRobin !== 'off' && maxRr(g) > 1)?.roundRobin === 'sequential'
      ? 'round_robin'
      : 'random';

  const groupsAttrs = [`volume="${fx(inst.master.gainDb, 2)}dB"`];
  if (usesRoundRobin) groupsAttrs.push(`seqMode="${seqMode}"`);
  out.push(`  <groups ${groupsAttrs.join(' ')}>`);

  for (const group of inst.groups) {
    if (!group.zones.length) continue;
    const artic = inst.articulations.find((a) => a.id === group.articulationId);
    const rr = maxRr(group);

    // DecentSampler switches whole groups, so each round-robin slot becomes its
    // own group rather than an attribute on the sample. Mics get the same
    // treatment: one group per mic carries that mic's level, so the mixer
    // survives as plain group volume. Muted mics are left out altogether.
    const slots = group.roundRobin !== 'off' && rr > 1 ? rr : 1;
    for (const part of micPartitions(inst, group)) {
      const micLabel = part.mic && inst.mics.length > 1 ? ` ${part.mic.name}` : '';
      for (let slot = 1; slot <= slots; slot++) {
        const zones = slots > 1 ? part.zones.filter((z) => z.rrIndex === slot) : part.zones;
        if (!zones.length) continue;

        const e = group.ampEnv;
        const attrs: string[] = [
          `name="${esc(group.name)}${esc(micLabel)}${slots > 1 ? ` ${slot}` : ''}"`,
          `attack="${fx(e.attack)}"`,
          `decay="${fx(e.decay)}"`,
          `sustain="${fx(e.sustain)}"`,
          `release="${fx(e.release)}"`,
        ];
        const volume = group.gainDb + (part.mic?.gainDb ?? 0);
        if (volume !== 0) attrs.push(`volume="${fx(volume, 2)}dB"`);
        const pan = Math.max(-1, Math.min(1, group.pan + (part.mic?.pan ?? 0)));
        if (pan !== 0) attrs.push(`pan="${fx(pan * 100, 1)}"`);
        if (slots > 1) attrs.push(`seqPosition="${slot}"`);
        if (group.trigger === 'release') attrs.push('trigger="release"');
        // One `tags` attribute only — a second would make the XML invalid.
        // Articulations are tags too; the midi section below enables the
        // matching tag from a keyswitch.
        const tags: string[] = [];
        if (group.chokeGroup > 0) tags.push(`choke${group.chokeGroup}`);
        if (artic && artic.select.mode === 'keyswitch') tags.push(`art_${artic.id}`);
        if (tags.length) attrs.push(`tags="${tags.join(',')}"`);
        if (group.chokeGroup > 0) attrs.push(`silencedByTags="choke${group.chokeGroup}"`);

        out.push(`    <group ${attrs.join(' ')}>`);
        const sorted = [...zones].sort((a, b) => a.keyLow - b.keyLow || a.velLow - b.velLow);
        for (const z of sorted) out.push(sampleTag(z, ctx, null, artic));
        out.push('    </group>');
      }
    }
  }
  out.push('  </groups>');

  // Keyswitch bindings: pressing the switch key enables its articulation's tag
  // and mutes the others.
  const keyswitched = inst.articulations.filter((a) => a.select.mode === 'keyswitch');
  if (keyswitched.length > 1) {
    out.push('  <midi>');
    for (const a of keyswitched) {
      const key = (a.select as { mode: 'keyswitch'; key: number }).key;
      out.push(`    <note note="${key}">`);
      for (const other of keyswitched) {
        out.push(
          `      <binding type="amp" level="tag" identifier="art_${other.id}" ` +
            `parameter="AMP_VOLUME" translation="fixed_value" ` +
            `translationValue="${other.id === a.id ? '1.0' : '0.0'}" />`,
        );
      }
      out.push('    </note>');
    }
    out.push('  </midi>');
  }

  // A minimal but real interface — a bare preset opens with no controls at all,
  // which reads as unfinished.
  out.push('  <ui width="812" height="200" bgColor="FF1A1A1A">');
  out.push('    <tab name="main">');
  out.push(
    '      <labeled-knob x="360" y="60" label="Volume" type="float" minValue="0" maxValue="1" value="0.8" ' +
      'textColor="FFDDDDDD" trackForegroundColor="FFCC8844" trackBackgroundColor="FF333333">',
  );
  out.push('        <binding type="amp" level="instrument" parameter="AMP_VOLUME" />');
  out.push('      </labeled-knob>');
  out.push('    </tab>');
  out.push('  </ui>');

  out.push('</DecentSampler>');
  return out.join('\n');
}

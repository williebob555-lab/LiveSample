// ============================================================================
// Voice selection — which zones a note should sound.
//
// Extracted so the Web Audio engine and the native (RtAudio) renderer share one
// implementation. Two engines with two copies of this logic would drift, and an
// audition that picks different samples than the export is worse than no
// audition at all.
// ============================================================================

import type { Instrument, Group, Zone, Articulation } from '../core/types';

export interface Selection {
  zone: Zone;
  group: Group;
}

/** Per-instance round-robin state. Kept outside the pure functions so each
 *  engine owns its own cycle position. */
export class RoundRobinState {
  private counters = new Map<string, number>();
  private last = new Map<string, number>();

  reset(): void {
    this.counters.clear();
    this.last.clear();
  }

  /** Pick one zone from a set of round-robin siblings. */
  pick(group: Group, siblings: Zone[], key: string): Zone {
    if (siblings.length === 1 || group.roundRobin === 'off') return siblings[0];
    const sorted = siblings;

    if (group.roundRobin === 'sequential') {
      const idx = (this.counters.get(key) ?? 0) % sorted.length;
      this.counters.set(key, idx + 1);
      return sorted[idx];
    }
    if (group.roundRobin === 'random') {
      return sorted[Math.floor(Math.random() * sorted.length)];
    }
    // randomNoRepeat — the default worth having. Plain random repeats often
    // enough to reintroduce the machine-gun effect round robins exist to fix.
    const previous = this.last.get(key);
    let idx: number;
    do {
      idx = Math.floor(Math.random() * sorted.length);
    } while (sorted.length > 1 && idx === previous);
    this.last.set(key, idx);
    return sorted[idx];
  }
}

/** The articulation a keyswitch selected, or the default. */
export function activeArticulation(
  inst: Instrument,
  activeId: string | null,
): Articulation | null {
  if (!inst.articulations.length) return null;
  if (activeId) {
    const found = inst.articulations.find((a) => a.id === activeId);
    if (found) return found;
  }
  return inst.articulations.find((a) => a.select.mode === 'always') ?? inst.articulations[0];
}

/** A keyswitch key selects an articulation and must not sound a note. */
export function keyswitchAt(inst: Instrument, key: number): Articulation | null {
  return (
    inst.articulations.find((a) => a.select.mode === 'keyswitch' && a.select.key === key) ?? null
  );
}

/** Whether a group is eligible given the current articulation and velocity. */
function groupEligible(
  inst: Instrument,
  group: Group,
  artic: Articulation | null,
  velocity: number,
): boolean {
  if (artic && group.articulationId === artic.id) return true;
  const sel = inst.articulations.find((a) => a.id === group.articulationId)?.select;
  if (!sel) return false;
  if (sel.mode === 'velocity') return velocity >= sel.low && velocity <= sel.high;
  return sel.mode === 'always';
}

/**
 * Every zone that should sound for a note, with round robins already resolved.
 *
 * Zones differing only by mic are *layered* (both sound); zones differing only
 * by rrIndex are *alternated* (one sounds). Getting that distinction wrong
 * either silences mic positions or plays every round robin at once.
 */
export function selectZones(
  inst: Instrument,
  rr: RoundRobinState,
  key: number,
  velocity: number,
  activeArticulationId: string | null,
  trigger: 'attack' | 'release' = 'attack',
): Selection[] {
  const artic = activeArticulation(inst, activeArticulationId);
  const out: Selection[] = [];

  for (const group of inst.groups) {
    if (group.trigger !== trigger) continue;
    if (!groupEligible(inst, group, artic, velocity)) continue;

    const matching = group.zones.filter(
      (z) => key >= z.keyLow && key <= z.keyHigh && velocity >= z.velLow && velocity <= z.velHigh,
    );
    if (!matching.length) continue;

    // Group by everything except the round-robin index.
    const byLayer = new Map<string, Zone[]>();
    for (const z of matching) {
      const k = `${z.micId ?? ''}|${z.keyLow}|${z.keyHigh}|${z.velLow}|${z.velHigh}`;
      const list = byLayer.get(k) ?? [];
      list.push(z);
      byLayer.set(k, list);
    }

    for (const [layerKey, siblings] of byLayer) {
      siblings.sort((a, b) => a.rrIndex - b.rrIndex);
      out.push({ zone: rr.pick(group, siblings, `${group.id}|${layerKey}`), group });
    }
  }
  return out;
}

/** Velocity 1..127 through the instrument's curve, normalised to 0..1. */
export function normalizeVelocity(inst: Instrument, velocity: number): number {
  const v = Math.max(1, Math.min(127, velocity)) / 127;
  return Math.pow(v, inst.master.velocityCurve);
}

/** Playback rate for a zone sounding at `key`, including all tuning. */
export function playbackRate(inst: Instrument, zone: Zone, key: number): number {
  const semis = key - zone.rootKey;
  const cents = zone.tuneCents + inst.master.tuneCents;
  return Math.pow(2, semis / 12) * Math.pow(2, cents / 1200);
}

/** Linear gain for a zone at a normalised velocity. */
export function voiceGain(zone: Zone, group: Group, vNorm: number): number {
  const velGain = 1 - group.velToGain + group.velToGain * vNorm;
  return Math.pow(10, (zone.gainDb + group.gainDb) / 20) * velGain;
}

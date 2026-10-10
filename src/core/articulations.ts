// ============================================================================
// Articulation editing, as pure operations on the instrument.
//
// Kept out of the UI so the rules (never delete the last articulation, never
// orphan a group, flag two articulations sharing a keyswitch) are testable
// without a DOM, and so every caller applies them identically.
// ============================================================================

import { newId, type Articulation, type ArticSelect, type Instrument, type Midi } from './types';

/** Lowest keyswitch octave sample libraries conventionally use (C0..B0). */
const KEYSWITCH_BASE: Midi = 24;

/** The first key from the conventional keyswitch zone not already taken. */
export function nextFreeKeyswitch(inst: Instrument): Midi {
  const used = new Set(
    inst.articulations.flatMap((a) => (a.select.mode === 'keyswitch' ? [a.select.key] : [])),
  );
  for (let k = KEYSWITCH_BASE; k < 128; k++) if (!used.has(k)) return k;
  return KEYSWITCH_BASE;
}

export function addArticulation(inst: Instrument, name = 'Articulation'): Articulation {
  // New articulations default to a keyswitch: 'always' would make the new one
  // sound on top of everything else, which is never what adding one means.
  const a: Articulation = {
    id: newId('art'),
    name,
    select: { mode: 'keyswitch', key: nextFreeKeyswitch(inst) },
  };
  inst.articulations.push(a);
  return a;
}

/** Defaults for switching an articulation to another select mode. */
export function defaultSelect(inst: Instrument, mode: ArticSelect['mode']): ArticSelect {
  switch (mode) {
    case 'always':
      return { mode };
    case 'keyswitch':
      return { mode, key: nextFreeKeyswitch(inst) };
    case 'cc':
      return { mode, cc: 1, low: 0, high: 127 };
    case 'velocity':
      return { mode, low: 1, high: 127 };
  }
}

/** Move by `dir` (-1 up, +1 down). Returns whether anything moved. */
export function moveArticulation(inst: Instrument, id: string, dir: -1 | 1): boolean {
  const i = inst.articulations.findIndex((a) => a.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= inst.articulations.length) return false;
  const arr = inst.articulations;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}

export function groupsOf(inst: Instrument, articulationId: string) {
  return inst.groups.filter((g) => g.articulationId === articulationId);
}

export function moveGroupTo(inst: Instrument, groupId: string, articulationId: string): void {
  const g = inst.groups.find((x) => x.id === groupId);
  if (g && inst.articulations.some((a) => a.id === articulationId)) g.articulationId = articulationId;
}

/**
 * Delete an articulation. Its groups must go somewhere: pass `moveTo` to
 * reassign them, or null to delete them (samples stay in the pool, so the
 * takes are not lost — only their mapping). Refuses to delete the last one.
 */
export function deleteArticulation(
  inst: Instrument,
  id: string,
  moveTo: string | null,
): { ok: boolean; groupsAffected: number } {
  const fail = { ok: false, groupsAffected: 0 };
  if (inst.articulations.length <= 1) return fail;
  if (!inst.articulations.some((a) => a.id === id)) return fail;
  if (moveTo !== null && (moveTo === id || !inst.articulations.some((a) => a.id === moveTo)))
    return fail;

  const owned = groupsOf(inst, id);
  if (moveTo !== null) for (const g of owned) g.articulationId = moveTo;
  else inst.groups = inst.groups.filter((g) => g.articulationId !== id);

  inst.articulations = inst.articulations.filter((a) => a.id !== id);
  // The capture plan remembers an articulation id; point it somewhere real.
  if (inst.capture && inst.capture.articulationId === id)
    inst.capture.articulationId = moveTo ?? inst.articulations[0].id;
  return { ok: true, groupsAffected: owned.length };
}

/** Human-readable problems with the current setup, shown in the editor. */
export function articulationIssues(inst: Instrument): string[] {
  const out: string[] = [];
  const seen = new Map<number, string>();
  for (const a of inst.articulations) {
    if (a.select.mode === 'keyswitch') {
      const prev = seen.get(a.select.key);
      if (prev) out.push(`"${a.name}" and "${prev}" share a keyswitch key.`);
      else seen.set(a.select.key, a.name);
    }
    if ((a.select.mode === 'cc' || a.select.mode === 'velocity') && a.select.low > a.select.high)
      out.push(`"${a.name}" has an inverted ${a.select.mode === 'cc' ? 'CC' : 'velocity'} range.`);
  }
  return out;
}

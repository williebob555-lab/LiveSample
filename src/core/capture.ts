// ============================================================================
// Capture planning.
//
// Kept out of the UI so it can be tested: the step matrix and the retake logic
// are where an off-by-one costs you a whole recording session.
// ============================================================================

import type { CapturePlan, CaptureStep, Instrument, Sample, Midi } from './types';
import { planNotes } from './automap';

/** A plan whose ids point at things that exist in this instrument. */
export function defaultCapturePlan(inst: Instrument): CapturePlan {
  return {
    lowNote: 48,
    highNote: 72,
    step: 3,
    velocityLayers: 1,
    roundRobins: 1,
    articulationId: inst.articulations[0]?.id ?? '',
    micIds: [inst.mics[0]?.id ?? ''],
    silenceTimeout: 0.6,
    onsetThresholdDb: 12,
    referenceTone: false,
    referenceSource: 'recorded',
    referencePreset: 'piano',
  };
}

/**
 * Repair a plan loaded from disk.
 *
 * Articulation and mic ids are per-instrument, so a plan that outlived an edit
 * to either can reference something gone. Silently capturing into a dangling
 * articulation would produce takes that never map, so anything missing falls
 * back to the instrument's first.
 */
export function normalizeCapturePlan(inst: Instrument, plan?: CapturePlan | null): CapturePlan {
  const base = defaultCapturePlan(inst);
  if (!plan) return base;

  const clampNote = (n: unknown, fallback: Midi): Midi =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(127, Math.round(n))) : fallback;

  const low = clampNote(plan.lowNote, base.lowNote);
  const high = clampNote(plan.highNote, base.highNote);

  const articulationId = inst.articulations.some((a) => a.id === plan.articulationId)
    ? plan.articulationId
    : base.articulationId;

  const micIds = (plan.micIds ?? []).filter((id) => inst.mics.some((m) => m.id === id));

  return {
    lowNote: Math.min(low, high),
    highNote: Math.max(low, high),
    step: Math.max(1, Math.min(12, Math.round(plan.step ?? base.step))),
    velocityLayers: Math.max(1, Math.min(8, Math.round(plan.velocityLayers ?? 1))),
    roundRobins: Math.max(1, Math.min(8, Math.round(plan.roundRobins ?? 1))),
    articulationId,
    micIds: micIds.length ? micIds : base.micIds,
    silenceTimeout: Math.max(0.1, Math.min(5, plan.silenceTimeout ?? base.silenceTimeout)),
    onsetThresholdDb: Math.max(3, Math.min(40, plan.onsetThresholdDb ?? base.onsetThresholdDb)),
    referenceTone: !!plan.referenceTone,
    referenceSource: plan.referenceSource === 'preset' ? 'preset' : 'recorded',
    referencePreset: plan.referencePreset || base.referencePreset,
  };
}

/** The full matrix a session walks: notes x layers x round robins x mics. */
export function buildSteps(plan: CapturePlan): CaptureStep[] {
  const steps: CaptureStep[] = [];
  const mics = plan.micIds.length ? plan.micIds : [''];
  let index = 0;
  for (const midi of planNotes(plan.lowNote, plan.highNote, plan.step))
    for (let velLayer = 1; velLayer <= plan.velocityLayers; velLayer++)
      for (let rrIndex = 1; rrIndex <= plan.roundRobins; rrIndex++)
        for (const micId of mics)
          steps.push({
            index: index++,
            midi,
            velLayer,
            rrIndex,
            micId,
            articulationId: plan.articulationId,
          });
  return steps;
}

/**
 * Mic is only a distinguishing dimension when there is more than one.
 *
 * With a single mic, an imported take carrying no mic id and a captured take
 * carrying the default one are the same slot. Treating them as different is how
 * a re-record silently appends a duplicate instead of replacing.
 */
function micKey(micId: string | undefined, plan?: CapturePlan): string {
  if (!plan || !Array.isArray(plan.micIds) || plan.micIds.length <= 1) return '';
  return micId ?? '';
}

/** What a step is keyed by. Two takes with the same identity are the same slot. */
export function stepIdentity(
  step: {
    midi?: number;
    velLayer?: number;
    rrIndex?: number;
    micId?: string;
    articulationId?: string;
  },
  plan?: CapturePlan,
): string {
  return [
    step.midi ?? -1,
    step.velLayer ?? 1,
    step.rrIndex ?? 1,
    micKey(step.micId, plan),
    step.articulationId ?? '',
  ].join('|');
}

export function sampleIdentity(sample: Sample, plan?: CapturePlan): string {
  const c = sample.capture;
  return stepIdentity(
    {
      midi: c.targetMidi ?? sample.analysis.rootMidi ?? -1,
      velLayer: c.velLayer,
      rrIndex: c.rrIndex,
      micId: c.micId,
      articulationId: c.articulationId,
    },
    plan,
  );
}

/**
 * Steps that re-record exactly the given takes, in pitch order.
 *
 * Ordering matters: a retake session that jumps around the keyboard is harder
 * to play than one that walks up it, and you are holding the instrument.
 */
export function buildRetakeSteps(samples: Sample[], plan: CapturePlan): CaptureStep[] {
  const steps: CaptureStep[] = [];
  const seen = new Set<string>();

  for (const s of samples) {
    const midi = s.capture.targetMidi ?? s.analysis.rootMidi;
    if (midi == null) continue;
    const step: CaptureStep = {
      index: 0,
      midi,
      velLayer: s.capture.velLayer ?? 1,
      rrIndex: s.capture.rrIndex ?? 1,
      micId: s.capture.micId ?? (plan.micIds.length > 1 ? (plan.micIds[0] ?? '') : ''),
      articulationId: s.capture.articulationId ?? plan.articulationId,
    };
    const key = stepIdentity(step, plan);
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(step);
  }

  steps.sort((a, b) => a.midi - b.midi || a.velLayer - b.velLayer || a.rrIndex - b.rrIndex);
  steps.forEach((s, i) => {
    s.index = i;
  });
  return steps;
}

/**
 * Steps for slots the plan asks for but nothing has been recorded into yet.
 * The "finish the session you abandoned" path.
 */
export function buildMissingSteps(plan: CapturePlan, samples: Sample[]): CaptureStep[] {
  const have = new Set(samples.map((s) => sampleIdentity(s, plan)));
  return buildSteps(plan)
    .filter((s) => !have.has(stepIdentity(s, plan)))
    .map((s, i) => ({ ...s, index: i }));
}

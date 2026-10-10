// ============================================================================
// Self-test for the DSP and export layers.
//
// These are the parts that have to be right and that a screenshot cannot check:
// if pitch detection is off by an octave, or the smpl chunk is malformed, or a
// key range is computed wrong, the instrument is broken in a way you would only
// discover in the DAW.
//
//   npm run selftest
// ============================================================================

import { encodeWav, decodeWav } from '../src/dsp/wav';
import { detectPitch, midiToHz, midiName, parseNote } from '../src/dsp/pitch';
import { splitOnSilence, levelStats, findOnsetAndTail, toMono } from '../src/dsp/analyze';
import { findLoop } from '../src/dsp/loop';
import { repitch } from '../src/dsp/resample';
import { autoMap, planNotes, findGaps, maxStretch } from '../src/core/automap';
import { createInstrument, createGroup, defaultLoop, newId, type Sample, type Zone } from '../src/core/types';
import { denoiseChannel } from '../src/dsp/denoise';
import { FFT, hann } from '../src/dsp/fft';
import { RoundRobinState, selectZones, micGain } from '../src/audio/select';
import {
  addArticulation,
  deleteArticulation,
  moveArticulation,
  moveGroupTo,
  articulationIssues,
} from '../src/core/articulations';
import { exportWarnings, TARGETS } from '../src/export';
import {
  defaultCapturePlan,
  normalizeCapturePlan,
  buildSteps,
  buildRetakeSteps,
  buildMissingSteps,
  sampleIdentity,
  stepIdentity,
} from '../src/core/capture';
import { History } from '../src/core/history';
import {
  parseMidiMessage,
  channelMatches,
  layerVelocity,
  midiTakeFinished,
  midiOnsetTimedOut,
  midiNoteOnBytes,
  midiNoteOffBytes,
  midiAllNotesOffBytes,
} from '../src/core/midi';
import { makeContext } from '../src/export/context';
import { exportSfz } from '../src/export/sfz';
import { exportDecentSampler } from '../src/export/decentsampler';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function group(name: string): void {
  console.log(`\n${name}`);
}

const SR = 48000;

/** A note with harmonics and a decaying envelope — closer to a real take than
 *  a bare sine, and much harder for a pitch detector. */
function synthNote(midi: number, seconds: number, sampleRate = SR): Float32Array {
  const hz = midiToHz(midi);
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  const partials = [1, 0.5, 0.32, 0.18, 0.1, 0.06];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t / 0.01) * Math.exp(-t * 1.6);
    let s = 0;
    for (let p = 0; p < partials.length; p++) {
      s += partials[p] * Math.sin(2 * Math.PI * hz * (p + 1) * t);
    }
    out[i] = (s / 2.2) * env;
  }
  return out;
}

// ---------------------------------------------------------------------------

group('WAV codec');
{
  const left = synthNote(60, 0.5);
  const right = synthNote(60, 0.5);
  const bytes = encodeWav([left, right], SR, {
    bitDepth: 24,
    rootMidi: 60,
    cents: -13.5,
    loop: { start: 1000, end: 9000 },
  });
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const back = decodeWav(buf);

  check('round-trips channel count', back.channels.length === 2);
  check('round-trips sample rate', back.sampleRate === SR);
  check('round-trips frame count', back.frames === left.length, `${back.frames} vs ${left.length}`);

  let maxErr = 0;
  for (let i = 0; i < left.length; i++) maxErr = Math.max(maxErr, Math.abs(back.channels[0][i] - left[i]));
  check('24-bit error below 1e-5', maxErr < 1e-5, `max error ${maxErr.toExponential(2)}`);

  // Negative cents are stored as the semitone below plus a positive fraction.
  const effective = (back.rootMidi ?? 0) + (back.cents ?? 0) / 100;
  check('smpl root+cents survives', Math.abs(effective - (60 - 0.135)) < 0.01, `got ${effective.toFixed(4)}`);
  check('smpl loop start survives', back.loops[0]?.start === 1000, String(back.loops[0]?.start));
  check('smpl loop end survives', back.loops[0]?.end === 9000, String(back.loops[0]?.end));

  const noRoot = encodeWav([left], SR, { bitDepth: 16 });
  const backNoRoot = decodeWav(
    noRoot.buffer.slice(noRoot.byteOffset, noRoot.byteOffset + noRoot.byteLength) as ArrayBuffer,
  );
  check('omits smpl when root unknown', backNoRoot.rootMidi === undefined);
  check('16-bit decodes', backNoRoot.frames === left.length);
}

group('Pitch detection');
{
  // Across the range an instrument builder actually samples.
  for (const midi of [33, 40, 48, 55, 60, 67, 72, 79, 84]) {
    const sig = synthNote(midi, 1.2);
    const r = detectPitch(sig, SR);
    check(
      `detects ${midiName(midi)} (${midi})`,
      r.midi === midi,
      `got ${r.midi != null ? midiName(r.midi) : 'null'} conf ${r.confidence.toFixed(2)}`,
    );
  }

  // Detuned input should report the offset, not silently round it away.
  const detuned = synthNote(60.25, 1.2);
  const rd = detectPitch(detuned, SR);
  check('reports cents offset', rd.midi === 60 && Math.abs(rd.cents - 25) < 8, `cents ${rd.cents.toFixed(1)}`);

  // Noise must not be reported as a confident pitch.
  const noise = new Float32Array(SR);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.3;
  const rn = detectPitch(noise, SR);
  check('noise yields low confidence', rn.confidence < 0.6, `conf ${rn.confidence.toFixed(2)}`);
}

group('Level and onset');
{
  const sig = new Float32Array(SR * 2);
  const note = synthNote(60, 0.8);
  sig.set(note, Math.floor(SR * 0.5));
  for (let i = 0; i < sig.length; i++) sig[i] += (Math.random() * 2 - 1) * 0.0004;

  const { onsetFrame, tailFrame } = findOnsetAndTail(sig, SR);
  check('onset lands just before the note', onsetFrame <= SR * 0.5 && onsetFrame > SR * 0.45, `frame ${onsetFrame}`);
  check('onset keeps pre-roll', onsetFrame < SR * 0.5, 'must not clip the transient');
  check('tail is after the note starts', tailFrame > SR * 0.5, `frame ${tailFrame}`);

  const stats = levelStats(sig);
  check('peak is sane', stats.peakDb < 0 && stats.peakDb > -12, `${stats.peakDb.toFixed(1)} dB`);
  check('noise floor found', stats.noiseFloorDb < -40, `${stats.noiseFloorDb.toFixed(1)} dB`);
  check('no false clip report', !stats.clipped);
}

group('Silence splitting');
{
  // Five notes separated by a second of near-silence.
  const total = SR * 12;
  const sig = new Float32Array(total);
  const notes = [60, 62, 64, 65, 67];
  notes.forEach((midi, i) => {
    const note = synthNote(midi, 1.0);
    sig.set(note, Math.floor(SR * (0.5 + i * 2.2)));
  });
  for (let i = 0; i < total; i++) sig[i] += (Math.random() * 2 - 1) * 0.0003;

  const regions = splitOnSilence(sig, SR, { minSilenceMs: 300 });
  check('finds every note', regions.length === notes.length, `found ${regions.length}`);

  if (regions.length === notes.length) {
    let correct = 0;
    regions.forEach((r, i) => {
      const slice = sig.subarray(r.start, r.end);
      const p = detectPitch(slice, SR);
      if (p.midi === notes[i]) correct++;
    });
    check('each region detects its own pitch', correct === notes.length, `${correct}/${notes.length}`);
  }
}

group('Loop finding');
{
  // A steady tone: the loop should lock to whole periods of the fundamental.
  const hz = midiToHz(57);
  const n = SR * 3;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    sig[i] =
      (Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(4 * Math.PI * hz * t)) *
      0.4 *
      Math.min(1, t / 0.02);
  }
  const loop = findLoop(sig, SR, { fundamentalHz: hz });
  check('finds a loop in steady tone', loop !== null);
  if (loop) {
    check('loop scores well', loop.score > 0.9, `score ${loop.score.toFixed(3)}`);
    check('loop is inside the signal', loop.end <= n && loop.start >= 0);
    const periods = (loop.end - loop.start) / (SR / hz);
    check('loop is a whole number of periods', Math.abs(periods - Math.round(periods)) < 0.05,
      `${periods.toFixed(3)} periods`);
    check('crossfade fits before the loop', loop.crossfade <= loop.start);
  }

  // Noise has no periodicity to lock to and should be rejected.
  const noise = new Float32Array(SR * 2);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.4;
  const noLoop = findLoop(noise, SR, { fundamentalHz: null });
  check('rejects loop in noise', noLoop === null || noLoop.score < 0.7,
    noLoop ? `score ${noLoop.score.toFixed(2)}` : 'null');
}

group('Repitch');
{
  const source = synthNote(60, 1.0);
  for (const semis of [-4, -1, 3, 7]) {
    const [out] = repitch([source], semis);
    const expectedLen = Math.floor(source.length / Math.pow(2, semis / 12));
    check(
      `repitch ${semis > 0 ? '+' : ''}${semis} length`,
      Math.abs(out.length - expectedLen) <= 1,
      `${out.length} vs ${expectedLen}`,
    );
    const r = detectPitch(out, SR);
    check(
      `repitch ${semis > 0 ? '+' : ''}${semis} pitch`,
      r.midi === 60 + semis,
      `got ${r.midi != null ? midiName(r.midi) : 'null'}`,
    );
  }
}

group('Auto-mapping');
{
  const inst = createInstrument('Test Instrument');
  const roots = [48, 51, 54, 57, 60];
  inst.samples = roots.map((midi, i) => {
    const s: Sample = {
      id: `smp_${i}`,
      name: `${midiName(midi)}`,
      sampleRate: SR,
      channels: 1,
      frames: SR,
      analysis: { rootMidi: midi, cents: 7, confidence: 0.95, onsetFrame: 0, tailFrame: SR },
      capture: { targetMidi: midi, velLayer: 1, rrIndex: 1 },
    };
    return s;
  });

  const group0 = inst.groups[0];
  const zones = autoMap(inst.samples, group0, { velocityLayers: 1 });
  check('one zone per sample', zones.length === roots.length, `${zones.length}`);

  const sorted = [...zones].sort((a, b) => a.rootKey - b.rootKey);
  check('lowest zone extends to key 0', sorted[0].keyLow === 0);
  check('highest zone extends to key 127', sorted[sorted.length - 1].keyHigh === 127);

  // Boundaries must meet exactly: no overlaps and no gaps.
  let contiguous = true;
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].keyLow !== sorted[i - 1].keyHigh + 1) contiguous = false;
  check('key ranges are contiguous', contiguous);

  const mid = sorted[1];
  check('range splits at the midpoint', mid.keyLow === 50 && mid.keyHigh === 52,
    `${mid.keyLow}-${mid.keyHigh}`);
  check('tunes away the detected offset', Math.abs(sorted[0].tuneCents + 7) < 0.001,
    `${sorted[0].tuneCents}`);
  check('no gaps remain', findGaps(inst).length === 0);
  // Roots are 3 semitones apart, so nothing inside the sampled span should ever
  // stretch more than 2. The extended edge tails must not inflate this.
  check('max stretch ignores extended edges', maxStretch(inst) <= 2, `${maxStretch(inst)}`);

  // Velocity layers.
  const layered = createInstrument('Layered');
  layered.samples = [];
  for (const midi of [60, 64]) {
    for (let layer = 1; layer <= 3; layer++) {
      layered.samples.push({
        id: `s_${midi}_${layer}`,
        name: `${midiName(midi)}_v${layer}`,
        sampleRate: SR,
        channels: 1,
        frames: SR,
        analysis: { rootMidi: midi, cents: 0, confidence: 0.9, onsetFrame: 0, tailFrame: SR },
        capture: { targetMidi: midi, velLayer: layer, rrIndex: 1 },
      });
    }
  }
  const lz = autoMap(layered.samples, layered.groups[0], { velocityLayers: 3 });
  check('layered map has every zone', lz.length === 6, `${lz.length}`);
  const vRanges = [...new Set(lz.map((z) => `${z.velLow}-${z.velHigh}`))].sort();
  check('three distinct velocity bands', vRanges.length === 3, vRanges.join(' '));
  const covers = new Set<number>();
  for (const z of lz) for (let v = z.velLow; v <= z.velHigh; v++) covers.add(v);
  check('velocity 1..127 fully covered', covers.size === 127, `${covers.size}`);

  check('planNotes includes the top note', planNotes(48, 60, 5).includes(60));
  check('planNotes respects the step', planNotes(48, 60, 4).join(',') === '48,52,56,60');
}

group('Export');
{
  const inst = createInstrument('Export Test');
  inst.author = 'Self test';
  const g = inst.groups[0];
  g.roundRobin = 'sequential';
  inst.samples = [];
  for (const midi of [60, 64]) {
    for (let rr = 1; rr <= 2; rr++) {
      inst.samples.push({
        id: `s_${midi}_${rr}`,
        name: `${midiName(midi)}_rr${rr}`,
        sampleRate: SR,
        channels: 1,
        frames: SR,
        analysis: { rootMidi: midi, cents: 0, confidence: 0.9, onsetFrame: 0, tailFrame: SR },
        capture: { targetMidi: midi, velLayer: 1, rrIndex: rr },
      });
    }
  }
  autoMap(inst.samples, g, { velocityLayers: 1 });
  g.zones[0].loop = { mode: 'forward', start: 100, end: 5000, crossfade: 0 };

  const ctx = makeContext(inst);
  const sfz = exportSfz(ctx);

  check('sfz declares a control block', sfz.includes('<control>'));
  check('sfz sets default_path', sfz.includes('default_path=samples/'));
  check('sfz has a region per zone', (sfz.match(/<region>/g) ?? []).length === g.zones.length,
    `${(sfz.match(/<region>/g) ?? []).length} vs ${g.zones.length}`);
  check('sfz writes key centers', sfz.includes('pitch_keycenter=60'));
  check('sfz writes round robins', sfz.includes('seq_length=2') && sfz.includes('seq_position=1'));
  check('sfz writes the loop', sfz.includes('loop_mode=loop_continuous') && sfz.includes('loop_start=100'));
  check('sfz writes amp envelope', sfz.includes('ampeg_release='));
  check('sfz references real filenames', sfz.includes('.wav'));

  // Filenames must be unique or samples overwrite each other on disk.
  const names = inst.samples.map((s) => ctx.fileFor(s.id));
  check('export filenames are unique', new Set(names).size === names.length, names.join(', '));
  // midi 60 is C4 in this app's naming (octave = floor(midi/12) - 1).
  check('filenames carry the note', names.every((n) => /_C4|_E4/.test(n)), names.join(', '));

  const ds = exportDecentSampler(ctx);
  check('dspreset is well-formed xml', ds.startsWith('<?xml') && ds.trim().endsWith('</DecentSampler>'));
  check('dspreset has groups', ds.includes('<groups') && ds.includes('</groups>'));
  check('dspreset splits round robins into groups', (ds.match(/<group /g) ?? []).length === 2,
    `${(ds.match(/<group /g) ?? []).length}`);
  check('dspreset sets seqMode', ds.includes('seqMode="round_robin"'));
  check('dspreset writes rootNote', ds.includes('rootNote="60"'));
  check('dspreset escapes nothing unexpected', !ds.includes('undefined') && !ds.includes('NaN'));
  check('sfz has no undefined values', !sfz.includes('undefined') && !sfz.includes('NaN'));
}

group('Note names');
{
  check('midiName anchors middle C at C4', midiName(60) === 'C4', midiName(60));
  check('midiName handles the bottom octave', midiName(0) === 'C-1', midiName(0));
  check('midiName handles sharps', midiName(61) === 'C#4', midiName(61));

  // Every note must survive name → parse → name unchanged, or edits corrupt
  // pitches silently.
  let roundTrips = 0;
  for (let m = 0; m <= 127; m++) if (parseNote(midiName(m)) === m) roundTrips++;
  check('all 128 notes round-trip', roundTrips === 128, `${roundTrips}/128`);

  check('parses flats', parseNote('Bb3') === 58, String(parseNote('Bb3')));
  check('parses lowercase', parseNote('c4') === 60, String(parseNote('c4')));
  check('parses s-for-sharp', parseNote('Fs2') === 42, String(parseNote('Fs2')));
  check('parses negative octaves', parseNote('A-1') === 9, String(parseNote('A-1')));
  check('accepts a bare midi number', parseNote('64') === 64, String(parseNote('64')));
  check('rejects nonsense', parseNote('hello') === null);
  check('rejects out-of-range names', parseNote('C12') === null, String(parseNote('C12')));
  check('rejects empty input', parseNote('  ') === null);
  check('rejects a bad accidental', parseNote('H#3') === null);
}

group('Capture planning');
{
  const inst = createInstrument('Capture Test');
  const plan = defaultCapturePlan(inst);
  plan.lowNote = 48;
  plan.highNote = 60;
  plan.step = 3;
  plan.velocityLayers = 2;
  plan.roundRobins = 2;

  const steps = buildSteps(plan);
  // 5 notes (48,51,54,57,60) x 2 layers x 2 round robins.
  check('step matrix is notes x layers x round robins', steps.length === 20, String(steps.length));
  check('steps are indexed from zero', steps[0].index === 0 && steps[19].index === 19);
  check('every step carries the articulation', steps.every((x) => x.articulationId === plan.articulationId));
  check('covers the top note', steps.some((x) => x.midi === 60));

  const ids = new Set(steps.map((x) => stepIdentity(x, plan)));
  check('every step is a distinct slot', ids.size === steps.length, `${ids.size}/${steps.length}`);

  // A plan that outlived an edit to its articulation must not capture into a
  // dangling id — those takes would never map.
  const stale = { ...plan, articulationId: 'gone', micIds: ['gone'], step: 99, velocityLayers: 0 };
  const fixed = normalizeCapturePlan(inst, stale);
  check('repairs a dangling articulation', fixed.articulationId === inst.articulations[0].id);
  check('repairs dangling mics', fixed.micIds[0] === inst.mics[0].id);
  check('clamps an absurd step', fixed.step === 12, String(fixed.step));
  check('clamps layers to at least one', fixed.velocityLayers === 1, String(fixed.velocityLayers));

  const swapped = normalizeCapturePlan(inst, { ...plan, lowNote: 80, highNote: 40 });
  check('orders a reversed range', swapped.lowNote === 40 && swapped.highNote === 80,
    `${swapped.lowNote}-${swapped.highNote}`);
  check('falls back when there is no plan', normalizeCapturePlan(inst, null).step === 3);

  // Retakes.
  const takes: Sample[] = [60, 48, 55].map((midi, i) => ({
    id: 'r' + i,
    name: midiName(midi),
    sampleRate: SR,
    channels: 1,
    frames: SR,
    analysis: { rootMidi: midi, cents: 0, confidence: 0.9 },
    capture: { targetMidi: midi, velLayer: 1, rrIndex: 1, articulationId: plan.articulationId },
  }));

  const retake = buildRetakeSteps(takes, plan);
  check('one retake step per take', retake.length === 3, String(retake.length));
  check('retakes walk up the keyboard', retake.map((x) => x.midi).join(',') === '48,55,60',
    retake.map((x) => x.midi).join(','));
  check('retake steps are re-indexed', retake.every((x, i) => x.index === i));

  // The identity of a take and of the step that re-records it must agree, or
  // the new audio lands in a new sample and the zone keeps the old one.
  check('take and step identities match',
    takes.every((t) => retake.some((x) => stepIdentity(x, plan) === sampleIdentity(t, plan))));

  const dupes = buildRetakeSteps([...takes, takes[0]], plan);
  check('duplicate takes collapse to one step', dupes.length === 3, String(dupes.length));
  check('takes with no note are skipped',
    buildRetakeSteps([{ ...takes[0], capture: {}, analysis: {} }], plan).length === 0);

  // Missing slots.
  const small = { ...plan, velocityLayers: 1, roundRobins: 1 };
  const missing = buildMissingSteps(small, takes);
  const wanted = buildSteps(small).length;
  check('missing steps exclude what exists', missing.length === wanted - 2, `${missing.length} of ${wanted}`);
  check('missing steps are re-indexed', missing.every((x, i) => x.index === i));
  check('nothing missing once all recorded', buildMissingSteps(small, buildSteps(small).map((x, i) => ({
    id: 'm' + i,
    name: 'm',
    sampleRate: SR,
    channels: 1,
    frames: SR,
    analysis: {},
    capture: {
      targetMidi: x.midi,
      velLayer: x.velLayer,
      rrIndex: x.rrIndex,
      micId: x.micId,
      articulationId: x.articulationId,
    },
  }))).length === 0);
}

group('Mono mixdown');
{
  const l = new Float32Array([1, 1, 1]);
  const r = new Float32Array([-1, 0, 1]);
  const m = toMono([l, r]);
  check('averages channels', m[0] === 0 && m[1] === 0.5 && m[2] === 1, Array.from(m).join(','));
}

group('Undo history');
{
  let clock = 0;
  const mk = () => new History<{ v: number }>({ v: 0 }, (x) => ({ ...x }), 3, 500, () => clock);
  const live = { v: 0 };
  const edit = (h: History<{ v: number }>, v: number, at: number) => {
    clock = at;
    live.v = v;
    h.commit(live);
  };

  let h = mk();
  check('nothing to undo at start', !h.canUndo && !h.canRedo && h.undo() === null && h.redo() === null);

  edit(h, 1, 1000);
  edit(h, 2, 3000);
  check('two separate edits are two steps', h.undo()?.v === 1 && h.undo()?.v === 0 && h.undo() === null);
  check('redo walks forward', h.redo()?.v === 1 && h.redo()?.v === 2 && h.redo() === null);

  h = mk();
  edit(h, 1, 1000);
  edit(h, 2, 1100);
  edit(h, 3, 1400);
  check('rapid edits coalesce into one step', h.undo()?.v === 0 && !h.canUndo);
  check('redo of a coalesced step restores its final state', h.redo()?.v === 3);

  h = mk();
  edit(h, 1, 1000);
  edit(h, 2, 3000);
  h.undo();
  check('a new edit clears redo', (edit(h, 9, 3100), !h.canRedo));
  clock = 3200;
  check('edit right after undo is its own step', h.undo()?.v === 1);

  h = mk();
  for (let i = 1; i <= 6; i++) edit(h, i, i * 10_000);
  let n = 0;
  while (h.undo()) n++;
  check('history is capped', n === 3, String(n));

  h = mk();
  edit(h, 1, 1000);
  h.reset({ v: 7 });
  check('reset clears both stacks', !h.canUndo && !h.canRedo);
  const snap = h.undo();
  check('snapshots are copies', snap === null);
  h = mk();
  edit(h, 1, 1000);
  const back = h.undo()!;
  back.v = 99;
  check('mutating a restored state does not corrupt history', h.redo()?.v === 1);
}

group('MIDI');
{
  const on = parseMidiMessage([0x93, 60, 100]);
  check('note-on parses, channel is 1-based', on?.type === 'noteOn' && on.channel === 4 && on.note === 60 && on.velocity === 100);
  const zero = parseMidiMessage([0x90, 60, 0]);
  check('velocity-0 note-on is a note-off', zero?.type === 'noteOff' && zero.note === 60);
  check('note-off parses', parseMidiMessage([0x80, 61, 64])?.type === 'noteOff');
  const ped = parseMidiMessage([0xb0, 64, 127]);
  const up = parseMidiMessage([0xb0, 64, 0]);
  check('sustain down/up', ped?.type === 'sustain' && ped.down && up?.type === 'sustain' && !up.down);
  check('CC123 is all-notes-off', parseMidiMessage([0xb2, 123, 0])?.type === 'allNotesOff');
  check('unhandled CC ignored', parseMidiMessage([0xb0, 7, 90]) === null);
  check('clock/sysex ignored', parseMidiMessage([0xf8]) === null && parseMidiMessage([0xf0, 1, 0xf7]) === null);
  const bend = parseMidiMessage([0xe0, 0, 64]);
  check('pitch bend centre is 0', bend?.type === 'pitchBend' && bend.value === 0);
  check('channel filter', channelMatches(0, 9) && channelMatches(3, 3) && !channelMatches(3, 4));
  check('output bytes', midiNoteOnBytes(2, 60, 100).join() === '145,60,100' && midiNoteOffBytes(2, 60).join() === '129,60,0' && midiAllNotesOffBytes(16).join() === '191,123,0');
  check('note-on velocity never 0', midiNoteOnBytes(1, 60, 0)[2] === 1);

  check('single layer velocity', layerVelocity(1, 1) === 100);
  const vels = [1, 2, 3, 4].map((l) => layerVelocity(l, 4));
  check('layer velocities rise from 32 to 127', vels[0] === 32 && vels[3] === 127 && vels.every((v, i) => i === 0 || v > vels[i - 1]), vels.join(','));

  const o = { noteLength: 2, releaseTail: 1.5, silenceTimeout: 0.6 };
  check('take never ends while key held', !midiTakeFinished(1, 5, o));
  check('silence after note-off ends take', midiTakeFinished(2.2, 0.7, o));
  check('no silence yet: keeps waiting', !midiTakeFinished(2.5, 0.2, o));
  check('tail is a hard ceiling', midiTakeFinished(3.5, 0, o));
  check('onset timeout only after tail + grace', !midiOnsetTimedOut(4, o) && midiOnsetTimedOut(5.5, o));
}

group('Denoise');
{
  const sr = 44100;
  const n = sr * 2;
  const clean = new Float32Array(n);
  const noisy = new Float32Array(n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1;
  // Half a second of room noise alone, then a sine over the same noise.
  for (let i = 0; i < n; i++) {
    const sine = i >= sr / 2 ? 0.3 * Math.sin((2 * Math.PI * 1000 * i) / sr) : 0;
    clean[i] = sine;
    noisy[i] = sine + 0.01 * rnd();
  }
  const out = denoiseChannel(noisy, sr, { strengthDb: 24 });
  check('denoise preserves length', out.length === noisy.length);

  // Noise energy away from the sine: spectrum above 3 kHz of the sine region.
  const bandEnergy = (x: Float32Array, from: number, lo: number, hi: number): number => {
    const N = 4096;
    const fft = new FFT(N);
    const w = hann(N);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = x[from + i] * w[i];
    fft.transform(re, im);
    let e = 0;
    for (let k = Math.floor((lo / sr) * N); k < Math.floor((hi / sr) * N); k++) e += re[k] * re[k] + im[k] * im[k];
    return e;
  };
  const from = sr; // well inside the sine section
  const noiseBefore = bandEnergy(noisy, from, 3000, 15000);
  const noiseAfter = bandEnergy(out, from, 3000, 15000);
  const dropDb = 10 * Math.log10(noiseBefore / noiseAfter);
  check(`denoise lowers the noise floor by >12 dB (${dropDb.toFixed(1)} dB)`, dropDb > 12, `${dropDb.toFixed(1)} dB`);

  const sineBefore = bandEnergy(noisy, from, 900, 1100);
  const sineAfter = bandEnergy(out, from, 900, 1100);
  const sineDb = 10 * Math.log10(sineAfter / sineBefore);
  check(`denoise keeps the sine within 1 dB (${sineDb.toFixed(2)} dB)`, Math.abs(sineDb) < 1, `${sineDb.toFixed(2)} dB`);

  // Timing: the output must stay in phase with the signal (no latency shift).
  let dot = 0, na = 0, nb = 0;
  for (let i = sr; i < sr + 20000; i++) {
    dot += out[i] * clean[i];
    na += out[i] * out[i];
    nb += clean[i] * clean[i];
  }
  const corr = dot / Math.sqrt(na * nb);
  check('denoise does not shift timing', corr > 0.99, `corr ${corr.toFixed(4)}`);

  const silent = denoiseChannel(new Float32Array(sr), sr, { strengthDb: 24 });
  check('denoise of silence stays silent', silent.every((v) => Math.abs(v) < 1e-6));
}

function zoneFor(sampleId: string, micId: string | undefined, rr = 1): Zone {
  return {
    id: newId('zone'),
    sampleId,
    micId,
    keyLow: 60,
    keyHigh: 60,
    rootKey: 60,
    velLow: 1,
    velHigh: 127,
    rrIndex: rr,
    tuneCents: 0,
    gainDb: 0,
    pan: 0,
    startFrame: 0,
    endFrame: 0,
    loop: defaultLoop(),
    fadeInFrames: 0,
    fadeOutFrames: 0,
  };
}

group('Mic selection and export');
{
  const inst = createInstrument('Mics');
  inst.mics.push({ id: 'mic_far', name: 'Far', gainDb: -6, pan: 0.5, delayMs: 12, muted: false });
  inst.mics.push({ id: 'mic_room', name: 'Room', gainDb: 0, pan: 0, delayMs: 0, muted: false });
  const closeId = inst.mics[0].id;
  const g = inst.groups[0];
  for (const mic of [closeId, 'mic_far', 'mic_room']) {
    for (const rr of [1, 2]) {
      const sid = `s_${mic}_${rr}`;
      inst.samples.push({ id: sid, name: sid, sampleRate: SR, channels: 1, frames: 1000, analysis: {}, capture: {} });
      g.zones.push(zoneFor(sid, mic, rr));
    }
  }
  const rr = new RoundRobinState();
  const sel = selectZones(inst, rr, 60, 100, null);
  check('one zone per mic sounds together (rr alternates, mics layer)', sel.length === 3, `${sel.length}`);
  check('every mic is represented', new Set(sel.map((x) => x.zone.micId)).size === 3);
  check('mic gain is applied linearly', Math.abs(micGain(inst, sel.find((x) => x.zone.micId === 'mic_far')!.zone) - Math.pow(10, -6 / 20)) < 1e-9);

  const sfz = exportSfz(makeContext(inst));
  check('SFZ writes one group per mic', (sfz.match(/<group>/g) ?? []).length === 3);
  check('SFZ carries mic volume', /volume=-6\b/.test(sfz));
  check('SFZ carries mic delay', sfz.includes('delay=0.012'));
  const ds = exportDecentSampler(makeContext(inst));
  check('DecentSampler has per-mic group volume', ds.includes('volume="-6dB"'));

  inst.mics[2].muted = true; // Room
  check('muted mic is not selected', selectZones(inst, new RoundRobinState(), 60, 100, null).every((x) => x.zone.micId !== 'mic_room'));
  check('muted mic is not exported (SFZ)', !exportSfz(makeContext(inst)).includes('mic_room') && (exportSfz(makeContext(inst)).match(/<group>/g) ?? []).length === 2);
  check('muted mic is not exported (DecentSampler)', !exportDecentSampler(makeContext(inst)).includes('Room'));

  const wav = TARGETS.find((t) => t.id === 'wav')!;
  const sfzT = TARGETS.find((t) => t.id === 'sfz')!;
  const ds2 = TARGETS.find((t) => t.id === 'decentsampler')!;
  check('WAV target warns mic levels are ignored', exportWarnings(wav, inst).some((w) => w.includes('Mic levels')));
  check('SFZ target does not warn about mics', exportWarnings(sfzT, inst).length === 0, exportWarnings(sfzT, inst).join('|'));
  check('DecentSampler warns about mic delay', exportWarnings(ds2, inst).some((w) => w.includes('delay')));
}

group('Articulations');
{
  const inst = createInstrument('Artic');
  const sustain = inst.articulations[0];
  sustain.select = { mode: 'keyswitch', key: 24 };
  const stac = addArticulation(inst, 'Staccato');
  check('new articulation gets a free keyswitch', stac.select.mode === 'keyswitch' && stac.select.key === 25);
  const pizz = addArticulation(inst, 'Pizz');
  pizz.select = { mode: 'cc', cc: 1, low: 64, high: 127 };
  const stGroup = createGroup(stac.id, 'Staccato');
  const pzGroup = createGroup(pizz.id, 'Pizz');
  inst.groups.push(stGroup, pzGroup);
  for (const [i, gr] of inst.groups.entries()) {
    const sid = 'sa' + i;
    inst.samples.push({ id: sid, name: sid, sampleRate: SR, channels: 1, frames: 1000, analysis: {}, capture: {} });
    gr.zones.push(zoneFor(sid, undefined));
  }

  const sfz = exportSfz(makeContext(inst));
  check('SFZ keyswitch groups use sw_last', sfz.includes('sw_last=24') && sfz.includes('sw_last=25'));
  check('SFZ keyswitch range spans both keys', sfz.includes('sw_lokey=24') && sfz.includes('sw_hikey=25'));
  check('SFZ sets sw_default to the default articulation', sfz.includes('sw_default=24'));
  check('SFZ writes CC window for CC articulation', sfz.includes('locc1=64') && sfz.includes('hicc1=127'));
  check('SFZ labels articulations', sfz.includes('sw_label=Staccato'));

  const ds = exportDecentSampler(makeContext(inst));
  check('DecentSampler groups have at most one tags attribute', ds.split('\n').every((l) => (l.match(/ tags=/g) ?? []).length <= 1));
  check('DecentSampler tags keyswitch articulations', ds.includes(`art_${stac.id}`));
  check('DecentSampler binds each keyswitch key', ds.includes('<note note="24">') && ds.includes('<note note="25">'));
  check('DecentSampler warns about CC articulations', exportWarnings(TARGETS.find((t) => t.id === 'decentsampler')!, inst).some((w) => w.includes('CC')));

  // Choke + keyswitch on one group must still yield a single, valid tags attribute.
  stGroup.chokeGroup = 2;
  const ds2 = exportDecentSampler(makeContext(inst));
  check('choke and keyswitch tags merge', ds2.includes(`tags="choke2,art_${stac.id}"`));
  stGroup.chokeGroup = 0;

  check('reorder moves an articulation', moveArticulation(inst, stac.id, -1) && inst.articulations[0].id === stac.id);
  moveGroupTo(inst, stGroup.id, sustain.id);
  check('group can move to another articulation', stGroup.articulationId === sustain.id);

  const r = deleteArticulation(inst, pizz.id, sustain.id);
  check('delete with move keeps the group', r.ok && r.groupsAffected === 1 && inst.groups.some((x) => x.id === pzGroup.id && x.articulationId === sustain.id));
  const total = inst.groups.length;
  const r2 = deleteArticulation(inst, stac.id, null);
  check('delete without move removes the groups', r2.ok && inst.groups.length === total - r2.groupsAffected);
  check('cannot delete the last articulation', !deleteArticulation(inst, sustain.id, null).ok && inst.articulations.length === 1);
  check('no issues on a sane setup', articulationIssues(inst).length === 0);
  inst.articulations.push({ id: 'dup', name: 'Dup', select: { mode: 'keyswitch', key: 24 } });
  check('duplicate keyswitch is reported', articulationIssues(inst).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

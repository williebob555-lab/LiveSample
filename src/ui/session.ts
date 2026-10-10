// ============================================================================
// Session — the capture screen.
//
// A different screen for a different distance. You are at the instrument, a few
// feet from the laptop, hands full. So: one enormous note name, a layer and
// take counter, a meter, and nothing else. It advances on its own when a note
// finishes, so a whole session runs without touching the mouse.
//
// Audio is captured through an AudioWorklet at the device's own rate, so takes
// are exact sample data rather than a re-encoded stream.
// ============================================================================

import { app, modal, toast } from './app';
import { el, clear, clamp } from './dom';
import { Meter, field, checkbox, numberField, selectBox } from './primitives';
import { NoteRange } from './notes';
import { midiName } from '../dsp/pitch';
import { playRefTone, REF_PRESETS, type RefPreset } from '../audio/reftones';
import { levelStats, gainToDb } from '../dsp/analyze';
import { SampleStore, sampleStore } from '../audio/store';
import { planNotes } from '../core/automap';
import {
  buildSteps,
  buildRetakeSteps,
  normalizeCapturePlan,
  sampleIdentity,
  stepIdentity,
} from '../core/capture';
import { newId, type CapturePlan, type CaptureStep, type Sample } from '../core/types';
import { analyzeSample } from '../core/pipeline';
import { audio } from '../audio/output';
import { midi } from '../audio/midi';
import {
  layerVelocity,
  midiOnsetTimedOut,
  midiTakeFinished,
  type MidiCaptureOptions,
} from '../core/midi';

/** Unattended-capture settings. Kept beside the app rather than in the
 *  CapturePlan: they describe the rig on this machine (which port the synth is
 *  on), not the instrument, so they should not travel inside a project file. */
export interface MidiDrive {
  enabled: boolean;
  outputId: string;
  channel: number;
  /** Seconds the note is held. */
  noteLength: number;
  /** Seconds to wait after note-off for the release. */
  releaseTail: number;
}

const MIDI_DRIVE_KEY = 'sampler.midi.capture';

function loadMidiDrive(): MidiDrive {
  const base: MidiDrive = { enabled: false, outputId: '', channel: 1, noteLength: 2, releaseTail: 1.5 };
  try {
    const saved = JSON.parse(localStorage.getItem(MIDI_DRIVE_KEY) ?? 'null') as Partial<MidiDrive> | null;
    if (saved) {
      if (typeof saved.outputId === 'string') base.outputId = saved.outputId;
      if (typeof saved.channel === 'number') base.channel = clamp(Math.round(saved.channel), 1, 16);
      if (typeof saved.noteLength === 'number') base.noteLength = clamp(saved.noteLength, 0.1, 30);
      if (typeof saved.releaseTail === 'number') base.releaseTail = clamp(saved.releaseTail, 0, 30);
    }
  } catch {
    /* defaults */
  }
  return base;
}

function saveMidiDrive(d: MidiDrive): void {
  try {
    localStorage.setItem(MIDI_DRIVE_KEY, JSON.stringify(d));
  } catch {
    /* not persisted */
  }
}

// A worklet that simply forwards every input block to the main thread. Kept
// inline as a blob so there is no second build entry point to keep in sync.
const WORKLET_SOURCE = `
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const copy = input.map((ch) => new Float32Array(ch));
      this.port.postMessage(copy, copy.map((c) => c.buffer));
    }
    return true;
  }
}
registerProcessor('tap', TapProcessor);
`;

type Phase = 'idle' | 'arming' | 'listening' | 'recording' | 'done';

export class SessionScreen {
  readonly root: HTMLElement;
  private noteEl: HTMLElement;
  private subEl: HTMLElement;
  private stateEl: HTMLElement;
  private progressBar: HTMLElement;
  private hintEl: HTMLElement;
  private meter = new Meter(420, 10);

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  private plan: CapturePlan | null = null;
  private steps: CaptureStep[] = [];
  private stepIndex = 0;
  private phase: Phase = 'idle';
  /** Retake mode: each take replaces the one already in its slot. */
  private replacing = false;
  private replaced = 0;

  private chunks: Float32Array[][] = [];
  private channelCount = 1;
  /** The rate takes are recorded at — the device's, not the tone context's. */
  private captureSampleRate = 48000;
  private stopNativeCapture: (() => void) | null = null;
  private noiseFloorDb = -70;
  /** Ignore onsets until this timestamp — the reference cue is still sounding. */
  private armAt = 0;
  private quietFrames = 0;
  private recordedFrames = 0;
  private level = 0;
  private onExit: () => void;

  /** Set when this session plays its own notes over MIDI. */
  private drive: MidiDrive | null = null;
  private noteOnAt = 0;
  private noteOnTimer: ReturnType<typeof setTimeout> | null = null;
  private noteOffTimer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private soundingNote: number | null = null;
  private skipped = 0;

  constructor(onExit: () => void) {
    this.onExit = onExit;
    this.noteEl = el('div', { class: 'session-note', text: '—' });
    this.subEl = el('div', { class: 'session-sub' });
    this.stateEl = el('div', { class: 'session-state', text: 'idle' });
    this.progressBar = el('div', { style: 'width:0%' });
    this.hintEl = el('div', {
      class: 'session-hint',
      text: 'Space — retake · Enter — accept now · S — skip · Esc — end session',
    });

    this.root = el('div', { class: 'session' }, [
      this.noteEl,
      this.subEl,
      this.stateEl,
      this.meter.root,
      el('div', { class: 'session-progress' }, [this.progressBar]),
      el('div', { class: 'session-actions' }, [
        el('button', { text: 'End session', onclick: () => this.stop() }),
      ]),
      this.hintEl,
    ]);

    document.addEventListener('keydown', this.onKey);

    const tick = () => {
      this.meter.draw(this.level);
      this.level *= 0.82;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.root.isConnected) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.stop();
    } else if (e.key === ' ') {
      e.preventDefault();
      this.restartStep();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.phase === 'recording') this.finishTake();
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.advance();
    }
  };

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /**
   * Re-record just these takes.
   *
   * Confirms first, because it overwrites audio in place — and shows exactly
   * which notes are about to be replaced, since "re-record 14 takes" is not
   * something you want to discover the meaning of afterwards.
   */
  static retake(samples: Sample[], onStart: (plan: CapturePlan, steps: CaptureStep[]) => void): void {
    const inst = app.instrument;
    const plan = normalizeCapturePlan(inst, inst.capture);
    inst.capture = plan;

    const steps = buildRetakeSteps(samples, plan);
    if (!steps.length) {
      toast('Those takes have no note assigned to re-record', 'err');
      return;
    }

    const notes = [...new Set(steps.map((s) => midiName(s.midi)))];
    const shown = notes.slice(0, 16).join(', ') + (notes.length > 16 ? `, +${notes.length - 16} more` : '');

    modal({
      title: `Re-record ${steps.length} take${steps.length === 1 ? '' : 's'}`,
      body: el('div', {}, [
        el('div', { class: 'notice warn' }, [
          el('strong', { text: 'Replaces audio in place. ' }),
          'Zones keep pointing at these takes, so the map is preserved — but the recordings themselves are overwritten.',
        ]),
        field('Notes', el('span', { class: 'num', text: shown })),
        el('div', {
          class: 'notice',
          text: 'Everything else uses the project capture settings. Space retakes the current note, S skips it and leaves the old recording alone.',
        }),
      ]),
      confirmLabel: 'Start',
      onConfirm: () => onStart(plan, steps),
    });
  }

  /** Ask for the plan, then start. Resolves false when the user cancels. */
  static configure(onStart: (plan: CapturePlan, drive: MidiDrive | null) => void): void {
    const inst = app.instrument;
    // Edits mutate the instrument's own plan, so the settings survive
    // cancelling the dialog, finishing a session, and saving the project.
    const plan = normalizeCapturePlan(inst, inst.capture);
    inst.capture = plan;

    const summary = el('div', { class: 'notice' });
    // Opening the dialog must not by itself mark the project unsaved; only a
    // real edit should. The first update() is setup, not a change.
    let edited = false;
    const update = () => {
      if (edited) app.dirty = true;
      const notes = planNotes(plan.lowNote, plan.highNote, plan.step);
      const total = notes.length * plan.velocityLayers * plan.roundRobins;
      clear(summary);
      summary.append(
        el('strong', { text: `${total} takes. ` }),
        `${notes.length} notes from ${midiName(plan.lowNote)} to ${midiName(plan.highNote)}, ` +
          `${plan.velocityLayers} velocity layer${plan.velocityLayers === 1 ? '' : 's'}, ` +
          `${plan.roundRobins} round robin${plan.roundRobins === 1 ? '' : 's'}.`,
      );
    };

    const presetHint = el('div', { class: 'status', style: 'margin:2px 0 6px 104px' });
    const setHint = () => {
      presetHint.textContent =
        REF_PRESETS.find((p) => p.value === plan.referencePreset)?.hint ?? '';
    };
    setHint();

    const previewMidi = Math.round((plan.lowNote + plan.highNote) / 2);
    const refSource = el(
      'div',
      { style: plan.referenceTone ? '' : 'display:none' },
      [
        field(
          'Reference',
          selectBox<'recorded' | 'preset'>(
            [
              { value: 'recorded', label: 'Repitch a take already recorded' },
              { value: 'preset', label: 'Built-in instrument' },
            ],
            plan.referenceSource,
            (v) => {
              plan.referenceSource = v;
              update();
            },
          ),
        ),
        field(
          'Instrument',
          selectBox(
            REF_PRESETS.map((p) => ({ value: p.value, label: p.label })),
            plan.referencePreset as RefPreset,
            (v) => {
              plan.referencePreset = v;
              setHint();
              update();
            },
          ),
          el('button', {
            class: 'sm ghost',
            text: 'Hear it',
            onclick: () => {
              const ctx = new AudioContext();
              playRefTone(ctx, plan.referencePreset as RefPreset, previewMidi);
              setTimeout(() => void ctx.close(), 2000);
            },
          }),
        ),
        presetHint,
        el('div', {
          class: 'notice',
          text:
            'A pure tone gives the ear no harmonics, so its octave is ambiguous at the top and bottom of the range — exactly where matching pitch is hardest. Repitching a take you have already captured is easiest to tune against; the built-in instrument covers the first note of a session, before there is anything to repitch.',
        }),
      ],
    );

    const drive = loadMidiDrive();
    const driveBody = el('div', { style: 'display:none' });
    const renderDrive = (): void => {
      clear(driveBody);
      if (!midi.ready) {
        driveBody.append(
          el('div', { class: 'notice warn', text: midi.error ?? 'MIDI is not available.' }),
        );
        return;
      }
      if (!midi.outputs.length) {
        driveBody.append(el('div', { class: 'notice warn', text: 'No MIDI outputs found. Plug one in and it will appear here.' }));
        return;
      }
      if (!midi.outputs.some((p) => p.id === drive.outputId)) drive.outputId = midi.outputs[0].id;
      driveBody.append(
        field(
          'Output',
          selectBox(
            midi.outputs.map((p) => ({ value: p.id, label: p.name })),
            drive.outputId,
            (v) => {
              drive.outputId = v;
              saveMidiDrive(drive);
            },
          ),
        ),
        field(
          'Channel',
          numberField(drive.channel, (v) => {
            drive.channel = clamp(Math.round(v), 1, 16);
            saveMidiDrive(drive);
          }, { min: 1, max: 16, width: 66 }),
        ),
        field(
          'Note length',
          numberField(drive.noteLength, (v) => {
            drive.noteLength = clamp(v, 0.1, 30);
            saveMidiDrive(drive);
          }, { min: 0.1, max: 30, step: 0.1, width: 66 }),
          el('span', { class: 'status', text: 'seconds held' }),
        ),
        field(
          'Release tail',
          numberField(drive.releaseTail, (v) => {
            drive.releaseTail = clamp(v, 0, 30);
            saveMidiDrive(drive);
          }, { min: 0, max: 30, step: 0.1, width: 66 }),
          el('span', { class: 'status', text: 'seconds to wait after note-off' }),
        ),
        el('div', {
          class: 'notice',
          text:
            plan.velocityLayers > 1
              ? `Layers play at velocity ${Array.from({ length: plan.velocityLayers }, (_, i) => layerVelocity(i + 1, plan.velocityLayers)).join(', ')}.`
              : `Plays at velocity ${layerVelocity(1, 1)}. Add velocity layers to vary it.`,
        }),
      );
    };
    const driveToggle = checkbox('Play each note over MIDI (unattended)', drive.enabled, (v) => {
      drive.enabled = v;
      driveBody.style.display = v ? '' : 'none';
      saveMidiDrive(drive);
      if (v) void midi.init().then(renderDrive);
      renderDrive();
    });
    driveBody.style.display = drive.enabled ? '' : 'none';
    midi.onChange(renderDrive);
    if (drive.enabled) void midi.init();
    renderDrive();

    const body = el('div', {}, [
      el('div', { class: 'notice' }, [
        'The app prompts a note, listens, and moves on by itself when the note finishes. ',
        'You should not need the mouse once it starts.',
      ]),
      field(
        'Range',
        new NoteRange({
          low: plan.lowNote,
          high: plan.highNote,
          min: 12,
          max: 120,
          minSpan: 1,
          onInput: (low, high) => {
            plan.lowNote = low;
            plan.highNote = high;
            update();
          },
          onChange: (low, high) => {
            plan.lowNote = low;
            plan.highNote = high;
            update();
          },
        }).root,
      ),
      field(
        'Every',
        numberField(plan.step, (v) => {
          plan.step = clamp(Math.round(v), 1, 12);
          update();
        }, { min: 1, max: 12, width: 66 }),
        el('span', { class: 'status', text: 'semitones' }),
      ),
      field(
        'Velocity layers',
        numberField(plan.velocityLayers, (v) => {
          plan.velocityLayers = clamp(Math.round(v), 1, 8);
          update();
        }, { min: 1, max: 8, width: 66 }),
      ),
      field(
        'Round robins',
        numberField(plan.roundRobins, (v) => {
          plan.roundRobins = clamp(Math.round(v), 1, 8);
          update();
        }, { min: 1, max: 8, width: 66 }),
      ),
      field(
        'Silence ends take',
        numberField(plan.silenceTimeout, (v) => {
          plan.silenceTimeout = clamp(v, 0.1, 5);
          update();
        }, { min: 0.1, max: 5, step: 0.1, width: 66 }),
        el('span', { class: 'status', text: 'seconds' }),
      ),
      checkbox('Play a reference pitch before each note', plan.referenceTone, (v) => {
        plan.referenceTone = v;
        refSource.style.display = v ? '' : 'none';
        update();
      }),
      refSource,
      driveToggle,
      driveBody,
      summary,
    ]);
    update();
    edited = true;

    modal({
      title: 'Capture session',
      body,
      confirmLabel: 'Start',
      onConfirm: () => onStart(plan, drive.enabled && drive.outputId ? drive : null),
    });
  }

  /**
   * Run a session. Passing an explicit step list records exactly those slots
   * instead of the
   * whole matrix, and makes each take replace the one already in that slot —
   * that is the re-record path.
   */
  async start(plan: CapturePlan, steps?: CaptureStep[], drive?: MidiDrive | null): Promise<boolean> {
    this.plan = plan;
    this.drive = drive ?? null;
    this.steps = steps?.length ? steps : buildSteps(plan);
    this.replacing = !!steps?.length;

    // A context purely for reference tones. In native mode nothing else uses
    // it — the takes come from RtAudio, not from Web Audio.
    this.ctx = new AudioContext({ latencyHint: 'interactive' });

    if (audio.canCaptureNatively) {
      // Record through the chosen interface (ASIO or WASAPI), which is the
      // whole point of having picked one.
      this.channelCount = audio.config.inputChannels;
      this.captureSampleRate = audio.status?.sampleRate || audio.config.sampleRate;
      this.stopNativeCapture = audio.captureTo(({ sampleRate, channels }) => {
        this.captureSampleRate = sampleRate;
        this.onAudio(channels);
      });
      this.hintEl.textContent =
        `Recording through ${audio.status?.api ?? 'native driver'} · ` +
        'Space — retake · Enter — accept now · S — skip · Esc — end session';
    } else {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: audio.webInputDeviceId ? { exact: audio.webInputDeviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch {
        toast('Could not open the microphone', 'err');
        return false;
      }

      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      this.captureSampleRate = this.ctx.sampleRate;
      this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'tap');
      this.node.port.onmessage = (e) => this.onAudio(e.data as Float32Array[]);
      this.sourceNode.connect(this.node);
      // Worklets need a destination path to be pulled, but we must not monitor
      // the mic through the speakers — a muted gain gives us the pull with no
      // feedback loop.
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.node.connect(sink);
      sink.connect(this.ctx.destination);
    }

    this.stepIndex = 0;
    if (this.drive) this.hintEl.textContent = 'Playing over MIDI · Space — retake · S — skip · Esc — end session';
    await this.measureNoiseFloor();
    this.beginStep();
    return true;
  }

  /** Listen briefly before the first take so thresholds match the room. */
  private measureNoiseFloor(): Promise<void> {
    this.phase = 'arming';
    this.noteEl.textContent = '···';
    this.stateEl.textContent = 'measuring the room';
    this.stateEl.className = 'session-state';
    this.subEl.textContent = 'stay quiet for a moment';
    this.chunks = [];

    return new Promise((resolve) => {
      setTimeout(() => {
        const captured = this.drain();
        if (captured && captured[0].length > 1000) {
          const stats = levelStats(captured[0]);
          this.noiseFloorDb = stats.rmsDb;
        }
        resolve();
      }, 1200);
    });
  }

  // -------------------------------------------------------------------------
  // Capture loop
  // -------------------------------------------------------------------------

  private get currentStep(): CaptureStep | null {
    return this.steps[this.stepIndex] ?? null;
  }

  private beginStep(): void {
    this.cancelMidiNote();
    const step = this.currentStep;
    if (!step) return this.finishSession();

    this.chunks = [];
    this.recordedFrames = 0;
    this.quietFrames = 0;
    this.phase = 'listening';

    this.noteEl.textContent = midiName(step.midi);
    this.noteEl.className = 'session-note armed';
    this.stateEl.textContent = 'listening';
    this.stateEl.className = 'session-state listening';

    const plan = this.plan;
    const parts: string[] = [];
    if (plan && plan.velocityLayers > 1) parts.push(`layer ${step.velLayer} of ${plan.velocityLayers}`);
    if (plan && plan.roundRobins > 1) parts.push(`take ${step.rrIndex} of ${plan.roundRobins}`);
    parts.push(`${this.stepIndex + 1} / ${this.steps.length}`);
    this.subEl.textContent = parts.join('  ·  ');
    this.progressBar.style.width = `${(this.stepIndex / this.steps.length) * 100}%`;

    // The reference comes out of the speakers, so the mic will hear it. Hold
    // off arming until it has finished or the session records its own cue.
    this.armAt = 0;
    if (this.drive) {
      // No reference cue here: the human it helps is not present, and the
      // synth is about to play the real note.
      this.scheduleMidiNote(step);
    } else if (plan?.referenceTone) {
      const seconds = this.playReference(step.midi);
      this.armAt = performance.now() + seconds * 1000 + 150;
      this.stateEl.textContent = 'reference';
    }
  }

  private get driveOptions(): MidiCaptureOptions {
    const d = this.drive;
    return {
      noteLength: d?.noteLength ?? 0,
      releaseTail: d?.releaseTail ?? 0,
      silenceTimeout: this.plan?.silenceTimeout ?? 0.6,
    };
  }

  /**
   * Play the step's note on the synth, then release it.
   *
   * A short settle delay comes first so the previous note's release and the
   * onset detector's re-arm are done before the new attack arrives.
   */
  private scheduleMidiNote(step: CaptureStep): void {
    const d = this.drive;
    if (!d || !this.plan) return;
    this.stateEl.textContent = 'playing over MIDI';
    this.noteOnTimer = setTimeout(() => {
      this.noteOnTimer = null;
      const velocity = layerVelocity(step.velLayer, this.plan?.velocityLayers ?? 1);
      if (!midi.sendNoteOn(d.outputId, d.channel, step.midi, velocity)) {
        toast('MIDI output not available', 'err');
        this.stop();
        return;
      }
      this.soundingNote = step.midi;
      this.noteOnAt = performance.now();
      this.noteOffTimer = setTimeout(() => this.releaseMidiNote(), d.noteLength * 1000);
      // Polled rather than driven by audio blocks: a silent or mis-routed synth
      // produces no blocks that cross the gate, and nothing else would notice.
      this.watchTimer = setInterval(() => this.watchMidiTake(), 100);
    }, 350);
  }

  private releaseMidiNote(): void {
    const d = this.drive;
    if (d && this.soundingNote != null) midi.sendNoteOff(d.outputId, d.channel, this.soundingNote);
    this.soundingNote = null;
  }

  /** Stop timers and make sure no note is left sounding. */
  private cancelMidiNote(): void {
    if (this.noteOnTimer) clearTimeout(this.noteOnTimer);
    if (this.noteOffTimer) clearTimeout(this.noteOffTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.noteOnTimer = this.noteOffTimer = this.watchTimer = null;
    this.noteOnAt = 0;
    this.releaseMidiNote();
  }

  private watchMidiTake(): void {
    if (!this.noteOnAt) return;
    const since = (performance.now() - this.noteOnAt) / 1000;
    if (this.phase === 'listening' && midiOnsetTimedOut(since, this.driveOptions)) {
      this.skipped++;
      toast(`No sound heard for ${midiName(this.currentStep?.midi ?? 0)} — skipped`, 'err');
      this.advance();
    } else if (this.phase === 'recording') {
      const quiet = this.quietFrames / this.captureSampleRate;
      if (midiTakeFinished(since, quiet, this.driveOptions)) this.finishTake();
    }
  }

  /**
   * The nearest already-captured take with a confident pitch, for use as a
   * reference. Nearest wins so the repitch interval stays small.
   */
  private nearestReference(midi: number): { sampleId: string; rootMidi: number } | null {
    let best: { sampleId: string; rootMidi: number; distance: number } | null = null;
    for (const s of app.instrument.samples) {
      const root =
        (s.analysis.confidence ?? 0) >= 0.6 && s.analysis.rootMidi != null
          ? s.analysis.rootMidi
          : s.capture.targetMidi;
      if (root == null || !sampleStore.has(s.id)) continue;
      const distance = Math.abs(root - midi);
      if (!best || distance < best.distance) best = { sampleId: s.id, rootMidi: root, distance };
    }
    return best ? { sampleId: best.sampleId, rootMidi: best.rootMidi } : null;
  }

  /** Plays the reference and returns how long it will sound, in seconds. */
  private playReference(midi: number): number {
    const ctx = this.ctx;
    if (!ctx) return 0;

    if (this.plan?.referenceSource === 'recorded') {
      const ref = this.nearestReference(midi);
      if (ref) {
        const seconds = this.playSampleReference(ctx, ref.sampleId, ref.rootMidi, midi);
        if (seconds > 0) return seconds;
      }
      // Nothing captured yet — the first note of a session always falls back.
    }
    return playRefTone(ctx, (this.plan?.referencePreset ?? 'piano') as RefPreset, midi);
  }

  /**
   * Repitch an existing take to the target note.
   *
   * playbackRate rather than an offline resample: it is instant, costs nothing,
   * and for a pitch reference the slight formant shift is irrelevant — what
   * matters is that the sound has harmonics so the octave is unambiguous.
   */
  private playSampleReference(
    ctx: AudioContext,
    sampleId: string,
    rootMidi: number,
    targetMidi: number,
  ): number {
    const audio = sampleStore.get(sampleId);
    if (!audio || !audio.frames) return 0;

    let buffer: AudioBuffer;
    try {
      buffer = ctx.createBuffer(audio.channels.length, audio.frames, audio.sampleRate);
      for (let c = 0; c < audio.channels.length; c++)
        buffer.getChannelData(c).set(audio.channels[c]);
    } catch {
      return 0;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, (targetMidi - rootMidi) / 12);

    const gain = ctx.createGain();
    const t = ctx.currentTime;
    // Short and quiet: a cue, not a performance. It has to be out of the way
    // before you play, or the session's own onset detection will hear it.
    const length = Math.min(0.7, buffer.duration / src.playbackRate.value);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.35, t + 0.01);
    gain.gain.setValueAtTime(0.35, t + length * 0.6);
    gain.gain.linearRampToValueAtTime(0, t + length);

    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(t, 0, length * src.playbackRate.value);
    src.onended = () => {
      try {
        gain.disconnect();
      } catch {
        /* already torn down */
      }
    };
    return length;
  }

  private onAudio(blocks: Float32Array[]): void {
    if (!blocks.length) return;
    this.channelCount = blocks.length;

    let peak = 0;
    for (let i = 0; i < blocks[0].length; i++) {
      const a = Math.abs(blocks[0][i]);
      if (a > peak) peak = a;
    }
    if (peak > this.level) this.level = peak;

    if (this.phase === 'arming') {
      this.chunks.push(blocks);
      return;
    }
    if (this.phase !== 'listening' && this.phase !== 'recording') return;

    const plan = this.plan;
    if (!plan) return;
    const blockDb = gainToDb(peak);
    const gate = this.noiseFloorDb + plan.onsetThresholdDb;

    if (this.phase === 'listening') {
      if (this.armAt && performance.now() < this.armAt) {
        // Still playing the reference — keep a rolling pre-roll but do not arm.
        this.chunks = [blocks];
        return;
      }
      if (this.armAt) {
        this.armAt = 0;
        this.stateEl.textContent = 'listening';
      }
      if (blockDb > gate) {
        this.phase = 'recording';
        this.stateEl.textContent = 'recording';
        this.stateEl.className = 'session-state recording';
        this.noteEl.className = 'session-note';
        // Keep the block that crossed the threshold — the transient is in it.
        this.chunks.push(blocks);
        this.recordedFrames += blocks[0].length;
      } else {
        // Hold a rolling one-block pre-roll so no attack is ever clipped.
        this.chunks = [blocks];
      }
      return;
    }

    this.chunks.push(blocks);
    this.recordedFrames += blocks[0].length;

    const sr = this.captureSampleRate;
    if (blockDb <= gate) {
      this.quietFrames += blocks[0].length;
      // In MIDI mode the watch timer decides: silence must not end a take
      // while the key is still held.
      if (!this.drive && this.quietFrames / sr >= plan.silenceTimeout) this.finishTake();
    } else {
      this.quietFrames = 0;
    }

    // A runaway take should not eat memory if the room never goes quiet.
    if (this.recordedFrames / sr > 60) this.finishTake();
  }

  /** Concatenate accumulated blocks into contiguous channels. */
  private drain(): Float32Array[] | null {
    if (!this.chunks.length) return null;
    const channels = this.channelCount;
    const total = this.chunks.reduce((n, b) => n + b[0].length, 0);
    if (!total) return null;
    const out: Float32Array[] = [];
    for (let c = 0; c < channels; c++) out.push(new Float32Array(total));
    let offset = 0;
    for (const block of this.chunks) {
      for (let c = 0; c < channels; c++) out[c].set(block[Math.min(c, block.length - 1)], offset);
      offset += block[0].length;
    }
    this.chunks = [];
    return out;
  }

  private finishTake(): void {
    const step = this.currentStep;
    this.cancelMidiNote();
    const captured = this.drain();
    this.phase = 'listening';
    if (!step || !captured) return this.advance();

    const take = SampleStore.wrap(captured, this.captureSampleRate);
    const name = `${midiName(step.midi)}${step.velLayer > 1 ? ` v${step.velLayer}` : ''}${step.rrIndex > 1 ? ` rr${step.rrIndex}` : ''}`;
    const meta = {
      targetMidi: step.midi,
      velLayer: step.velLayer,
      rrIndex: step.rrIndex,
      articulationId: step.articulationId,
      micId: step.micId || undefined,
      takenAt: Date.now(),
    };

    // In retake mode the new audio takes over the existing sample's id, so
    // every zone already pointing at that take keeps working. Re-recording a
    // note must never unmap it.
    const existing = this.replacing
      ? app.instrument.samples.find(
          (s) => sampleIdentity(s, this.plan ?? undefined) === stepIdentity(step, this.plan ?? undefined),
        )
      : undefined;

    if (existing) {
      sampleStore.setProcessed(existing.id, null);
      sampleStore.set(existing.id, take);
      existing.name = name;
      existing.sampleRate = take.sampleRate;
      existing.channels = take.channels.length;
      existing.frames = take.frames;
      existing.analysis = {};
      existing.capture = meta;
      existing.processed = false;
      // The old audio may have been a generated repitch; the new one is real.
      delete existing.derivedFrom;
      delete existing.path;
      analyzeSample(existing);
      audio.invalidate(existing.id);
      this.replaced++;
    } else {
      const sample: Sample = {
        id: newId('smp'),
        name,
        sampleRate: take.sampleRate,
        channels: take.channels.length,
        frames: take.frames,
        analysis: {},
        capture: meta,
      };
      sampleStore.set(sample.id, take);
      analyzeSample(sample);
      app.instrument.samples.push(sample);
    }

    app.touch();
    this.advance();
  }

  private advance(): void {
    this.stepIndex++;
    if (this.stepIndex >= this.steps.length) this.finishSession();
    else this.beginStep();
  }

  private restartStep(): void {
    // Drop the take just recorded for this step, if there was one.
    const step = this.currentStep ?? this.steps[this.stepIndex - 1];
    if (step) {
      const inst = app.instrument;
      const idx = [...inst.samples]
        .reverse()
        .findIndex(
          (s) =>
            s.capture.targetMidi === step.midi &&
            s.capture.velLayer === step.velLayer &&
            s.capture.rrIndex === step.rrIndex,
        );
      if (idx >= 0) {
        const real = inst.samples.length - 1 - idx;
        sampleStore.delete(inst.samples[real].id);
        inst.samples.splice(real, 1);
        app.touch();
      }
    }
    this.beginStep();
  }

  private finishSession(): void {
    this.phase = 'done';
    this.noteEl.textContent = 'done';
    this.noteEl.className = 'session-note';
    this.stateEl.textContent = this.replacing
      ? `${this.replaced} of ${this.steps.length} takes replaced`
      : `${this.steps.length - this.skipped} takes captured`;
    this.stateEl.className = 'session-state';
    this.subEl.textContent = '';
    this.progressBar.style.width = '100%';
    setTimeout(() => this.stop(), 900);
  }

  stop(): void {
    document.removeEventListener('keydown', this.onKey);
    this.cancelMidiNote();
    // A dropped note-off would leave a synth droning after the session ends,
    // so always finish with All Notes Off on the driven channel.
    if (this.drive) midi.sendAllNotesOff(this.drive.outputId, this.drive.channel);
    try {
      this.stopNativeCapture?.();
      this.stopNativeCapture = null;
      this.node?.disconnect();
      this.sourceNode?.disconnect();
      for (const track of this.stream?.getTracks() ?? []) track.stop();
      void this.ctx?.close();
    } catch {
      /* already torn down */
    }
    this.ctx = null;
    this.node = null;
    this.stream = null;
    this.phase = 'idle';
    this.onExit();
  }
}

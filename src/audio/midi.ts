// ============================================================================
// Web MIDI: input for auditioning, output for unattended capture.
//
// Lives in the renderer (Chromium's own Web MIDI) rather than the audio host:
// MIDI timing here only has to be good enough to play a keyboard or trigger a
// synth, and it keeps working with either audio backend. Electron has to grant
// the 'midi' permission (see electron/main.cjs); in a plain browser the user is
// prompted, and a refusal is reported as `error`.
//
// Sysex is never requested — it widens the permission prompt for nothing here.
// ============================================================================

import { audio } from './output';
import {
  channelMatches,
  midiAllNotesOffBytes,
  midiNoteOffBytes,
  midiNoteOnBytes,
  parseMidiMessage,
} from '../core/midi';

export interface MidiPort {
  id: string;
  name: string;
  connected: boolean;
}

const KEY = 'sampler.midi';

interface Saved {
  /** 'all' or a port id. */
  input: string;
  /** 0 = omni, else 1-16. */
  channel: number;
}

type NoteListener = (midi: number, on: boolean) => void;

class MidiManager {
  inputs: MidiPort[] = [];
  outputs: MidiPort[] = [];
  /** null until init() succeeds; see `error` for why not. */
  error: string | null = null;
  ready = false;

  selectedInput = 'all';
  channel = 0;
  /** performance.now() of the last incoming message we acted on, for the UI. */
  lastActivity = 0;
  /** While false (capture session running) input is ignored, so a stray key
   *  cannot play the engine into the microphone. */
  auditionEnabled = true;

  private access: MIDIAccess | null = null;
  private listeners = new Set<() => void>();
  private noteListeners = new Set<NoteListener>();
  private sounding = new Set<number>();
  private sustained = new Set<number>();
  private pedal = false;
  private initPromise: Promise<boolean> | null = null;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
      if (saved) {
        if (typeof saved.input === 'string') this.selectedInput = saved.input;
        if (typeof saved.channel === 'number' && saved.channel >= 0 && saved.channel <= 16)
          this.channel = saved.channel;
      }
    } catch {
      /* defaults */
    }
  }

  get available(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe to notes that reach the audition path, e.g. to light keys. */
  onNote(fn: NoteListener): () => void {
    this.noteListeners.add(fn);
    return () => this.noteListeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ input: this.selectedInput, channel: this.channel }));
    } catch {
      /* private mode etc. — the setting just will not survive a restart */
    }
  }

  setInput(id: string): void {
    this.selectedInput = id;
    this.releaseAll();
    this.persist();
    this.notify();
  }

  setChannel(channel: number): void {
    this.channel = Math.max(0, Math.min(16, Math.round(channel)));
    this.releaseAll();
    this.persist();
    this.notify();
  }

  /** Request access once; safe to call repeatedly. */
  init(): Promise<boolean> {
    this.initPromise ??= this.open();
    return this.initPromise;
  }

  private async open(): Promise<boolean> {
    if (!this.available) {
      this.error = 'Web MIDI is not available in this environment.';
      this.notify();
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.error = `MIDI access was refused (${(e as Error).message || 'permission denied'}). Allow MIDI for this app and reopen this dialog.`;
      // Allow a retry after the user changes the permission.
      this.initPromise = null;
      this.notify();
      return false;
    }
    this.error = null;
    this.ready = true;
    // Hot-plug: ports appear and disappear after the fact, and a re-added
    // device is a new object, so handlers are re-bound on every change.
    this.access.onstatechange = () => this.refresh();
    this.refresh();
    return true;
  }

  private refresh(): void {
    const access = this.access;
    if (!access) return;
    const list = (m: ReadonlyMap<string, MIDIPort>): MidiPort[] =>
      [...m.values()].map((p) => ({
        id: p.id,
        name: p.name || p.id,
        connected: p.state === 'connected',
      }));
    this.inputs = list(access.inputs);
    this.outputs = list(access.outputs);
    for (const input of access.inputs.values()) input.onmidimessage = (e) => this.onMessage(input.id, e);

    // A selected device that was unplugged: stop its notes, keep the choice so
    // it resumes when it comes back.
    if (this.selectedInput !== 'all' && !this.inputs.some((p) => p.id === this.selectedInput && p.connected))
      this.releaseAll();
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Input -> audition
  // -------------------------------------------------------------------------

  private onMessage(portId: string, e: MIDIMessageEvent): void {
    if (!e.data) return;
    if (this.selectedInput !== 'all' && this.selectedInput !== portId) return;
    const msg = parseMidiMessage(e.data);
    if (!msg || msg.type === 'pitchBend') return;
    if (!channelMatches(this.channel, msg.channel)) return;
    this.lastActivity = performance.now();
    if (!this.auditionEnabled) return;

    switch (msg.type) {
      case 'noteOn':
        this.sustained.delete(msg.note);
        this.sounding.add(msg.note);
        // start() is idempotent and covers the browser's autoplay rule: the
        // first key press is the user gesture that lets audio begin.
        void audio.start().then(() => audio.noteOn(msg.note, msg.velocity));
        for (const fn of this.noteListeners) fn(msg.note, true);
        break;
      case 'noteOff':
        if (!this.sounding.delete(msg.note)) break;
        if (this.pedal) this.sustained.add(msg.note);
        else this.stop(msg.note);
        break;
      case 'sustain':
        this.pedal = msg.down;
        if (!msg.down) {
          for (const n of this.sustained) this.stop(n);
          this.sustained.clear();
        }
        break;
      case 'allNotesOff':
        this.releaseAll();
        break;
    }
  }

  private stop(note: number): void {
    audio.noteOff(note);
    for (const fn of this.noteListeners) fn(note, false);
  }

  /** Drop every note we started, e.g. when the source or channel changes. */
  releaseAll(): void {
    for (const n of [...this.sounding, ...this.sustained]) this.stop(n);
    this.sounding.clear();
    this.sustained.clear();
    this.pedal = false;
  }

  // -------------------------------------------------------------------------
  // Output (capture)
  // -------------------------------------------------------------------------

  private output(id: string): MIDIOutput | null {
    return this.access?.outputs.get(id) ?? null;
  }

  sendNoteOn(portId: string, channel: number, note: number, velocity: number): boolean {
    const out = this.output(portId);
    if (!out) return false;
    out.send(midiNoteOnBytes(channel, note, velocity));
    return true;
  }

  sendNoteOff(portId: string, channel: number, note: number): void {
    this.output(portId)?.send(midiNoteOffBytes(channel, note));
  }

  sendAllNotesOff(portId: string, channel: number): void {
    this.output(portId)?.send(midiAllNotesOffBytes(channel));
  }
}

export const midi = new MidiManager();

// ============================================================================
// MIDI: message parsing and the timing of an unattended capture note.
//
// Pure functions, no Web MIDI objects, so the byte-level rules (reading a
// velocity-0 note-on as a note-off, the 1-based channel numbers people see vs
// the 0-based ones on the wire) and the take timeline can be tested without
// any hardware.
// ============================================================================

export type MidiEvent =
  | { type: 'noteOn'; channel: number; note: number; velocity: number }
  | { type: 'noteOff'; channel: number; note: number }
  | { type: 'sustain'; channel: number; down: boolean }
  | { type: 'pitchBend'; channel: number; value: number }
  | { type: 'allNotesOff'; channel: number };

/**
 * Decode one channel-voice message. Channels are returned 1-16 (what a
 * musician sees on the device) rather than the 0-15 on the wire. Anything we
 * do not act on (clock, aftertouch, sysex...) returns null.
 */
export function parseMidiMessage(data: ArrayLike<number>): MidiEvent | null {
  if (data.length < 2) return null;
  const status = data[0];
  if (status < 0x80 || status >= 0xf0) return null;
  const kind = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const d1 = data[1] & 0x7f;
  const d2 = (data[2] ?? 0) & 0x7f;

  switch (kind) {
    case 0x90:
      // Many keyboards send note-off as note-on with velocity 0; treating that
      // as a real note-on would leave the note stuck.
      return d2 === 0
        ? { type: 'noteOff', channel, note: d1 }
        : { type: 'noteOn', channel, note: d1, velocity: d2 };
    case 0x80:
      return { type: 'noteOff', channel, note: d1 };
    case 0xb0:
      if (d1 === 64) return { type: 'sustain', channel, down: d2 >= 64 };
      if (d1 === 123 || d1 === 120) return { type: 'allNotesOff', channel };
      return null;
    case 0xe0:
      // 14-bit, centred on 8192; normalised to -1..1.
      return { type: 'pitchBend', channel, value: (((d2 << 7) | d1) - 8192) / 8192 };
    default:
      return null;
  }
}

/** Channel filter: 0 means omni (every channel). */
export function channelMatches(filter: number, channel: number): boolean {
  return filter === 0 || filter === channel;
}

/** Raw bytes for sending. `channel` is 1-16. */
export const midiNoteOnBytes = (channel: number, note: number, velocity: number): number[] => [
  0x90 | ((channel - 1) & 0x0f),
  note & 0x7f,
  Math.max(1, Math.min(127, Math.round(velocity))),
];
export const midiNoteOffBytes = (channel: number, note: number): number[] => [
  0x80 | ((channel - 1) & 0x0f),
  note & 0x7f,
  0,
];
/** CC123, "All Notes Off". */
export const midiAllNotesOffBytes = (channel: number): number[] => [
  0xb0 | ((channel - 1) & 0x0f),
  123,
  0,
];

// ---------------------------------------------------------------------------
// Unattended capture
// ---------------------------------------------------------------------------

export interface MidiCaptureOptions {
  /** Seconds the note is held before note-off. */
  noteLength: number;
  /** Seconds to wait after note-off for the release to die away. */
  releaseTail: number;
  /** Seconds of silence that end a take (the plan's silenceTimeout). */
  silenceTimeout: number;
}

/**
 * Velocity for a layer (1-based). The plan only stores a layer count, so the
 * values are spread evenly: one layer plays a firm 100; several run from 32
 * (soft, but above most instruments' dead zone) up to 127.
 */
export function layerVelocity(layer: number, layers: number): number {
  if (layers <= 1) return 100;
  const t = (Math.max(1, Math.min(layers, layer)) - 1) / (layers - 1);
  return Math.round(32 + (127 - 32) * t);
}

/**
 * Decide whether a MIDI-driven take is over.
 *
 * `sinceNoteOn` is seconds since note-on was sent, `quiet` the length of the
 * current run of below-threshold audio. Silence alone must not end the take
 * while the key is still held (a soft sustained note can dip under the gate),
 * so nothing ends before note-off. After it, silence ends the take early and
 * the release tail is a hard ceiling for sounds that never fall under the gate.
 */
export function midiTakeFinished(sinceNoteOn: number, quiet: number, o: MidiCaptureOptions): boolean {
  if (sinceNoteOn < o.noteLength) return false;
  if (quiet >= o.silenceTimeout) return true;
  return sinceNoteOn >= o.noteLength + o.releaseTail;
}

/**
 * Give up on a step when no onset appears: the synth is muted, routed to the
 * wrong port, or the note is out of its range. Without this an unattended run
 * would wait forever with nobody there to notice.
 */
export function midiOnsetTimedOut(sinceNoteOn: number, o: MidiCaptureOptions): boolean {
  return sinceNoteOn >= o.noteLength + o.releaseTail + 2;
}

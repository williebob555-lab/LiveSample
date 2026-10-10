// ============================================================================
// WAV read/write, including the `smpl` chunk.
//
// The smpl chunk is what makes a bare WAV self-describing: it carries the root
// note, the fine tuning and the loop points, so a plain folder of files drops
// into most samplers already mapped and already looping. It costs a few dozen
// bytes and is the difference between "a folder of audio" and "an instrument",
// so every file this app writes gets one.
//
// Arbitrary formats (mp3/m4a/ogg/flac) are decoded with the browser's
// decodeAudioData instead — see dsp/decode.ts. This module is only for WAV,
// where we need byte-level control the Web Audio decoder does not give us.
// ============================================================================

export interface WavLoop {
  start: number;
  /** Exclusive end frame, normalised on read from the file's inclusive value. */
  end: number;
  type: 'forward' | 'pingpong' | 'reverse';
}

export interface DecodedWav {
  channels: Float32Array[];
  sampleRate: number;
  frames: number;
  /** From the smpl chunk when present. */
  rootMidi?: number;
  cents?: number;
  loops: WavLoop[];
}

const FOURCC = (v: DataView, off: number): string =>
  String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function isWav(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const v = new DataView(buf);
  return FOURCC(v, 0) === 'RIFF' && FOURCC(v, 8) === 'WAVE';
}

export function decodeWav(buf: ArrayBuffer): DecodedWav {
  const v = new DataView(buf);
  if (!isWav(buf)) throw new Error('Not a RIFF/WAVE file');

  let format = WAVE_FORMAT_PCM;
  let channelCount = 0;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;
  let rootMidi: number | undefined;
  let cents: number | undefined;
  const loops: WavLoop[] = [];

  // Walk the chunk list. Chunks are word-aligned: odd sizes carry a pad byte.
  let pos = 12;
  while (pos + 8 <= buf.byteLength) {
    const id = FOURCC(v, pos);
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (size > buf.byteLength - body) break;

    if (id === 'fmt ') {
      format = v.getUint16(body, true);
      channelCount = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bitsPerSample = v.getUint16(body + 14, true);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 40) {
        // The real format lives in the first two bytes of the GUID.
        format = v.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
    } else if (id === 'smpl' && size >= 36) {
      const unity = v.getUint32(body + 12, true);
      const frac = v.getUint32(body + 16, true);
      if (unity <= 127) rootMidi = unity;
      cents = (frac / 4294967296) * 100;
      const loopCount = v.getUint32(body + 28, true);
      for (let i = 0; i < loopCount; i++) {
        const lo = body + 36 + i * 24;
        if (lo + 24 > buf.byteLength) break;
        const t = v.getUint32(lo + 4, true);
        loops.push({
          start: v.getUint32(lo + 8, true),
          // Files store the last *included* frame; we work with exclusive ends.
          end: v.getUint32(lo + 12, true) + 1,
          type: t === 1 ? 'pingpong' : t === 2 ? 'reverse' : 'forward',
        });
      }
    }
    pos = body + size + (size & 1);
  }

  if (dataOffset < 0 || channelCount === 0) throw new Error('WAV is missing fmt or data');

  const bytesPerSample = bitsPerSample >> 3;
  const frames = Math.floor(dataLength / (bytesPerSample * channelCount));
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(frames));

  const readers: Record<number, (o: number) => number> = {
    8: (o) => (v.getUint8(o) - 128) / 128,
    16: (o) => v.getInt16(o, true) / 32768,
    // 24-bit little-endian, sign-extended from the top byte.
    24: (o) => ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608),
    32: format === WAVE_FORMAT_FLOAT ? (o) => v.getFloat32(o, true) : (o) => v.getInt32(o, true) / 2147483648,
    64: (o) => v.getFloat64(o, true),
  };
  const read = readers[bitsPerSample];
  if (!read) throw new Error(`Unsupported bit depth: ${bitsPerSample}`);

  for (let f = 0; f < frames; f++) {
    const base = dataOffset + f * bytesPerSample * channelCount;
    for (let c = 0; c < channelCount; c++) channels[c][f] = read(base + c * bytesPerSample);
  }

  return { channels, sampleRate, frames, rootMidi, cents, loops };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export interface EncodeOptions {
  bitDepth?: 16 | 24 | 32;
  /** Written into the smpl chunk so the file maps itself in other samplers. */
  rootMidi?: number | null;
  /** Fine tune in cents. Negative values shift rootMidi down by one semitone. */
  cents?: number;
  loop?: { start: number; end: number; type?: 'forward' | 'pingpong' } | null;
}

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  opts: EncodeOptions = {},
): Uint8Array {
  const bitDepth = opts.bitDepth ?? 24;
  const isFloat = bitDepth === 32;
  const channelCount = channels.length;
  const frames = channelCount ? channels[0].length : 0;
  const bytesPerSample = bitDepth >> 3;
  const blockAlign = bytesPerSample * channelCount;
  const dataBytes = frames * blockAlign;

  // smpl is only written when we actually know the root note.
  const wantSmpl = opts.rootMidi != null && opts.rootMidi >= 0;
  const loopCount = wantSmpl && opts.loop ? 1 : 0;
  const smplBytes = wantSmpl ? 36 + loopCount * 24 : 0;

  const headerBytes = 12 + 24 + (wantSmpl ? 8 + smplBytes : 0) + 8;
  const out = new ArrayBuffer(headerBytes + dataBytes + (dataBytes & 1));
  const v = new DataView(out);
  const bytes = new Uint8Array(out);

  let p = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) bytes[p + i] = s.charCodeAt(i);
    p += s.length;
  };
  const u32 = (n: number) => {
    v.setUint32(p, n >>> 0, true);
    p += 4;
  };
  const u16 = (n: number) => {
    v.setUint16(p, n & 0xffff, true);
    p += 2;
  };

  str('RIFF');
  u32(out.byteLength - 8);
  str('WAVE');

  str('fmt ');
  u32(16);
  u16(isFloat ? WAVE_FORMAT_FLOAT : WAVE_FORMAT_PCM);
  u16(channelCount);
  u32(sampleRate);
  u32(sampleRate * blockAlign);
  u16(blockAlign);
  u16(bitDepth);

  if (wantSmpl) {
    // The pitch fraction is unsigned (0..1 semitone), so a flat sample is
    // expressed as the semitone below plus a positive fraction.
    let unity = Math.round(opts.rootMidi as number);
    let c = opts.cents ?? 0;
    if (c < 0) {
      unity -= 1;
      c += 100;
    }
    c = Math.max(0, Math.min(99.999, c));

    str('smpl');
    u32(smplBytes);
    u32(0); // manufacturer
    u32(0); // product
    u32(Math.round(1e9 / sampleRate)); // sample period, nanoseconds
    u32(Math.max(0, Math.min(127, unity)));
    u32(Math.round((c / 100) * 4294967296) >>> 0);
    u32(0); // SMPTE format
    u32(0); // SMPTE offset
    u32(loopCount);
    u32(0); // sampler-specific data length
    if (loopCount && opts.loop) {
      u32(0); // cue point id
      u32(opts.loop.type === 'pingpong' ? 1 : 0);
      u32(opts.loop.start);
      u32(Math.max(opts.loop.start, opts.loop.end - 1)); // inclusive last frame
      u32(0); // fraction
      u32(0); // play count — 0 means loop forever
    }
  }

  str('data');
  u32(dataBytes);

  const clamp = (x: number) => (x > 1 ? 1 : x < -1 ? -1 : x);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channelCount; c++) {
      const s = clamp(channels[c][f]);
      if (isFloat) {
        v.setFloat32(p, s, true);
        p += 4;
      } else if (bitDepth === 16) {
        v.setInt16(p, Math.round(s * 32767), true);
        p += 2;
      } else {
        const n = Math.round(s * 8388607);
        bytes[p] = n & 0xff;
        bytes[p + 1] = (n >> 8) & 0xff;
        bytes[p + 2] = (n >> 16) & 0xff;
        p += 3;
      }
    }
  }

  return bytes;
}

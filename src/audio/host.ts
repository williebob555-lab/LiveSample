// ============================================================================
// Audio host process.
//
// Owns RtAudio (WASAPI / ASIO / DirectSound) and the native renderer. Runs as
// an Electron utilityProcess so feeding the output queue never competes with
// window management, IPC or GC on the main thread.
//
// Bundled to dist-host/host.cjs by scripts/build-host.mjs. `audify` stays
// external — it is a native module and must be required at runtime.
// ============================================================================

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadAudify, RtAudioFormat, RtAudioStreamFlags } from './audify-native';
import type { RtAudio } from 'audify';
import type { Instrument } from '../core/types';
import { NativeRenderer } from './render';
import { decodeWav, isWav } from '../dsp/wav';
import {
  AudioApi,
  API_LABELS,
  type ApiDevices,
  type AudioDevice,
  type HostEvent,
  type HostRequest,
  type StreamConfig,
  type StreamStatus,
} from './protocol';

const parentPort = (process as unknown as { parentPort: NodeJS.EventEmitter & {
  postMessage(m: unknown): void;
} }).parentPort;

const send = (event: HostEvent): void => parentPort.postMessage(event);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let rt: RtAudio | null = null;
let renderer = new NativeRenderer(48000, 2);
let config: StreamConfig | null = null;
let frameSize = 512;
let outputChannels = 2;
let inputChannels = 0;
let capturing = false;
let inputPeak = 0;

let interleaved = new Float32Array(0);
let planar: Float32Array[] = [];

const WINDOWS_APIS = [AudioApi.WindowsWasapi, AudioApi.WindowsAsio, AudioApi.WindowsDirectSound];

/**
 * One RtAudio instance per API, kept for the life of the process.
 *
 * Two reasons, both of which cost real debugging time to find:
 *
 *  - Device ids are assigned per instance, not globally. Every API's first
 *    device comes back as id 129, so an id read from a throwaway enumeration
 *    probe is not guaranteed to mean the same device to a different instance.
 *    Enumerating and streaming through the same object keeps ids meaningful.
 *
 *  - Instances hold their driver until garbage collection, which JS gives no
 *    guarantee about. A discarded ASIO probe keeps the driver open, and the
 *    next open fails with "Another RtAudio ASIO stream is open".
 */
const instances = new Map<number, RtAudio>();

function instanceFor(api: number): RtAudio {
  let inst = instances.get(api);
  if (!inst) {
    inst = new (loadAudify().RtAudio)(api);
    instances.set(api, inst);
  }
  return inst;
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/**
 * ASIO drivers that are installed but did not probe.
 *
 * RtAudio prints these to stderr from native code and simply omits them, so an
 * interface that is merely unplugged looks identical to one that was never
 * installed. Reading the registry lets the UI say "installed, not connected"
 * instead of silently hiding it.
 */
function installedAsioDrivers(): string[] {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\ASIO'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('HKEY_'))
      .map((l) => l.slice(l.lastIndexOf('\\') + 1))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function toDevice(d: {
  id: number;
  name: string;
  inputChannels: number;
  outputChannels: number;
  duplexChannels: number;
  isDefaultInput: number;
  isDefaultOutput: number;
  sampleRates: number[];
  preferredSampleRate: number;
}): AudioDevice {
  return {
    id: d.id,
    name: d.name,
    inputChannels: d.inputChannels,
    outputChannels: d.outputChannels,
    duplexChannels: d.duplexChannels,
    isDefaultInput: !!d.isDefaultInput,
    isDefaultOutput: !!d.isDefaultOutput,
    sampleRates: d.sampleRates ?? [],
    preferredSampleRate: d.preferredSampleRate,
  };
}

function enumerate(): ApiDevices[] {
  const asioInstalled = installedAsioDrivers();
  const result: ApiDevices[] = [];

  try {
    loadAudify();
  } catch (e) {
    // The native binary is missing or unloadable — report it once per API
    // rather than silently showing three empty device lists.
    return WINDOWS_APIS.map((api) => ({
      api,
      label: API_LABELS[api] ?? String(api),
      actualName: '',
      devices: [],
      unavailable: [],
      error: (e as Error).message,
    }));
  }

  for (const api of WINDOWS_APIS) {
    const label = API_LABELS[api] ?? String(api);
    try {
      const probe = instanceFor(api);
      const actualName = probe.getApi();
      const devices = probe.getDevices().map(toDevice);

      // RtAudio silently falls back to a working API when the requested one
      // is unavailable, so an ASIO request can come back as WASAPI. Detecting
      // that is the difference between an honest list and a lie.
      const matches = actualName.toLowerCase().includes(label.toLowerCase().slice(0, 4));
      if (!matches && api !== AudioApi.WindowsWasapi) {
        result.push({
          api,
          label,
          actualName,
          devices: [],
          unavailable: api === AudioApi.WindowsAsio ? asioInstalled : [],
          error: `Not available (RtAudio fell back to ${actualName})`,
        });
        continue;
      }

      const unavailable =
        api === AudioApi.WindowsAsio
          ? asioInstalled.filter((n) => !devices.some((d) => d.name.includes(n) || n.includes(d.name)))
          : [];

      result.push({ api, label, actualName, devices, unavailable });
    } catch (e) {
      result.push({
        api,
        label,
        actualName: '',
        devices: [],
        unavailable: api === AudioApi.WindowsAsio ? asioInstalled : [],
        error: (e as Error).message,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

function status(): StreamStatus {
  if (!rt || !rt.isStreamOpen()) {
    return {
      open: false,
      running: false,
      api: '',
      sampleRate: 0,
      frameSize: 0,
      latencyFrames: 0,
      latencyMs: 0,
      latencyEstimated: false,
    };
  }
  const sr = rt.getStreamSampleRate();
  const reported = rt.getStreamLatency();

  // WASAPI routinely reports 0. Falling back to the buffer depth is a rough
  // figure but an honest one; presenting 0.0 ms would not be.
  const estimated = reported <= 0;
  const frames = estimated ? frameSize * (outputChannels && inputChannels ? 2 : 1) : reported;

  return {
    open: true,
    running: rt.isStreamRunning(),
    api: rt.getApi(),
    sampleRate: sr,
    frameSize,
    latencyFrames: frames,
    latencyMs: sr > 0 ? (frames / sr) * 1000 : 0,
    latencyEstimated: estimated,
  };
}

function allocateBuffers(): void {
  interleaved = new Float32Array(frameSize * Math.max(1, outputChannels));
  planar = [];
  for (let c = 0; c < Math.max(1, outputChannels); c++) planar.push(new Float32Array(frameSize));
}

function pushBlock(): void {
  if (!rt || !outputChannels) return;
  renderer.renderInterleaved(interleaved, frameSize, planar);
  rt.write(Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength));
}

function onInput(data: Buffer): void {
  if (!inputChannels) return;
  const frames = Math.floor(data.byteLength / 4 / inputChannels);
  if (frames <= 0) return;

  // Buffer may not be 4-byte aligned for a Float32Array view, so copy first.
  const copy = new Float32Array(frames * inputChannels);
  for (let i = 0; i < copy.length; i++) copy[i] = data.readFloatLE(i * 4);

  let peak = inputPeak;
  const channels: Float32Array[] = [];
  for (let c = 0; c < inputChannels; c++) channels.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < inputChannels; c++) {
      const s = copy[i * inputChannels + c];
      channels[c][i] = s;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
  }
  inputPeak = peak;

  if (capturing) {
    send({ type: 'capture', sampleRate: rt?.getStreamSampleRate() ?? 48000, channels });
  }
}

/** When the last stream was torn down. Exclusive drivers need a settling gap. */
let lastCloseAt = 0;

function closeStream(): void {
  capturing = false;
  const had = !!rt;
  const target = rt;
  rt = null;
  config = null;
  if (!target) return;

  // Close unconditionally rather than guarding on isStreamOpen(). When an
  // exclusive driver tears a stream down underneath us, isStreamOpen() already
  // reports false while RtAudio still considers the stream open — skipping the
  // close then makes the next attempt fail with "a stream is already open".
  try {
    target.stop();
  } catch {
    /* not running */
  }
  try {
    target.closeStream();
  } catch {
    /* not open */
  }
  if (had) lastCloseAt = Date.now();
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * RtAudio routes warnings through the same callback as real failures, and
 * enumeration chatter about disconnected ASIO drivers arrives there too. Only
 * surface things the user can act on — types 0 and 1 are WARNING and
 * DEBUG_WARNING.
 */
function reportStreamError(type: number, message: string): void {
  if (type <= 1) return;
  send({ type: 'error', message });
}

async function openStream(cfg: StreamConfig): Promise<void> {
  closeStream();

  // Exclusive drivers — ASIO above all — do not release the hardware the
  // instant the stream closes. Opening ASIO on an interface that was just
  // being used over WASAPI fails unless it is given a moment, and the gap has
  // to be measured from the close itself: by the time we get here the stream
  // handle is already gone, so "did we have a stream" is not the question.
  const since = Date.now() - lastCloseAt;
  if (lastCloseAt && since < 900) await delay(900 - since);

  const wantOutput = cfg.outputDeviceId != null && cfg.outputChannels > 0;
  const wantInput = cfg.inputDeviceId != null && cfg.inputChannels > 0;
  if (!wantOutput && !wantInput) {
    send({ type: 'error', message: 'Choose an input or an output device.' });
    send({ type: 'status', status: status() });
    return;
  }

  let failure: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      closeStream();
      await delay(900);
    }
    try {
      tryOpen(cfg, wantOutput, wantInput);
      // An exclusive driver can accept openStream and then tear the stream down
      // a moment later — ASIO does exactly this when another program already
      // holds the interface. Without re-checking we would report a healthy
      // stream that is silently dead.
      await delay(250);
      if (rt?.isStreamOpen() && rt.isStreamRunning()) {
        send({ type: 'status', status: status() });
        return;
      }
      failure = 'The driver closed the stream immediately after opening it.';
    } catch (e) {
      failure = (e as Error).message || 'The driver refused to open the stream.';
    }
  }

  closeStream();
  const message =
    cfg.api === AudioApi.WindowsAsio
      ? `${failure} ASIO drivers are exclusive — close anything else using this interface ` +
        '(a DAW, a browser tab, or system audio routed through it) and try again.'
      : (failure ?? 'Could not open the device.');
  send({ type: 'status', status: { ...status(), error: message } });
  send({ type: 'error', message });
}

function tryOpen(cfg: StreamConfig, wantOutput: boolean, wantInput: boolean): void {
  {
    rt = instanceFor(cfg.api);
    outputChannels = wantOutput ? cfg.outputChannels : 0;
    inputChannels = wantInput ? cfg.inputChannels : 0;

    let flags = 0;
    if (cfg.minimizeLatency) flags |= RtAudioStreamFlags.MINIMIZE_LATENCY;

    const actualFrameSize = rt.openStream(
      wantOutput
        ? {
            deviceId: cfg.outputDeviceId as number,
            nChannels: cfg.outputChannels,
            firstChannel: cfg.outputFirstChannel,
          }
        : null,
      wantInput
        ? {
            deviceId: cfg.inputDeviceId as number,
            nChannels: cfg.inputChannels,
            firstChannel: cfg.inputFirstChannel,
          }
        : null,
      RtAudioFormat.FLOAT32,
      cfg.sampleRate,
      cfg.frameSize,
      'Sampler',
      wantInput ? onInput : null,
      wantOutput ? () => pushBlock() : null,
      flags,
      reportStreamError,
    );

    frameSize = actualFrameSize || cfg.frameSize || 512;
    const actualRate = rt.getStreamSampleRate() || cfg.sampleRate;
    renderer.channels = Math.max(1, outputChannels);
    renderer.setSampleRate(actualRate);
    allocateBuffers();

    rt.start();
    // Prime the output queue. Without a few blocks in hand the first
    // frameOutputCallback arrives too late and the stream starts with a glitch.
    if (wantOutput) for (let i = 0; i < 3; i++) pushBlock();

    config = { ...cfg, frameSize, sampleRate: actualRate };
  }
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

function loadSampleFromPath(id: string, path: string): boolean {
  try {
    const buf = readFileSync(path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    if (!isWav(ab)) return false;
    const wav = decodeWav(ab);
    renderer.addSample(id, wav.channels, wav.sampleRate);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

parentPort.on('message', (e: { data: HostRequest }) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'enumerate':
        send({ type: 'devices', apis: enumerate() });
        break;
      case 'open':
        void openStream(msg.config);
        break;
      case 'close':
        closeStream();
        send({ type: 'status', status: status() });
        break;
      case 'status':
        send({ type: 'status', status: status() });
        break;
      case 'instrument':
        renderer.setInstrument(msg.instrument as Instrument | null);
        break;
      case 'sampleFromPath':
        send({ type: 'sampleReady', id: msg.id, ok: loadSampleFromPath(msg.id, msg.path) });
        break;
      case 'sampleFromData':
        renderer.addSample(msg.id, msg.channels, msg.sampleRate);
        send({ type: 'sampleReady', id: msg.id, ok: true });
        break;
      case 'dropSample':
        renderer.removeSample(msg.id);
        break;
      case 'clearSamples':
        renderer.clearSamples();
        break;
      case 'noteOn':
        renderer.noteOn(msg.key, msg.velocity);
        break;
      case 'noteOff':
        renderer.noteOff(msg.key);
        break;
      case 'sustain':
        renderer.setSustainPedal(msg.down);
        break;
      case 'panic':
        renderer.allNotesOff();
        break;
      case 'startCapture':
        capturing = true;
        break;
      case 'stopCapture':
        capturing = false;
        break;
      default:
        break;
    }
  } catch (err) {
    send({ type: 'error', message: (err as Error).message });
  }
});

// Meter updates. 20 Hz is enough to look continuous and costs nothing.
setInterval(() => {
  if (!rt?.isStreamOpen()) return;
  send({
    type: 'meter',
    output: renderer.takePeak(),
    input: inputPeak,
    voices: renderer.voiceCount,
  });
  inputPeak = 0;
}, 50);

process.on('uncaughtException', (err) => {
  send({ type: 'error', message: `host: ${err.message}` });
});

// Keep a reference so bundlers never tree-shake the renderer away.
void renderer;
void config;

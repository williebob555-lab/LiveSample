// ============================================================================
// Audio output facade.
//
// Two backends behind one surface:
//
//   webaudio  Chromium's own mixer. No native dependency, device selection via
//             enumerateDevices / setSinkId, shared mode only. The
//             fallback, and what runs in a plain browser.
//
//   native    RtAudio in the host process: WASAPI (including low-latency),
//             DirectSound and ASIO on Windows; PulseAudio (PipeWire) and
//             ALSA on Linux. The real answer for a sampling rig.
//
// Both drive the same selection logic (audio/select), so switching backends
// changes latency and driver, never which sample you hear.
// ============================================================================

import type { Instrument } from '../core/types';
import { engine as webEngine } from './engine';
import { sampleStore } from './store';
import { encodeWav } from '../dsp/wav';
import {
  defaultStreamConfig,
  platformApis,
  type ApiDevices,
  type HostEvent,
  type HostRequest,
  type StreamConfig,
  type StreamStatus,
} from './protocol';

interface AudioBridge {
  platform?: string;
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  send(msg: HostRequest): void;
  onEvent(fn: (e: HostEvent) => void): () => void;
}

const bridge: AudioBridge | undefined = (window as unknown as { samplerAudio?: AudioBridge })
  .samplerAudio;

export const hasNativeAudio = !!bridge;

/** The OS the audio host runs on. Under Electron the preload reports it; in a
 *  plain browser it is only a guess, and only used for wording. */
export const platform: string =
  bridge?.platform ??
  (/Win/i.test(navigator.userAgent) ? 'win32' : /Mac/i.test(navigator.userAgent) ? 'darwin' : 'linux');

export type Backend = 'webaudio' | 'native';

const CONFIG_KEY = 'sampler.audio.config';
const BACKEND_KEY = 'sampler.audio.backend';

export interface CaptureChunk {
  sampleRate: number;
  channels: Float32Array[];
}

class AudioOutput {
  backend: Backend = 'webaudio';
  config: StreamConfig = defaultStreamConfig(platform);
  apis: ApiDevices[] = [];
  status: StreamStatus | null = null;
  lastError: string | null = null;

  private instrument: Instrument | null = null;
  private sentSamples = new Set<string>();
  private outputPeak = 0;
  private inputPeak = 0;
  private voices = 0;
  private listeners = new Set<() => void>();
  private captureSink: ((chunk: CaptureChunk) => void) | null = null;
  private started = false;

  constructor() {
    try {
      const saved = localStorage.getItem(CONFIG_KEY);
      if (saved) this.config = { ...this.config, ...(JSON.parse(saved) as StreamConfig) };
      // A config carried over from another OS (a synced profile, a copied
      // userData folder) names an API this platform cannot open.
      if (!platformApis(platform).includes(this.config.api)) {
        this.config = { ...this.config, api: defaultStreamConfig(platform).api, outputDeviceId: null, inputDeviceId: null };
      }
      const b = localStorage.getItem(BACKEND_KEY);
      if (b === 'native' && hasNativeAudio) this.backend = 'native';
    } catch {
      /* fall back to defaults */
    }

    bridge?.onEvent((e) => this.onHostEvent(e));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private persist(): void {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(this.config));
    localStorage.setItem(BACKEND_KEY, this.backend);
  }

  // -------------------------------------------------------------------------
  // Host events
  // -------------------------------------------------------------------------

  private onHostEvent(e: HostEvent): void {
    switch (e.type) {
      case 'devices':
        this.apis = e.apis;
        this.notify();
        break;
      case 'status':
        this.status = e.status;
        if (e.status.error) this.lastError = e.status.error;
        this.notify();
        break;
      case 'meter':
        this.outputPeak = e.output;
        this.inputPeak = e.input;
        this.voices = e.voices;
        break;
      case 'capture':
        this.captureSink?.({ sampleRate: e.sampleRate, channels: e.channels });
        break;
      case 'error':
        this.lastError = e.message;
        this.notify();
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  /** Ask the host to enumerate every API. Results arrive via onChange. */
  async refreshDevices(): Promise<void> {
    if (!bridge) return;
    await bridge.start();
    bridge.send({ type: 'enumerate' });
  }

  /** Chromium's own device list, for the Web Audio backend. */
  async webAudioDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    try {
      // Labels are blank until microphone permission has been granted once.
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
        for (const t of s.getTracks()) t.stop();
      });
    } catch {
      /* permission refused — the list still works, just unlabelled */
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: all.filter((d) => d.kind === 'audioinput'),
      outputs: all.filter((d) => d.kind === 'audiooutput'),
    };
  }

  setConfig(patch: Partial<StreamConfig>): void {
    this.config = { ...this.config, ...patch };
    this.persist();
    this.notify();
  }

  async setBackend(backend: Backend): Promise<void> {
    if (backend === this.backend) return;
    this.allNotesOff();
    if (this.backend === 'native') bridge?.send({ type: 'close' });
    this.backend = backend;
    this.sentSamples.clear();
    this.persist();
    this.started = false;
    await this.start();
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<boolean> {
    this.lastError = null;
    if (this.backend === 'native') {
      if (!bridge) {
        this.lastError = 'Native audio needs the desktop app.';
        return false;
      }
      await bridge.start();
      bridge.send({ type: 'open', config: this.config });
      this.started = true;
      if (this.instrument) this.pushInstrument(this.instrument);
      return true;
    }
    await webEngine.start();
    await this.applyWebOutputDevice();
    this.started = true;
    return webEngine.running;
  }

  /** Route the Web Audio backend to the chosen output, where supported. */
  private async applyWebOutputDevice(): Promise<void> {
    const id = this.webOutputDeviceId;
    if (!id) return;
    const ctx = webEngine.context as
      | (AudioContext & { setSinkId?: (id: string) => Promise<void> })
      | null;
    if (!ctx?.setSinkId) return;
    try {
      await ctx.setSinkId(id);
    } catch (e) {
      this.lastError = `Could not switch output: ${(e as Error).message}`;
    }
  }

  /** Web Audio output device, stored separately from the RtAudio numeric id. */
  webOutputDeviceId: string = localStorage.getItem('sampler.audio.webOut') ?? '';
  webInputDeviceId: string = localStorage.getItem('sampler.audio.webIn') ?? '';

  setWebDevices(input: string, output: string): void {
    this.webInputDeviceId = input;
    this.webOutputDeviceId = output;
    localStorage.setItem('sampler.audio.webIn', input);
    localStorage.setItem('sampler.audio.webOut', output);
    void this.applyWebOutputDevice();
    this.notify();
  }

  get running(): boolean {
    if (this.backend === 'native') return !!this.status?.running;
    return webEngine.running;
  }

  get latencyMs(): number {
    if (this.backend === 'native') return this.status?.latencyMs ?? 0;
    const ctx = webEngine.context;
    if (!ctx) return 0;
    return (ctx.baseLatency + (ctx.outputLatency || 0)) * 1000;
  }

  get voiceCount(): number {
    return this.backend === 'native' ? this.voices : 0;
  }

  // -------------------------------------------------------------------------
  // Instrument and samples
  // -------------------------------------------------------------------------

  setInstrument(inst: Instrument | null): void {
    this.instrument = inst;
    webEngine.setInstrument(inst);
    if (this.backend === 'native' && this.started) this.pushInstrument(inst);
  }

  private pushInstrument(inst: Instrument | null): void {
    if (!bridge) return;
    bridge.send({ type: 'instrument', instrument: inst });
    // A freshly started host knows nothing of the UI's chosen articulation.
    bridge.send({ type: 'articulation', id: this.articulationId });
    if (inst) this.syncSamples(inst);
  }

  /**
   * Make sure the host has audio for every sample the instrument references.
   *
   * Disk-backed samples are sent by path so the host decodes them itself —
   * a large library would otherwise be copied twice through IPC. Samples that
   * exist only in memory (recorded takes, generated repitches) are sent as
   * float data, which is a one-off cost and keeps them from needing a temp file.
   */
  private syncSamples(inst: Instrument): void {
    if (!bridge) return;
    for (const sample of inst.samples) {
      if (this.sentSamples.has(sample.id)) continue;
      const audio = sampleStore.get(sample.id);
      if (!audio) continue;

      if (sample.path && !sample.processed && !sample.derivedFrom) {
        bridge.send({ type: 'sampleFromPath', id: sample.id, path: sample.path });
      } else {
        bridge.send({
          type: 'sampleFromData',
          id: sample.id,
          sampleRate: audio.sampleRate,
          channels: audio.channels.map((c) => c.slice()),
        });
      }
      this.sentSamples.add(sample.id);
    }
  }

  /** Drop cached audio for a sample after it has been reprocessed. */
  invalidate(sampleId: string): void {
    webEngine.invalidate(sampleId);
    this.sentSamples.delete(sampleId);
    if (this.backend === 'native' && bridge) {
      bridge.send({ type: 'dropSample', id: sampleId });
      const audio = sampleStore.get(sampleId);
      if (audio) {
        bridge.send({
          type: 'sampleFromData',
          id: sampleId,
          sampleRate: audio.sampleRate,
          channels: audio.channels.map((c) => c.slice()),
        });
        this.sentSamples.add(sampleId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Playing
  // -------------------------------------------------------------------------

  noteOn(key: number, velocity = 100): void {
    if (this.backend === 'native') bridge?.send({ type: 'noteOn', key, velocity });
    else webEngine.noteOn(key, velocity);
  }

  noteOff(key: number): void {
    if (this.backend === 'native') bridge?.send({ type: 'noteOff', key });
    else webEngine.noteOff(key);
  }

  /**
   * The articulation used for audition, chosen from the UI rather than by
   * playing a keyswitch. Held here so it survives backend switches and is
   * re-sent to a freshly started native host.
   */
  private articulationId: string | null = null;

  get auditionArticulation(): string | null {
    return this.articulationId;
  }

  setArticulation(id: string | null): void {
    this.articulationId = id;
    webEngine.setArticulation(id);
    if (this.backend === 'native') bridge?.send({ type: 'articulation', id });
  }

  setSustainPedal(down: boolean): void {
    if (this.backend === 'native') bridge?.send({ type: 'sustain', down });
    else webEngine.setSustainPedal(down);
  }

  allNotesOff(): void {
    if (this.backend === 'native') bridge?.send({ type: 'panic' });
    webEngine.allNotesOff();
  }

  previewSample(sampleId: string, startFrame = 0, endFrame = -1): void {
    if (this.backend === 'native') {
      // The host has no standalone preview path; auditioning a raw take is a
      // Web Audio job either way and does not need driver latency.
      void webEngine.start().then(() => webEngine.previewSample(sampleId, startFrame, endFrame));
      return;
    }
    webEngine.previewSample(sampleId, startFrame, endFrame);
  }

  level(): number {
    return this.backend === 'native' ? this.outputPeak : webEngine.level();
  }

  inputLevel(): number {
    return this.inputPeak;
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /** Route input frames from the native host to a sink. Returns a stopper. */
  captureTo(sink: (chunk: CaptureChunk) => void): () => void {
    this.captureSink = sink;
    bridge?.send({ type: 'startCapture' });
    return () => {
      bridge?.send({ type: 'stopCapture' });
      this.captureSink = null;
    };
  }

  get canCaptureNatively(): boolean {
    return (
      this.backend === 'native' &&
      !!this.status?.running &&
      this.config.inputDeviceId != null &&
      this.config.inputChannels > 0
    );
  }

  /** WAV bytes for a captured buffer, used when writing takes to disk. */
  static toWav(channels: Float32Array[], sampleRate: number): Uint8Array {
    return encodeWav(channels, sampleRate, { bitDepth: 24 });
  }
}

export const audio = new AudioOutput();

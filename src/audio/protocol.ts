// ============================================================================
// Protocol between the renderer and the audio host process.
//
// The host owns RtAudio and does all native rendering. It runs as a separate
// Electron utilityProcess rather than on the main thread: RtAudio's output
// queue has to be fed on time, and sharing a thread with window management, IPC
// and GC is how you get dropouts.
// ============================================================================

import type { Instrument } from '../core/types';

/** RtAudio's API enum. Verified against audify 1.10 — the Windows values are
 *  6/7/8, which is easy to get wrong by counting the enum on Linux. */
export const enum AudioApi {
  Unspecified = 0,
  MacOsCore = 1,
  LinuxAlsa = 2,
  UnixJack = 3,
  LinuxPulse = 4,
  LinuxOss = 5,
  WindowsAsio = 6,
  WindowsWasapi = 7,
  WindowsDirectSound = 8,
}

export const API_LABELS: Record<number, string> = {
  [AudioApi.WindowsWasapi]: 'WASAPI',
  [AudioApi.WindowsAsio]: 'ASIO',
  [AudioApi.WindowsDirectSound]: 'DirectSound',
  [AudioApi.MacOsCore]: 'Core Audio',
  [AudioApi.LinuxAlsa]: 'ALSA',
  [AudioApi.UnixJack]: 'JACK',
  [AudioApi.LinuxPulse]: 'PulseAudio',
  [AudioApi.LinuxOss]: 'OSS',
};

export interface AudioDevice {
  id: number;
  name: string;
  inputChannels: number;
  outputChannels: number;
  duplexChannels: number;
  isDefaultInput: boolean;
  isDefaultOutput: boolean;
  sampleRates: number[];
  preferredSampleRate: number;
}

export interface ApiDevices {
  api: number;
  label: string;
  /** What RtAudio reports it actually opened — not always what was asked for. */
  actualName: string;
  devices: AudioDevice[];
  /** Set when the whole API failed to initialise. */
  error?: string;
  /** Drivers that are installed but could not be probed (typically ASIO
   *  hardware that is not plugged in). Shown so their absence is explicable. */
  unavailable: string[];
}

export interface StreamConfig {
  api: number;
  outputDeviceId: number | null;
  outputChannels: number;
  outputFirstChannel: number;
  inputDeviceId: number | null;
  inputChannels: number;
  inputFirstChannel: number;
  sampleRate: number;
  /** 0 lets the driver choose, which is required for ASIO. */
  frameSize: number;
  minimizeLatency: boolean;
}

export interface StreamStatus {
  open: boolean;
  running: boolean;
  api: string;
  sampleRate: number;
  frameSize: number;
  /** Round-trip latency in frames, as reported by the driver. */
  latencyFrames: number;
  latencyMs: number;
  /** True when the driver reported nothing and this is a buffer-size estimate.
   *  WASAPI commonly returns 0, and showing "0.0 ms" would be a lie. */
  latencyEstimated: boolean;
  error?: string;
}

export const defaultStreamConfig = (): StreamConfig => ({
  api: AudioApi.WindowsWasapi,
  outputDeviceId: null,
  outputChannels: 2,
  outputFirstChannel: 0,
  inputDeviceId: null,
  inputChannels: 1,
  inputFirstChannel: 0,
  sampleRate: 48000,
  frameSize: 512,
  minimizeLatency: true,
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type HostRequest =
  | { type: 'enumerate' }
  | { type: 'open'; config: StreamConfig }
  | { type: 'close' }
  | { type: 'status' }
  | { type: 'instrument'; instrument: Instrument | null }
  | { type: 'sampleFromPath'; id: string; path: string }
  | { type: 'sampleFromData'; id: string; sampleRate: number; channels: Float32Array[] }
  | { type: 'dropSample'; id: string }
  | { type: 'clearSamples' }
  | { type: 'noteOn'; key: number; velocity: number }
  | { type: 'noteOff'; key: number }
  | { type: 'sustain'; down: boolean }
  | { type: 'panic' }
  | { type: 'previewSample'; id: string; startFrame: number; endFrame: number }
  | { type: 'startCapture' }
  | { type: 'stopCapture' };

export type HostEvent =
  | { type: 'devices'; apis: ApiDevices[] }
  | { type: 'status'; status: StreamStatus }
  | { type: 'meter'; output: number; input: number; voices: number }
  | { type: 'capture'; sampleRate: number; channels: Float32Array[] }
  | { type: 'sampleReady'; id: string; ok: boolean }
  | { type: 'error'; message: string };

/** Requests are answered by matching id, so several can be in flight. */
export interface Envelope<T> {
  id: number;
  payload: T;
}

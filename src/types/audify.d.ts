// Module declaration for audify.
//
// The shipped index.d.ts declares RtAudioApi / RtAudioFormat / RtAudioStreamFlags
// as non-exported `declare const enum`, so they cannot be imported even though
// index.js exports them as real runtime objects. This declares the surface we
// actually use, matching the runtime values verified against audify 1.10.1.

declare module 'audify' {
  export interface RtAudioDeviceInfo {
    id: number;
    name: string;
    outputChannels: number;
    inputChannels: number;
    duplexChannels: number;
    isDefaultOutput: number;
    isDefaultInput: number;
    sampleRates: number[];
    preferredSampleRate: number;
    nativeFormats: number;
  }

  export interface RtAudioStreamParameters {
    deviceId?: number;
    nChannels: number;
    firstChannel?: number;
  }

  export const RtAudioApi: {
    UNSPECIFIED: 0;
    MACOSX_CORE: 1;
    LINUX_ALSA: 2;
    UNIX_JACK: 3;
    LINUX_PULSE: 4;
    LINUX_OSS: 5;
    WINDOWS_ASIO: 6;
    WINDOWS_WASAPI: 7;
    WINDOWS_DS: 8;
    RTAUDIO_DUMMY: 9;
  };

  export const RtAudioFormat: {
    RTAUDIO_SINT8: 0x1;
    RTAUDIO_SINT16: 0x2;
    RTAUDIO_SINT24: 0x4;
    RTAUDIO_SINT32: 0x8;
    RTAUDIO_FLOAT32: 0x10;
    RTAUDIO_FLOAT64: 0x20;
  };

  export const RtAudioStreamFlags: {
    RTAUDIO_NONINTERLEAVED: 0x1;
    RTAUDIO_MINIMIZE_LATENCY: 0x2;
    RTAUDIO_HOG_DEVICE: 0x4;
    RTAUDIO_SCHEDULE_REALTIME: 0x8;
    RTAUDIO_ALSA_USE_DEFAULT: 0x10;
    RTAUDIO_JACK_DONT_CONNECT: 0x20;
  };

  export const RtAudioErrorType: Record<string, number>;

  export class RtAudio {
    constructor(api?: number);
    outputVolume: number;
    streamTime: number;
    openStream(
      outputParameters: RtAudioStreamParameters | null,
      inputParameters: RtAudioStreamParameters | null,
      format: number,
      sampleRate: number,
      frameSize: number,
      streamName: string,
      inputCallback: ((inputData: Buffer) => void) | null,
      frameOutputCallback: (() => void) | null,
      flags?: number,
      errorCallback?: ((type: number, msg: string) => void) | null,
    ): number;
    closeStream(): void;
    isStreamOpen(): boolean;
    start(): void;
    stop(): void;
    isStreamRunning(): boolean;
    write(pcm: Buffer): void;
    clearOutputQueue(): void;
    getApi(): string;
    getStreamLatency(): number;
    getStreamSampleRate(): number;
    getDevices(): RtAudioDeviceInfo[];
    getDefaultInputDevice(): number;
    getDefaultOutputDevice(): number;
  }
}

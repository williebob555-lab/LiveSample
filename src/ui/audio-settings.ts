// ============================================================================
// Audio device settings.
//
// Two backends, deliberately presented as one choice with honest consequences:
// Web Audio is zero-setup but shared-mode only, native gives the platform's
// own drivers (WASAPI / ASIO / DirectSound, or PulseAudio / ALSA on Linux) with
// real buffer control. The dialog always shows the *actual*
// API and latency the driver reported, not what was requested — RtAudio quietly
// falls back to a working API when the requested one is unavailable, and
// hiding that would be lying to the user about what they are recording through.
// ============================================================================

import { modal, toast } from './app';
import { el, clear } from './dom';
import { field, checkbox, selectBox } from './primitives';
import { audio, hasNativeAudio, platform, type Backend } from '../audio/output';
import {
  AudioApi,
  API_LABELS,
  platformApis,
  platformApiSummary,
  type ApiDevices,
  type AudioDevice,
} from '../audio/protocol';

const isLinux = platform === 'linux';
const osName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'the system';

const SAMPLE_RATES = [44100, 48000, 88200, 96000];
const FRAME_SIZES = [0, 64, 128, 256, 512, 1024, 2048];

const frameLabel = (n: number): string => (n === 0 ? 'Driver default' : String(n));

function apiOf(apis: ApiDevices[], api: number): ApiDevices | undefined {
  return apis.find((a) => a.api === api);
}

export function openAudioSettings(): void {
  const body = el('div');
  let unsubscribe: (() => void) | null = null;

  const render = (): void => {
    clear(body);
    body.append(backendSection(render));
    if (audio.backend === 'native') body.append(...nativeSections(render));
    else body.append(webAudioSection());
    body.append(statusSection());
  };

  unsubscribe = audio.onChange(render);
  render();

  if (audio.backend === 'native') void audio.refreshDevices();

  modal({
    title: 'Audio devices',
    body,
    wide: true,
    cancelLabel: 'Close',
    confirmLabel: 'Apply',
    onConfirm: async () => {
      unsubscribe?.();
      const ok = await audio.start();
      toast(ok ? 'Audio device opened' : (audio.lastError ?? 'Could not open the device'), ok ? 'info' : 'err');
    },
  });
}

// ---------------------------------------------------------------------------

function backendSection(rerender: () => void): HTMLElement {
  const options: { value: Backend; label: string }[] = [
    { value: 'webaudio', label: 'System (Web Audio)' },
    { value: 'native', label: `Native driver (${platformApiSummary(platform) || 'RtAudio'})` },
  ];

  return el('div', { class: 'section' }, [
    el('h3', { text: 'Backend' }),
    field(
      'Engine',
      selectBox(
        hasNativeAudio ? options : options.slice(0, 1),
        audio.backend,
        (v) => {
          void audio.setBackend(v).then(rerender);
        },
      ),
    ),
    el('div', {
      class: 'notice',
      text:
        audio.backend === 'native'
          ? isLinux
            ? 'Native gives you PulseAudio (served by PipeWire on Fedora and most current desktops) and raw ALSA, with a real buffer-size control.'
            : 'Native gives you ASIO and low-latency WASAPI with a real buffer-size control. ASIO drivers are exclusive — close other audio software first.'
          : isLinux
            ? 'Uses whatever the desktop mixer is doing. No setup, but buffer size and latency are out of your hands.'
            : `Uses whatever ${osName} is already doing. No setup, but shared-mode only, so latency is higher and ASIO interfaces are not addressable.`,
    }),
    !hasNativeAudio
      ? el('div', { class: 'notice warn', text: 'Native drivers need the desktop app.' })
      : null,
  ]);
}

// ---------------------------------------------------------------------------

function nativeSections(rerender: () => void): HTMLElement[] {
  const cfg = audio.config;
  const apis = audio.apis;
  const current = apiOf(apis, cfg.api);

  const apiOptions = platformApis(platform).map(
    (a) => {
      const entry = apiOf(apis, a);
      const count = entry?.devices.length ?? 0;
      return {
        value: String(a),
        label: `${API_LABELS[a]}${entry ? ` — ${count} device${count === 1 ? '' : 's'}` : ''}${entry?.error ? ' (unavailable)' : ''}`,
      };
    },
  );

  const outputs = (current?.devices ?? []).filter((d) => d.outputChannels > 0);
  const inputs = (current?.devices ?? []).filter((d) => d.inputChannels > 0);

  const deviceOptions = (list: AudioDevice[], kind: 'in' | 'out') => [
    { value: '', label: kind === 'in' ? 'No input' : 'No output' },
    ...list.map((d) => ({
      value: String(d.id),
      label: `${d.name}${(kind === 'in' ? d.isDefaultInput : d.isDefaultOutput) ? '  (default)' : ''}`,
    })),
  ];

  const maxOut = outputs.find((d) => d.id === cfg.outputDeviceId)?.outputChannels ?? 2;
  const maxIn = inputs.find((d) => d.id === cfg.inputDeviceId)?.inputChannels ?? 2;

  const driver = el('div', { class: 'section' }, [
    el('h3', { text: 'Driver' }),
    field(
      'API',
      selectBox(apiOptions, String(cfg.api), (v) => {
        // Device ids are per-API and are not comparable across them.
        audio.setConfig({ api: Number(v), outputDeviceId: null, inputDeviceId: null });
        rerender();
      }),
      el('button', {
        class: 'sm ghost',
        text: 'Rescan',
        onclick: () => void audio.refreshDevices(),
      }),
    ),
    current?.error ? el('div', { class: 'notice danger', text: current.error }) : null,
    current?.unavailable.length
      ? el('div', { class: 'notice warn' }, [
          el('strong', { text: 'Installed but not available: ' }),
          current.unavailable.join(', '),
          el('br'),
          'These drivers are on the system but did not respond — usually the interface is not plugged in, or another program has it open.',
        ])
      : null,
  ]);

  const devices = el('div', { class: 'section' }, [
    el('h3', { text: 'Devices' }),
    field(
      'Output',
      selectBox(
        deviceOptions(outputs, 'out'),
        cfg.outputDeviceId == null ? '' : String(cfg.outputDeviceId),
        (v) => audio.setConfig({ outputDeviceId: v === '' ? null : Number(v) }),
      ),
    ),
    field(
      'Out channels',
      selectBox(
        Array.from({ length: Math.max(1, Math.min(maxOut, 8)) }, (_x, i) => ({
          value: String(i + 1),
          label: String(i + 1),
        })),
        String(cfg.outputChannels),
        (v) => audio.setConfig({ outputChannels: Number(v) }),
      ),
      el('span', { class: 'status', text: 'first channel' }),
      selectBox(
        Array.from({ length: Math.max(1, maxOut) }, (_x, i) => ({
          value: String(i),
          label: String(i + 1),
        })),
        String(cfg.outputFirstChannel),
        (v) => audio.setConfig({ outputFirstChannel: Number(v) }),
      ),
    ),
    field(
      'Input',
      selectBox(
        deviceOptions(inputs, 'in'),
        cfg.inputDeviceId == null ? '' : String(cfg.inputDeviceId),
        (v) => audio.setConfig({ inputDeviceId: v === '' ? null : Number(v) }),
      ),
    ),
    field(
      'In channels',
      selectBox(
        Array.from({ length: Math.max(1, Math.min(maxIn, 8)) }, (_x, i) => ({
          value: String(i + 1),
          label: String(i + 1),
        })),
        String(cfg.inputChannels),
        (v) => audio.setConfig({ inputChannels: Number(v) }),
      ),
      el('span', { class: 'status', text: 'first channel' }),
      selectBox(
        Array.from({ length: Math.max(1, maxIn) }, (_x, i) => ({
          value: String(i),
          label: String(i + 1),
        })),
        String(cfg.inputFirstChannel),
        (v) => audio.setConfig({ inputFirstChannel: Number(v) }),
      ),
    ),
    cfg.api === AudioApi.WindowsAsio
      ? el('div', {
          class: 'notice',
          text:
            'ASIO uses one device for input and output — pick the same interface for both. Buffer size is set in the driver’s own control panel, so leave it on driver default.',
        })
      : null,
    cfg.api === AudioApi.LinuxPulse
      ? el('div', {
          class: 'notice',
          text:
            'PulseAudio shares the device with every other application, so nothing needs closing first. Under PipeWire the buffer you ask for is a request; the latency below is what the server granted.',
        })
      : null,
    cfg.api === AudioApi.LinuxAlsa
      ? el('div', {
          class: 'notice',
          text:
            'ALSA "hw:" devices are exclusive and usually held by PipeWire. Pick the "pipewire" or "default" device to share, or stop PipeWire first for direct hardware access.',
        })
      : null,
  ]);

  const format = el('div', { class: 'section' }, [
    el('h3', { text: 'Format' }),
    field(
      'Sample rate',
      selectBox(
        SAMPLE_RATES.map((r) => ({ value: String(r), label: `${r} Hz` })),
        String(cfg.sampleRate),
        (v) => audio.setConfig({ sampleRate: Number(v) }),
      ),
    ),
    field(
      'Buffer size',
      selectBox(
        FRAME_SIZES.map((f) => ({ value: String(f), label: frameLabel(f) })),
        String(cfg.frameSize),
        (v) => audio.setConfig({ frameSize: Number(v) }),
      ),
      el('span', { class: 'status', text: 'frames' }),
    ),
    checkbox('Ask the driver for lowest latency', cfg.minimizeLatency, (v) =>
      audio.setConfig({ minimizeLatency: v }),
    ),
  ]);

  return [driver, devices, format];
}

// ---------------------------------------------------------------------------

function webAudioSection(): HTMLElement {
  const host = el('div', { class: 'section' }, [
    el('h3', { text: 'Devices' }),
    el('div', { class: 'status', text: 'Loading devices…' }),
  ]);

  void audio.webAudioDevices().then(({ inputs, outputs }) => {
    clear(host);
    host.append(
      el('h3', { text: 'Devices' }),
      field(
        'Output',
        selectBox(
          [
            { value: '', label: 'System default' },
            ...outputs.map((d) => ({ value: d.deviceId, label: d.label || d.deviceId })),
          ],
          audio.webOutputDeviceId,
          (v) => audio.setWebDevices(audio.webInputDeviceId, v),
        ),
      ),
      field(
        'Input',
        selectBox(
          [
            { value: '', label: 'System default' },
            ...inputs.map((d) => ({ value: d.deviceId, label: d.label || d.deviceId })),
          ],
          audio.webInputDeviceId,
          (v) => audio.setWebDevices(v, audio.webOutputDeviceId),
        ),
      ),
      el('div', {
        class: 'notice',
        text: `Buffer size and sample rate are chosen by ${osName} in this mode. Switch to a native driver for control over either.`,
      }),
    );
  });

  return host;
}

// ---------------------------------------------------------------------------

function statusSection(): HTMLElement {
  const s = audio.status;
  const rows: (Node | null)[] = [];

  if (audio.backend === 'native') {
    rows.push(
      field('State', el('span', { class: 'badge ' + (s?.running ? 'ok' : 'warn'), text: s?.running ? 'running' : s?.open ? 'open' : 'stopped' })),
      field('Reported API', el('span', { class: 'num', text: s?.api || '—' })),
      field('Sample rate', el('span', { class: 'num', text: s?.sampleRate ? `${s.sampleRate} Hz` : '—' })),
      field('Buffer', el('span', { class: 'num', text: s?.frameSize ? `${s.frameSize} frames` : '—' })),
      field(
        'Latency',
        el('span', {
          class: 'num',
          text: s?.latencyMs
            ? `${s.latencyEstimated ? '≈' : ''}${s.latencyMs.toFixed(1)} ms (${s.latencyFrames} frames)`
            : '—',
        }),
        s?.latencyEstimated
          ? el('span', { class: 'status', text: 'driver reported none — estimated from buffer' })
          : null,
      ),
    );
  } else {
    rows.push(
      field('State', el('span', { class: 'badge ' + (audio.running ? 'ok' : 'warn'), text: audio.running ? 'running' : 'stopped' })),
      field('Latency', el('span', { class: 'num', text: audio.latencyMs ? `${audio.latencyMs.toFixed(1)} ms` : '—' })),
    );
  }

  if (audio.lastError) rows.push(el('div', { class: 'notice danger', text: audio.lastError }));

  return el('div', { class: 'section' }, [el('h3', { text: 'Status' }), ...rows]);
}

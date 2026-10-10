// End-to-end check of the audio host.
//
// Boots it exactly as the app does (Electron utilityProcess), enumerates every
// API, opens a real stream, and — the part that matters — loads a sample, plays
// a note, and verifies the native renderer actually produced signal. Silence
// from a "running" stream is the failure mode worth catching.
//
//   npx electron scripts/test-host.cjs
const { app, utilityProcess } = require('electron');
const path = require('node:path');

const HOST = path.join(__dirname, '..', 'dist-host', 'host.cjs');
let child = null;
let failures = 0;

const log = (...a) => process.stdout.write(a.join(' ') + '\n');

function check(name, ok, detail) {
  if (!ok) failures++;
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function note(name, ok, detail) {
  log(`  ${ok ? 'ok  ' : 'note'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** One second of A440, the signal we expect to hear back. */
function sine(seconds, hz, sampleRate) {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.5;
  return out;
}

function testInstrument(sampleId) {
  return {
    version: 1,
    id: 'inst_test',
    name: 'Host Test',
    author: '',
    description: '',
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    samples: [],
    articulations: [{ id: 'art', name: 'Sustain', select: { mode: 'always' } }],
    mics: [],
    groups: [
      {
        id: 'grp',
        name: 'Group',
        articulationId: 'art',
        trigger: 'attack',
        roundRobin: 'off',
        chokeGroup: 0,
        gainDb: 0,
        pan: 0,
        ampEnv: { attack: 0.005, decay: 0.3, sustain: 1, release: 0.2 },
        filter: { type: 'off', cutoff: 12000, resonance: 0.7, envAmount: 0, keyTrack: 0, velAmount: 0 },
        filterEnv: { attack: 0.001, decay: 0.3, sustain: 1, release: 0.2 },
        velToGain: 1,
        velCrossfade: 0,
        zones: [
          {
            id: 'zone',
            sampleId,
            keyLow: 0,
            keyHigh: 127,
            rootKey: 69,
            velLow: 1,
            velHigh: 127,
            rrIndex: 1,
            tuneCents: 0,
            gainDb: 0,
            pan: 0,
            startFrame: 0,
            endFrame: 48000,
            loop: { mode: 'forward', start: 0, end: 48000, crossfade: 0 },
            fadeInFrames: 0,
            fadeOutFrames: 0,
          },
        ],
      },
    ],
    master: {
      gainDb: 0,
      tuneCents: 0,
      bendRangeSemis: 2,
      polyphony: 0,
      velocityCurve: 1,
      glideSeconds: 0,
    },
  };
}

app.whenReady().then(() => {
  child = utilityProcess.fork(HOST, [], { serviceName: 'sampler-audio-test', stdio: 'pipe' });
  child.stdout?.on('data', (d) => process.stdout.write('[host] ' + d));
  child.stderr?.on('data', (d) => process.stdout.write('[host:err] ' + d));

  let apis = null;
  let phase = 'enumerate';
  let peakSeen = 0;
  let voicesSeen = 0;
  let asioStatus = null;

  child.on('message', (msg) => {
    if (msg.type === 'meter') {
      if (msg.output > peakSeen) peakSeen = msg.output;
      if (msg.voices > voicesSeen) voicesSeen = msg.voices;
      return;
    }

    if (msg.type === 'devices') {
      apis = msg.apis;
      log('\nEnumeration');
      for (const a of apis) {
        log(`  ${a.label.padEnd(12)} ${a.error ? `unavailable (${a.error})` : `${a.devices.length} devices as "${a.actualName}"`}`);
        for (const d of a.devices)
          log(`      id=${String(d.id).padEnd(4)} in=${d.inputChannels} out=${d.outputChannels} ${d.preferredSampleRate}Hz  ${d.name}`);
        if (a.unavailable.length) log(`      installed, not responding: ${a.unavailable.join(', ')}`);
      }

      log('\nEnumeration checks');
      check('host answered enumerate', Array.isArray(apis) && apis.length === 3);
      const wasapi = apis.find((a) => a.label === 'WASAPI');
      check('WASAPI reports devices', !!wasapi && wasapi.devices.length > 0);
      check('WASAPI identifies as WASAPI', !!wasapi && /wasapi/i.test(wasapi.actualName), wasapi?.actualName);
      const asio = apis.find((a) => a.label === 'ASIO');
      check('ASIO probed without crashing', !!asio);
      check('ASIO drivers found', !!asio && asio.devices.length + asio.unavailable.length > 0);
      check('DirectSound probed', !!apis.find((a) => a.label === 'DirectSound'));

      const out = wasapi?.devices.find((d) => d.isDefaultOutput && d.outputChannels > 0)
        ?? wasapi?.devices.find((d) => d.outputChannels > 0);
      if (!out) {
        check('found an output device to test', false);
        return finish();
      }
      log(`\nOpening WASAPI "${out.name}" @ 48000 / 512`);
      phase = 'wasapi';
      child.postMessage({
        type: 'open',
        config: {
          api: 7,
          outputDeviceId: out.id,
          outputChannels: 2,
          outputFirstChannel: 0,
          inputDeviceId: null,
          inputChannels: 0,
          inputFirstChannel: 0,
          sampleRate: 48000,
          frameSize: 512,
          minimizeLatency: true,
        },
      });
      return;
    }

    if (msg.type === 'status' && phase === 'wasapi') {
      // Handle exactly once: closing the stream emits another status, which
      // would otherwise re-enter this whole block with an empty one.
      phase = 'wasapi-done';
      const s = msg.status;
      log('\nStream');
      log(`  api=${s.api} rate=${s.sampleRate} frames=${s.frameSize} latency=${s.latencyEstimated ? '≈' : ''}${s.latencyMs.toFixed(1)}ms`);
      check('stream opened', s.open, s.error || '');
      check('stream running', s.running);
      check('sample rate honoured', s.sampleRate === 48000, String(s.sampleRate));
      check('latency is not reported as zero', s.latencyMs > 0, `${s.latencyMs}`);

      log('\nRendering a note through the native renderer');
      const sr = s.sampleRate;
      child.postMessage({
        type: 'sampleFromData',
        id: 'smp_test',
        sampleRate: sr,
        channels: [sine(1, 440, sr)],
      });
      child.postMessage({ type: 'instrument', instrument: testInstrument('smp_test') });
      setTimeout(() => child.postMessage({ type: 'noteOn', key: 69, velocity: 110 }), 150);

      setTimeout(() => {
        check('renderer produced signal', peakSeen > 0.01, `peak ${peakSeen.toFixed(4)}`);
        check('a voice was allocated', voicesSeen > 0, `${voicesSeen} voices`);
        child.postMessage({ type: 'panic' });
        child.postMessage({ type: 'close' });

        // ASIO is exclusive; if the interface is in use elsewhere this is
        // expected to fail, so it is reported but never fails the suite.
        const asio = apis.find((a) => a.label === 'ASIO');
        const dev = asio?.devices[0];
        if (!dev) {
          note('ASIO stream', false, 'no ASIO device connected');
          return finish();
        }
        log(`\nOpening ASIO "${dev.name}" @ driver default`);
        setTimeout(() => {
          // Only start listening for ASIO status *after* the open is posted —
          // the close above also emits a status, and capturing that instead
          // would report an empty stream and hide the real result.
          phase = 'asio';
          child.postMessage({
            type: 'open',
            config: {
              api: 6,
              outputDeviceId: dev.id,
              outputChannels: Math.min(2, dev.outputChannels),
              outputFirstChannel: 0,
              inputDeviceId: dev.inputChannels > 0 ? dev.id : null,
              inputChannels: dev.inputChannels > 0 ? Math.min(2, dev.inputChannels) : 0,
              inputFirstChannel: 0,
              sampleRate: dev.preferredSampleRate || 48000,
              frameSize: 0,
              minimizeLatency: true,
            },
          });
          setTimeout(() => {
            if (!asioStatus) note('ASIO stream', false, 'no response');
            child.postMessage({ type: 'close' });
            setTimeout(finish, 300);
          }, 6000);
        }, 600);
      }, 1600);
      return;
    }

    if (msg.type === 'status' && phase === 'asio' && !asioStatus) {
      asioStatus = msg.status;
      log('\nASIO');
      log(`  api=${asioStatus.api} rate=${asioStatus.sampleRate} frames=${asioStatus.frameSize} latency=${asioStatus.latencyMs.toFixed(1)}ms`);
      note('ASIO stream opened', asioStatus.open, asioStatus.error || '(no error reported)');
      note('ASIO duplex running', asioStatus.running);
      if (!asioStatus.open) log('  full status: ' + JSON.stringify(asioStatus));
      return;
    }

    if (msg.type === 'error') log(`  [host error] ${msg.message}`);
  });

  setTimeout(() => child.postMessage({ type: 'enumerate' }), 400);
  setTimeout(() => {
    log('\nTIMEOUT — host did not finish');
    failures++;
    finish();
  }, 30000);
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  log(`\n${failures} failure${failures === 1 ? '' : 's'}\n`);
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  app.exit(failures ? 1 : 0);
}

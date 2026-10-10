// End-to-end test of a capture session, with synthetic input instead of a mic.
//
// Launches the REAL built app (dist/ + electron/main.cjs) with
// SAMPLER_TEST_CAPTURE=1, which makes the preload expose a test flag. With it,
// audio/output.ts takes capture blocks from `audio.testFeed()` instead of a
// microphone, and src/main.ts exposes `window.__sampler`. Everything past that
// seam (onset detection, silence end, advance, analysis, retake, save, load)
// is the production code. The test drives the app over the Chrome DevTools
// Protocol.
//
//   npm run test:capture        (builds first)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 9400 + Math.floor(Math.random() * 400);
let failures = 0;
const log = (...a) => process.stdout.write(a.join(' ') + '\n');
function check(name, ok, detail) {
  if (!ok) failures++;
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Launch Electron and attach over CDP
// ---------------------------------------------------------------------------

function launch(userData) {
  const electron = require('electron');
  const args = [
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--autoplay-policy=no-user-gesture-required',
    ROOT,
  ];
  const env = { ...process.env, SAMPLER_TEST_CAPTURE: '1' };
  const useXvfb = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const cmd = useXvfb ? 'xvfb-run' : electron;
  const full = useXvfb ? ['-a', electron, ...args] : args;
  const child = spawn(cmd, full, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.output = () => out;
  return child;
}

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('Electron did not expose a debugging endpoint');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push('exception: ' + (d.exception?.description ?? d.text));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };
  const ready = new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  /** Evaluate an expression (may be async) in the page and return its value. */
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { ready, send, ev, logs, close: () => ws.close() };
}

// ---------------------------------------------------------------------------
// Page-side helpers (synthetic instrument + feeding)
// ---------------------------------------------------------------------------

const PAGE_HELPERS = `
(() => {
  const S = window.__sampler;
  const SR = 48000, BLOCK = 512;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Gaussian room noise, about -66 dBFS rms: a quiet room, not digital zero.
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const noise = (n) => Float32Array.from({ length: n }, () => 0.0005 * gauss());
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const tone = (midi, seconds, level) => {
    const n = Math.floor(seconds * SR), f = hz(midi);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t + h) / h;
      const atk = Math.min(1, t / 0.004);
      const rel = Math.min(1, (seconds - t) / 0.03);
      out[i] = v * 0.35 * level * Math.exp(-t / 0.6) * atk * rel + 0.0005 * gauss();
    }
    return out;
  };
  const feed = (arr) => {
    for (let o = 0; o < arr.length; o += BLOCK) S.audio.testFeed(SR, [arr.slice(o, o + BLOCK)]);
  };
  const label = () => document.querySelector('.session-note')?.textContent ?? null;
  const state = () => document.querySelector('.session-state')?.textContent ?? null;
  const clickPrimary = (text) => {
    const b = [...document.querySelectorAll('.modal-foot button.primary')].find((x) => x.textContent === text);
    if (!b) throw new Error('no "' + text + '" button; modal: ' + document.querySelector('.modal-foot')?.textContent);
    b.click();
  };
  const waitFor = async (fn, ms, what) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); }
    throw new Error('timed out waiting for ' + what + ' (note=' + label() + ', state=' + state() + ')');
  };
  // Room tone while the session measures the noise floor (it waits ~1.2 s).
  const arm = async (first) => {
    await waitFor(() => document.querySelector('.session'), 4000, 'session screen');
    feed(noise(SR));
    await waitFor(() => label() === first, 4000, 'first note ' + first);
  };
  // One take: near-silence, a decaying harmonic tone, then silence until the
  // session moves on by itself.
  const play = async (midi, seconds, level) => {
    const before = label();
    feed(noise(Math.floor(0.3 * SR)));
    const s1 = state();
    feed(tone(midi, seconds, level));
    const s2 = state();
    let fed = 0;
    while (label() === before && document.querySelector('.session') && fed < 4 * SR) {
      feed(noise(BLOCK)); fed += BLOCK;
    }
    return { before, after: label(), preState: s1, toneState: s2, recordingSeen: s2 === 'recording' || s2 === 'listening' && fed > 0, silenceFed: fed / SR };
  };
  window.__t = { SR, BLOCK, noise, tone, feed, label, state, clickPrimary, waitFor, arm, play };
})()`;

// ---------------------------------------------------------------------------

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livesample-capture-'));
  const userData = path.join(tmp, 'userdata');
  const projectDir = path.join(tmp, 'Capture Test.sinst');
  const app = launch(userData);
  let page;
  try {
    log('\nLaunching the app (SAMPLER_TEST_CAPTURE=1)');
    page = cdp(await connect());
    await page.ready;
    await page.send('Runtime.enable');
    let hook = false;
    for (let i = 0; i < 60 && !hook; i++) {
      hook = await page.ev('!!window.__sampler');
      if (!hook) await sleep(500);
    }
    check('app booted with the test hook', hook);
    if (!hook) throw new Error('window.__sampler never appeared');
    await page.ev(PAGE_HELPERS);

    const NOTES = [48, 52, 56, 60]; // C3, E3, G#3, C4 (low 48, high 60, step 4)
    const NAMES = ['C3', 'E3', 'G#3', 'C4'];

    // -- Session ----------------------------------------------------------
    log('\nCapture session: 4 notes, synthetic tones');
    await page.ev(`(() => {
      const S = window.__sampler;
      S.app.instrument.capture = { lowNote: 48, highNote: 60, step: 4, silenceTimeout: 0.6 };
      S.startSession();
      __t.clickPrimary('Start');
    })()`);
    await page.ev(`__t.arm('C3')`);
    check('session armed on the first note', (await page.ev('__t.label()')) === 'C3');

    const plays = [];
    for (let i = 0; i < NOTES.length; i++) plays.push(await page.ev(`__t.play(${NOTES[i]}, 1.0, 1)`));
    check(
      'every note was recorded and the session advanced by itself',
      plays.every((p, i) => p.before === NAMES[i] && p.after !== p.before),
      plays.map((p) => `${p.before}->${p.after}`).join(' '),
    );
    check(
      'silence ended each take after about the 0.6 s timeout',
      plays.every((p) => p.silenceFed > 0.3 && p.silenceFed < 1.5),
      plays.map((p) => p.silenceFed.toFixed(2) + 's').join(' '),
    );
    await page.ev(`__t.waitFor(() => !document.querySelector('.session'), 4000, 'session to close')`);
    check('session closed itself after the last note', true);

    const takes = await page.ev(`(() => {
      const S = window.__sampler;
      return S.app.instrument.samples.map((s) => {
        const a = S.sampleStore.get(s.id);
        const ch = a.channels[0];
        let onset = -1;
        for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > 0.02) { onset = i; break; }
        return { id: s.id, name: s.name, target: s.capture.targetMidi, root: s.analysis.rootMidi,
          cents: s.analysis.cents, conf: s.analysis.confidence, frames: s.frames, audioFrames: a.frames,
          sr: s.sampleRate, onset, onsetAnalysis: s.analysis.onsetFrame };
      });
    })()`);
    check('4 takes', takes.length === 4, `got ${takes.length}`);
    const dev = (t) => (t.root - t.target) * 100 + t.cents;
    for (const t of takes) {
      check(
        `${t.name}: pitch within 20 cents of its note`,
        t.root != null && Math.abs(dev(t)) <= 20,
        `target ${t.target}, detected ${t.root} ${t.cents?.toFixed(1)}c, deviation ${dev(t).toFixed(1)}c, confidence ${t.conf?.toFixed(2)}`,
      );
      check(
        `${t.name}: trimmed to the onset`,
        t.onset >= 0 && t.onset < 2 * 512 + 64 && t.frames > 0.9 * t.sr && t.frames < 2.2 * t.sr,
        `onset at frame ${t.onset} (${((t.onset / t.sr) * 1000).toFixed(1)} ms), length ${(t.frames / t.sr).toFixed(2)} s`,
      );
    }
    check('takes filed in the order played', takes.map((t) => t.target).join() === NOTES.join());

    // -- Map, then retake one note ----------------------------------------
    log('\nMap, then re-record E3 through the retake flow');
    const zones0 = await page.ev(`(() => {
      const S = window.__sampler;
      const g = S.app.group();
      S.autoMap(S.app.instrument.samples, g);
      return g.zones.map((z) => ({ id: z.id, sampleId: z.sampleId, root: z.rootKey }));
    })()`);
    check('auto-map made a zone per take', zones0.length === 4);
    const e3 = takes[1];
    check('E3 has a zone', zones0.some((z) => z.sampleId === e3.id));

    await page.ev(`(() => {
      const S = window.__sampler;
      S.app.selectedSamples = ['${e3.id}'];
      S.startSession(S.app.instrument.samples.filter((s) => s.id === '${e3.id}'));
      __t.clickPrimary('Start');
    })()`);
    await page.ev(`__t.arm('E3')`);
    // Space = "retake this one" while listening. In a retake session the old
    // take must survive it: the zone points at that sample.
    await page.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))`);
    const afterSpace = await page.ev(`(() => {
      const S = window.__sampler;
      return { sampleExists: S.app.instrument.samples.some((s) => s.id === '${e3.id}'),
        stored: S.sampleStore.has('${e3.id}'),
        zoneOk: S.app.group().zones.some((z) => z.sampleId === '${e3.id}'),
        label: __t.label() };
    })()`);
    check(
      'Space during a retake keeps the existing take',
      afterSpace.sampleExists && afterSpace.stored && afterSpace.zoneOk && afterSpace.label === 'E3',
      JSON.stringify(afterSpace),
    );
    const rp = await page.ev(`__t.play(52, 0.6, 0.8)`);
    check('retake recorded and the session ended', rp.before === 'E3' && rp.after !== 'E3', JSON.stringify(rp));
    await page.ev(`__t.waitFor(() => !document.querySelector('.session'), 4000, 'retake session to close')`);

    const after = await page.ev(`(() => {
      const S = window.__sampler;
      const s = S.app.instrument.samples;
      const e = s.find((x) => x.id === '${e3.id}');
      return { count: s.length, ids: s.map((x) => x.id),
        e3: e && { name: e.name, frames: e.frames, root: e.analysis.rootMidi, cents: e.analysis.cents,
          target: e.capture.targetMidi, stored: S.sampleStore.get(e.id).frames },
        zones: S.app.group().zones.map((z) => z.sampleId) };
    })()`);
    check('still 4 takes after the retake', after.count === 4, `got ${after.count}`);
    check('retake replaced in place (same sample id, same order)', !!after.e3 && after.ids.join() === takes.map((t) => t.id).join());
    check('E3 audio is the new recording', !!after.e3 && after.e3.frames !== e3.frames && after.e3.stored === after.e3.frames, `frames ${e3.frames} -> ${after.e3?.frames}`);
    check('E3 zone still points at the sample', after.zones.includes(e3.id) && after.zones.length === 4);
    check(
      'E3 pitch still within 20 cents',
      !!after.e3 && Math.abs((after.e3.root - after.e3.target) * 100 + after.e3.cents) <= 20,
      `${after.e3?.root} ${after.e3?.cents?.toFixed(1)}c`,
    );

    // -- Save, reopen -----------------------------------------------------
    log('\nSave to a .sinst folder, then reopen');
    const saved = await page.ev(`(async () => {
      const S = window.__sampler;
      S.app.instrument.name = 'Capture Test';
      S.app.projectPath = ${JSON.stringify(projectDir)};
      await S.studio.save();
      const inst = S.app.instrument;
      const audio = {};
      for (const s of inst.samples) {
        const a = S.sampleStore.get(s.id);
        audio[s.id] = { frames: a.frames, sr: a.sampleRate, head: Array.from(a.channels[0].slice(0, 4000)) };
      }
      window.__saved = { audio, inst: JSON.parse(JSON.stringify(inst)) };
      return { dirty: S.app.dirty };
    })()`);
    const wavs = fs.existsSync(path.join(projectDir, 'samples')) ? fs.readdirSync(path.join(projectDir, 'samples')) : [];
    check('instrument.json written', fs.existsSync(path.join(projectDir, 'instrument.json')));
    check('4 wav files written', wavs.filter((f) => f.endsWith('.wav')).length === 4, wavs.join(', '));
    check('project marked clean after save', saved.dirty === false);

    const reopened = await page.ev(`(async () => {
      const S = window.__sampler;
      const saved = window.__saved;
      // Wipe the document and the audio so nothing can pass by being cached.
      S.sampleStore.clear();
      const blank = JSON.parse(JSON.stringify(saved.inst));
      blank.samples = []; blank.groups.forEach((g) => (g.zones = []));
      S.app.setInstrument(blank);
      S.app.projectPath = null;
      await S.studio.openPath(${JSON.stringify(projectDir)});
      const inst = S.app.instrument;
      const out = { name: inst.name, path: S.app.projectPath, samples: [], maxErr: 0 };
      for (const s of inst.samples) {
        const a = S.sampleStore.get(s.id);
        const ref = saved.audio[s.id];
        const was = saved.inst.samples.find((x) => x.id === s.id);
        if (!a || !ref) { out.samples.push({ id: s.id, missing: true }); continue; }
        let err = 0;
        for (let i = 0; i < ref.head.length; i++) err = Math.max(err, Math.abs(a.channels[0][i] - ref.head[i]));
        out.maxErr = Math.max(out.maxErr, err);
        out.samples.push({ id: s.id, frames: a.frames, refFrames: ref.frames, sr: a.sampleRate, refSr: ref.sr,
          target: s.capture.targetMidi, savedTarget: was?.capture.targetMidi,
          root: s.analysis.rootMidi, savedRoot: was?.analysis.rootMidi });
      }
      const zs = inst.groups.flatMap((g) => g.zones), sz = saved.inst.groups.flatMap((g) => g.zones);
      out.zones = zs.length;
      out.zonesSame = JSON.stringify(zs) === JSON.stringify(sz);
      out.zoneTargets = zs.every((z) => inst.samples.some((s) => s.id === z.sampleId));
      return out;
    })()`);
    check('reopened as "Capture Test" from the saved path', reopened.name === 'Capture Test' && reopened.path === projectDir);
    check('4 takes after reopening', reopened.samples.length === 4, `got ${reopened.samples.length}`);
    check('every take decoded with audio', reopened.samples.every((s) => !s.missing));
    check(
      'frame counts and sample rate survive',
      reopened.samples.every((s) => s.frames === s.refFrames && s.sr === s.refSr),
      reopened.samples.map((s) => s.frames).join(' '),
    );
    check('audio identical within 24-bit quantisation', reopened.maxErr < 1e-5, `max error ${reopened.maxErr.toExponential(2)}`);
    check('capture target and detected pitch survive', reopened.samples.every((s) => s.target === s.savedTarget && s.root === s.savedRoot));
    check('zones identical and still point at their takes', reopened.zones === 4 && reopened.zonesSame && reopened.zoneTargets);
    const e3r = reopened.samples.find((s) => s.id === e3.id);
    check('the retaken E3 is the one on disk', !!e3r && !!after.e3 && e3r.frames === after.e3.frames);

    const errs = page.logs.filter((l) => !/Autoplay/i.test(l));
    check('no renderer errors', errs.length === 0, errs.join(' | '));
  } catch (e) {
    check('test run', false, e.stack || e.message);
    log('\n--- app output (tail) ---\n' + app.output().split('\n').slice(-25).join('\n'));
  } finally {
    try {
      page?.close();
    } catch {
      /* gone */
    }
    try {
      process.kill(-app.pid, 'SIGKILL');
    } catch {
      app.kill('SIGKILL');
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main();

// ============================================================================
// Envelope and filter displays.
//
// The Refine stage used to render the same zone map as Map, which made it look
// like it did nothing. What actually happens there is voice shaping, so that is
// what it should draw: an ADSR you can grab, and the filter curve it feeds.
// ============================================================================

import type { Envelope, FilterSettings } from '../core/types';
import { el, fitCanvas, cssVar, clamp, onDrag } from './dom';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

type Handle = 'attack' | 'decay' | 'release' | null;

const HANDLE_R = 5;
/** Fraction of the width given to the sustain hold, which has no duration. */
const HOLD = 0.18;

export class EnvelopeView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private env: Envelope = { attack: 0.01, decay: 0.3, sustain: 1, release: 0.3 };
  private timeSpan = 2;
  private hover: Handle = null;
  private dragging: Handle = null;
  private onChange: (env: Envelope) => void;

  constructor(onChange: (env: Envelope) => void) {
    this.onChange = onChange;
    this.canvas = el('canvas');
    this.root = el('div', { class: 'canvas-wrap envelope-view' }, [this.canvas]);

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) return;
      const next = this.handleAt(e);
      if (next !== this.hover) {
        this.hover = next;
        this.canvas.style.cursor = next ? 'grab' : 'default';
        this.draw();
      }
    });

    onDrag(this.canvas, {
      start: (e) => {
        this.dragging = this.handleAt(e);
        if (this.dragging) this.apply(e);
      },
      move: (_dx, _dy, e) => {
        if (this.dragging) this.apply(e);
      },
      end: () => {
        this.dragging = null;
      },
    });

    new ResizeObserver(() => this.draw()).observe(this.root);
  }

  show(env: Envelope): void {
    this.env = env;
    // Recomputed only when the envelope is set from outside, never mid-drag —
    // an axis that rescales under the cursor is impossible to aim with.
    this.timeSpan = clamp(env.attack + env.decay + env.release + 0.4, 1, 16);
    this.draw();
  }

  private geo() {
    const rect = this.canvas.getBoundingClientRect();
    const pad = 16;
    const w = Math.max(1, rect.width - pad * 2);
    const h = Math.max(1, rect.height - pad * 2 - 8);
    const perSecond = (w * (1 - HOLD)) / this.timeSpan;
    return { pad, w, h, perSecond };
  }

  /** Screen points for the envelope corners. */
  private points() {
    const { pad, w, h, perSecond } = this.geo();
    const ax = pad + Math.min(this.env.attack * perSecond, w * 0.4);
    const dx = Math.min(ax + this.env.decay * perSecond, pad + w * (1 - HOLD));
    const sy = pad + h * (1 - this.env.sustain);
    const hx = dx + w * HOLD;
    const rx = Math.min(hx + this.env.release * perSecond, pad + w);
    return {
      start: { x: pad, y: pad + h },
      peak: { x: ax, y: pad },
      sustain: { x: dx, y: sy },
      hold: { x: hx, y: sy },
      end: { x: rx, y: pad + h },
    };
  }

  private handleAt(e: PointerEvent): Handle {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = this.points();
    const near = (px: number, py: number) => Math.hypot(x - px, y - py) < HANDLE_R * 2.6;
    if (near(p.peak.x, p.peak.y)) return 'attack';
    if (near(p.sustain.x, p.sustain.y)) return 'decay';
    if (near(p.end.x, p.end.y)) return 'release';
    return null;
  }

  private apply(e: PointerEvent): void {
    const { pad, h, perSecond } = this.geo();
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = this.points();
    const seconds = (px: number) => clamp(px / perSecond, 0.0005, 16);

    if (this.dragging === 'attack') {
      this.env.attack = seconds(x - pad);
    } else if (this.dragging === 'decay') {
      this.env.decay = seconds(x - p.peak.x);
      this.env.sustain = clamp(1 - (y - pad) / h, 0, 1);
    } else if (this.dragging === 'release') {
      this.env.release = seconds(x - p.hold.x);
    }
    this.onChange(this.env);
    this.draw();
  }

  draw(): void {
    const ctx = fitCanvas(this.canvas);
    if (!ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    const { pad, w, h } = this.geo();

    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = cssVar('--s0') || '#0e0f11';
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.strokeStyle = cssVar('--line-soft') || '#1c1f24';
    ctx.setLineDash([2, 3]);
    for (const frac of [0.25, 0.5, 0.75]) {
      const y = pad + h * frac;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(pad + w, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const p = this.points();
    const accent = cssVar('--accent') || '#d9903f';

    const trace = () => {
      ctx.moveTo(p.start.x, p.start.y);
      ctx.lineTo(p.peak.x, p.peak.y);
      ctx.lineTo(p.sustain.x, p.sustain.y);
      ctx.lineTo(p.hold.x, p.hold.y);
      ctx.lineTo(p.end.x, p.end.y);
    };

    const fill = ctx.createLinearGradient(0, pad, 0, pad + h);
    fill.addColorStop(0, 'rgba(217,144,63,0.22)');
    fill.addColorStop(1, 'rgba(217,144,63,0.02)');
    ctx.beginPath();
    trace();
    ctx.lineTo(p.end.x, pad + h);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    trace();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // The note-off point, which is what the hold segment actually means.
    ctx.strokeStyle = 'rgba(150,160,175,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(p.hold.x, pad);
    ctx.lineTo(p.hold.x, pad + h);
    ctx.stroke();
    ctx.setLineDash([]);

    const font = cssVar('--font-mono') || 'monospace';
    ctx.fillStyle = cssVar('--text-faint') || '#656b75';
    ctx.font = '9px ' + font;
    ctx.textAlign = 'center';
    ctx.fillText('note off', p.hold.x, pad + h + 12);

    for (const entry of [
      ['attack', p.peak],
      ['decay', p.sustain],
      ['release', p.end],
    ] as const) {
      const active = this.hover === entry[0] || this.dragging === entry[0];
      const pt = entry[1];
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, active ? HANDLE_R + 1 : HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = active ? accent : cssVar('--s0') || '#0e0f11';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const fmt = (t: number) => (t < 1 ? Math.round(t * 1000) + ' ms' : t.toFixed(2) + ' s');
    ctx.fillStyle = cssVar('--text-dim') || '#949aa4';
    ctx.textAlign = 'left';
    ctx.fillText(
      'A ' + fmt(this.env.attack) + '   D ' + fmt(this.env.decay) +
        '   S ' + Math.round(this.env.sustain * 100) + '%   R ' + fmt(this.env.release),
      pad,
      pad - 5,
    );
  }
}

// ---------------------------------------------------------------------------
// Filter response
// ---------------------------------------------------------------------------

/** Magnitude response of the same RBJ biquad both engines use, in dB. */
function responseDb(f: FilterSettings, hz: number, sampleRate: number): number {
  const w0 = (2 * Math.PI * clamp(f.cutoff, 20, sampleRate * 0.45)) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.max(0.1, f.resonance));
  const cos = Math.cos(w0);

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  if (f.type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (f.type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;

  const w = (2 * Math.PI * hz) / sampleRate;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2w = Math.cos(2 * w);
  const s2w = Math.sin(2 * w);

  const nr = b0 + b1 * cw + b2 * c2w;
  const ni = -(b1 * sw + b2 * s2w);
  const dr = a0 + a1 * cw + a2 * c2w;
  const di = -(a1 * sw + a2 * s2w);

  const mag = Math.hypot(nr, ni) / Math.max(1e-9, Math.hypot(dr, di));
  return 20 * Math.log10(Math.max(1e-6, mag));
}

export class FilterView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private settings: FilterSettings | null = null;

  constructor() {
    this.canvas = el('canvas');
    this.root = el('div', { class: 'canvas-wrap filter-view' }, [this.canvas]);
    new ResizeObserver(() => this.draw()).observe(this.root);
  }

  show(settings: FilterSettings | null): void {
    this.settings = settings;
    this.draw();
  }

  draw(): void {
    const ctx = fitCanvas(this.canvas);
    if (!ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w < 8 || h < 8) return;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = cssVar('--s0') || '#0e0f11';
    ctx.fillRect(0, 0, w, h);

    const font = cssVar('--font-mono') || 'monospace';
    const minHz = 20;
    const maxHz = 20000;
    const xFor = (hz: number) => (Math.log(hz / minHz) / Math.log(maxHz / minHz)) * w;

    ctx.strokeStyle = cssVar('--line-soft') || '#1c1f24';
    ctx.font = '9px ' + font;
    ctx.textAlign = 'center';
    for (const hz of [100, 1000, 10000]) {
      const x = xFor(hz);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h - 12);
      ctx.stroke();
      ctx.fillStyle = cssVar('--text-faint') || '#656b75';
      ctx.fillText(hz >= 1000 ? hz / 1000 + 'k' : String(hz), x, h - 2);
    }

    if (!this.settings || this.settings.type === 'off') {
      ctx.fillStyle = cssVar('--text-faint') || '#656b75';
      ctx.font = '11px ' + (cssVar('--font') || 'sans-serif');
      ctx.fillText('Filter off — samples pass through unchanged', w / 2, h / 2);
      return;
    }

    // +12 dB at the top, -36 at the bottom: enough to show a resonant peak
    // without flattening everything else.
    const top = 12;
    const bottom = -36;
    const yFor = (db: number) => ((top - db) / (top - bottom)) * (h - 14);

    ctx.strokeStyle = 'rgba(150,160,175,0.18)';
    ctx.beginPath();
    ctx.moveTo(0, yFor(0));
    ctx.lineTo(w, yFor(0));
    ctx.stroke();

    ctx.beginPath();
    for (let px = 0; px <= w; px++) {
      const hz = minHz * Math.pow(maxHz / minHz, px / w);
      const y = yFor(clamp(responseDb(this.settings, hz, 48000), bottom, top));
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = cssVar('--accent') || '#d9903f';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const cx = xFor(clamp(this.settings.cutoff, minHz, maxHz));
    ctx.strokeStyle = 'rgba(217,144,63,0.45)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h - 12);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

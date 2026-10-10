// ============================================================================
// Coverage strip.
//
// One band under the zone map showing, per key, whether anything plays there
// and how far the nearest sample is being stretched to do it. "Max stretch 5
// st" in the status bar is a number you have to interpret; this is the same
// fact as a picture, and it points at exactly which notes are the problem.
//
// Shares KeyProjection with the zone map and the keyboard, so all three line up.
// ============================================================================

import type { Instrument } from '../core/types';
import { el, fitCanvas, cssVar } from './dom';
import { KeyProjection, type KeyRange } from './keyboard';
import { midiName } from '../dsp/pitch';

export interface KeyCoverage {
  /** Zones that respond to this key at any velocity. */
  zones: number;
  /** Smallest distance from this key to a zone's root, in semitones. */
  stretch: number;
  /**
   * True when this key sits outside the range that was actually sampled.
   *
   * The outermost zones are deliberately widened to keys 0 and 127 so the
   * instrument answers across the whole keyboard. Those tails stretch enormously
   * by construction, and counting them as defects would drown out the stretch
   * that genuinely matters — the same reasoning as maxStretch in core/automap.
   */
  extended: boolean;
}

/** Per-key coverage for the whole keyboard. */
export function coverageOf(inst: Instrument): KeyCoverage[] {
  const out: KeyCoverage[] = [];
  for (let key = 0; key < 128; key++)
    out.push({ zones: 0, stretch: Infinity, extended: false });

  const roots = inst.groups.flatMap((g) => g.zones.map((z) => z.rootKey));
  const lowestRoot = roots.length ? Math.min(...roots) : 0;
  const highestRoot = roots.length ? Math.max(...roots) : 127;

  for (const group of inst.groups) {
    for (const zone of group.zones) {
      const lo = Math.max(0, zone.keyLow);
      const hi = Math.min(127, zone.keyHigh);
      for (let key = lo; key <= hi; key++) {
        const entry = out[key];
        entry.zones++;
        entry.stretch = Math.min(entry.stretch, Math.abs(key - zone.rootKey));
      }
    }
  }

  for (let key = 0; key < 128; key++)
    out[key].extended = key < lowestRoot || key > highestRoot;

  return out;
}

/** How bad a given stretch is, 0..1, for colouring. */
function severity(stretch: number): number {
  // Under 2 semitones is inaudible on almost anything; past 6 it shows on
  // nearly everything. The ramp between is where judgement lives.
  return Math.max(0, Math.min(1, (stretch - 1) / 6));
}

export class CoverageStrip {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private instrument: Instrument | null = null;
  private range: KeyRange = { low: 21, high: 108 };
  private hoverKey: number | null = null;
  private readout: HTMLElement;

  constructor() {
    this.canvas = el('canvas');
    this.readout = el('div', { class: 'coverage-readout' });
    this.root = el('div', { class: 'coverage-strip' }, [this.canvas, this.readout]);

    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width < 2) return;
      const proj = new KeyProjection(this.range, rect.width);
      this.hoverKey = proj.noteAt(e.clientX - rect.left);
      this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverKey = null;
      this.draw();
    });

    new ResizeObserver(() => this.draw()).observe(this.root);
  }

  setInstrument(inst: Instrument | null): void {
    this.instrument = inst;
    this.draw();
  }

  setRange(range: KeyRange): void {
    this.range = range;
    this.draw();
  }

  draw(): void {
    const ctx = fitCanvas(this.canvas);
    if (!ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w < 4 || h < 4) return;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = cssVar('--s0') || '#0e0f11';
    ctx.fillRect(0, 0, w, h);

    if (!this.instrument) return;
    const cov = coverageOf(this.instrument);
    const proj = new KeyProjection(this.range, w);
    const step = w / Math.max(1, this.range.high - this.range.low + 1);

    let covered = 0;
    let worst = 0;
    let worstKey = -1;

    for (let key = this.range.low; key <= this.range.high; key++) {
      const entry = cov[key];
      const x = proj.x(key);
      const width = Math.max(1, step);

      if (!entry.zones) {
        // Unmapped keys read as holes, not as "fine".
        ctx.fillStyle = 'rgba(217,95,95,0.30)';
        ctx.fillRect(x, 0, width, h);
        continue;
      }
      covered++;
      if (entry.extended) {
        // Reachable, but past the last real recording. Drawn as a neutral wash
        // so it reads as "extended to fill the keyboard", not as a problem.
        ctx.fillStyle = 'rgba(150,160,175,0.16)';
        ctx.fillRect(x, 0, width, h);
        continue;
      }
      const s = severity(entry.stretch);
      if (entry.stretch > worst) {
        worst = entry.stretch;
        worstKey = key;
      }
      // Green through amber: how hard this key is leaning on a distant sample.
      const r = Math.round(110 + s * 107);
      const g = Math.round(191 - s * 47);
      const b = Math.round(115 - s * 52);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.28 + s * 0.45})`;
      ctx.fillRect(x, 0, width, h);

      // A tick where a sample sits unstretched.
      if (entry.stretch === 0) {
        ctx.fillStyle = 'rgba(230,232,236,0.75)';
        ctx.fillRect(x + width / 2 - 0.5, h - 4, 1, 4);
      }
    }

    if (this.hoverKey != null) {
      const x = proj.x(this.hoverKey);
      ctx.strokeStyle = cssVar('--accent') || '#d9903f';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, 0.5, Math.max(1, step) - 1, h - 1);
    }

    const total = this.range.high - this.range.low + 1;
    const pct = Math.round((covered / total) * 100);
    const hovered = this.hoverKey != null ? cov[this.hoverKey] : null;

    if (hovered && this.hoverKey != null) {
      const name = midiName(this.hoverKey);
      this.readout.textContent = !hovered.zones
        ? `${name} — nothing mapped here`
        : hovered.extended
          ? `${name} — extended past the sampled range, stretched ${hovered.stretch} st`
          : `${name} — ${hovered.zones} zone${hovered.zones === 1 ? '' : 's'}, stretched ${hovered.stretch} st`;
    } else {
      this.readout.textContent =
        `${pct}% of the keyboard covered` +
        (worstKey >= 0 && worst > 0
          ? ` · worst stretch ${worst} st at ${midiName(worstKey)}`
          : ' · nothing stretched');
    }
  }
}

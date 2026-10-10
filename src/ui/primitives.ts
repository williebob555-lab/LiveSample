// ============================================================================
// Control primitives.
//
// Written before any screen. Native range inputs and checkboxes are the fastest
// way for an audio interface to look amateur, so nothing here wraps one — the
// knob, fader and meter are canvas-drawn and the rest are styled from scratch.
// ============================================================================

import { el, onDrag, clamp, fitCanvas, cssVar, formatDb } from './dom';

// ---------------------------------------------------------------------------
// Knob
// ---------------------------------------------------------------------------

export interface KnobOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  /** Log taper — right for frequency and time, wrong for pan and mix. */
  curve?: 'linear' | 'log';
  format?: (v: number) => string;
  /** Double-click resets here. */
  default?: number;
  onChange: (v: number) => void;
}

export class Knob {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private valueEl: HTMLElement;
  private opts: KnobOptions;
  private value: number;

  constructor(opts: KnobOptions) {
    this.opts = opts;
    this.value = opts.value;
    this.canvas = el('canvas', { width: 40, height: 40, style: 'width:40px;height:40px' });
    this.valueEl = el('div', { class: 'knob-value' });
    this.root = el('div', { class: 'knob', title: opts.label }, [
      this.canvas,
      this.valueEl,
      el('div', { class: 'knob-label', text: opts.label }),
    ]);

    // Vertical drag, with shift for fine control. 160px of travel covers the
    // full range, which is the range most hardware knobs feel like.
    onDrag(this.root, {
      move: (_dx, dy, e) => {
        const span = this.opts.max - this.opts.min;
        const scale = e.shiftKey ? 0.15 : 1;
        this.setNormalized(this.normalized() - (dy / 160) * scale, true);
        void span;
      },
    });
    this.root.addEventListener('dblclick', () => {
      if (this.opts.default != null) this.set(this.opts.default, true);
    });
    this.root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = e.shiftKey ? 0.02 : 0.06;
      this.setNormalized(this.normalized() - Math.sign(e.deltaY) * scale, true);
    }, { passive: false });

    this.draw();
  }

  private normalized(): number {
    const { min, max, curve } = this.opts;
    if (curve === 'log') {
      const lo = Math.log(Math.max(1e-6, min));
      const hi = Math.log(Math.max(1e-6, max));
      return (Math.log(Math.max(1e-6, this.value)) - lo) / (hi - lo);
    }
    return (this.value - min) / (max - min);
  }

  private setNormalized(n: number, emit: boolean): void {
    const { min, max, curve } = this.opts;
    n = clamp(n, 0, 1);
    let v: number;
    if (curve === 'log') {
      const lo = Math.log(Math.max(1e-6, min));
      const hi = Math.log(Math.max(1e-6, max));
      v = Math.exp(lo + n * (hi - lo));
    } else {
      v = min + n * (max - min);
    }
    this.set(v, emit);
  }

  set(v: number, emit = false): void {
    const { min, max, step } = this.opts;
    let next = clamp(v, min, max);
    if (step) next = Math.round(next / step) * step;
    if (next === this.value && !emit) return;
    this.value = next;
    this.draw();
    if (emit) this.opts.onChange(next);
  }

  get(): number {
    return this.value;
  }

  private draw(): void {
    const ctx = fitCanvas(this.canvas);
    if (!ctx) return;
    const w = 40;
    const h = 40;
    const cx = w / 2;
    const cy = h / 2;
    const r = 14;
    // 270 degrees of travel, the pot convention: 7:30 round to 4:30.
    const startA = Math.PI * 0.75;
    const endA = Math.PI * 2.25;
    const n = clamp(this.normalized(), 0, 1);
    const valueA = startA + (endA - startA) * n;

    ctx.clearRect(0, 0, w, h);

    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = cssVar('--s4') || '#2a2f35';
    ctx.beginPath();
    ctx.arc(cx, cy, r, startA, endA);
    ctx.stroke();

    ctx.strokeStyle = cssVar('--accent') || '#d9903f';
    ctx.beginPath();
    ctx.arc(cx, cy, r, startA, valueA);
    ctx.stroke();

    ctx.fillStyle = cssVar('--s3') || '#212529';
    ctx.beginPath();
    ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
    ctx.fill();

    // Pointer line — reads the position faster than the arc alone.
    ctx.strokeStyle = cssVar('--text') || '#e6e8ec';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(valueA) * 4, cy + Math.sin(valueA) * 4);
    ctx.lineTo(cx + Math.cos(valueA) * (r - 5), cy + Math.sin(valueA) * (r - 5));
    ctx.stroke();

    this.valueEl.textContent = this.opts.format
      ? this.opts.format(this.value)
      : this.value.toFixed(2);
  }
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export interface SliderOptions {
  min: number;
  max: number;
  value: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

export class Slider {
  readonly root: HTMLElement;
  private fill: HTMLElement;
  private thumb: HTMLElement;
  private readout: HTMLElement;
  private opts: SliderOptions;
  private value: number;
  private bar: HTMLElement;

  constructor(opts: SliderOptions) {
    this.opts = opts;
    this.value = opts.value;
    this.fill = el('div', { class: 'fill' });
    this.thumb = el('div', { class: 'thumb' });
    this.bar = el('div', { class: 'slider' }, [el('div', { class: 'track' }), this.fill, this.thumb]);
    this.readout = el('div', { class: 'slider-value' });
    this.root = el('div', { class: 'control' }, [this.bar, this.readout]);

    const fromEvent = (e: PointerEvent) => {
      const rect = this.bar.getBoundingClientRect();
      this.setNormalized((e.clientX - rect.left) / Math.max(1, rect.width), true);
    };
    onDrag(this.bar, { start: fromEvent, move: (_dx, _dy, e) => fromEvent(e) });
    this.draw();
  }

  private setNormalized(n: number, emit: boolean): void {
    const { min, max } = this.opts;
    this.set(min + clamp(n, 0, 1) * (max - min), emit);
  }

  set(v: number, emit = false): void {
    const { min, max, step } = this.opts;
    let next = clamp(v, min, max);
    if (step) next = Math.round(next / step) * step;
    this.value = next;
    this.draw();
    if (emit) this.opts.onChange(next);
  }

  get(): number {
    return this.value;
  }

  private draw(): void {
    const { min, max } = this.opts;
    const n = clamp((this.value - min) / (max - min), 0, 1);
    this.fill.style.width = `${n * 100}%`;
    this.thumb.style.left = `${n * 100}%`;
    this.readout.textContent = this.opts.format
      ? this.opts.format(this.value)
      : String(Math.round(this.value));
  }
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export function segmented<T extends string>(
  options: { value: T; label: string }[],
  current: T,
  onChange: (v: T) => void,
): HTMLElement {
  const root = el('div', { class: 'segmented' });
  const buttons = options.map((o) => {
    const b = el('button', {
      text: o.label,
      class: o.value === current ? 'on' : '',
      onclick: () => {
        for (const other of buttons) other.classList.remove('on');
        b.classList.add('on');
        onChange(o.value);
      },
    });
    root.append(b);
    return b;
  });
  return root;
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

export class Meter {
  readonly root: HTMLCanvasElement;
  private peakHold = 0;
  private holdUntil = 0;

  constructor(width = 120, height = 8) {
    this.root = el('canvas', {
      class: 'meter',
      style: `width:${width}px;height:${height}px`,
    });
  }

  /** `level` is linear 0..1. Call from an animation frame. */
  draw(level: number): void {
    const ctx = fitCanvas(this.root);
    if (!ctx) return;
    const rect = this.root.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // dBFS scale from -60 up, which is where the useful resolution is.
    const db = level <= 1e-5 ? -60 : 20 * Math.log10(level);
    const n = clamp((db + 60) / 60, 0, 1);

    const now = performance.now();
    if (n >= this.peakHold) {
      this.peakHold = n;
      this.holdUntil = now + 900;
    } else if (now > this.holdUntil) {
      this.peakHold = Math.max(n, this.peakHold - 0.012);
    }

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, cssVar('--level-low') || '#4f7d55');
    grad.addColorStop(0.72, cssVar('--level-mid') || '#8fbf5f');
    grad.addColorStop(0.9, cssVar('--level-hot') || '#d9b03f');
    grad.addColorStop(1, cssVar('--level-clip') || '#d95f5f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w * n, h);

    if (this.peakHold > 0.01) {
      ctx.fillStyle = this.peakHold > 0.98 ? cssVar('--level-clip') : cssVar('--text-dim');
      ctx.fillRect(clamp(w * this.peakHold - 1, 0, w - 1), 0, 1.5, h);
    }
  }
}

// ---------------------------------------------------------------------------
// Composed rows
// ---------------------------------------------------------------------------

export function field(
  label: string,
  ...controls: (Node | string | null | undefined)[]
): HTMLElement {
  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    el('div', { class: 'control' }, controls),
  ]);
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'check' }, [input, label]);
}

export function selectBox<T extends string>(
  options: { value: T; label: string }[],
  current: T,
  onChange: (v: T) => void,
): HTMLSelectElement {
  const sel = el('select');
  for (const o of options) {
    const opt = el('option', { value: o.value, text: o.label });
    if (o.value === current) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value as T));
  return sel;
}

export function numberField(
  value: number,
  onChange: (v: number) => void,
  attrs: { min?: number; max?: number; step?: number; width?: number } = {},
): HTMLInputElement {
  const input = el('input', {
    type: 'number',
    value: String(value),
    min: attrs.min,
    max: attrs.max,
    step: attrs.step ?? 1,
    style: attrs.width ? `width:${attrs.width}px` : '',
  });
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return input;
}

export function dbKnob(label: string, value: number, onChange: (v: number) => void): Knob {
  return new Knob({
    label,
    min: -24,
    max: 12,
    value,
    default: 0,
    format: (v) => `${formatDb(v)} dB`,
    onChange,
  });
}

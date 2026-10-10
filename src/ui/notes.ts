// ============================================================================
// Note-valued controls.
//
// Anything that means a pitch is shown and edited as a pitch. A MIDI number is
// an implementation detail — nobody thinks "sample from 48 to 72", they think
// "C3 to C5", and making the musician translate is a small tax paid on every
// single interaction.
//
// NoteField   one note, typed or nudged
// NoteRange   two handles on one track, for a low/high span
// ============================================================================

import { el, fitCanvas, cssVar, clamp, onDrag } from './dom';
import { midiName, parseNote } from '../dsp/pitch';
import { isBlackKey, whiteIndex } from './keyboard';

// ---------------------------------------------------------------------------
// NoteField
// ---------------------------------------------------------------------------

export interface NoteFieldOptions {
  value: number;
  min?: number;
  max?: number;
  onChange: (midi: number) => void;
  width?: number;
}

export class NoteField {
  readonly root: HTMLInputElement;
  private value: number;
  private opts: NoteFieldOptions;

  constructor(opts: NoteFieldOptions) {
    this.opts = opts;
    this.value = opts.value;
    this.root = el('input', {
      type: 'text',
      class: 'num note-field',
      value: midiName(opts.value),
      spellcheck: false,
      title: 'Note name (C3, F#4, Bb2). Arrow keys or the wheel step by semitone.',
      style: `width:${opts.width ?? 64}px;text-align:center`,
    });

    this.root.addEventListener('change', () => this.commitText());
    this.root.addEventListener('blur', () => this.commitText());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        // Shift jumps an octave — the step you actually want most of the time
        // when moving a root note around.
        const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        this.set(this.value + step, true);
      } else if (e.key === 'Enter') {
        this.commitText();
      }
    });
    this.root.addEventListener(
      'wheel',
      (e) => {
        if (document.activeElement !== this.root) return;
        e.preventDefault();
        this.set(this.value - Math.sign(e.deltaY) * (e.shiftKey ? 12 : 1), true);
      },
      { passive: false },
    );
  }

  /** Reject anything unparseable and restore, rather than write a wrong pitch. */
  private commitText(): void {
    const parsed = parseNote(this.root.value);
    if (parsed == null) {
      this.root.value = midiName(this.value);
      return;
    }
    this.set(parsed, true);
  }

  set(midi: number, emit = false): void {
    const next = clamp(Math.round(midi), this.opts.min ?? 0, this.opts.max ?? 127);
    const changed = next !== this.value;
    this.value = next;
    this.root.value = midiName(next);
    if (emit && changed) this.opts.onChange(next);
  }

  get(): number {
    return this.value;
  }
}

export function noteField(
  value: number,
  onChange: (midi: number) => void,
  opts: { min?: number; max?: number; width?: number } = {},
): HTMLInputElement {
  return new NoteField({ value, onChange, ...opts }).root;
}

// ---------------------------------------------------------------------------
// NoteRange
// ---------------------------------------------------------------------------

export interface NoteRangeOptions {
  low: number;
  high: number;
  min?: number;
  max?: number;
  /** Keep at least this many semitones between the handles. */
  minSpan?: number;
  onChange: (low: number, high: number) => void;
  /** Live feedback while dragging, before the gesture ends. */
  onInput?: (low: number, high: number) => void;
}

/**
 * Two handles on one track over a piano-shaped scale.
 *
 * The track draws the black keys as darker bands, so the position reads as a
 * place on a keyboard rather than a percentage. Handles snap to semitones and
 * cannot cross.
 */
export class NoteRange {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private lowLabel: HTMLElement;
  private highLabel: HTMLElement;
  private spanLabel: HTMLElement;
  private low: number;
  private high: number;
  private opts: NoteRangeOptions;
  private dragging: 'low' | 'high' | null = null;

  constructor(opts: NoteRangeOptions) {
    this.opts = opts;
    this.low = opts.low;
    this.high = opts.high;

    this.canvas = el('canvas', { class: 'nr-canvas' });
    this.lowLabel = el('span', { class: 'nr-value num' });
    this.highLabel = el('span', { class: 'nr-value num' });
    this.spanLabel = el('span', { class: 'nr-span' });

    this.root = el('div', { class: 'note-range' }, [
      el('div', { class: 'nr-head' }, [
        this.lowLabel,
        this.spanLabel,
        this.highLabel,
      ]),
      this.canvas,
    ]);

    const pick = (e: PointerEvent): void => {
      const midi = this.midiAt(e);
      // Grab whichever handle is nearer, so clicking anywhere on the track
      // moves the sensible one instead of always the same one.
      this.dragging =
        Math.abs(midi - this.low) <= Math.abs(midi - this.high) ? 'low' : 'high';
      this.apply(midi);
    };

    onDrag(this.canvas, {
      start: pick,
      move: (_dx, _dy, e) => this.apply(this.midiAt(e)),
      end: () => {
        this.dragging = null;
        this.opts.onChange(this.low, this.high);
      },
    });

    new ResizeObserver(() => this.draw()).observe(this.root);
    this.refresh();
  }

  private get minMidi(): number {
    return this.opts.min ?? 21;
  }
  private get maxMidi(): number {
    return this.opts.max ?? 108;
  }

  private midiAt(e: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    const t = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    return Math.round(this.minMidi + t * (this.maxMidi - this.minMidi));
  }

  private apply(midi: number): void {
    const span = this.opts.minSpan ?? 0;
    if (this.dragging === 'low') this.low = clamp(midi, this.minMidi, this.high - span);
    else if (this.dragging === 'high') this.high = clamp(midi, this.low + span, this.maxMidi);
    this.refresh();
    this.opts.onInput?.(this.low, this.high);
  }

  set(low: number, high: number): void {
    this.low = low;
    this.high = high;
    this.refresh();
  }

  private refresh(): void {
    this.lowLabel.textContent = midiName(this.low);
    this.highLabel.textContent = midiName(this.high);
    const semis = this.high - this.low;
    this.spanLabel.textContent = `${semis} semitone${semis === 1 ? '' : 's'}`;
    this.draw();
  }

  private xFor(midi: number, width: number): number {
    return ((midi - this.minMidi) / Math.max(1, this.maxMidi - this.minMidi)) * width;
  }

  private draw(): void {
    const ctx = fitCanvas(this.canvas);
    if (!ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w < 4 || h < 4) return;

    const trackY = Math.round(h / 2) - 6;
    const trackH = 12;

    ctx.clearRect(0, 0, w, h);

    // Keyboard-shaped backdrop: black keys as darker bands, so a position on
    // the track reads as a place on an instrument.
    ctx.fillStyle = cssVar('--s0') || '#0e0f11';
    ctx.fillRect(0, trackY, w, trackH);
    const step = w / Math.max(1, this.maxMidi - this.minMidi + 1);
    for (let m = this.minMidi; m <= this.maxMidi; m++) {
      if (!isBlackKey(m)) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(this.xFor(m, w), trackY, Math.max(1, step), trackH);
    }

    // Selected span.
    const x0 = this.xFor(this.low, w);
    const x1 = this.xFor(this.high, w);
    ctx.fillStyle = 'rgba(217,144,63,0.30)';
    ctx.fillRect(x0, trackY, Math.max(2, x1 - x0), trackH);

    ctx.strokeStyle = cssVar('--line-strong') || '#333940';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, trackY + 0.5, w - 1, trackH - 1);

    // C markers give the eye somewhere to count from.
    ctx.fillStyle = cssVar('--text-faint') || '#656b75';
    ctx.font = `9px ${cssVar('--font-mono') || 'monospace'}`;
    ctx.textAlign = 'center';
    for (let m = this.minMidi; m <= this.maxMidi; m++) {
      if (m % 12 !== 0) continue;
      const x = this.xFor(m, w) + step / 2;
      ctx.fillStyle = 'rgba(150,160,175,0.35)';
      ctx.fillRect(x - 0.5, trackY - 3, 1, 3);
      if (whiteIndex(this.maxMidi) - whiteIndex(this.minMidi) < 60 || m % 24 === 0)
        ctx.fillText(`C${Math.floor(m / 12) - 1}`, x, h - 1);
    }

    const accent = cssVar('--accent') || '#d9903f';
    for (const [midi, kind] of [
      [this.low, 'low'],
      [this.high, 'high'],
    ] as const) {
      const x = this.xFor(midi, w) + (kind === 'high' ? step : 0);
      ctx.fillStyle = accent;
      ctx.fillRect(x - 2, trackY - 4, 4, trackH + 8);
      ctx.fillStyle = cssVar('--s0') || '#0e0f11';
      ctx.fillRect(x - 0.5, trackY - 1, 1, trackH + 2);
    }
  }
}

export function noteRange(opts: NoteRangeOptions): NoteRange {
  return new NoteRange(opts);
}

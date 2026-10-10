// Playable keyboard strip. Doubles as the map's X axis ruler, so the same
// note-to-x projection is shared with the zone map above it.

import { el, fitCanvas, cssVar, clamp } from './dom';

const BLACK = [1, 3, 6, 8, 10];
export const isBlackKey = (midi: number): boolean => BLACK.includes(((midi % 12) + 12) % 12);

/** White-key index of a midi note, used for horizontal layout. */
export function whiteIndex(midi: number): number {
  const octave = Math.floor(midi / 12);
  const pc = ((midi % 12) + 12) % 12;
  const whitesBefore = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6][pc];
  return octave * 7 + whitesBefore;
}

export interface KeyRange {
  low: number;
  high: number;
}

/** Maps midi notes to x positions across a width. Shared by keyboard and map. */
export class KeyProjection {
  constructor(
    readonly range: KeyRange,
    readonly width: number,
  ) {}

  private get whiteCount(): number {
    return whiteIndex(this.range.high) - whiteIndex(this.range.low) + 1;
  }

  get whiteWidth(): number {
    return this.width / Math.max(1, this.whiteCount);
  }

  /** Left edge of a note's cell. Black keys sit between their neighbours. */
  x(midi: number): number {
    const w = this.whiteWidth;
    const rel = whiteIndex(midi) - whiteIndex(this.range.low);
    if (!isBlackKey(midi)) return rel * w;
    return rel * w + w * 0.68;
  }

  keyWidth(midi: number): number {
    return isBlackKey(midi) ? this.whiteWidth * 0.64 : this.whiteWidth;
  }

  /** Continuous position, for drawing spans that cross many notes. */
  span(low: number, high: number): { x: number; w: number } {
    const x0 = whiteIndex(low) - whiteIndex(this.range.low);
    const x1 = whiteIndex(high) - whiteIndex(this.range.low) + 1;
    const w = this.whiteWidth;
    return { x: x0 * w, w: Math.max(2, (x1 - x0) * w) };
  }

  /** Inverse: which note is under an x position. */
  noteAt(x: number): number {
    const w = this.whiteWidth;
    const whiteOffset = Math.floor(clamp(x / w, 0, this.whiteCount - 1));
    const targetWhite = whiteIndex(this.range.low) + whiteOffset;
    for (let m = this.range.low; m <= this.range.high; m++) {
      if (!isBlackKey(m) && whiteIndex(m) === targetWhite) {
        // Prefer a black key when the cursor is over its narrower cell.
        for (const candidate of [m + 1, m - 1]) {
          if (
            candidate >= this.range.low &&
            candidate <= this.range.high &&
            isBlackKey(candidate)
          ) {
            const bx = this.x(candidate);
            if (x >= bx && x <= bx + this.keyWidth(candidate)) return candidate;
          }
        }
        return m;
      }
    }
    return this.range.low;
  }
}

export interface KeyboardOptions {
  range?: KeyRange;
  onNoteOn?: (midi: number, velocity: number) => void;
  onNoteOff?: (midi: number) => void;
}

export class Keyboard {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private range: KeyRange;
  private held = new Set<number>();
  /** Notes lit from outside — MIDI input, or the current capture target. */
  private highlighted = new Map<number, string>();
  private opts: KeyboardOptions;
  private pointerNote: number | null = null;

  constructor(opts: KeyboardOptions = {}) {
    this.opts = opts;
    this.range = opts.range ?? { low: 21, high: 108 };
    this.canvas = el('canvas');
    this.root = el('div', { class: 'canvas-wrap' }, [this.canvas]);

    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      const note = this.noteFromEvent(e);
      if (note == null) return;
      this.pointerNote = note;
      // Vertical position sets velocity: near the bottom of the key is louder,
      // which is how a real keybed behaves under a finger.
      const rect = this.canvas.getBoundingClientRect();
      const v = Math.round(clamp((e.clientY - rect.top) / rect.height, 0.15, 1) * 127);
      this.held.add(note);
      this.opts.onNoteOn?.(note, v);
      this.draw();
    });

    const release = () => {
      if (this.pointerNote != null) {
        this.held.delete(this.pointerNote);
        this.opts.onNoteOff?.(this.pointerNote);
        this.pointerNote = null;
        this.draw();
      }
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
    this.canvas.addEventListener('pointerleave', release);

    new ResizeObserver(() => this.draw()).observe(this.root);
  }

  private noteFromEvent(e: PointerEvent): number | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1) return null;
    const proj = new KeyProjection(this.range, rect.width);
    return proj.noteAt(e.clientX - rect.left);
  }

  setRange(range: KeyRange): void {
    this.range = range;
    this.draw();
  }

  getRange(): KeyRange {
    return this.range;
  }

  setHighlight(map: Map<number, string>): void {
    this.highlighted = map;
    this.draw();
  }

  noteOn(midi: number): void {
    this.held.add(midi);
    this.draw();
  }

  noteOff(midi: number): void {
    this.held.delete(midi);
    this.draw();
  }

  draw(): void {
    const ctx = fitCanvas(this.canvas);
    if (!ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w < 2 || h < 2) return;
    const proj = new KeyProjection(this.range, w);

    const accent = cssVar('--accent') || '#d9903f';
    ctx.clearRect(0, 0, w, h);

    // White keys first, then black on top — the standard two-pass draw.
    for (let m = this.range.low; m <= this.range.high; m++) {
      if (isBlackKey(m)) continue;
      const x = proj.x(m);
      const kw = proj.keyWidth(m);
      const held = this.held.has(m);
      const hi = this.highlighted.get(m);
      ctx.fillStyle = held ? accent : hi || '#c8ccd2';
      ctx.fillRect(x, 0, kw - 1, h);
      // Octave labels on C, the only orientation cue that matters.
      if (m % 12 === 0 && kw > 14) {
        ctx.fillStyle = '#5a5f66';
        ctx.font = `9px ${cssVar('--font-mono') || 'monospace'}`;
        ctx.textAlign = 'center';
        ctx.fillText(`C${Math.floor(m / 12) - 1}`, x + kw / 2, h - 4);
      }
    }

    for (let m = this.range.low; m <= this.range.high; m++) {
      if (!isBlackKey(m)) continue;
      const x = proj.x(m);
      const kw = proj.keyWidth(m);
      const held = this.held.has(m);
      const hi = this.highlighted.get(m);
      ctx.fillStyle = held ? accent : hi || '#16181b';
      ctx.fillRect(x, 0, kw, h * 0.62);
    }
  }
}

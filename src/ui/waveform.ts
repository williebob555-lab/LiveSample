// ============================================================================
// Waveform display with draggable trim and loop markers.
//
// Markers are drawn as full-height lines with grab handles at the top, which is
// the convention every sample editor shares — worth matching exactly, because
// this is the one control users arrive already knowing how to operate.
// ============================================================================

import { el, fitCanvas, cssVar, clamp } from './dom';
import { sampleStore } from '../audio/store';

export type MarkerKind = 'start' | 'end' | 'loopStart' | 'loopEnd';

export interface WaveformValues {
  startFrame: number;
  endFrame: number;
  loopStart: number;
  loopEnd: number;
  loopEnabled: boolean;
  fadeInFrames: number;
  fadeOutFrames: number;
}

export interface WaveformOptions {
  onChange: (values: Partial<WaveformValues>) => void;
  onScrub?: (frame: number) => void;
}

const HANDLE_PX = 6;

export class WaveformView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private sampleId: string | null = null;
  private values: WaveformValues = {
    startFrame: 0,
    endFrame: 0,
    loopStart: 0,
    loopEnd: 0,
    loopEnabled: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
  };
  private frames = 0;
  private dragging: MarkerKind | null = null;
  private opts: WaveformOptions;

  constructor(opts: WaveformOptions) {
    this.opts = opts;
    this.canvas = el('canvas');
    this.root = el('div', { class: 'canvas-wrap' }, [this.canvas]);

    this.canvas.addEventListener('pointerdown', (e) => {
      const x = this.localX(e);
      const hit = this.markerAt(x);
      if (hit) {
        this.dragging = hit;
        this.canvas.setPointerCapture(e.pointerId);
      } else {
        this.opts.onScrub?.(this.frameAt(x));
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const x = this.localX(e);
      if (!this.dragging) {
        this.canvas.style.cursor = this.markerAt(x) ? 'ew-resize' : 'default';
        return;
      }
      const frame = this.frameAt(x);
      const v = this.values;
      const patch: Partial<WaveformValues> = {};
      if (this.dragging === 'start') patch.startFrame = clamp(frame, 0, v.endFrame - 1);
      else if (this.dragging === 'end') patch.endFrame = clamp(frame, v.startFrame + 1, this.frames);
      else if (this.dragging === 'loopStart') patch.loopStart = clamp(frame, 0, v.loopEnd - 1);
      else if (this.dragging === 'loopEnd') patch.loopEnd = clamp(frame, v.loopStart + 1, this.frames);
      Object.assign(this.values, patch);
      this.opts.onChange(patch);
      this.draw();
    });
    const stop = (e: PointerEvent) => {
      this.dragging = null;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);

    new ResizeObserver(() => this.draw()).observe(this.root);
  }

  private localX(e: PointerEvent): number {
    return e.clientX - this.canvas.getBoundingClientRect().left;
  }

  private width(): number {
    return this.canvas.getBoundingClientRect().width;
  }

  private frameAt(x: number): number {
    const w = this.width();
    return Math.round(clamp(x / Math.max(1, w), 0, 1) * this.frames);
  }

  private xAt(frame: number): number {
    return (frame / Math.max(1, this.frames)) * this.width();
  }

  private markerAt(x: number): MarkerKind | null {
    const candidates: [MarkerKind, number][] = [
      ['start', this.values.startFrame],
      ['end', this.values.endFrame],
    ];
    if (this.values.loopEnabled) {
      candidates.push(['loopStart', this.values.loopStart], ['loopEnd', this.values.loopEnd]);
    }
    let best: MarkerKind | null = null;
    let bestDist = HANDLE_PX;
    for (const [kind, frame] of candidates) {
      const d = Math.abs(this.xAt(frame) - x);
      if (d < bestDist) {
        bestDist = d;
        best = kind;
      }
    }
    return best;
  }

  show(sampleId: string | null, values: Partial<WaveformValues>): void {
    this.sampleId = sampleId;
    const audio = sampleId ? sampleStore.get(sampleId) : null;
    this.frames = audio?.frames ?? 0;
    this.values = {
      startFrame: values.startFrame ?? 0,
      endFrame: values.endFrame ?? this.frames,
      loopStart: values.loopStart ?? 0,
      loopEnd: values.loopEnd ?? 0,
      loopEnabled: values.loopEnabled ?? false,
      fadeInFrames: values.fadeInFrames ?? 0,
      fadeOutFrames: values.fadeOutFrames ?? 0,
    };
    this.draw();
  }

  draw(): void {
    const ctx = fitCanvas(this.canvas);
    if (!ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w < 2 || h < 2) return;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = cssVar('--s0') || '#0e0f11';
    ctx.fillRect(0, 0, w, h);

    const audio = this.sampleId ? sampleStore.get(this.sampleId) : null;
    if (!audio) {
      ctx.fillStyle = cssVar('--text-faint') || '#656b75';
      ctx.font = `12px ${cssVar('--font') || 'sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.fillText('No sample selected', w / 2, h / 2);
      return;
    }

    const mid = h / 2;
    const peaks = audio.peaks;
    const buckets = peaks.length / 2;

    // Centre line first, so a near-silent file still reads as a waveform.
    ctx.strokeStyle = cssVar('--line') || '#24282e';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    ctx.fillStyle = 'rgba(150,162,180,0.62)';
    for (let px = 0; px < w; px++) {
      const b0 = Math.floor((px / w) * buckets);
      const b1 = Math.max(b0 + 1, Math.floor(((px + 1) / w) * buckets));
      let lo = 0;
      let hi = 0;
      for (let b = b0; b < b1 && b < buckets; b++) {
        if (peaks[b * 2] < lo) lo = peaks[b * 2];
        if (peaks[b * 2 + 1] > hi) hi = peaks[b * 2 + 1];
      }
      const y0 = mid - hi * mid * 0.94;
      const y1 = mid - lo * mid * 0.94;
      ctx.fillRect(px, y0, 1, Math.max(1, y1 - y0));
    }

    // Everything outside the playback window is dimmed rather than hidden —
    // you need to see what you are cutting off.
    const sx = this.xAt(this.values.startFrame);
    const ex = this.xAt(this.values.endFrame);
    ctx.fillStyle = 'rgba(14,15,17,0.72)';
    ctx.fillRect(0, 0, sx, h);
    ctx.fillRect(ex, 0, w - ex, h);

    if (this.values.loopEnabled && this.values.loopEnd > this.values.loopStart) {
      const lx = this.xAt(this.values.loopStart);
      const lex = this.xAt(this.values.loopEnd);
      ctx.fillStyle = 'rgba(95,147,217,0.12)';
      ctx.fillRect(lx, 0, lex - lx, h);
      this.marker(ctx, lx, h, cssVar('--info') || '#5f93d9', 'L');
      this.marker(ctx, lex, h, cssVar('--info') || '#5f93d9', 'L');
    }

    this.marker(ctx, sx, h, cssVar('--accent') || '#d9903f', 'S');
    this.marker(ctx, ex, h, cssVar('--accent') || '#d9903f', 'E');
  }

  private marker(
    ctx: CanvasRenderingContext2D,
    x: number,
    h: number,
    color: string,
    label: string,
  ): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(x - 5, 0, 11, 12);
    ctx.fillStyle = cssVar('--text-on-accent') || '#16120c';
    ctx.font = `8px ${cssVar('--font-mono') || 'monospace'}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, x, 9);
  }
}

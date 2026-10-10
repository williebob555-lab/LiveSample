// ============================================================================
// The zone map — key on X, velocity on Y, one rectangle per zone.
//
// This is the hero element: it is the data model made directly visible and
// directly editable, and every other panel is support for it. Drag a zone to
// move it, drag its edges to resize, and the underlying keyboard shares the
// same note projection so the two always line up.
// ============================================================================

import type { Instrument, Zone } from '../core/types';
import { el, fitCanvas, cssVar, clamp } from './dom';
import { KeyProjection, type KeyRange, isBlackKey } from './keyboard';

type Edge = 'left' | 'right' | 'top' | 'bottom' | 'body' | null;

export interface ZoneMapOptions {
  onSelect: (zoneIds: string[]) => void;
  onChange: () => void;
  onAudition: (midi: number, velocity: number) => void;
}

interface Hit {
  zone: Zone;
  edge: Edge;
}

const EDGE_PX = 5;

export class ZoneMap {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private instrument: Instrument | null = null;
  private range: KeyRange = { low: 21, high: 108 };
  private selected = new Set<string>();
  private opts: ZoneMapOptions;
  private hover: Hit | null = null;
  private drag: {
    hit: Hit;
    startKey: number;
    startVel: number;
    original: Map<string, { keyLow: number; keyHigh: number; velLow: number; velHigh: number }>;
  } | null = null;

  constructor(opts: ZoneMapOptions) {
    this.opts = opts;
    this.canvas = el('canvas');
    this.root = el('div', { class: 'canvas-wrap zonemap-wrap' }, [this.canvas]);

    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
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

  setSelection(ids: string[]): void {
    this.selected = new Set(ids);
    this.draw();
  }

  private allZones(): Zone[] {
    return this.instrument ? this.instrument.groups.flatMap((g) => g.zones) : [];
  }

  private geometry(): { proj: KeyProjection; w: number; h: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return { proj: new KeyProjection(this.range, rect.width), w: rect.width, h: rect.height };
  }

  /** Velocity increases upward, so y is inverted. */
  private velToY(vel: number, h: number): number {
    return h - (vel / 127) * h;
  }
  private yToVel(y: number, h: number): number {
    return clamp(Math.round((1 - y / h) * 127), 1, 127);
  }

  private zoneRect(zone: Zone, proj: KeyProjection, h: number) {
    const { x, w } = proj.span(zone.keyLow, zone.keyHigh);
    const yTop = this.velToY(zone.velHigh, h);
    const yBottom = this.velToY(zone.velLow - 1, h);
    return { x, y: yTop, w, h: Math.max(3, yBottom - yTop) };
  }

  private hitTest(px: number, py: number): Hit | null {
    const g = this.geometry();
    if (!g) return null;
    // Reverse order so the topmost drawn zone wins.
    const zones = this.allZones();
    for (let i = zones.length - 1; i >= 0; i--) {
      const z = zones[i];
      const r = this.zoneRect(z, g.proj, g.h);
      if (px < r.x - EDGE_PX || px > r.x + r.w + EDGE_PX) continue;
      if (py < r.y - EDGE_PX || py > r.y + r.h + EDGE_PX) continue;
      let edge: Edge = 'body';
      if (Math.abs(px - r.x) <= EDGE_PX) edge = 'left';
      else if (Math.abs(px - (r.x + r.w)) <= EDGE_PX) edge = 'right';
      else if (Math.abs(py - r.y) <= EDGE_PX) edge = 'top';
      else if (Math.abs(py - (r.y + r.h)) <= EDGE_PX) edge = 'bottom';
      return { zone: z, edge };
    }
    return null;
  }

  private onMove(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const g = this.geometry();
    if (!g) return;

    if (this.drag) {
      const key = g.proj.noteAt(px);
      const vel = this.yToVel(py, g.h);
      const dKey = key - this.drag.startKey;
      const dVel = vel - this.drag.startVel;

      for (const [id, orig] of this.drag.original) {
        const zone = this.allZones().find((z) => z.id === id);
        if (!zone) continue;
        const edge = this.drag.hit.edge;
        if (edge === 'body') {
          const width = orig.keyHigh - orig.keyLow;
          zone.keyLow = clamp(orig.keyLow + dKey, 0, 127 - width);
          zone.keyHigh = zone.keyLow + width;
          const vSpan = orig.velHigh - orig.velLow;
          zone.velLow = clamp(orig.velLow + dVel, 1, 127 - vSpan);
          zone.velHigh = zone.velLow + vSpan;
        } else if (edge === 'left') {
          zone.keyLow = clamp(orig.keyLow + dKey, 0, zone.keyHigh);
        } else if (edge === 'right') {
          zone.keyHigh = clamp(orig.keyHigh + dKey, zone.keyLow, 127);
        } else if (edge === 'top') {
          zone.velHigh = clamp(orig.velHigh + dVel, zone.velLow, 127);
        } else if (edge === 'bottom') {
          zone.velLow = clamp(orig.velLow + dVel, 1, zone.velHigh);
        }
      }
      this.opts.onChange();
      this.draw();
      return;
    }

    this.hover = this.hitTest(px, py);
    const edge = this.hover?.edge;
    this.canvas.style.cursor =
      edge === 'left' || edge === 'right'
        ? 'ew-resize'
        : edge === 'top' || edge === 'bottom'
          ? 'ns-resize'
          : edge === 'body'
            ? 'move'
            : 'default';
    this.draw();
  }

  private onDown(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const g = this.geometry();
    if (!g) return;
    const hit = this.hitTest(px, py);

    if (!hit) {
      // Clicking empty space auditions that note and velocity — the fastest way
      // to check what a spot in the map actually sounds like.
      this.selected.clear();
      this.opts.onSelect([]);
      this.opts.onAudition(g.proj.noteAt(px), this.yToVel(py, g.h));
      this.draw();
      return;
    }

    this.canvas.setPointerCapture(e.pointerId);
    if (e.shiftKey) {
      if (this.selected.has(hit.zone.id)) this.selected.delete(hit.zone.id);
      else this.selected.add(hit.zone.id);
    } else if (!this.selected.has(hit.zone.id)) {
      this.selected = new Set([hit.zone.id]);
    }
    this.opts.onSelect([...this.selected]);

    const original = new Map<
      string,
      { keyLow: number; keyHigh: number; velLow: number; velHigh: number }
    >();
    for (const z of this.allZones()) {
      if (this.selected.has(z.id))
        original.set(z.id, {
          keyLow: z.keyLow,
          keyHigh: z.keyHigh,
          velLow: z.velLow,
          velHigh: z.velHigh,
        });
    }
    this.drag = {
      hit,
      startKey: g.proj.noteAt(px),
      startVel: this.yToVel(py, g.h),
      original,
    };
    this.draw();
  }

  private onUp(e: PointerEvent): void {
    if (this.drag) {
      this.drag = null;
      this.opts.onChange();
    }
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  }

  draw(): void {
    const ctx = fitCanvas(this.canvas);
    const g = this.geometry();
    if (!ctx || !g) return;
    const { proj, w, h } = g;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = cssVar('--s0') || '#0e0f11';
    ctx.fillRect(0, 0, w, h);

    // Octave columns, shaded so the eye can find middle C without counting.
    for (let m = this.range.low; m <= this.range.high; m++) {
      if (isBlackKey(m)) {
        const x = proj.x(m);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(x, 0, proj.keyWidth(m), h);
      }
      if (m % 12 === 0) {
        const s = proj.span(m, m);
        ctx.strokeStyle = cssVar('--line') || '#24282e';
        ctx.beginPath();
        ctx.moveTo(s.x, 0);
        ctx.lineTo(s.x, h);
        ctx.stroke();
      }
    }

    // Velocity gridlines every 32.
    ctx.strokeStyle = cssVar('--line-soft') || '#1c1f24';
    ctx.setLineDash([2, 3]);
    for (let v = 32; v < 127; v += 32) {
      const y = this.velToY(v, h);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (!this.instrument) return;
    const accent = cssVar('--accent') || '#d9903f';
    const font = cssVar('--font-mono') || 'monospace';

    for (const group of this.instrument.groups) {
      for (const zone of group.zones) {
        const r = this.zoneRect(zone, proj, h);
        const isSelected = this.selected.has(zone.id);
        const isHover = this.hover?.zone.id === zone.id;

        // Round robins are drawn stacked and slightly inset so a stack of four
        // reads as four, not one.
        const inset = Math.min(3, (zone.rrIndex - 1) * 1.5);

        ctx.fillStyle = isSelected
          ? 'rgba(217,144,63,0.32)'
          : isHover
            ? 'rgba(160,172,190,0.26)'
            : 'rgba(140,152,170,0.20)';
        ctx.fillRect(r.x + inset, r.y + inset, Math.max(2, r.w - inset * 2), Math.max(2, r.h - inset * 2));

        ctx.strokeStyle = isSelected
          ? accent
          : isHover
            ? 'rgba(200,212,228,0.75)'
            : 'rgba(165,178,196,0.55)';
        ctx.lineWidth = isSelected ? 1.5 : 1;
        ctx.strokeRect(
          r.x + inset + 0.5,
          r.y + inset + 0.5,
          Math.max(2, r.w - inset * 2 - 1),
          Math.max(2, r.h - inset * 2 - 1),
        );

        // Root key marker — where the sample is unstretched.
        const rootSpan = proj.span(zone.rootKey, zone.rootKey);
        if (rootSpan.x >= r.x - 1 && rootSpan.x <= r.x + r.w) {
          ctx.fillStyle = isSelected ? accent : 'rgba(200,210,225,0.55)';
          ctx.fillRect(rootSpan.x + rootSpan.w / 2 - 1, r.y + 2, 2, Math.max(3, r.h - 4));
        }

        if (r.w > 34 && r.h > 13) {
          ctx.fillStyle = isSelected ? '#f0e2d0' : cssVar('--text-dim') || '#949aa4';
          ctx.font = `9px ${font}`;
          ctx.textAlign = 'left';
          const label = zone.rrIndex > 1 ? `rr${zone.rrIndex}` : `${zone.velLow}-${zone.velHigh}`;
          ctx.fillText(label, r.x + inset + 4, r.y + inset + 11);
        }
      }
    }
  }
}

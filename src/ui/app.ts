// ============================================================================
// Application state and shell chrome.
//
// One mutable instrument document plus a change notification. Deliberately not
// reactive: the panels are small enough to redraw wholesale, and a redraw that
// is obviously correct beats a diffing layer that is subtly wrong.
// ============================================================================

import { type Instrument, type Sample, createInstrument } from '../core/types';
import { el, clear } from './dom';

export type Stage = 'takes' | 'map' | 'refine' | 'export';

class AppState {
  instrument: Instrument = createInstrument();
  stage: Stage = 'takes';
  selectedSamples: string[] = [];
  selectedZones: string[] = [];
  activeGroupId: string | null = null;
  projectPath: string | null = null;

  /**
   * Unsaved-changes flag.
   *
   * A property rather than a plain field because the main process needs to know
   * the moment it changes — some edits (capture settings, for one) set it
   * without triggering a re-render, and a missed signal means closing the app
   * without the prompt.
   */
  private dirtyFlag = false;
  private dirtyListeners = new Set<(dirty: boolean) => void>();

  get dirty(): boolean {
    return this.dirtyFlag;
  }

  set dirty(value: boolean) {
    if (this.dirtyFlag === value) return;
    this.dirtyFlag = value;
    for (const fn of this.dirtyListeners) fn(value);
  }

  onDirtyChange(fn: (dirty: boolean) => void): () => void {
    this.dirtyListeners.add(fn);
    return () => this.dirtyListeners.delete(fn);
  }

  /**
   * Ask for a capture session. Set by the shell, called from anywhere that can
   * start one. Passing takes re-records exactly those instead of the full plan.
   */
  requestCapture: ((retakeOf?: Sample[]) => void) | null = null;

  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Mark the document changed and redraw everything listening. */
  touch(dirty = true): void {
    if (dirty) this.dirty = true;
    for (const fn of this.listeners) fn();
  }

  group() {
    const inst = this.instrument;
    return inst.groups.find((g) => g.id === this.activeGroupId) ?? inst.groups[0] ?? null;
  }

  setInstrument(inst: Instrument): void {
    this.instrument = inst;
    this.selectedSamples = [];
    this.selectedZones = [];
    this.activeGroupId = inst.groups[0]?.id ?? null;
    this.dirty = false;
    this.touch(false);
  }

  zoneById(id: string) {
    for (const g of this.instrument.groups) {
      const z = g.zones.find((zz) => zz.id === id);
      if (z) return { zone: z, group: g };
    }
    return null;
  }

  sampleById(id: string) {
    return this.instrument.samples.find((s) => s.id === id) ?? null;
  }
}

export const app = new AppState();

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'err' = 'info', ms = 2600): void {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts' });
    document.getElementById('app')?.append(toastHost);
  }
  const node = el('div', { class: `toast ${kind === 'err' ? 'err' : ''}`, text: message });
  toastHost.append(node);
  setTimeout(() => node.remove(), ms);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface ModalOptions {
  title: string;
  body: HTMLElement;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void | Promise<void>;
  wide?: boolean;
  /** Runs however the dialog closes (button, Esc, click outside). */
  onClose?: () => void;
}

export function modal(opts: ModalOptions): () => void {
  const host = document.getElementById('app');
  if (!host) return () => {};

  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  const foot = el('div', { class: 'modal-foot' }, [
    el('button', { text: opts.cancelLabel ?? 'Cancel', onclick: close }),
    opts.onConfirm
      ? el('button', {
          class: 'primary',
          text: opts.confirmLabel ?? 'OK',
          onclick: async () => {
            await opts.onConfirm?.();
            close();
          },
        })
      : null,
  ]);

  const box = el(
    'div',
    { class: 'modal', style: opts.wide ? 'width:680px' : '' },
    [
      el('div', { class: 'modal-head', text: opts.title }),
      el('div', { class: 'modal-body' }, [opts.body]),
      foot,
    ],
  );

  const scrim = el('div', {
    class: 'modal-scrim',
    onclick: (e: Event) => {
      if (e.target === scrim) close();
    },
  }, [box]);

  host.append(scrim);
  document.addEventListener('keydown', onKey);
  return close;
}

/** Blocking progress dialog for long batch operations. */
export function progressModal(title: string): {
  update: (done: number, total: number, label?: string) => void;
  close: () => void;
} {
  const bar = el('div', { style: 'height:100%;background:var(--accent);width:0%' });
  const label = el('div', { class: 'status', style: 'margin-top:8px' });
  const body = el('div', {}, [
    el('div', { style: 'height:3px;background:var(--s3);border-radius:2px;overflow:hidden' }, [bar]),
    label,
  ]);
  const close = modal({ title, body, cancelLabel: 'Hide' });
  return {
    update: (done, total, text) => {
      bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      label.textContent = text ? `${done} / ${total} — ${text}` : `${done} / ${total}`;
    },
    close,
  };
}

export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return el('div', { class: 'section' }, [el('h3', { text: title }), ...children]);
}

export function panel(title: string, extra: Node[] = []): {
  root: HTMLElement;
  body: HTMLElement;
  head: HTMLElement;
} {
  const body = el('div', { class: 'panel-body' });
  const head = el('div', { class: 'panel-head' }, [
    el('span', { class: 'panel-title', text: title }),
    el('div', { class: 'spacer' }),
    ...extra,
  ]);
  const root = el('div', { class: 'panel' }, [head, body]);
  return { root, body, head };
}

export function rebuild(host: HTMLElement, build: () => Node): void {
  clear(host);
  host.append(build());
}

// Small DOM helpers. Deliberately tiny — the app is plain TypeScript against
// the DOM, matching the sibling LivePatch project, so there is no framework to
// learn and no build-time magic.

export type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (k === 'text') {
      node.textContent = String(v);
    } else if (k === 'value' && node instanceof HTMLInputElement) {
      node.value = String(v);
    } else if (k === 'checked' && node instanceof HTMLInputElement) {
      node.checked = Boolean(v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export const clear = (node: Element): void => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Size a canvas to its CSS box at device pixel ratio and return a context
 * already scaled to CSS pixels. Everything canvas-drawn goes through this, so
 * nothing is ever blurry on a high-DPI display.
 */
export function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Pointer drag helper. Captures the pointer so the gesture survives leaving the
 * element, which knobs and faders both need.
 */
export function onDrag(
  target: HTMLElement,
  handlers: {
    start?: (e: PointerEvent) => void;
    move: (dx: number, dy: number, e: PointerEvent) => void;
    end?: () => void;
  },
): void {
  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Capture can throw when the pointer is no longer active (and for
    // synthesised events). Losing capture only costs us drags that leave the
    // element, so it must never abort the gesture.
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* drag still works, it just will not track outside the element */
    }
    let lastX = e.clientX;
    let lastY = e.clientY;
    handlers.start?.(e);

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      handlers.move(dx, dy, ev);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      handlers.end?.();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  });
}

export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '-inf';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
}

export function formatSeconds(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  return `${s.toFixed(2)} s`;
}

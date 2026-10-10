// ============================================================================
// Undo / redo history.
//
// Snapshot based, and it records the state *after* each edit rather than
// before. Edits all follow "mutate the instrument in place, then touch()", so
// there is no moment before the mutation at which a hook could snapshot; but
// the previous touch's result is exactly the state before this one. So the
// history keeps `current` (a copy of the last committed state) and, when a new
// edit commits, files the old `current` on the undo stack.
//
// Rapid edits (a knob drag, typing) fire many commits. Those landing within
// `windowMs` of the previous one are folded into the same step: `current` is
// refreshed but nothing is pushed, so one undo rewinds the whole gesture.
//
// Generic over the state type and with an injectable clock so the logic can be
// tested without a DOM.
// ============================================================================

export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private current: T;
  private lastAt = -Infinity;

  constructor(
    initial: T,
    private readonly clone: (v: T) => T,
    private readonly cap = 100,
    private readonly windowMs = 500,
    private readonly now: () => number = Date.now,
  ) {
    this.current = clone(initial);
  }

  /** Forget everything and treat `state` as the starting point (open / new). */
  reset(state: T): void {
    this.undoStack = [];
    this.redoStack = [];
    this.current = this.clone(state);
    this.lastAt = -Infinity;
  }

  /** Call after an edit has been applied to the live state. */
  commit(live: T): void {
    const t = this.now();
    if (t - this.lastAt > this.windowMs) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.cap) this.undoStack.shift();
      this.redoStack = [];
    }
    this.current = this.clone(live);
    this.lastAt = t;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The state to restore, or null. The caller applies it to the app. */
  undo(): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(this.current);
    this.current = prev;
    // The next edit after an undo is a new step, however soon it comes.
    this.lastAt = -Infinity;
    return this.clone(prev);
  }

  redo(): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(this.current);
    this.current = next;
    this.lastAt = -Infinity;
    return this.clone(next);
  }
}

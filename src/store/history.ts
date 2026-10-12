/**
 * What: Immutable undo/redo stacks for durable editor state only.
 * Role: clone/push/pop snapshots — `SimContext` decides when to record history.
 * Owns/exports: `UndoSnapshot`, `UndoStacks`, `cloneUndoSnapshot`, `createUndoSnapshot`,
 * stack push/undo/redo helpers.
 * Conventions: snapshot includes components, wires, viewport, `idCounter` — not selection,
 * clipboard, sketch text, or sim live store; clones deep-copy wires and `pinStates` maps.
 * To include new durable fields in undo: extend `UndoSnapshot` and cloning in this file,
 * ensure reducer copies them on restore (sketch may stay separate if not in snapshot today).
 * To cap memory: adjust max stack depth in `SimContext` if present — stacks live there.
 * Not-here: React hooks or action dispatch — pure data structures only.
 *
 * Changelog:
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */
import type { PlacedComponent, Viewport, Wire } from '../types';

/** Circuit data restored by undo/redo (excludes transient UI). */
export interface UndoSnapshot {
  components: PlacedComponent[];
  wires: Wire[];
  viewport: Viewport;
  idCounter: number;
}

export function cloneUndoSnapshot(snapshot: UndoSnapshot): UndoSnapshot {
  return {
    components: snapshot.components.map((c) => ({
      ...c,
      pinStates: { ...c.pinStates },
    })),
    wires: snapshot.wires.map((w) => ({
      ...w,
      from: { ...w.from },
      to: { ...w.to },
      bends: w.bends.map((b) => ({ ...b })),
    })),
    viewport: { ...snapshot.viewport },
    idCounter: snapshot.idCounter,
  };
}

export function createUndoSnapshot(
  components: PlacedComponent[],
  wires: Wire[],
  viewport: Viewport,
  idCounter: number,
): UndoSnapshot {
  return cloneUndoSnapshot({ components, wires, viewport, idCounter });
}

export interface UndoStacks {
  past: UndoSnapshot[];
  future: UndoSnapshot[];
}

export function createUndoStacks(): UndoStacks {
  return { past: [], future: [] };
}

export function pushUndoSnapshot(stacks: UndoStacks, snapshot: UndoSnapshot): void {
  stacks.past.push(cloneUndoSnapshot(snapshot));
  stacks.future = [];
}

export function resetUndoStacks(stacks: UndoStacks): void {
  stacks.past = [];
  stacks.future = [];
}

export function canUndo(stacks: UndoStacks): boolean {
  return stacks.past.length > 0;
}

export function canRedo(stacks: UndoStacks): boolean {
  return stacks.future.length > 0;
}

export function popUndo(
  stacks: UndoStacks,
  current: UndoSnapshot,
): UndoSnapshot | null {
  const previous = stacks.past.pop();
  if (!previous) return null;
  stacks.future.push(cloneUndoSnapshot(current));
  return previous;
}

export function popRedo(
  stacks: UndoStacks,
  current: UndoSnapshot,
): UndoSnapshot | null {
  const next = stacks.future.pop();
  if (!next) return null;
  stacks.past.push(cloneUndoSnapshot(current));
  return next;
}

/**
 * What: Copy/paste payloads for selected components and their internal wires.
 * Role: clone selection, remap ids, offset placement — invoked from `SimContext` shortcuts.
 * Owns/exports: `CopyPayload`, `PASTE_STEP`, `buildCopyPayload`, `pastePayload`, `pastePayloadAt`.
 * Conventions: only wires with both endpoints in the selection copy; new ids use caller-supplied
 * suffix factory; default paste offset is one `GRID_SIZE` (`geometry.ts`).
 * To extend what copies with a part: ensure new fields live on `PlacedComponent` and are copied
 * in `cloneComponent` (spread already shallow-clones scalars; deep-clone maps if added).
 * To paste at cursor: use `pastePayloadAt` with world coordinates; grid nudge uses `pastePayload`.
 * Not-here: undo stacks, selection state, or keyboard handlers — context owns those.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Moved from `src/utils/clipboard.ts` (tree reorganization)
 */

import type { PlacedComponent, Wire } from '../types';
import { GRID_SIZE } from '../ui/canvas/geometry';

export const PASTE_STEP = GRID_SIZE;

export interface CopyPayload {
  components: PlacedComponent[];
  wires: Wire[];
}

function cloneComponent(c: PlacedComponent): PlacedComponent {
  return {
    ...c,
    pinStates: { ...c.pinStates },
  };
}

function cloneWire(w: Wire): Wire {
  return {
    ...w,
    from: { ...w.from },
    to: { ...w.to },
    bends: w.bends.map((b) => ({ ...b })),
  };
}

/** Build a copy payload from the current selection (components + connected wires). */
export function buildCopyPayload(
  components: PlacedComponent[],
  wires: Wire[],
  selectedIds: string[],
  selectedWireIds: string[],
): CopyPayload | null {
  const selectedCompSet = new Set(selectedIds);
  const selectedWireSet = new Set(selectedWireIds);

  if (selectedCompSet.size === 0 && selectedWireSet.size === 0) {
    return null;
  }

  let copiedComponents = components
    .filter((c) => selectedCompSet.has(c.id))
    .map(cloneComponent);

  const copiedWires = wires
    .filter((w) => {
      if (selectedWireSet.has(w.id)) return true;
      if (selectedCompSet.size === 0) return false;
      return (
        selectedCompSet.has(w.from.componentId) &&
        selectedCompSet.has(w.to.componentId)
      );
    })
    .map(cloneWire);

  if (copiedComponents.length === 0 && copiedWires.length > 0) {
    const endpointIds = new Set<string>();
    for (const w of copiedWires) {
      endpointIds.add(w.from.componentId);
      endpointIds.add(w.to.componentId);
    }
    copiedComponents = components
      .filter((c) => endpointIds.has(c.id))
      .map(cloneComponent);
  }

  if (copiedComponents.length === 0 && copiedWires.length === 0) {
    return null;
  }

  return { components: copiedComponents, wires: copiedWires };
}

export function pastePayload(
  payload: CopyPayload,
  pasteIndex: number,
  allocateId: (prefix: string) => string,
): {
  components: PlacedComponent[];
  wires: Wire[];
  selectedIds: string[];
  selectedWireIds: string[];
} {
  const dx = PASTE_STEP * pasteIndex;
  const dy = PASTE_STEP * pasteIndex;
  return pastePayloadWithOffset(payload, dx, dy, allocateId);
}

/** Paste clipboard contents so the selection's top-left lands at a world point. */
export function pastePayloadAt(
  payload: CopyPayload,
  atWorld: { x: number; y: number },
  allocateId: (prefix: string) => string,
): {
  components: PlacedComponent[];
  wires: Wire[];
  selectedIds: string[];
  selectedWireIds: string[];
} {
  if (payload.components.length === 0) {
    return { components: [], wires: [], selectedIds: [], selectedWireIds: [] };
  }

  const minX = Math.min(...payload.components.map((c) => c.x));
  const minY = Math.min(...payload.components.map((c) => c.y));
  return pastePayloadWithOffset(
    payload,
    atWorld.x - minX,
    atWorld.y - minY,
    allocateId,
  );
}

function pastePayloadWithOffset(
  payload: CopyPayload,
  dx: number,
  dy: number,
  allocateId: (prefix: string) => string,
): {
  components: PlacedComponent[];
  wires: Wire[];
  selectedIds: string[];
  selectedWireIds: string[];
} {
  const idMap = new Map<string, string>();

  const newComponents = payload.components.map((c) => {
    const newId = allocateId(c.type);
    idMap.set(c.id, newId);
    return {
      ...c,
      id: newId,
      x: c.x + dx,
      y: c.y + dy,
    };
  });

  const newWires = payload.wires
    .map((w) => {
      const fromId = idMap.get(w.from.componentId);
      const toId = idMap.get(w.to.componentId);
      if (!fromId || !toId) return null;
      return {
        id: allocateId('wire'),
        from: { componentId: fromId, pinId: w.from.pinId },
        to: { componentId: toId, pinId: w.to.pinId },
        bends: w.bends.map((b) => ({ x: b.x + dx, y: b.y + dy })),
      };
    })
    .filter((w): w is Wire => w !== null);

  return {
    components: newComponents,
    wires: newWires,
    selectedIds: newComponents.map((c) => c.id),
    selectedWireIds: newWires.map((w) => w.id),
  };
}

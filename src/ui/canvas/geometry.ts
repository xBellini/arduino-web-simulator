/**
 * What: Canvas 2D geometry — snap grid, pin positions, wire routing, and bend editing.
 * Role: world/local transforms and orthogonal paths between pins; used by canvas and store.
 * Owns/exports: `GRID_SIZE`, wire snap constants, `snapToGrid`, placement snap, pin position
 * helpers, wire draft/commit, obstacle-aware routing, completed-wire bend builders.
 * Conventions: `GRID_SIZE` equals `BB_COL`; wire drag uses finer `WIRE_DRAG_GRID`; obstacles
 * use scaled body hitboxes from `componentHitbox.ts`; pin coords from scaled `getDefinition`.
 * To snap a new interaction to holes: reuse `snapToGrid` / `snapComponentPlacement` rather
 * than duplicating pitch math from `breadboardGrid.ts`.
 * To adjust wire routing: search bend/route helpers here; keep hitboxes in sync when parts
 * have overrides.
 * To add pin hit radius behavior: extend pin proximity helpers alongside existing join threshold.
 * Not-here: React components, reducer actions, or simulation netlists.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 05-10-2026 | Cursor | Portal stubs stay on pin exit axis (no perpendicular grid snap); axis-aligned wires stay straight
#                     | Fix portal along-axis snap (was calling snapToGrid on a scalar → NaN stubs)
#                     | Draft cursor preview skips obstacle clearing (no inside-out detours over target body)
#                     | Draft rubber-band: no exit portal + V-first off headers (avoids stub hairpin loops)
#                     | Draft rubber-band H-first (off-column elbow on destination column)
#                     | Cursor draft uses exit portal again (leave body first); hairpin guard when cursor is still between pin and portal
#                     | Junction dots only at shared pin ends (not overlapping bends); stop snap-to-other-wire junctions on commit
#                     | Free-space routing no longer skips origin/dest as obstacles (stops wires cutting back through their own body)
# 06-10-2026 | Cursor | clearFreeSpaceWirePath no longer snapToGrid's free-path points (keeps off-grid portal axis straight)
#                     | Draft rubber-band: free axis snaps in GRID_SIZE steps from route anchor (not absolute board grid)
#                     | wire_junction split helpers + free-path ignores junction obstacles
#                     | Removed completed straight-down / body-cross debug logs; keep resize diagonal probes
#                     | No pinWirePortal for wire_junction (stops stub funnel at tees); stripped join path logs
#                     | Debug instrumentation: wire resize diagonals (handle/segment/commit/pin legs)
#                     | Resize commit: refuse merges that create diagonals; relative WIRE_DRAG snap; pin stubs keep pin axis (no snapToGrid)
#                     | Debug instrumentation: draft 2nd-curve stick (commit vs resolveWireDraftPoints)
#                     | Draft bends store click waypoints; ortho legs + no-reverse tail; dedupe keeps mandatory prev
#                     | Draft/path: preserve bend waypoints through assemble+clear (retreat no longer erases spur)
#                     | After vertical/horizontal exit portal, continue along exit axis first (stops column rubberband reverse)
# 07-10-2026 | Cursor | Stripped wire draft/resize debug instrumentation after confirmed polish
# 09-10-2026 | Cursor | Moved from `src/utils/geometry.ts` (tree reorganization)
# 14-10-2026 | Codex  | Store creation waypoints, not generated corners; reroute around moved bodies
#                     | Replace repeated detours with bounded visibility search; unify resize preview/commit
#                     | Preserve pin leads symmetrically while dragging; discard obstructed waypoints
#                     | Trim self-intersections after moves; tight endpoint envelopes may reduce clearance
#                     | Physically enclosed pins retain a finite fallback when no body-safe route exists
#                     | Align endpoint runs within half a grid to exact pin axes, removing off-grid LCD/header grooves
#                     | Keep pin exits outside their own bodies in tight gaps; construct exact orthogonal legs and allow straight-segment dragging
#                     | Apply obstacle routing to free drafts from breadboard holes and junctions as well as component pins
 */
import type {
  ComponentDefinition,
  PlacedComponent,
  PinDefinition,
  PinRef,
  Wire,
} from '../../types';
import { getDefinition } from '../../registry/components';
import { getComponentBodyHitbox } from '../../registry/componentHitbox';
import { BB_COL } from '../../registry/breadboardGrid';

export interface Point {
  x: number;
  y: number;
}

export const GRID_SIZE = BB_COL;
/** Finer snap while dragging/resizing wires (quarter grid). */
export const WIRE_DRAG_GRID = GRID_SIZE / 4;

/** Hidden auto-placed tee node (not in the palette). */
export const WIRE_JUNCTION_TYPE = 'wire_junction';
export const WIRE_JUNCTION_PIN_ID = 'j';
/** Snap/join radius when a wire edit is committed (mouse release). */
export const WIRE_JOIN_THRESHOLD = GRID_SIZE;

export function snapToGrid(p: Point): Point {
  return {
    x: Math.round(p.x / GRID_SIZE) * GRID_SIZE,
    y: Math.round(p.y / GRID_SIZE) * GRID_SIZE,
  };
}

/** Snap `p` to a GRID_SIZE lattice whose origin is `anchor` (not the board origin). */
export function snapRelativeToAnchor(p: Point, anchor: Point): Point {
  return {
    x: anchor.x + Math.round((p.x - anchor.x) / GRID_SIZE) * GRID_SIZE,
    y: anchor.y + Math.round((p.y - anchor.y) / GRID_SIZE) * GRID_SIZE,
  };
}

export function snapWireDrag(p: Point): Point {
  return {
    x: Math.round(p.x / WIRE_DRAG_GRID) * WIRE_DRAG_GRID,
    y: Math.round(p.y / WIRE_DRAG_GRID) * WIRE_DRAG_GRID,
  };
}

/** Snap `p` to a WIRE_DRAG_GRID lattice whose origin is `anchor` (not the board origin). */
export function snapWireDragRelative(p: Point, anchor: Point): Point {
  return {
    x: anchor.x + Math.round((p.x - anchor.x) / WIRE_DRAG_GRID) * WIRE_DRAG_GRID,
    y: anchor.y + Math.round((p.y - anchor.y) / WIRE_DRAG_GRID) * WIRE_DRAG_GRID,
  };
}

/** Max distance from a component pin to a breadboard tie hole while placing. */
const BREADBOARD_SNAP_RADIUS = 36;
/** How close a pin must land to count as seated on a breadboard hole. */
const PIN_HOLE_MATCH_EPS = 3;

function isBreadboardTiePin(pinId: string): boolean {
  return /^[a-j]\d{1,2}$/.test(pinId);
}

/** Power/ground rail holes: top/bottom × +/− (tp/tn/bp/bn). */
function isBreadboardRailPin(pinId: string): boolean {
  return /^[tb][pn]\d{1,2}$/.test(pinId);
}

function gatherBreadboardHoles(placedComponents: PlacedComponent[]): Point[] {
  const holes: Point[] = [];
  for (const comp of placedComponents) {
    if (comp.type !== 'breadboard') continue;
    const bbDef = getDefinition('breadboard');
    for (const pin of bbDef.pins) {
      if (!isBreadboardTiePin(pin.id) && !isBreadboardRailPin(pin.id)) continue;
      holes.push(pinWorldPosition(comp, pin));
    }
  }
  return holes;
}

/** Pin used to align a part onto breadboard rows (leftmost bottom pin). */
function getPlacementAnchorPin(def: ComponentDefinition): PinDefinition {
  if (def.pins.length === 0) {
    return {
      id: '__center__',
      description: '',
      x: def.width / 2,
      y: def.height / 2,
      type: 'digital',
    };
  }

  const maxY = Math.max(...def.pins.map((p) => p.y));
  const bottomPins = def.pins.filter((p) => p.y >= maxY - 4);
  const pool = bottomPins.length > 0 ? bottomPins : def.pins;

  return pool.reduce((best, pin) => (pin.x < best.x ? pin : best));
}

function countPinsMatchingHoles(
  preview: PlacedComponent,
  def: ComponentDefinition,
  holes: Point[],
): { count: number; slack: number } {
  let count = 0;
  let slack = 0;
  for (const pin of def.pins) {
    const pinWorld = pinWorldPosition(preview, pin);
    let nearest = Infinity;
    for (const hole of holes) {
      const d = Math.hypot(hole.x - pinWorld.x, hole.y - pinWorld.y);
      if (d < nearest) nearest = d;
    }
    slack += nearest;
    if (nearest <= PIN_HOLE_MATCH_EPS) count++;
  }
  return { count, slack };
}

function snapComponentToGridAnchor(
  def: ComponentDefinition,
  topLeft: Point,
  rotation: number,
): Point {
  const preview: PlacedComponent = {
    id: '__snap_preview__',
    type: def.type,
    x: topLeft.x,
    y: topLeft.y,
    rotation,
    pinStates: {},
  };
  const anchor = getPlacementAnchorPin(def);
  const anchorWorld = pinWorldPosition(preview, anchor);
  const snappedAnchor = snapToGrid(anchorWorld);
  return {
    x: topLeft.x + (snappedAnchor.x - anchorWorld.x),
    y: topLeft.y + (snappedAnchor.y - anchorWorld.y),
  };
}

/** Snap a component top-left while placing: breadboard holes when nearby, else canvas grid. */
export function snapComponentPlacement(
  type: string,
  topLeft: Point,
  rotation: number,
  placedComponents: PlacedComponent[],
): Point {
  if (type === 'breadboard') {
    return snapToGrid(topLeft);
  }

  const def = getDefinition(type);
  const holes = gatherBreadboardHoles(placedComponents);
  const preview: PlacedComponent = {
    id: '__snap_preview__',
    type,
    x: topLeft.x,
    y: topLeft.y,
    rotation,
    pinStates: {},
  };

  if (holes.length === 0) {
    return snapComponentToGridAnchor(def, topLeft, rotation);
  }

  let bestTopLeft = topLeft;
  let bestCount = -1;
  let bestSlack = Infinity;
  let bestMove = Infinity;

  for (const pin of def.pins) {
    const pinWorld = pinWorldPosition(preview, pin);
    for (const hole of holes) {
      const dToHole = Math.hypot(hole.x - pinWorld.x, hole.y - pinWorld.y);
      if (dToHole > BREADBOARD_SNAP_RADIUS) continue;

      const candidateTopLeft = {
        x: topLeft.x + (hole.x - pinWorld.x),
        y: topLeft.y + (hole.y - pinWorld.y),
      };
      const candidatePreview: PlacedComponent = {
        ...preview,
        x: candidateTopLeft.x,
        y: candidateTopLeft.y,
      };
      const { count, slack } = countPinsMatchingHoles(
        candidatePreview,
        def,
        holes,
      );
      const move = Math.hypot(
        candidateTopLeft.x - topLeft.x,
        candidateTopLeft.y - topLeft.y,
      );

      const better =
        count > bestCount ||
        (count === bestCount && slack < bestSlack) ||
        (count === bestCount && slack === bestSlack && move < bestMove);

      if (better) {
        bestCount = count;
        bestSlack = slack;
        bestMove = move;
        bestTopLeft = candidateTopLeft;
      }
    }
  }

  if (bestCount > 0) {
    return bestTopLeft;
  }

  const anchor = getPlacementAnchorPin(def);
  const anchorWorld = pinWorldPosition(preview, anchor);
  let bestHole: Point | null = null;
  let bestDist = BREADBOARD_SNAP_RADIUS;

  for (const hole of holes) {
    const d = Math.hypot(hole.x - anchorWorld.x, hole.y - anchorWorld.y);
    if (d < bestDist) {
      bestDist = d;
      bestHole = hole;
    }
  }

  if (bestHole) {
    return {
      x: topLeft.x + (bestHole.x - anchorWorld.x),
      y: topLeft.y + (bestHole.y - anchorWorld.y),
    };
  }

  return snapComponentToGridAnchor(def, topLeft, rotation);
}

export function pinWorldPosition(
  component: PlacedComponent,
  pin: PinDefinition,
): Point {
  const def = getDefinition(component.type);
  const cx = component.x + def.width / 2;
  const cy = component.y + def.height / 2;
  const px = component.x + pin.x;
  const py = component.y + pin.y;
  const rad = (component.rotation * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  return {
    x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

export function getPinPosition(
  ref: PinRef,
  components: PlacedComponent[],
): Point | null {
  const comp = components.find((c) => c.id === ref.componentId);
  if (!comp) return null;
  const def = getDefinition(comp.type);
  const pin = def.pins.find((p) => p.id === ref.pinId);
  if (!pin) return null;
  return pinWorldPosition(comp, pin);
}

/** Hit radius for pin hover, wiring snap, and crosshair alignment. */
export const PIN_SNAP_RADIUS = 14;

export type PinSnap = {
  pin: PinRef;
  position: Point;
};

/** Nearest pin within snap radius (exact pin center for cursor / wire preview). */
export function findPinSnap(
  world: Point,
  components: PlacedComponent[],
  radius = PIN_SNAP_RADIUS,
): PinSnap | null {
  let best: (PinSnap & { dist: number }) | null = null;
  for (const comp of components) {
    const def = getDefinition(comp.type);
    for (const pinDef of def.pins) {
      const position = pinWorldPosition(comp, pinDef);
      const dist = distance(position, world);
      if (dist <= radius && (!best || dist < best.dist)) {
        best = {
          pin: { componentId: comp.id, pinId: pinDef.id },
          position,
          dist,
        };
      }
    }
  }
  if (!best) return null;
  return { pin: best.pin, position: best.position };
}

/** Wire-routing cursor: snap to pin center when near a pin, else main grid. */
export function resolveWireCursorPoint(
  world: Point,
  components: PlacedComponent[],
  radius = PIN_SNAP_RADIUS,
): Point {
  return findPinSnap(world, components, radius)?.position ?? snapToGrid(world);
}

/** Orthogonal elbow from `from` toward `to` (alternates H-first / V-first). */
export function orthogonalSegment(
  from: Point,
  to: Point,
  segmentIndex: number,
): Point[] {
  if (from.x === to.x || from.y === to.y) {
    return [from, to];
  }
  const hFirst = segmentIndex % 2 === 0;
  if (hFirst) {
    return [from, { x: to.x, y: from.y }, to];
  }
  return [from, { x: from.x, y: to.y }, to];
}

/**
 * Like `orthogonalSegment`, but if the preferred elbow would reverse back along
 * the inbound leg (spur / hairpin), flip H/V order so the path leaves through
 * the bend instead of retreating past it.
 */
function orthogonalSegmentNoReverse(
  from: Point,
  to: Point,
  segmentIndex: number,
  inbound: Point | null,
): Point[] {
  if (from.x === to.x || from.y === to.y) {
    return [from, to];
  }
  const hFirst = segmentIndex % 2 === 0;
  const preferred = hFirst
    ? ([from, { x: to.x, y: from.y }, to] as Point[])
    : ([from, { x: from.x, y: to.y }, to] as Point[]);
  const alternate = hFirst
    ? ([from, { x: from.x, y: to.y }, to] as Point[])
    : ([from, { x: to.x, y: from.y }, to] as Point[]);
  if (!inbound) return preferred;

  const inDx = from.x - inbound.x;
  const inDy = from.y - inbound.y;
  const mid = preferred[1];
  const outDx = mid.x - from.x;
  const outDy = mid.y - from.y;
  const reverses =
    (inDx !== 0 && Math.sign(outDx) === -Math.sign(inDx)) ||
    (inDy !== 0 && Math.sign(outDy) === -Math.sign(inDy));
  return reverses ? alternate : preferred;
}

/** Board header pins (Uno/Nano edge rows) — route vertically off the row first. */
export function boardHeaderPinPrefersVerticalFirst(
  comp: PlacedComponent,
  pinId: string,
): boolean {
  if (comp.type !== 'arduino_uno' && comp.type !== 'arduino_nano') {
    return false;
  }
  const def = getDefinition(comp.type);
  const pin = def.pins.find((p) => p.id === pinId);
  if (!pin) return false;
  const ys = def.pins.map((p) => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return Math.abs(pin.y - minY) < 1 || Math.abs(pin.y - maxY) < 1;
}

/** Minimum visible wire lead out of a pin (world px). */
export const MIN_PIN_EXIT_DISTANCE = GRID_SIZE / 2;

/** Extra clearance beyond the component body hitbox (world px). */
export const PIN_EXIT_CLEARANCE = GRID_SIZE / 2;

/** @deprecated use MIN_PIN_EXIT_DISTANCE */
export const BOARD_HEADER_EXIT_DISTANCE = MIN_PIN_EXIT_DISTANCE;

/** Clearance when routing wires around component bodies. */
export const WIRE_OBSTACLE_CLEARANCE = GRID_SIZE;

const AXIS_EPS = 0.5;

/** Segments that are neither horizontal nor vertical (debug + resize checks). */
export function diagonalSegmentsOf(
  path: Point[],
): Array<{ i: number; a: Point; b: Point; dx: number; dy: number }> {
  const out: Array<{ i: number; a: Point; b: Point; dx: number; dy: number }> = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!sameAxisCoord(a.x, b.x) && !sameAxisCoord(a.y, b.y)) {
      out.push({
        i,
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
        dx: b.x - a.x,
        dy: b.y - a.y,
      });
    }
  }
  return out;
}

function sameAxisCoord(a: number, b: number): boolean {
  return Math.abs(a - b) <= AXIS_EPS;
}

type WorldAabb = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function componentLocalToWorld(
  comp: PlacedComponent,
  localX: number,
  localY: number,
): Point {
  return pinWorldPosition(comp, {
    id: '_',
    description: '',
    x: localX,
    y: localY,
    type: 'digital',
  });
}

/** Axis-aligned bounds of a component body in world space (supports rotation). */
export function componentBodyWorldAabb(comp: PlacedComponent): WorldAabb | null {
  const def = getDefinition(comp.type);
  const hit = getComponentBodyHitbox(comp.type);
  const rect = hit ?? { x: 0, y: 0, width: def.width, height: def.height };
  const corners = [
    componentLocalToWorld(comp, rect.x, rect.y),
    componentLocalToWorld(comp, rect.x + rect.width, rect.y),
    componentLocalToWorld(comp, rect.x + rect.width, rect.y + rect.height),
    componentLocalToWorld(comp, rect.x, rect.y + rect.height),
  ];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
}

function expandAabb(box: WorldAabb, pad: number): WorldAabb {
  return {
    minX: box.minX - pad,
    minY: box.minY - pad,
    maxX: box.maxX + pad,
    maxY: box.maxY + pad,
  };
}

function segmentIntersectsAabb(a: Point, b: Point, box: WorldAabb, pad: number): boolean {
  const hit = expandAabb(box, pad);
  if (sameAxisCoord(a.x, b.x)) {
    const x = (a.x + b.x) / 2;
    if (x < hit.minX || x > hit.maxX) return false;
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return maxY >= hit.minY && minY <= hit.maxY;
  }
  if (sameAxisCoord(a.y, b.y)) {
    const y = (a.y + b.y) / 2;
    if (y < hit.minY || y > hit.maxY) return false;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return maxX >= hit.minX && minX <= hit.maxX;
  }
  return false;
}

function pointInsideExpandedAabb(p: Point, box: WorldAabb, pad: number): boolean {
  const hit = expandAabb(box, pad);
  return p.x >= hit.minX && p.x <= hit.maxX && p.y >= hit.minY && p.y <= hit.maxY;
}

/** Shortest rectilinear route on obstacle-edge visibility coordinates. */
function routeAroundObstacles(from: Point, to: Point, boxes: WorldAabb[], clearance = WIRE_OBSTACLE_CLEARANCE): Point[] {
  const equal = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
  const blocked = (a: Point, b: Point) => boxes.some(box => {
    if (!segmentIntersectsAabb(a, b, box, clearance)) return false;
    // Close parts can cover the pin's clearance envelope. Only the endpoint
    // escape/approach may cross that envelope, never the actual body.
    if (segmentIntersectsAabb(a, b, box, 0)) return true;
    const escape = (p: Point, q: Point) =>
      (equal(p, from) || equal(p, to)) && pointInsideExpandedAabb(p, box, clearance) &&
      !pointInsideExpandedAabb(q, box, clearance);
    return !escape(a, b) && !escape(b, a);
  });
  const direct = orthogonalSegment(from, to, 0);
  if (direct.slice(1).every((p, i) => !blocked(direct[i], p))) return direct;
  const alternate = orthogonalSegment(from, to, 1);
  if (alternate.slice(1).every((p, i) => !blocked(alternate[i], p))) return alternate;
  // Search outside padded boundaries; rounding inward can re-enter the obstacle.
  const margin = clearance + 1;
  const xs = [...new Set([from.x, to.x, ...boxes.flatMap(b => [b.minX - margin, b.maxX + margin])])].sort((a,b) => a-b);
  const ys = [...new Set([from.y, to.y, ...boxes.flatMap(b => [b.minY - margin, b.maxY + margin])])].sort((a,b) => a-b);
  const width = xs.length;
  const start = ys.indexOf(from.y) * width + xs.indexOf(from.x);
  const goal = ys.indexOf(to.y) * width + xs.indexOf(to.x);
  const point = (id: number): Point => ({ x: xs[id % width], y: ys[Math.floor(id / width)] });
  const costs = new Map<number, number>([[start, 0]]);
  const parent = new Map<number, number>();
  const open = new Set([start]);
  const closed = new Set<number>();
  while (open.size) {
    let current = -1;
    let best = Infinity;
    for (const id of open) {
      const p = point(id);
      const score = costs.get(id)! + Math.abs(p.x - to.x) + Math.abs(p.y - to.y);
      if (score < best) { current = id; best = score; }
    }
    if (current === goal) {
      const result = [point(current)];
      while (parent.has(current)) { current = parent.get(current)!; result.push(point(current)); }
      return dedupeCollinear(result.reverse());
    }
    open.delete(current);
    closed.add(current);
    const x = current % width;
    const y = Math.floor(current / width);
    const neighbors = [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1,
      y > 0 ? current - width : -1, y + 1 < ys.length ? current + width : -1];
    // Endpoint escapes may need to jump over visibility coordinates inside padding.
    if (current === start) {
      for (let col = 0; col < width; col++) neighbors.push(y * width + col);
      for (let row = 0; row < ys.length; row++) neighbors.push(row * width + x);
    }
    if (x === goal % width || y === Math.floor(goal / width)) neighbors.push(goal);
    const a = point(current);
    for (const next of neighbors) {
      if (next < 0 || closed.has(next)) continue;
      const b = point(next);
      if (blocked(a, b)) continue;
      const cost = costs.get(current)! + Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost); parent.set(next, current); open.add(next);
    }
  }
  // If envelopes overlap, prefer a body-safe route with reduced clearance.
  // Actual overlapping bodies may make any route impossible; keep the fallback finite.
  return clearance > 0 ? routeAroundObstacles(from, to, boxes, 0) : direct;
}

/** Route between intentional waypoints, never feed generated detours back into the search. */
export function clearFreeSpaceWirePath(
  points: Point[],
  components: PlacedComponent[],
  skipComponentIds?: ReadonlySet<string>,
  mandatory: Point[] = [],
): Point[] {
  if (points.length < 2) return points;
  const boxes = components
    .filter(c => c.type !== 'breadboard' && c.type !== 'wire_junction' && !skipComponentIds?.has(c.id))
    .map(componentBodyWorldAabb).filter((b): b is WorldAabb => b !== null);
  const anchors = [points[0], ...mandatory.filter(p => !boxes.some(b =>
    pointInsideExpandedAabb(p, b, WIRE_OBSTACLE_CLEARANCE))), points[points.length - 1]];
  const result: Point[] = [anchors[0]];
  for (let i = 1; i < anchors.length; i++) {
    result.push(...routeAroundObstacles(anchors[i - 1], anchors[i], boxes).slice(1));
  }
  return dedupeCollinear(result);
}

/** @deprecated use clearFreeSpaceWirePath */
export function clearWirePathThroughComponents(
  points: Point[],
  components: PlacedComponent[],
  options?: { protectedSegmentCount?: number; protectedTailSegmentCount?: number },
): Point[] {
  if ((options?.protectedSegmentCount ?? 0) > 0 || (options?.protectedTailSegmentCount ?? 0) > 0) {
    const protectedStart = options?.protectedSegmentCount ?? 0;
    const protectedTail = options?.protectedTailSegmentCount ?? 0;
    if (points.length <= protectedStart + protectedTail + 1) return points;
    const head = points.slice(0, protectedStart + 1);
    const tail = protectedTail > 0 ? points.slice(points.length - 1 - protectedTail) : [];
    const midStart = protectedStart;
    const midEnd = points.length - protectedTail;
    const mid = clearFreeSpaceWirePath(points.slice(midStart, midEnd), components);
    return dedupeCollinear([...head, ...mid.slice(1), ...tail.slice(1)]);
  }
  return clearFreeSpaceWirePath(points, components);
}

/** Local exit direction from a pin (component-local axes). */
function pinExitDirectionLocal(
  comp: PlacedComponent,
  pinId: string,
): Point | null {
  const def = getDefinition(comp.type);
  const pin = def.pins.find((p) => p.id === pinId);
  if (!pin) return null;

  if (comp.type === 'arduino_uno' || comp.type === 'arduino_nano') {
    const ys = def.pins.map((p) => p.y);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (Math.abs(pin.y - minY) < 1) return { x: 0, y: -1 };
    if (Math.abs(pin.y - maxY) < 1) return { x: 0, y: 1 };
    return pin.y < def.height / 2 ? { x: 0, y: -1 } : { x: 0, y: 1 };
  }

  if (boardHeaderPinPrefersVerticalFirst(comp, pinId)) {
    const ys = def.pins.map((p) => p.y);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (Math.abs(pin.y - minY) < 1) return { x: 0, y: -1 };
    if (Math.abs(pin.y - maxY) < 1) return { x: 0, y: 1 };
  }

  const hit = getComponentBodyHitbox(comp.type);
  const toLeft = pin.x - hit.x;
  const toRight = hit.x + hit.width - pin.x;
  const toTop = pin.y - hit.y;
  const toBottom = hit.y + hit.height - pin.y;
  const min = Math.min(toLeft, toRight, toTop, toBottom);

  if (min === toTop) return { x: 0, y: -1 };
  if (min === toBottom) return { x: 0, y: 1 };
  if (min === toLeft) return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

function localDirectionToWorld(comp: PlacedComponent, localDir: Point): Point {
  const rad = (comp.rotation * Math.PI) / 180;
  return {
    x: localDir.x * Math.cos(rad) - localDir.y * Math.sin(rad),
    y: localDir.x * Math.sin(rad) + localDir.y * Math.cos(rad),
  };
}

/**
 * Point just outside the component body along the pin's exit axis.
 * Wires attach at the pin (inside the hitbox) but route from this portal in free space.
 * Keep the portal on the pin's exit axis — snapping the perpendicular axis onto the
 * breadboard grid creates micro-jogs (and rounded curves) between aligned header pins.
 */
export function pinWirePortal(
  comp: PlacedComponent,
  pinId: string,
  pinWorld: Point,
): Point | null {
  if (comp.type === 'breadboard') return null;
  // Tee nodes are pure electrical points — stubs create funnel/V artifacts at junctions.
  if (comp.type === WIRE_JUNCTION_TYPE) return null;

  const localDir = pinExitDirectionLocal(comp, pinId);
  if (!localDir) return null;
  const worldDir = localDirectionToWorld(comp, localDir);
  const aabb = componentBodyWorldAabb(comp);

  const snapAxis = (v: number) => Math.round(v / GRID_SIZE) * GRID_SIZE;
  const alongExit = (dist: number): Point => {
    const raw = {
      x: pinWorld.x + worldDir.x * dist,
      y: pinWorld.y + worldDir.y * dist,
    };
    // Vertical exit → lock X to pin; horizontal exit → lock Y to pin.
    if (Math.abs(worldDir.y) >= Math.abs(worldDir.x)) {
      return { x: pinWorld.x, y: snapAxis(raw.y) };
    }
    return { x: snapAxis(raw.x), y: pinWorld.y };
  };

  if (!aabb) {
    return alongExit(MIN_PIN_EXIT_DISTANCE);
  }

  let dist = MIN_PIN_EXIT_DISTANCE;
  const step = GRID_SIZE / 4;
  const routePad = WIRE_OBSTACLE_CLEARANCE + AXIS_EPS;
  const maxDist = Math.max(aabb.maxX - aabb.minX, aabb.maxY - aabb.minY) * 2;
  while (dist <= maxDist) {
    const candidate = alongExit(dist);
    if (!pointInsideExpandedAabb(candidate, aabb, routePad)) {
      return candidate;
    }
    dist += step;
  }

  return alongExit(dist);
}

/** @alias pinWirePortal */
export function pinWireExitStub(
  comp: PlacedComponent,
  pinId: string,
  pinWorld: Point,
): Point | null {
  return pinWirePortal(comp, pinId, pinWorld);
}

export type WireRouteOptions = {
  /** 0 = horizontal first leg, 1 = vertical first leg */
  startSegmentIndex?: number;
  /** Last leg into the destination pin runs vertically when true */
  endVerticalFirst?: boolean;
  /** Step off a board header row before horizontal routing (source pin). */
  exitStub?: Point;
  /** Step vertically before landing on a board header pin (destination). */
  approachStub?: Point;
  /**
   * Components to ignore while clearing free-space obstacles.
   * Do NOT put the wire's own from/to parts here — portals leave those bodies;
   * free-space legs must still detour if a route would cut back through them.
   */
  skipObstacleComponentIds?: ReadonlySet<string>;
  /** Keep stored bend geometry on rebuild (skip auto detours around components). */
  skipObstacleClearing?: boolean;
};

export type PinWireRouteHints = {
  startSegmentIndex: number;
  endVerticalFirst: boolean;
  /** Clearance point outside the header row for this pin. */
  headerStub?: Point;
};

export function wireRouteHintsFromPin(
  pin: PinRef,
  components: PlacedComponent[],
): PinWireRouteHints {
  const comp = components.find((c) => c.id === pin.componentId);
  if (!comp) {
    return { startSegmentIndex: 0, endVerticalFirst: false };
  }
  const pinWorld = getPinPosition(pin, components);
  if (!pinWorld) {
    return { startSegmentIndex: 0, endVerticalFirst: false };
  }
  let stub = pinWirePortal(comp, pin.pinId, pinWorld);
  if (stub) {
    const horizontal = sameAxisCoord(stub.y, pinWorld.y);
    const sign = Math.sign(horizontal ? stub.x - pinWorld.x : stub.y - pinWorld.y);
    let length = distance(pinWorld, stub);
    const ownBody = componentBodyWorldAabb(comp);
    const origin = horizontal ? pinWorld.x : pinWorld.y;
    const ownEdge = ownBody ? horizontal
      ? (sign > 0 ? ownBody.maxX : ownBody.minX)
      : (sign > 0 ? ownBody.maxY : ownBody.minY) : origin;
    const bodyExit = Math.max(0, (ownEdge - origin) * sign);
    for (const other of components) {
      if (other.id === comp.id || other.type === 'breadboard' || other.type === WIRE_JUNCTION_TYPE) continue;
      const body = componentBodyWorldAabb(other);
      if (!body || pointInsideExpandedAabb(pinWorld, body, 0)) continue;
      const pad = pointInsideExpandedAabb(pinWorld, body, WIRE_OBSTACLE_CLEARANCE) ? 0 : WIRE_OBSTACLE_CLEARANCE;
      if (!segmentIntersectsAabb(pinWorld, stub, body, pad)) continue;
      const box = expandAabb(body, pad + 1);
      const edge = horizontal ? (sign > 0 ? box.minX : box.maxX) : (sign > 0 ? box.minY : box.maxY);
      let available = (edge - origin) * sign;
      if (available <= bodyExit) {
        // Padding may overlap even when the bodies do not. Reduce clearance,
        // never shorten the protected lead back inside its own body.
        const actualEdge = horizontal ? (sign > 0 ? body.minX : body.maxX)
          : (sign > 0 ? body.minY : body.maxY);
        const gap = (actualEdge - origin) * sign - bodyExit;
        if (gap > 0) available = bodyExit + gap / 2;
      }
      if (available > bodyExit) length = Math.min(length, available);
    }
    stub = horizontal ? { x: pinWorld.x + sign * length, y: pinWorld.y }
      : { x: pinWorld.x, y: pinWorld.y + sign * length };
  }
  return {
    startSegmentIndex: 0,
    endVerticalFirst: !!stub,
    headerStub: stub ?? undefined,
  };
}

export function wireRouteOptionsFromPin(
  pin: PinRef,
  components: PlacedComponent[],
): WireRouteOptions {
  const hints = wireRouteHintsFromPin(pin, components);
  return {
    startSegmentIndex: hints.startSegmentIndex,
    endVerticalFirst: hints.endVerticalFirst,
    exitStub: hints.headerStub,
  };
}

export function wireRouteOptionsForWire(
  from: PinRef,
  to: PinRef,
  components: PlacedComponent[],
): WireRouteOptions {
  const start = wireRouteHintsFromPin(from, components);
  const end = wireRouteHintsFromPin(to, components);
  return {
    startSegmentIndex: start.startSegmentIndex,
    endVerticalFirst: end.endVerticalFirst,
    exitStub: start.headerStub,
    approachStub: end.headerStub,
  };
}

/** Anchor + segment index for the next bend while drafting a wire. */
export function wireDraftRouteAnchor(
  draftFrom: PinRef,
  bends: Point[],
  components: PlacedComponent[],
): { anchor: Point; segmentIndex: number } | null {
  const pinPos = getPinPosition(draftFrom, components);
  if (!pinPos) return null;
  const opts = wireRouteHintsFromPin(draftFrom, components);
  if (opts.headerStub && bends.length === 0) {
    return { anchor: opts.headerStub, segmentIndex: 0 };
  }
  const anchor = bends.length > 0 ? bends[bends.length - 1] : pinPos;
  const base = opts.headerStub ? 0 : opts.startSegmentIndex;
  return { anchor, segmentIndex: base + bends.length };
}

/**
 * Rubber-band cursor while drafting: lock to the route-anchor axis within half a
 * cell; otherwise snap the free axis in GRID_SIZE steps from that anchor.
 */
export function wireDraftRubberBandCursor(
  world: Point,
  draftFrom: PinRef,
  bends: Point[],
  components: PlacedComponent[],
): Point {
  const route = wireDraftRouteAnchor(draftFrom, bends, components);
  if (!route) return snapToGrid(world);
  const { anchor } = route;
  const lockX = Math.abs(world.x - anchor.x) <= GRID_SIZE / 2;
  const lockY = Math.abs(world.y - anchor.y) <= GRID_SIZE / 2;
  const stepped = snapRelativeToAnchor(world, anchor);
  return {
    x: lockX ? anchor.x : stepped.x,
    y: lockY ? anchor.y : stepped.y,
  };
}

/** Segment index for the next bend while routing from `draftFrom`. */
export function wireDraftBendSegmentIndex(
  draftFrom: PinRef,
  bendCount: number,
  components: PlacedComponent[],
): number {
  const opts = wireRouteHintsFromPin(draftFrom, components);
  const base = opts.headerStub ? 0 : opts.startSegmentIndex;
  return base + bendCount;
}

/**
 * Waypoint to store when the user left-clicks while routing.
 * Store the click (axis-locked / step-snapped), not the intermediate elbow —
 * `buildFreeSpaceOrthogonalPath` rebuilds H/V corners between waypoints.
 * Storing the elbow left the next segment anchored one corner behind (H_C2).
 */
export function commitWireBend(
  from: Point,
  click: Point,
  _segmentIndex: number,
): Point {
  const stepped = snapRelativeToAnchor(click, from);
  if (sameAxisCoord(from.x, click.x)) {
    return { x: from.x, y: stepped.y };
  }
  if (sameAxisCoord(from.y, click.y)) {
    return { x: stepped.x, y: from.y };
  }
  return stepped;
}

export function dedupeCollinear(points: Point[]): Point[] {
  if (points.length <= 2) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    if (prev.x === cur.x && prev.y === cur.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const sameX = a.x === prev.x && prev.x === cur.x;
      const sameY = a.y === prev.y && prev.y === cur.y;
      if (sameX || sameY) {
        out[out.length - 1] = cur;
        continue;
      }
    }
    out.push(cur);
  }
  return out;
}

function pointKey(p: Point): string {
  return `${p.x}:${p.y}`;
}

/** True when path[i] is a 90° H/V turn (not a straight-through point). */
function isOrthogonalCorner(points: Point[], index: number): boolean {
  if (index <= 0 || index >= points.length - 1) return false;
  const prev = points[index - 1];
  const curr = points[index];
  const next = points[index + 1];
  const dx1 = curr.x - prev.x;
  const dy1 = curr.y - prev.y;
  const dx2 = next.x - curr.x;
  const dy2 = next.y - curr.y;
  if (dx1 === 0 && dy1 === 0) return false;
  if (dx2 === 0 && dy2 === 0) return false;
  const inH = dy1 === 0 && dx1 !== 0;
  const inV = dx1 === 0 && dy1 !== 0;
  const outH = dy2 === 0 && dx2 !== 0;
  const outV = dx2 === 0 && dy2 !== 0;
  return (inH && outV) || (inV && outH);
}

function pathCornerPoints(points: Point[]): Point[] {
  const corners: Point[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    if (isOrthogonalCorner(points, i)) {
      corners.push(points[i]);
    }
  }
  return corners;
}

function dedupeCollinearPreserving(points: Point[], mandatory: Point[]): Point[] {
  if (points.length <= 2) return points;
  const mustKeep = new Set(mandatory.map(pointKey));
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    if (prev.x === cur.x && prev.y === cur.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const sameX = a.x === prev.x && prev.x === cur.x;
      const sameY = a.y === prev.y && prev.y === cur.y;
      // Never collapse away a mandatory waypoint (prev). Old check only guarded
      // `cur`, so a rubber-band retreat past a bend deleted the bend (H_C3).
      if (
        (sameX || sameY) &&
        !mustKeep.has(pointKey(cur)) &&
        !mustKeep.has(pointKey(prev))
      ) {
        out[out.length - 1] = cur;
        continue;
      }
    }
    out.push(cur);
  }
  return out;
}

/** Internal bend points extracted from a resolved path (excluding pins). */
export function pathToBends(points: Point[]): Point[] {
  if (points.length <= 2) return [];
  return points.slice(1, -1).map((p) => ({ ...p }));
}

/** Drop bends when the full path collapses to a straight pin-to-pin line. */
export function simplifyWireBends(
  from: Point,
  bends: Point[],
  to: Point,
): Point[] {
  return finalizeWireBends(from, buildOrthogonalPath(from, bends, to), to);
}

/** Merge collinear steps and drop redundant corners after an edit. */
export function normalizeWireBends(
  from: Point,
  path: Point[],
  to: Point,
  options?: WireRouteOptions,
  components?: PlacedComponent[],
): Point[] {
  const raw =
    path.length > 0 &&
    path[0].x === from.x &&
    path[0].y === from.y &&
    path[path.length - 1].x === to.x &&
    path[path.length - 1].y === to.y
      ? path
      : dedupeCollinear([from, ...path, to]);
  const mandatory = pathCornerPoints(raw);
  const pts = dedupeCollinearPreserving(raw, mandatory);
  if (pts.length <= 2) return [];
  const interior = pathToBends(pts);
  void options; void components;
  return interior;
}

export function finalizeWireBends(
  from: Point,
  path: Point[],
  to: Point,
  options?: WireRouteOptions,
  components?: PlacedComponent[],
): Point[] {
  return normalizeWireBends(from, path, to, options, components);
}

/** Contiguous horizontal run containing segmentIndex (inclusive segment index range). */
function horizontalRunSegmentRange(
  path: Point[],
  segmentIndex: number,
): [number, number] | null {
  if (segmentIndex < 0 || segmentIndex >= path.length - 1) return null;
  const a = path[segmentIndex];
  const b = path[segmentIndex + 1];
  if (!sameAxisCoord(a.y, b.y) || sameAxisCoord(a.x, b.x)) return null;

  const runY = a.y;
  let lo = segmentIndex;
  let hi = segmentIndex + 1;

  while (
    lo > 0 &&
    sameAxisCoord(path[lo - 1].y, runY) &&
    sameAxisCoord(path[lo].y, runY) &&
    !sameAxisCoord(path[lo - 1].x, path[lo].x)
  ) {
    lo--;
  }
  while (
    hi < path.length - 1 &&
    sameAxisCoord(path[hi].y, runY) &&
    sameAxisCoord(path[hi + 1].y, runY) &&
    !sameAxisCoord(path[hi].x, path[hi + 1].x)
  ) {
    hi++;
  }

  return [lo, hi];
}

/** Contiguous vertical run containing segmentIndex (inclusive segment index range). */
function verticalRunSegmentRange(
  path: Point[],
  segmentIndex: number,
): [number, number] | null {
  if (segmentIndex < 0 || segmentIndex >= path.length - 1) return null;
  const a = path[segmentIndex];
  const b = path[segmentIndex + 1];
  if (!sameAxisCoord(a.x, b.x) || sameAxisCoord(a.y, b.y)) return null;

  const runX = a.x;
  let lo = segmentIndex;
  let hi = segmentIndex + 1;

  while (
    lo > 0 &&
    sameAxisCoord(path[lo - 1].x, runX) &&
    sameAxisCoord(path[lo].x, runX) &&
    !sameAxisCoord(path[lo - 1].y, path[lo].y)
  ) {
    lo--;
  }
  while (
    hi < path.length - 1 &&
    sameAxisCoord(path[hi].x, runX) &&
    sameAxisCoord(path[hi + 1].x, runX) &&
    !sameAxisCoord(path[hi].y, path[hi + 1].y)
  ) {
    hi++;
  }

  return [lo, hi];
}

/** Move only the horizontal run that contains segmentIndex (not every run at the same y). */
function moveHorizontalRunAtSegment(
  out: Point[],
  segmentIndex: number,
  newY: number,
): void {
  const range = horizontalRunSegmentRange(out, segmentIndex);
  if (!range) return;
  const [lo, hi] = range;
  const runY = out[segmentIndex].y;
  for (let j = Math.max(1, lo); j <= Math.min(out.length - 2, hi); j++) {
    if (sameAxisCoord(out[j].y, runY)) {
      out[j] = { ...out[j], y: newY };
    }
  }
}

/** Move only the vertical run that contains segmentIndex (not every run at the same x). */
function moveVerticalRunAtSegment(
  out: Point[],
  segmentIndex: number,
  newX: number,
): void {
  const range = verticalRunSegmentRange(out, segmentIndex);
  if (!range) return;
  const [lo, hi] = range;
  const runX = out[segmentIndex].x;
  for (let j = Math.max(1, lo); j <= Math.min(out.length - 2, hi); j++) {
    if (sameAxisCoord(out[j].x, runX)) {
      out[j] = { ...out[j], x: newX };
    }
  }
}

/** Move the horizontal run attached to a corner in the given direction. */
function moveHorizontalRunFromCorner(
  out: Point[],
  cornerIndex: number,
  dir: 'in' | 'out',
  newY: number,
): void {
  const segmentIndex = dir === 'out' ? cornerIndex : cornerIndex - 1;
  if (segmentIndex < 0 || segmentIndex >= out.length - 1) return;
  moveHorizontalRunAtSegment(out, segmentIndex, newY);
}

/** Move the vertical run attached to a corner in the given direction. */
function moveVerticalRunFromCorner(
  out: Point[],
  cornerIndex: number,
  dir: 'in' | 'out',
  newX: number,
): void {
  const segmentIndex = dir === 'out' ? cornerIndex : cornerIndex - 1;
  if (segmentIndex < 0 || segmentIndex >= out.length - 1) return;
  moveVerticalRunAtSegment(out, segmentIndex, newX);
}

function wireCornerTopology(path: Point[], index: number) {
  const prev = path[index - 1];
  const cur = path[index];
  const next = path[index + 1];
  return {
    inH:
      sameAxisCoord(prev.y, cur.y) && !sameAxisCoord(prev.x, cur.x),
    inV:
      sameAxisCoord(prev.x, cur.x) && !sameAxisCoord(prev.y, cur.y),
    outH:
      sameAxisCoord(next.y, cur.y) && !sameAxisCoord(next.x, cur.x),
    outV:
      sameAxisCoord(next.x, cur.x) && !sameAxisCoord(next.y, cur.y),
  };
}

/** Crosshair anchor for a wire segment (axis-aligned midpoint). */
export function wireSegmentCrosshairPoint(a: Point, b: Point): Point {
  if (sameAxisCoord(a.y, b.y)) return { x: (a.x + b.x) / 2, y: a.y };
  if (sameAxisCoord(a.x, b.x)) return { x: a.x, y: (a.y + b.y) / 2 };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Persist only deliberate draft waypoints; generated elbows follow moving pins. */
export function bendsForCompletedWire(
  from: Point,
  to: Point,
  draftBends: Point[],
  fromPin: PinRef,
  toPin: PinRef,
  components: PlacedComponent[],
): Point[] {
  // Generated elbows/portals are resolved from current component positions, not persisted.
  void from; void to; void fromPin; void toPin; void components;
  return draftBends.map(p => ({ ...p }));
}

/** Default elbow corner when a wire has no stored bends. */
export function defaultWireBends(
  from: Point,
  to: Point,
  options?: WireRouteOptions,
  components?: PlacedComponent[],
): Point[] {
  return pathToBends(buildOrthogonalPath(from, [], to, options, components));
}

function buildFreeSpaceOrthogonalPath(
  from: Point,
  bends: Point[],
  to: Point,
  segIdx: number,
  endVerticalFirst: boolean,
): Point[] {
  if (bends.length === 0) {
    return dedupeCollinear(orthogonalSegment(from, to, segIdx));
  }

  let points = orthogonalSegment(from, bends[0], segIdx);
  for (let i = 1; i < bends.length; i++) {
    const prev = bends[i - 1];
    const bend = bends[i];
    const inbound = points.length >= 2 ? points[points.length - 2] : from;
    const seg = orthogonalSegmentNoReverse(prev, bend, segIdx + i, inbound);
    points = [...points, ...seg.slice(1)];
  }
  const last = bends[bends.length - 1];
  let tailIdx = segIdx + bends.length;
  if (endVerticalFirst && tailIdx % 2 === 0) {
    tailIdx += 1;
  }
  const inbound = points.length >= 2 ? points[points.length - 2] : from;
  const tail = orthogonalSegmentNoReverse(last, to, tailIdx, inbound);
  return dedupeCollinearPreserving([...points, ...tail.slice(1)], bends);
}

/** Remove retraced/self-intersecting tails left by moved endpoints or legacy route corners. */
function removeWireLoops(points: Point[]): Point[] {
  let out = dedupeCollinear(points);
  const between = (v: number, a: number, b: number) => v >= Math.min(a, b) && v <= Math.max(a, b);
  for (let pass = 0; pass < points.length; pass++) {
    let cut = false;
    for (let i = 0; i + 1 < out.length && !cut; i++) {
      const a = out[i], b = out[i + 1];
      for (let j = i + 2; j + 1 < out.length; j++) {
        const c = out[j], d = out[j + 1];
        let cross: Point | null = null;
        if (a.y === b.y && c.x === d.x && between(c.x, a.x, b.x) && between(a.y, c.y, d.y)) cross = { x: c.x, y: a.y };
        else if (a.x === b.x && c.y === d.y && between(a.x, c.x, d.x) && between(c.y, a.y, b.y)) cross = { x: a.x, y: c.y };
        else if (a.y === b.y && c.y === d.y && a.y === c.y) {
          const x = Math.max(Math.min(a.x,b.x), Math.min(c.x,d.x));
          if (x <= Math.min(Math.max(a.x,b.x), Math.max(c.x,d.x))) cross = { x, y: a.y };
        } else if (a.x === b.x && c.x === d.x && a.x === c.x) {
          const y = Math.max(Math.min(a.y,b.y), Math.min(c.y,d.y));
          if (y <= Math.min(Math.max(a.y,b.y), Math.max(c.y,d.y))) cross = { x: a.x, y };
        }
        if (!cross) continue;
        out = dedupeCollinear([...out.slice(0,i+1), cross, ...out.slice(j+1)]);
        cut = true;
        break;
      }
    }
    if (!cut) break;
  }
  return out;
}

function assembleWirePath(
  pinFrom: Point,
  pinTo: Point,
  freePath: Point[],
  exitPortal?: Point,
  approachPortal?: Point,
  mandatory: Point[] = [],
): Point[] {
  // Waypoints guide routing, but a moved endpoint must not leave a closed loop.
  void mandatory;
  const finish = (pts: Point[]) => removeWireLoops(pts);

  if (!exitPortal && !approachPortal) {
    if (freePath.length >= 2) return finish(freePath);
    return finish([pinFrom, pinTo]);
  }

  const parts: Point[] = [{ ...pinFrom }];
  if (exitPortal) parts.push({ ...exitPortal });

  for (const p of freePath) {
    const prev = parts[parts.length - 1];
    if (sameAxisCoord(prev.x, p.x) && sameAxisCoord(prev.y, p.y)) continue;
    parts.push({ ...p });
  }

  if (approachPortal) {
    const prev = parts[parts.length - 1];
    if (!sameAxisCoord(prev.x, approachPortal.x) || !sameAxisCoord(prev.y, approachPortal.y)) {
      parts.push({ ...approachPortal });
    }
    const last = parts[parts.length - 1];
    if (!sameAxisCoord(last.x, pinTo.x) || !sameAxisCoord(last.y, pinTo.y)) {
      parts.push({ ...pinTo });
    }
  }

  return finish(parts);
}

/** Align only a nearly matching terminal run, not unrelated bends on the same axis. */
function alignEndpointRuns(from: Point, to: Point, bends: Point[], options?: WireRouteOptions): Point[] {
  const result = bends.map(p => ({ ...p }));
  const align = (pin: Point, portal: Point | undefined, reverse: boolean) => {
    if (!portal || result.length === 0) return;
    const vertical = portal.x === pin.x && portal.y !== pin.y;
    const horizontal = portal.y === pin.y && portal.x !== pin.x;
    if (!vertical && !horizontal) return;
    const axis = vertical ? 'x' : 'y';
    const along = vertical ? 'y' : 'x';
    const index = reverse ? result.length - 1 : 0;
    const coordinate = result[index][axis];
    if (Math.abs(coordinate - pin[axis]) > GRID_SIZE / 2) return;
    const direction = Math.sign(portal[along] - pin[along]);
    // A legacy terminal run can end inside the clearance envelope. Align the
    // whole run when it also has a point outside; clearing drops the inside point.
    const run: number[] = [];
    for (let i = index; i >= 0 && i < result.length; i += reverse ? -1 : 1) {
      if (result[i][axis] !== coordinate) break;
      run.push(i);
    }
    if (!run.some(i => (result[i][along] - portal[along]) * direction >= -AXIS_EPS)) return;
    for (const i of run) result[i][axis] = pin[axis];
  };
  align(from, options?.exitStub, false);
  align(to, options?.approachStub, true);
  return result;
}

/** Build orthogonal path through bend points with H/V legs at both ends. */
export function buildOrthogonalPath(
  from: Point,
  bends: Point[],
  to: Point,
  options?: WireRouteOptions,
  components?: PlacedComponent[],
): Point[] {
  const exitPortal = options?.exitStub;
  const approachPortal = options?.approachStub;
  const routeFrom = exitPortal ?? from;
  const routeTo = approachPortal ?? to;
  bends = alignEndpointRuns(from, to, bends, options);
  // Continue along the pin→portal axis first, then turn. Forcing H-first (segIdx 0)
  // after a vertical exit put an elbow on the exit row; the next bend on that
  // column reverse-rubberbanded through it (e.g. 612→540→756 on x=378).
  let segIdx = options?.startSegmentIndex ?? 0;
  if (exitPortal) {
    if (
      sameAxisCoord(from.x, exitPortal.x) &&
      !sameAxisCoord(from.y, exitPortal.y)
    ) {
      segIdx = 1; // vertical exit → V-first
    } else if (
      sameAxisCoord(from.y, exitPortal.y) &&
      !sameAxisCoord(from.x, exitPortal.x)
    ) {
      segIdx = 0; // horizontal exit → H-first
    } else {
      segIdx = 0;
    }
  }

  const freePath = buildFreeSpaceOrthogonalPath(
    routeFrom,
    bends,
    routeTo,
    segIdx,
    !!options?.endVerticalFirst && !approachPortal,
  );

  const clearedFree =
    components &&
    components.length > 0 &&
    !options?.skipObstacleClearing
      ? clearFreeSpaceWirePath(
          freePath,
          components,
          options?.skipObstacleComponentIds,
          bends,
        )
      : freePath;

  return assembleWirePath(from, to, clearedFree, exitPortal, approachPortal, bends);
}

/** Interior bend points for storage, excluding auto-generated pin portals. */
function freeSpaceBendsFromPath(
  path: Point[],
  wire: Wire,
  components: PlacedComponent[],
): Point[] {
  const opts = wireRouteOptionsForWire(wire.from, wire.to, components);
  // Keep path coords — absolute snapToGrid shifts off-grid pin axes (e.g. 238 → 234).
  let bends = pathToBends(path).map((p) => ({ ...p }));

  if (opts.exitStub && bends.length > 0) {
    const stub = opts.exitStub;
    if (
      sameAxisCoord(bends[0].x, stub.x) &&
      sameAxisCoord(bends[0].y, stub.y)
    ) {
      bends = bends.slice(1);
    }
  }

  if (opts.approachStub && bends.length > 0) {
    const stub = opts.approachStub;
    const last = bends[bends.length - 1];
    if (
      sameAxisCoord(last.x, stub.x) &&
      sameAxisCoord(last.y, stub.y)
    ) {
      bends = bends.slice(0, -1);
    }
  }

  return bends;
}

/** Full polyline for a completed wire. */
export function resolveWirePoints(
  wire: Wire,
  components: PlacedComponent[],
): Point[] | null {
  const from = getPinPosition(wire.from, components);
  const to = getPinPosition(wire.to, components);
  if (!from || !to) return null;

  const opts = wireRouteOptionsForWire(wire.from, wire.to, components);


  return buildOrthogonalPath(
    from,
    wire.bends.map((p) => ({ x: p.x, y: p.y })),
    to,
    opts,
    components,
  );
}

/** Release legacy generated corners when they describe the current automatic route exactly. */
export function releaseAutomaticWireBends(wire: Wire, components: PlacedComponent[]): Wire {
  if (wire.bends.length === 0) return wire;
  const current = resolveWirePoints(wire, components);
  const automatic = resolveWirePoints({ ...wire, bends: [] }, components);
  if (!current || !automatic || current.length !== automatic.length) return wire;
  const same = current.every((p, i) => sameAxisCoord(p.x, automatic[i].x) && sameAxisCoord(p.y, automatic[i].y));
  return same ? { ...wire, bends: [] } : wire;
}

/** Bend points used for handles (materializes default elbow if needed). */
export function getWireBends(wire: Wire, components: PlacedComponent[]): Point[] {
  const path = resolveWirePoints(wire, components);
  return path ? pathToBends(path) : wire.bends.map(p => ({ ...p }));
}

/** Result of a live wire edit (before commit). */
export interface WireEditPreview {
  bends: Point[];
  path: Point[];
}

function resolveWireEditPreview(
  wire: Wire,
  components: PlacedComponent[],
  anchor: Point[],
  out: Point[],
): WireEditPreview {
  // Runs may reach a pin; keep it fixed and bridge to the displaced run.
  for (const end of ['end', 'start'] as const) {
    const pi = end === 'start' ? 0 : out.length - 1;
    const li = end === 'start' ? 1 : out.length - 2;
    const ai = end === 'start' ? 1 : anchor.length - 2;
    const pin = out[pi], leg = out[li];
    if (sameAxisCoord(pin.x, leg.x) || sameAxisCoord(pin.y, leg.y)) continue;
    const horizontal = sameAxisCoord(anchor[end === 'start' ? 0 : anchor.length - 1].y, anchor[ai].y);
    const elbow = horizontal ? { x: leg.x, y: pin.y } : { x: pin.x, y: leg.y };
    out.splice(end === 'start' ? 1 : out.length - 1, 0, elbow);
  }
  const bends = freeSpaceBendsFromPath(out, wire, components);
  const preview = resolveWirePoints({ ...wire, bends }, components) ?? out;
  return { bends: freeSpaceBendsFromPath(preview, wire, components), path: preview };
}

function applyWireHandleEdit(
  wire: Wire,
  components: PlacedComponent[],
  bendIndex: number,
  pos: Point,
  _allWires: Wire[],
  _commit: boolean,
  dragStartPath?: Point[] | null,
): WireEditPreview | null {
  const from = getPinPosition(wire.from, components);
  const to = getPinPosition(wire.to, components);
  if (!from || !to) return null;

  const anchor =
    dragStartPath && dragStartPath.length >= 2
      ? dragStartPath.map((p) => ({ ...p }))
      : resolveWirePoints(wire, components);
  if (!anchor || bendIndex < 0 || bendIndex >= anchor.length - 2) return null;

  const out = anchor.map((p) => ({ ...p }));
  const vertexIndex = bendIndex + 1;
  const T = snapWireDragRelative(pos, anchor[vertexIndex]);
  const { inH, inV, outH, outV } = wireCornerTopology(anchor, vertexIndex);

  if (inV && outH) {
    moveHorizontalRunFromCorner(out, vertexIndex, 'out', T.y);
  } else if (inH && outV) {
    moveVerticalRunFromCorner(out, vertexIndex, 'out', T.x);
  } else if (inV && outV) {
    out[vertexIndex] = { x: anchor[vertexIndex - 1].x, y: T.y };
  } else if (inH && outH) {
    out[vertexIndex] = { x: T.x, y: anchor[vertexIndex - 1].y };
  } else if (sameAxisCoord(anchor[vertexIndex - 1].x, anchor[vertexIndex].x)) {
    out[vertexIndex] = { x: anchor[vertexIndex - 1].x, y: T.y };
  } else {
    out[vertexIndex] = { x: T.x, y: anchor[vertexIndex - 1].y };
  }

  return resolveWireEditPreview(wire, components, anchor, out);
}

function applyWireSegmentEdit(
  wire: Wire,
  components: PlacedComponent[],
  segmentIndex: number,
  cursor: Point,
  _allWires: Wire[],
  _commit: boolean,
  dragStartPath?: Point[] | null,
): WireEditPreview | null {
  const from = getPinPosition(wire.from, components);
  const to = getPinPosition(wire.to, components);
  if (!from || !to) return null;

  const anchor =
    dragStartPath && dragStartPath.length >= 2
      ? dragStartPath.map((p) => ({ ...p }))
      : resolveWirePoints(wire, components);
  if (!anchor || segmentIndex < 0 || segmentIndex >= anchor.length - 1) return null;

  const a = anchor[segmentIndex];
  const b = anchor[segmentIndex + 1];
  const out = anchor.map((p) => ({ ...p }));
  const snapped = snapWireDragRelative(cursor, a);

  const isHorizontal =
    sameAxisCoord(a.y, b.y) && !sameAxisCoord(a.x, b.x);
  const isVertical =
    sameAxisCoord(a.x, b.x) && !sameAxisCoord(a.y, b.y);

  if (anchor.length === 2 && (isHorizontal || isVertical)) {
    // A straight wire has no internal vertices for the run movers to displace.
    // Create a pair of elbows while preserving both pins and their exit axes.
    const opts = wireRouteOptionsForWire(wire.from, wire.to, components);
    const start = opts.exitStub ?? from;
    const end = opts.approachStub ?? to;
    out.splice(1, 0, isHorizontal ? { x: start.x, y: snapped.y } : { x: snapped.x, y: start.y },
      isHorizontal ? { x: end.x, y: snapped.y } : { x: snapped.x, y: end.y });
    return resolveWireEditPreview(wire, components, anchor, out);
  }

  if (isHorizontal) {
    moveHorizontalRunAtSegment(out, segmentIndex, snapped.y);
  } else if (isVertical) {
    moveVerticalRunAtSegment(out, segmentIndex, snapped.x);
  } else {
    return null;
  }

  return resolveWireEditPreview(wire, components, anchor, out);
}

/** Apply a new position to a bend handle. */
export function moveWireInternalVertex(
  wire: Wire,
  components: PlacedComponent[],
  bendIndex: number,
  pos: Point,
  allWires: Wire[] = [],
  commit = true,
): Point[] {
  const result = applyWireHandleEdit(
    wire,
    components,
    bendIndex,
    pos,
    allWires,
    commit,
  );
  return result?.bends ?? wire.bends;
}

export function previewWireHandleMove(
  wire: Wire,
  components: PlacedComponent[],
  bendIndex: number,
  pos: Point,
  allWires: Wire[] = [],
  dragStartPath?: Point[] | null,
): WireEditPreview | null {
  return applyWireHandleEdit(
    wire,
    components,
    bendIndex,
    pos,
    allWires,
    false,
    dragStartPath,
  );
}

/** Drag an entire wire segment perpendicular to its axis. */
export function dragWireSegment(
  wire: Wire,
  components: PlacedComponent[],
  segmentIndex: number,
  cursor: Point,
  allWires: Wire[] = [],
  commit = true,
): Point[] {
  const result = applyWireSegmentEdit(
    wire,
    components,
    segmentIndex,
    cursor,
    allWires,
    commit,
  );
  return result?.bends ?? wire.bends;
}

export function previewWireSegmentDrag(
  wire: Wire,
  components: PlacedComponent[],
  segmentIndex: number,
  cursor: Point,
  allWires: Wire[] = [],
  dragStartPath?: Point[] | null,
): WireEditPreview | null {
  return applyWireSegmentEdit(
    wire,
    components,
    segmentIndex,
    cursor,
    allWires,
    false,
    dragStartPath,
  );
}

/** Commit the validated preview without a second snapping/routing pass. */
export function commitWireBendsFromPath(
  wire: Wire,
  path: Point[],
  components: PlacedComponent[],
  allWires: Wire[] = [],
): Point[] {
  void allWires;
  if (path.length < 2) return wire.bends;
  return freeSpaceBendsFromPath(dedupeCollinear(path), wire, components);
}

export function commitWireBends(
  wire: Wire,
  components: PlacedComponent[],
  allWires: Wire[] = [],
): Point[] {
  const from = getPinPosition(wire.from, components);
  const to = getPinPosition(wire.to, components);
  if (!from || !to) return wire.bends;

  const path = buildOrthogonalPath(
    from,
    wire.bends.map((p) => ({ x: p.x, y: p.y })),
    to,
    wireRouteOptionsForWire(wire.from, wire.to, components),
    components,
  );
  if (path.length <= 2) return [];
  return commitWireBendsFromPath(wire, path, components, allWires);
}

function clampSegmentCoord(value: number, min: number, max: number, margin: number): number {
  const lo = Math.min(min, max) + margin;
  const hi = Math.max(min, max) - margin;
  if (lo > hi) return (min + max) / 2;
  return Math.max(lo, Math.min(hi, value));
}

/** Insert an orthogonal jog (new joint) on a wire segment at the click location. */
export function insertWireJoint(
  wire: Wire,
  components: PlacedComponent[],
  click: Point,
  hitThreshold = WIRE_DRAG_GRID * 3,
): Point[] {
  const from = getPinPosition(wire.from, components);
  const to = getPinPosition(wire.to, components);
  if (!from || !to) return wire.bends;

  const path = resolveWirePoints(wire, components);
  if (!path) return wire.bends;

  const segIdx = findWireSegmentAt(path, click, hitThreshold);
  if (segIdx < 0) return wire.bends;

  const a = path[segIdx];
  const b = path[segIdx + 1];
  const snapped = snapToGrid(click);
  const jog = GRID_SIZE;
  const segLen =
    a.y === b.y ? Math.abs(b.x - a.x) : a.x === b.x ? Math.abs(b.y - a.y) : 0;
  if (segLen < jog) return wire.bends;
  const margin = Math.min(jog * 2, Math.max(jog, segLen * 0.15));

  let splice: Point[] = [];
  if (a.y === b.y) {
    const cx = clampSegmentCoord(snapped.x, a.x, b.x, margin);
    const offset =
      snapped.y === a.y ? jog : Math.sign(snapped.y - a.y) * jog;
    const cy = a.y + offset;
    splice = [
      { x: cx, y: a.y },
      { x: cx, y: cy },
      { x: b.x, y: cy },
    ];
  } else if (a.x === b.x) {
    const cy = clampSegmentCoord(snapped.y, a.y, b.y, margin);
    const offset =
      snapped.x === a.x ? jog : Math.sign(snapped.x - a.x) * jog;
    const cx = a.x + offset;
    splice = [
      { x: a.x, y: cy },
      { x: cx, y: cy },
      { x: cx, y: b.y },
    ];
  } else {
    return wire.bends;
  }

  const next = dedupeCollinearPreserving(
    [
      ...path.slice(0, segIdx + 1),
      ...splice,
      b,
      ...path.slice(segIdx + 2),
    ],
    pathCornerPoints(path),
  );
  if (next.length <= 2) return wire.bends;
  const opts = wireRouteOptionsForWire(wire.from, wire.to, components);
  return normalizeWireBends(from, next, to, opts, components);
}

/** Top-left so the junction pin sits at `world`. */
export function wireJunctionTopLeft(world: Point): Point {
  return { x: world.x - 1, y: world.y - 1 };
}

/** Project a click onto a wire segment (step-snapped along the segment). */
export function projectPointOntoWire(
  wire: Wire,
  components: PlacedComponent[],
  click: Point,
  hitThreshold = WIRE_DRAG_GRID * 3,
): { point: Point; segmentIndex: number; path: Point[] } | null {
  const path = resolveWirePoints(wire, components);
  if (!path || path.length < 2) return null;
  const segIdx = findWireSegmentAt(path, click, hitThreshold);
  if (segIdx < 0) return null;

  const a = path[segIdx];
  const b = path[segIdx + 1];
  let point: Point;
  if (sameAxisCoord(a.y, b.y) && !sameAxisCoord(a.x, b.x)) {
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    const raw = Math.max(lo, Math.min(hi, click.x));
    let x = a.x + Math.round((raw - a.x) / GRID_SIZE) * GRID_SIZE;
    x = Math.max(lo, Math.min(hi, x));
    point = { x, y: a.y };
  } else if (sameAxisCoord(a.x, b.x) && !sameAxisCoord(a.y, b.y)) {
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    const raw = Math.max(lo, Math.min(hi, click.y));
    let y = a.y + Math.round((raw - a.y) / GRID_SIZE) * GRID_SIZE;
    y = Math.max(lo, Math.min(hi, y));
    point = { x: a.x, y };
  } else {
    return null;
  }

  const endMargin = Math.max(GRID_SIZE / 2, PIN_SNAP_RADIUS * 0.5);
  if (
    distance(point, path[0]) < endMargin ||
    distance(point, path[path.length - 1]) < endMargin
  ) {
    return null;
  }
  return { point, segmentIndex: segIdx, path };
}

/** Split a resolved polyline at `at` on `segmentIndex` into left/right paths. */
export function splitWirePathAt(
  path: Point[],
  at: Point,
  segmentIndex: number,
): { left: Point[]; right: Point[] } | null {
  if (segmentIndex < 0 || segmentIndex >= path.length - 1) return null;
  const a = path[segmentIndex];
  const b = path[segmentIndex + 1];
  const atOnSeg =
    (sameAxisCoord(a.y, b.y) &&
      sameAxisCoord(at.y, a.y) &&
      at.x >= Math.min(a.x, b.x) - AXIS_EPS &&
      at.x <= Math.max(a.x, b.x) + AXIS_EPS) ||
    (sameAxisCoord(a.x, b.x) &&
      sameAxisCoord(at.x, a.x) &&
      at.y >= Math.min(a.y, b.y) - AXIS_EPS &&
      at.y <= Math.max(a.y, b.y) + AXIS_EPS);
  if (!atOnSeg) return null;

  const left = dedupeCollinear([...path.slice(0, segmentIndex + 1), { ...at }]);
  const right = dedupeCollinear([{ ...at }, ...path.slice(segmentIndex + 1)]);
  if (left.length < 2 || right.length < 2) return null;
  return { left, right };
}

/** Existing wire_junction pin within half a grid of `world`, if any. */
export function findWireJunctionPinAt(
  world: Point,
  components: PlacedComponent[],
  radius = GRID_SIZE / 2,
): PinRef | null {
  let best: PinRef | null = null;
  let bestDist = radius;
  for (const comp of components) {
    if (comp.type !== WIRE_JUNCTION_TYPE) continue;
    const pin: PinRef = { componentId: comp.id, pinId: WIRE_JUNCTION_PIN_ID };
    const pos = getPinPosition(pin, components);
    if (!pos) continue;
    const d = distance(world, pos);
    if (d <= bestDist) {
      bestDist = d;
      best = pin;
    }
  }
  return best;
}

/**
 * Drop wire_junction components with fewer than two attached wires.
 * Also drops the leftover single wire (otherwise it would reference a deleted pin).
 */
export function pruneOrphanWireJunctions(
  components: PlacedComponent[],
  wires: Wire[],
): { components: PlacedComponent[]; wires: Wire[] } {
  let comps = components;
  let ws = wires;
  for (let guard = 0; guard < 32; guard++) {
    const orphanIds = new Set<string>();
    for (const c of comps) {
      if (c.type !== WIRE_JUNCTION_TYPE) continue;
      const n = ws.filter(
        (w) => w.from.componentId === c.id || w.to.componentId === c.id,
      ).length;
      if (n < 2) orphanIds.add(c.id);
    }
    if (orphanIds.size === 0) break;
    ws = ws.filter(
      (w) =>
        !orphanIds.has(w.from.componentId) && !orphanIds.has(w.to.componentId),
    );
    comps = comps.filter((c) => !orphanIds.has(c.id));
  }
  return { components: comps, wires: ws };
}

export function getWireInternalVertices(
  wire: Wire,
  components: PlacedComponent[],
): Point[] {
  const path = resolveWirePoints(wire, components);
  if (!path || path.length <= 2) return [];
  return pathToBends(path);
}

export interface WireLineSegment {
  orientation: 'h' | 'v';
  /** y for horizontal, x for vertical */
  fixed: number;
  start: number;
  end: number;
}

function mergeOverlappingSegments(segments: WireLineSegment[]): WireLineSegment[] {
  const groups = new Map<string, WireLineSegment[]>();
  for (const seg of segments) {
    const key = `${seg.orientation}:${seg.fixed}`;
    const list = groups.get(key) ?? [];
    list.push(seg);
    groups.set(key, list);
  }

  const merged: WireLineSegment[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start);
    let current = { ...group[0] };
    for (let i = 1; i < group.length; i++) {
      const next = group[i];
      if (next.start <= current.end) {
        current.end = Math.max(current.end, next.end);
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
  }
  return merged;
}

/** Merge collinear wire pieces on the same grid step into one drawable segment. */
export function getMergedWireSegments(
  wires: Wire[],
  components: PlacedComponent[],
): WireLineSegment[] {
  const raw: WireLineSegment[] = [];
  for (const wire of wires) {
    const path = resolveWirePoints(wire, components);
    if (!path) continue;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (a.y === b.y) {
        raw.push({
          orientation: 'h',
          fixed: a.y,
          start: Math.min(a.x, b.x),
          end: Math.max(a.x, b.x),
        });
      } else if (a.x === b.x) {
        raw.push({
          orientation: 'v',
          fixed: a.x,
          start: Math.min(a.y, b.y),
          end: Math.max(a.y, b.y),
        });
      }
    }
  }
  return mergeOverlappingSegments(raw);
}

/** Solder dots only where ≥2 wires share a pin endpoint (not crossing/overlapping geometry). */
export function getWireJunctionPoints(
  wires: Wire[],
  components: PlacedComponent[],
): Point[] {
  const usage = new Map<string, { point: Point; count: number }>();
  for (const wire of wires) {
    const path = resolveWirePoints(wire, components);
    if (!path || path.length < 2) continue;
    const ends = [path[0], path[path.length - 1]];
    const seen = new Set<string>();
    for (const p of ends) {
      const key = `${p.x},${p.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = usage.get(key);
      if (entry) entry.count += 1;
      else usage.set(key, { point: { x: p.x, y: p.y }, count: 1 });
    }
  }
  return [...usage.values()]
    .filter((e) => e.count >= 2)
    .map((e) => e.point);
}

export function mergedWireSegmentsPath(segments: WireLineSegment[]): string {
  if (segments.length === 0) return '';

  const chains = wireSegmentChains(segments);
  return chains
    .map((chain) => roundedPolylinePath(chain))
    .join(' ');
}

function wireSegmentEndpoints(seg: WireLineSegment): [Point, Point] {
  if (seg.orientation === 'h') {
    return [
      { x: seg.start, y: seg.fixed },
      { x: seg.end, y: seg.fixed },
    ];
  }
  return [
    { x: seg.fixed, y: seg.start },
    { x: seg.fixed, y: seg.end },
  ];
}

/** Trace connected H/V segments into polylines for rounded rendering. */
function wireSegmentChains(segments: WireLineSegment[]): Point[][] {
  const visited = new Set<WireLineSegment>();
  const chains: Point[][] = [];

  for (const seed of segments) {
    if (visited.has(seed)) continue;

    const chain: Point[] = [];
    let current: WireLineSegment | null = seed;
    let at = wireSegmentEndpoints(seed)[0];

    while (current && !visited.has(current)) {
      visited.add(current);
      const [a, b] = wireSegmentEndpoints(current);
      const next = pointKey(a) === pointKey(at) ? b : a;
      if (chain.length === 0) chain.push({ ...at });
      chain.push({ ...next });
      at = next;

      current =
        segments.find((candidate) => {
          if (visited.has(candidate)) return false;
          const [ca, cb] = wireSegmentEndpoints(candidate);
          return pointKey(ca) === pointKey(at) || pointKey(cb) === pointKey(at);
        }) ?? null;
    }

    if (chain.length >= 2) chains.push(chain);
  }

  return chains;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  return distPointToSegment(p, a, b);
}

/** Closest segment index on a wire polyline, or -1. */
export function findWireSegmentAt(
  points: Point[],
  world: Point,
  threshold: number,
): number {
  let bestIdx = -1;
  let bestDist = threshold;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distToSegment(world, points[i], points[i + 1]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function findWireHandleAt(
  wire: Wire,
  components: PlacedComponent[],
  world: Point,
  radius: number,
): number {
  const verts = getWireInternalVertices(wire, components);
  for (let i = 0; i < verts.length; i++) {
    if (distance(world, verts[i]) <= radius) return i;
  }
  return -1;
}

/** True when `cursor` is on the free-space side of the exit portal (past the stub). */
function cursorPastPinExit(pin: Point, exit: Point, cursor: Point): boolean {
  const dx = exit.x - pin.x;
  const dy = exit.y - pin.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy < 0 ? cursor.y <= exit.y + AXIS_EPS : cursor.y >= exit.y - AXIS_EPS;
  }
  return dx < 0 ? cursor.x <= exit.x + AXIS_EPS : cursor.x >= exit.x - AXIS_EPS;
}

/** True when cursor has left the pin's exit-axis column/row (needs a sideways leg). */
function cursorOffPinExitAxis(pin: Point, exit: Point, cursor: Point): boolean {
  const dx = exit.x - pin.x;
  const dy = exit.y - pin.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return !sameAxisCoord(cursor.x, pin.x);
  }
  return !sameAxisCoord(cursor.y, pin.y);
}

/** Preview polyline while routing (start pin → bends → cursor or snapped target pin). */
export function resolveWireDraftPoints(
  draft: { from: PinRef; bends: Point[] },
  cursor: Point,
  components: PlacedComponent[],
  targetPin?: PinRef | null,
): Point[] | null {
  const from = getPinPosition(draft.from, components);
  if (!from) return null;

  const sameTarget =
    targetPin &&
    targetPin.componentId === draft.from.componentId &&
    targetPin.pinId === draft.from.pinId;

  if (targetPin && !sameTarget) {
    const to = getPinPosition(targetPin, components);
    if (!to) return null;
    const opts = wireRouteOptionsForWire(draft.from, targetPin, components);
    return buildOrthogonalPath(from, draft.bends, to, opts, components);
  }

  // Rubber-band: leave via exit portal (same as completed wires) so the draft
  // does not run horizontally/vertically through the origin body. Skip the
  // portal only while the cursor is still on the exit axis between pin and
  // portal — otherwise pin→exit→cursor hairpins.
  const fromOpts = wireRouteOptionsFromPin(draft.from, components);
  const exit = fromOpts.exitStub;
  const pastExit = exit ? cursorPastPinExit(from, exit, cursor) : true;
  const offAxis = exit ? cursorOffPinExitAxis(from, exit, cursor) : false;
  // Draft waypoints use the same obstacle policy as completed wires.
  const wantClear =
    !!(exit && (pastExit || offAxis));
  const opts: WireRouteOptions = wantClear
    ? {
        ...fromOpts,
        skipObstacleClearing: false,
        skipObstacleComponentIds: targetPin
          ? new Set([targetPin.componentId])
          : undefined,
      }
    : exit && draft.bends.length > 0
      ? {
          ...fromOpts,
          skipObstacleClearing: false,
        }
      : {
          startSegmentIndex: 0,
          endVerticalFirst: false,
          // With no protected pin lead (breadboard/junction), the entire
          // rubber band is free space and must still avoid component bodies.
          skipObstacleClearing: !!exit,
        };
  return buildOrthogonalPath(from, draft.bends, cursor, opts, components);
}

export function polylinePath(points: Point[]): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

/** Default corner fillet radius for rendered wires (world px). */
export const WIRE_CORNER_RADIUS = 7;

/**
 * Orthogonal polyline with quadratic fillets at every 90° corner (visual only).
 * Hit-testing still uses the underlying point list.
 */
export function roundedPolylinePath(
  points: Point[],
  radius = WIRE_CORNER_RADIUS,
): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) return polylinePath(points);

  let d = `M ${points[0].x} ${points[0].y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 === 0 || len2 === 0) {
      d += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    const r = Math.min(radius, len1 / 2, len2 / 2);
    const p1 = {
      x: curr.x + (v1x / len1) * r,
      y: curr.y + (v1y / len1) * r,
    };
    const p2 = {
      x: curr.x + (v2x / len2) * r,
      y: curr.y + (v2y / len2) * r,
    };
    d += ` L ${p1.x} ${p1.y} Q ${curr.x} ${curr.y} ${p2.x} ${p2.y}`;
  }

  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function pointInRect(p: Point, rect: Rect): boolean {
  return (
    p.x >= rect.x &&
    p.x <= rect.x + rect.width &&
    p.y >= rect.y &&
    p.y <= rect.y + rect.height
  );
}

function segmentsIntersect(
  a1: number,
  a2: number,
  b1: number,
  b2: number,
): boolean {
  const loA = Math.min(a1, a2);
  const hiA = Math.max(a1, a2);
  const loB = Math.min(b1, b2);
  const hiB = Math.max(b1, b2);
  return hiA >= loB && hiB >= loA;
}

/** True when any vertex lies inside the rect or a segment crosses it. */
export function polylineIntersectsRect(points: Point[], rect: Rect): boolean {
  if (points.length === 0) return false;
  if (points.some((p) => pointInRect(p, rect))) return true;
  if (points.length < 2) return false;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.y === b.y) {
      if (
        a.y >= rect.y &&
        a.y <= rect.y + rect.height &&
        segmentsIntersect(a.x, b.x, rect.x, rect.x + rect.width)
      ) {
        return true;
      }
    } else if (a.x === b.x) {
      if (
        a.x >= rect.x &&
        a.x <= rect.x + rect.width &&
        segmentsIntersect(a.y, b.y, rect.y, rect.y + rect.height)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Wires whose resolved path intersects a marquee rectangle. */
export function wiresInMarquee(
  wires: Wire[],
  components: PlacedComponent[],
  rect: Rect,
): string[] {
  const hits: string[] = [];
  for (const wire of wires) {
    const path = resolveWirePoints(wire, components);
    if (path && polylineIntersectsRect(path, rect)) hits.push(wire.id);
  }
  return hits;
}

function distPointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function distanceToPolyline(points: Point[], point: Point): number {
  if (points.length < 2) {
    return points.length === 1 ? distance(point, points[0]) : Infinity;
  }
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    min = Math.min(min, distPointToSegment(point, points[i], points[i + 1]));
  }
  return min;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function screenToWorld(
  screenX: number,
  screenY: number,
  viewport: { x: number; y: number; zoom: number },
  rect: DOMRect,
): Point {
  return {
    x: (screenX - rect.left - viewport.x) / viewport.zoom,
    y: (screenY - rect.top - viewport.y) / viewport.zoom,
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectFromPoints(x1: number, y1: number, x2: number, y2: number): Rect {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return {
    x,
    y,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

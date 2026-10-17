/**
 * What: Primary breadboard SVG workspace — pan/zoom, place/drag parts, wire routing, selection, editors.
 * Exports SimCanvas; orchestrates SimContext (geometry, placement, undo) + simLiveStore (pin/sim flags while
 * running). Renders ComponentShape per component, PinLabel on snap/hover, WireFlowOverlay, NgspiceDebugOverlay
 * when dcSolverBackend is ngspice; mounts ContextMenu and part-declared property editors.
 * World coords via ui/canvas/geometry (screenToWorld, snap, wire polylines). To add canvas interaction: extend
 * pointer handlers/state here and dispatch store actions. To add context-menu or double-click edit flow: build
 * ContextMenuItem list or setPropertiesEditor target. Property fields/custom editors live with each part;
 * adding a part does not require another canvas branch.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 25-09-2026 | Cursor | CapacitorValueEditor for ceramic / polarized
# 05-10-2026 | Cursor | Wire draft cursor axis-locks to start pin (off-grid pins no longer force grid jogs)
#                     | Blur IDE/editor on canvas pointer so Delete works after selecting parts/wires
# 06-10-2026 | Cursor | Draft cursor/bends use wireDraftRubberBandCursor (step-from-anchor, not board grid)
#                     | Draft click on existing wire completes as tee (completeWireOnWire); stripped join debug logs
# 09-10-2026 | Cursor | Moved from `src/components/SimCanvas.tsx` (tree reorganization)
# 12-10-2026 | Cursor | Ds3231PropertiesEditor for RTC I2C address
# 13-10-2026 | Codex | Replace type-specific editor branches with registered forms; chip-name editor becomes fallback only.
#                     | Custom Editor takes precedence over fields; chip-name editing is the fallback, never a stacked second dialog.
#                     | Property saves still use updateComponent, preserving undo and stopping active simulation.
# 14-10-2026 | Codex | Render GPIO warning badges above hit layers so their measured-current tooltips receive hover.
#                    | Keep automatic routes automatic until edited; choose the drag target at pointer-down.
#                     | Attach shared delayed measurement tooltip to part, pin and wire hit targets while running.
# 15-10-2026 | Codex | Default power-connected wires to red and GND/VSS nets to black, including junctions/breadboards and drafts; ground wins mixed nets.
#                     | Outline black ground wires in light gray for contrast against the dark canvas, including draft previews.
#                     | Pause wire motion during pointer gestures and wheel bursts; resume after release/cancel or 150 ms wheel idle without rerendering the canvas.
#                     | Cache resolved wire routes and junctions by circuit geometry so zoom and simulation renders do not rerun obstacle routing; live wire previews bypass the cache.
#                     | Pass live wire preview identity to invalidate the overlay cache during wire editing.
#                     | Skip pin-hover and placement calculations during panning; cancel pending hover work and avoid redundant panning-state updates.
#                     | Keep wire motion active during running pushbutton presses; dragging, panning and zooming still pause it.
# 16-10-2026 | Codex | Let individual button shapes subscribe to pressed appearance instead of rebuilding the canvas through editor state.
# 17-10-2026 | Codex  | Add editable named nets on pins and junctions; labels follow parts and use existing undo/save paths.
#                     | Preview toolbar labels under the cursor, highlight pin snaps, and allow standalone labels to move.

#                     | Double-click empty canvas to finish a wire with a connectable free end.
 */
import { Profiler, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { getDefinition } from '../../registry/components';
import { buildCircuitNetlist } from '../../circuit/netlist';
import { GpioOvercurrentOverlay } from './ComponentOverlays';
import { getComponentBodyHitbox, pointInComponentHitbox, componentPlacementPivot } from '../../registry/componentHitbox';
import { useSim } from '../../store/SimContext';
import {
  getSimLiveSnapshot,
  pinStateForComponent,
  subscribeSimLive,
} from '../../store/simLiveStore';
import type { PinRef, PlacedComponent, Wire } from '../../types';
import {
  commitWireBend,
  distanceToPolyline,
  commitWireBends,
  commitWireBendsFromPath,
  previewWireHandleMove,
  previewWireSegmentDrag,
  findPinSnap,
  findWireHandleAt,
  findWireSegmentAt,
  getPinPosition,
  getWireInternalVertices,
  getWireJunctionPoints,
  insertWireJoint,
  pathToBends,
  PIN_SNAP_RADIUS,
  polylinePath,
  rectFromPoints,
  rectsIntersect,
  resolveWireDraftPoints,
  wireDraftRouteAnchor,
  wireDraftRubberBandCursor,
  resolveWirePoints,
  roundedPolylinePath,
  screenToWorld,
  snapComponentPlacement,
  snapToGrid,
  GRID_SIZE,
  wiresInMarquee,
  wireSegmentCrosshairPoint,
  type Point,
} from './geometry';
import { componentHasEditableProperties, componentHasChipMarking } from '../editors/editable';
import { getPartModule } from '../../components';
import { PartPropertiesEditor } from '../editors/PartPropertiesEditor';
import { ComponentShape } from './ComponentShape';
import { ContextMenu } from './ContextMenu';
import { PartLabelEditor } from '../editors/PartLabelEditor';
import { PinLabel } from './ComponentShape';
import { WireFlowOverlay } from './WireFlowOverlay';
import { NgspiceDebugOverlay } from '../debug/NgspiceDebugOverlay';
import { MeasurementTooltip } from './MeasurementTooltip';
import { SimPerfOverlay } from '../debug/SimPerfOverlay';
import { isSimPerfEnabled, recordStutter, recordCanvasCommit } from '../../avr/simPerf';
import { wireShowsCurrent } from '../../circuit/currents';

const PIN_HIT_RADIUS = PIN_SNAP_RADIUS;
const PIN_DOT_RADIUS = 4;
const PIN_CROSSHAIR_ARM = 8;
/** World-span for wire-resize alignment guides through the edited point. */
const WIRE_RESIZE_CROSSHAIR_SPAN = 2400;
const BREADBOARD_HOLE_HIT_RADIUS = 4;
const WIRE_HIT_THRESHOLD = 10;
const WIRE_HANDLE_RADIUS = 10;
const WIRE_SEGMENT_HIT = 12;
const MARQUEE_MIN_SIZE = 4;

/** Drop IDE/editor keyboard focus so canvas shortcuts (Delete, etc.) apply. */
function blurEditableFocus(): void {
  const ae = document.activeElement as HTMLElement | null;
  if (!ae) return;
  const tag = (ae.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || ae.isContentEditable) {
    ae.blur();
  }
}

type Marquee = { x1: number; y1: number; x2: number; y2: number };

type Interaction =
  | {
      kind: 'pan';
      startX: number;
      startY: number;
      vx: number;
      vy: number;
      vz: number;
      immediate?: boolean;
      pendingX?: number;
      pendingY?: number;
    }
  | { kind: 'marquee'; box: Marquee; additive: boolean }
  | {
      kind: 'single';
      componentId: string;
      offsetX: number;
      offsetY: number;
    }
  | {
      kind: 'group';
      startWorld: { x: number; y: number };
      origins: Record<string, { x: number; y: number }>;
      leadId: string;
    }
  | {
      kind: 'wire-handle';
      wireId: string;
      handleIndex: number;
      dragStartPath: Point[];
    }
  | {
      kind: 'wire-segment';
      wireId: string;
      segmentIndex: number;
      dragStartPath: Point[];
    }
  | {
      kind: 'wire-pending';
      wireId: string;
      startX: number;
      startY: number;
    };

const WIRE_DRAG_THRESHOLD = 4;
const RIGHT_PAN_THRESHOLD = 4;
const WIRE_DOUBLE_CLICK_MS = 400;
const WIRE_DOUBLE_CLICK_PX = 12;
const PROPERTIES_DOUBLE_CLICK_MS = WIRE_DOUBLE_CLICK_MS;
const PROPERTIES_DOUBLE_CLICK_PX = WIRE_DOUBLE_CLICK_PX;

export function SimCanvas() {
  const traceBuildStart = performance.now();
  const {
    state,
    setViewport,
    select,
    moveComponent,
    updateComponent,
    pinClick,
    completeWireOnWire,
    addWireBend,
    updateWireBends,
    cancelWire,
    cancelPlacement,
    confirmPlacement,
    confirmNetLabelPlacement,
    rotatePlacement,
    deleteSelected,
    recordUndoSnapshot,
    rotateSelected,
    undo,
    redo,
    copySelection,
    pasteSelection,
    canPaste,
    setButtonPressed,
    setPotPosition,
    setCanvasInteracting,
  } = useSim();

  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canvas = wrapRef.current;
    if (!canvas) return;
    const pointers = new Set<number>();
    let wheelIdle: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      if (pointers.size || wheelIdle !== undefined) canvas.dataset.wireMotionPaused = 'true';
      else delete canvas.dataset.wireMotionPaused;
    };
    const down = (event: PointerEvent) => {
      if (event.button === 0 && !spaceDownRef.current &&
          event.target instanceof Element && event.target.closest('[data-sim-button="true"]')) return;
      pointers.add(event.pointerId); sync();
    };
    const up = (event: PointerEvent) => { pointers.delete(event.pointerId); sync(); };
    const wheel = () => {
      clearTimeout(wheelIdle);
      wheelIdle = setTimeout(() => { wheelIdle = undefined; sync(); }, 150);
      sync();
    };
    const reset = () => {
      pointers.clear(); clearTimeout(wheelIdle); wheelIdle = undefined; sync();
    };
    canvas.addEventListener('pointerdown', down, true);
    canvas.addEventListener('wheel', wheel, { passive: true, capture: true });
    canvas.addEventListener('lostpointercapture', up);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', reset);
    return () => {
      reset();
      canvas.removeEventListener('pointerdown', down, true);
      canvas.removeEventListener('wheel', wheel, true);
      canvas.removeEventListener('lostpointercapture', up);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', reset);
    };
  }, []);
  const worldGroupRef = useRef<SVGGElement>(null);
  const suppressContextMenuRef = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const lastWireTapRef = useRef<{
    wireId: string;
    t: number;
    x: number;
    y: number;
  } | null>(null);
  const lastPropertiesTapRef = useRef<{
    componentId: string;
    t: number;
    x: number;
    y: number;
  } | null>(null);
  const lastJointInsertRef = useRef<{ wireId: string; t: number } | null>(null);
  const wireEditPathRef = useRef<{
    wireId: string;
    path: { x: number; y: number }[];
  } | null>(null);
  const [, setWireEditTick] = useState(0);
  const [wireResizeCrosshair, setWireResizeCrosshair] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    componentIds: string[];
    pasteAtWorld?: { x: number; y: number };
    netPin?: { componentId: string; pinId: string };
  } | null>(null);
  const [netEditor, setNetEditor] = useState<{ componentId: string; pinId: string; x: number; y: number } | null>(null);
  const [propertiesEditor, setPropertiesEditor] = useState<{
    componentId: string;
    x: number;
    y: number;
  } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const isPanningRef = useRef(false);
  const pendingWheelRef = useRef<{
    deltaY: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const [spacePan, setSpacePan] = useState(false);
  const spaceDownRef = useRef(false);
  const [wireCursor, setWireCursor] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [wireCursorPin, setWireCursorPin] = useState<PinRef | null>(null);
  const [hoveredPinSnap, setHoveredPinSnap] = useState<{
    pin: PinRef;
    position: { x: number; y: number };
  } | null>(null);
  const hoverPinRafRef = useRef<number | null>(null);
  const pendingHoverPinRef = useRef<typeof hoveredPinSnap>(null);
  /** Snapped top-left of the component currently being placed. */
  const [netPreview, setNetPreview] = useState<{ x: number; y: number } | null>(null);
  const [placementPreview, setPlacementPreview] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const {
    viewport,
    components,
    wires,
    selectedIds,
    selectedWireIds,
    wireDraft,
    placementType,
    placementRotation,
    simStatus,
  } = state;
  const liveSnap = useSyncExternalStore(
    subscribeSimLive,
    getSimLiveSnapshot,
    getSimLiveSnapshot,
  );
  const simFlags = simStatus === 'running' ? liveSnap.simFlags : undefined;
  const ngspiceDebug =
    simStatus === 'running' && liveSnap.dcSolverBackend === 'ngspice'
      ? liveSnap.ngspiceDebug
      : null;
  const simPerfOverlay =
    simStatus === 'running' && isSimPerfEnabled() && liveSnap.simPerf
      ? liveSnap.simPerf
      : null;
  void liveSnap.version;
  const selectedSet = new Set(selectedIds);
  const selectedWireSet = new Set(selectedWireIds);
  const pinWireColors = useMemo(() => {
    const colors = new Map<string, string>();
    for (const component of components) {
      for (const pin of getDefinition(component.type).pins) {
        const names = [pin.id, pin.description].map(name => name?.trim().toUpperCase());
        if (pin.type === 'ground' || names.some(name => name === 'GND' || name === 'VSS')) {
          colors.set(`${component.id}:${pin.id}`, '#000000');
        } else if (pin.type === 'power' || names.some(name => name === 'VCC')) {
          colors.set(`${component.id}:${pin.id}`, '#ff0000');
        }
      }
    }
    // Use actual copper connectivity, not simulation HIGH/LOW or component conduction.
    for (const pins of buildCircuitNetlist(components, wires).nets.values()) {
      const keys = pins.map(pin => `${pin.componentId}:${pin.pinId}`);
      const color = keys.some(key => colors.get(key) === '#000000') ? '#000000'
        : keys.some(key => colors.get(key) === '#ff0000') ? '#ff0000' : undefined;
      if (color) for (const key of keys) colors.set(key, color);
    }
    return colors;
  }, [components, wires]);

  const setPanningVisual = useCallback((active: boolean) => {
    if (isPanningRef.current === active) return;
    isPanningRef.current = active;
    setIsPanning(active);
    wrapRef.current?.classList.toggle('is-panning', active);
  }, []);

  const breadboardComponents = useMemo(
    () => components.filter((c) => c.type === 'breadboard'),
    [components],
  );
  const partComponents = useMemo(
    () => components.filter((c) => c.type !== 'breadboard'),
    [components],
  );

  const resolvePlacementTopLeft = useCallback(
    (type: string, cursorWorld: { x: number; y: number }, rotation: number) => {
      const def = getDefinition(type);
      const pivot = componentPlacementPivot(type, def);
      const rawTopLeft = {
        x: cursorWorld.x - pivot.x,
        y: cursorWorld.y - pivot.y,
      };
      return snapComponentPlacement(type, rawTopLeft, rotation, components);
    },
    [components],
  );

  const getActiveViewport = useCallback((): typeof viewport => {
    const interaction = interactionRef.current;
    if (interaction?.kind === 'pan') {
      return {
        x: interaction.pendingX ?? interaction.vx,
        y: interaction.pendingY ?? interaction.vy,
        zoom: interaction.vz,
      };
    }
    return viewport;
  }, [viewport]);

  const getWorldPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return screenToWorld(clientX, clientY, getActiveViewport(), rect);
    },
    [getActiveViewport],
  );

  const findPinOnComponent = useCallback(
    (comp: PlacedComponent, worldX: number, worldY: number): PinRef | null => {
      const snap = findPinSnap(
        { x: worldX, y: worldY },
        [comp],
        PIN_HIT_RADIUS,
      );
      return snap?.pin ?? null;
    },
    [],
  );

  /** Match click to the snapped pin shown by the ghost crosshair (not topmost SVG hit target). */
  const resolvePinClick = useCallback(
    (world: { x: number; y: number }, hitPin?: PinRef): PinRef | null => {
      if (hoveredPinSnap) {
        const hoverDist = Math.hypot(
          hoveredPinSnap.position.x - world.x,
          hoveredPinSnap.position.y - world.y,
        );
        if (hoverDist <= PIN_HIT_RADIUS) {
          return hoveredPinSnap.pin;
        }
      }
      const snap = findPinSnap(world, components, PIN_HIT_RADIUS);
      if (snap) return snap.pin;
      return hitPin ?? null;
    },
    [components, hoveredPinSnap],
  );

  const scheduleHoveredPinUpdate = useCallback(
    (world: { x: number; y: number } | null) => {
      pendingHoverPinRef.current = world
        ? findPinSnap(world, components, PIN_HIT_RADIUS)
        : null;
      if (hoverPinRafRef.current !== null) return;
      hoverPinRafRef.current = requestAnimationFrame(() => {
        hoverPinRafRef.current = null;
        const next = pendingHoverPinRef.current;
        setHoveredPinSnap((prev) => {
          if (!next && !prev) return prev;
          if (
            next &&
            prev &&
            next.pin.componentId === prev.pin.componentId &&
            next.pin.pinId === prev.pin.pinId
          ) {
            return prev;
          }
          return next;
        });
      });
    },
    [components],
  );

  const syncWireCursor = useCallback(
    (world: { x: number; y: number }) => {
      const snap = findPinSnap(world, components, PIN_HIT_RADIUS);
      if (snap) {
        setWireCursor(snap.position);
        setWireCursorPin(snap.pin);
        return;
      }
      setWireCursorPin(null);
      // Rubber-band: lock to route-anchor axis; free axis steps from that anchor.
      if (wireDraft) {
        setWireCursor(
          wireDraftRubberBandCursor(
            world,
            wireDraft.from,
            wireDraft.bends,
            components,
          ),
        );
        return;
      }
      setWireCursor(snapToGrid(world));
    },
    [components, wireDraft],
  );

  const beginComponentDrag = useCallback(
    (hit: PlacedComponent, world: { x: number; y: number }, pointerId: number) => {
      if (!wrapRef.current) return;
      setCanvasInteracting(true);
      const dragIds =
        selectedSet.has(hit.id) && selectedIds.length > 1
          ? selectedIds
          : [hit.id];
      select(dragIds, []);

      if (dragIds.length > 1) {
        recordUndoSnapshot();
        const origins: Record<string, { x: number; y: number }> = {};
        for (const id of dragIds) {
          const c = components.find((x) => x.id === id);
          if (c) origins[id] = { x: c.x, y: c.y };
        }
        interactionRef.current = {
          kind: 'group',
          startWorld: world,
          origins,
          leadId: hit.id,
        };
      } else {
        recordUndoSnapshot();
        interactionRef.current = {
          kind: 'single',
          componentId: hit.id,
          offsetX: world.x - hit.x,
          offsetY: world.y - hit.y,
        };
      }
      wrapRef.current.setPointerCapture(pointerId);
    },
    [selectedSet, selectedIds, components, select, recordUndoSnapshot, setCanvasInteracting],
  );

  const findComponentAt = useCallback(
    (worldX: number, worldY: number): PlacedComponent | null => {
      const topFirst = [...partComponents].reverse().concat(
        [...breadboardComponents].reverse(),
      );
      return (
        topFirst.find((c) => pointInComponentHitbox(c, worldX, worldY)) ?? null
      );
    },
    [partComponents, breadboardComponents],
  );

  const wirePaths = useMemo(() => new Map(
    wires.map(wire => [wire.id, resolveWirePoints(wire, components)] as const),
  ), [wires, components]);
  const wireJunctions = useMemo(() => getWireJunctionPoints(wires, components), [wires, components]);

  const getWirePath = useCallback(
    (wire: Wire) => {
      const liveEdit = wireEditPathRef.current;
      if (liveEdit?.wireId === wire.id) return liveEdit.path;
      return wirePaths.get(wire.id) ?? null;
    },
    [wirePaths],
  );

  const findWireAt = useCallback(
    (worldX: number, worldY: number): string | null => {
      let bestId: string | null = null;
      let bestDist = WIRE_HIT_THRESHOLD;
      for (const wire of wires) {
        const points = getWirePath(wire);
        if (!points) continue;
        const d = distanceToPolyline(points, { x: worldX, y: worldY });
        if (d < bestDist) {
          bestDist = d;
          bestId = wire.id;
        }
      }
      return bestId;
    },
    [wires, getWirePath],
  );

  const selectInMarquee = useCallback(
    (box: Marquee, additive = false) => {
      const rect = rectFromPoints(box.x1, box.y1, box.x2, box.y2);
      if (rect.width < MARQUEE_MIN_SIZE && rect.height < MARQUEE_MIN_SIZE) {
        if (!additive) select([], []);
        return;
      }
      const compHits = components
        .filter((c) => {
          const def = getDefinition(c.type);
          return rectsIntersect(rect, {
            x: c.x,
            y: c.y,
            width: def.width,
            height: def.height,
          });
        })
        .map((c) => c.id);
      const wireHits = wiresInMarquee(wires, components, rect);
      if (additive) {
        const compSet = new Set([...selectedIds, ...compHits]);
        const wireSet = new Set([...selectedWireIds, ...wireHits]);
        select([...compSet], [...wireSet]);
      } else {
        select(compHits, wireHits);
      }
    },
    [components, wires, select, selectedIds, selectedWireIds],
  );

  const endInteraction = useCallback(() => {
    const interaction = interactionRef.current;
    interactionRef.current = null;
    setMarquee(null);
    setPanningVisual(false);
    setCanvasInteracting(false);
    setWireResizeCrosshair(null);

    if (
      interaction?.kind === 'pan' &&
      interaction.pendingX !== undefined &&
      interaction.pendingY !== undefined
    ) {
      setViewport({
        x: interaction.pendingX,
        y: interaction.pendingY,
        zoom: interaction.vz,
      });
    }

    if (interaction?.kind === 'marquee') {
      selectInMarquee(interaction.box, interaction.additive);
    }
  }, [selectInMarquee, setViewport, setCanvasInteracting, setPanningVisual]);

  const startWireEdit = useCallback(
    (wireId: string, world: { x: number; y: number }) => {
      const wire = wires.find((w) => w.id === wireId);
      if (!wire || !wrapRef.current) return false;
      setCanvasInteracting(true);

      const handleRadius = WIRE_HANDLE_RADIUS / viewport.zoom;
      const segmentHit = WIRE_SEGMENT_HIT / viewport.zoom;

      const handleIndex = findWireHandleAt(
        wire,
        components,
        world,
        handleRadius,
      );
      if (handleIndex >= 0) {
        const points = getWirePath(wire);
        if (!points) return false;
        select([], [wireId]);
        const vi = handleIndex + 1;
        const pt = points[vi];
        if (pt) setWireResizeCrosshair({ x: pt.x, y: pt.y });
        interactionRef.current = {
          kind: 'wire-handle',
          wireId,
          handleIndex,
          dragStartPath: points.map((p) => ({ ...p })),
        };
        wireEditPathRef.current = {
          wireId,
          path: points.map((p) => ({ ...p })),
        };
        return true;
      }

      const points = getWirePath(wire);
      if (points) {
        const segmentIndex = findWireSegmentAt(points, world, segmentHit);
        if (segmentIndex >= 0) {
          select([], [wireId]);
          const a = points[segmentIndex];
          const b = points[segmentIndex + 1];
          setWireResizeCrosshair(wireSegmentCrosshairPoint(a, b));
          interactionRef.current = {
            kind: 'wire-segment',
            wireId,
            segmentIndex,
            dragStartPath: points.map((p) => ({ ...p })),
          };
          wireEditPathRef.current = {
            wireId,
            path: points.map((p) => ({ ...p })),
          };
          return true;
        }
      }
      return false;
    },
    [wires, components, viewport.zoom, getWirePath, select, updateWireBends],
  );

  const insertJointAt = useCallback(
    (wireId: string, world: { x: number; y: number }) => {
      const now = performance.now();
      if (
        lastJointInsertRef.current?.wireId === wireId &&
        now - lastJointInsertRef.current.t < 300
      ) {
        return;
      }
      lastJointInsertRef.current = { wireId, t: now };
      lastWireTapRef.current = null;

      const wire = wires.find((w) => w.id === wireId);
      if (!wire) return;

      let workingWire = wire;
      if (wire.bends.length === 0) {
        const path = resolveWirePoints(wire, components);
        if (path && path.length > 2) {
          const materialized = pathToBends(path);
          workingWire = { ...wire, bends: materialized };
        }
      }

      const hitThreshold = Math.max(WIRE_SEGMENT_HIT / viewport.zoom, 14);
      const newBends = insertWireJoint(workingWire, components, world, hitThreshold);
      updateWireBends(wireId, newBends, true);
      select([], [wireId]);
      endInteraction();
    },
    [
      wires,
      components,
      viewport.zoom,
      updateWireBends,
      select,
      endInteraction,
    ],
  );

  const applyWheelZoom = useCallback(
    (deltaY: number, clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const factor = deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.min(3, Math.max(0.25, viewport.zoom * factor));
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const wx = (mx - viewport.x) / viewport.zoom;
      const wy = (my - viewport.y) / viewport.zoom;
      setViewport({
        zoom: newZoom,
        x: mx - wx * newZoom,
        y: my - wy * newZoom,
      });
    },
    [viewport, setViewport],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      pendingWheelRef.current = {
        deltaY: e.deltaY,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      if (wheelFrameRef.current !== null) return;
      wheelFrameRef.current = requestAnimationFrame(() => {
        wheelFrameRef.current = null;
        const pending = pendingWheelRef.current;
        pendingWheelRef.current = null;
        if (!pending) return;
        applyWheelZoom(pending.deltaY, pending.clientX, pending.clientY);
      });
    },
    [applyWheelZoom],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const closePropertiesEditor = useCallback(() => setPropertiesEditor(null), []);

  const beginPanInteraction = useCallback(
    (e: React.PointerEvent, immediate = false) => {
      if (!wrapRef.current) return;
      const active = interactionRef.current;
      if (
        active &&
        active.kind !== 'pan' &&
        (active.kind === 'single' ||
          active.kind === 'group' ||
          active.kind === 'marquee' ||
          active.kind === 'wire-handle' ||
          active.kind === 'wire-segment')
      ) {
        return;
      }
      closeContextMenu();
      // Pending hover work must not wake React after the pan starts.
      if (hoverPinRafRef.current !== null) cancelAnimationFrame(hoverPinRafRef.current);
      hoverPinRafRef.current = null;
      pendingHoverPinRef.current = null;
      setHoveredPinSnap(null);
      suppressContextMenuRef.current = false;
      interactionRef.current = {
        kind: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        vx: viewport.x,
        vy: viewport.y,
        vz: viewport.zoom,
        immediate,
      };
      wrapRef.current.setPointerCapture(e.pointerId);
      if (immediate) {
        setPanningVisual(true);
        setCanvasInteracting(true);
      }
    },
    [viewport, closeContextMenu, setCanvasInteracting, setPanningVisual],
  );

  const onPointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      if (state.netLabelPlacement) {
        if (e.button !== 0 && e.button !== 2) return;
        e.preventDefault(); e.stopPropagation();
        if (e.button === 2) { cancelPlacement(); setNetPreview(null); return; }
        const world = getWorldPoint(e.clientX, e.clientY);
        if (world) {
          const snap = findPinSnap(world, components, PIN_HIT_RADIUS);
          confirmNetLabelPlacement(snap?.position.x ?? world.x, snap?.position.y ?? world.y, snap?.pin);
          setNetPreview(null);
        }
        return;
      }
      if (e.button === 2) {
        e.preventDefault();
        beginPanInteraction(e, true);
        return;
      }

      if (!placementType) return;

      if (e.button === 0) {
        const world = getWorldPoint(e.clientX, e.clientY);
        if (!world) return;
        const snapped = resolvePlacementTopLeft(placementType, world, placementRotation);
        confirmPlacement(snapped.x, snapped.y, placementRotation);
        setPlacementPreview(null);
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [
      placementType,
      state.netLabelPlacement, components, cancelPlacement, confirmNetLabelPlacement,
      getWorldPoint,
      resolvePlacementTopLeft,
      confirmPlacement,
      placementRotation,
      beginPanInteraction,
    ],
  );

  const openPropertiesEditor = useCallback(
    (clientX: number, clientY: number, componentId: string) => {
      closeContextMenu();
      setPropertiesEditor({ componentId, x: clientX, y: clientY });
    },
    [closeContextMenu],
  );

  const runContextMenuAction = useCallback(
    (componentIds: string[], action: () => void) => {
      flushSync(() => {
        select(componentIds, selectedWireIds);
      });
      action();
    },
    [select, selectedWireIds],
  );

  const openContextMenu = useCallback(
    (clientX: number, clientY: number, componentId?: string) => {
      closePropertiesEditor();

      const world = getWorldPoint(clientX, clientY);
      if (!world) return false;

      let hitId = componentId ?? findComponentAt(world.x, world.y)?.id ?? null;

      if (hitId) {
        const compIds = selectedSet.has(hitId) ? selectedIds : [hitId];
        select(compIds, selectedWireIds);
        setContextMenu({ x: clientX, y: clientY, componentIds: compIds });
        return true;
      }

      setContextMenu({
        x: clientX,
        y: clientY,
        componentIds: selectedIds,
        pasteAtWorld: world,
      });
      return true;
    },
    [
      getWorldPoint,
      findComponentAt,
      selectedSet,
      selectedIds,
      selectedWireIds,
      select,
      closePropertiesEditor,
    ],
  );

  const tryOpenContextMenu = useCallback(
    (clientX: number, clientY: number, componentId?: string, pinId?: string) => {
      if (state.netLabelPlacement) { cancelPlacement(); setNetPreview(null); return; }
      if (suppressContextMenuRef.current) return;
      if (placementType) {
        cancelPlacement();
        setPlacementPreview(null);
        return;
      }
      if (wireDraft) {
        cancelWire();
        setWireCursor(null);
        setWireCursorPin(null);
        return;
      }
      openContextMenu(clientX, clientY, componentId);
      const comp = components.find(c => c.id === componentId);
      const targetPin = pinId ?? (comp?.type === 'wire_junction' ? getDefinition(comp.type).pins[0]?.id : undefined);
      if (componentId && targetPin) setContextMenu(menu => menu && ({ ...menu, netPin: { componentId, pinId: targetPin } }));
    },
    [state.netLabelPlacement, openContextMenu, placementType, wireDraft, cancelWire, cancelPlacement, components],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      tryOpenContextMenu(e.clientX, e.clientY);
    },
    [tryOpenContextMenu],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!wrapRef.current || !svgRef.current) return;

      // Canvas clicks must take keyboard focus so Delete/Backspace hit selection, not the IDE.
      blurEditableFocus();

      if (contextMenu && e.button === 0) {
        closeContextMenu();
      }
      if (propertiesEditor && e.button === 0) {
        closePropertiesEditor();
      }

      if (e.button === 2) return;

      const world = getWorldPoint(e.clientX, e.clientY);
      if (!world) return;

      // Middle mouse: pan immediately
      if (e.button === 1) {
        e.preventDefault();
        closePropertiesEditor();
        beginPanInteraction(e, true);
        return;
      }

      if (e.button !== 0) return;

      // Space + left drag: pan
      if (spaceDownRef.current) {
        e.preventDefault();
        closePropertiesEditor();
        beginPanInteraction(e, true);
        return;
      }

      if (wireDraft) {
        const pin = resolvePinClick(world);
        if (pin) {
          pinClick(pin);
          syncWireCursor(world);
          return;
        }

        e.preventDefault();
        const bendClick = wireDraftRubberBandCursor(
          world,
          wireDraft.from,
          wireDraft.bends,
          components,
        );
        const routeAnchor = wireDraftRouteAnchor(
          wireDraft.from,
          wireDraft.bends,
          components,
        );
        if (routeAnchor) {
          const bend = commitWireBend(
            routeAnchor.anchor,
            bendClick,
            routeAnchor.segmentIndex,
          );
          addWireBend(bend.x, bend.y);
        }
        return;
      }

      const top = findComponentAt(world.x, world.y);
      if (top && top.type !== 'breadboard') {
        // Body hits are handled on the component-hit rect (supports double-click).
        return;
      }

      const pin = resolvePinClick(world);
      if (pin) {
        pinClick(pin);
        syncWireCursor(world);
        return;
      }

      e.preventDefault();

      const wireId = findWireAt(world.x, world.y);
      if (wireId) {
        if (e.shiftKey) {
          const wireSet = new Set(selectedWireIds);
          if (wireSet.has(wireId)) wireSet.delete(wireId);
          else wireSet.add(wireId);
          select(selectedIds, [...wireSet]);
        } else {
          select([], [wireId]);
        }
        return;
      }

      if (top) {
        beginComponentDrag(top, world, e.pointerId);
        return;
      }

      // Empty canvas: marquee select
      const box: Marquee = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
      interactionRef.current = { kind: 'marquee', box, additive: e.shiftKey };
      setMarquee(box);
      setCanvasInteracting(true);
      wrapRef.current.setPointerCapture(e.pointerId);
    },
    [
      contextMenu,
      propertiesEditor,
      closePropertiesEditor,
      wireDraft,
      getWorldPoint,
      resolvePinClick,
      syncWireCursor,
      findWireAt,
      findComponentAt,
      pinClick,
      addWireBend,
      select,
      selectedIds,
      selectedWireIds,
      beginPanInteraction,
    ],
  );

  const isPropertiesDoubleTap = useCallback(
    (componentId: string, clientX: number, clientY: number) => {
      const now = performance.now();
      const prev = lastPropertiesTapRef.current;
      lastPropertiesTapRef.current = { componentId, t: now, x: clientX, y: clientY };
      if (
        prev &&
        prev.componentId === componentId &&
        now - prev.t < PROPERTIES_DOUBLE_CLICK_MS &&
        Math.hypot(clientX - prev.x, clientY - prev.y) < PROPERTIES_DOUBLE_CLICK_PX
      ) {
        lastPropertiesTapRef.current = null;
        return true;
      }
      return false;
    },
    [],
  );

  const openPropertiesEditorFor = useCallback(
    (clientX: number, clientY: number, componentId: string) => {
      endInteraction();
      select([componentId], []);
      openPropertiesEditor(clientX, clientY, componentId);
    },
    [endInteraction, openPropertiesEditor, select],
  );

  const handleComponentWheel = useCallback(
    (e: React.WheelEvent, comp: PlacedComponent) => {
      if (simStatus !== 'running' || comp.type !== 'potentiometer') return;
      e.preventDefault();
      e.stopPropagation();
      const current = simFlags?.potPositions[comp.id] ?? 0.5;
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      setPotPosition(comp.id, current + delta);
    },
    [simStatus, simFlags, setPotPosition],
  );

  const handleComponentBodyPointerDown = useCallback(
    (e: React.PointerEvent, comp: PlacedComponent) => {
      if (e.button !== 0) return;
      blurEditableFocus();
      e.stopPropagation();
      e.preventDefault();

      const world = getWorldPoint(e.clientX, e.clientY);
      if (!world) return;

      if (wireDraft) return;

      if (comp.type === 'button' && simStatus === 'running') {
        setButtonPressed(comp.id, true);
        const release = () => {
          setButtonPressed(comp.id, false);
          window.removeEventListener('pointerup', release);
          window.removeEventListener('pointercancel', release);
        };
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
        return;
      }

      if (
        componentHasEditableProperties(comp.type) &&
        (e.detail === 2 ||
          isPropertiesDoubleTap(comp.id, e.clientX, e.clientY))
      ) {
        openPropertiesEditorFor(e.clientX, e.clientY, comp.id);
        return;
      }

      const ownPin = findPinOnComponent(comp, world.x, world.y);
      if (ownPin) {
        const target = resolvePinClick(world, ownPin);
        if (target) {
          pinClick(target);
          syncWireCursor(world);
        }
        return;
      }

      beginComponentDrag(comp, world, e.pointerId);
    },
    [
      getWorldPoint,
      wireDraft,
      isPropertiesDoubleTap,
      openPropertiesEditorFor,
      findPinOnComponent,
      resolvePinClick,
      syncWireCursor,
      pinClick,
      beginComponentDrag,
      simStatus,
      setButtonPressed,
    ],
  );

  const handleComponentBodyDoubleClick = useCallback(
    (e: React.MouseEvent, comp: PlacedComponent) => {
      if (!componentHasEditableProperties(comp.type)) return;
      e.preventDefault();
      e.stopPropagation();
      openPropertiesEditorFor(e.clientX, e.clientY, comp.id);
    },
    [openPropertiesEditorFor],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const interaction = interactionRef.current;
      if (interaction?.kind === 'pan') {
        const dx = e.clientX - interaction.startX;
        const dy = e.clientY - interaction.startY;
        if (
          interaction.immediate ||
          Math.hypot(dx, dy) >= RIGHT_PAN_THRESHOLD
        ) {
          suppressContextMenuRef.current = true;
          setPanningVisual(true);
        }
        if (interaction.immediate || suppressContextMenuRef.current) {
          setCanvasInteracting(true);
          const nx = interaction.vx + dx;
          const ny = interaction.vy + dy;
          interactionRef.current = {
            ...interaction,
            pendingX: nx,
            pendingY: ny,
          };
          worldGroupRef.current?.setAttribute(
            'transform',
            `translate(${nx}, ${ny}) scale(${interaction.vz})`,
          );
        }
        return;
      }

      const world = getWorldPoint(e.clientX, e.clientY);
      if (!world) return;

      if (wireDraft) {
        syncWireCursor(world);
      }

      scheduleHoveredPinUpdate(world);
      if (state.netLabelPlacement) setNetPreview(world);

      if (placementType) {
        setPlacementPreview(
          resolvePlacementTopLeft(placementType, world, placementRotation),
        );
      }

      if (!interaction) return;

      if (interaction.kind === 'marquee') {
        const box: Marquee = {
          x1: interaction.box.x1,
          y1: interaction.box.y1,
          x2: world.x,
          y2: world.y,
        };
        interactionRef.current = { kind: 'marquee', box, additive: interaction.additive };
        setMarquee(box);
        return;
      }

      if (interaction.kind === 'group') {
        const dx = world.x - interaction.startWorld.x;
        const dy = world.y - interaction.startWorld.y;
        const leadOrigin = interaction.origins[interaction.leadId];
        const lead = components.find((c) => c.id === interaction.leadId);
        if (!leadOrigin || !lead) return;

        const rawLead = {
          x: leadOrigin.x + dx,
          y: leadOrigin.y + dy,
        };
        const movingIds = new Set(Object.keys(interaction.origins));
        const snappedLead = snapComponentPlacement(
          lead.type,
          rawLead,
          lead.rotation,
          components.filter((c) => !movingIds.has(c.id)),
        );
        const snapDx = snappedLead.x - rawLead.x;
        const snapDy = snappedLead.y - rawLead.y;

        for (const [id, origin] of Object.entries(interaction.origins)) {
          moveComponent(
            id,
            origin.x + dx + snapDx,
            origin.y + dy + snapDy,
          );
        }
        return;
      }

      if (interaction.kind === 'single') {
        const comp = components.find((c) => c.id === interaction.componentId);
        if (!comp) return;

        const rawTopLeft = {
          x: world.x - interaction.offsetX,
          y: world.y - interaction.offsetY,
        };
        const snapped = snapComponentPlacement(
          comp.type,
          rawTopLeft,
          comp.rotation,
          components.filter((c) => c.id !== comp.id),
        );
        moveComponent(interaction.componentId, snapped.x, snapped.y);
        return;
      }

      if (interaction.kind === 'wire-pending') {
        const dx = e.clientX - interaction.startX;
        const dy = e.clientY - interaction.startY;
        if (Math.hypot(dx, dy) >= WIRE_DRAG_THRESHOLD) {
          const origin = getWorldPoint(interaction.startX, interaction.startY);
          if (origin && startWireEdit(interaction.wireId, origin)) {
            const seg = interactionRef.current;
            if (seg?.kind === 'wire-segment') {
              const wire = wires.find((w) => w.id === seg.wireId);
              if (wire) {
                const preview = previewWireSegmentDrag(
                  wire,
                  components,
                  seg.segmentIndex,
                  world,
                  wires,
                  seg.dragStartPath,
                );
                if (preview) {
                  wireEditPathRef.current = {
                    wireId: wire.id,
                    path: preview.path.map((p) => ({ ...p })),
                  };
                  const a = preview.path[seg.segmentIndex];
                  const b = preview.path[seg.segmentIndex + 1];
                  if (a && b) {
                    setWireResizeCrosshair(wireSegmentCrosshairPoint(a, b));
                  }
                  setWireEditTick((t) => t + 1);
                }
              }
            }
          }
        }
        return;
      }

      if (interaction.kind === 'wire-handle') {
        const wire = wires.find((w) => w.id === interaction.wireId);
        if (wire) {
          const preview = previewWireHandleMove(
            wire,
            components,
            interaction.handleIndex,
            world,
            wires,
            interaction.dragStartPath,
          );
          if (preview) {
            wireEditPathRef.current = {
              wireId: wire.id,
              path: preview.path.map((p) => ({ ...p })),
            };
            const vi = interaction.handleIndex + 1;
            const pt = preview.path[vi];
            if (pt) setWireResizeCrosshair({ x: pt.x, y: pt.y });
            setWireEditTick((t) => t + 1);
          }
        }
        return;
      }

      if (interaction.kind === 'wire-segment') {
        const wire = wires.find((w) => w.id === interaction.wireId);
        if (wire) {
          const preview = previewWireSegmentDrag(
            wire,
            components,
            interaction.segmentIndex,
            world,
            wires,
            interaction.dragStartPath,
          );
          if (preview) {
            wireEditPathRef.current = {
              wireId: wire.id,
              path: preview.path.map((p) => ({ ...p })),
            };
            const a = preview.path[interaction.segmentIndex];
            const b = preview.path[interaction.segmentIndex + 1];
            if (a && b) {
              setWireResizeCrosshair(wireSegmentCrosshairPoint(a, b));
            }
            setWireEditTick((t) => t + 1);
          }
        }
      }
    },
    [
      state.netLabelPlacement,
      viewport,
      wireDraft,
      placementType,
      placementRotation,
      wires,
      components,
      getWorldPoint,
      resolvePlacementTopLeft,
      setViewport,
      moveComponent,
      startWireEdit,
      scheduleHoveredPinUpdate,
      syncWireCursor,
    ],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const interaction = interactionRef.current;

      if (
        interaction?.kind === 'wire-handle' ||
        interaction?.kind === 'wire-segment'
      ) {
        const pendingPath = wireEditPathRef.current;
        const wire = wires.find((w) => w.id === interaction.wireId);
        if (wire && pendingPath?.wireId === wire.id) {
          const committed = commitWireBendsFromPath(
            wire,
            pendingPath.path,
            components,
            wires,
          );
          updateWireBends(wire.id, committed, true);
        } else if (wire) {
          updateWireBends(wire.id, commitWireBends(wire, components, wires), true);
        }
        wireEditPathRef.current = null;
        setWireResizeCrosshair(null);
        setWireEditTick((t) => t + 1);
      }

      if (interaction?.kind === 'single') {
        const comp = components.find((c) => c.id === interaction.componentId);
        if (comp) {
          const snapped = snapComponentPlacement(
            comp.type,
            { x: comp.x, y: comp.y },
            comp.rotation,
            components.filter((c) => c.id !== comp.id),
          );
          if (snapped.x !== comp.x || snapped.y !== comp.y) {
            moveComponent(comp.id, snapped.x, snapped.y);
          }
        }
      }

      if (interaction?.kind === 'group') {
        const lead = components.find((c) => c.id === interaction.leadId);
        if (lead) {
          const movingIds = new Set(Object.keys(interaction.origins));
          const snappedLead = snapComponentPlacement(
            lead.type,
            { x: lead.x, y: lead.y },
            lead.rotation,
            components.filter((c) => !movingIds.has(c.id)),
          );
          const snapDx = snappedLead.x - lead.x;
          const snapDy = snappedLead.y - lead.y;
          if (snapDx !== 0 || snapDy !== 0) {
            for (const id of movingIds) {
              const c = components.find((x) => x.id === id);
              if (c) moveComponent(id, c.x + snapDx, c.y + snapDy);
            }
          }
        }
      }

      if (wrapRef.current?.hasPointerCapture(e.pointerId)) {
        wrapRef.current.releasePointerCapture(e.pointerId);
      }
      endInteraction();
    },
    [wires, components, updateWireBends, moveComponent, endInteraction],
  );

  useEffect(() => {
    if (isPanningRef.current) return;
    worldGroupRef.current?.setAttribute(
      'transform',
      `translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`,
    );
  }, [viewport]);

  useEffect(
    () => () => {
      if (hoverPinRafRef.current !== null) {
        cancelAnimationFrame(hoverPinRafRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const isEditableTarget = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = (el.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      return !!el.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isEditableTarget()) return;
      e.preventDefault();
      spaceDownRef.current = true;
      setSpacePan(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceDownRef.current = false;
      setSpacePan(false);
    };
    const onBlur = () => {
      spaceDownRef.current = false;
      setSpacePan(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    const isEditableTarget = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = (el.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      return !!el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      const editable = isEditableTarget();
      if (editable) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copySelection();
        return;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteSelection();
        return;
      }

      if (
        e.key.toLowerCase() === 'r' &&
        !mod &&
        state.placementType
      ) {
        e.preventDefault();
        rotatePlacement(e.shiftKey ? -90 : 90);
        return;
      }

      if (
        e.key.toLowerCase() === 'r' &&
        !mod &&
        state.selectedIds.length > 0 &&
        state.selectedWireIds.length === 0
      ) {
        e.preventDefault();
        rotateSelected(e.shiftKey ? -90 : 90);
        return;
      }

      if (e.key === 'Escape') {
        cancelWire();
        cancelPlacement();
        setPlacementPreview(null);
        setContextMenu(null);
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelWire, cancelPlacement, deleteSelected, undo, redo, rotateSelected, rotatePlacement, copySelection, pasteSelection, state.selectedIds.length, state.selectedWireIds.length, state.placementType]);

  const isWireDoubleTap = useCallback(
    (wireId: string, clientX: number, clientY: number) => {
      const now = performance.now();
      const prev = lastWireTapRef.current;
      lastWireTapRef.current = { wireId, t: now, x: clientX, y: clientY };
      if (
        prev &&
        prev.wireId === wireId &&
        now - prev.t < WIRE_DOUBLE_CLICK_MS &&
        Math.hypot(clientX - prev.x, clientY - prev.y) < WIRE_DOUBLE_CLICK_PX
      ) {
        lastWireTapRef.current = null;
        return true;
      }
      return false;
    },
    [],
  );

  const handleWirePointerDown = useCallback(
    (e: React.PointerEvent, wireId: string) => {
      if (e.button !== 0) return;
      blurEditableFocus();
      e.stopPropagation();
      e.preventDefault();

      const world = getWorldPoint(e.clientX, e.clientY);
      if (!world) return;

      if (wireDraft) {
        completeWireOnWire(wireId, world);
        setWireCursor(null);
        setWireCursorPin(null);
        return;
      }

      if (e.detail === 2 || isWireDoubleTap(wireId, e.clientX, e.clientY)) {
        insertJointAt(wireId, world);
        return;
      }

      if (e.shiftKey) {
        const wireSet = new Set(selectedWireIds);
        if (wireSet.has(wireId)) wireSet.delete(wireId);
        else wireSet.add(wireId);
        select(selectedIds, [...wireSet]);
      } else {
        select([], [wireId]);
      }
      interactionRef.current = {
        kind: 'wire-pending',
        wireId,
        startX: e.clientX,
        startY: e.clientY,
      };
      wrapRef.current?.setPointerCapture(e.pointerId);
    },
    [
      getWorldPoint,
      insertJointAt,
      isWireDoubleTap,
      select,
      selectedIds,
      selectedWireIds,
      wireDraft,
      completeWireOnWire,
    ],
  );

  const handleWireDoubleClick = useCallback(
    (e: React.MouseEvent, wireId: string) => {
      e.stopPropagation();
      e.preventDefault();
      const world = getWorldPoint(e.clientX, e.clientY);
      if (world) insertJointAt(wireId, world);
    },
    [getWorldPoint, insertJointAt],
  );

  const handleWireHandlePointerDown = useCallback(
    (e: React.PointerEvent, wireId: string, handleIndex: number) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const wire = wires.find((w) => w.id === wireId);
      if (!wire) return;
      select([], [wireId]);
      const dragStartPath = resolveWirePoints(wire, components);
      if (!dragStartPath) return;
      const vi = handleIndex + 1;
      const pt = dragStartPath[vi];
      if (pt) setWireResizeCrosshair({ x: pt.x, y: pt.y });
      interactionRef.current = {
        kind: 'wire-handle',
        wireId,
        handleIndex,
        dragStartPath: dragStartPath.map((p) => ({ ...p })),
      };
      wireEditPathRef.current = {
        wireId,
        path: dragStartPath.map((p) => ({ ...p })),
      };
      wrapRef.current?.setPointerCapture(e.pointerId);
    },
    [wires, components, select, updateWireBends],
  );

  const handlePinPointerDown = useCallback(
    (e: React.PointerEvent, pin: PinRef) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const world = getWorldPoint(e.clientX, e.clientY);
      if (!world) return;

      const owner = components.find((c) => c.id === pin.componentId);
      if (!owner) return;

      if (wireDraft) {
        e.stopPropagation();
        const target = resolvePinClick(world, pin);
        if (target) pinClick(target);
        syncWireCursor(world);
        return;
      }

      if (owner.type !== 'breadboard') {
        e.stopPropagation();
        const target = resolvePinClick(world, pin);
        if (target) pinClick(target);
        syncWireCursor(world);
        return;
      }

      const top = findComponentAt(world.x, world.y);
      if (top && top.type !== 'breadboard') {
        e.stopPropagation();
        if (selectedSet.has(top.id)) {
          const ownPin = findPinOnComponent(top, world.x, world.y);
          if (ownPin) {
            const target = resolvePinClick(world, ownPin);
            if (target) {
              pinClick(target);
              syncWireCursor(world);
            }
            return;
          }
        }
        beginComponentDrag(top, world, e.pointerId);
        return;
      }

      e.stopPropagation();
      const target = resolvePinClick(world, pin);
      if (target) pinClick(target);
      syncWireCursor(world);
    },
    [
      components,
      wireDraft,
      selectedSet,
      getWorldPoint,
      findComponentAt,
      findPinOnComponent,
      resolvePinClick,
      pinClick,
      syncWireCursor,
      beginComponentDrag,
      endInteraction,
    ],
  );

  const handleBreadboardHolePointerDown = useCallback(
    (e: React.PointerEvent, pin: PinRef) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const world = getWorldPoint(e.clientX, e.clientY);
      if (!world) return;

      const top = findComponentAt(world.x, world.y);
      if (top && top.type !== 'breadboard') {
        e.stopPropagation();
        handleComponentBodyPointerDown(e, top);
        return;
      }

      handlePinPointerDown(e, pin);
    },
    [getWorldPoint, findComponentAt, handleComponentBodyPointerDown, handlePinPointerDown],
  );

  const handleBreadboardHoleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const world = getWorldPoint(e.clientX, e.clientY);
      if (!world) return;
      const top = findComponentAt(world.x, world.y);
      if (top && top.type !== 'breadboard') {
        handleComponentBodyDoubleClick(e, top);
      }
    },
    [getWorldPoint, findComponentAt, handleComponentBodyDoubleClick],
  );

  const renderPlacedComponent = (comp: PlacedComponent) => {
    const selected = selectedSet.has(comp.id);
    const bodyHit = getComponentBodyHitbox(comp.type);

    return (
      <g
        key={comp.id}
        transform={componentTransform(comp)}
        className={`placed-component ${selected ? 'is-selected' : ''}`}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          tryOpenContextMenu(e.clientX, e.clientY, comp.id);
        }}
      >
        {selected && (
          <rect
            x={bodyHit.x}
            y={bodyHit.y}
            width={bodyHit.width}
            height={bodyHit.height}
            className="component-selection-outline"
          />
        )}
        <ComponentShape
          component={comp}
          selected={selected}
          simFlags={simFlags}
          simRunning={simStatus === 'running'}
        />
      </g>
    );
  };

  const renderComponentBodyHit = (comp: PlacedComponent) => {
    const bodyHit = getComponentBodyHitbox(comp.type);

    return (
      <g
        key={`hit-${comp.id}`}
        transform={componentTransform(comp)}
        className="placed-component-hit"
      >
        <rect
          x={bodyHit.x}
          y={bodyHit.y}
          width={bodyHit.width}
          height={bodyHit.height}
          className="component-hit"
          data-measure-component={comp.id}
          data-sim-button={comp.type === 'button' && simStatus === 'running' && !wireDraft ? 'true' : undefined}
          fill="rgba(0,0,0,0.001)"
          onPointerDown={(e) => handleComponentBodyPointerDown(e, comp)}
          onDoubleClick={(e) => handleComponentBodyDoubleClick(e, comp)}
          onWheel={(e) => handleComponentWheel(e, comp)}
        />
      </g>
    );
  };

  const componentTransform = (comp: PlacedComponent) => {
    const def = getDefinition(comp.type);
    return `translate(${comp.x}, ${comp.y}) rotate(${comp.rotation} ${def.width / 2} ${def.height / 2})`;
  };

  const renderPins = (comp: PlacedComponent) => {
    if (comp.type === 'wire_junction') return null;
    const def = getDefinition(comp.type);
    const isBreadboard = comp.type === 'breadboard';

    return def.pins.map((pin) => {
      const isDraft =
        wireDraft?.from.componentId === comp.id &&
        wireDraft.from.pinId === pin.id;
      const simLevel =
        simStatus === 'running'
          ? pinStateForComponent(comp.id, pin.id, comp.pinStates[pin.id])
          : undefined;
      const pinTypeClass = `pin pin-${pin.type}${isDraft ? ' pin-draft' : ''}${
        simLevel === 'high' ? ' pin-sim-high' : simLevel === 'low' ? ' pin-sim-low' : ''
      }`;

      if (isBreadboard) {
        const isSnapHovered =
          hoveredPinSnap?.pin.componentId === comp.id &&
          hoveredPinSnap?.pin.pinId === pin.id;
        return (
          <g
            key={pin.id}
            transform={`translate(${pin.x}, ${pin.y})`}
            data-measure-component={comp.id}
            data-measure-pin={pin.id}
            className={`breadboard-hole-hit${isSnapHovered ? ' is-snap-hovered' : ''}`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              tryOpenContextMenu(e.clientX, e.clientY, comp.id, pin.id);
            }}
            onPointerDown={(e) =>
              handleBreadboardHolePointerDown(e, {
                componentId: comp.id,
                pinId: pin.id,
              })
            }
            onDoubleClick={handleBreadboardHoleDoubleClick}
          >
            <circle r={BREADBOARD_HOLE_HIT_RADIUS} className="breadboard-hole-target" />
          </g>
        );
      }

      const isSnapHovered =
        hoveredPinSnap?.pin.componentId === comp.id &&
        hoveredPinSnap?.pin.pinId === pin.id;

      return (
        <g
          key={pin.id}
          transform={`translate(${pin.x}, ${pin.y})`}
          data-measure-component={comp.id}
          data-measure-pin={pin.id}
          className={`pin-interactive${isSnapHovered ? ' is-snap-hovered' : ''}`}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            tryOpenContextMenu(e.clientX, e.clientY, comp.id, pin.id);
          }}
          onPointerDown={(e) =>
            handlePinPointerDown(e, { componentId: comp.id, pinId: pin.id })
          }
        >
          <circle r={PIN_HIT_RADIUS} className="pin-hit-area" />
          <circle r={PIN_DOT_RADIUS} className={pinTypeClass} />
          {pin.description ? <PinLabel label={pin.description} /> : null}
        </g>
      );
    });
  };

  const renderWireResizeCrosshair = () => {
    if (!wireResizeCrosshair) return null;
    const { x, y } = wireResizeCrosshair;
    const span = WIRE_RESIZE_CROSSHAIR_SPAN;
    return (
      <g className="wire-resize-crosshair" pointerEvents="none" aria-hidden="true">
        <line
          x1={x - span}
          y1={y}
          x2={x + span}
          y2={y}
          className="wire-resize-crosshair-line"
        />
        <line
          x1={x}
          y1={y - span}
          x2={x}
          y2={y + span}
          className="wire-resize-crosshair-line"
        />
      </g>
    );
  };

  const renderPinSnapCrosshair = () => {
    if (!hoveredPinSnap) return null;
    const { x, y } = hoveredPinSnap.position;
    const arm = PIN_CROSSHAIR_ARM;
    return (
      <g className="pin-snap-crosshair" pointerEvents="none" aria-hidden="true">
        <line
          x1={x - arm}
          y1={y}
          x2={x + arm}
          y2={y}
          className="pin-snap-crosshair-line"
        />
        <line
          x1={x}
          y1={y - arm}
          x2={x}
          y2={y + arm}
          className="pin-snap-crosshair-line"
        />
      </g>
    );
  };

  const renderWire = (wire: Wire, mode: 'visual' | 'hit' | 'overlay') => {
    const liveEdit = wireEditPathRef.current;
    const points =
      liveEdit?.wireId === wire.id ? liveEdit.path : getWirePath(wire);
    if (!points) return null;
    const d =
      mode === 'hit'
        ? polylinePath(points)
        : roundedPolylinePath(points);
    const isSelected = selectedWireSet.has(wire.id);
    const currentMa =
      simStatus === 'running' && simFlags
        ? simFlags.wireCurrentMa[wire.id]
        : undefined;
    const hasCurrent = wireShowsCurrent(currentMa);
    const color = pinWireColors.get(`${wire.from.componentId}:${wire.from.pinId}`);
    return (
      <g
        key={mode === 'hit' ? `${wire.id}-hit` : `${wire.id}-${mode}`}
        className={[
          'wire-group',
          isSelected ? 'is-selected' : '',
          mode === 'visual' && hasCurrent ? 'has-current' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {mode === 'visual' && (
          <>
            {color === '#000000' && <path d={d} fill="none" pointerEvents="none"
              stroke="#b0bec5" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />}
            <path d={d} className="wire" style={{ stroke: color }} fill="none" pointerEvents="none" />
          </>
        )}
        {mode === 'hit' && (
          <path
            d={d}
            className="wire-hit"
            data-measure-wire={wire.id}
            fill="none"
            onPointerDown={(e) => handleWirePointerDown(e, wire.id)}
            onDoubleClick={(e) => handleWireDoubleClick(e, wire.id)}
          />
        )}
        {mode === 'overlay' && (
          <path d={d} className="wire wire-overlay" fill="none" pointerEvents="none" />
        )}
      </g>
    );
  };

  const renderWireJunctions = () => {
    return wireJunctions.map((p, i) => (
      <circle key={`joint-${i}`} cx={p.x} cy={p.y} r={4} className="wire-joint" />
    ));
  };

  const renderWireHandles = () => {
    if (selectedWireIds.length === 0) return null;
    return selectedWireIds.flatMap((wireId) => {
      const wire = wires.find((w) => w.id === wireId);
      if (!wire) return [];
      const liveEdit = wireEditPathRef.current;
      const verts =
        liveEdit?.wireId === wireId
          ? pathToBends(liveEdit.path)
          : getWireInternalVertices(wire, components);
      return verts.map((v, i) => (
        <circle
          key={`${wireId}-h-${i}`}
          cx={v.x}
          cy={v.y}
          r={8 / viewport.zoom}
          className="wire-handle"
          onPointerDown={(e) => handleWireHandlePointerDown(e, wireId, i)}
        />
      ));
    });
  };

  const wireDraftLine = () => {
    if (!wireDraft || !wireCursor) return null;
    const points = resolveWireDraftPoints(
      wireDraft,
      wireCursor,
      components,
      wireCursorPin,
    );
    if (!points || points.length < 2) return null;
    const color = [wireDraft.from, wireCursorPin].some(pin => pin && pinWireColors.get(`${pin.componentId}:${pin.pinId}`) === '#000000')
      ? '#000000' : [wireDraft.from, wireCursorPin].some(pin => pin && pinWireColors.get(`${pin.componentId}:${pin.pinId}`) === '#ff0000') ? '#ff0000' : undefined;
    return (
      <>
      {color === '#000000' && <path d={roundedPolylinePath(points)} className="wire wire-draft"
        style={{ stroke: '#b0bec5', strokeWidth: 5 }} fill="none" pointerEvents="none" />}
      <path
        d={roundedPolylinePath(points)}
        className="wire wire-draft"
        style={{ stroke: color }}
        fill="none"
      />
      </>
    );
  };

  const wireDraftBends = () => {
    if (!wireDraft) return null;
    return wireDraft.bends.map((b, i) => (
      <circle key={i} cx={b.x} cy={b.y} r={4} className="wire-bend" />
    ));
  };

  const hologramComponent = (): PlacedComponent | null => {
    if (!placementType || !placementPreview) return null;
    return {
      id: '__hologram__',
      type: placementType,
      x: placementPreview.x,
      y: placementPreview.y,
      rotation: placementRotation,
      pinStates: {},
    };
  };

  const placementDef = placementType ? getDefinition(placementType) : null;

  const marqueeRect = marquee
    ? rectFromPoints(marquee.x1, marquee.y1, marquee.x2, marquee.y2)
    : null;

  const ghost = hologramComponent();
  const placementPivot = placementDef
    ? componentPlacementPivot(placementType!, placementDef)
    : null;
  const propertiesEditorTarget = propertiesEditor
    ? components.find((c) => c.id === propertiesEditor.componentId)
    : null;
  const partProperties = propertiesEditorTarget ? getPartModule(propertiesEditorTarget.type)?.properties : undefined;
  const placementLabel = placementType
    ? getDefinition(placementType).label
    : null;
  const canContextCopy =
    (contextMenu?.componentIds.length ?? 0) > 0 || selectedWireIds.length > 0;
  const canContextDelete = canContextCopy;

  const canvas = (
    <div
      ref={wrapRef}
      className={`canvas-wrap${isPanning ? ' is-panning' : ''}${
        spacePan ? ' is-space-pan' : ''
      }${
        marquee ? ' is-marquee' : ''
      }${placementType ? ' is-placing' : ''}${wireDraft ? ' is-wiring' : ''}${
        selectedWireIds.length > 0 ? ' is-wire-selected' : ''
      }${hoveredPinSnap ? ' is-pin-snap' : ''}${
        simStatus === 'running' ? ' is-sim-running' : ''
      }${wireResizeCrosshair ? ' is-wire-resizing' : ''}`}
      onContextMenu={onContextMenu}
      onPointerDownCapture={onPointerDownCapture}
      onPointerDown={onPointerDown}
      onDoubleClick={e => {
        if (!wireDraft) return;
        e.preventDefault();
        const endpoint = wireDraft.bends.at(-1);
        if (!endpoint) return;
        completeWireOnWire(null, endpoint);
        setWireCursor(null);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => scheduleHoveredPinUpdate(null)}
    >
      {simStatus === 'running' && !wireDraft && !placementType && !spacePan && !contextMenu && !propertiesEditor && (
        <MeasurementTooltip container={wrapRef} components={components} wires={wires} />
      )}
      {ngspiceDebug && (
        <NgspiceDebugOverlay components={components} debug={ngspiceDebug} />
      )}
      {simPerfOverlay && <SimPerfOverlay perf={simPerfOverlay} />}
      <svg
        ref={svgRef}
        className="sim-canvas"
        onWheel={handleWheel}
      >
        <defs>
          <pattern
            id="grid"
            width={GRID_SIZE}
            height={GRID_SIZE}
            patternUnits="userSpaceOnUse"
          >
            <path d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`} fill="none" className="grid-line" />
          </pattern>
        </defs>

        <rect width="100%" height="100%" className="canvas-bg" />

        <g ref={worldGroupRef} className="canvas-world">
          <rect
            x={-2000}
            y={-2000}
            width={4000}
            height={4000}
            fill="url(#grid)"
            className="canvas-grid"
          />

          {breadboardComponents.map(renderPlacedComponent)}
          {partComponents.map(renderPlacedComponent)}

          {partComponents.map(renderComponentBodyHit)}

          {wires.map((wire) => renderWire(wire, 'visual'))}
          {simStatus === 'running' && simFlags && (
            <WireFlowOverlay
              wires={wires}
              simFlags={simFlags}
              getWirePath={getWirePath}
              liveEditPath={wireEditPathRef.current?.path}
            />
          )}
          {renderWireJunctions()}

          {wireDraftLine()}
          {wireDraftBends()}

          {wires.map((wire) => renderWire(wire, 'hit'))}
          {simStatus === 'running' && partComponents.map(comp => (
            <g key={`gpio-warning-${comp.id}`} transform={componentTransform(comp)}>
              <GpioOvercurrentOverlay component={comp} design={getDefinition(comp.type)}
                simFlags={simFlags} simRunning />
            </g>
          ))}

          {breadboardComponents.map((comp) => (
            <g key={`pins-${comp.id}`} transform={componentTransform(comp)}>
              {renderPins(comp)}
            </g>
          ))}

          {partComponents.map((comp) => (
            <g key={`pins-${comp.id}`} transform={componentTransform(comp)}>
              {renderPins(comp)}
            </g>
          ))}

          {renderPinSnapCrosshair()}
          {renderWireResizeCrosshair()}

          {selectedWireIds.map((wireId) => {
            const wire = wires.find((w) => w.id === wireId);
            return wire ? renderWire(wire, 'overlay') : null;
          })}
          {renderWireHandles()}
          {components.flatMap(comp => Object.entries(comp.pinNetLabels ?? {}).map(([pinId, name]) => {
            const p = getPinPosition({ componentId: comp.id, pinId }, components);
            if (!p || !name) return null;
            return <g key={comp.id + ':' + pinId} transform={`translate(${p.x}, ${p.y})`}
              data-net-label={name} style={{ cursor: 'pointer' }}
              onPointerDown={e => { if (comp.type === 'wire_junction') handleComponentBodyPointerDown(e, comp); else e.stopPropagation(); }}
              onDoubleClick={e => { e.stopPropagation(); setNetEditor({ componentId: comp.id, pinId, x: e.clientX, y: e.clientY }); }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); tryOpenContextMenu(e.clientX, e.clientY, comp.id, pinId); }}>
              <title>{name + ' — double-click to edit; matching names connect'}</title>
              <path d="M0 0 L12 -12 H22" fill="none" stroke="#70dce8" strokeWidth={1.5} />
              <rect x={20} y={-23} width={Math.max(30, name.length * 7.5 + 12)} height={20} rx={3} fill="#15252c" stroke="#70dce8" />
              <text x={26} y={-9} fill="#d9fbff" fontSize={12} fontFamily="monospace">{name}</text>
            </g>;
          }))}

          {state.netLabelPlacement && netPreview && <g pointerEvents="none" opacity={0.7}
            transform={`translate(${hoveredPinSnap?.position.x ?? netPreview.x}, ${hoveredPinSnap?.position.y ?? netPreview.y})`}>
            <circle r={8} fill="none" stroke={hoveredPinSnap ? '#77ff9d' : '#70dce8'} strokeWidth={2} />
            <path d="M0 0 L12 -12 H22" fill="none" stroke="#70dce8" />
            <rect x={20} y={-23} width={Math.max(30, state.netLabelPlacement.length * 7.5 + 12)} height={20} rx={3} fill="#15252c" stroke="#70dce8" />
            <text x={26} y={-9} fill="#d9fbff" fontSize={12} fontFamily="monospace">{state.netLabelPlacement}</text>
          </g>}
          {ghost && placementDef && placementPivot && (
            <g
              transform={`translate(${ghost.x}, ${ghost.y}) rotate(${ghost.rotation} ${placementPivot.x} ${placementPivot.y})`}
              className="component-hologram"
            >
              <ComponentShape component={ghost} selected={false} />
            </g>
          )}

          {marqueeRect && (
            <rect
              x={marqueeRect.x}
              y={marqueeRect.y}
              width={marqueeRect.width}
              height={marqueeRect.height}
              className="selection-marquee"
            />
          )}
        </g>
      </svg>

      <div className="canvas-status">
        {placementType && placementLabel && (
          <span className="canvas-status-mode">
            Place {placementLabel} · R rotate · Esc cancel
          </span>
        )}
        {wireDraft && !placementType && (
          <span className="canvas-status-mode">
            Wiring · click pin to finish · Esc / right-click cancel
          </span>
        )}
        {spacePan && !isPanning && !placementType && !wireDraft && (
          <span className="canvas-status-mode">Space — drag to pan</span>
        )}
        <span>Zoom {(viewport.zoom * 100).toFixed(0)}%</span>
        <span>{components.length} components</span>
        <span>{wires.length} wires</span>
        {selectedIds.length > 0 && (
          <span>{selectedIds.length} parts</span>
        )}
        {selectedWireIds.length > 0 && (
          <span>{selectedWireIds.length} wires</span>
        )}
      </div>

      {netEditor && <PartLabelEditor key={netEditor.componentId + ':' + netEditor.pinId} netName
        x={netEditor.x} y={netEditor.y} footprintLabel="Net"
        initialLabel={components.find(c => c.id === netEditor.componentId)?.pinNetLabels?.[netEditor.pinId] ?? ''}
        onClose={() => setNetEditor(null)} onSave={name => {
          const comp = components.find(c => c.id === netEditor.componentId);
          if (!comp) return;
          const pinNetLabels = { ...comp.pinNetLabels };
          if (name.trim()) pinNetLabels[netEditor.pinId] = name.trim();
          else delete pinNetLabels[netEditor.pinId];
          updateComponent(comp.id, { pinNetLabels });
        }} />}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          items={[
            { id: 'named-net', label: 'Name net…', disabled: !contextMenu.netPin,
              onSelect: () => { if (contextMenu.netPin) setNetEditor({ ...contextMenu.netPin, x: contextMenu.x, y: contextMenu.y }); } },
            {
              id: 'copy',
              label: 'Copy',
              shortcut: 'Ctrl+C',
              disabled: !canContextCopy,
              onSelect: () =>
                runContextMenuAction(contextMenu.componentIds, copySelection),
            },
            {
              id: 'paste',
              label: 'Paste',
              shortcut: 'Ctrl+V',
              disabled: !canPaste,
              onSelect: () => {
                if (contextMenu.pasteAtWorld) {
                  pasteSelection(contextMenu.pasteAtWorld);
                } else {
                  runContextMenuAction(contextMenu.componentIds, () =>
                    pasteSelection(),
                  );
                }
              },
            },
            {
              id: 'properties',
              label: 'Change properties',
              disabled:
                contextMenu.componentIds.length !== 1 ||
                !componentHasEditableProperties(
                  components.find((c) => c.id === contextMenu.componentIds[0])?.type,
                ),
              onSelect: () => {
                const id = contextMenu.componentIds[0];
                runContextMenuAction(contextMenu.componentIds, () => {
                  openPropertiesEditor(contextMenu.x, contextMenu.y, id);
                });
              },
            },
            {
              id: 'rotate',
              label: 'Rotate',
              shortcut: 'R',
              disabled: contextMenu.componentIds.length === 0,
              onSelect: () =>
                runContextMenuAction(contextMenu.componentIds, () => rotateSelected()),
            },
            {
              id: 'delete',
              label: 'Delete',
              shortcut: 'Del',
              danger: true,
              disabled: !canContextDelete,
              onSelect: () =>
                runContextMenuAction(contextMenu.componentIds, deleteSelected),
            },
          ]}
        />
      )}

      {propertiesEditor && propertiesEditorTarget && partProperties && (
        partProperties.Editor ? (
          <partProperties.Editor key={propertiesEditorTarget.id} component={propertiesEditorTarget}
            x={propertiesEditor.x} y={propertiesEditor.y}
            onSave={patch => updateComponent(propertiesEditorTarget.id, patch)} onClose={closePropertiesEditor} />
        ) : partProperties.fields?.length ? (
          <PartPropertiesEditor key={propertiesEditorTarget.id} component={propertiesEditorTarget}
            properties={partProperties} title={partProperties.title ?? getDefinition(propertiesEditorTarget.type).label + ' properties'}
            x={propertiesEditor.x} y={propertiesEditor.y}
            onSave={patch => updateComponent(propertiesEditorTarget.id, patch)} onClose={closePropertiesEditor} />
        ) : null
      )}

      {propertiesEditor &&
        propertiesEditorTarget &&
        !partProperties?.Editor && !partProperties?.fields?.length &&
        componentHasChipMarking(propertiesEditorTarget.type) && (
          <PartLabelEditor
            x={propertiesEditor.x}
            y={propertiesEditor.y}
            footprintLabel={getDefinition(propertiesEditorTarget.type).label}
            initialLabel={propertiesEditorTarget.partLabel ?? ''}
            onSave={(partLabel) => {
              updateComponent(propertiesEditorTarget.id, { partLabel });
            }}
            onClose={closePropertiesEditor}
          />
        )}
    </div>
  );

  recordStutter('canvas-build', performance.now() - traceBuildStart);
  return <Profiler id="canvas" onRender={recordCanvasCommit}>{canvas}</Profiler>;

}

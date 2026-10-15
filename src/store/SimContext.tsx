/**
 * What: React context + reducer for the full circuit editor and project/sketch lifecycle.
 * Role: authoritative editor state; delegates run/stop to `SimulationController`.
 * Owns/exports: `SimProvider`, `useSim()`, reducer actions (place/move/wire/select/viewport),
 * undo integration, clipboard, load/save project + sketch hooks.
 * Conventions: durable edits push `history.ts` snapshots; transient UI (selection, wire draft)
 * stays out of undo; new components get default property fields per type here; ids from counter.
 * To add an editor action: extend reducer + context method, call geometry/registry helpers,
 * push undo before mutating components/wires/viewport.
 * To set defaults for a new part type: branch in place/add handlers mirroring `paletteIcon` stub
 * and `projectFile` normalization.
 * To hook simulation: use/ref `SimulationController` from provider effects — do not write pin
 * states into reducer during run (`simLiveStore` owns live sim overlay).
 * Not-here: DC solve internals, compile pipeline details, or presentational canvas JSX.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | New components seed from the part module's `properties.defaults`
# 06-10-2026 | Cursor | COMPLETE_WIRE_ON_WIRE: split target wire + junction pin tee while drafting
# 14-10-2026 | Codex  | Release recognizable legacy automatic corners before moving/rotating connected parts.
#                     | Saving preserves session undo/redo stacks; loading a circuit still starts fresh history.
# 15-10-2026 | Codex  | Component moves carry attached terminal runs while keeping remote wire bends fixed.
#                     | Route serial output through its independent buffered store; flush on stop/error and clear before new runs without per-byte editor dispatches.
#                     | Expose serial input for the running simulation without modifying the buffered output path.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  PinRef,
  PlacedComponent,
  Viewport,
  Wire,
  WireDraft,
} from '../types';
import { appendSerialOutput, flushSerialOutput, resetSerialOutput } from './simLiveStore';
import { getDefinition } from '../registry/components';
import { getPartModule } from '../components';
import {
  bendsForCompletedWire,
  releaseAutomaticWireBends,
  findWireJunctionPinAt,
  getPinPosition,
  pathToBends,
  projectPointOntoWire,
  pruneOrphanWireJunctions,
  splitWirePathAt,
  WIRE_JUNCTION_PIN_ID,
  WIRE_JUNCTION_TYPE,
  wireJunctionTopLeft,
} from '../ui/canvas/geometry';
import {
  buildCopyPayload,
  pastePayload,
  pastePayloadAt,
  type CopyPayload,
} from '../project/clipboard';
import { snapComponentPlacement } from '../ui/canvas/geometry';
import {
  createProjectFile,
  downloadProjectFile,
  maxIdSuffix,
  parseProjectJson,
  projectFileToJson,
  type ProjectFile,
} from '../project/projectFile';
import {
  isUserProjectsApiAvailable,
  normalizeProjectFilename,
  saveUserProjectFile,
} from '../project/projectFile';
import {
  canRedo,
  canUndo,
  createUndoSnapshot,
  createUndoStacks,
  popRedo,
  popUndo,
  pushUndoSnapshot,
  resetUndoStacks,
} from './history';
import { DEFAULT_SKETCH } from '../avr/firmware';
import { getSketchTemplate } from '../ui/ide/templates';
import { parseHexFile } from '../avr/firmware';
import {
  downloadSketchFile,
  parseInoSource,
  sketchNameFromFilename,
} from '../project/sketchFile';
import {
  SimulationController,
  type SimRunStatus,
} from './simulationController';
import { resetSimLiveState } from './simLiveStore';
import {
  createComponentSimFlags,
  type ComponentSimFlags,
} from '../avr/gpioBridge';

let idCounter = 0;
function nextId(prefix: string) {
  return `${prefix}_${++idCounter}`;
}

interface SimState {
  components: PlacedComponent[];
  wires: Wire[];
  viewport: Viewport;
  selectedIds: string[];
  selectedWireIds: string[];
  wireDraft: WireDraft | null;
  placementType: string | null;
  placementRotation: number;
  simStatus: SimRunStatus;
  simErrorMessage: string;
  sketchSource: string;
  sketchName: string;
  compilerOutput: string;
  simTimeMs: number;
  pressedButtonIds: string[];
  simFlags: ComponentSimFlags;
  loadedHex: string | null;
  loadedHexName: string | null;
}

type Action =
  | { type: 'SET_VIEWPORT'; viewport: Viewport }
  | { type: 'SELECT'; componentIds: string[]; wireIds: string[] }
  | { type: 'ADD_COMPONENT'; component: PlacedComponent }
  | { type: 'CONFIRM_PLACEMENT'; x: number; y: number; rotation: number }
  | { type: 'MOVE_COMPONENT'; id: string; x: number; y: number }
  | { type: 'UPDATE_COMPONENT'; id: string; patch: Partial<PlacedComponent> }
  | { type: 'ROTATE_SELECTED'; degrees: number }
  | { type: 'DELETE_SELECTED' }
  | { type: 'START_WIRE'; pin: PinRef }
  | { type: 'ADD_WIRE_BEND'; x: number; y: number }
  | { type: 'CANCEL_WIRE' }
  | { type: 'COMPLETE_WIRE'; pin: PinRef }
  | { type: 'COMPLETE_WIRE_ON_WIRE'; wireId: string; world: { x: number; y: number } }
  | { type: 'UPDATE_WIRE_BENDS'; wireId: string; bends: { x: number; y: number }[] }
  | { type: 'START_PLACEMENT'; componentType: string }
  | { type: 'CANCEL_PLACEMENT' }
  | { type: 'ROTATE_PLACEMENT'; degrees: number }
  | {
      type: 'LOAD_PROJECT';
      components: PlacedComponent[];
      wires: Wire[];
      viewport: Viewport;
      nextIdCounter: number;
    }
  | {
      type: 'RESTORE_SNAPSHOT';
      components: PlacedComponent[];
      wires: Wire[];
      viewport: Viewport;
      idCounter: number;
    }
  | {
      type: 'PASTE';
      components: PlacedComponent[];
      wires: Wire[];
      selectedIds: string[];
      selectedWireIds: string[];
    }
  | { type: 'SET_SKETCH'; source: string }
  | { type: 'SET_SKETCH_NAME'; name: string }
  | { type: 'NEW_SKETCH' }
  | { type: 'LOAD_SKETCH'; source: string; name: string }
  | { type: 'SET_LOADED_HEX'; hex: string; filename: string }
  | { type: 'CLEAR_LOADED_HEX' }
  | { type: 'SET_SIM_STATUS'; status: SimRunStatus; message?: string }
  | { type: 'SET_COMPILER_OUTPUT'; text: string }
  | { type: 'APPEND_COMPILER_OUTPUT'; text: string }
  | { type: 'CLEAR_SERIAL' }
  | { type: 'RESET_LIVE_PIN_STATES' }
  | { type: 'SET_BUTTON_PRESSED'; componentId: string; pressed: boolean };

function createComponent(
  type: string,
  x: number,
  y: number,
  rotation = 0,
): PlacedComponent {
  const def = getDefinition(type);
  const pinStates = Object.fromEntries(
    def.pins.map((p) => [p.id, 'floating' as const]),
  );
  return {
    id: nextId(type),
    type,
    x,
    y,
    rotation,
    pinStates,
    ...(getPartModule(type)?.properties?.defaults?.() ?? {}),
    ...(def.marking === 'chip' && def.package
      ? {
          partLabel: Array.isArray(def.defaultPartLabel)
            ? def.defaultPartLabel.join('\n')
            : (def.defaultPartLabel ?? def.label),
        }
      : {}),
  };
}

function reducer(state: SimState, action: Action): SimState {
  switch (action.type) {
    case 'SET_SKETCH':
      return {
        ...state,
        sketchSource: action.source,
        loadedHex: null,
        loadedHexName: null,
      };
    case 'SET_SKETCH_NAME':
      return { ...state, sketchName: action.name };
    case 'NEW_SKETCH':
      return {
        ...state,
        sketchSource: DEFAULT_SKETCH,
        sketchName: 'sketch',
        loadedHex: null,
        loadedHexName: null,
      };
    case 'LOAD_SKETCH':
      return {
        ...state,
        sketchSource: action.source,
        sketchName: action.name,
        loadedHex: null,
        loadedHexName: null,
      };
    case 'SET_LOADED_HEX':
      return {
        ...state,
        loadedHex: action.hex,
        loadedHexName: action.filename,
      };
    case 'CLEAR_LOADED_HEX':
      return { ...state, loadedHex: null, loadedHexName: null };
    case 'SET_SIM_STATUS':
      return {
        ...state,
        simStatus: action.status,
        simErrorMessage:
          action.status === 'error'
            ? (action.message ?? state.simErrorMessage)
            : '',
      };
    case 'SET_COMPILER_OUTPUT':
      return { ...state, compilerOutput: action.text };
    case 'APPEND_COMPILER_OUTPUT':
      return {
        ...state,
        compilerOutput: state.compilerOutput + action.text,
      };
    case 'CLEAR_SERIAL':
      return {
        ...state,
        compilerOutput: '',
        simErrorMessage: '',
      };
    case 'RESET_LIVE_PIN_STATES':
      return {
        ...state,
        components: state.components.map((c) => {
          const def = getDefinition(c.type);
          const pinStates = Object.fromEntries(
            def.pins.map((p) => [p.id, 'floating' as const]),
          );
          return { ...c, pinStates };
        }),
        simStatus: 'idle',
        simTimeMs: 0,
        simErrorMessage: '',
        pressedButtonIds: [],
        simFlags: createComponentSimFlags(),
      };
    case 'SET_BUTTON_PRESSED': {
      const set = new Set(state.pressedButtonIds);
      if (action.pressed) set.add(action.componentId);
      else set.delete(action.componentId);
      return { ...state, pressedButtonIds: [...set] };
    }
    case 'SET_VIEWPORT':
      return { ...state, viewport: action.viewport };
    case 'SELECT':
      return {
        ...state,
        selectedIds: action.componentIds,
        selectedWireIds: action.wireIds,
      };
    case 'ADD_COMPONENT':
      return {
        ...state,
        components: [...state.components, action.component],
        selectedIds: [action.component.id],
        selectedWireIds: [],
      };
    case 'CONFIRM_PLACEMENT': {
      if (!state.placementType) return state;
      const component = createComponent(
        state.placementType,
        action.x,
        action.y,
        action.rotation,
      );
      return {
        ...state,
        components: [...state.components, component],
        selectedIds: [component.id],
        selectedWireIds: [],
        placementType: null,
        placementRotation: 0,
      };
    }
    case 'MOVE_COMPONENT': {
      const components = state.components.map((c) =>
        c.id === action.id ? { ...c, x: action.x, y: action.y } : c,
      );
      return {
        ...state,
        wires: state.wires.map(w => w.from.componentId === action.id || w.to.componentId === action.id
          ? releaseAutomaticWireBends(w, state.components, components) : w),
        components,
      };
    }
    case 'UPDATE_COMPONENT':
      return {
        ...state,
        components: state.components.map((c) =>
          c.id === action.id ? { ...c, ...action.patch } : c,
        ),
      };
    case 'ROTATE_SELECTED': {
      if (state.selectedIds.length === 0) return state;
      const ids = new Set(state.selectedIds);
      return {
        ...state,
        wires: state.wires.map(w => ids.has(w.from.componentId) || ids.has(w.to.componentId)
          ? releaseAutomaticWireBends(w, state.components) : w),
        components: state.components.map((c) => {
          if (!ids.has(c.id)) return c;
          const rotation = (c.rotation + action.degrees + 360) % 360;
          const snapped = snapComponentPlacement(
            c.type,
            { x: c.x, y: c.y },
            rotation,
            state.components.filter((other) => other.id !== c.id),
          );
          return { ...c, rotation, x: snapped.x, y: snapped.y };
        }),
      };
    }
    case 'DELETE_SELECTED': {
      const compIds = new Set(state.selectedIds);
      const wireIds = new Set(state.selectedWireIds);
      if (compIds.size === 0 && wireIds.size === 0) return state;
      const nextComponents = state.components.filter((c) => !compIds.has(c.id));
      const nextWires = state.wires.filter((w) => {
        if (wireIds.has(w.id)) return false;
        if (compIds.has(w.from.componentId) || compIds.has(w.to.componentId)) {
          return false;
        }
        return true;
      });
      const pruned = pruneOrphanWireJunctions(nextComponents, nextWires);
      return {
        ...state,
        components: pruned.components,
        wires: pruned.wires,
        selectedIds: [],
        selectedWireIds: [],
      };
    }
    case 'START_WIRE':
      return { ...state, wireDraft: { from: action.pin, bends: [] } };
    case 'ADD_WIRE_BEND':
      if (!state.wireDraft) return state;
      return {
        ...state,
        wireDraft: {
          ...state.wireDraft,
          bends: [...state.wireDraft.bends, { x: action.x, y: action.y }],
        },
      };
    case 'CANCEL_WIRE':
      return { ...state, wireDraft: null };
    case 'COMPLETE_WIRE': {
      const draft = state.wireDraft;
      if (!draft) return state;
      const samePin =
        draft.from.componentId === action.pin.componentId &&
        draft.from.pinId === action.pin.pinId;
      if (samePin) return { ...state, wireDraft: null };
      const exists = state.wires.some(
        (w) =>
          (w.from.componentId === draft.from.componentId &&
            w.from.pinId === draft.from.pinId &&
            w.to.componentId === action.pin.componentId &&
            w.to.pinId === action.pin.pinId) ||
          (w.to.componentId === draft.from.componentId &&
            w.to.pinId === draft.from.pinId &&
            w.from.componentId === action.pin.componentId &&
            w.from.pinId === action.pin.pinId),
      );
      if (exists) return { ...state, wireDraft: null };
      const from = getPinPosition(draft.from, state.components);
      const to = getPinPosition(action.pin, state.components);
      const bends =
        from && to
          ? bendsForCompletedWire(
              from,
              to,
              draft.bends,
              draft.from,
              action.pin,
              state.components,
            )
          : draft.bends;
      return {
        ...state,
        wires: [
          ...state.wires,
          {
            id: nextId('wire'),
            from: draft.from,
            to: action.pin,
            bends,
          },
        ],
        wireDraft: null,
      };
    }
    case 'COMPLETE_WIRE_ON_WIRE': {
      const draft = state.wireDraft;
      if (!draft) return state;
      const target = state.wires.find((w) => w.id === action.wireId);
      if (!target) return state;

      const existingJunction = findWireJunctionPinAt(
        action.world,
        state.components,
      );
      if (existingJunction) {
        const samePin =
          draft.from.componentId === existingJunction.componentId &&
          draft.from.pinId === existingJunction.pinId;
        if (samePin) return { ...state, wireDraft: null };
        const from = getPinPosition(draft.from, state.components);
        const to = getPinPosition(existingJunction, state.components);
        const bends =
          from && to
            ? bendsForCompletedWire(
                from,
                to,
                draft.bends,
                draft.from,
                existingJunction,
                state.components,
              )
            : draft.bends;
        return {
          ...state,
          wires: [
            ...state.wires,
            {
              id: nextId('wire'),
              from: draft.from,
              to: existingJunction,
              bends,
            },
          ],
          wireDraft: null,
        };
      }

      const projected = projectPointOntoWire(
        target,
        state.components,
        action.world,
      );
      if (!projected) {
        // Near an endpoint: finish onto that pin instead of splitting.
        const fromEnd = getPinPosition(target.from, state.components);
        const toEnd = getPinPosition(target.to, state.components);
        const nearFrom =
          fromEnd &&
          Math.hypot(action.world.x - fromEnd.x, action.world.y - fromEnd.y) <=
            14;
        const nearTo =
          toEnd &&
          Math.hypot(action.world.x - toEnd.x, action.world.y - toEnd.y) <= 14;
        if (nearFrom || nearTo) {
          const pin = nearFrom ? target.from : target.to!;
          const samePin =
            draft.from.componentId === pin.componentId &&
            draft.from.pinId === pin.pinId;
          if (samePin) return { ...state, wireDraft: null };
          const from = getPinPosition(draft.from, state.components);
          const to = getPinPosition(pin, state.components);
          const bends =
            from && to
              ? bendsForCompletedWire(
                  from,
                  to,
                  draft.bends,
                  draft.from,
                  pin,
                  state.components,
                )
              : draft.bends;
          return {
            ...state,
            wires: [
              ...state.wires,
              {
                id: nextId('wire'),
                from: draft.from,
                to: pin,
                bends,
              },
            ],
            wireDraft: null,
          };
        }
        return state;
      }

      const split = splitWirePathAt(
        projected.path,
        projected.point,
        projected.segmentIndex,
      );
      if (!split) return state;

      const junction = createComponent(
        WIRE_JUNCTION_TYPE,
        wireJunctionTopLeft(projected.point).x,
        wireJunctionTopLeft(projected.point).y,
      );
      const junctionPin: PinRef = {
        componentId: junction.id,
        pinId: WIRE_JUNCTION_PIN_ID,
      };
      const compsWithJunction = [...state.components, junction];
      const leftBends = pathToBends(split.left);
      const rightBends = pathToBends(split.right);
      const draftFrom = getPinPosition(draft.from, compsWithJunction);
      const junctionPos = getPinPosition(junctionPin, compsWithJunction);
      const draftBends =
        draftFrom && junctionPos
          ? bendsForCompletedWire(
              draftFrom,
              junctionPos,
              draft.bends,
              draft.from,
              junctionPin,
              compsWithJunction,
            )
          : draft.bends;

      const wireA: Wire = {
        id: nextId('wire'),
        from: target.from,
        to: junctionPin,
        bends: leftBends,
      };
      const wireB: Wire = {
        id: nextId('wire'),
        from: junctionPin,
        to: target.to,
        bends: rightBends,
      };
      const wireC: Wire = {
        id: nextId('wire'),
        from: draft.from,
        to: junctionPin,
        bends: draftBends,
      };

      return {
        ...state,
        components: compsWithJunction,
        wires: [
          ...state.wires.filter((w) => w.id !== target.id),
          wireA,
          wireB,
          wireC,
        ],
        wireDraft: null,
        selectedIds: [],
        selectedWireIds: [],
      };
    }
    case 'UPDATE_WIRE_BENDS':
      return {
        ...state,
        wires: state.wires.map((w) =>
          w.id === action.wireId ? { ...w, bends: action.bends } : w,
        ),
      };
    case 'START_PLACEMENT':
      return {
        ...state,
        placementType: action.componentType,
        placementRotation: 0,
        wireDraft: null,
        selectedIds: [],
        selectedWireIds: [],
      };
    case 'CANCEL_PLACEMENT':
      return { ...state, placementType: null, placementRotation: 0 };
    case 'ROTATE_PLACEMENT':
      if (!state.placementType) return state;
      return {
        ...state,
        placementRotation: (state.placementRotation + action.degrees + 360) % 360,
      };
    case 'LOAD_PROJECT':
      idCounter = action.nextIdCounter;
      return {
        ...state,
        components: action.components,
        wires: action.wires,
        viewport: action.viewport,
        selectedIds: [],
        selectedWireIds: [],
        wireDraft: null,
        placementType: null,
        placementRotation: 0,
      };
    case 'RESTORE_SNAPSHOT':
      idCounter = action.idCounter;
      return {
        ...state,
        components: action.components,
        wires: action.wires,
        viewport: action.viewport,
        selectedIds: [],
        selectedWireIds: [],
        wireDraft: null,
        placementType: null,
        placementRotation: 0,
      };
    case 'PASTE':
      return {
        ...state,
        components: [...state.components, ...action.components],
        wires: [...state.wires, ...action.wires],
        selectedIds: action.selectedIds,
        selectedWireIds: action.selectedWireIds,
        wireDraft: null,
        placementType: null,
        placementRotation: 0,
      };
    default:
      return state;
  }
}

const initialState: SimState = {
  components: [],
  wires: [],
  viewport: { x: 80, y: 60, zoom: 1 },
  selectedIds: [],
  selectedWireIds: [],
  wireDraft: null,
  placementType: null,
  placementRotation: 0,
  simStatus: 'idle',
  simErrorMessage: '',
  sketchSource: DEFAULT_SKETCH,
  sketchName: 'sketch',
  compilerOutput: '',
  simTimeMs: 0,
  pressedButtonIds: [],
  simFlags: createComponentSimFlags(),
  loadedHex: null,
  loadedHexName: null,
};

interface SimContextValue {
  state: SimState;
  setViewport: (viewport: Viewport) => void;
  select: (componentIds: string[], wireIds?: string[]) => void;
  placeComponent: (type: string, x: number, y: number) => void;
  moveComponent: (id: string, x: number, y: number) => void;
  updateComponent: (id: string, patch: Partial<PlacedComponent>) => void;
  rotateSelected: (degrees?: number) => void;
  deleteSelected: () => void;
  pinClick: (pin: PinRef) => void;
  completeWireOnWire: (wireId: string, world: { x: number; y: number }) => void;
  addWireBend: (x: number, y: number) => void;
  updateWireBends: (
    wireId: string,
    bends: { x: number; y: number }[],
    recordHistory?: boolean,
  ) => void;
  cancelWire: () => void;
  startPlacement: (componentType: string) => void;
  cancelPlacement: () => void;
  confirmPlacement: (x: number, y: number, rotation: number) => void;
  rotatePlacement: (degrees?: number) => void;
  saveProject: (filename?: string) => Promise<'folder' | 'download'>;
  loadProject: (file: ProjectFile) => void;
  loadProjectFromJson: (text: string) => void;
  recordUndoSnapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  copySelection: () => void;
  pasteSelection: (atWorld?: { x: number; y: number }) => void;
  setSketchSource: (source: string) => void;
  newSketch: () => void;
  loadSketchFromFile: (text: string, filename: string) => void;
  saveSketchToFile: () => void;
  applySketchTemplate: (templateId: string) => void;
  loadHexFirmware: (text: string, filename: string) => string | null;
  clearLoadedHex: () => void;
  compileAndRun: () => Promise<void>;
  stopSimulation: () => void;
  sendSerial: (text: string) => void;
  clearSerialOutput: () => void;
  setButtonPressed: (componentId: string, pressed: boolean) => void;
  setPotPosition: (componentId: string, position: number) => void;
  setCanvasInteracting: (active: boolean) => void;
}

const SimContext = createContext<SimContextValue | null>(null);

export function SimProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const undoStacksRef = useRef(createUndoStacks());
  const clipboardRef = useRef<{ payload: CopyPayload | null; pasteCount: number }>({
    payload: null,
    pasteCount: 0,
  });
  const [clipboardTick, setClipboardTick] = useState(0);
  const syncClipboardUi = useCallback(() => setClipboardTick((t) => t + 1), []);
  const [historyTick, setHistoryTick] = useState(0);
  const syncHistoryUi = useCallback(() => setHistoryTick((t) => t + 1), []);

  const canvasInteractingRef = useRef(false);

  const simulationRef = useRef<SimulationController | null>(null);
  if (!simulationRef.current) {
    simulationRef.current = new SimulationController(
      {
        onStatus: (status, message) => {
          if (status !== 'running') flushSerialOutput();
          dispatch({ type: 'SET_SIM_STATUS', status, message });
        },
        onCompilerOutput: (text) => {
          dispatch({ type: 'SET_COMPILER_OUTPUT', text });
        },
        onCompilerAppend: (text) => {
          dispatch({ type: 'APPEND_COMPILER_OUTPUT', text });
        },
        onSerialOutput: (text) => {
          appendSerialOutput(text);
        },
      },
      { isCanvasInteracting: () => canvasInteractingRef.current },
    );
  }

  const setCanvasInteracting = useCallback((active: boolean) => {
    canvasInteractingRef.current = active;
    if (!active) {
      simulationRef.current?.forceVisualSync();
    }
  }, []);

  useEffect(() => {
    const stopSim = () => simulationRef.current?.stop();
    window.addEventListener('pagehide', stopSim);
    window.addEventListener('beforeunload', stopSim);
    return () => {
      window.removeEventListener('pagehide', stopSim);
      window.removeEventListener('beforeunload', stopSim);
      stopSim();
    };
  }, []);

  const setSketchSource = useCallback((source: string) => {
    dispatch({ type: 'SET_SKETCH', source });
  }, []);

  const compileAndRun = useCallback(async () => {
    const s = stateRef.current;
    resetSerialOutput();
    dispatch({ type: 'CLEAR_SERIAL' });

    const watchdog = window.setTimeout(() => {
      if (stateRef.current.simStatus === 'compiling') {
        simulationRef.current?.stop();
        dispatch({
          type: 'SET_SIM_STATUS',
          status: 'error',
          message:
            'Compile timed out. Try importing a .hex file, or use a smaller sketch.',
        });
      }
    }, 18_000);

    try {
      await simulationRef.current?.runFirmware({
        sketch: s.loadedHex ? undefined : s.sketchSource,
        hex: s.loadedHex ?? undefined,
        hexFilename: s.loadedHexName ?? undefined,
        components: s.components,
        wires: s.wires,
      });
    } finally {
      window.clearTimeout(watchdog);
    }
  }, []);

  const sendSerial = useCallback((text: string) => {
    if (stateRef.current.simStatus === 'running') simulationRef.current?.sendSerial(text);
  }, []);

  const stopSimulation = useCallback(() => {
    simulationRef.current?.stop();
    resetSimLiveState();
    dispatch({ type: 'RESET_LIVE_PIN_STATES' });
  }, []);

  const haltSimulation = useCallback(() => {
    const status = stateRef.current.simStatus;
    if (status === 'running' || status === 'compiling') {
      stopSimulation();
    }
  }, [stopSimulation]);

  const newSketch = useCallback(() => {
    haltSimulation();
    dispatch({ type: 'NEW_SKETCH' });
  }, [haltSimulation]);

  const loadSketchFromFile = useCallback(
    (text: string, filename: string) => {
      haltSimulation();
      dispatch({
        type: 'LOAD_SKETCH',
        source: parseInoSource(text),
        name: sketchNameFromFilename(filename),
      });
    },
    [haltSimulation],
  );

  const saveSketchToFile = useCallback(() => {
    const s = stateRef.current;
    downloadSketchFile(s.sketchSource, s.sketchName);
  }, []);

  const applySketchTemplate = useCallback(
    (templateId: string) => {
      const template = getSketchTemplate(templateId);
      if (!template) return;
      haltSimulation();
      dispatch({
        type: 'LOAD_SKETCH',
        source: template.source,
        name: template.filename,
      });
    },
    [haltSimulation],
  );

  const loadHexFirmware = useCallback((text: string, filename: string): string | null => {
    const parsed = parseHexFile(text, filename);
    if (!parsed.validation.ok) {
      return parsed.validation.message ?? 'Invalid HEX file.';
    }
    haltSimulation();
    dispatch({ type: 'SET_LOADED_HEX', hex: parsed.hex, filename: parsed.filename });
    dispatch({
      type: 'SET_COMPILER_OUTPUT',
      text: `Ready to run: ${parsed.filename}\nProgram data: ${parsed.validation.dataBytes ?? 0} bytes`,
    });
    return null;
  }, [haltSimulation]);

  const clearLoadedHex = useCallback(() => {
    dispatch({ type: 'CLEAR_LOADED_HEX' });
  }, []);

  const clearSerialOutput = useCallback(() => {
    resetSerialOutput();
    dispatch({ type: 'CLEAR_SERIAL' });
  }, []);

  const setButtonPressed = useCallback((componentId: string, pressed: boolean) => {
    simulationRef.current?.setButtonPressed(componentId, pressed);
    dispatch({ type: 'SET_BUTTON_PRESSED', componentId, pressed });
  }, []);

  const setPotPosition = useCallback((componentId: string, position: number) => {
    simulationRef.current?.setPotPosition(componentId, position);
  }, []);

  const snapshotFromCurrent = useCallback(
    () =>
      createUndoSnapshot(
        stateRef.current.components,
        stateRef.current.wires,
        stateRef.current.viewport,
        idCounter,
      ),
    [],
  );

  const recordUndoSnapshot = useCallback(() => {
    pushUndoSnapshot(undoStacksRef.current, snapshotFromCurrent());
    syncHistoryUi();
  }, [snapshotFromCurrent, syncHistoryUi]);

  const resetUndoHistory = useCallback(() => {
    resetUndoStacks(undoStacksRef.current);
    syncHistoryUi();
  }, [syncHistoryUi]);

  const undo = useCallback(() => {
    haltSimulation();
    const restored = popUndo(undoStacksRef.current, snapshotFromCurrent());
    if (!restored) return;
    dispatch({
      type: 'RESTORE_SNAPSHOT',
      components: restored.components,
      wires: restored.wires,
      viewport: restored.viewport,
      idCounter: restored.idCounter,
    });
    syncHistoryUi();
  }, [snapshotFromCurrent, syncHistoryUi, haltSimulation]);

  const redo = useCallback(() => {
    haltSimulation();
    const restored = popRedo(undoStacksRef.current, snapshotFromCurrent());
    if (!restored) return;
    dispatch({
      type: 'RESTORE_SNAPSHOT',
      components: restored.components,
      wires: restored.wires,
      viewport: restored.viewport,
      idCounter: restored.idCounter,
    });
    syncHistoryUi();
  }, [snapshotFromCurrent, syncHistoryUi, haltSimulation]);

  const canUndoNow = canUndo(undoStacksRef.current);
  const canRedoNow = canRedo(undoStacksRef.current);
  void historyTick;
  void clipboardTick;
  const canPasteNow = clipboardRef.current.payload !== null;

  const copySelection = useCallback(() => {
    const s = stateRef.current;
    const payload = buildCopyPayload(
      s.components,
      s.wires,
      s.selectedIds,
      s.selectedWireIds,
    );
    if (!payload) return;
    clipboardRef.current = { payload, pasteCount: 0 };
    syncClipboardUi();
  }, [syncClipboardUi]);

  const pasteSelection = useCallback(
    (atWorld?: { x: number; y: number }) => {
      const clip = clipboardRef.current;
      if (!clip.payload) return;

      haltSimulation();

      const existingComponents = stateRef.current.components;
      let result;

      if (atWorld) {
        result = pastePayloadAt(clip.payload, atWorld, nextId);
        if (result.components.length > 0) {
          const lead = result.components.reduce((best, c) =>
            c.x < best.x || (c.x === best.x && c.y < best.y) ? c : best,
          );
          const snappedLead = snapComponentPlacement(
            lead.type,
            { x: lead.x, y: lead.y },
            lead.rotation,
            existingComponents,
          );
          const dx = snappedLead.x - lead.x;
          const dy = snappedLead.y - lead.y;
          if (dx !== 0 || dy !== 0) {
            result = {
              ...result,
              components: result.components.map((c) => ({
                ...c,
                x: c.x + dx,
                y: c.y + dy,
              })),
              wires: result.wires.map((w) => ({
                ...w,
                bends: w.bends.map((b) => ({ x: b.x + dx, y: b.y + dy })),
              })),
            };
          }
        }
      } else {
        clip.pasteCount += 1;
        result = pastePayload(clip.payload, clip.pasteCount, nextId);
      }

      recordUndoSnapshot();
      dispatch({
        type: 'PASTE',
        components: result.components,
        wires: result.wires,
        selectedIds: result.selectedIds,
        selectedWireIds: result.selectedWireIds,
      });
      syncClipboardUi();
    },
    [recordUndoSnapshot, syncClipboardUi, haltSimulation],
  );

  const setViewport = useCallback((viewport: Viewport) => {
    dispatch({ type: 'SET_VIEWPORT', viewport });
  }, []);

  const select = useCallback((componentIds: string[], wireIds: string[] = []) => {
    dispatch({ type: 'SELECT', componentIds, wireIds });
  }, []);

  const placeComponent = useCallback((type: string, x: number, y: number) => {
    haltSimulation();
    recordUndoSnapshot();
    dispatch({
      type: 'ADD_COMPONENT',
      component: createComponent(type, x, y),
    });
  }, [recordUndoSnapshot, haltSimulation]);

  const moveComponent = useCallback((id: string, x: number, y: number) => {
    dispatch({ type: 'MOVE_COMPONENT', id, x, y });
  }, []);

  const updateComponent = useCallback(
    (id: string, patch: Partial<PlacedComponent>) => {
      haltSimulation();
      recordUndoSnapshot();
      dispatch({ type: 'UPDATE_COMPONENT', id, patch });
    },
    [recordUndoSnapshot, haltSimulation],
  );

  const rotateSelected = useCallback(
    (degrees = 90) => {
      if (stateRef.current.selectedIds.length === 0) return;
      recordUndoSnapshot();
      dispatch({ type: 'ROTATE_SELECTED', degrees });
    },
    [recordUndoSnapshot],
  );

  const deleteSelected = useCallback(() => {
    if (
      stateRef.current.selectedIds.length === 0 &&
      stateRef.current.selectedWireIds.length === 0
    ) {
      return;
    }
    haltSimulation();
    recordUndoSnapshot();
    dispatch({ type: 'DELETE_SELECTED' });
  }, [recordUndoSnapshot, haltSimulation]);

  const pinClick = useCallback(
    (pin: PinRef) => {
      if (!state.wireDraft) {
        dispatch({ type: 'START_WIRE', pin });
      } else {
        haltSimulation();
        recordUndoSnapshot();
        dispatch({ type: 'COMPLETE_WIRE', pin });
      }
    },
    [state.wireDraft, recordUndoSnapshot, haltSimulation],
  );

  const completeWireOnWire = useCallback(
    (wireId: string, world: { x: number; y: number }) => {
      if (!stateRef.current.wireDraft) return;
      haltSimulation();
      recordUndoSnapshot();
      dispatch({ type: 'COMPLETE_WIRE_ON_WIRE', wireId, world });
    },
    [recordUndoSnapshot, haltSimulation],
  );

  const addWireBend = useCallback((x: number, y: number) => {
    dispatch({ type: 'ADD_WIRE_BEND', x, y });
  }, []);

  const updateWireBends = useCallback(
    (wireId: string, bends: { x: number; y: number }[], recordHistory = false) => {
      if (recordHistory) recordUndoSnapshot();
      dispatch({ type: 'UPDATE_WIRE_BENDS', wireId, bends });
    },
    [recordUndoSnapshot],
  );

  const cancelWire = useCallback(() => {
    dispatch({ type: 'CANCEL_WIRE' });
  }, []);

  const startPlacement = useCallback((componentType: string) => {
    dispatch({ type: 'START_PLACEMENT', componentType });
  }, []);

  const cancelPlacement = useCallback(() => {
    dispatch({ type: 'CANCEL_PLACEMENT' });
  }, []);

  const confirmPlacement = useCallback(
    (x: number, y: number, rotation: number) => {
      if (!stateRef.current.placementType) return;
      haltSimulation();
      recordUndoSnapshot();
      dispatch({ type: 'CONFIRM_PLACEMENT', x, y, rotation });
    },
    [recordUndoSnapshot, haltSimulation],
  );

  const rotatePlacement = useCallback((degrees = 90) => {
    if (!stateRef.current.placementType) return;
    dispatch({ type: 'ROTATE_PLACEMENT', degrees });
  }, []);

  const saveProject = useCallback(
    async (filename?: string): Promise<'folder' | 'download'> => {
      const name = normalizeProjectFilename(filename ?? 'arduino-circuit');
      const project = createProjectFile({
        components: state.components,
        wires: state.wires,
        viewport: state.viewport,
        sketch: state.sketchSource,
        sketchName: state.sketchName,
      });

      let where: 'folder' | 'download';
      if (await isUserProjectsApiAvailable()) {
        await saveUserProjectFile(name, projectFileToJson(project));
        where = 'folder';
      } else {
        downloadProjectFile(project, name);
        where = 'download';
      }

      return where;
    },
    [state.components, state.wires, state.viewport, state.sketchSource, state.sketchName],
  );

  const loadProject = useCallback(
    (file: ProjectFile) => {
      haltSimulation();
      dispatch({
        type: 'LOAD_PROJECT',
        components: file.components,
        wires: file.wires,
        viewport: file.viewport,
        nextIdCounter: maxIdSuffix(file.components, file.wires),
      });
      if (file.sketch !== undefined) {
        dispatch({
          type: 'LOAD_SKETCH',
          source: file.sketch,
          name: file.sketchName?.trim() || 'sketch',
        });
      }
      resetUndoHistory();
    },
    [resetUndoHistory, haltSimulation],
  );

  const loadProjectFromJson = useCallback(
    (text: string) => {
      loadProject(parseProjectJson(text));
    },
    [loadProject],
  );

  const value = useMemo(
    () => ({
      state,
      setViewport,
      select,
      placeComponent,
      moveComponent,
      updateComponent,
      rotateSelected,
      deleteSelected,
      pinClick,
      completeWireOnWire,
      addWireBend,
      updateWireBends,
      cancelWire,
      startPlacement,
      cancelPlacement,
      confirmPlacement,
      rotatePlacement,
      saveProject,
      loadProject,
      loadProjectFromJson,
      recordUndoSnapshot,
      undo,
      redo,
      canUndo: canUndoNow,
      canRedo: canRedoNow,
      canPaste: canPasteNow,
      copySelection,
      pasteSelection,
      setSketchSource,
      newSketch,
      loadSketchFromFile,
      saveSketchToFile,
      applySketchTemplate,
      loadHexFirmware,
      clearLoadedHex,
      compileAndRun,
      stopSimulation,
      sendSerial,
      clearSerialOutput,
      setButtonPressed,
      setPotPosition,
      setCanvasInteracting,
    }),
    [
      state,
      setViewport,
      select,
      placeComponent,
      moveComponent,
      updateComponent,
      rotateSelected,
      deleteSelected,
      pinClick,
      completeWireOnWire,
      addWireBend,
      updateWireBends,
      cancelWire,
      startPlacement,
      cancelPlacement,
      confirmPlacement,
      rotatePlacement,
      saveProject,
      loadProject,
      loadProjectFromJson,
      recordUndoSnapshot,
      undo,
      redo,
      canUndoNow,
      canRedoNow,
      canPasteNow,
      copySelection,
      pasteSelection,
      setSketchSource,
      newSketch,
      loadSketchFromFile,
      saveSketchToFile,
      applySketchTemplate,
      loadHexFirmware,
      clearLoadedHex,
      compileAndRun,
      stopSimulation,
      sendSerial,
      clearSerialOutput,
      setButtonPressed,
      setPotPosition,
      setCanvasInteracting,
    ],
  );

  return <SimContext.Provider value={value}>{children}</SimContext.Provider>;
}

export function useSim() {
  const ctx = useContext(SimContext);
  if (!ctx) throw new Error('useSim must be used within SimProvider');
  return ctx;
}

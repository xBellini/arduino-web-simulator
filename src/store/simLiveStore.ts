/**
 * What: Module-level live sim snapshot for React — outside the editor reducer.
 * Role: high-frequency pin states / flags / solver debug without undo pollution.
 * Also owns buffered serial display text with separate listeners so output never invalidates canvas subscribers.
 * Owns/exports: subscribe/getters, `applySimLivePinStates`, `resetSimLiveState`,
 * `setDcSolverBackend`, ngspice debug setters, version counter for hooks.
 * Conventions: only `SimulationController` and solvers should write; UI reads via subscribe
 * hook pattern; reset on stop clears pins/flags/debug.
 * To surface new live data in UI: extend `SimLiveSnapshot`, update apply/reset clones, expose
 * getter + bump `version` in `emit`.
 * To debug ngspice: populate `NgspiceDcDebug` from solver, read in meter/debug components.
 * Not-here: placed component persistence, wire topology edits, or compile output strings.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | `applySimLivePinStates` no-ops when pins/flags/backend/debug are unchanged
# 05-10-2026 | Cursor | `simPerf` overlay snapshot preserved across pin updates
# 15-10-2026 | Codex | Buffer serial display text for 16 ms on an independent subscription; preserve order, flush on stop and discard pending text on clear.
 */

import type { PinState } from '../types';
import {
  createComponentSimFlags,
  type ComponentSimFlags,
} from '../avr/gpioBridge';

export type DcSolverBackend = 'ngspice' | 'legacy' | null;

/** ngspice .OP values pushed to the UI for debugging. */
export type NgspiceDcDebug = {
  branchCurrentMa: Record<string, number>;
  netVoltages: Record<number, number>;
  ledConducting: Record<string, boolean>;
};

export type { SimPerfSnapshot } from '../avr/simPerf';
import type { SimPerfSnapshot } from '../avr/simPerf';

type SimLiveSnapshot = {
  pinStatesByComponent: Record<string, Record<string, PinState>>;
  simFlags: ComponentSimFlags;
  dcSolverBackend: DcSolverBackend;
  ngspiceDebug: NgspiceDcDebug | null;
  /** Live Sim perf overlay metrics while Run is active. */
  simPerf: SimPerfSnapshot | null;
  version: number;
};

let snapshot: SimLiveSnapshot = {
  pinStatesByComponent: {},
  simFlags: createComponentSimFlags(),
  dcSolverBackend: null,
  ngspiceDebug: null,
  simPerf: null,
  version: 0,
};

const listeners = new Set<() => void>();

// Serial display notifications must not invalidate the canvas live snapshot.
let serialText = '';
let pendingSerial = '';
let serialTimer: ReturnType<typeof setTimeout> | undefined;
const serialListeners = new Set<() => void>();

export function getSerialOutput(): string { return serialText; }
export function subscribeSerialOutput(listener: () => void): () => void {
  serialListeners.add(listener);
  return () => { serialListeners.delete(listener); };
}
export function flushSerialOutput(): void {
  clearTimeout(serialTimer);
  serialTimer = undefined;
  if (!pendingSerial) return;
  serialText += pendingSerial;
  pendingSerial = '';
  for (const listener of serialListeners) listener();
}
export function appendSerialOutput(text: string): void {
  if (!text) return;
  pendingSerial += text;
  if (serialTimer === undefined) serialTimer = setTimeout(flushSerialOutput, 16);
}
export function resetSerialOutput(): void {
  clearTimeout(serialTimer);
  serialTimer = undefined;
  pendingSerial = '';
  if (!serialText) return;
  serialText = '';
  for (const listener of serialListeners) listener();
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function clonePinStates(
  pinStatesByComponent: Record<string, Record<string, PinState>>,
): Record<string, Record<string, PinState>> {
  return Object.fromEntries(
    Object.entries(pinStatesByComponent).map(([componentId, pins]) => [
      componentId,
      { ...pins },
    ]),
  );
}

export function subscribeSimLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSimLiveSnapshot(): SimLiveSnapshot {
  return snapshot;
}

export function applySimLivePinStates(
  pinStatesByComponent: Record<string, Record<string, PinState>>,
  simFlags: ComponentSimFlags,
  dcSolverBackend?: DcSolverBackend,
  ngspiceDebug?: NgspiceDcDebug | null,
): void {
  const nextBackend =
    dcSolverBackend !== undefined ? dcSolverBackend : snapshot.dcSolverBackend;
  const nextDebug =
    ngspiceDebug !== undefined ? ngspiceDebug : snapshot.ngspiceDebug;

  // Static frames (bench PSU, held GPIO) must not force a full canvas re-render.
  if (
    nextBackend === snapshot.dcSolverBackend &&
    JSON.stringify(snapshot.pinStatesByComponent) ===
      JSON.stringify(pinStatesByComponent) &&
    JSON.stringify(snapshot.simFlags) === JSON.stringify(simFlags) &&
    JSON.stringify(snapshot.ngspiceDebug) === JSON.stringify(nextDebug)
  ) {
    return;
  }

  snapshot = {
    pinStatesByComponent: clonePinStates(pinStatesByComponent),
    simFlags: structuredClone(simFlags),
    dcSolverBackend: nextBackend,
    ngspiceDebug: nextDebug,
    // Preserve sim-perf overlay across high-frequency pin updates (was blinking off).
    simPerf: snapshot.simPerf,
    version: snapshot.version + 1,
  };
  emit();
}

export function setDcSolverBackend(backend: DcSolverBackend): void {
  if (snapshot.dcSolverBackend === backend) return;
  snapshot = { ...snapshot, dcSolverBackend: backend, version: snapshot.version + 1 };
  emit();
}

export function resetSimLiveState(): void {
  snapshot = {
    pinStatesByComponent: {},
    simFlags: createComponentSimFlags(),
    dcSolverBackend: null,
    ngspiceDebug: null,
    simPerf: null,
    version: snapshot.version + 1,
  };
  emit();
}

/** Push Sim perf overlay metrics (throttled by `simPerf.ts`). */
export function applySimPerfSnapshot(simPerf: SimPerfSnapshot): void {
  snapshot = {
    ...snapshot,
    simPerf,
    version: snapshot.version + 1,
  };
  emit();
}

export function pinStateForComponent(
  componentId: string,
  pinId: string,
  fallback: PinState,
): PinState {
  return snapshot.pinStatesByComponent[componentId]?.[pinId] ?? fallback;
}

/**
 * What: Module-level live sim snapshot for React — outside the editor reducer.
 * Role: high-frequency pin states / flags / solver debug without undo pollution.
 * Owns/exports: subscribe/getters, `applySimLivePinStates`, `resetSimLiveState`,
 * `setDcSolverBackend`, ngspice debug setters, version counter for hooks.
 * Conventions: only `SimulationController` and solvers should write; UI reads via subscribe
 * hook pattern; reset on stop clears pins/flags/debug.
 * To surface new live data in UI: extend `SimLiveSnapshot`, update apply/reset clones, expose
 * getter + bump `version` in `emit`.
 * To debug ngspice: populate `NgspiceDcDebug` from solver, read in meter/debug components.
 * Not-here: placed component persistence, wire topology edits, or compile output strings.
 *
 * Changelog:
 * - 05-10-2026 — `simPerf` overlay snapshot preserved across pin updates
 * - 17-09-2026 — `applySimLivePinStates` no-ops when pins/flags/backend/debug are unchanged
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
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

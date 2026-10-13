/**
 * What: DC operating-point facade for the sim loop — sync read path + async ngspice refresh.
 *
 * Owns/exports: `solveDcCircuit`, `refreshDcOperatingPoint`, re-exports of `DcSolveResult`,
 * ground/level helpers, ngspice cache API (`getCachedNgspiceDcResult`, `invalidateNgspiceCache`,
 * `terminateNgspiceWorker`), and SPICE waveform cache helpers (`lookupSpiceWaveCache`,
 * `putSpiceWaveCache`, `prepareIcForSpiceWaveFill`, `takeNgspiceWaveform`, …).
 *
 * Conventions: Each frame call `refreshDcOperatingPoint` (async) then `solveDcCircuit` (sync);
 * cache key includes components, netlist, blow/button/MCU source state. Legacy runs only on
 * cache miss. Circuits with capacitors prefer RC-sized `.tran` + waveform playback in spice/client.ts.
 *
 * To wire a new input into DC solves, thread the parameter through both `solveDcCircuit` and
 * `refreshDcOperatingPoint`, then update spice/client.ts cache keying and legacy callers.
 * To force MNA after schematic edits, call `invalidateNgspiceCache()` from the editor layer.
 * To shut down the worker on teardown, call `terminateNgspiceWorker`.
 *
 * Not here: MNA matrix details or SPICE deck text — see circuit/mnaLegacy.ts and
 * spice/netlistExport.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 25-09-2026 | Cursor | Thread capacitorBlown; capacitor circuits use stepped .tran
# 28-09-2026 | Cursor | Restored normal line spacing (file had been double-spaced)
#                     | Re-export SPICE waveform cache / IC helpers used by blink replay
# 09-10-2026 | Cursor | Moved from `src/sim/dcCircuitSolver.ts` (tree reorganization)
 */


import type { PlacedComponent } from '../types';
import type { CircuitNetlist, McuSourceMap } from './netlist';
import {
  findGroundNetId,
  hasStandaloneCircuit,
  netLevelsFromDc,
  netVoltageToLevel,
  solveDcCircuitLegacy,
  type DcSolveResult,
  LED_ON_RESISTANCE_OHMS,
} from './mnaLegacy';
import {
  getCachedNgspiceDcResult,
  invalidateNgspiceCache,
  commitNgspiceNodeIc,
  takeNgspiceWaveform,
  abortNgspiceInFlight,
  lookupSpiceWaveCache,
  putSpiceWaveCache,
  prepareIcForSpiceWaveFill,
  circuitKeyFromSolveSig,
  spiceWaveKindFromSolveSig,
  solveDcWithNgspice,
  terminateNgspiceWorker,
} from './spice/client';
import { exportSpiceOpNetlist, type ButtonPressedState } from './spice/netlistExport';

export type { DcSolveResult };
export {
  findGroundNetId,
  hasStandaloneCircuit,
  netLevelsFromDc,
  netVoltageToLevel,
  LED_ON_RESISTANCE_OHMS,
  getCachedNgspiceDcResult,
  invalidateNgspiceCache,
  commitNgspiceNodeIc,
  takeNgspiceWaveform,
  abortNgspiceInFlight,
  lookupSpiceWaveCache,
  putSpiceWaveCache,
  prepareIcForSpiceWaveFill,
  circuitKeyFromSolveSig,
  spiceWaveKindFromSolveSig,
  terminateNgspiceWorker,
};

/**
 * DC operating point — prefers cached ngspice .OP/.tran; falls back to legacy MNA.
 * Call {@link refreshDcOperatingPoint} each sim frame to update ngspice cache.
 */
export function solveDcCircuit(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs = 0,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
): DcSolveResult | null {
  const cached = getCachedNgspiceDcResult(
    components,
    netlist,
    simTimeMs,
    resistorBlown,
    ledBlown,
    buttonPressed,
    mcuSources,
    capacitorBlown,
  );
  if (cached) return cached;
  return solveDcCircuitLegacy(
    components,
    netlist,
    simTimeMs,
    resistorBlown,
    ledBlown,
    buttonPressed,
    mcuSources,
  );
}
/** Async ngspice .OP / stepped .tran (Web Worker). Updates cache used by {@link solveDcCircuit}. */
export async function refreshDcOperatingPoint(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs = 0,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
): Promise<{ result: DcSolveResult | null; backend: 'ngspice' | 'legacy' }> {
  const canUseNgspice =
    exportSpiceOpNetlist(
      components,
      netlist,
      simTimeMs,
      null,
      resistorBlown,
      ledBlown,
      {},
      buttonPressed,
      mcuSources,
      capacitorBlown,
    ) !== null;
  if (canUseNgspice) {
    const spice = await solveDcWithNgspice(
      components,
      netlist,
      simTimeMs,
      resistorBlown,
      ledBlown,
      buttonPressed,
      mcuSources,
      capacitorBlown,
    );
    if (spice) return { result: spice, backend: 'ngspice' };
  }
  const legacy = solveDcCircuitLegacy(
    components,
    netlist,
    simTimeMs,
    resistorBlown,
    ledBlown,
    buttonPressed,
    mcuSources,
  );
  return { result: legacy, backend: 'legacy' };
}
/** True when the canvas netlist can be exported for ngspice .OP / .tran. */
export function canUseNgspiceOp(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs = 0,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
): boolean {
  return (
    exportSpiceOpNetlist(
      components,
      netlist,
      simTimeMs,
      null,
      resistorBlown,
      ledBlown,
      {},
      buttonPressed,
      mcuSources,
      capacitorBlown,
    ) !== null
  );
}

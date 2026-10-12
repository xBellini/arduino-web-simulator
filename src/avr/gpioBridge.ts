/**
 * What: MCU↔breadboard coupling layer — owns {@link GpioBridge} lifecycle and the per-frame
 * sync that keeps avr8js ports aligned with {@link solveCircuit} net levels.
 *
 * Owns/exports: `GpioBridge`, `createGpioBridge`, `createCircuitBridge`, `readMcuSources`,
 * `syncMcuWithNets`, `syncCircuitOnly`, plus re-exports of solver helpers for UI.
 *
 * Conventions: Rebuild netlist only when components/wires change (factories); pass the same
 * `simState`/`simFlags` each tick. MCU drives use {@link McuSourceMap} (net id → volts);
 * input pins are updated from resolved `NetLevel` after each solve.
 *
 * To add a new MCU-driven net source, extend `readMcuSources` / board rail merge so the net
 * id and voltage appear in `lastMcuSources` before `solveCircuit`.
 * To run bench-only sim (no AVR), use `createCircuitBridge` and `syncCircuitOnly`.
 * To expose another solver helper to React, add a named re-export at the file bottom (avoid
 * importing `circuit/solver.ts` from UI when this facade already covers it).
 *
 * Not here: Netlist union-find, DC `.OP`, or AVR instruction stepping — see circuit/netlist.ts,
 * circuit/dcSolver.ts, avr/runner.ts.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/sim/gpioBridge.ts` (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

import { PinState as AvrPinState, type AVRIOPort } from 'avr8js';
import type { PlacedComponent, PinState, Wire } from '../types';
import {
  boardPowerSources,
  buildCircuitNetlist,
  netForPin,
  netLevelToSourceVolts,
  type CircuitNetlist,
  type McuSourceMap,
  type NetLevel,
} from '../circuit/netlist';
import {
  createComponentSimFlags,
  createCircuitSimState,
  pinStatesFromNetLevels,
  solveCircuit,
  type CircuitSimState,
  type ComponentSimFlags,
} from '../circuit/solver';
import type { DcSolveResult } from '../circuit/mnaLegacy';
import { ARDUINO_DIGITAL_PIN_MAP, type AvrPortName } from './pinMap';

export interface GpioBridge {
  netlist: CircuitNetlist;
  wires: Wire[];
  ports: Record<AvrPortName, AVRIOPort>;
  simState: CircuitSimState;
  simFlags: ComponentSimFlags;
  /** Last MCU source map (board rails + GPIO outputs) used for the DC solve. */
  lastMcuSources: McuSourceMap;
}

export function createGpioBridge(
  components: PlacedComponent[],
  wires: Wire[],
  ports: Record<AvrPortName, AVRIOPort>,
): GpioBridge {
  return {
    netlist: buildCircuitNetlist(components, wires),
    wires,
    ports,
    simState: createCircuitSimState(),
    simFlags: createComponentSimFlags(),
    lastMcuSources: new Map(),
  };
}

/** Circuit bridge without AVR ports (bench supply + passives). */
export function createCircuitBridge(
  components: PlacedComponent[],
  wires: Wire[],
): GpioBridge {
  const dummyPort = {} as AVRIOPort;
  return {
    netlist: buildCircuitNetlist(components, wires),
    wires,
    ports: { B: dummyPort, C: dummyPort, D: dummyPort },
    simState: createCircuitSimState(),
    simFlags: createComponentSimFlags(),
    lastMcuSources: new Map(),
  };
}

function readPortPin(port: AVRIOPort, bit: number): NetLevel {
  const state = port.pinState(bit);
  if (state === AvrPinState.High) return 'high';
  if (state === AvrPinState.Low) return 'low';
  return 'floating';
}

function writePortPin(port: AVRIOPort, bit: number, level: NetLevel): void {
  if (level === 'high') port.setPin(bit, true);
  else if (level === 'low') port.setPin(bit, false);
}

function mcuOutputDrives(
  bridge: GpioBridge,
  mcu: PlacedComponent,
): Map<number, NetLevel> {
  const drives = new Map<number, NetLevel>();
  const { netlist, ports } = bridge;

  for (const [pinId, mapping] of Object.entries(ARDUINO_DIGITAL_PIN_MAP)) {
    const netId = netForPin(netlist, { componentId: mcu.id, pinId });
    if (netId === null) continue;
    const port = ports[mapping.port];
    const pinReg = port.pinState(mapping.bit);
    if (pinReg !== AvrPinState.Input && pinReg !== AvrPinState.InputPullUp) {
      const out = readPortPin(port, mapping.bit);
      if (out === 'high' || out === 'low') drives.set(netId, out);
    }
  }

  return drives;
}

/**
 * Combined ideal MCU source map for the DC solve: board power/ground rails plus
 * every GPIO pin currently driving high/low (5V / 0V). Board rails win on the
 * rare overlap so a pin configured as output on a power pin can't fight a rail.
 */
function combineMcuSources(
  netlist: CircuitNetlist,
  mcu: PlacedComponent,
  drives: Map<number, NetLevel>,
): McuSourceMap {
  const sources = boardPowerSources([mcu], netlist);
  for (const [netId, level] of drives) {
    if (!sources.has(netId)) sources.set(netId, netLevelToSourceVolts(level));
  }
  return sources;
}

/** Current MCU source map (board rails + live GPIO outputs) for the async solve. */
export function computeMcuSources(
  bridge: GpioBridge,
  mcu: PlacedComponent,
): McuSourceMap {
  return combineMcuSources(bridge.netlist, mcu, mcuOutputDrives(bridge, mcu));
}

/** Run circuit solver and sync MCU inputs from resolved nets. */
export function syncMcuWithNets(
  bridge: GpioBridge,
  mcu: PlacedComponent,
  components: PlacedComponent[],
  buttonPressed: Record<string, boolean>,
  simTimeMs: number,
  dcResult?: DcSolveResult | null,
): Map<number, NetLevel> {
  const { netlist, ports, simState } = bridge;
  bridge.simFlags = createComponentSimFlags();

  const mcuDrives = mcuOutputDrives(bridge, mcu);
  const mcuSources = combineMcuSources(netlist, mcu, mcuDrives);
  bridge.lastMcuSources = mcuSources;
  const levels = solveCircuit(
    components,
    bridge.wires,
    netlist,
    mcuDrives,
    buttonPressed,
    simState,
    simTimeMs,
    bridge.simFlags,
    dcResult,
    mcuSources,
  );

  for (const [pinId, mapping] of Object.entries(ARDUINO_DIGITAL_PIN_MAP)) {
    const netId = netForPin(netlist, { componentId: mcu.id, pinId });
    if (netId === null) continue;
    const port = ports[mapping.port];
    const pinReg = port.pinState(mapping.bit);
    if (pinReg === AvrPinState.Input || pinReg === AvrPinState.InputPullUp) {
      const netLevel = levels.get(netId);
      if (pinReg === AvrPinState.InputPullUp) {
        writePortPin(port, mapping.bit, netLevel === 'low' ? 'low' : 'high');
      } else if (netLevel === 'high' || netLevel === 'low') {
        writePortPin(port, mapping.bit, netLevel);
      }
    }
  }

  return levels;
}

/** Run circuit solve without syncing MCU GPIO (standalone passives). */
export function syncCircuitOnly(
  bridge: GpioBridge,
  components: PlacedComponent[],
  buttonPressed: Record<string, boolean>,
  simTimeMs: number,
  dcResult?: DcSolveResult | null,
): Map<number, NetLevel> {
  bridge.simFlags = createComponentSimFlags();
  const levels = solveCircuit(
    components,
    bridge.wires,
    bridge.netlist,
    new Map(),
    buttonPressed,
    bridge.simState,
    simTimeMs,
    bridge.simFlags,
    dcResult,
  );
  return levels;
}

export function pinStatesFromNets(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  netLevels: Map<number, NetLevel>,
): Record<string, Record<string, PinState>> {
  return pinStatesFromNetLevels(components, netlist, netLevels);
}

export {
  createComponentSimFlags,
} from '../circuit/solver';
export type { ComponentSimFlags, CircuitSimState } from '../circuit/solver';

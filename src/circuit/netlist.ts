/**
 * What: Electrical connectivity — union-find nets from wires, pins, breadboard tie strips,
 * and MCU board copper (GND/5V/3.3V header shorts).
 *
 * Owns/exports: `NetLevel`, `CircuitNetlist`, `PinEndpoint`, `buildCircuitNetlist`,
 * `netForPin`, `baseNetLevels`, `boardPowerSources`, `netLevelToSourceVolts`, `McuSourceMap`.
 *
 * Conventions: Pin keys are `componentId:pinId`. Rebuild netlist when topology changes, not
 * every sim tick. `NetLevel` is digital abstraction; DC volts live on `DcSolveResult`. MCU board
 * detection uses {@link isMcuBoard}. Arduino GND pins (and same-voltage power taps) are shorted
 * like real PCB copper so SPICE sees one ground node — not one Vmcu per GND header pin.
 *
 * To connect a new pin type into nets, ensure registry pins exist and wires attach; for
 * breadboard-only ties, use `tiePinId` from breadboardGrid in the builder.
 * To seed a net as high/low before solve, extend `baseNetLevels` / power pin detection in
 * `getDefinition` pin types.
 * To add a fixed rail source for DC, extend `boardPowerSources` and MCU map builders consistently
 * with gpioBridge.
 *
 * Not here: Solving voltages or SPICE node naming — see circuit/dcSolver.ts and spice/netlistExport.
 *
 * Changelog:
 * - 09-10-2026 — Apply `PartModule.internalPinShorts` (duplicate module headers)
 * - 09-10-2026 ? Moved from `src/sim/circuitNetlist.ts` (tree reorganization)
 * - 28-09-2026 — MCU board copper: short all GND pins together and identical power rails (5V/3.3V)
 * - 17-09-2026 — Unwired pin nets come from `PartModule.ensurePins` instead of a button-only loop
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

import type { PinRef, PlacedComponent, Wire } from '../types';
import { getDefinition } from '../registry/components';
import { getPartModule } from '../components';
import {
  BB_COLS,
  BB_ROWS,
  BB_ROWS_PER_BAND,
  tiePinId,
} from '../registry/breadboardGrid';
import { isMcuBoard } from '../avr/pinMap';

export type NetLevel = 'low' | 'high' | 'floating';

/** Logic-high rail voltage for ideal digital MCU sources. */
export const LOGIC_HIGH_VOLTS = 5;

/** Net id → forced voltage (V) for ideal MCU sources (board rails + GPIO outputs). */
export type McuSourceMap = Map<number, number>;

export interface PinEndpoint {
  componentId: string;
  pinId: string;
  componentType: string;
}

/** Voltage an MCU board power/ground pin supplies, or null if it is not a source. */
function mcuBoardPinVolts(pinId: string, pinType: string): number | null {
  if (pinType === 'ground') return 0;
  if (pinType === 'power') {
    if (pinId === 'v5' || pinId === '5v') return LOGIC_HIGH_VOLTS;
    if (pinId === 'v33' || pinId === '3v3') return 3.3;
    return null; // vin and other rails are inputs, not sources we provide
  }
  return null;
}

class UnionFind {
  private parent = new Map<number, number>();

  makeSet(x: number): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  find(x: number): number {
    const p = this.parent.get(x);
    if (p === undefined) return x;
    if (p !== x) {
      const root = this.find(p);
      this.parent.set(x, root);
      return root;
    }
    return x;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function pinKey(ref: PinRef): string {
  return `${ref.componentId}:${ref.pinId}`;
}

export interface CircuitNetlist {
  /** pinKey → net id */
  pinToNet: Map<string, number>;
  /** net id → connected endpoints */
  nets: Map<number, PinEndpoint[]>;
  /** First Arduino board in the circuit, if any */
  mcu: PlacedComponent | null;
}

/** Breadboard tie strips (a–e, f–j per column) and continuous power rails. */
function applyBreadboardInternalUnions(
  uf: UnionFind,
  indexFor: (ref: PinRef) => number,
  breadboardId: string,
): void {
  for (const prefix of ['tp', 'tn', 'bp', 'bn'] as const) {
    for (let i = 1; i < BB_COLS; i++) {
      uf.union(
        indexFor({ componentId: breadboardId, pinId: `${prefix}${i - 1}` }),
        indexFor({ componentId: breadboardId, pinId: `${prefix}${i}` }),
      );
    }
  }

  for (let c = 0; c < BB_COLS; c++) {
    for (let r = 1; r < BB_ROWS_PER_BAND; r++) {
      uf.union(
        indexFor({ componentId: breadboardId, pinId: tiePinId(r - 1, c) }),
        indexFor({ componentId: breadboardId, pinId: tiePinId(r, c) }),
      );
    }
    for (let r = BB_ROWS_PER_BAND + 1; r < BB_ROWS; r++) {
      uf.union(
        indexFor({ componentId: breadboardId, pinId: tiePinId(r - 1, c) }),
        indexFor({ componentId: breadboardId, pinId: tiePinId(r, c) }),
      );
    }
  }
}

/**
 * Arduino PCB copper: all GND header pins are one node; all 5V taps share a rail;
 * all 3.3V taps share a rail. Without this, each GND pin is a separate net with its
 * own 0 V Vmcu — wire mA on LED cathode vs cap− diverge even though both are GND.
 */
function applyMcuBoardInternalUnions(
  uf: UnionFind,
  indexFor: (ref: PinRef) => number,
  mcu: PlacedComponent,
): void {
  const def = getDefinition(mcu.type);
  const groundPinIds: string[] = [];
  const rail5PinIds: string[] = [];
  const rail33PinIds: string[] = [];
  for (const pin of def.pins) {
    if (pin.type === 'ground') groundPinIds.push(pin.id);
    else if (pin.type === 'power') {
      const volts = mcuBoardPinVolts(pin.id, pin.type);
      if (volts === LOGIC_HIGH_VOLTS) rail5PinIds.push(pin.id);
      else if (volts === 3.3) rail33PinIds.push(pin.id);
    }
  }
  const shortGroup = (pinIds: string[]) => {
    for (let i = 1; i < pinIds.length; i++) {
      uf.union(
        indexFor({ componentId: mcu.id, pinId: pinIds[0]! }),
        indexFor({ componentId: mcu.id, pinId: pinIds[i]! }),
      );
    }
  };
  shortGroup(groundPinIds);
  shortGroup(rail5PinIds);
  shortGroup(rail33PinIds);
}

export function buildCircuitNetlist(
  components: PlacedComponent[],
  wires: Wire[],
): CircuitNetlist {
  const compById = new Map(components.map((c) => [c.id, c]));
  const uf = new UnionFind();
  const keyToIndex = new Map<string, number>();
  let nextIndex = 0;

  const indexFor = (ref: PinRef): number => {
    const key = pinKey(ref);
    let idx = keyToIndex.get(key);
    if (idx === undefined) {
      idx = nextIndex++;
      keyToIndex.set(key, idx);
      uf.makeSet(idx);
    }
    return idx;
  };

  for (const wire of wires) {
    uf.union(indexFor(wire.from), indexFor(wire.to));
  }

  for (const comp of components) {
    if (comp.type === 'breadboard') {
      applyBreadboardInternalUnions(uf, indexFor, comp.id);
    }
    if (isMcuBoard(comp.type)) {
      applyMcuBoardInternalUnions(uf, indexFor, comp);
    }
    const shorts = getPartModule(comp.type)?.internalPinShorts;
    if (shorts) {
      for (const [a, b] of shorts) {
        uf.union(
          indexFor({ componentId: comp.id, pinId: a }),
          indexFor({ componentId: comp.id, pinId: b }),
        );
      }
    }
  }

  // Parts that need unwired pins as nets (button legs) declare `ensurePins` on their module.
  for (const comp of components) {
    const pins = getPartModule(comp.type)?.ensurePins;
    if (!pins) continue;
    for (const pinId of pins) {
      indexFor({ componentId: comp.id, pinId });
    }
  }

  const pinToNet = new Map<string, number>();
  const nets = new Map<number, PinEndpoint[]>();

  for (const [key, idx] of keyToIndex) {
    const netId = uf.find(idx);
    pinToNet.set(key, netId);
    const [componentId, pinId] = key.split(':');
    const comp = compById.get(componentId);
    if (!comp) continue;
    const list = nets.get(netId) ?? [];
    list.push({ componentId, pinId, componentType: comp.type });
    nets.set(netId, list);
  }

  const mcu = components.find((c) => isMcuBoard(c.type)) ?? null;

  return { pinToNet, nets, mcu };
}

export function netForPin(
  netlist: CircuitNetlist,
  ref: PinRef,
): number | null {
  return netlist.pinToNet.get(pinKey(ref)) ?? null;
}

/** Tie power/ground rails on a net to fixed levels. */
export function baseNetLevels(netlist: CircuitNetlist): Map<number, NetLevel> {
  const levels = new Map<number, NetLevel>();
  for (const [netId, endpoints] of netlist.nets) {
    for (const ep of endpoints) {
      const def = getDefinition(ep.componentType);
      const pin = def.pins.find((p) => p.id === ep.pinId);
      if (!pin) continue;
      if (pin.type === 'ground') levels.set(netId, 'low');
      if (pin.type === 'power') levels.set(netId, 'high');
    }
  }
  return levels;
}

/** Map an MCU logic level to its ideal source voltage. */
export function netLevelToSourceVolts(level: NetLevel): number {
  return level === 'high' ? LOGIC_HIGH_VOLTS : 0;
}

/**
 * Fixed source voltages contributed by an MCU board's power/ground pins
 * (5V/3V3 rails and GND). Only Arduino boards inject these — passive parts with
 * VCC/GND pins (LCDs, etc.) are loads, not sources.
 */
export function boardPowerSources(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
): McuSourceMap {
  const sources: McuSourceMap = new Map();
  for (const comp of components) {
    if (!isMcuBoard(comp.type)) continue;
    const def = getDefinition(comp.type);
    for (const pin of def.pins) {
      const volts = mcuBoardPinVolts(pin.id, pin.type);
      if (volts === null) continue;
      const netId = netForPin(netlist, { componentId: comp.id, pinId: pin.id });
      if (netId !== null && !sources.has(netId)) sources.set(netId, volts);
    }
  }
  return sources;
}

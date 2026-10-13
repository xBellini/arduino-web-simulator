/**
 * What: Mixed-signal orchestrator — merges DC results, digital propagation, dynamics, visuals,
 * and wire currents each tick.
 *
 * Owns/exports: `CircuitSimState`, `ComponentSimFlags`, `createCircuitSimState`,
 * `createComponentSimFlags`, `solveCircuit`, `pinStatesFromNetLevels`, `estimateNetCurrentMa`.
 *
 * Conventions: Callers pass persistent `simState`; fresh `simFlags` each frame is typical.
 * `solveCircuit` expects optional `DcSolveResult` / precomputed net voltages; triggers ngspice
 * refresh via circuit/dcSolver.ts when wired from gpioBridge. Logic threshold ~2.5 V @ 5 V supply.
 *
 * To add a new interactive part, implement the hooks on its `src/components/<type>` module
 * (`netUnions`, `evaluate`, `publishState`, …) and register it in `src/components/index.ts`.
 * To add passive dynamics (e.g. new RC), extend `CircuitSimState` if new time-integrated
 * fields are needed, then advance them in the part's `publishState`.
 * To expose a new UI readout, add a field on `ComponentSimFlags` and write it from the
 * part's `visuals` or `readings` hook.
 *
 * Not here: AVR port sync or HEX load — see gpioBridge and avr/runner.ts.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | Merged static/dynamic union passes into `applyUnions`; part module dispatch added for unions, evaluate, DC-result seeding, and state publishing
#                     | Deleted leftover per-type arms; every simulating part dispatches via its module
#                     | Prefer a caller-supplied DC result so the frame loop can skip a second MNA
# 09-10-2026 | Cursor | Moved from `src/sim/circuitSolver.ts` (tree reorganization)
 */


import { getDefinition } from '../registry/components';
import type { PlacedComponent, PinState } from '../types';
import {
  baseNetLevels,
  netForPin,
  type CircuitNetlist,
  type McuSourceMap,
  type NetLevel,
} from './netlist';
import { updateComponentVisuals } from './visuals';
import { buildNetBranchCurrentMa, resistorCurrentMa } from './currents';
import { updateWireCurrents } from './currents';
import {
  getCachedNgspiceDcResult,
  invalidateNgspiceCache,
  netLevelsFromDc,
  solveDcCircuit,
} from './dcSolver';
import { solveDcCircuitLegacy } from './mnaLegacy';
import type { DcSolveResult } from './mnaLegacy';
import type { Wire } from '../types';
import { getPartModule } from '../components';
import { syncCapacitorStateFromDc } from '../components/passives/capacitor';

const SUPPLY_V = 5;
const LOGIC_THRESHOLD = SUPPLY_V / 2;

export interface CircuitSimState {
  potPositions: Record<string, number>;
  capacitorCharge: Record<string, number>;
  /** Signed terminal voltage (V) from last SPICE solve. */
  capacitorTerminalV: Record<string, number>;
  /** |I| from SPICE branch (mA) for wire animation. */
  capacitorCurrentMa: Record<string, number>;
  /** Reverse / overvoltage failure latch (polarized + ceramic). */
  capacitorBlown: Record<string, boolean>;
  /** Accumulated ms above voltage rating before latch. */
  capacitorOverVoltageMs: Record<string, number>;
  lastSimTimeMs: number;
  ledBlown: Record<string, boolean>;
  ledOvercurrentMs: Record<string, number>;
  resistorBlown: Record<string, boolean>;
  resistorOverPowerMs: Record<string, number>;
  lastVisualMs: number;
  /**
   * Live MCU net→volts (string keys) for LED drive-source while ngspice is in flight.
   * Not physics — bridge only so GPIO ON/OFF is not stuck on the last SPICE sample.
   */
  mcuSourceVolts?: Record<string, number>;
}

export function createCircuitSimState(): CircuitSimState {
  return {
    potPositions: {},
    capacitorCharge: {},
    capacitorTerminalV: {},
    capacitorCurrentMa: {},
    capacitorBlown: {},
    capacitorOverVoltageMs: {},
    lastSimTimeMs: 0,
    ledBlown: {},
    ledOvercurrentMs: {},
    resistorBlown: {},
    resistorOverPowerMs: {},
    lastVisualMs: 0,
  };
}

export interface ComponentSimFlags {
  ledLit: Record<string, boolean>;
  ledBrightness: Record<string, number>;
  ledCurrentMa: Record<string, number>;
  ledBlown: Record<string, boolean>;
  /** RGB LED per-channel on/off (digital; no PWM yet). */
  rgbLedChannels: Record<string, { r: boolean; g: boolean; b: boolean }>;
  diodeConducting: Record<string, boolean>;
  diodeGlowLevel: Record<string, number>;
  transistorOn: Record<string, boolean>;
  mosfetOn: Record<string, boolean>;
  buzzerActive: Record<string, boolean>;
  buzzerLevel: Record<string, number>;
  capacitorCharge: Record<string, number>;
  capacitorBlown: Record<string, boolean>;
  potPositions: Record<string, number>;
  resistorHeatLevel: Record<string, number>;
  resistorOverrated: Record<string, boolean>;
  /** Dissipated power (mW) from I×V / I²R (ngspice branch when available). */
  resistorPowerMw: Record<string, number>;
  resistorBlown: Record<string, boolean>;
  voltmeterReading: Record<string, number>;
  ammeterReading: Record<string, number>;
  ohmmeterReading: Record<string, number | null>;
  ohmmeterDisplay: Record<string, string>;
  oscillatorOutputHigh: Record<string, boolean>;
  /** Power supply in constant-current mode (output voltage sagged). */
  supplyCurrentLimited: Record<string, boolean>;
  /** Actual pos−neg output voltage (V) while sim runs. */
  supplyOutputVoltage: Record<string, number>;
  /** Push button pressed while sim runs (for wire-flow tracing). */
  buttonPressed: Record<string, boolean>;
  wireCurrentMa: Record<string, number>;
  wireFlowReverse: Record<string, boolean>;
}

export function createComponentSimFlags(): ComponentSimFlags {
  return {
    ledLit: {},
    ledBrightness: {},
    ledCurrentMa: {},
    ledBlown: {},
    rgbLedChannels: {},
    diodeConducting: {},
    diodeGlowLevel: {},
    transistorOn: {},
    mosfetOn: {},
    buzzerActive: {},
    buzzerLevel: {},
    capacitorCharge: {},
    capacitorBlown: {},
    potPositions: {},
    resistorHeatLevel: {},
    resistorOverrated: {},
    resistorPowerMw: {},
    resistorBlown: {},
    voltmeterReading: {},
    ammeterReading: {},
    ohmmeterReading: {},
    ohmmeterDisplay: {},
    oscillatorOutputHigh: {},
    supplyCurrentLimited: {},
    supplyOutputVoltage: {},
    buttonPressed: {},
    wireCurrentMa: {},
    wireFlowReverse: {},
  };
}

type DrivePriority = 0 | 1 | 2 | 3;

interface NetDrive {
  level: NetLevel;
  priority: DrivePriority;
}

class NetUnionFind {
  private parent = new Map<number, number>();

  find(x: number): number {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
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

  groups(): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const netId of this.parent.keys()) {
      const root = this.find(netId);
      const list = out.get(root) ?? [];
      list.push(netId);
      out.set(root, list);
    }
    return out;
  }
}

function levelToVoltage(level: NetLevel): number {
  if (level === 'high') return SUPPLY_V;
  if (level === 'low') return 0;
  return LOGIC_THRESHOLD;
}

function voltageToLevel(v: number): NetLevel {
  if (v >= LOGIC_THRESHOLD + 0.05) return 'high';
  if (v <= LOGIC_THRESHOLD - 0.05) return 'low';
  return 'floating';
}

function pinNet(
  netlist: CircuitNetlist,
  componentId: string,
  pinId: string,
): number | null {
  return netForPin(netlist, { componentId, pinId });
}

function netLevel(
  levels: Map<number, NetLevel>,
  netId: number | null,
): NetLevel {
  if (netId === null) return 'floating';
  return levels.get(netId) ?? 'floating';
}

function setDrive(
  drives: Map<number, NetDrive>,
  netId: number | null,
  level: NetLevel,
  priority: DrivePriority,
): void {
  if (netId === null || level === 'floating') return;
  const prev = drives.get(netId);
  if (!prev || priority >= prev.priority) {
    drives.set(netId, { level, priority });
  }
}

/** Net-merge state the dynamic phase reads; ignored during the static phase. */
interface UnionState {
  buttonPressed: Record<string, boolean>;
  transistorOn: Record<string, boolean>;
  mosfetOn: Record<string, boolean>;
  capacitorCharge: Record<string, number>;
}

const STATIC_UNION_STATE: UnionState = {
  buttonPressed: {},
  transistorOn: {},
  mosfetOn: {},
  capacitorCharge: {},
};

/**
 * Merge nets shorted by a component. Called twice per pass: `'static'` before the evaluate
 * step for connections that always exist, `'dynamic'` after it for ones that depend on the
 * levels evaluate just produced (pressed contact, saturated transistor, charged capacitor).
 */
function applyUnions(
  uf: NetUnionFind,
  netlist: CircuitNetlist,
  components: PlacedComponent[],
  phase: 'static' | 'dynamic',
  spiceButtonModel: boolean,
  state: UnionState,
): void {
  for (const comp of components) {
    const id = comp.id;

    getPartModule(comp.type)?.netUnions?.({
      comp,
      netlist,
      phase,
      spiceButtonModel,
      buttonPressed: state.buttonPressed,
      transistorOn: state.transistorOn,
      mosfetOn: state.mosfetOn,
      capacitorCharge: state.capacitorCharge,
      pinNet: (pinId) => pinNet(netlist, id, pinId),
      union: (a, b) => uf.union(a, b),
    });
  }
}

function resolveGroups(
  uf: NetUnionFind,
  drives: Map<number, NetDrive>,
): Map<number, NetLevel> {
  const levels = new Map<number, NetLevel>();
  const groups = uf.groups();

  for (const [, netIds] of groups) {
    let high = 0;
    let low = 0;
    for (const netId of netIds) {
      const drive = drives.get(netId);
      if (!drive || drive.level === 'floating') continue;
      if (drive.level === 'high') high = Math.max(high, drive.priority);
      if (drive.level === 'low') low = Math.max(low, drive.priority);
    }

    let level: NetLevel = 'floating';
    if (high > 0 && low > 0) {
      level = low >= high ? 'low' : 'high';
    } else if (high > 0) {
      level = 'high';
    } else if (low > 0) {
      level = 'low';
    }

    for (const netId of netIds) {
      levels.set(netId, level);
    }
  }

  return levels;
}

function evaluateComponents(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  levels: Map<number, NetLevel>,
  simState: CircuitSimState,
  flags: ComponentSimFlags,
  simTimeMs: number,
  dcLedOn?: Record<string, boolean>,
): Map<number, NetDrive> {
  const drives = new Map<number, NetDrive>();

  for (const [netId, level] of baseNetLevels(netlist)) {
    setDrive(drives, netId, level, 3);
  }

  for (const comp of components) {
    const id = comp.id;

    getPartModule(comp.type)?.evaluate?.({
      comp,
      netlist,
      levels,
      simState,
      flags,
      simTimeMs,
      dcLedOn,
      pinNet: (pinId) => pinNet(netlist, id, pinId),
      netLevel: (netId) => netLevel(levels, netId),
      levelVolts: levelToVoltage,
      voltsToLevel: voltageToLevel,
      drive: (netId, level, priority) => setDrive(drives, netId, level, priority),
    });
  }

  return drives;
}

export function estimateNetCurrentMa(
  netId: number,
  netlist: CircuitNetlist,
  levels: Map<number, NetLevel>,
  components: PlacedComponent[],
  flags: ComponentSimFlags,
  netVoltages?: Map<number, number>,
  branchByNet?: Map<number, number>,
): number {
  const fromBranch = branchByNet?.get(netId);
  if (fromBranch !== undefined && fromBranch > 0) return fromBranch;

  const endpoints = netlist.nets.get(netId) ?? [];
  const compById = new Map(components.map((c) => [c.id, c]));

  for (const ep of endpoints) {
    const comp = compById.get(ep.componentId);
    if (comp?.type !== 'resistor') continue;
    if (flags.resistorBlown?.[comp.id]) continue;
    const na = pinNet(netlist, comp.id, 'a');
    const nb = pinNet(netlist, comp.id, 'b');
    if (na !== netId && nb !== netId) continue;
    const iMa = resistorCurrentMa(netlist, comp, netVoltages, levels);
    if (iMa >= 0.05) return iMa;
  }

  for (const ep of endpoints) {
    const comp = compById.get(ep.componentId);
    if (comp?.type === 'buzzer' && flags.buzzerActive[comp.id]) return 30;
  }

  return 0;
}

function updateInstrumentReadings(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  levels: Map<number, NetLevel>,
  flags: ComponentSimFlags,
  netVoltages?: Map<number, number>,
  branchByNet?: Map<number, number>,
  branchCurrentMa?: Record<string, number>,
): void {
  for (const comp of components) {
    const id = comp.id;

    getPartModule(comp.type)?.readings?.({
      comp,
      components,
      netlist,
      levels,
      flags,
      netVoltages,
      branchCurrentMa,
      pinNet: (pinId) => pinNet(netlist, id, pinId),
      netOfPin: (componentId, pinId) => pinNet(netlist, componentId, pinId),
      netLevel: (netId) => netLevel(levels, netId),
      levelVolts: levelToVoltage,
      netCurrentMa: (netId) =>
        estimateNetCurrentMa(
          netId,
          netlist,
          levels,
          components,
          flags,
          netVoltages,
          branchByNet,
        ),
    });
  }
}

/** Iterative digital circuit solve with passive + active component models. */
export function solveCircuit(
  components: PlacedComponent[],
  wires: Wire[],
  netlist: CircuitNetlist,
  mcuDrives: Map<number, NetLevel>,
  buttonPressed: Record<string, boolean>,
  simState: CircuitSimState,
  simTimeMs: number,
  flags: ComponentSimFlags,
  dcResult?: DcSolveResult | null,
  mcuSources: McuSourceMap = new Map(),
): Map<number, NetLevel> {
  const dc =
    dcResult !== undefined
      ? dcResult
      : (getCachedNgspiceDcResult(
          components,
          netlist,
          simTimeMs,
          simState.resistorBlown,
          simState.ledBlown,
          buttonPressed,
          mcuSources,
          simState.capacitorBlown,
        ) ??
        solveDcCircuit(
          components,
          netlist,
          simTimeMs,
          simState.resistorBlown,
          simState.ledBlown,
          buttonPressed,
          mcuSources,
          simState.capacitorBlown,
        ) ??
        null);
  /** Overlay owns button unions whenever buttons exist (ngspice + legacy stay aligned). */
  const useSpiceButtons = false;
  // Clone maps used by overlays; capacitor state is read back from SPICE V/I.
  const voltages = dc?.netVoltages ? new Map(dc.netVoltages) : undefined;
  const ledConducting = dc?.ledConducting ? { ...dc.ledConducting } : undefined;
  const branchCurrentMa: Record<string, number> = {
    ...(dc?.branchCurrentMa ?? {}),
  };
  syncCapacitorStateFromDc(
    components,
    netlist,
    simState,
    voltages,
    branchCurrentMa,
  );

  flags.buttonPressed = { ...buttonPressed };

  for (const comp of components) {
    getPartModule(comp.type)?.applyDcResult?.({
      comp,
      netlist,
      flags,
      dc,
      pinNet: (pinId) => pinNet(netlist, comp.id, pinId),
    });
  }

  let levels =
    voltages !== undefined
      ? netLevelsFromDc(netlist, voltages)
      : new Map<number, NetLevel>();
  let transistorOn: Record<string, boolean> = {};

  for (let pass = 0; pass < 8; pass++) {
    const uf = new NetUnionFind();
    for (const netId of netlist.nets.keys()) uf.find(netId);
    applyUnions(
      uf,
      netlist,
      components,
      'static',
      useSpiceButtons,
      STATIC_UNION_STATE,
    );

    const drives = evaluateComponents(
      components,
      netlist,
      levels,
      simState,
      flags,
      simTimeMs,
      ledConducting,
    );

    for (const [netId, level] of mcuDrives) {
      setDrive(drives, netId, level, 3);
    }

    applyUnions(uf, netlist, components, 'dynamic', useSpiceButtons, {
      buttonPressed,
      transistorOn: flags.transistorOn,
      mosfetOn: flags.mosfetOn,
      capacitorCharge: simState.capacitorCharge,
    });

    levels = resolveGroups(uf, drives);

    const nextTransistorOn = { ...flags.transistorOn };
    if (
      Object.keys(nextTransistorOn).length === Object.keys(transistorOn).length &&
      Object.entries(nextTransistorOn).every(([k, v]) => transistorOn[k] === v) &&
      pass >= 2
    ) {
      break;
    }
    transistorOn = nextTransistorOn;
  }

  // Computed once so every time-integrating part sees the same step.
  const publishDtMs = Math.max(0, simTimeMs - simState.lastSimTimeMs);
  simState.lastSimTimeMs = simTimeMs;
  for (const comp of components) {
    getPartModule(comp.type)?.publishState?.({
      comp,
      simState,
      flags,
      levels,
      dtMs: publishDtMs,
      pinNet: (pinId) => pinNet(netlist, comp.id, pinId),
      netLevel: (netId) => netLevel(levels, netId),
      levelVolts: levelToVoltage,
    });
  }

  const resistorBlownBefore = { ...simState.resistorBlown };
  const ledBlownBefore = { ...simState.ledBlown };
  const capacitorBlownBefore = { ...simState.capacitorBlown };

  updateComponentVisuals(
    components,
    netlist,
    levels,
    simState,
    flags,
    simTimeMs,
    voltages,
    ledConducting,
    branchCurrentMa,
  );

  let activeVoltages = voltages;
  let activeBranchMa = branchCurrentMa;
  let activeLed = ledConducting;

  // A part that just failed open changes the topology, so the cached DC result is stale.
  const newlyLatched = (
    now: Record<string, boolean>,
    before: Record<string, boolean>,
  ): boolean => Object.keys(now).some((id) => now[id] && !before[id]);
  const circuitOpened =
    newlyLatched(simState.resistorBlown, resistorBlownBefore) ||
    newlyLatched(simState.ledBlown, ledBlownBefore) ||
    newlyLatched(simState.capacitorBlown, capacitorBlownBefore);
  if (circuitOpened) {
    invalidateNgspiceCache();
    const refreshed = solveDcCircuitLegacy(
      components,
      netlist,
      simTimeMs,
      simState.resistorBlown,
      simState.ledBlown,
      buttonPressed,
      mcuSources,
    );
    if (refreshed) {
      activeVoltages = refreshed.netVoltages;
      activeBranchMa = refreshed.branchCurrentMa ?? {};
      activeLed = refreshed.ledConducting;
      levels = netLevelsFromDc(netlist, activeVoltages);
      updateComponentVisuals(
        components,
        netlist,
        levels,
        simState,
        flags,
        simTimeMs,
        activeVoltages,
        activeLed,
        activeBranchMa,
      );
    }
  }

  const branchByNet = buildNetBranchCurrentMa(
    netlist,
    components,
    flags,
    activeVoltages,
    levels,
    activeBranchMa,
  );
  updateInstrumentReadings(
    components,
    netlist,
    levels,
    flags,
    activeVoltages,
    branchByNet,
    activeBranchMa,
  );
  updateWireCurrents(
    wires,
    netlist,
    levels,
    components,
    flags,
    activeVoltages,
    branchByNet,
  );

  if (activeVoltages) {
    levels = netLevelsFromDc(netlist, activeVoltages);
    // Driven MCU output nets keep their logic level even if the DC node sits in
    // the threshold band, so pin colors, wire flow, and digitalRead stay correct.
    for (const [netId, level] of mcuDrives) {
      levels.set(netId, level);
    }
  }

  return levels;
}

export function pinStatesFromNetLevels(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  netLevels: Map<number, NetLevel>,
): Record<string, Record<string, PinState>> {
  const out: Record<string, Record<string, PinState>> = {};
  for (const comp of components) {
    const def = getDefinition(comp.type);
    const states: Record<string, PinState> = {};
    for (const pin of def.pins) {
      const netId = netForPin(netlist, { componentId: comp.id, pinId: pin.id });
      const level =
        netId !== null ? (netLevels.get(netId) ?? 'floating') : 'floating';
      states[pin.id] = level;
    }
    out[comp.id] = states;
  }
  return out;
}

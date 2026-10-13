/**
 * What: Synchronous MNA DC operating-point solver — fallback when ngspice cache misses and
 * inner loop for CC-limited supplies inside `spice/client.ts`.
 *
 * Owns/exports: `DcSolveResult`, `BLOWN_RESISTOR_OHMS`, `LED_ON_RESISTANCE_OHMS`,
 * `findGroundNetId`, `netVoltageToLevel`, `netLevelsFromDc`, `hasStandaloneCircuit`,
 * `solveDcCircuitLegacy`, `solveDcCircuitLegacyOnce`, `ButtonPressedState`.
 *
 * Conventions: Voltages are net id → V vs ground; LED conduction uses Norton + on-resistance;
 * button/contact ohms must stay aligned with `netlistExport` constants. CC supplies iterate
 * via {@link resolveCcVoltageOverrides} from circuit/supplyLimit.ts.
 *
 * To model a new two-terminal part in MNA, implement `legacyStamp` (and
 * `legacyFixedVoltages` / `legacySettleConduction` if needed) on its part module.
 * To change blown/open behavior, reuse `BLOWN_RESISTOR_OHMS` or document a new constant used
 * by both the part's SPICE stamp and its legacy stamp.
 * To add a one-shot solve without CC outer loop, call `solveDcCircuitLegacyOnce` (used when
 * warming ngspice comparisons).
 *
 * Not here: Worker-based ngspice or netlist string generation — see spice/client.ts and
 * spice/netlistExport.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | Part module dispatch for fixed voltages, stamping, and conduction settling
#                     | Deleted leftover stamp/settle/source arms; modules own MNA and standalone detect
# 09-10-2026 | Cursor | Moved from `src/sim/dcCircuitSolverLegacy.ts` (tree reorganization)
# 13-10-2026 | Codex | Return named resistor-branch currents calculated by the legacy solve for wire readouts.
 */


import { getDefinition } from '../registry/components';
import type { PlacedComponent } from '../types';
import type { CircuitNetlist, McuSourceMap } from './netlist';
import { netForPin } from './netlist';
import type { SupplyVoltageOverrides } from './supplyLimit';
import {
  estimateSupplyCurrentMa,
  markSupplyCcMode,
  resolveCcVoltageOverrides,
} from './supplyLimit';
import { getPartModule } from '../components';

// Both constants are owned by the part that defines the model; re-exported here because the
// solvers, the SPICE exporter, and the supply current limiter all reference them.
import { LED_ON_RESISTANCE_OHMS } from '../components/output/led';
export { BLOWN_RESISTOR_OHMS } from '../components/passives/resistor';
export { LED_ON_RESISTANCE_OHMS };

export type ButtonPressedState = Record<string, boolean>;

const DEFAULT_SUPPLY_V = 5;
const LOGIC_THRESHOLD = DEFAULT_SUPPLY_V / 2;

export interface DcSolveResult {
  /** Net id → voltage (V) relative to circuit ground. */
  netVoltages: Map<number, number>;
  /** LED id → conducting */
  ledConducting: Record<string, boolean>;
  /** Component id → |I| in mA (ngspice #branch when available). */
  branchCurrentMa?: Record<string, number>;
  /** Power supply id → constant-current mode active (load hit current limit). */
  supplyCurrentLimited?: Record<string, boolean>;
}

function pinNet(
  netlist: CircuitNetlist,
  componentId: string,
  pinId: string,
): number | null {
  return netForPin(netlist, { componentId, pinId });
}

function isGroundPin(componentType: string, pinId: string): boolean {
  const def = getDefinition(componentType);
  const pin = def.pins.find((p) => p.id === pinId);
  return pin?.type === 'ground';
}

/** Pick a reference net tied to a ground pin (0 V). */
export function findGroundNetId(netlist: CircuitNetlist): number | null {
  for (const [netId, endpoints] of netlist.nets) {
    for (const ep of endpoints) {
      if (isGroundPin(ep.componentType, ep.pinId)) return netId;
    }
  }
  return null;
}

export function netVoltageToLevel(voltage: number): 'low' | 'high' | 'floating' {
  if (voltage >= LOGIC_THRESHOLD + 0.05) return 'high';
  if (voltage <= LOGIC_THRESHOLD - 0.05) return 'low';
  return 'floating';
}

function collectFixedVoltages(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs: number,
  supplyVoltageOverrides: SupplyVoltageOverrides = {},
  mcuSources: McuSourceMap = new Map(),
): Map<number, number> {
  const fixed = new Map<number, number>();
  const ground = findGroundNetId(netlist);
  if (ground !== null) fixed.set(ground, 0);

  for (const comp of components) {
    const mod = getPartModule(comp.type);
    if (mod) {
      mod.legacyFixedVoltages?.({
        comp,
        netlist,
        simTimeMs,
        supplyVoltageOverrides,
        pinNet: (pinId) => pinNet(netlist, comp.id, pinId),
        setFixed: (netId, volts) => fixed.set(netId, volts),
        hasFixed: (netId) => fixed.has(netId),
      });
    }
  }

  // MCU board rails + GPIO outputs as ideal sources; bench supply/osc keep priority.
  for (const [netId, volts] of mcuSources) {
    if (!fixed.has(netId)) fixed.set(netId, volts);
  }

  return fixed;
}

function stampResistor(
  g: Float64Array,
  n: number,
  idx: Map<number, number>,
  fixed: Map<number, number>,
  rhs: Float64Array,
  na: number,
  nb: number,
  ohms: number,
): void {
  const conductance = 1 / ohms;
  const ia = idx.get(na);
  const ib = idx.get(nb);
  const fa = fixed.get(na);
  const fb = fixed.get(nb);

  if (ia !== undefined && ib !== undefined) {
    g[ia * n + ia] += conductance;
    g[ib * n + ib] += conductance;
    g[ia * n + ib] -= conductance;
    g[ib * n + ia] -= conductance;
  } else if (ia !== undefined && fb !== undefined) {
    g[ia * n + ia] += conductance;
    rhs[ia] += conductance * fb;
  } else if (ib !== undefined && fa !== undefined) {
    g[ib * n + ib] += conductance;
    rhs[ib] += conductance * fa;
  }
}

/** Norton equivalent of Vf + R_on in series (LED on). */
function stampLedOn(
  g: Float64Array,
  n: number,
  idx: Map<number, number>,
  fixed: Map<number, number>,
  rhs: Float64Array,
  anode: number,
  cathode: number,
  vf: number,
): void {
  const conductance = 1 / LED_ON_RESISTANCE_OHMS;
  stampResistor(g, n, idx, fixed, rhs, anode, cathode, LED_ON_RESISTANCE_OHMS);
  const ia = idx.get(anode);
  const ic = idx.get(cathode);
  const fc = fixed.get(cathode);
  const fa = fixed.get(anode);

  if (ia !== undefined) {
    rhs[ia] += conductance * vf;
  } else if (fa !== undefined && ic !== undefined) {
    rhs[ic] -= conductance * fa;
  }
  if (ic !== undefined && fc === undefined) {
    rhs[ic] -= conductance * vf;
  } else if (fc !== undefined && ia !== undefined) {
    rhs[ia] += conductance * fc;
  }
}

function solveConductanceMatrix(
  g: Float64Array,
  rhs: Float64Array,
  n: number,
): Float64Array | null {
  const a = new Float64Array(n * n);
  const b = new Float64Array(n);
  a.set(g);
  b.set(rhs);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(a[pivot * n + col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(a[row * n + col]);
      if (v > best) {
        best = v;
        pivot = row;
      }
    }
    if (best < 1e-12) return null;

    if (pivot !== col) {
      for (let k = col; k < n; k++) {
        const tmp = a[col * n + k];
        a[col * n + k] = a[pivot * n + k];
        a[pivot * n + k] = tmp;
      }
      const tb = b[col];
      b[col] = b[pivot];
      b[pivot] = tb;
    }

    const div = a[col * n + col];
    for (let k = col; k < n; k++) a[col * n + k] /= div;
    b[col] /= div;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row * n + col];
      if (Math.abs(factor) < 1e-15) continue;
      for (let k = col; k < n; k++) {
        a[row * n + k] -= factor * a[col * n + k];
      }
      b[row] -= factor * b[col];
    }
  }

  return b;
}

function solveOnce(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  fixed: Map<number, number>,
  ledOn: Record<string, boolean>,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  buttonPressed: ButtonPressedState = {},
  branchCurrents: Record<string, number> = {},
): Map<number, number> | null {
  const netIds = [...netlist.nets.keys()];
  const unknowns = netIds.filter((id) => !fixed.has(id));
  const n = unknowns.length;
  const idx = new Map<number, number>();
  unknowns.forEach((id, i) => idx.set(id, i));

  const measured: { key: string; a: number; b: number; ohms: number }[] = [];
  const g = new Float64Array(n * n);
  const rhs = new Float64Array(n);

  for (const comp of components) {
    const mod = getPartModule(comp.type);
    if (mod) {
      mod.legacyStamp?.({
        comp,
        netlist,
        resistorBlown,
        ledBlown,
        buttonPressed,
        ledOn,
        pinNet: (pinId) => pinNet(netlist, comp.id, pinId),
        stampResistor: (na, nb, ohms, branch) => {
          stampResistor(g, n, idx, fixed, rhs, na, nb, ohms);
          if (branch) measured.push({ key: comp.id + ':' + branch, a: na, b: nb, ohms });
        },
        stampLedOn: (anode, cathode, vf) =>
          stampLedOn(g, n, idx, fixed, rhs, anode, cathode, vf),
      });
    }
  }

  const solution = n === 0 ? new Float64Array(0) : solveConductanceMatrix(g, rhs, n);
  if (!solution) return null;

  const voltages = new Map<number, number>(fixed);
  for (let i = 0; i < unknowns.length; i++) {
    voltages.set(unknowns[i], solution[i]);
  }
  for (const load of measured) {
    const a = voltages.get(load.a), b = voltages.get(load.b);
    if (a !== undefined && b !== undefined)
      branchCurrents[load.key] = Math.abs(a - b) * 1000 / load.ohms;
  }
  return voltages;
}

/**
 * DC nodal analysis for resistors, bench supplies, and LEDs (Norton diode model).
 * Returns null when no ground reference exists.
 */
export function solveDcCircuitLegacyOnce(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs = 0,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  supplyVoltageOverrides: SupplyVoltageOverrides = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
): DcSolveResult | null {
  if (findGroundNetId(netlist) === null) return null;
  const branchCurrentMa: Record<string, number> = {};

  const fixed = collectFixedVoltages(
    components,
    netlist,
    simTimeMs,
    supplyVoltageOverrides,
    mcuSources,
  );
  const ledOn: Record<string, boolean> = {};
  let voltages: Map<number, number> | null = null;

  for (let pass = 0; pass < 12; pass++) {
    voltages = solveOnce(
      components,
      netlist,
      fixed,
      ledOn,
      resistorBlown,
      ledBlown,
      buttonPressed,
      branchCurrentMa,
    );
    if (!voltages) return null;

    let changed = false;
    for (const comp of components) {
      const mod = getPartModule(comp.type);
      if (!mod?.legacySettleConduction) continue;
      const flipped = mod.legacySettleConduction({
        comp,
        netlist,
        voltages,
        ledOn,
        resistorBlown,
        ledBlown,
        buttonPressed,
        pinNet: (pinId) => pinNet(netlist, comp.id, pinId),
      });
      if (flipped) changed = true;
    }
    if (!changed) break;
  }

  if (!voltages) return null;
  return { netVoltages: voltages, ledConducting: ledOn, branchCurrentMa };
}

export function solveDcCircuitLegacy(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs = 0,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
): DcSolveResult | null {
  const cvResult = solveDcCircuitLegacyOnce(
    components,
    netlist,
    simTimeMs,
    resistorBlown,
    ledBlown,
    {},
    buttonPressed,
    mcuSources,
  );
  if (!cvResult) return null;

  const cvBranchCurrentMa: Record<string, number> = {};
  for (const comp of components) {
    if (comp.type !== 'power_supply') continue;
    cvBranchCurrentMa[comp.id] = estimateSupplyCurrentMa(
      comp,
      netlist,
      cvResult.netVoltages,
      components,
      cvResult.ledConducting,
      resistorBlown,
      ledBlown,
    );
  }

  const measureCurrentMa = (compId: string, outputVolts: number) => {
    const probe = solveDcCircuitLegacyOnce(
      components,
      netlist,
      simTimeMs,
      resistorBlown,
      ledBlown,
      { [compId]: outputVolts },
      buttonPressed,
      mcuSources,
    );
    if (!probe) return undefined;
    const comp = components.find((c) => c.id === compId);
    if (!comp) return undefined;
    return estimateSupplyCurrentMa(
      comp,
      netlist,
      probe.netVoltages,
      components,
      probe.ledConducting,
      resistorBlown,
      ledBlown,
    );
  };

  const ccOverrides = resolveCcVoltageOverrides(
    components,
    measureCurrentMa,
    cvBranchCurrentMa,
  );

  if (Object.keys(ccOverrides).length === 0) return cvResult;

  const ccResult = solveDcCircuitLegacyOnce(
    components,
    netlist,
    simTimeMs,
    resistorBlown,
    ledBlown,
    ccOverrides,
    buttonPressed,
    mcuSources,
  );
  if (!ccResult) return cvResult;
  markSupplyCcMode(ccResult, ccOverrides, components);
  return ccResult;
}

export function netLevelsFromDc(
  netlist: CircuitNetlist,
  netVoltages: Map<number, number>,
): Map<number, import('./netlist').NetLevel> {
  const levels = new Map<number, import('./netlist').NetLevel>();
  for (const netId of netlist.nets.keys()) {
    const v = netVoltages.get(netId);
    levels.set(netId, v === undefined ? 'floating' : netVoltageToLevel(v));
  }
  return levels;
}

/** True when the canvas has parts that can simulate without an MCU. */
export function hasStandaloneCircuit(components: PlacedComponent[]): boolean {
  return components.some((c) => getPartModule(c.type)?.standaloneSource);
}

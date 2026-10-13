/**
 * What: Bench PSU constant-current (CC) limiting — estimates load current and backs off
 * output voltage for iterative DC solves.
 *
 * Owns/exports: `SupplyVoltageOverrides`, `supplyCurrentLimitMa`, `supplyOutputVolts`,
 * `estimateSupplySignedAmps`, `estimateSupplyCurrentMa`, `markSupplyCcMode`,
 * `resolveCcVoltageOverrides`, `supplyTerminalVolts`.
 *
 * Conventions: Limit `null` means unlimited (user set 0 mA limit). CC uses fixed bisection
 * passes (`CC_BISECT_PASSES`); overrides are per `power_supply` component id. Terminal volts
 * for digital overlay come from `supplyTerminalVolts` after overrides apply.
 *
 * To include a new load type in CC estimation, extend the neighbor-walk inside
 * `estimateSupplySignedAmps` (mirror legacy LED/resistor paths).
 * To change CC accuracy vs speed, tune `CC_BISECT_PASSES` / `CC_VOLTAGE_EPS` (keep ngspice
 * and legacy callers using the same `resolveCcVoltageOverrides` API).
 * To read effective limit from UI, use `supplyCurrentLimitMa` (not raw component fields).
 *
 * Not here: SPICE V-source deck lines or MNA stamping — see spice/netlistExport and
 * circuit/mnaLegacy.ts.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Moved from `src/sim/supplyCurrentLimit.ts` (tree reorganization)
 */


import type { PlacedComponent } from '../types';
import { supplyCurrentLimitMilliamps, supplyVoltageVolts } from '../values/electric';
import type { CircuitNetlist } from './netlist';
import { netForPin } from './netlist';
import {
  BLOWN_RESISTOR_OHMS,
  LED_ON_RESISTANCE_OHMS,
} from './mnaLegacy';
import {
  DEFAULT_RESISTANCE_UNIT,
  DEFAULT_RESISTANCE_VALUE,
  resistanceToOhms,
} from '../values/resistor';
import {
  DEFAULT_LED_FORWARD_VOLTAGE,
  defaultForwardVoltageForColor,
} from '../values/led';

/** Optional per-supply output voltage (V) for CC backoff solves. */
export type SupplyVoltageOverrides = Record<string, number>;

const CC_BISECT_PASSES = 12;
const CC_VOLTAGE_EPS = 1e-4;

/** Effective limit in mA; `null` when unlimited (limit set to 0). */
export function supplyCurrentLimitMa(comp: PlacedComponent): number | null {
  return supplyCurrentLimitMilliamps(comp);
}

export function supplyOutputVolts(comp: PlacedComponent): number {
  return supplyVoltageVolts(comp);
}

function pinNet(
  netlist: CircuitNetlist,
  componentId: string,
  pinId: string,
): number | null {
  return netForPin(netlist, { componentId, pinId });
}

function componentResistanceOhms(comp: PlacedComponent): number {
  const value = comp.resistanceValue ?? DEFAULT_RESISTANCE_VALUE;
  const unit = comp.resistanceUnit ?? DEFAULT_RESISTANCE_UNIT;
  return Math.max(1, resistanceToOhms(value, unit));
}

function ledForwardVoltage(comp: PlacedComponent): number {
  if (comp.ledForwardVoltage !== undefined) return comp.ledForwardVoltage;
  if (comp.ledColor) return defaultForwardVoltageForColor(comp.ledColor);
  return DEFAULT_LED_FORWARD_VOLTAGE;
}

/** Signed current (A) supplied by a bench PSU from pos → neg. */
export function estimateSupplySignedAmps(
  comp: PlacedComponent,
  netlist: CircuitNetlist,
  voltages: Map<number, number>,
  components: PlacedComponent[],
  ledOn: Record<string, boolean>,
  resistorBlown: Record<string, boolean>,
  ledBlown: Record<string, boolean>,
): number {
  const nPos = pinNet(netlist, comp.id, 'pos');
  if (nPos === null) return 0;
  const vPos = voltages.get(nPos) ?? 0;

  let ampsOut = 0;
  for (const other of components) {
    if (other.type === 'resistor') {
      const na = pinNet(netlist, other.id, 'a');
      const nb = pinNet(netlist, other.id, 'b');
      if (na === null || nb === null) continue;
      const ohms = resistorBlown[other.id]
        ? BLOWN_RESISTOR_OHMS
        : componentResistanceOhms(other);
      if (na === nPos) {
        ampsOut += (vPos - (voltages.get(nb) ?? 0)) / ohms;
      } else if (nb === nPos) {
        ampsOut += (vPos - (voltages.get(na) ?? 0)) / ohms;
      }
      continue;
    }
    if (other.type === 'ammeter') {
      const na = pinNet(netlist, other.id, 'in');
      const nb = pinNet(netlist, other.id, 'out');
      if (na === null || nb === null) continue;
      const ohms = 0.001;
      if (na === nPos) {
        ampsOut += (vPos - (voltages.get(nb) ?? 0)) / ohms;
      } else if (nb === nPos) {
        ampsOut += (vPos - (voltages.get(na) ?? 0)) / ohms;
      }
      continue;
    }
    if (other.type === 'led') {
      const na = pinNet(netlist, other.id, 'anode');
      const nk = pinNet(netlist, other.id, 'cathode');
      if (na === null || nk === null) continue;
      if (ledBlown[other.id]) continue;
      if (na === nPos && ledOn[other.id]) {
        ampsOut += (vPos - ledForwardVoltage(other)) / LED_ON_RESISTANCE_OHMS;
      } else if (nk === nPos && ledOn[other.id]) {
        ampsOut += (vPos - (voltages.get(na) ?? 0)) / LED_ON_RESISTANCE_OHMS;
      }
    }
  }

  return ampsOut;
}

export function estimateSupplyCurrentMa(
  comp: PlacedComponent,
  netlist: CircuitNetlist,
  voltages: Map<number, number>,
  components: PlacedComponent[],
  ledOn: Record<string, boolean>,
  resistorBlown: Record<string, boolean>,
  ledBlown: Record<string, boolean>,
): number {
  return Math.abs(
    estimateSupplySignedAmps(
      comp,
      netlist,
      voltages,
      components,
      ledOn,
      resistorBlown,
      ledBlown,
    ),
  ) * 1000;
}

function supplyBranchCurrentMa(
  comp: PlacedComponent,
  branchCurrentMa?: Record<string, number>,
): number | undefined {
  return branchCurrentMa?.[comp.id];
}

/** True when CV solve draws more than the configured limit. */
export function supplyNeedsCcBackoff(
  comp: PlacedComponent,
  currentMa: number | undefined,
): boolean {
  if (comp.type !== 'power_supply' || comp.supplyEnabled === false) return false;
  const limitMa = supplyCurrentLimitMa(comp);
  if (limitMa === null || currentMa === undefined) return false;
  return currentMa > limitMa + 1e-6;
}

/**
 * Find the highest output voltage in [0, Vset] where supply current <= Ilim.
 * Real CC mode: regulate by sagging voltage, not by injecting a current clamp.
 */
export function bisectCcOutputVoltage(
  comp: PlacedComponent,
  measureCurrentMa: (outputVolts: number) => number | undefined,
): number {
  const vSet = supplyOutputVolts(comp);
  const limitMa = supplyCurrentLimitMa(comp);
  if (limitMa === null) return vSet;

  let lo = 0;
  let hi = vSet;

  for (let pass = 0; pass < CC_BISECT_PASSES; pass++) {
    const mid = (lo + hi) / 2;
    const iMa = measureCurrentMa(mid);
    if (iMa === undefined) {
      hi = mid;
      continue;
    }
    if (iMa > limitMa) hi = mid;
    else lo = mid;
  }

  return lo;
}

export function resolveCcVoltageOverrides(
  components: PlacedComponent[],
  measureCurrentMa: (compId: string, outputVolts: number) => number | undefined,
  cvBranchCurrentMa?: Record<string, number>,
): SupplyVoltageOverrides {
  const overrides: SupplyVoltageOverrides = {};

  for (const comp of components) {
    if (comp.type !== 'power_supply' || comp.supplyEnabled === false) continue;
    const iMa =
      supplyBranchCurrentMa(comp, cvBranchCurrentMa) ??
      measureCurrentMa(comp.id, supplyOutputVolts(comp));
    if (!supplyNeedsCcBackoff(comp, iMa)) continue;

    overrides[comp.id] = bisectCcOutputVoltage(comp, (v) =>
      measureCurrentMa(comp.id, v),
    );
  }

  return overrides;
}

export function markSupplyCcMode(
  result: { supplyCurrentLimited?: Record<string, boolean> },
  overrides: SupplyVoltageOverrides,
  components: PlacedComponent[],
): void {
  const limited: Record<string, boolean> = {};

  for (const comp of components) {
    if (comp.type !== 'power_supply') continue;
    const backedOff = overrides[comp.id];
    if (backedOff === undefined) continue;
    if (backedOff < supplyOutputVolts(comp) - CC_VOLTAGE_EPS) {
      limited[comp.id] = true;
    }
  }

  if (Object.keys(limited).length > 0) {
    result.supplyCurrentLimited = limited;
  }
}

export function supplyTerminalVolts(
  comp: PlacedComponent,
  netlist: CircuitNetlist,
  netVoltages: Map<number, number>,
): number | null {
  const nPos = pinNet(netlist, comp.id, 'pos');
  const nNeg = pinNet(netlist, comp.id, 'neg');
  if (nPos === null || nNeg === null) return null;
  return (netVoltages.get(nPos) ?? 0) - (netVoltages.get(nNeg) ?? 0);
}

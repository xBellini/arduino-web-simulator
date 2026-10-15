/**
 * What: Voltage/current units, conversion, and supply field readers for bench instruments.
 * Role: normalize UI values to volts and mA for simulation and formatters.
 * Owns/exports: unit lists/labels, multipliers, `isVoltageUnit`/`isCurrentUnit`, stepper configs,
 * `supplyVoltageVolts`, `supplyCurrentLimitMa`, and related parsers on `PlacedComponent`.
 * Conventions: stored values stay in the user's chosen unit on the component; readers convert
 * to canonical V / mA; current limit `0` means unlimited; legacy `supplyCurrentLimitMa` still
 * migrates when present.
 * To add a supply field to the UI: extend `PlacedComponent` in `types.ts`, defaults in
 * `SimContext`, validation in `projectFile.ts`, then add conversion here if it needs V or mA.
 * To add a new unit: extend `VoltageUnit`/`CurrentUnit` in `types.ts`, add label, multiplier,
 * stepper entry, and project-file guards.
 * Not-here: instrument SVG layout (`electric.ts`) or DC solver netlists.
 *
 * Merged in from `src/utils/instrumentsGeometry.ts`: Default bench-instrument numbers and readout
 * formatters for the UI. Role: shared defaults + display strings for meters, supply, and oscillator
 * panels. Owns/exports: `DEFAULT_SUPPLY_VOLTAGE`, `DEFAULT_SUPPLY_CURRENT_LIMIT_MA`,
 * `DEFAULT_OSCILLATOR_FREQUENCY_HZ`, `formatVoltage`, `formatCurrentMa`, `formatResistance`.
 * Conventions: non-finite sim values render as `---`; resistance prefers optional display string
 * over auto-scaled ohms; supply limit default is 1 A (1000 mA). To change factory supply/oscillator
 * defaults: edit constants here and align `SimContext` placement + `electric.ts` readers. To
 * add a new instrument readout style: add a formatter here rather than duplicating in components.
 * Not-here: unit conversion (`electric.ts`) or live sim values (`simLiveStore.ts`).
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | [src/utils/instrumentsGeometry.ts] Changelog creation
#                     | [src/utils/instrumentsGeometry.ts] Expanded What with practical how-to notes
#                     | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Merged `src/utils/instrumentsGeometry.ts` into this file (tree reorganization)
#                     | Moved from `src/utils/electricUnits.ts` (tree reorganization)
# 15-10-2026 | Codex | Format small measured currents in microamps/nanoamps instead of rounding them to zero mA.
 */

import type { CurrentUnit, PlacedComponent, VoltageUnit } from '../types';

export const DEFAULT_SUPPLY_VOLTAGE = 5;
/** Default bench supply current limit (1 A). Set limit to 0 for unlimited. */
export const DEFAULT_SUPPLY_CURRENT_LIMIT_MA = 1000;
export const DEFAULT_OSCILLATOR_FREQUENCY_HZ = 1;

export function formatVoltage(v: number): string {
  if (!Number.isFinite(v)) return '---';
  return `${v.toFixed(2)} V`;
}

export function formatCurrentMa(mA: number): string {
  if (!Number.isFinite(mA)) return '---';
  if (mA !== 0 && Math.abs(mA) < 0.001) return `${(mA * 1e6).toFixed(1)} nA`;
  if (mA !== 0 && Math.abs(mA) < 0.1) return `${(mA * 1000).toFixed(1)} µA`;
  if (mA >= 1000) return `${(mA / 1000).toFixed(2)} A`;
  if (mA >= 100) return `${mA.toFixed(0)} mA`;
  if (mA >= 10) return `${mA.toFixed(1)} mA`;
  return `${mA.toFixed(2)} mA`;
}

export function formatResistance(ohms: number | null, display?: string): string {
  if (display) return display;
  if (ohms === null || !Number.isFinite(ohms)) return '---';
  if (ohms >= 1_000_000) return `${(ohms / 1_000_000).toFixed(2)} MΩ`;
  if (ohms >= 1000) return `${(ohms / 1000).toFixed(2)} kΩ`;
  if (ohms >= 100) return `${ohms.toFixed(0)} Ω`;
  if (ohms >= 10) return `${ohms.toFixed(1)} Ω`;
  return `${ohms.toFixed(2)} Ω`;
}

export const VOLTAGE_UNITS: VoltageUnit[] = ['V', 'mV', 'uV'];
export const CURRENT_UNITS: CurrentUnit[] = ['A', 'mA', 'uA'];

export const VOLTAGE_UNIT_LABELS: Record<VoltageUnit, string> = {
  V: 'V',
  mV: 'mV',
  uV: 'µV',
};

export const CURRENT_UNIT_LABELS: Record<CurrentUnit, string> = {
  A: 'A',
  mA: 'mA',
  uA: 'µA',
};

export const DEFAULT_SUPPLY_VOLTAGE_UNIT: VoltageUnit = 'V';
export const DEFAULT_SUPPLY_CURRENT_LIMIT_UNIT: CurrentUnit = 'A';

const VOLTAGE_MULTIPLIER: Record<VoltageUnit, number> = {
  V: 1,
  mV: 1e-3,
  uV: 1e-6,
};

const CURRENT_MULTIPLIER: Record<CurrentUnit, number> = {
  A: 1000,
  mA: 1,
  uA: 1e-3,
};

export interface StepperUnitConfig {
  step: number;
  coarseStep: number;
  decimals: number;
}

export function isVoltageUnit(value: unknown): value is VoltageUnit {
  return value === 'V' || value === 'mV' || value === 'uV';
}

export function isCurrentUnit(value: unknown): value is CurrentUnit {
  return value === 'A' || value === 'mA' || value === 'uA';
}

export function voltageToVolts(value: number, unit: VoltageUnit): number {
  return value * VOLTAGE_MULTIPLIER[unit];
}

export function currentToMilliamps(value: number, unit: CurrentUnit): number {
  return value * CURRENT_MULTIPLIER[unit];
}

export function voltsToUnitValue(volts: number, unit: VoltageUnit): number {
  return volts / VOLTAGE_MULTIPLIER[unit];
}

export function milliampsToUnitValue(mA: number, unit: CurrentUnit): number {
  return mA / CURRENT_MULTIPLIER[unit];
}

export function convertVoltageValue(
  value: number,
  from: VoltageUnit,
  to: VoltageUnit,
): number {
  return voltsToUnitValue(voltageToVolts(value, from), to);
}

export function convertCurrentValue(
  value: number,
  from: CurrentUnit,
  to: CurrentUnit,
): number {
  return milliampsToUnitValue(currentToMilliamps(value, from), to);
}

export function voltageStepConfig(unit: VoltageUnit): StepperUnitConfig {
  switch (unit) {
    case 'mV':
      return { step: 10, coarseStep: 100, decimals: 0 };
    case 'uV':
      return { step: 1000, coarseStep: 10000, decimals: 0 };
    default:
      return { step: 0.1, coarseStep: 1, decimals: 1 };
  }
}

export function currentStepConfig(unit: CurrentUnit): StepperUnitConfig {
  switch (unit) {
    case 'mA':
      return { step: 10, coarseStep: 100, decimals: 0 };
    case 'uA':
      return { step: 1000, coarseStep: 10000, decimals: 0 };
    default:
      return { step: 0.01, coarseStep: 0.1, decimals: 2 };
  }
}

export function supplyVoltageVolts(comp: PlacedComponent): number {
  const value = comp.supplyVoltage ?? DEFAULT_SUPPLY_VOLTAGE;
  const unit = comp.supplyVoltageUnit ?? DEFAULT_SUPPLY_VOLTAGE_UNIT;
  return voltageToVolts(value, unit);
}

/** Effective limit in mA; `null` when unlimited (limit value is 0). */
export function supplyCurrentLimitMilliamps(comp: PlacedComponent): number | null {
  if (comp.type !== 'power_supply') return null;

  if (comp.supplyCurrentLimit !== undefined) {
    if (comp.supplyCurrentLimit === 0) return null;
    const unit = comp.supplyCurrentLimitUnit ?? DEFAULT_SUPPLY_CURRENT_LIMIT_UNIT;
    return currentToMilliamps(comp.supplyCurrentLimit, unit);
  }

  const legacyMa = comp.supplyCurrentLimitMa;
  if (legacyMa === 0) return null;
  if (legacyMa !== undefined && Number.isFinite(legacyMa) && legacyMa > 0) return legacyMa;
  return DEFAULT_SUPPLY_CURRENT_LIMIT_MA;
}

export function parseSupplyNumeric(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * What: Capacitor value defaults, validation, formatting, and farad conversion.
 * Role: single place for allowed units and display strings for ceramic / polarized caps.
 * Owns/exports: `CAPACITANCE_*` lists/defaults, `capacitanceToFarads`, format/parse helpers,
 * `isCapacitanceUnit` for JSON load.
 * Conventions: stored `capacitanceValue` + `capacitanceUnit` on `PlacedComponent`; canonical
 * sim value is farads via `capacitanceToFarads`.
 * To change default new-cap values: adjust `DEFAULT_*` / polarized defaults in part modules.
 * Not-here: charge envelope / overlays — `components/passives/capacitor.tsx` and ComponentOverlays.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/utils/capacitance.ts` (tree reorganization)
 * - 25-09-2026 — Changelog creation; voltage rating defaults
 */
import type { CapacitanceUnit } from '../types';

export const CAPACITANCE_UNITS: CapacitanceUnit[] = ['pF', 'nF', 'uF', 'mF'];

/** Default for ceramic (non-polarized) capacitors. */
export const DEFAULT_CAPACITANCE_VALUE = 100;
export const DEFAULT_CAPACITANCE_UNIT: CapacitanceUnit = 'nF';

/** Default for polarized / electrolytic capacitors. */
export const DEFAULT_POLARIZED_CAPACITANCE_VALUE = 100;
export const DEFAULT_POLARIZED_CAPACITANCE_UNIT: CapacitanceUnit = 'uF';

/** Default voltage ratings (V). */
export const DEFAULT_CAPACITANCE_VOLTAGE_RATING = 50;
export const DEFAULT_POLARIZED_VOLTAGE_RATING = 16;

const UNIT_MULTIPLIER: Record<CapacitanceUnit, number> = {
  pF: 1e-12,
  nF: 1e-9,
  uF: 1e-6,
  mF: 1e-3,
};

export const CAPACITANCE_UNIT_LABELS: Record<CapacitanceUnit, string> = {
  pF: 'pF',
  nF: 'nF',
  uF: 'µF',
  mF: 'mF',
};

export function isCapacitanceUnit(value: unknown): value is CapacitanceUnit {
  return (
    value === 'pF' || value === 'nF' || value === 'uF' || value === 'mF'
  );
}

export interface CapacitorPropertiesPatch {
  capacitanceValue: number;
  capacitanceUnit: CapacitanceUnit;
  capacitanceVoltageRating: number;
}

export function capacitanceToFarads(
  value: number,
  unit: CapacitanceUnit,
): number {
  return value * UNIT_MULTIPLIER[unit];
}

export function formatCapacitanceCompact(
  value: number,
  unit: CapacitanceUnit,
): string {
  const trimmed = Number.isInteger(value) ? String(value) : String(value);
  return `${trimmed}${CAPACITANCE_UNIT_LABELS[unit]}`;
}

/** Parse a numeric capacitance entry (supports decimals). Returns null if invalid. */
export function parseCapacitanceValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

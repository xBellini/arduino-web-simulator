/**
 * What: LED color presets, RGB channel map, defaults, and property parsers.
 * Role: catalog + validation for `led` / `rgb_led` placed fields and sim-facing pin names.
 * Owns/exports: `LED_COLOR_OPTIONS`, `RGB_LED_CHANNELS`, defaults, `isLedColorHex`,
 * `defaultForwardVoltageForColor`, forward V/mA parsers, `LedPropertiesPatch`.
 * Conventions: body color is hex from `LED_COLOR_OPTIONS`; RGB uses `RGB_LED_CHANNELS` anode
 * pin ids with per-channel Vf/If; forward current stored in mA on the component.
 * To add a preset color: append to `LED_COLOR_OPTIONS` with label and default Vf; ensure
 * `isLedColorHex` and project load accept the hex.
 * To change RGB sim behavior: edit `RGB_LED_CHANNELS` pin ids to match registry pins in
 * `components.ts` and gpio/SPICE bridges.
 * Not-here: canvas glow rendering or ngspice diode models — only property metadata here.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Moved from `src/utils/led.ts` (tree reorganization)
 */

export const LED_COLOR_OPTIONS = [
  { hex: '#E53935', label: 'Red', defaultForwardVoltage: 2.0 },
  { hex: '#FB8C00', label: 'Orange', defaultForwardVoltage: 2.1 },
  { hex: '#FDD835', label: 'Yellow', defaultForwardVoltage: 2.0 },
  { hex: '#43A047', label: 'Green', defaultForwardVoltage: 2.1 },
  { hex: '#1E88E5', label: 'Blue', defaultForwardVoltage: 3.2 },
  { hex: '#8E24AA', label: 'Purple', defaultForwardVoltage: 3.2 },
  { hex: '#FF9800', label: 'Amber', defaultForwardVoltage: 2.0 },
  { hex: '#ECEFF1', label: 'White', defaultForwardVoltage: 3.2 },
] as const;

export type LedColorHex = (typeof LED_COLOR_OPTIONS)[number]['hex'];

/**
 * RGB LED (common-cathode) channels. Each colour die is a separate diode from its
 * anode pin to the shared cathode, modelled by ngspice/legacy like a normal LED.
 * Inputs are digital (1/0, no PWM) so conduction is effectively on/off per channel.
 */
export const RGB_LED_CHANNELS = [
  { key: 'r', anodePin: 'red', forwardVoltage: 2.0, forwardCurrentMa: 20 },
  { key: 'g', anodePin: 'green', forwardVoltage: 3.0, forwardCurrentMa: 20 },
  { key: 'b', anodePin: 'blue', forwardVoltage: 3.2, forwardCurrentMa: 20 },
] as const;

export type RgbLedChannelKey = (typeof RGB_LED_CHANNELS)[number]['key'];

export const DEFAULT_LED_COLOR: LedColorHex = '#E53935';
export const DEFAULT_LED_FORWARD_VOLTAGE = 2.0;
export const DEFAULT_LED_FORWARD_CURRENT = 20;
/** Slack under catalog Vf still treated as conducting (SPICE often sits slightly below Vf). */
export const VF_CONDUCT_SLACK_V = 0.25;

export interface LedPropertiesPatch {
  ledColor: LedColorHex;
  ledForwardVoltage: number;
  ledForwardCurrent: number;
}

const LED_COLOR_SET = new Set<string>(
  LED_COLOR_OPTIONS.map((option) => option.hex.toUpperCase()),
);

export function isLedColorHex(value: unknown): value is LedColorHex {
  return typeof value === 'string' && LED_COLOR_SET.has(value.toUpperCase());
}

export function defaultForwardVoltageForColor(hex: string): number {
  const match = LED_COLOR_OPTIONS.find(
    (option) => option.hex.toUpperCase() === hex.toUpperCase(),
  );
  return match?.defaultForwardVoltage ?? DEFAULT_LED_FORWARD_VOLTAGE;
}

export function ledColorLabel(hex: string): string {
  const match = LED_COLOR_OPTIONS.find(
    (option) => option.hex.toUpperCase() === hex.toUpperCase(),
  );
  return match?.label ?? 'Custom';
}

/** Parse forward voltage in volts. */
export function parseForwardVoltage(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > 10) return null;
  return value;
}

/** Parse forward current in milliamps. */
export function parseForwardCurrent(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > 1000) return null;
  return value;
}

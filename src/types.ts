/**
 * What: Shared TypeScript domain schema for the editor, persistence, and simulation.
 * Role: single contract for pins, parts, wires, and viewport — no runtime logic here.
 * Owns/exports: unit enums, `PinDefinition`, `ComponentDefinition`, `ComponentRegistryEntry`,
 * `PlacedComponent`, `Wire` / `WireDraft` / `PinRef`, `Viewport`.
 * Conventions: pin `x`/`y` are component-local px in SVG design space before canvas `scale`;
 * registry entries omit `width`/`height` (filled from SVG viewBox); placed instances use
 * string `type` keys matching `COMPONENT_REGISTRY`.
 * To add a catalog field every part of that kind shares (scale, package, marking, default
 * label), extend `ComponentDefinition` / `ComponentRegistryEntry` in `components.ts`.
 * To add per-instance editable or sim state (value, color, supply setpoints, `partLabel`),
 * extend `PlacedComponent` and wire defaults in `SimContext`, validation in `projectFile.ts`,
 * and UI in the properties panel helpers.
 * To add a new pin kind, extend `PinDefinition['type']` and update pin-type helpers in the
 * registry (e.g. Arduino pin classifiers).
 * Not-here: registry entries, geometry, reducers, or SPICE netlists — only types.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | Package-field example points at `src/parts/ne555.ts`
# 23-09-2026 | Cursor | `scale` optional; package ICs inherit footprint scale unless overridden
# 24-09-2026 | Cursor | Documented `pinLetters` and two-line TO package markings
# 25-09-2026 | Cursor | Pin `label` → `description`; optional `letter`; drop `pinLetters`; `defaultPartLabel` may be a line array
#                     | CapacitanceUnit + capacitanceValue/Unit on PlacedComponent
# 12-10-2026 | Cursor | rtcI2cAddr on PlacedComponent (DS3231 RTC 7-bit Wire address)
# 13-10-2026 | Codex | Add PaletteMetadata for category, order and optional search keywords.
 */
export type PinState = 'low' | 'high' | 'floating';

export type ResistanceUnit = 'ohm' | 'kohm' | 'Mohm';

export type CapacitanceUnit = 'pF' | 'nF' | 'uF' | 'mF';

export type VoltageUnit = 'V' | 'mV' | 'uV';

export type CurrentUnit = 'A' | 'mA' | 'uA';

export type ResistancePowerRating = '1/8W' | '1/4W' | '1/2W' | '1W';

export type ResistanceTolerance =
  | '0.01%'
  | '0.02%'
  | '0.05%'
  | '0.1%'
  | '0.25%'
  | '0.5%'
  | '1%'
  | '2%'
  | '5%'
  | '10%'
  | '20%';

export interface PinDefinition {
  id: string;
  /** Pin hover callout (and casing text when `letter` is omitted). */
  description: string;
  /** Optional molded casing letter for TO packages (else `description`). */
  letter?: string;
  /** Offset from component top-left, in component-local px */
  x: number;
  y: number;
  type: 'digital' | 'power' | 'ground' | 'analog';
}

export interface PaletteMetadata {
  category: 'boards' | 'prototyping' | 'passives' | 'semiconductors' | 'output' | 'input' | 'modules' | 'ics' | 'logic_gates' | 'bare_packages' | 'instruments';
  order: number;
  keywords?: readonly string[];
}

export interface ComponentDefinition {
  palette?: PaletteMetadata;
  type: string;
  label: string;
  /**
   * Design footprint from the SVG viewBox (`viewBox` width × height).
   * Filled by `getDefinition` / `getDesignDefinition` — not set in the registry.
   */
  width: number;
  height: number;
  /**
   * Uniform canvas scale applied to width, height, pins, and hit-bounds.
   * Floats allowed (e.g. `0.75`, `1.5`). Aspect ratio follows the SVG.
   * Omit on a named IC that sets `package` to inherit that footprint's scale
   * (e.g. NE555 → dip8). Set only to override. Non-package parts default to `1`
   * when omitted. Resolved for the canvas by `getDefinitionScale`.
   */
  scale?: number;
  pins: PinDefinition[];
  /**
   * Shared package / footprint id (e.g. `dip8`).
   * Uses that package's SVG for artwork + viewBox size; this part keeps its
   * own `type`, `label`, and `pins`. Canvas scale defaults to the package's
   * scale unless this entry sets `scale`. Example: NE555 in `src/components/modules/ne555.ts`.
   */
  package?: string;
  /**
   * Public URL to part artwork, e.g. `/components/led.svg`.
   * Pin x/y must use the same coordinate space as the SVG viewBox.
   * When omitted and `package` is set, uses `/components/<package>.svg`.
   */
  artwork?: string;
  /**
   * Optional body marking drawn on top of the shared footprint SVG.
   * - `chip` — free-text part name (e.g. NE555 on a DIP8 package; TO parts may use
   *   a line array such as `['2N2222', 'NPN']`)
   * - `value` — derived from component properties (e.g. resistor Ω)
   */
  marking?: 'chip' | 'value';
  /**
   * Default silkscreen when `marking: 'chip'`.
   * String for one line, or a string array (one entry per line on the casing).
   * If omitted but `package` is set, the component `label` is used when placed.
   * On place, arrays are joined with newlines into `PlacedComponent.partLabel`.
   */
  defaultPartLabel?: string | string[];
}

/** Registry entry — size comes from the SVG viewBox, not these fields. */
export type ComponentRegistryEntry = Omit<
  ComponentDefinition,
  'width' | 'height'
>;


export interface PlacedComponent {
  id: string;
  type: string;
  x: number;
  y: number;
  rotation: number;
  pinStates: Record<string, PinState>;
  /** Resistor value (numeric part); only used when type === 'resistor'. */
  resistanceValue?: number;
  resistanceUnit?: ResistanceUnit;
  resistancePowerRating?: ResistancePowerRating;
  resistanceTolerance?: ResistanceTolerance;
  /** Capacitor value (numeric part); ceramic / polarized. */
  capacitanceValue?: number;
  capacitanceUnit?: CapacitanceUnit;
  /** Capacitor voltage rating (V); ceramic / polarized. */
  capacitanceVoltageRating?: number;
  /** LED body color (hex preset); only used when type === 'led'. */
  ledColor?: string;
  /** LED forward voltage in volts. */
  ledForwardVoltage?: number;
  /** LED forward current in milliamps. */
  ledForwardCurrent?: number;
  /** Parallel LCD glass background preset (hex); lcd_16x2 / lcd_20x4. */
  lcdBackgroundColor?: string;
  /** Parallel LCD lit character color preset (hex); lcd_16x2 / lcd_20x4. */
  lcdCharacterColor?: string;
  /** Bench supply output voltage (numeric part); power_supply only. */
  supplyVoltage?: number;
  /** Bench supply voltage unit; power_supply only. */
  supplyVoltageUnit?: VoltageUnit;
  /** Bench supply output enabled; power_supply only. */
  supplyEnabled?: boolean;
  /** Bench supply current limit (numeric part); 0 = unlimited; power_supply only. */
  supplyCurrentLimit?: number;
  /** Bench supply current limit unit; power_supply only. */
  supplyCurrentLimitUnit?: CurrentUnit;
  /** @deprecated Use supplyCurrentLimit + supplyCurrentLimitUnit. Loaded for migration only. */
  supplyCurrentLimitMa?: number;
  /** Signal generator frequency (Hz); oscillator only. */
  oscillatorFrequencyHz?: number;
  /** Signal generator enabled; oscillator only. */
  oscillatorEnabled?: boolean;
  /** SPICE catalog part id (e.g. 1N4148, 2N2222); uses type default from catalog when omitted. */
  spiceModelId?: string;
  /**
   * Silkscreen / body marking for footprint packages (DIP, etc.).
   * Uses the shared type SVG; this text is the per-instance chip name.
   */
  partLabel?: string;
  /**
   * DS3231 RTC 7-bit I2C address (sim knob; real chip is fixed 0x68).
   * Only used when type === 'ds3231_rtc'. Default 0x68.
   */
  rtcI2cAddr?: number;
}

export interface Wire {
  id: string;
  from: PinRef;
  to: PinRef;
  /** Corner points between pins (orthogonal segments) */
  bends: { x: number; y: number }[];
}

export interface WireDraft {
  from: PinRef;
  bends: { x: number; y: number }[];
}

export interface PinRef {
  componentId: string;
  pinId: string;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

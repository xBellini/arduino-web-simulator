/**
 * What: Resistor value defaults, validation, formatting, and ohm conversion.
 * Role: single place for allowed units/tolerances/power ratings and display strings.
 * Owns/exports: `RESISTANCE_*` lists/defaults, `resistanceToOhms`, format/parse helpers,
 * `isResistanceUnit` / `isResistanceTolerance` / `isResistancePowerRating` for JSON load.
 * Conventions: stored `resistanceValue` + `resistanceUnit` on `PlacedComponent`; canonical
 * sim value is ohms via `resistanceToOhms`.
 * To add a tolerance or power rating: extend types in `types.ts`, append to the arrays here,
 * update `projectFile.ts` validation and any color-band mapping in `resistor.ts`.
 * To change default new-resistor value: adjust `DEFAULT_*` constants and mirror stubs in
 * `SimContext`, `Palette.tsx`, and `projectFile.ts` normalization.
 * Not-here: canvas band drawing (uses `resistor.ts`) or registry artwork.
 *
 * Merged in from `src/utils/resistorColorCode.ts`: IEC-style color bands — decode/encode ohms and
 * supply band colors for the resistor SVG. Role: visual bands ↔ `PlacedComponent` resistance
 * fields; pairs with `resistor.ts`. Owns/exports: band color tables, stroke constants,
 * decode/encode helpers, display band arrays. Conventions: canonical math uses ohms from
 * `resistanceToOhms`; ±20% tolerance omits a 4th band; digit colors tuned for contrast on the tan
 * body. To sync UI after property edits: encode value/unit/tolerance to bands for render; on band
 * picker edits, decode back into component fields via exported encoders. To support a new tolerance
 * stripe: extend `ResistanceTolerance` in `types.ts`, map in tolerance color table, and update
 * decode rules if digit count changes. Not-here: registry scale, hitboxes, or SPICE value export
 * (ohms come from `resistor.ts`).
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/utils/resistance.ts` (tree reorganization)
 * - 09-10-2026 — Merged `src/utils/resistorColorCode.ts` into this file (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 * - [src/utils/resistorColorCode.ts] 24-09-2026 — Retuned RESISTOR_BODY / transform for current resistor.svg (~49.5×9.55)
 * - [src/utils/resistorColorCode.ts] 17-09-2026 — Expanded What with practical how-to notes
 * - [src/utils/resistorColorCode.ts] 17-09-2026 — Changelog creation
 */
import type { ResistancePowerRating, ResistanceTolerance, ResistanceUnit } from '../types';

export const RESISTANCE_UNITS: ResistanceUnit[] = ['ohm', 'kohm', 'Mohm'];

export const RESISTANCE_POWER_RATINGS: ResistancePowerRating[] = [
  '1/8W',
  '1/4W',
  '1/2W',
  '1W',
];

export const RESISTANCE_TOLERANCES: ResistanceTolerance[] = [
  '0.01%',
  '0.02%',
  '0.05%',
  '0.1%',
  '0.25%',
  '0.5%',
  '1%',
  '2%',
  '5%',
  '10%',
  '20%',
];

export const DEFAULT_RESISTANCE_VALUE = 1;
export const DEFAULT_RESISTANCE_UNIT: ResistanceUnit = 'kohm';
export const DEFAULT_RESISTANCE_POWER_RATING: ResistancePowerRating = '1/4W';
export const DEFAULT_RESISTANCE_TOLERANCE: ResistanceTolerance = '5%';

const UNIT_MULTIPLIER: Record<ResistanceUnit, number> = {
  ohm: 1,
  kohm: 1_000,
  Mohm: 1_000_000,
};

export const UNIT_LABELS: Record<ResistanceUnit, string> = {
  ohm: 'Ω',
  kohm: 'kΩ',
  Mohm: 'MΩ',
};

export function isResistanceUnit(value: unknown): value is ResistanceUnit {
  return value === 'ohm' || value === 'kohm' || value === 'Mohm';
}

export function isResistancePowerRating(
  value: unknown,
): value is ResistancePowerRating {
  return (
    value === '1/8W' ||
    value === '1/4W' ||
    value === '1/2W' ||
    value === '1W'
  );
}

export function isResistanceTolerance(
  value: unknown,
): value is ResistanceTolerance {
  return RESISTANCE_TOLERANCES.includes(value as ResistanceTolerance);
}

export const TOLERANCE_LABELS: Record<ResistanceTolerance, string> = {
  '0.01%': '±0.01%',
  '0.02%': '±0.02%',
  '0.05%': '±0.05%',
  '0.1%': '±0.1%',
  '0.25%': '±0.25%',
  '0.5%': '±0.5%',
  '1%': '±1%',
  '2%': '±2%',
  '5%': '±5%',
  '10%': '±10%',
  '20%': '±20%',
};

export interface ResistorPropertiesPatch {
  resistanceValue: number;
  resistanceUnit: ResistanceUnit;
  resistancePowerRating: ResistancePowerRating;
  resistanceTolerance: ResistanceTolerance;
}

export function resistanceToOhms(value: number, unit: ResistanceUnit): number {
  return value * UNIT_MULTIPLIER[unit];
}

export function formatResistance(value: number, unit: ResistanceUnit): string {
  const trimmed = Number.isInteger(value) ? String(value) : String(value);
  return `${trimmed} ${UNIT_LABELS[unit]}`;
}

export function formatResistanceCompact(value: number, unit: ResistanceUnit): string {
  const trimmed = Number.isInteger(value) ? String(value) : String(value);
  return `${trimmed}${UNIT_LABELS[unit]}`;
}

/** Parse a numeric resistance entry (supports decimals). Returns null if invalid. */
export function parseResistanceValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Saturated digit / multiplier colors (distinct on the tan resistor body). */
export const DIGIT_BAND_COLORS: Record<number, string> = {
  0: '#0A0A0A', // black
  1: '#6B3400', // brown
  2: '#E02020', // red
  3: '#FF6D00', // orange
  4: '#FFE600', // yellow (vivid; not amber/gold)
  5: '#00A651', // green
  6: '#0052FF', // blue
  7: '#8E24AA', // violet
  8: '#616161', // gray
  9: '#FFFFFF', // white
};

/** Deep metallic gold — deliberately darker than the yellow digit band. */
export const GOLD_BAND = '#9A7209';
export const SILVER_BAND = '#9E9E9E';

/** Outline every band so adjacent hues (yellow / gold / orange) stay readable. */
export const BAND_STROKE = '#1F1F1F';
export const BAND_STROKE_WIDTH = 0.55;

/** Tolerance stripe color per stored tolerance (±20% has no stripe — 3-band). */
const TOLERANCE_BAND_COLORS: Record<
  Exclude<ResistanceTolerance, '20%'>,
  string
> = {
  '0.01%': DIGIT_BAND_COLORS[8], // gray ±0.01%
  '0.02%': DIGIT_BAND_COLORS[4], // yellow ±0.02%
  '0.05%': DIGIT_BAND_COLORS[3], // orange ±0.05%
  '0.1%': DIGIT_BAND_COLORS[7], // violet ±0.1%
  '0.25%': DIGIT_BAND_COLORS[6], // blue ±0.25%
  '0.5%': DIGIT_BAND_COLORS[5], // green ±0.5%
  '1%': DIGIT_BAND_COLORS[1], // brown ±1%
  '2%': DIGIT_BAND_COLORS[2], // red ±2%
  '5%': GOLD_BAND, // gold ±5%
  '10%': SILVER_BAND, // silver ±10%
};

function multiplierBandColor(exp: number): string {
  if (exp === -1) return GOLD_BAND;
  if (exp === -2) return SILVER_BAND;
  if (exp >= 0 && exp <= 9) return DIGIT_BAND_COLORS[exp];
  return DIGIT_BAND_COLORS[0];
}

function digitBandColor(digit: number): string {
  return DIGIT_BAND_COLORS[Math.max(0, Math.min(9, digit))] ?? DIGIT_BAND_COLORS[0];
}

/** 3-band (±20%), 4-band (2–10%), or 5-band (≤1% precision). */
function bandCountForTolerance(tolerance: ResistanceTolerance): 3 | 4 | 5 {
  if (tolerance === '20%') return 3;
  if (
    tolerance === '0.01%' ||
    tolerance === '0.02%' ||
    tolerance === '0.05%' ||
    tolerance === '0.1%' ||
    tolerance === '0.25%' ||
    tolerance === '0.5%' ||
    tolerance === '1%'
  ) {
    return 5;
  }
  return 4;
}

function encodeFourBand(ohms: number): { digits: [number, number]; multExp: number } {
  if (!Number.isFinite(ohms) || ohms <= 0) {
    return { digits: [0, 0], multExp: 0 };
  }

  let exp = Math.floor(Math.log10(ohms)) - 1;
  let mantissa = ohms / 10 ** exp;

  if (mantissa < 10) {
    exp -= 1;
    mantissa = ohms / 10 ** exp;
  }
  if (mantissa >= 100) {
    exp += 1;
    mantissa = ohms / 10 ** exp;
  }

  const rounded = Math.round(mantissa);
  return {
    digits: [Math.floor(rounded / 10), rounded % 10],
    multExp: exp,
  };
}

function encodeFiveBand(ohms: number): {
  digits: [number, number, number];
  multExp: number;
} {
  if (!Number.isFinite(ohms) || ohms <= 0) {
    return { digits: [0, 0, 0], multExp: 0 };
  }

  let exp = Math.floor(Math.log10(ohms)) - 2;
  let mantissa = ohms / 10 ** exp;

  if (mantissa < 100) {
    exp -= 1;
    mantissa = ohms / 10 ** exp;
  }
  if (mantissa >= 1000) {
    exp += 1;
    mantissa = ohms / 10 ** exp;
  }

  const rounded = Math.round(mantissa);
  const clamped = Math.max(100, Math.min(999, rounded));
  return {
    digits: [
      Math.floor(clamped / 100),
      Math.floor((clamped % 100) / 10),
      clamped % 10,
    ],
    multExp: exp,
  };
}

/** Map stored resistance + tolerance to ordered band fill colors (first band nearest left lead). */
export function resistanceColorBands(
  value: number,
  unit: ResistanceUnit,
  tolerance: ResistanceTolerance = DEFAULT_RESISTANCE_TOLERANCE,
): string[] {
  const ohms = resistanceToOhms(value, unit);
  const bandCount = bandCountForTolerance(tolerance);

  if (bandCount === 5) {
    const { digits, multExp } = encodeFiveBand(ohms);
    const tol = TOLERANCE_BAND_COLORS[tolerance as Exclude<ResistanceTolerance, '20%'>];
    return [
      digitBandColor(digits[0]),
      digitBandColor(digits[1]),
      digitBandColor(digits[2]),
      multiplierBandColor(multExp),
      tol,
    ];
  }

  const { digits, multExp } = encodeFourBand(ohms);

  if (bandCount === 3) {
    return [
      digitBandColor(digits[0]),
      digitBandColor(digits[1]),
      multiplierBandColor(multExp),
    ];
  }

  const tol = TOLERANCE_BAND_COLORS[tolerance as Exclude<ResistanceTolerance, '20%'>];
  return [
    digitBandColor(digits[0]),
    digitBandColor(digits[1]),
    multiplierBandColor(multExp),
    tol,
  ];
}

export function bandsForComponent(component: {
  resistanceValue?: number;
  resistanceUnit?: ResistanceUnit;
  resistanceTolerance?: ResistanceTolerance;
}): string[] {
  return resistanceColorBands(
    component.resistanceValue ?? DEFAULT_RESISTANCE_VALUE,
    component.resistanceUnit ?? DEFAULT_RESISTANCE_UNIT,
    component.resistanceTolerance ?? DEFAULT_RESISTANCE_TOLERANCE,
  );
}

/** Tan body box in current public/components/resistor.svg design space (~49.5×9.55). */
export const RESISTOR_BODY = { x: 6.2, y: 0.35, width: 37.1, height: 8.85 } as const;

/**
 * Body path from calculator.net 4-band.svg (275×59 local units).
 * @see https://www.calculator.net/resistor-calculator.html
 */
export const CALCNET_RESISTOR_BODY_PATH =
  'M93 60 L62 60 A5,5 0 0,1 60,59 A42,42 0 0,1 60,2 A5,5 0 0,1 62,1 L93 1 L99 6 L212 6 L218 1 L249 1 A5,5 0 0,1 251,2 A42,42 0 0,1 251,59 A5,5 0 0,1 249,60 L218 60 L212 55 L99 55 Z';

/** Leftmost/rightmost extent of the reference graphic (bulb tips). */
const CALCNET_ANCHOR = { x: 18, y: 30.5, spanX: 275, spanY: 59 } as const;

/** Slightly thicker stripes than the reference (12→14 wide, taller on neck). */
const BAND_WIDTH = 14;
const CALCNET_FIRST_BAND = { x: 73, y: 1, width: BAND_WIDTH, height: 59 } as const;
const CALCNET_NECK_BAND = { y: 4, width: BAND_WIDTH, height: 52 } as const;
const CALCNET_NECK_X0 = 99;
const CALCNET_NECK_X1 = 208;

/** Band rectangles — 4-band layout mirroring calculator.net spacing. */
const CALCNET_FOUR_BAND_RECTS = [
  { ...CALCNET_FIRST_BAND },
  { x: 99, ...CALCNET_NECK_BAND },
  { x: 123, ...CALCNET_NECK_BAND },
  { x: 195, ...CALCNET_NECK_BAND },
] as const;

/** Map calc.net band coords into RESISTOR_BODY (center-anchored scale). */
export const RESISTOR_GRAPHIC = {
  bodyPath: CALCNET_RESISTOR_BODY_PATH,
  bodyLeftX: RESISTOR_BODY.x,
  bodyRightX: RESISTOR_BODY.x + RESISTOR_BODY.width,
  transform: `translate(${RESISTOR_BODY.x}, ${RESISTOR_BODY.y + RESISTOR_BODY.height / 2}) scale(${RESISTOR_BODY.width / CALCNET_ANCHOR.spanX}, ${RESISTOR_BODY.height / CALCNET_ANCHOR.spanY}) translate(${-CALCNET_ANCHOR.x}, ${-CALCNET_ANCHOR.y})`,
} as const;

function neckBandPositions(count: number): number[] {
  if (count <= 1) return [CALCNET_NECK_X0];
  const innerWidth = CALCNET_NECK_X1 - CALCNET_NECK_X0;
  const bandSpan = count * CALCNET_NECK_BAND.width;
  const gap = count > 1 ? (innerWidth - bandSpan) / (count - 1) : 0;
  return Array.from(
    { length: count },
    (_, i) => CALCNET_NECK_X0 + i * (CALCNET_NECK_BAND.width + gap),
  );
}

export function layoutResistorBands(
  bandCount: number,
): { x: number; y: number; width: number; height: number }[] {
  if (bandCount === 4) {
    return CALCNET_FOUR_BAND_RECTS.map((band) => ({ ...band }));
  }

  if (bandCount === 3) {
    const [a, c] = neckBandPositions(2);
    return [
      { ...CALCNET_FIRST_BAND },
      { x: a, ...CALCNET_NECK_BAND },
      { x: c, ...CALCNET_NECK_BAND },
    ];
  }

  const neckXs = neckBandPositions(bandCount - 1);
  return [
    { ...CALCNET_FIRST_BAND },
    ...neckXs.map((x) => ({ x, ...CALCNET_NECK_BAND })),
  ];
}

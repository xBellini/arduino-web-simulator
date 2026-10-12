/**
 * What: Central catalog of every placeable part and palette ordering.
 * Role: maps `type` → registry metadata; merges SVG footprint sizes at runtime.
 * Owns/exports: `COMPONENT_REGISTRY`, `PALETTE_CATEGORIES`, `PALETTE_ORDER`,
 * `getDesignDefinition`, `getDefinitionScale`, `getDefinition`.
 * Conventions: pin `x`/`y` match the artwork viewBox (same space as `public/components/*.svg`);
 * do not set `width`/`height` on entries — `getDesignDefinition` reads viewBox via
 * `partFootprints`; canvas size = viewBox × `scale`.
 * To add a simulating part: create `src/components/<type>.ts(x)` with a `PartModule` (definition +
 * hooks), register it in `src/components/index.ts`, add `public/components/<type>.svg`, and list the type
 * in a `PALETTE_CATEGORIES.types` array. Do not add it to `STATIC_REGISTRY`.
 * To add an artwork-only part (unique SVG, no sim): add `public/components/<type>.svg` with a valid
 * viewBox, add a `STATIC_REGISTRY` entry with `type`, `label`, `scale`, `pins` (measure coords
 * in the SVG), optional `artwork: art('<type>')`, append `type` to a `PALETTE_CATEGORIES.types`
 * array, and set `marking` if the properties panel should edit chip name or value.
 * To add a package IC that simulates: put `package: 'dip8'` / `'to92'` / `'to220'` (etc.) on
 * the part module's `definition` — see `src/components/modules/ne555.ts`, `transistorNpn.ts`. Omit `scale`
 * to inherit the package shell's scale; set `scale` only to override. Blank DIP / TO shells
 * stay in `STATIC_REGISTRY` (use `dipPackagePins` / `to92DevicePins` / `to220DevicePins` from
 * `packagePins.ts`). Named DIPs use `dipDevicePins(packageId, pinMap)` — never hardcode pin
 * x/y when reusing a package SVG. Optional per-pin `letter` overrides casing text when it
 * should differ from `description`.
 * To wire the palette: only types listed under `PALETTE_CATEGORIES` appear in the sidebar;
 * order within a category follows each category's `types` array; `PALETTE_ORDER` is the flat
 * drag order — keep new types in both registry and a category.
 * To tune pin coords: open the SVG, read viewBox units at each lead/hole center, set matching
 * `PinDefinition` ids (wire/sim code may depend on ids); use `breadboardGrid` helpers for
 * breadboard tie/rail ids only on `breadboard`.
 * Not-here: hitbox overrides (`componentHitbox.ts`), palette icon crops (`Palette.tsx`),
 * or simulation models — registry is placement + artwork metadata only.
 *
 *---------------------------------------------------------------------------------------------------------------------
 * Changelog:
 * - 09-10-2026 — Modules palette: DS3231 RTC (part module)
 * - 08-10-2026 — ICs palette: 74HC combinational set (definition-only); DIP pins via packagePins
 * - 06-10-2026 — Added hidden wire_junction (single-pin tee node; not in palette)
 * - 05-10-2026 — pcf8574_lcd_backpack part module (palette only here); lcd_i2c removed
 * - 05-10-2026 — Parallel lcd_16x2 / lcd_20x4 moved to part modules (palette only here)
 * - 05-10-2026 — Button Matrix 4×4 (tactile) in Modules; Keypad 4×4 stays numbered membrane
 * - 05-10-2026 — Keypad 4×4 moved to part module (palette only here)
 * - 03-10-2026 — Modules category: RFID-RC522, MAX7219 8×8, microSD (part modules; palette only here)
 * - 28-09-2026 — TinkerCAD Keypad 4×4 + LDR (photoresistor) artwork + pins (no sim yet)
 * - 28-09-2026 — TinkerCAD Relay SPDT / DPDT artwork + pins (no sim yet)
 * - 28-09-2026 — Blank DIP18 / DIP20 / DIP24 / DIP28 shells + palette ICs list
 * - 25-09-2026 — TO helpers in packagePins.ts; pin description + letter
 * - 24-09-2026 — TO pin helpers next to DIP (geometry only); dipPackagePins options object
 * - 24-09-2026 — Blank TO92/TO220 shells
 * - 23-09-2026 - Modified dipPackagePins to accept closerPins as an argument, for either small or bigger ic packages
 * - 23-09-2026 - Added DIP4 and DIP40 packages
 * - 23-09-2026 — Package ICs inherit footprint `scale` when omitted (`getDefinitionScale`)
 * - 19-09-2026 - Updated dipPackagePins function to place pins on the correct place on the components
 * - 17-09-2026 — NE555 definition moved to `src/parts/ne555.ts`
 * - 17-09-2026 — Simulating part definitions live only in `src/parts`; this file keeps
 *   boards, breadboard, and artwork-only types
 * - 17-09-2026 — Registry merges `STATIC_REGISTRY` with part module definitions
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */
import type {
  ComponentDefinition,
  ComponentRegistryEntry,
  PinDefinition,
} from '../types';
import {
  BB_COLS,
  BB_HEIGHT,
  BB_RAIL_BOT_MINUS_Y,
  BB_RAIL_BOT_PLUS_Y,
  BB_RAIL_TOP_MINUS_Y,
  BB_RAIL_TOP_PLUS_Y,
  BB_ROWS,
  BB_WIDTH,
  holeX,
  holeY,
  tiePinId,
} from './breadboardGrid';
import { getPartFootprint } from './partFootprints';
import { dipPackagePins, to220DevicePins, to92DevicePins } from './packagePins';
import { PART_MODULES } from '../components';

function art(type: string): string {
  return `/components/${type}.svg`;
}

function arduinoUnoPinType(id: string): PinDefinition['type'] {
  if (id === 'v5' || id === '5v' || id === 'v33' || id === '3v3' || id === 'vin') {
    return 'power';
  }
  if (id.startsWith('gnd')) return 'ground';
  if (id === 'aref' || /^a\d$/.test(id)) return 'analog';
  return 'digital';
}

function arduinoNanoPinType(id: string): PinDefinition['type'] {
  if (
    id === 'v5' ||
    id === '5v' ||
    id === 'v33' ||
    id === '3v3' ||
    id.startsWith('vin')
  ) {
    return 'power';
  }
  if (id.startsWith('gnd')) return 'ground';
  if (id === 'aref' || /^a\d$/.test(id)) return 'analog';
  return 'digital';
}

function breadboardPins(): PinDefinition[] {
  const pins: PinDefinition[] = [];

  for (let i = 0; i < BB_COLS; i++) {
    const x = holeX(i);
    pins.push({ id: `tp${i}`, description: '', x, y: BB_RAIL_TOP_PLUS_Y, type: 'power' });
    pins.push({ id: `tn${i}`, description: '', x, y: BB_RAIL_TOP_MINUS_Y, type: 'ground' });
  }

  for (let r = 0; r < BB_ROWS; r++) {
    for (let c = 0; c < BB_COLS; c++) {
      pins.push({
        id: tiePinId(r, c),
        description: '',
        x: holeX(c),
        y: holeY(r),
        type: 'digital',
      });
    }
  }

  for (let i = 0; i < BB_COLS; i++) {
    const x = holeX(i);
    pins.push({ id: `bp${i}`, description: '', x, y: BB_RAIL_BOT_PLUS_Y, type: 'power' });
    pins.push({ id: `bn${i}`, description: '', x, y: BB_RAIL_BOT_MINUS_Y, type: 'ground' });
  }

  return pins;
}

/**
 * Parts whose definition lives here rather than in a part module: the boards and breadboard
 * (infrastructure, not parts) and the artwork-only types that have no simulation behaviour.
 * Anything that simulates belongs in `src/components/<type>.ts`.
 */
const STATIC_REGISTRY: Record<string, ComponentRegistryEntry> = {
  arduino_uno: { // Adjusted already
    type: 'arduino_uno',
    label: 'Arduino Uno',
    scale: 2,
    artwork: art('arduino_uno'),
    pins: [
	  { id: 'scl', description: 'SCL', x: 99.7, y: 10 },
	  { id: 'sda', description: 'SDA', x: 109.7, y: 10 },
	  { id: 'aref', description: 'AREF', x: 119.7, y: 10 },
	  { id: 'gnd', description: 'GND', x: 129.7, y: 10 },
	  { id: 'd13', description: 'D13', x: 139.7, y: 10 },
	  { id: 'd12', description: 'D12', x: 149.7, y: 10 },
	  { id: 'd11', description: 'D11', x: 159.7, y: 10 },
	  { id: 'd10', description: 'D10', x: 169.7, y: 10 },
	  { id: 'd9', description: 'D9', x: 179.7, y: 10 },
	  { id: 'd8', description: 'D8', x: 189.7, y: 10 },
	  { id: 'd7', description: 'D7', x: 205.7, y: 10 },
	  { id: 'd6', description: 'D6', x: 215.7, y: 10 },
	  { id: 'd5', description: 'D5', x: 225.7, y: 10 },
	  { id: 'd4', description: 'D4', x: 235.7, y: 10 },
	  { id: 'd3', description: 'D3', x: 245.7, y: 10 },
	  { id: 'd2', description: 'D2', x: 255.7, y: 10 },
	  { id: 'd1', description: 'D1', x: 265.7, y: 10 },
	  { id: 'd0', description: 'D0', x: 275.7, y: 10 },
	  { id: 'unused', description: 'UNUSED', x: 135.5, y: 200 },
	  { id: 'ioref', description: 'IOREF', x: 145.5, y: 200 },
	  { id: 'reset', description: 'Reset', x: 155.5, y: 200 },
	  { id: '3v3', description: '3.3V', x: 165.5, y: 200 },
	  { id: '5v', description: '5V', x: 175.5, y: 200 },
	  { id: 'gnd2', description: 'GND', x: 185.5, y: 200 },
	  { id: 'gnd3', description: 'GND', x: 195.5, y: 200 },
	  { id: 'vin', description: 'VIN', x: 205.5, y: 200 },
	  { id: 'a0', description: 'A0', x: 225.5, y: 200 },
	  { id: 'a1', description: 'A1', x: 235.5, y: 200 },
	  { id: 'a2', description: 'A2', x: 245.5, y: 200 },
	  { id: 'a3', description: 'A3', x: 255.5, y: 200 },
	  { id: 'a4', description: 'A4', x: 265.5, y: 200 },
	  { id: 'a5', description: 'A5', x: 275.5, y: 200 },
	].map((p) => ({ ...p, type: arduinoUnoPinType(p.id) })),
  },
  
  arduino_nano: { // Adjusted already
    type: 'arduino_nano',
    label: 'Arduino Nano',
    scale: 1,
    artwork: art('arduino_nano'),
    pins: [
	  { id: 'vin', description: 'VIN', x: 29.7, y: 9 },
	  { id: 'gnd', description: 'GND', x: 50.5, y: 9 },
	  { id: 'reset', description: 'RST', x: 71, y: 9 },
	  { id: '5v', description: '5V', x: 91.5, y: 9 },
	  { id: 'a7', description: 'A7', x: 112.5, y: 9 },
	  { id: 'a6', description: 'A6', x: 133, y: 9 },
	  { id: 'a5', description: 'A5', x: 153.5, y: 9 },
	  { id: 'a4', description: 'A4', x: 174, y: 9 },
	  { id: 'a3', description: 'A3', x: 194.5, y: 9 },
	  { id: 'a2', description: 'A2', x: 215.5, y: 9 },
	  { id: 'a1', description: 'A1', x: 236, y: 9 },
	  { id: 'a0', description: 'A0', x: 257, y: 9 },
	  { id: 'aref', description: 'REF', x: 277.5, y: 9 },
	  { id: 'v33', description: '3.3V', x: 298, y: 9 },
	  { id: 'd13', description: 'D13', x: 318.5, y: 9 },
	  { id: 'tx1', description: 'TX1', x: 29.7, y: 134 },
	  { id: 'rx0', description: 'RX0', x: 50.5, y: 134 },
	  { id: 'reset2', description: 'RST', x: 71, y: 134 },
	  { id: 'gnd2', description: 'GND', x: 91.5, y: 134 },
	  { id: 'd2', description: 'D2', x: 112.5, y: 134 },
	  { id: 'd3', description: 'D3', x: 133, y: 134 },
	  { id: 'd4', description: 'D4', x: 153.5, y: 134 },
	  { id: 'd5', description: 'D5', x: 174, y: 134 },
	  { id: 'd6', description: 'D6', x: 194.5, y: 134 },
	  { id: 'd7', description: 'D7', x: 215.5, y: 134 },
	  { id: 'd8', description: 'D8', x: 236, y: 134 },
	  { id: 'd9', description: 'D9', x: 257, y: 134 },
	  { id: 'd10', description: 'D10', x: 277.5, y: 134 },
	  { id: 'd11', description: 'D11', x: 298, y: 134 },
	  { id: 'd12', description: 'D12', x: 318.5, y: 134 },
	].map((p) => ({ ...p, type: arduinoNanoPinType(p.id) })),
  },
  
  breadboard: {
    type: 'breadboard',
    label: 'Breadboard',
    scale: 1,
    pins: breadboardPins(),
  },

  servo: {
    type: 'servo',
    label: 'Micro Servo',
    scale: 1,
    artwork: art('servo'),
    pins: [
      { id: 'gnd', description: 'GND', x: 14, y: 16, type: 'ground' },
      { id: 'v5', description: '5V', x: 32, y: 16, type: 'power' },
      { id: 'signal', description: 'SIG', x: 50, y: 16, type: 'digital' },
    ],
  },

  slide_switch: {
    type: 'slide_switch',
    label: 'Slide Switch',
    scale: 1,
    artwork: art('slide_switch'),
    pins: [
      { id: '1', description: '1', x: 14, y: 40, type: 'digital' },
      { id: 'common', description: 'Common', x: 32, y: 40, type: 'digital' },
      { id: '2', description: '2', x: 50, y: 40, type: 'digital' },
    ],
  },

  /** TinkerCAD Relay SPDT (DIL12 footprint 122167). Artwork only — SPICE later. */
  relay_spdt: {
    type: 'relay_spdt',
    label: 'Relay SPDT',
    scale: 2,
    artwork: art('relay_spdt'),
    pins: [
      // TinkerCAD terminal → schematic: local = (W/2+tx, H/2+ty) for 62×42 crop
      { id: 'r1', description: 'R1', x: 6, y: 6, type: 'digital' }, // T6
      { id: 'coil2', description: 'COIL2', x: 16, y: 6, type: 'digital' }, // T5
      { id: 'com2', description: 'COM2', x: 56, y: 6, type: 'digital' }, // T1
      { id: 'r2', description: 'R2', x: 6, y: 36, type: 'digital' }, // T7
      { id: 'coil1', description: 'COIL1', x: 16, y: 36, type: 'digital' }, // T8
      { id: 'com1', description: 'COM1', x: 56, y: 36, type: 'digital' }, // T12
    ],
  },

  /** TinkerCAD Relay DPDT (DIL16 footprint 122164). Artwork only — SPICE later. */
  relay_dpdt: {
    type: 'relay_dpdt',
    label: 'Relay DPDT',
    scale: 2,
    artwork: art('relay_dpdt'),
    pins: [
      // local = (W/2+tx, H/2+ty) for 80×40 crop
      { id: 'b2', description: 'B2', x: 5, y: 5, type: 'digital' }, // T8
      { id: 'b1', description: 'B1', x: 25, y: 5, type: 'digital' }, // T6
      { id: 'comb', description: 'COMB', x: 45, y: 5, type: 'digital' }, // T4
      { id: 'coil2', description: 'COIL2', x: 75, y: 5, type: 'digital' }, // T1
      { id: 'a2', description: 'A2', x: 5, y: 35, type: 'digital' }, // T9
      { id: 'a1', description: 'A1', x: 25, y: 35, type: 'digital' }, // T11
      { id: 'coma', description: 'COMA', x: 45, y: 35, type: 'digital' }, // T13
      { id: 'coil1', description: 'COIL1', x: 75, y: 35, type: 'digital' }, // T16
    ],
  },

  /** TinkerCAD Photoresistor / LDR (footprint 116691). Artwork only — SPICE later. */
  ldr: {
    type: 'ldr',
    label: 'Photoresistor',
    scale: 2,
    artwork: art('ldr'),
    pins: [
      // origin (0,-13) in 26×30 crop → lx=px+13, ly=py+28
      { id: '1', description: '1', x: 8, y: 28, type: 'digital' },
      { id: '2', description: '2', x: 18, y: 28, type: 'digital' },
    ],
  },

  seven_segment: { // Adjusted already
    type: 'seven_segment',
    label: '7-Segment Display',
    scale: 2,
    artwork: art('seven_segment'),
    pins: [
      { id: 'g', description: 'G', x: 5, y: 7, type: 'digital' },
      { id: 'f', description: 'F', x: 15, y: 7, type: 'digital' },
      { id: 'common1', description: 'Common', x: 25, y: 7, type: 'digital' },
      { id: 'a', description: 'A', x: 35, y: 7, type: 'digital' },
      { id: 'b', description: 'B', x: 45, y: 7, type: 'digital' },
      { id: 'e', description: 'E', x: 5, y: 67, type: 'digital' },
      { id: 'd', description: 'D', x: 15, y: 67, type: 'digital' },
      { id: 'common2', description: 'Common', x: 25, y: 67, type: 'digital' },
      { id: 'c', description: 'C', x: 35, y: 67, type: 'digital' },
      { id: 'dp', description: 'DP', x: 45, y: 67, type: 'digital' },
    ],
  },
  
  dip_switch_4: { // Adjusted already
    type: 'dip_switch_4',
    label: 'DIP Switch (4)',
    scale: 2,
    artwork: art('dip_switch_4'),
    pins: [
      { id: '1b', description: '1B', x: 7.5, y: 5, type: 'digital' },
      { id: '2b', description: '2B', x: 17.5, y: 5, type: 'digital' },
      { id: '3b', description: '3B', x: 27.5, y: 5, type: 'digital' },
      { id: '4b', description: '4B', x: 37.5, y: 5, type: 'digital' },
      { id: '1a', description: '1A', x: 7.5, y: 35, type: 'digital' },
      { id: '2a', description: '2A', x: 17.5, y: 35, type: 'digital' },
      { id: '3a', description: '3A', x: 27.5, y: 35, type: 'digital' },
      { id: '4a', description: '4A', x: 37.5, y: 35, type: 'digital' },
    ],
  },
  
  dip_switch_6: { // Adjusted already
    type: 'dip_switch_6',
    label: 'DIP Switch (6)',
    scale: 2,
    artwork: art('dip_switch_6'),
    pins: [
      { id: '1b', description: '1B', x: 9.5, y: 5, type: 'digital' },
      { id: '2b', description: '2B', x: 19.5, y: 5, type: 'digital' },
      { id: '3b', description: '3B', x: 29.5, y: 5, type: 'digital' },
      { id: '4b', description: '4B', x: 39.5, y: 5, type: 'digital' },
      { id: '5b', description: '5B', x: 49.5, y: 5, type: 'digital' },
      { id: '6b', description: '6B', x: 59.5, y: 5, type: 'digital' },
      { id: '1a', description: '1A', x: 9.5, y: 35, type: 'digital' },
      { id: '2a', description: '2A', x: 19.5, y: 35, type: 'digital' },
      { id: '3a', description: '3A', x: 29.5, y: 35, type: 'digital' },
      { id: '4a', description: '4A', x: 39.5, y: 35, type: 'digital' },
      { id: '5a', description: '5A', x: 49.5, y: 35, type: 'digital' },
      { id: '6a', description: '6A', x: 59.5, y: 35, type: 'digital' },
    ],
  },

  to92: { // Adjusted
    type: 'to92',
    label: 'TO92',
    scale: 2,
    artwork: art('to92'),
    marking: 'chip',
    pins: to92DevicePins([
      { id: '1', description: '1' },
      { id: '2', description: '2' },
      { id: '3', description: '3' },
    ]),
  },

  to220: { // Adjusted
    type: 'to220',
    label: 'TO220',
    scale: 2,
    artwork: art('to220'),
    marking: 'chip',
    pins: to220DevicePins([
      { id: '1', description: '1' },
      { id: '2', description: '2' },
      { id: '3', description: '3' },
    ]),
  },

  dip4: {
    type: 'dip4',
    label: 'DIP4',
    scale: 2,
    artwork: art('dip4'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 2, closerPins: false }),
  },
  
  dip6: {
    type: 'dip6',
    label: 'DIP6',
    scale: 2,
    artwork: art('dip6'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 3, closerPins: false }),
  },
  
  dip8: {
    type: 'dip8',
    label: 'DIP8',
    scale: 2,
    artwork: art('dip8'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 4, closerPins: false }),
  },
  
  dip14: {
    type: 'dip14',
    label: 'DIP14',
    scale: 2,
    artwork: art('dip14'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 7, closerPins: false }),
  },
  
  dip16: {
    type: 'dip16',
    label: 'DIP16',
    scale: 2,
    artwork: art('dip16'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 8, closerPins: false }),
  },

  dip18: {
    type: 'dip18',
    label: 'DIP18',
    scale: 2,
    artwork: art('dip18'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 9, closerPins: false }),
  },
  
  dip20: {
    type: 'dip20',
    label: 'DIP20',
    scale: 2,
    artwork: art('dip20'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 10, closerPins: false }),
  },
  
  dip24: {
    type: 'dip24',
    label: 'DIP24',
    scale: 2,
    artwork: art('dip24'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 12, closerPins: false }),
  },

  dip28: {
    type: 'dip28',
    label: 'DIP28',
    scale: 2,
    artwork: art('dip28'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 14, closerPins: false }),
  },
  
  dip40: {
    type: 'dip40',
    label: 'DIP40',
    scale: 2,
    artwork: art('dip40'),
    marking: 'chip',
    pins: dipPackagePins({ perRow: 20, closerPins: true }),
  },

  /** Invisible electrical tee — created when routing onto an existing wire; not in the palette. */
  wire_junction: {
    type: 'wire_junction',
    label: 'Wire junction',
    scale: 1,
    artwork: art('wire_junction'),
    pins: [
      { id: 'j', description: 'Junction', x: 1, y: 1, type: 'digital' },
    ],
  },
};

/** Registry of every placeable type: artwork shells + simulating part modules. */
export const COMPONENT_REGISTRY: Record<string, ComponentRegistryEntry> = {
  ...STATIC_REGISTRY,
  ...Object.fromEntries(
    Object.entries(PART_MODULES).map(([type, mod]) => [type, mod.definition]),
  ),
};

export const PALETTE_CATEGORIES = [
  {
    id: 'boards',
    label: 'Boards',
    types: ['arduino_uno', 'arduino_nano'],
  },
  {
    id: 'prototyping',
    label: 'Prototyping',
    types: ['breadboard'],
  },
  {
    id: 'passives',
    label: 'Passives',
    types: [
	'resistor',
	'capacitor',
	'polarized_capacitor',
	'potentiometer',
	],
  },
  {
    id: 'semiconductors',
    label: 'Semiconductors',
    types: [
	'diode', 
	'to92', 
	'transistor_npn',
	'transistor_pnp',
	'to220',
	'mosfet_n',
	'mosfet_p',
	],
  },
  {
    id: 'output',
    label: 'Output',
    types: [
      'led',
      'rgb_led',
      'seven_segment',
      'lcd_16x2',
      'lcd_20x4',
      'buzzer',
      'servo',
      'relay_spdt',
      'relay_dpdt',
    ],
  },
  {
    id: 'input',
    label: 'Input',
    types: [
	  'button',
	  'slide_switch',
	  'dip_switch_4',
	  'dip_switch_6',
	  'keypad_4x4',
	  'ldr',
	],
  },
  {
    id: 'modules',
    label: 'Modules',
    types: [
      'rfid_rc522',
      'max7219_matrix_8x8',
      'microsd_module',
      'button_matrix_4x4',
      'pcf8574_lcd_backpack',
      'ds3231_rtc',
    ],
  },
  {
    id: 'ics',
    label: 'ICs',
    types: [
      'ne555',
    ],
  },
    {
    id: 'logic_gates',
    label: 'Logic Gates',
    types: [
      '74hc00',
      '74hc02',
      '74hc03',
      '74hc04',
      '74hc08',
      '74hc10',
      '74hc11',
      '74hc20',
      '74hc21',
      '74hc27',
      '74hc32',
      '74hc86',
    ],
  },
  /*
  {
    id: 'bare_packages',
    label: 'Bare Packages',
    types: [
	  'dip4',
	  'dip6',
	  'dip8',
	  'dip14',
	  'dip16',
	  'dip18',
	  'dip20',
	  'dip24',
	  'dip28',
	  'dip40',
	],
  },
  */
  {
    id: 'instruments',
    label: 'Instruments',
    types: [
	  'power_supply',
	  'voltmeter', 
	  'ammeter',
	  'ohmmeter',
	  'oscillator'
	],
  },
] as const;

export type PaletteCategoryId = (typeof PALETTE_CATEGORIES)[number]['id'];

export const PALETTE_ORDER = PALETTE_CATEGORIES.flatMap((category) => [
  ...category.types,
]);

export function getDesignDefinition(type: string): ComponentDefinition {
  const entry = COMPONENT_REGISTRY[type];
  if (!entry) throw new Error(`Unknown component type: ${type}`);
  const footprintId = entry.package ?? type;
  const size =
    type === 'breadboard'
      ? { width: BB_WIDTH, height: BB_HEIGHT }
      : getPartFootprint(footprintId);
  return {
    ...entry,
    width: size.width,
    height: size.height,
    artwork: entry.artwork ?? (entry.package ? art(entry.package) : undefined),
  };
}

/** Effective scale for placement / hit-testing. */
export function getDefinitionScale(type: string): number {
  const entry = COMPONENT_REGISTRY[type];
  if (!entry) throw new Error(`Unknown component type: ${type}`);
  const own = entry.scale;
  if (typeof own === 'number' && Number.isFinite(own) && own > 0) return own;
  // Named IC on a shared footprint: use the package shell's scale by default.
  if (entry.package && entry.package !== type) {
    const pkgScale = COMPONENT_REGISTRY[entry.package]?.scale;
    if (typeof pkgScale === 'number' && Number.isFinite(pkgScale) && pkgScale > 0) {
      return pkgScale;
    }
  }
  return 1;
}

/**
 * Footprint used by the canvas: SVG viewBox size × `scale`, pins scaled too.
 * Artwork still renders in design space (see ComponentShape).
 */
export function getDefinition(type: string): ComponentDefinition {
  const def = getDesignDefinition(type);
  const scale = getDefinitionScale(type);
  if (scale === 1) return { ...def, scale };
  return {
    ...def,
    scale,
    width: def.width * scale,
    height: def.height * scale,
    pins: def.pins.map((pin) => ({
      ...pin,
      x: pin.x * scale,
      y: pin.y * scale,
    })),
  };
}

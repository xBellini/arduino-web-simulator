/**
 * What: MAX7219 8×8 LED matrix module as a placeable part — footprint and header pinout.
 * Role: definition-only part module (no SPI / display sim yet).
 * Owns/exports: `max7219Matrix8x8Module`.
 * Conventions: pin x/y in footprint space (SVG `data-terminal-*` minus viewBox min-x/min-y;
 * viewBox is `25 0 199 134`).
 * Not-here: digit/segment driving — add hooks here later, not a second STATIC_REGISTRY entry.
 *
# Changelog
# Date       | Author | Remarks
# 03-10-2026 | Cursor | Changelog creation / moved out of STATIC_REGISTRY (definition only)
# 05-10-2026 | Cursor | Pin x: footprint space (terminal 32 − viewBox min-x 25 → 7)
# 09-10-2026 | Cursor | Moved from `src/parts/max7219Matrix8x8.ts` (tree reorganization)
 */
import type { PartModule } from '../partModule';

export const max7219Matrix8x8Module: PartModule = {
  type: 'max7219_matrix_8x8',

  definition: {
    type: 'max7219_matrix_8x8',
    label: 'MAX7219 8×8',
    scale: 2,
    artwork: '/components/max7219_matrix_8x8.svg',
    pins: [
      { id: 'vcc', description: 'VCC', x: 7, y: 52, type: 'power' },
      { id: 'gnd', description: 'GND', x: 7, y: 62, type: 'ground' },
      { id: 'din', description: 'DIN', x: 7, y: 72, type: 'digital' },
      { id: 'cs', description: 'CS', x: 7, y: 82, type: 'digital' },
      { id: 'clk', description: 'CLK', x: 7, y: 92, type: 'digital' },
    ],
  },
};

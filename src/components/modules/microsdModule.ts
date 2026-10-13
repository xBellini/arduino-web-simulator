/**
 * What: microSD breakout as a placeable part — footprint and header pinout.
 * Role: definition-only part module (no SPI / filesystem sim yet).
 * Owns/exports: `microsdModule`.
 * Conventions: pin coords from SVG `data-terminal-*`; artwork `/components/microsd_module.svg`.
 * Not-here: SD card protocol — add hooks here later, not a second STATIC_REGISTRY entry.
 *
# Changelog
# Date       | Author | Remarks
# 03-10-2026 | Cursor | Changelog creation / moved out of STATIC_REGISTRY (definition only)
# 09-10-2026 | Cursor | Moved from `src/parts/microsdModule.ts` (tree reorganization)
 */
import type { PartModule } from '../partModule';

export const microsdModule: PartModule = {
  type: 'microsd_module',

  definition: {
    type: 'microsd_module',
    label: 'microSD Module',
    scale: 1.5,
    artwork: '/components/microsd_module.svg',
    pins: [
      { id: 'cs', description: 'CS', x: 198, y: 29, type: 'digital' },
      { id: 'sck', description: 'SCK', x: 198, y: 42, type: 'digital' },
      { id: 'mosi', description: 'MOSI', x: 198, y: 55, type: 'digital' },
      { id: 'miso', description: 'MISO', x: 198, y: 68, type: 'digital' },
      { id: 'vcc', description: 'VCC', x: 198, y: 81, type: 'power' },
      { id: 'gnd', description: 'GND', x: 198, y: 94, type: 'ground' },
    ],
  },
};

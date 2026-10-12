/**
 * What: RFID-RC522 breakout as a placeable part — footprint and header pinout.
 * Role: definition-only part module (no SPI / tag sim yet).
 * Owns/exports: `rfidRc522Module`.
 * Conventions: pin coords from SVG `data-terminal-*`; artwork `/components/rfid_rc522.svg`.
 * Not-here: SPI protocol or card detection — add hooks here later, not a second STATIC_REGISTRY entry.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/parts/rfidRc522.ts` (tree reorganization)
 * - 03-10-2026 — Changelog creation / moved out of STATIC_REGISTRY (definition only)
 */
import type { PartModule } from '../partModule';

export const rfidRc522Module: PartModule = {
  type: 'rfid_rc522',

  definition: {
    type: 'rfid_rc522',
    label: 'RFID-RC522',
    scale: 2,
    artwork: '/components/rfid_rc522.svg',
    pins: [
      { id: 'v33', description: '3V3', x: 45, y: 9, type: 'power' },
      { id: 'rst', description: 'RST', x: 55, y: 9, type: 'digital' },
      { id: 'gnd', description: 'GND', x: 65, y: 9, type: 'ground' },
      { id: 'irq', description: 'IRQ', x: 75, y: 9, type: 'digital' },
      { id: 'miso', description: 'MISO', x: 85, y: 9, type: 'digital' },
      { id: 'mosi', description: 'MOSI', x: 95, y: 9, type: 'digital' },
      { id: 'sck', description: 'SCK', x: 105, y: 9, type: 'digital' },
      { id: 'sda', description: 'SDA', x: 115, y: 9, type: 'digital' },
    ],
  },
};

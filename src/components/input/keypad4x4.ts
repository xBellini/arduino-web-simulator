/**
 * What: 4×4 numbered membrane keypad as a placeable part — footprint and row/col pinout.
 * Role: definition-only part module (no matrix scan / key sim yet). Distinct from
 * `button_matrix_4x4` (tactile-switch PCB module).
 * Owns/exports: `keypad4x4Module`.
 * Conventions: pin coords from TinkerCAD crop (280×390); artwork `/components/keypad_4x4.svg`.
 * Not-here: button matrix scanning — add hooks here later, not a second STATIC_REGISTRY entry.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/parts/keypad4x4.ts` (tree reorganization)
 * - 05-10-2026 — Changelog creation / moved out of STATIC_REGISTRY (definition only)
 */
import type { PartModule } from '../partModule';

export const keypad4x4Module: PartModule = {
  type: 'keypad_4x4',

  definition: {
    type: 'keypad_4x4',
    label: 'Keypad 4x4',
    scale: 1,
    artwork: '/components/keypad_4x4.svg',
    pins: [
      { id: 'row1', description: 'Row 1', x: 105, y: 381, type: 'digital' },
      { id: 'row2', description: 'Row 2', x: 115, y: 381, type: 'digital' },
      { id: 'row3', description: 'Row 3', x: 125, y: 381, type: 'digital' },
      { id: 'row4', description: 'Row 4', x: 135, y: 381, type: 'digital' },
      { id: 'col1', description: 'Col 1', x: 145, y: 381, type: 'digital' },
      { id: 'col2', description: 'Col 2', x: 155, y: 381, type: 'digital' },
      { id: 'col3', description: 'Col 3', x: 165, y: 381, type: 'digital' },
      { id: 'col4', description: 'Col 4', x: 175, y: 381, type: 'digital' },
    ],
  },
};

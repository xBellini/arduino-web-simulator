/**
 * What: 4×4 tactile-switch button matrix module — footprint and C/R header pinout.
 * Role: definition-only part module (no matrix scan / key sim yet). Distinct from
 * `keypad_4x4` (numbered membrane keypad).
 * Owns/exports: `buttonMatrix4x4Module`.
 * Conventions: pin x/y in footprint space (SVG `data-terminal-*` minus viewBox min-x/min-y;
 * viewBox is `25 0 177 172`). Left header top→bottom: C4…R4.
 * Not-here: switch matrix scanning — add hooks here later.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Changelog creation / definition-only registration
#                     | Pin x: footprint space (terminal 32.5 − viewBox min-x 25 → 7.5)
# 09-10-2026 | Cursor | Moved from `src/parts/buttonMatrix4x4.ts` (tree reorganization)
 */
import type { PartModule } from '../partModule';

export const buttonMatrix4x4Module: PartModule = {
  type: 'button_matrix_4x4',

  definition: {
    type: 'button_matrix_4x4',
    label: 'Button Matrix 4×4',
    scale: 1.5,
    artwork: '/components/button_matrix_4x4.svg',
    pins: [
      { id: 'c4', description: 'C4', x: 7.5, y: 36, type: 'digital' },
      { id: 'c3', description: 'C3', x: 7.5, y: 47.5, type: 'digital' },
      { id: 'c2', description: 'C2', x: 7.5, y: 59, type: 'digital' },
      { id: 'c1', description: 'C1', x: 7.5, y: 70.5, type: 'digital' },
      { id: 'r1', description: 'R1', x: 7.5, y: 82, type: 'digital' },
      { id: 'r2', description: 'R2', x: 7.5, y: 93.5, type: 'digital' },
      { id: 'r3', description: 'R3', x: 7.5, y: 105, type: 'digital' },
      { id: 'r4', description: 'R4', x: 7.5, y: 116.5, type: 'digital' },
    ],
  },
};

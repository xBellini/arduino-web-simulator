/**
 * What: NE555 timer as a named DIP8 part — footprint, pinout, and silkscreen.
 * Role: part module so the chip lives with the other simulating types instead of as a
 * registry-only blob. Electrical behaviour is not implemented yet: TRIG/THRES are analog
 * comparator inputs, and this sim still has no analog voltage path those pins can use.
 * Owns/exports: `ne555Module`.
 * Conventions: DIP8 pin order (GND, TRIG, OUT, RESET, CTRL, THRES, DISCH, VCC). Artwork is
 * the shared `dip8` package SVG; canvas scale is inherited from that shell (omit `scale`
 * unless you need a different size). `partLabel` is the body marking.
 * To add the timer later: `evaluate` / `spiceStamp` on this file — do not put a second
 * definition back in `STATIC_REGISTRY`.
 * Not-here: blank DIP shells, which stay artwork-only in `src/registry/components.ts`.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/parts/ne555.ts` (tree reorganization)
 * - 23-09-2026 — Dropped explicit `scale`; inherits dip8 package scale
 * - 17-09-2026 — Changelog creation / moved out of STATIC_REGISTRY (definition only)
 */
import type { PartModule } from '../partModule';

export const ne555Module: PartModule = {
  type: 'ne555',

  definition: {
    type: 'ne555',
    label: 'NE555',
    package: 'dip8',
    marking: 'chip',
    defaultPartLabel: 'NE555',
    pins: [
      { id: 'gnd', description: 'GND', x: 6, y: 32, type: 'ground' },
      { id: 'trig', description: 'TRIG', x: 16, y: 32, type: 'digital' },
      { id: 'out', description: 'OUT', x: 26, y: 32, type: 'digital' },
      { id: 'reset', description: 'RESET', x: 36, y: 32, type: 'digital' },
      { id: 'ctrl', description: 'CTRL', x: 36, y: 0, type: 'digital' },
      { id: 'thresh', description: 'THRES', x: 26, y: 0, type: 'digital' },
      { id: 'disch', description: 'DISCH', x: 16, y: 0, type: 'digital' },
      { id: 'vcc', description: 'VCC', x: 6, y: 0, type: 'power' },
    ],
  },
};

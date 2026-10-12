/**
 * What: 4 input NAND Gate (74HC20) as a named DIP14 part — footprint, datasheet pinout, and SPICE
 * stamp that wraps single-gate XSPICE subcircuits from `Digital Logic/74HC.LIB`.
 * Those are XSPICE A-devices; no engine in the app solves them (eecircuit-engine has no XSPICE code models).
 * Owns/exports: `hc20Module` (`type: '74hc20'`).
 * Conventions: `dipDevicePins('dip14', …)`; each gate stamps only its I/O nets —
 * VCC/GND are package pins for wiring. Artwork is the shared `dip14` package SVG.
 * Solver routing: none working — the ngspice worker refuses decks with A-devices, so the circuit falls back to legacy MNA.
 * Not-here: blank DIP14 shells.
 *
 * Changelog:
 * - 09-10-2026 ? Moved to `src/components/IC/Logic Gates/`; fixed relative imports
 * - 09-10-2026 ? Moved from `src/parts/74hc20.ts` (tree reorganization)
 * - 09-10-2026 — Header: engine is eecircuit-engine (ngspice-45); A-device decks are refused
 * - 09-10-2026 — XSPICE engine removed; documented that 74HC.LIB decks have no working solver
 * - 08-10-2026 — Restored spiceStamp; XSPICE via dual-engine client routing
 * - 07-10-2026 — Inlined spiceStamp (dropped 74hcLogicStamp helper)
 * - 07-10-2026 — Pins via dipDevicePins; Changelog creation
 */
import type { PartModule } from '../../partModule';
import { dipDevicePins } from '../../../registry/packagePins';

/** Lib pinout `1 2 4 5 6;9 10 12 13 8` (in1..in4 out); NC 3, 11. */
const GATES = [
  ['1a', '1b', '1c', '1d', '1y'],
  ['2a', '2b', '2c', '2d', '2y'],
] as const;

export const hc20Module: PartModule = {
  type: '74hc20',

  definition: {
    type: '74hc20',
    label: '4 input NAND Gate (74HC20)',
    package: 'dip14',
    marking: 'chip',
    defaultPartLabel: ['Dual NAND', '74HC20'],
    pins: dipDevicePins('dip14', {
      1: { id: '1a', description: '1A' },
      2: { id: '1b', description: '1B' },
      3: { id: 'nc3', description: 'NC' },
      4: { id: '1c', description: '1C' },
      5: { id: '1d', description: '1D' },
      6: { id: '1y', description: '1Y' },
      7: { id: 'gnd', description: 'GND', type: 'ground' },
      8: { id: '2y', description: '2Y' },
      9: { id: '2a', description: '2A' },
      10: { id: '2b', description: '2B' },
      11: { id: 'nc11', description: 'NC' },
      12: { id: '2c', description: '2C' },
      13: { id: '2d', description: '2D' },
      14: { id: 'vcc', description: 'VCC', type: 'power' },
    }),
  },

  spiceStamp(ctx) {
    const resolved = ctx.resolveModel();
    const spiceName = resolved?.spiceName ?? '74HC20';
    const deviceLetter = resolved?.deviceLetter ?? 'X';
    for (let i = 0; i < GATES.length; i++) {
      const pins = GATES[i]!;
      const nets: number[] = [];
      let missing = false;
      for (const pinId of pins) {
        const n = ctx.pinNet(pinId);
        if (n === null) {
          missing = true;
          break;
        }
        nets.push(n);
      }
      if (missing) continue;
      const inst = `${deviceLetter}${ctx.sid}_g${i + 1}`;
      ctx.line(`${inst} ${nets.map((n) => ctx.node(n)).join(' ')} ${spiceName}`);
      ctx.instance(inst);
    }
  },
};

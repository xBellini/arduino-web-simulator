/**
 * What: 2 input AND Gate (74HC08) as a named DIP14 part — footprint, datasheet pinout, and SPICE
 * stamp using TI's behavioral SN74HC08 model (`Manufacturer/Texas Instruments/SN74HC08.cir`,
 * from TI SCLM228; catalog default for `74hc08`). One `X` instance per wired gate.
 * Owns/exports: `hc08Module` (`type: '74hc08'`).
 * Conventions: `dipDevicePins('dip14', …)`; TI subckt pin order is `Y A B VCC GND`, so every
 * gate instance is tied to the package VCC (pin 14) and GND (pin 7) nets. If either supply pin is
 * unwired the chip stamps nothing; a gate with any of A/B/Y unwired is skipped. The model's PSpice
 * TABLE / VSWITCH lines are rewritten by `pspiceCompat` in the ngspice worker.
 * Artwork is the shared `dip14` package SVG.
 * Not-here: blank DIP14 shells.
 *
# Changelog
# Date       | Author | Remarks
# 07-10-2026 | Cursor | Pins via dipDevicePins; Changelog creation
#                     | Inlined spiceStamp (dropped 74hcLogicStamp helper)
# 08-10-2026 | Cursor | Restored spiceStamp; XSPICE via dual-engine client routing
#                     | Document hybrid Concord↔XSPICE co-sim routing
# 09-10-2026 | Cursor | XSPICE engine + hybrid removed; documented that 74HC.LIB decks have no working solver
#                     | Header: engine is eecircuit-engine (ngspice-45); A-device decks are refused
#                     | Stamp TI SN74HC08 behavioral model (Y A B VCC GND) instead of XSPICE 74HC.LIB
#                     | Moved from `src/parts/74hc08.ts` (tree reorganization)
#                     | Moved to `src/components/IC/Logic Gates/`; fixed relative imports
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import type { PartModule } from '../../partModule';
import { dipDevicePins } from '../../../registry/packagePins';

/** Quad 2-input AND — lib pinout `1 2 3;4 5 6;9 10 8;12 13 11`. */
const GATES = [
  ['1a', '1b', '1y'],
  ['2a', '2b', '2y'],
  ['3a', '3b', '3y'],
  ['4a', '4b', '4y'],
] as const;

export const hc08Module: PartModule = {
  palette: { category: 'logic_gates', order: 40 },
  type: '74hc08',

  definition: {
    type: '74hc08',
    label: '2 input AND Gate (74HC08)',
    package: 'dip14',
    marking: 'chip',
    defaultPartLabel: ['Quad AND', '74HC08'],
    pins: dipDevicePins('dip14', {
      1: { id: '1a', description: '1A' },
      2: { id: '1b', description: '1B' },
      3: { id: '1y', description: '1Y' },
      4: { id: '2a', description: '2A' },
      5: { id: '2b', description: '2B' },
      6: { id: '2y', description: '2Y' },
      7: { id: 'gnd', description: 'GND', type: 'ground' },
      8: { id: '3y', description: '3Y' },
      9: { id: '3a', description: '3A' },
      10: { id: '3b', description: '3B' },
      11: { id: '4y', description: '4Y' },
      12: { id: '4a', description: '4A' },
      13: { id: '4b', description: '4B' },
      14: { id: 'vcc', description: 'VCC', type: 'power' },
    }),
  },

  spiceStamp(ctx) {
    const resolved = ctx.resolveModel();
    if (!resolved) return;
    // TI gate subckt: `Y A B VCC GND`. An unpowered package contributes nothing.
    const vcc = ctx.pinNet('vcc');
    const gnd = ctx.pinNet('gnd');
    if (vcc === null || gnd === null) return;
    for (let i = 0; i < GATES.length; i++) {
      const [a, b, y] = GATES[i]!.map((pinId) => ctx.pinNet(pinId));
      if (a == null || b == null || y == null) continue;
      const inst = `${resolved.deviceLetter}${ctx.sid}_g${i + 1}`;
      const nodes = [y, a, b, vcc, gnd].map((n) => ctx.node(n));
      ctx.line(`${inst} ${nodes.join(' ')} ${resolved.spiceName}`);
      ctx.instance(inst);
    }
  },
};

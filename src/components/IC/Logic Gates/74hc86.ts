/**
 * What: 2 input XOR Gate (74HC86) as a named DIP14 part — footprint, datasheet pinout, and SPICE
 * stamp using TI's behavioral SN74HC86 model (`Manufacturer/Texas Instruments/SN74HC86.cir`,
 * from TI SCLM206; catalog default for `74hc86`). One `X` instance per wired gate.
 * Owns/exports: `hc86Module` (`type: '74hc86'`).
 * Conventions: `dipDevicePins('dip14', …)`; TI subckt pin order is `Y A B VCC GND`, so every
 * gate instance is tied to the package VCC (pin 14) and GND (pin 7) nets. If either supply pin is
 * unwired the chip stamps nothing; a gate with any I/O pin unwired is skipped.
 * The model's PSpice TABLE / VSWITCH lines are rewritten by `pspiceCompat` in the ngspice worker.
 * Artwork is the shared `dip14` package SVG.
 * Not-here: blank DIP14 shells.
 *
# Changelog
# Date       | Author | Remarks
# 07-10-2026 | Cursor | Pins via dipDevicePins; Changelog creation
#                     | Inlined spiceStamp (dropped 74hcLogicStamp helper)
# 08-10-2026 | Cursor | Restored spiceStamp; XSPICE via dual-engine client routing
# 09-10-2026 | Cursor | XSPICE engine removed; documented that 74HC.LIB decks have no working solver
#                     | Header: engine is eecircuit-engine (ngspice-45); A-device decks are refused
#                     | Stamp TI SN74HC86 behavioral model (Y A B VCC GND) instead of XSPICE 74HC.LIB
#                     | Moved from `src/parts/74hc86.ts` (tree reorganization)
#                     | Moved to `src/components/IC/Logic Gates/`; fixed relative imports
 */
import type { PartModule } from '../../partModule';
import { dipDevicePins } from '../../../registry/packagePins';

/** Lib pinout `1 2 3;4 5 6;9 10 8;12 13 11`. */
const GATES = [
  ['1a', '1b', '1y'],
  ['2a', '2b', '2y'],
  ['3a', '3b', '3y'],
  ['4a', '4b', '4y'],
] as const;

export const hc86Module: PartModule = {
  type: '74hc86',

  definition: {
    type: '74hc86',
    label: '2 input XOR Gate (74HC86)',
    package: 'dip14',
    marking: 'chip',
    defaultPartLabel: ['Quad XOR', '74HC86'],
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
    // TI gate subckt: `Y <inputs> VCC GND`. An unpowered package contributes nothing.
    const vcc = ctx.pinNet('vcc');
    const gnd = ctx.pinNet('gnd');
    if (vcc === null || gnd === null) return;
    for (let i = 0; i < GATES.length; i++) {
      const nets = GATES[i]!.map((pinId) => ctx.pinNet(pinId));
      if (nets.some((n) => n == null)) continue;
      const y = nets[nets.length - 1]!;
      const inputs = nets.slice(0, -1) as number[];
      const inst = `${resolved.deviceLetter}${ctx.sid}_g${i + 1}`;
      const nodes = [y, ...inputs, vcc, gnd].map((n) => ctx.node(n));
      ctx.line(`${inst} ${nodes.join(' ')} ${resolved.spiceName}`);
      ctx.instance(inst);
    }
  },
};

/**
 * What: 3 input AND Gate (74HC11) as a named DIP14 part — footprint, datasheet pinout, and SPICE
 * stamp using TI's behavioral SN74HC11 model (`Manufacturer/Texas Instruments/SN74HC11.cir`,
 * from TI SCLM226; catalog default for `74hc11`). One `X` instance per wired gate.
 * Owns/exports: `hc11Module` (`type: '74hc11'`).
 * Conventions: `dipDevicePins('dip14', …)`; TI subckt pin order is `Y A B C VCC GND`, so every
 * gate instance is tied to the package VCC (pin 14) and GND (pin 7) nets. If either supply pin is
 * unwired the chip stamps nothing; a gate with any I/O pin unwired is skipped.
 * The model's PSpice TABLE / VSWITCH lines are rewritten by `pspiceCompat` in the ngspice worker.
 * Artwork is the shared `dip14` package SVG.
 * Not-here: blank DIP14 shells.
 *
 * Changelog:
 * - 09-10-2026 ? Moved to `src/components/IC/Logic Gates/`; fixed relative imports
 * - 09-10-2026 ? Moved from `src/parts/74hc11.ts` (tree reorganization)
 * - 09-10-2026 — Stamp TI SN74HC11 behavioral model (Y A B C VCC GND) instead of XSPICE 74HC.LIB
 * - 09-10-2026 — Header: engine is eecircuit-engine (ngspice-45); A-device decks are refused
 * - 09-10-2026 — XSPICE engine removed; documented that 74HC.LIB decks have no working solver
 * - 08-10-2026 — Restored spiceStamp; XSPICE via dual-engine client routing
 * - 07-10-2026 — Inlined spiceStamp (dropped 74hcLogicStamp helper)
 * - 07-10-2026 — Pins via dipDevicePins; Changelog creation
 */
import type { PartModule } from '../../partModule';
import { dipDevicePins } from '../../../registry/packagePins';

/** Lib pinout `1 2 13 12;3 4 5 6;9 10 11 8`. */
const GATES = [
  ['1a', '1b', '1c', '1y'],
  ['2a', '2b', '2c', '2y'],
  ['3a', '3b', '3c', '3y'],
] as const;

export const hc11Module: PartModule = {
  type: '74hc11',

  definition: {
    type: '74hc11',
    label: '3 input AND Gate (74HC11)',
    package: 'dip14',
    marking: 'chip',
    defaultPartLabel: ['Triple AND', '74HC11'],
    pins: dipDevicePins('dip14', {
      1: { id: '1a', description: '1A' },
      2: { id: '1b', description: '1B' },
      3: { id: '2a', description: '2A' },
      4: { id: '2b', description: '2B' },
      5: { id: '2c', description: '2C' },
      6: { id: '2y', description: '2Y' },
      7: { id: 'gnd', description: 'GND', type: 'ground' },
      8: { id: '3y', description: '3Y' },
      9: { id: '3a', description: '3A' },
      10: { id: '3b', description: '3B' },
      11: { id: '3c', description: '3C' },
      12: { id: '1y', description: '1Y' },
      13: { id: '1c', description: '1C' },
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

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
# Changelog
# Date       | Author | Remarks
# 07-10-2026 | Cursor | Pins via dipDevicePins; Changelog creation
#                     | Inlined spiceStamp (dropped 74hcLogicStamp helper)
# 08-10-2026 | Cursor | Restored spiceStamp; XSPICE via dual-engine client routing
# 09-10-2026 | Cursor | XSPICE engine removed; documented that 74HC.LIB decks have no working solver
#                     | Header: engine is eecircuit-engine (ngspice-45); A-device decks are refused
#                     | Moved from `src/parts/74hc20.ts` (tree reorganization)
#                     | Moved to `src/components/IC/Logic Gates/`; fixed relative imports
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
# 15-10-2026 | Codex | Add per-input SPICE probes and unavailable supply labels; legacy XSPICE model remains unsupported and has no supply terminals.
 */
import type { PartModule } from '../../partModule';
import { dipDevicePins } from '../../../registry/packagePins';

/** Lib pinout `1 2 4 5 6;9 10 12 13 8` (in1..in4 out); NC 3, 11. */
const GATES = [
  ['1a', '1b', '1c', '1d', '1y'],
  ['2a', '2b', '2c', '2d', '2y'],
] as const;

export const hc20Module: PartModule = {
  palette: { category: 'logic_gates', order: 70 },
  type: '74hc20',
  wireCurrentPath: pin => pin === 'vcc' || pin === 'gnd'
    ? { branch: pin, positive: 'vcc', negative: 'gnd' }
    : GATES.some(gate => gate.slice(0, -1).some(input => input === pin))
      ? { branch: pin, positive: pin, negative: 'gnd' } : undefined,

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
    if (!resolved) return;
    // This model has no supply terminals and requires unsupported XSPICE code models.
    for (let i = 0; i < GATES.length; i++) {
      const pins = GATES[i]!;
      const nets = pins.map(pin => ctx.pinNet(pin));
      if (nets.some(net => net === null)) continue;
      const inputNodes = nets.slice(0, -1).map((net, index) => {
        const pin = pins[index]!;
        const internal = `${ctx.sid}_${pin}`, sense = `V${ctx.sid}_${pin}_sense`;
        ctx.line(`${sense} ${ctx.node(net!)} ${internal} 0`);
        ctx.instance(sense, pin);
        return internal;
      });
      const output = ctx.node(nets[nets.length - 1]!);
      const inst = `${resolved.deviceLetter}${ctx.sid}_g${i + 1}`;
      const nodes = [...inputNodes, output];
      ctx.line(`${inst} ${nodes.join(' ')} ${resolved.spiceName}`);
    }
  },
};

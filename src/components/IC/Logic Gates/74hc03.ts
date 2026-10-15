/**
 * What: 2 input OC NAND Gate (74HC03) as a named DIP14 part — footprint, datasheet pinout, and SPICE
 * stamp using TI's behavioral SN74HC03 model (`Manufacturer/Texas Instruments/SN74HC03.cir`,
 * from TI SCLM233; catalog default for `74hc03`). One `X` instance per wired gate.
 * Owns/exports: `hc03Module` (`type: '74hc03'`).
 * Conventions: `dipDevicePins('dip14', …)`; TI subckt pin order is `Y A B VCC GND`, so every
 * gate instance is tied to the package VCC (pin 14) and GND (pin 7) nets. If either supply pin is
 * unwired the chip stamps nothing; a gate with any I/O pin unwired is skipped. Outputs are open drain (the model sinks only) — wire a pull-up.
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
#                     | Stamp TI SN74HC03 behavioral model (Y A B VCC GND) instead of XSPICE 74HC.LIB
#                     | Moved from `src/parts/74hc03.ts` (tree reorganization)
#                     | Moved to `src/components/IC/Logic Gates/`; fixed relative imports
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
# 15-10-2026 | Codex | Expose SPICE probes for every wired input and separate package VCC/GND currents; preserve model pin order and small-current labels.
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

export const hc03Module: PartModule = {
  palette: { category: 'logic_gates', order: 20 },
  type: '74hc03',
  wireCurrentPath: pin => pin === 'vcc' || pin === 'gnd'
    ? { branch: pin, positive: 'vcc', negative: 'gnd' }
    : GATES.some(gate => gate.slice(0, -1).some(input => input === pin))
      ? { branch: pin, positive: pin, negative: 'gnd' } : undefined,

  definition: {
    type: '74hc03',
    label: '2 input OC NAND Gate (74HC03)',
    package: 'dip14',
    marking: 'chip',
    defaultPartLabel: ['Quad OC NAND', '74HC03'],
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
    const vcc = ctx.pinNet('vcc'), gnd = ctx.pinNet('gnd');
    if (vcc === null || gnd === null) return;
    let supplySensed = false;
    const internalVcc = `${ctx.sid}_vcc`, internalGnd = `${ctx.sid}_gnd`;
    for (let i = 0; i < GATES.length; i++) {
      const pins = GATES[i]!;
      const nets = pins.map(pin => ctx.pinNet(pin));
      if (nets.some(net => net === null)) continue;
      if (!supplySensed) {
        const vccSense = `V${ctx.sid}_vcc_sense`, gndSense = `V${ctx.sid}_gnd_sense`;
        ctx.line(`${vccSense} ${ctx.node(vcc)} ${internalVcc} 0`);
        ctx.line(`${gndSense} ${internalGnd} ${ctx.node(gnd)} 0`);
        ctx.instance(vccSense, 'vcc');
        ctx.instance(gndSense, 'gnd');
        supplySensed = true;
      }
      const inputNodes = nets.slice(0, -1).map((net, index) => {
        const pin = pins[index]!;
        const internal = `${ctx.sid}_${pin}`, sense = `V${ctx.sid}_${pin}_sense`;
        ctx.line(`${sense} ${ctx.node(net!)} ${internal} 0`);
        ctx.instance(sense, pin);
        return internal;
      });
      const output = ctx.node(nets[nets.length - 1]!);
      const inst = `${resolved.deviceLetter}${ctx.sid}_g${i + 1}`;
      const nodes = [output, ...inputNodes, internalVcc, internalGnd];
      ctx.line(`${inst} ${nodes.join(' ')} ${resolved.spiceName}`);
    }
  },
};

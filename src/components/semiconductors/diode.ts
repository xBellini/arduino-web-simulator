/**
 * What: Everything the simulator knows about a signal diode, in one file.
 * Role: part module — footprint, SPICE catalog or synthetic D model, digital conduction
 * flag + cathode drive, glow visual, and series path for wire flow.
 * Owns/exports: `diodeModule`.
 * Conventions: conduction threshold is 0.55 V on the digital overlay (the SPICE model is
 * a real diode). Glow is on/off from that flag — there is no brightness curve.
 * To pick a catalog part: set `spiceModelId` on the placed instance (default 1N4148).
 * Not-here: the LED, which has Vf/If properties and a blow model of its own.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/parts/diode.ts` (tree reorganization)
 * - 17-09-2026 — Changelog creation / migrated out of the per-subsystem type switches
 */
import type { PartModule } from '../partModule';

export const diodeModule: PartModule = {
  type: 'diode',

  definition: {
    type: 'diode',
    label: 'Diode',
    scale: 1.5,
    artwork: '/components/diode.svg',
    pins: [
      { id: 'anode', description: 'Anode', x: 5, y: 0, type: 'digital' },
      { id: 'cathode', description: 'Cathode', x: 5, y: 43, type: 'digital' },
    ],
  },

  spiceStamp(ctx) {
    const na = ctx.pinNet('anode');
    const nk = ctx.pinNet('cathode');
    if (na === null || nk === null) return;
    const resolved = ctx.resolveModel();
    if (resolved) {
      const inst = `${resolved.deviceLetter}${ctx.sid}`;
      ctx.line(`${inst} ${ctx.node(na)} ${ctx.node(nk)} ${resolved.spiceName}`);
      ctx.instance(inst);
      return;
    }
    const model = `DIO_${ctx.sid}`;
    ctx.model(`.model ${model} D (Is=1e-14 N=1.0 Rs=0.5)`);
    ctx.line(`D${ctx.sid} ${ctx.node(na)} ${ctx.node(nk)} ${model}`);
    ctx.instance(`D${ctx.sid}`);
  },

  evaluate(ctx) {
    const nA = ctx.pinNet('anode');
    const nK = ctx.pinNet('cathode');
    const vA = ctx.levelVolts(ctx.netLevel(nA));
    const vK = ctx.levelVolts(ctx.netLevel(nK));
    const conducting = vA - vK >= 0.55;
    ctx.flags.diodeConducting[ctx.comp.id] = conducting;
    if (conducting && nK !== null && ctx.netLevel(nK) !== 'high') {
      ctx.drive(nK, 'high', 2);
    }
  },

  visuals(ctx) {
    ctx.flags.diodeGlowLevel[ctx.comp.id] = ctx.flags.diodeConducting[ctx.comp.id]
      ? 1
      : 0;
  },

  seriesPins(_comp, pinId) {
    if (pinId === 'anode') return ['cathode'];
    if (pinId === 'cathode') return ['anode'];
    return [];
  },
};

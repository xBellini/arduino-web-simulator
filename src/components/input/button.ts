/**
 * What: Everything the simulator knows about the four-pin tactile push button.
 * Role: part module — footprint, SPICE/legacy resistor network (leg shorts + contact),
 * digital net unions, series path for wire flow, and the ngspice cache key for press state.
 * Owns/exports: `buttonModule`.
 * Conventions: 1a↔1b and 2a↔2b are always shorted (~1 mΩ). The contact is 1a↔2a
 * (~1 mΩ pressed, 1 GΩ open). Unwired columns get a 1 TΩ bleed to ground so .OP is
 * not singular. The digital overlay also unions those pins unless `spiceButtonModel`
 * is true (today the overlay always runs so SPICE and digital stay aligned).
 * To change contact feel: the ohm constants below must match in spiceStamp and
 * legacyStamp — they are the same numbers on purpose.
 * Not-here: pointer-down while sim runs (`SimCanvas` calls `setButtonPressed`).
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 09-10-2026 | Cursor | Moved from `src/parts/button.ts` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import type { SpiceStampCtx } from '../partModule';
import type { PartModule } from '../partModule';
import { BLOWN_RESISTOR_OHMS } from '../passives/resistor';

const LEG_R_OHMS = 0.001;
const CONTACT_CLOSED_OHMS = 0.001;
const CONTACT_OPEN_OHMS = BLOWN_RESISTOR_OHMS;
const FLOAT_BLEED_OHMS = 1e12;
const MIN_WIRE_CURRENT_MA = 0.05;

function columnExternallyWired(ctx: SpiceStampCtx, pins: readonly string[]): boolean {
  for (const pinId of pins) {
    const netId = ctx.pinNet(pinId);
    if (netId === null) continue;
    for (const ep of ctx.netlist.nets.get(netId) ?? []) {
      if (ep.componentId !== ctx.comp.id) return true;
    }
  }
  return false;
}

export const buttonModule: PartModule = {
  palette: { category: 'input', order: 0 },
  type: 'button',
  ensurePins: ['1a', '1b', '2a', '2b'],

  definition: {
    type: 'button',
    label: 'Push Button',
    scale: 1,
    artwork: '/components/button.svg',
    pins: [
      { id: '1a', description: '1a', x: 14, y: 0, type: 'digital' },
      { id: '2a', description: '2a', x: 50, y: 0, type: 'digital' },
      { id: '1b', description: '1b', x: 14, y: 54, type: 'digital' },
      { id: '2b', description: '2b', x: 50, y: 54, type: 'digital' },
    ],
  },

  spiceStamp(ctx) {
    const n1a = ctx.pinNet('1a');
    const n1b = ctx.pinNet('1b');
    const n2a = ctx.pinNet('2a');
    const n2b = ctx.pinNet('2b');
    if (n1a === null || n1b === null || n2a === null || n2b === null) return;
    ctx.line(`R${ctx.sid}_1 ${ctx.node(n1a)} ${ctx.node(n1b)} ${LEG_R_OHMS}`);
    ctx.line(`R${ctx.sid}_2 ${ctx.node(n2a)} ${ctx.node(n2b)} ${LEG_R_OHMS}`);
    const contactR = ctx.buttonPressed[ctx.comp.id]
      ? CONTACT_CLOSED_OHMS
      : CONTACT_OPEN_OHMS;
    const contactInst = `R${ctx.sid}c`;
    ctx.line(`${contactInst} ${ctx.node(n1a)} ${ctx.node(n2a)} ${contactR}`);
    ctx.instance(contactInst);
    if (!columnExternallyWired(ctx, ['1a', '1b'])) {
      ctx.line(`R${ctx.sid}_gl ${ctx.node(n1a)} 0 ${FLOAT_BLEED_OHMS}`);
    }
    if (!columnExternallyWired(ctx, ['2a', '2b'])) {
      ctx.line(`R${ctx.sid}_gr ${ctx.node(n2a)} 0 ${FLOAT_BLEED_OHMS}`);
    }
  },

  spiceCacheKey({ comp, buttonPressed }) {
    return buttonPressed[comp.id] ? 'pressed' : 'open';
  },

  legacyStamp(ctx) {
    const n1a = ctx.pinNet('1a');
    const n1b = ctx.pinNet('1b');
    const n2a = ctx.pinNet('2a');
    const n2b = ctx.pinNet('2b');
    if (n1a === null || n1b === null || n2a === null || n2b === null) return;
    ctx.stampResistor(n1a, n1b, LEG_R_OHMS);
    ctx.stampResistor(n2a, n2b, LEG_R_OHMS);
    ctx.stampResistor(
      n1a,
      n2a,
      ctx.buttonPressed[ctx.comp.id] ? CONTACT_CLOSED_OHMS : CONTACT_OPEN_OHMS,
    );
  },

  netUnions(ctx) {
    if (ctx.spiceButtonModel) return;
    if (ctx.phase === 'static') {
      const n1a = ctx.pinNet('1a');
      const n1b = ctx.pinNet('1b');
      const n2a = ctx.pinNet('2a');
      const n2b = ctx.pinNet('2b');
      if (n1a !== null && n1b !== null) ctx.union(n1a, n1b);
      if (n2a !== null && n2b !== null) ctx.union(n2a, n2b);
      return;
    }
    if (!ctx.buttonPressed[ctx.comp.id]) return;
    const n1 = ctx.pinNet('1a');
    const n2 = ctx.pinNet('2a');
    if (n1 !== null && n2 !== null) ctx.union(n1, n2);
  },

  branchCurrentPass: 4,
  branchCurrent(ctx) {
    const pinNets = (['1a', '1b', '2a', '2b'] as const)
      .map((p) => ctx.pinNet(p))
      .filter((n): n is number => n !== null);
    if (pinNets.length === 0) return;
    const spiceMa = ctx.branchCurrentMa?.[ctx.comp.id];
    let iMa = spiceMa !== undefined && spiceMa >= MIN_WIRE_CURRENT_MA ? spiceMa : 0;
    if (iMa <= 0) {
      for (const n of pinNets) {
        const existing = ctx.netMa(n);
        if (existing !== undefined && existing > iMa) iMa = existing;
      }
    }
    if (iMa < MIN_WIRE_CURRENT_MA) return;
    for (const n of pinNets) {
      if (ctx.netMa(n) === undefined) ctx.setNetMa(n, iMa);
    }
  },

  seriesPins(comp, pinId, flags) {
    const pressed = flags.buttonPressed?.[comp.id];
    if (pinId === '1a') return pressed ? ['1b', '2a'] : ['1b'];
    if (pinId === '1b') return ['1a'];
    if (pinId === '2a') return pressed ? ['2b', '1a'] : ['2b'];
    if (pinId === '2b') return ['2a'];
    return [];
  },
};

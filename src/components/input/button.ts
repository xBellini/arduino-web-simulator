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
# Date       | Author  | Remarks
# 17-09-2026 | Cursor  | Changelog creation / migrated out of the per-subsystem type switches
# 09-10-2026 | Cursor  | Moved from `src/parts/button.ts` (tree reorganization)
# 13-10-2026 | Codex   | Declare palette category/order beside this part; preserve placement order and electrical behavior.
# 15-10-2026 | Bellini | Adjusted button scale to 2
					   | Corrected pin coordinates
# 15-10-2026 | Codex | Sense each button terminal in SPICE; remove net-wide current copying and preserve leakage currents.
 */
import type { SpiceStampCtx } from '../partModule';
import type { PartModule } from '../partModule';
import { BLOWN_RESISTOR_OHMS } from '../passives/resistor';

const LEG_R_OHMS = 0.001;
const CONTACT_CLOSED_OHMS = 0.001;
const CONTACT_OPEN_OHMS = BLOWN_RESISTOR_OHMS;
const FLOAT_BLEED_OHMS = 1e12;

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
    scale: 2,
    artwork: '/components/button.svg',
    pins: [
      { id: '1a', description: '1a', x: 2, y: 0, type: 'digital' },
      { id: '2a', description: '2a', x: 22, y: 0, type: 'digital' },
      { id: '1b', description: '1b', x: 2, y: 32, type: 'digital' },
      { id: '2b', description: '2b', x: 22, y: 32, type: 'digital' },
    ],
  },

  spiceStamp(ctx) {
    const n1a = ctx.pinNet('1a');
    const n1b = ctx.pinNet('1b');
    const n2a = ctx.pinNet('2a');
    const n2b = ctx.pinNet('2b');
    if (n1a === null || n1b === null || n2a === null || n2b === null) return;
    // Independent zero-volt terminal probes preserve splits at shared pins.
    const terminals = new Map<string, string>();
    for (const [pin, net] of [['1a', n1a], ['1b', n1b], ['2a', n2a], ['2b', n2b]] as const) {
      const internal = ctx.sid + '_' + pin;
      const probe = 'V' + internal;
      ctx.line(probe + ' ' + ctx.node(net) + ' ' + internal + ' 0');
      ctx.instance(probe, 'terminal:' + pin);
      terminals.set(pin, internal);
    }
    ctx.line(`R${ctx.sid}_1 ${terminals.get('1a')} ${terminals.get('1b')} ${LEG_R_OHMS}`);
    ctx.line(`R${ctx.sid}_2 ${terminals.get('2a')} ${terminals.get('2b')} ${LEG_R_OHMS}`);
    const contactR = ctx.buttonPressed[ctx.comp.id]
      ? CONTACT_CLOSED_OHMS
      : CONTACT_OPEN_OHMS;
    const contactInst = `R${ctx.sid}c`;
    ctx.line(`${contactInst} ${terminals.get('1a')} ${terminals.get('2a')} ${contactR}`);
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

  seriesPins(comp, pinId, flags) {
    const pressed = flags.buttonPressed?.[comp.id];
    if (pinId === '1a') return pressed ? ['1b', '2a'] : ['1b'];
    if (pinId === '1b') return ['1a'];
    if (pinId === '2a') return pressed ? ['2b', '1a'] : ['2b'];
    if (pinId === '2b') return ['2a'];
    return [];
  },
};

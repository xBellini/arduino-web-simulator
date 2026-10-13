/**
 * What: Everything the simulator knows about an NPN BJT (TO-style, C-B-E pin order).
 * Role: part module — footprint, SPICE Q / catalog model, digital on-flag, C–E union when on.
 * Owns/exports: `transistorNpnModule`.
 * Conventions: "on" is Vbe ≥ 0.55 V with collector not floating. The overlay then shorts
 * collector to emitter so a load on C sees the emitter net. No analog beta model in the
 * digital pass — SPICE owns the analog behaviour.
 * To change the default catalog part: spice/models.ts (2N2222).
 * Not-here: PNP, which has E-B-C pin order and inverted Vbe.
 *
 * Conventions: shared `to92` package SVG; C-B-E left→right via `to92DevicePins`.
 * Body marking is two lines (`['2N2222', 'NPN']`). Scale inherits from the TO-92 shell.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 24-09-2026 | Cursor | Migrated to `package: 'to92'` + chip marking
#                     | Pin list inlined (NE555-style); casing from pin labels
# 25-09-2026 | Cursor | to92DevicePins; letter + description; array defaultPartLabel
# 09-10-2026 | Cursor | Moved from `src/parts/transistorNpn.ts` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import type { PartModule } from '../partModule';
import { to92DevicePins } from '../../registry/packagePins';

export const transistorNpnModule: PartModule = {
  palette: { category: 'semiconductors', order: 10 },
  type: 'transistor_npn',

  definition: {
    type: 'transistor_npn',
    label: 'NPN Transistor',
    package: 'to92',
    marking: 'chip',
    defaultPartLabel: ['2N2222', 'NPN'],
    pins: to92DevicePins([
      { id: 'c', letter: 'C', description: 'Collector' },
      { id: 'b', letter: 'B', description: 'Base' },
      { id: 'e', letter: 'E', description: 'Emitter' },
    ]),
  },

  spiceStamp(ctx) {
    const nc = ctx.pinNet('c');
    const nb = ctx.pinNet('b');
    const ne = ctx.pinNet('e');
    if (nc === null || nb === null || ne === null) return;
    const resolved = ctx.resolveModel();
    if (resolved) {
      const inst = `${resolved.deviceLetter}${ctx.sid}`;
      ctx.line(
        `${inst} ${ctx.node(nc)} ${ctx.node(nb)} ${ctx.node(ne)} ${resolved.spiceName}`,
      );
      ctx.instance(inst);
      return;
    }
    const model = `NPN_${ctx.sid}`;
    ctx.model(`.model ${model} NPN (Is=1e-15 Bf=100 Br=5 Vaf=100)`);
    ctx.line(`Q${ctx.sid} ${ctx.node(nc)} ${ctx.node(nb)} ${ctx.node(ne)} ${model}`);
    ctx.instance(`Q${ctx.sid}`);
  },

  evaluate(ctx) {
    const vB = ctx.levelVolts(ctx.netLevel(ctx.pinNet('b')));
    const vE = ctx.levelVolts(ctx.netLevel(ctx.pinNet('e')));
    const nC = ctx.pinNet('c');
    ctx.flags.transistorOn[ctx.comp.id] =
      vB - vE >= 0.55 && ctx.netLevel(nC) !== 'floating';
  },

  netUnions(ctx) {
    if (ctx.phase !== 'dynamic') return;
    if (!ctx.transistorOn[ctx.comp.id]) return;
    const nc = ctx.pinNet('c');
    const ne = ctx.pinNet('e');
    if (nc !== null && ne !== null) ctx.union(nc, ne);
  },
};

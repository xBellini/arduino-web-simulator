/**
 * What: Everything the simulator knows about an N-channel MOSFET (TO-220, G-D-S).
 * Role: part module — footprint, SPICE M / catalog model, digital on-flag, D–S union when on.
 * Owns/exports: `mosfetNModule`.
 * Conventions: "on" is Vgs ≥ 2 V with drain not floating. Substrate is tied to source
 * in the SPICE stamp (four-terminal MOSFET with bulk = source).
 * To change the default catalog part: spice/models.ts (2N7002).
 * Not-here: P-MOSFET (inverted Vgs, VTO negative).
 *
 * Conventions: shared `to220` package SVG; G-D-S left→right via `to220DevicePins`.
 * Body marking is two lines (`['2N7002', 'N-MOS']`). Scale inherits from the TO-220 shell.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 24-09-2026 | Cursor | Migrated to `package: 'to220'` + chip marking
#                     | Pin list inlined (NE555-style); casing from pin labels
# 25-09-2026 | Cursor | to220DevicePins; letter + description; array defaultPartLabel
# 09-10-2026 | Cursor | Moved from `src/parts/mosfetN.ts` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import type { PartModule } from '../partModule';
import { to220DevicePins } from '../../registry/packagePins';

export const mosfetNModule: PartModule = {
  palette: { category: 'semiconductors', order: 30 },
  type: 'mosfet_n',

  definition: {
    type: 'mosfet_n',
    label: 'N-MOSFET',
    package: 'to220',
    marking: 'chip',
    defaultPartLabel: ['2N7002', 'N-MOS'],
    pins: to220DevicePins([
      { id: 'gate', letter: 'G', description: 'Gate' },
      { id: 'drain', letter: 'D', description: 'Drain' },
      { id: 'source', letter: 'S', description: 'Source' },
    ]),
  },

  spiceStamp(ctx) {
    const nd = ctx.pinNet('drain');
    const ng = ctx.pinNet('gate');
    const ns = ctx.pinNet('source');
    if (nd === null || ng === null || ns === null) return;
    const sn = ctx.node(ns);
    const resolved = ctx.resolveModel();
    if (resolved) {
      const inst = `${resolved.deviceLetter}${ctx.sid}`;
      ctx.line(
        `${inst} ${ctx.node(nd)} ${ctx.node(ng)} ${sn} ${sn} ${resolved.spiceName}`,
      );
      ctx.instance(inst);
      return;
    }
    const model = `NMOS_${ctx.sid}`;
    ctx.model(`.model ${model} NMOS (VTO=2 KP=20u)`);
    ctx.line(`M${ctx.sid} ${ctx.node(nd)} ${ctx.node(ng)} ${sn} ${sn} ${model}`);
    ctx.instance(`M${ctx.sid}`);
  },

  evaluate(ctx) {
    const vG = ctx.levelVolts(ctx.netLevel(ctx.pinNet('gate')));
    const vS = ctx.levelVolts(ctx.netLevel(ctx.pinNet('source')));
    const nD = ctx.pinNet('drain');
    ctx.flags.mosfetOn[ctx.comp.id] =
      vG - vS >= 2 && ctx.netLevel(nD) !== 'floating';
  },

  netUnions(ctx) {
    if (ctx.phase !== 'dynamic') return;
    if (!ctx.mosfetOn[ctx.comp.id]) return;
    const nd = ctx.pinNet('drain');
    const ns = ctx.pinNet('source');
    if (nd !== null && ns !== null) ctx.union(nd, ns);
  },
};

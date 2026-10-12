/**
 * What: Everything the simulator knows about a PNP BJT (TO-92 E-B-C pin order).
 * Role: part module — footprint, SPICE Q / catalog model, digital on-flag, C–E union when on.
 * Owns/exports: `transistorPnpModule`.
 * Conventions: "on" is Veb ≥ 0.55 V with collector not floating. Pin ids are still
 * `e`/`b`/`c` even though the physical order on the package is E-B-C left to right.
 * To change the default catalog part: spice/models.ts (2N2907).
 * Not-here: NPN.
 *
 * Conventions: shared `to92` package SVG; E-B-C left→right via `to92DevicePins`.
 * Body marking is two lines (`['2N2907', 'PNP']`). Scale inherits from the TO-92 shell.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/parts/transistorPnp.ts` (tree reorganization)
 * - 25-09-2026 — to92DevicePins; letter + description; array defaultPartLabel
 * - 24-09-2026 — Pin list inlined (NE555-style); casing from pin labels
 * - 24-09-2026 — Migrated to `package: 'to92'` + chip marking
 * - 17-09-2026 — Changelog creation / migrated out of the per-subsystem type switches
 */
import type { PartModule } from '../partModule';
import { to92DevicePins } from '../../registry/packagePins';

export const transistorPnpModule: PartModule = {
  type: 'transistor_pnp',

  definition: {
    type: 'transistor_pnp',
    label: 'PNP Transistor',
    package: 'to92',
    marking: 'chip',
    defaultPartLabel: ['2N2907', 'PNP'],
    pins: to92DevicePins([
      { id: 'e', letter: 'E', description: 'Emitter' },
      { id: 'b', letter: 'B', description: 'Base' },
      { id: 'c', letter: 'C', description: 'Collector' },
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
    const model = `PNP_${ctx.sid}`;
    ctx.model(`.model ${model} PNP (Is=1e-15 Bf=100 Br=5 Vaf=100)`);
    ctx.line(`Q${ctx.sid} ${ctx.node(nc)} ${ctx.node(nb)} ${ctx.node(ne)} ${model}`);
    ctx.instance(`Q${ctx.sid}`);
  },

  evaluate(ctx) {
    const vB = ctx.levelVolts(ctx.netLevel(ctx.pinNet('b')));
    const vE = ctx.levelVolts(ctx.netLevel(ctx.pinNet('e')));
    const nC = ctx.pinNet('c');
    ctx.flags.transistorOn[ctx.comp.id] =
      vE - vB >= 0.55 && ctx.netLevel(nC) !== 'floating';
  },

  netUnions(ctx) {
    if (ctx.phase !== 'dynamic') return;
    if (!ctx.transistorOn[ctx.comp.id]) return;
    const nc = ctx.pinNet('c');
    const ne = ctx.pinNet('e');
    if (nc !== null && ne !== null) ctx.union(nc, ne);
  },
};

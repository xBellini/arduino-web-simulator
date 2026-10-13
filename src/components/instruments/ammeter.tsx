/**
 * What: Everything the simulator knows about the series ammeter, in one file.
 * Role: part module — footprint, 1 mΩ SPICE/legacy shunt, digital in↔out union, reading,
 * series path, and the front-panel overlay.
 * Owns/exports: `ammeterModule`.
 * Conventions: the shunt is 0.001 Ω so the meter is almost a short. Wire current uses the
 * same series-pass as resistors (pass 0) so neighbouring nets see the measured current.
 * To change burden voltage: the 0.001 Ω stamp in spiceStamp and legacyStamp together.
 * Not-here: voltmeter or ohmmeter.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 30-09-2026 | Cursor | Corrected pin coordinates
# 09-10-2026 | Cursor | Moved from `src/parts/ammeter.tsx` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import { formatCurrentMa } from '../../values/electric';
import type { PartModule } from '../partModule';
import { InstrumentReadout } from '../overlayKit';

const SHUNT_OHMS = 0.001;
const MIN_WIRE_CURRENT_MA = 0.05;

export const ammeterModule: PartModule = {
  palette: { category: 'instruments', order: 20 },
  type: 'ammeter',

  definition: {
    type: 'ammeter',
    label: 'Ammeter',
    scale: 2,
    artwork: '/components/ammeter.svg',
    pins: [
      { id: 'in', description: 'IN', x: 0, y: 13, type: 'digital' },
      { id: 'out', description: 'OUT', x: 75, y: 13, type: 'digital' },
    ],
  },

  spiceStamp(ctx) {
    const na = ctx.pinNet('in');
    const nb = ctx.pinNet('out');
    if (na === null || nb === null) return;
    ctx.line(`R${ctx.sid} ${ctx.node(na)} ${ctx.node(nb)} ${SHUNT_OHMS}`);
    ctx.instance(`R${ctx.sid}`);
  },

  legacyStamp(ctx) {
    const na = ctx.pinNet('in');
    const nb = ctx.pinNet('out');
    if (na === null || nb === null) return;
    ctx.stampResistor(na, nb, SHUNT_OHMS);
  },

  netUnions(ctx) {
    if (ctx.phase !== 'static') return;
    const nIn = ctx.pinNet('in');
    const nOut = ctx.pinNet('out');
    if (nIn !== null && nOut !== null) ctx.union(nIn, nOut);
  },

  readings(ctx) {
    const spiceMa = ctx.branchCurrentMa?.[ctx.comp.id];
    if (spiceMa !== undefined) {
      ctx.flags.ammeterReading[ctx.comp.id] = spiceMa;
      return;
    }
    const nIn = ctx.pinNet('in');
    ctx.flags.ammeterReading[ctx.comp.id] =
      nIn === null ? 0 : ctx.netCurrentMa(nIn);
  },

  branchCurrentPass: 0,
  branchCurrent(ctx) {
    const estimatedMa = ctx.resistorMa(ctx.comp);
    const spiceMa = ctx.branchCurrentMa?.[ctx.comp.id];
    const iMa =
      spiceMa !== undefined && spiceMa >= MIN_WIRE_CURRENT_MA ? spiceMa : estimatedMa;
    if (iMa <= 0) return;
    const na = ctx.pinNet('in');
    const nb = ctx.pinNet('out');
    if (na !== null) ctx.setNetMa(na, iMa);
    if (nb !== null) ctx.setNetMa(nb, iMa);
  },

  seriesPins(_comp, pinId) {
    if (pinId === 'in') return ['out'];
    if (pinId === 'out') return ['in'];
    return [];
  },

  overlay: ({ component, simFlags, simRunning }) => (
    <InstrumentReadout
      x={17}
      y={3}
      width={40}
      height={18}
      label="A"
      value={
        simRunning && simFlags?.ammeterReading[component.id] !== undefined
          ? formatCurrentMa(simFlags.ammeterReading[component.id]!)
          : '---'
      }
    />
  ),
};

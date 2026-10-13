/**
 * What: Everything the simulator knows about the two-probe ohmmeter, in one file.
 * Role: part module — footprint, reading (Ω across a single resistor or OL/short), overlay.
 * Owns/exports: `ohmmeterModule`.
 * Conventions: only reports a number when the probes sit directly across one resistor.
 * High vs low on the two probes with no matching resistor is `OL`. Same-level non-floating
 * nets report `0 Ω`. Ideal meter: no SPICE stamp.
 * To support measuring other parts: extend `readings` (keep the display string in sync).
 * Not-here: voltmeter or ammeter.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 30-09-2026 | Cursor | Corrected pin coordinates
# 09-10-2026 | Cursor | Moved from `src/parts/ohmmeter.tsx` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import {
  DEFAULT_RESISTANCE_UNIT,
  DEFAULT_RESISTANCE_VALUE,
  resistanceToOhms,
} from '../../values/resistor';
import { formatResistance } from '../../values/electric';
import type { PartModule } from '../partModule';
import { InstrumentReadout } from '../overlayKit';
import { MNA_OHM_FLOOR } from '../passives/resistor';

export const ohmmeterModule: PartModule = {
  palette: { category: 'instruments', order: 30 },
  type: 'ohmmeter',

  definition: {
    type: 'ohmmeter',
    label: 'Ohmmeter',
    scale: 2,
    artwork: '/components/ohmmeter.svg',
    pins: [
      { id: 'probe_pos', description: '+', x: 24, y: 47, type: 'digital' },
      { id: 'probe_neg', description: '−', x: 42, y: 47, type: 'digital' },
    ],
  },

  readings(ctx) {
    const nP = ctx.pinNet('probe_pos');
    const nN = ctx.pinNet('probe_neg');
    const id = ctx.comp.id;
    if (nP === null || nN === null) {
      ctx.flags.ohmmeterReading[id] = null;
      ctx.flags.ohmmeterDisplay[id] = '---';
      return;
    }
    if (nP === nN) {
      ctx.flags.ohmmeterReading[id] = 0;
      ctx.flags.ohmmeterDisplay[id] = '0 Ω';
      return;
    }

    for (const target of ctx.components) {
      if (target.type !== 'resistor') continue;
      const ra = ctx.netOfPin(target.id, 'a');
      const rb = ctx.netOfPin(target.id, 'b');
      if ((nP === ra && nN === rb) || (nP === rb && nN === ra)) {
        const value = target.resistanceValue ?? DEFAULT_RESISTANCE_VALUE;
        const unit = target.resistanceUnit ?? DEFAULT_RESISTANCE_UNIT;
        const ohms = Math.max(MNA_OHM_FLOOR, resistanceToOhms(value, unit));
        ctx.flags.ohmmeterReading[id] = ohms;
        ctx.flags.ohmmeterDisplay[id] =
          ohms >= 1000 ? `${(ohms / 1000).toFixed(2)} kΩ` : `${ohms.toFixed(0)} Ω`;
        return;
      }
    }

    const lP = ctx.netLevel(nP);
    const lN = ctx.netLevel(nN);
    if (lP === 'high' && lN === 'low') {
      ctx.flags.ohmmeterReading[id] = null;
      ctx.flags.ohmmeterDisplay[id] = 'OL';
      return;
    }
    if (lP === 'low' && lN === 'high') {
      ctx.flags.ohmmeterReading[id] = null;
      ctx.flags.ohmmeterDisplay[id] = 'OL';
      return;
    }
    if (lP === lN && lP !== 'floating') {
      ctx.flags.ohmmeterReading[id] = 0;
      ctx.flags.ohmmeterDisplay[id] = '0 Ω';
      return;
    }
    ctx.flags.ohmmeterReading[id] = null;
    ctx.flags.ohmmeterDisplay[id] = '---';
  },

  overlay: ({ component, simFlags, simRunning }) => (
    <InstrumentReadout
      x={6.75}
      y={6.75}
      width={52}
      height={24}
      label="Ω"
      value={
        simRunning
          ? (simFlags?.ohmmeterDisplay[component.id] ??
            (simFlags?.ohmmeterReading[component.id] !== undefined
              ? formatResistance(simFlags.ohmmeterReading[component.id]!)
              : '---'))
          : '---'
      }
    />
  ),
};

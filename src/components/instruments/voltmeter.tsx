/**
 * What: Everything the simulator knows about the two-probe voltmeter, in one file.
 * Role: part module — footprint, reading from solved net voltages (or digital levels),
 * and the front-panel overlay. Ideal meter: no SPICE stamp, no load on the nets.
 * Owns/exports: `voltmeterModule`.
 * Conventions: reading is V(probe_pos) − V(probe_neg). Prefers ngspice node voltages.
 * To change the display format: `values/electric.formatVoltage`.
 * Not-here: ammeter (series shunt) or ohmmeter (resistor probe).
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/parts/voltmeter.tsx` (tree reorganization)
 * - 30-09-2026 - Corrected pin coordinates
 * - 17-09-2026 — Changelog creation / migrated out of the per-subsystem type switches
 */
import { formatVoltage } from '../../values/electric';
import type { PartModule } from '../partModule';
import { InstrumentReadout } from '../overlayKit';

export const voltmeterModule: PartModule = {
  type: 'voltmeter',

  definition: {
    type: 'voltmeter',
    label: 'Voltmeter',
    scale: 2,
    artwork: '/components/voltmeter.svg',
    pins: [
      { id: 'probe_pos', description: '+', x: 24, y: 47, type: 'digital' },
      { id: 'probe_neg', description: '−', x: 42, y: 47, type: 'digital' },
    ],
  },

  readings(ctx) {
    const nP = ctx.pinNet('probe_pos');
    const nN = ctx.pinNet('probe_neg');
    const vP =
      nP !== null && ctx.netVoltages?.has(nP)
        ? ctx.netVoltages.get(nP)!
        : ctx.levelVolts(ctx.netLevel(nP));
    const vN =
      nN !== null && ctx.netVoltages?.has(nN)
        ? ctx.netVoltages.get(nN)!
        : ctx.levelVolts(ctx.netLevel(nN));
    ctx.flags.voltmeterReading[ctx.comp.id] = vP - vN;
  },

  overlay: ({ component, simFlags, simRunning }) => (
    <InstrumentReadout
      x={6.75}
      y={6.75}
      width={52}
      height={24}
      label="V"
      value={
        simRunning && simFlags?.voltmeterReading[component.id] !== undefined
          ? formatVoltage(simFlags.voltmeterReading[component.id]!)
          : '---'
      }
    />
  ),
};

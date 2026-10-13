/**
 * What: Everything the simulator knows about the bench power supply, in one file.
 * Role: part module — footprint, SPICE V-source, legacy fixed-node voltages, digital drive,
 * the CC-mode readout, flow-trace pin roles, saved-file fields, and the front-panel overlay.
 * Owns/exports: `powerSupplyModule`.
 * Conventions: the supply is a *voltage* source. Constant-current limiting is modelled by
 * sagging the output voltage (see `circuit/supplyLimit.ts`), and the sagged value arrives
 * here through `supplyVoltageOverrides`, so every stamp must prefer the override over the
 * set-point. While the supply is in CC mode the digital pass must not re-drive `pos` at the
 * set-point, or the overlay and the net levels would disagree.
 * To change the current-limit algorithm: `circuit/supplyLimit.ts`, not this file.
 * Not-here: the CC bisection itself, or the MCU board rails, which are separate sources.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 30-09-2026 | Cursor | Corrected pin coordinates
# 09-10-2026 | Cursor | Moved from `src/parts/powerSupply.tsx` (tree reorganization)
# 13-10-2026 | Codex | Own palette placement and custom editor registration; retain unit conversion, steppers and legacy current limits.
 */
import { InstrumentPropertiesEditor } from '../../ui/editors/InstrumentPropertiesEditor';
import { isCurrentUnit, isVoltageUnit, supplyVoltageVolts } from '../../values/electric';
import type { PartModule } from '../partModule';
import { InstrumentReadout } from '../overlayKit';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export const powerSupplyModule: PartModule = {
  palette: { category: 'instruments', order: 0 },
  type: 'power_supply',
  standaloneSource: true,

  definition: {
    type: 'power_supply',
    label: 'Power Supply',
    scale: 2,
    artwork: '/components/power_supply.svg',
    pins: [
      { id: 'pos', description: 'Positive', x: 17.5, y: 52, type: 'digital' },
      { id: 'neg', description: 'Negative', x: 51.5, y: 52, type: 'ground' },
    ],
  },

  spiceStamp(ctx) {
    if (ctx.comp.supplyEnabled === false) return;
    const nPos = ctx.pinNet('pos');
    const nNeg = ctx.pinNet('neg');
    if (nPos === null || nNeg === null) return;
    const volts =
      ctx.supplyVoltageOverrides[ctx.comp.id] ?? supplyVoltageVolts(ctx.comp);
    ctx.line(`V${ctx.sid} ${ctx.node(nPos)} ${ctx.node(nNeg)} DC ${volts}`);
    ctx.markSourced(nPos);
    ctx.instance(`V${ctx.sid}`);
  },

  spiceCacheKey({ comp }) {
    return [
      comp.supplyVoltage,
      comp.supplyVoltageUnit ?? 'V',
      comp.supplyEnabled,
      comp.supplyCurrentLimit ?? 'default',
      comp.supplyCurrentLimitUnit ?? 'A',
    ].join(':');
  },

  legacyFixedVoltages(ctx) {
    if (ctx.comp.supplyEnabled === false) return;
    const nPos = ctx.pinNet('pos');
    const nNeg = ctx.pinNet('neg');
    const volts =
      ctx.supplyVoltageOverrides[ctx.comp.id] ?? supplyVoltageVolts(ctx.comp);
    if (nPos !== null) ctx.setFixed(nPos, volts);
    if (nNeg !== null && !ctx.hasFixed(nNeg)) ctx.setFixed(nNeg, 0);
  },

  applyDcResult(ctx) {
    const id = ctx.comp.id;
    ctx.flags.supplyCurrentLimited[id] = ctx.dc?.supplyCurrentLimited?.[id] ?? false;

    const netVoltages = ctx.dc?.netVoltages;
    if (!netVoltages) return;
    const nPos = ctx.pinNet('pos');
    const nNeg = ctx.pinNet('neg');
    if (nPos === null || nNeg === null) return;
    ctx.flags.supplyOutputVoltage[id] =
      (netVoltages.get(nPos) ?? 0) - (netVoltages.get(nNeg) ?? 0);
  },

  evaluate(ctx) {
    const { comp, flags } = ctx;
    if (comp.supplyEnabled === false || flags.supplyCurrentLimited[comp.id]) return;
    const voltage = supplyVoltageVolts(comp);
    ctx.drive(ctx.pinNet('pos'), ctx.voltsToLevel(voltage), 3);
  },

  pinRole(comp, pinId) {
    if (pinId === 'pos' && comp.supplyEnabled !== false) return 'source';
    if (pinId === 'neg') return 'sink';
    return undefined;
  },

  properties: {
    Editor: InstrumentPropertiesEditor,
    defaults: () => ({
      supplyVoltage: 5,
      supplyVoltageUnit: 'V',
      supplyEnabled: true,
      supplyCurrentLimit: 1,
      supplyCurrentLimitUnit: 'A',
    }),
    load(raw, into) {
      const volts = raw.supplyVoltage;
      into.supplyVoltage = isFiniteNumber(volts) && volts >= 0 ? volts : 5;
      into.supplyVoltageUnit = isVoltageUnit(raw.supplyVoltageUnit)
        ? raw.supplyVoltageUnit
        : 'V';
      if (typeof raw.supplyEnabled === 'boolean') into.supplyEnabled = raw.supplyEnabled;

      const limit = raw.supplyCurrentLimit;
      if (isFiniteNumber(limit) && limit >= 0) {
        into.supplyCurrentLimit = limit;
        into.supplyCurrentLimitUnit = isCurrentUnit(raw.supplyCurrentLimitUnit)
          ? raw.supplyCurrentLimitUnit
          : 'A';
        return;
      }

      // Pre-unit projects stored a bare milliamp figure.
      const legacyMa = raw.supplyCurrentLimitMa;
      if (!isFiniteNumber(legacyMa) || legacyMa < 0) {
        into.supplyCurrentLimit = 1;
        into.supplyCurrentLimitUnit = 'A';
      } else if (legacyMa === 0) {
        into.supplyCurrentLimit = 0;
        into.supplyCurrentLimitUnit = 'A';
      } else if (legacyMa >= 1000 && legacyMa % 1000 === 0) {
        into.supplyCurrentLimit = legacyMa / 1000;
        into.supplyCurrentLimitUnit = 'A';
      } else {
        into.supplyCurrentLimit = legacyMa;
        into.supplyCurrentLimitUnit = 'mA';
      }
    },
  },

  overlay: ({ component, simFlags, simRunning }) => {
    const id = component.id;
    const enabled = component.supplyEnabled !== false;
    const setVoltage = supplyVoltageVolts(component);
    const ccMode = simFlags?.supplyCurrentLimited?.[id] === true;
    const outputVoltage = simFlags?.supplyOutputVoltage?.[id] ?? setVoltage;
    const readout =
      simRunning && enabled
        ? `${
            Math.abs(outputVoltage) >= 100
              ? outputVoltage.toFixed(0)
              : outputVoltage.toFixed(1)
          } V`
        : 'OFF';
    return (
      <InstrumentReadout
        x={8.75}
        y={8.75}
        width={52}
        height={16}
        label={simRunning && enabled && ccMode ? 'CC' : 'PSU'}
        value={readout}
      />
    );
  },
};

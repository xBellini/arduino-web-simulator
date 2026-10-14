/**
 * What: Everything the simulator knows about a fixed resistor, in one file.
 * Role: part module — footprint and pins, SPICE and MNA stamps, wire-current contribution,
 * heat/overload visuals and the blow model, saved-file fields, and the colour-band overlay.
 * Owns/exports: `resistorModule` (the `PartModule`), plus three things other parts reuse:
 * `resistorOhms`, `BLOWN_RESISTOR_OHMS`, and the two ohm floors.
 * Conventions: the ohm floor differs by solver, which is why callers pass it explicitly.
 * Once `resistorBlown` latches in `CircuitSimState` it never clears on its own — only replacing
 * the part resets it. Power is I²R, raised to |dV|·I when both node voltages are solved, because
 * ngspice reports the more accurate figure through the branch current.
 * To change how fast a resistor burns out: the `BLOW_*` constants below.
 * To add a power rating: extend `ResistancePowerRating` in `types.ts` and `RATING_MW` here.
 * Not-here: band colour maths (`values/resistor`) or unit parsing (`values/resistor`).
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 24-09-2026 | Cursor | Pin B x aligned to resistor.svg viewBox width (~49.5)
# 09-10-2026 | Cursor | Moved from `src/parts/resistor.tsx` (tree reorganization)
# 13-10-2026 | Codex | Own palette placement and resistance/unit/rating/tolerance form schema; retain defaults and validation.
# 14-10-2026 | Codex | Clear the overload timer on burnout so static circuits stop updating every frame; failure thresholds and effects are unchanged.
#                     | Declare resistor terminals so leaf-wire direction follows solved voltage drop, independent of drawing direction.
 */
import type { PlacedComponent, ResistancePowerRating } from '../../types';
import {
  parseResistanceValue, RESISTANCE_UNITS, UNIT_LABELS,
  RESISTANCE_POWER_RATINGS, RESISTANCE_TOLERANCES, TOLERANCE_LABELS,
  DEFAULT_RESISTANCE_POWER_RATING,
  DEFAULT_RESISTANCE_TOLERANCE,
  DEFAULT_RESISTANCE_UNIT,
  DEFAULT_RESISTANCE_VALUE,
  isResistancePowerRating,
  isResistanceTolerance,
  isResistanceUnit,
  resistanceToOhms,
} from '../../values/resistor';
import {
  bandsForComponent,
  BAND_STROKE,
  BAND_STROKE_WIDTH,
  layoutResistorBands,
  RESISTOR_GRAPHIC,
} from '../../values/resistor';
import type { PartModule } from '../partModule';

/** Open-circuit stand-in for a burned-out part or an open contact (SPICE + legacy MNA). */
export const BLOWN_RESISTOR_OHMS = 1e9;

/** ngspice is happy with milliohms. */
export const SPICE_OHM_FLOOR = 0.001;
/** The legacy MNA matrix goes ill-conditioned below 1 ohm. */
export const MNA_OHM_FLOOR = 1;

/** Wire flow only animates above this, so a smaller ngspice reading is treated as noise. */
const MIN_WIRE_CURRENT_MA = 0.05;

const BLOW_RATIO = 1;
const BLOW_INSTANT_RATIO = 2.5;
const BLOW_HOLD_MS = 1800;

const RATING_MW: Record<ResistancePowerRating, number> = {
  '1/8W': 125,
  '1/4W': 250,
  '1/2W': 500,
  '1W': 1000,
};

/**
 * Resistance in ohms, clamped to `floorOhms`. The floor is a caller decision because the two
 * solvers disagree on how small a resistance they can accept — see the two floor constants.
 */
export function resistorOhms(comp: PlacedComponent, floorOhms: number): number {
  const value = comp.resistanceValue ?? DEFAULT_RESISTANCE_VALUE;
  const unit = comp.resistanceUnit ?? DEFAULT_RESISTANCE_UNIT;
  return Math.max(floorOhms, resistanceToOhms(value, unit));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function ResistorBandOverlay({ component }: { component: PlacedComponent }) {
  const bands = bandsForComponent(component);
  const layout = layoutResistorBands(bands.length);
  const g = RESISTOR_GRAPHIC;
  return (
    <g className="resistor-bands" transform={g.transform} pointerEvents="none">
      {bands.map((color, i) => {
        const box = layout[i];
        if (!box) return null;
        return (
          <rect
            key={i}
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill={color}
            stroke={BAND_STROKE}
            strokeWidth={BAND_STROKE_WIDTH}
          />
        );
      })}
    </g>
  );
}

export const resistorModule: PartModule = {
  palette: { category: 'passives', order: 0 },
  type: 'resistor',

  definition: {
    type: 'resistor',
    label: 'Resistor',
    scale: 2.5,
    artwork: '/components/resistor.svg',
    pins: [
      { id: 'a', description: 'A', x: 0, y: 4.7, type: 'digital' },
      { id: 'b', description: 'B', x: 49.5, y: 4.7, type: 'digital' },
    ],
  },

  spiceStamp(ctx) {
    const na = ctx.pinNet('a');
    const nb = ctx.pinNet('b');
    if (na === null || nb === null) return;
    const ohms = ctx.resistorBlown[ctx.comp.id]
      ? BLOWN_RESISTOR_OHMS
      : resistorOhms(ctx.comp, SPICE_OHM_FLOOR);
    // 0V sense — the worker reads V-source branch currents i(V…), not device @R[i].
    const sense = `n${ctx.sid}_isense`;
    ctx.line(`Vi${ctx.sid} ${ctx.node(na)} ${sense} 0`);
    ctx.line(`R${ctx.sid} ${sense} ${ctx.node(nb)} ${ohms}`);
    ctx.instance(`Vi${ctx.sid}`);
  },

  spiceCacheKey({ comp, resistorBlown }) {
    const blown = resistorBlown[comp.id] ? 'open' : 'ok';
    return `${comp.resistanceValue}:${comp.resistanceUnit}:${blown}`;
  },

  legacyStamp(ctx) {
    const na = ctx.pinNet('a');
    const nb = ctx.pinNet('b');
    if (na === null || nb === null) return;
    const ohms = ctx.resistorBlown[ctx.comp.id]
      ? BLOWN_RESISTOR_OHMS
      : resistorOhms(ctx.comp, MNA_OHM_FLOOR);
    ctx.stampResistor(na, nb, ohms);
  },

  visuals(ctx) {
    const { comp, simState, flags, netVoltages, branchCurrentMa } = ctx;
    const id = comp.id;

    if (!simState.resistorBlown) simState.resistorBlown = {};
    if (!simState.resistorOverPowerMs) simState.resistorOverPowerMs = {};

    const blowOut = (): void => {
      simState.resistorBlown[id] = true;
      simState.resistorOverPowerMs[id] = 0;
      flags.resistorBlown[id] = true;
      flags.resistorHeatLevel[id] = 0;
      flags.resistorOverrated[id] = false;
      flags.resistorPowerMw[id] = 0;
    };

    if (simState.resistorBlown[id]) {
      flags.resistorBlown[id] = true;
      flags.resistorHeatLevel[id] = 0;
      flags.resistorOverrated[id] = false;
      flags.resistorPowerMw[id] = 0;
      return;
    }

    const na = ctx.pinNet('a');
    const nb = ctx.pinNet('b');
    let powerMw = 0;
    if (na !== null && nb !== null) {
      const estimatedMa = Math.abs(ctx.resistorMa(comp));
      const spiceMa = branchCurrentMa?.[id];
      const iMa =
        spiceMa !== undefined && spiceMa > 0 ? Math.abs(spiceMa) : estimatedMa;
      const ohms = resistorOhms(comp, MNA_OHM_FLOOR);
      powerMw = (iMa * iMa * ohms) / 1000;
      if (netVoltages) {
        const va = netVoltages.get(na);
        const vb = netVoltages.get(nb);
        if (va !== undefined && vb !== undefined) {
          powerMw = Math.max(powerMw, Math.abs(va - vb) * iMa);
        }
      }
    }

    const rating = comp.resistancePowerRating ?? '1/4W';
    const maxMw = RATING_MW[rating] ?? 250;
    const ratio = maxMw > 0 ? powerMw / maxMw : 0;
    flags.resistorPowerMw[id] = powerMw;
    flags.resistorHeatLevel[id] = ratio;
    flags.resistorOverrated[id] = ratio >= 1;

    if (ratio >= BLOW_INSTANT_RATIO) {
      blowOut();
      return;
    }

    if (ratio >= BLOW_RATIO) {
      simState.resistorOverPowerMs[id] =
        (simState.resistorOverPowerMs[id] ?? 0) + ctx.blowDtMs;
      if ((simState.resistorOverPowerMs[id] ?? 0) >= BLOW_HOLD_MS) blowOut();
    } else {
      simState.resistorOverPowerMs[id] = 0;
    }
  },

  branchCurrentPass: 0,
  branchCurrent(ctx) {
    const { comp, flags } = ctx;
    if (flags.resistorBlown?.[comp.id]) return;
    const estimatedMa = ctx.resistorMa(comp);
    const spiceMa = ctx.branchCurrentMa?.[comp.id];
    const iMa =
      spiceMa !== undefined && spiceMa >= MIN_WIRE_CURRENT_MA ? spiceMa : estimatedMa;
    if (iMa < MIN_WIRE_CURRENT_MA) return;
    const na = ctx.pinNet('a');
    const nb = ctx.pinNet('b');
    if (na !== null) ctx.setNetMa(na, iMa);
    if (nb !== null) ctx.setNetMa(nb, iMa);
  },

  wireCurrentPath(pinId) {
    if (pinId === 'a' || pinId === 'b') return { positive: 'a', negative: 'b' };
  },

  seriesPins(comp, pinId, flags) {
    if (flags.resistorBlown?.[comp.id]) return [];
    if (pinId === 'a') return ['b'];
    if (pinId === 'b') return ['a'];
    return [];
  },

  properties: {
    title: 'Resistor properties',
    fields: [
      { key: 'resistanceValue', label: 'Resistance value', kind: 'number', parse: parseResistanceValue, error: 'Enter a positive number' },
      { key: 'resistanceUnit', label: 'Resistance unit', kind: 'select', options: RESISTANCE_UNITS.map(value => ({ value, label: UNIT_LABELS[value] })) },
      { key: 'resistancePowerRating', label: 'Power rating', kind: 'select', options: RESISTANCE_POWER_RATINGS.map(value => ({ value, label: value })) },
      { key: 'resistanceTolerance', label: 'Tolerance', kind: 'select', options: RESISTANCE_TOLERANCES.map(value => ({ value, label: TOLERANCE_LABELS[value] })) },
    ],
    defaults: () => ({
      resistanceValue: DEFAULT_RESISTANCE_VALUE,
      resistanceUnit: DEFAULT_RESISTANCE_UNIT,
      resistancePowerRating: DEFAULT_RESISTANCE_POWER_RATING,
      resistanceTolerance: DEFAULT_RESISTANCE_TOLERANCE,
    }),
    load(raw, into) {
      const value = raw.resistanceValue;
      into.resistanceValue =
        isFiniteNumber(value) && value > 0 ? value : DEFAULT_RESISTANCE_VALUE;
      into.resistanceUnit = isResistanceUnit(raw.resistanceUnit)
        ? raw.resistanceUnit
        : DEFAULT_RESISTANCE_UNIT;
      into.resistancePowerRating = isResistancePowerRating(raw.resistancePowerRating)
        ? raw.resistancePowerRating
        : DEFAULT_RESISTANCE_POWER_RATING;
      into.resistanceTolerance = isResistanceTolerance(raw.resistanceTolerance)
        ? raw.resistanceTolerance
        : DEFAULT_RESISTANCE_TOLERANCE;
    },
  },

  overlay: ({ component }) => <ResistorBandOverlay component={component} />,
};

/**
 * What: Ceramic and polarized capacitors — footprint, SPICE C stamp, charge UI, blow model.
 * Role: part modules — native SPICE `C` (+ ESR for polarized); charge/blow from solved V/I.
 * Owns/exports: `capacitorModule`, `polarizedCapacitorModule`, `syncCapacitorStateFromDc`,
 * `circuitHasCapacitors`.
 * Conventions: Ideal C is open in `.OP`. Dynamics come from ngspice stepped `.tran` + `.ic`
 * (see spice/client.ts). Blown → open (~1 GΩ). UI only mirrors SPICE results.
 * To retune: `BLOW_*` / `REVERSE_SLACK_V` / `POLARIZED_ESR_OHMS`.
 * Not-here: hand-rolled RC / Thévenin companion models.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 25-09-2026 | Cursor | Editable capacitance; polarized module
#                     | SPICE C + ESR; voltage rating; blow; drop body value marking
# 26-09-2026 | Cursor | Restore native SPICE C stamp; drop discrete companion invent
# 28-09-2026 | Cursor | Charge/fill driven only from SPICE Vc / #branch (no invented RC)
# 09-10-2026 | Cursor | Moved from `src/parts/capacitor.tsx` (tree reorganization)
# 13-10-2026 | Codex | Own palette placement and shared capacitor form schema; preserve both variants and their defaults.
 */
import type { PartModule, PartPropertyField } from '../partModule';
import type { PlacedComponent } from '../../types';
import type { CircuitNetlist } from '../../circuit/netlist';
import { netForPin } from '../../circuit/netlist';
import type { CircuitSimState } from '../../circuit/solver';
import { BLOWN_RESISTOR_OHMS } from './resistor';
import {
  CAPACITANCE_UNITS, CAPACITANCE_UNIT_LABELS, parseCapacitanceValue,
  capacitanceToFarads,
  DEFAULT_CAPACITANCE_UNIT,
  DEFAULT_CAPACITANCE_VALUE,
  DEFAULT_CAPACITANCE_VOLTAGE_RATING,
  DEFAULT_POLARIZED_CAPACITANCE_UNIT,
  DEFAULT_POLARIZED_CAPACITANCE_VALUE,
  DEFAULT_POLARIZED_VOLTAGE_RATING,
  isCapacitanceUnit,
} from '../../values/capacitor';

//const SUPPLY_V = 5;
/** Shared property form for ceramic and polarized variants. */
const CAPACITOR_FIELDS: readonly PartPropertyField[] = [
  { key: 'capacitanceValue', label: 'Capacitance value', kind: 'number', parse: parseCapacitanceValue, error: 'Enter a positive capacitance' },
  { key: 'capacitanceUnit', label: 'Capacitance unit', kind: 'select', options: CAPACITANCE_UNITS.map(value => ({ value, label: CAPACITANCE_UNIT_LABELS[value] })) },
  { key: 'capacitanceVoltageRating', label: 'Voltage rating', kind: 'number', unit: 'V', parse: parseCapacitanceValue, error: 'Enter a positive voltage rating' },
];

/** Visual full-scale for charge fill — ~LED Vf reads “full”; blow still uses rating. */
const CHARGE_VISUAL_FULL_V = 2.5;
const POLARIZED_ESR_OHMS = 0.5;
const REVERSE_SLACK_V = 0.3;
const BLOW_HOLD_MS = 80;
const BLOW_INSTANT_RATIO = 1.5;

/** Last SPICE Vc sample — only for C·|dV/dt| fallback when SPICE omits C#branch. */
const prevSpiceVc = new Map<string, { v: number; tMs: number }>();

const CAP_WIRE_SHOW_MA = 0.08;
const CAP_WIRE_HIDE_MA = 0.03;
const CAP_WIRE_MAX_MA = 40;

/** Last SPICE terminal voltage mirrored for LED parallel sense (not a parallel invent). */
const lastSpiceVc = new Map<string, number>();

function chargeFillFromVc(vc: number): number {
  return Math.max(0, Math.min(1, Math.abs(vc) / CHARGE_VISUAL_FULL_V));
}

/**
 * Prefer SPICE `#branch` current; else I ≈ C·|dV/dt| between SPICE Vc samples only.
 * Does not invent charge/discharge curves — ngspice owns the dynamics.
 */
function applyCapBranchCurrent(
  id: string,
  spiceVc: number,
  cFarad: number,
  spiceBranchMa: number | undefined,
  simState: CircuitSimState,
  branchCurrentMa: Record<string, number> | undefined,
  //source: string,
): number {
  let rawMa = 0;
  let dV = 0;
  let dtSec = 0;
  //let from = 'none';

  if (spiceBranchMa !== undefined && Number.isFinite(spiceBranchMa)) {
    rawMa = Math.abs(spiceBranchMa);
    //from = 'spice-branch';
  } else {
    const tMs = performance.now();
    const prev = prevSpiceVc.get(id);
    dtSec = prev ? (tMs - prev.tMs) / 1000 : 0;
    if (prev && dtSec > 1e-4 && dtSec < 2) {
      dV = spiceVc - prev.v;
      if (Math.abs(dV) > 1e-4) {
        rawMa = Math.abs(cFarad * (dV / dtSec)) * 1000;
        //from = 'spice-dVdt';
      }
    }
    prevSpiceVc.set(id, { v: spiceVc, tMs });
  }

  if (!Number.isFinite(rawMa)) rawMa = 0;
  rawMa = Math.min(CAP_WIRE_MAX_MA, rawMa);

  const show =
    rawMa >= CAP_WIRE_SHOW_MA ||
    ((simState.capacitorCurrentMa[id] ?? 0) >= CAP_WIRE_HIDE_MA &&
      rawMa >= CAP_WIRE_HIDE_MA);
  if (show) {
    simState.capacitorCurrentMa[id] = rawMa;
    if (branchCurrentMa) branchCurrentMa[id] = rawMa;
  } else {
    simState.capacitorCurrentMa[id] = 0;
    if (branchCurrentMa) delete branchCurrentMa[id];
  }


  return rawMa;
}

/** Latest SPICE terminal voltage for LED parallel sense. */
export function getCapDisplayVoltage(id: string): number | undefined {
  return lastSpiceVc.get(id);
}

/** While waiting on SPICE: mirror last solved Vc into fill flags (no invented ramp). */
export function tickCapacitorChargeVisuals(
  components: PlacedComponent[],
  simState: CircuitSimState,
  flags: {
    capacitorCharge: Record<string, number>;
    capacitorBlown: Record<string, boolean>;
  },
  _dtMs: number,
): void {
  for (const comp of components) {
    if (comp.type !== 'capacitor' && comp.type !== 'polarized_capacitor') continue;
    const id = comp.id;
    if (simState.capacitorBlown?.[id] || flags.capacitorBlown?.[id]) {
      flags.capacitorCharge[id] = 0;
      continue;
    }
    const vc = simState.capacitorTerminalV?.[id] ?? lastSpiceVc.get(id) ?? 0;
    const charge = chargeFillFromVc(vc);
    flags.capacitorCharge[id] = charge;
    simState.capacitorCharge[id] = charge;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function faradsOf(
  comp: PlacedComponent,
  defaultValue: number,
  defaultUnit: typeof DEFAULT_CAPACITANCE_UNIT,
): number {
  const value = comp.capacitanceValue ?? defaultValue;
  const unit = comp.capacitanceUnit ?? defaultUnit;
  return Math.max(1e-15, capacitanceToFarads(value, unit));
}

function voltageRatingOf(comp: PlacedComponent, fallback: number): number {
  const v = comp.capacitanceVoltageRating;
  return isFiniteNumber(v) && v > 0 ? v : fallback;
}

function defaultsFor(comp: PlacedComponent): {
  value: number;
  unit: typeof DEFAULT_CAPACITANCE_UNIT;
  rating: number;
  polarized: boolean;
} {
  const polarized = comp.type === 'polarized_capacitor';
  return {
    polarized,
    value: polarized ? DEFAULT_POLARIZED_CAPACITANCE_VALUE : DEFAULT_CAPACITANCE_VALUE,
    unit: polarized ? DEFAULT_POLARIZED_CAPACITANCE_UNIT : DEFAULT_CAPACITANCE_UNIT,
    rating: polarized ? DEFAULT_POLARIZED_VOLTAGE_RATING : DEFAULT_CAPACITANCE_VOLTAGE_RATING,
  };
}

/**
 * After a DC/tran solve, copy terminal voltages into simState for glow + blow.
 * Estimates |Ic| ≈ C·|dV/dt| when SPICE branch current is absent (node-only export).
 * Mutates `simState` and optionally `branchCurrentMa` for wire animation.
 */
export function syncCapacitorStateFromDc(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simState: CircuitSimState,
  netVoltages: Map<number, number> | undefined,
  branchCurrentMa: Record<string, number> | undefined,
): void {
  if (!netVoltages) return;
  if (!simState.capacitorTerminalV) simState.capacitorTerminalV = {};
  if (!simState.capacitorCharge) simState.capacitorCharge = {};
  if (!simState.capacitorBlown) simState.capacitorBlown = {};
  if (!simState.capacitorCurrentMa) simState.capacitorCurrentMa = {};

  for (const comp of components) {
    if (comp.type !== 'capacitor' && comp.type !== 'polarized_capacitor') continue;
    const id = comp.id;
    if (simState.capacitorBlown[id]) {
      simState.capacitorTerminalV[id] = 0;
      simState.capacitorCharge[id] = 0;
      simState.capacitorCurrentMa[id] = 0;
      prevSpiceVc.delete(id);
      lastSpiceVc.delete(id);
      continue;
    }
    const nPos = netForPin(netlist, { componentId: id, pinId: 'pos' });
    const nNeg = netForPin(netlist, { componentId: id, pinId: 'neg' });
    if (nPos === null || nNeg === null) continue;
    const vc = (netVoltages.get(nPos) ?? 0) - (netVoltages.get(nNeg) ?? 0);
    simState.capacitorTerminalV[id] = vc;
    lastSpiceVc.set(id, vc);
    simState.capacitorCharge[id] = chargeFillFromVc(vc);

    const defs = defaultsFor(comp);
    const cFarad = faradsOf(comp, defs.value, defs.unit);
    const spiceBranch = branchCurrentMa?.[id];
    applyCapBranchCurrent(
      id,
      vc,
      cFarad,
      spiceBranch,
      simState,
      branchCurrentMa,
      //'sync',
    );

  }
}

function loadCapacitance(
  raw: Partial<PlacedComponent>,
  into: PlacedComponent,
  defaultValue: number,
  defaultUnit: typeof DEFAULT_CAPACITANCE_UNIT,
  defaultRating: number,
) {
  const value = raw.capacitanceValue;
  into.capacitanceValue =
    isFiniteNumber(value) && value > 0 ? value : defaultValue;
  into.capacitanceUnit = isCapacitanceUnit(raw.capacitanceUnit)
    ? raw.capacitanceUnit
    : defaultUnit;
  const rating = raw.capacitanceVoltageRating;
  into.capacitanceVoltageRating =
    isFiniteNumber(rating) && rating > 0 ? rating : defaultRating;
}

function stampCapacitor(
  ctx: Parameters<NonNullable<PartModule['spiceStamp']>>[0],
  polarized: boolean,
  defaultValue: number,
  defaultUnit: typeof DEFAULT_CAPACITANCE_UNIT,
): void {
  const nPos = ctx.pinNet('pos');
  const nNeg = ctx.pinNet('neg');
  if (nPos === null || nNeg === null) return;

  if (ctx.capacitorBlown?.[ctx.comp.id]) {
    const sense = `n${ctx.sid}_isense`;
    ctx.line(`Vi${ctx.sid} ${ctx.node(nPos)} ${sense} 0`);
    ctx.line(`R${ctx.sid} ${sense} ${ctx.node(nNeg)} ${BLOWN_RESISTOR_OHMS}`);
    ctx.instance(`Vi${ctx.sid}`);
    return;
  }

  const c = faradsOf(ctx.comp, defaultValue, defaultUnit);
  const cExpr = c.toExponential(6);
  // 0V sense — the worker reads V-source branch currents i(V…), not device @C[i].
  const sense = `n${ctx.sid}_isense`;
  ctx.line(`Vi${ctx.sid} ${ctx.node(nPos)} ${sense} 0`);
  if (polarized) {
    const mid = `n${ctx.sid}_esr`;
    ctx.line(`R${ctx.sid}esr ${sense} ${mid} ${POLARIZED_ESR_OHMS}`);
    ctx.line(`C${ctx.sid} ${mid} ${ctx.node(nNeg)} ${cExpr}`);
  } else {
    ctx.line(`C${ctx.sid} ${sense} ${ctx.node(nNeg)} ${cExpr}`);
  }
  ctx.instance(`Vi${ctx.sid}`);

}

const capacitorHooks: Pick<
  PartModule,
  | 'evaluate'
  | 'publishState'
  | 'visuals'
  | 'overlay'
  | 'branchCurrent'
  | 'branchCurrentPass'
  | 'seriesPins'
> = {
  evaluate(ctx) {
    const id = ctx.comp.id;
    if (ctx.simState.capacitorBlown?.[id]) {
      ctx.flags.capacitorBlown[id] = true;
      ctx.flags.capacitorCharge[id] = 0;
      return;
    }
    ctx.flags.capacitorCharge[id] = ctx.simState.capacitorCharge[id] ?? 0;
  },

  publishState(ctx) {
    const id = ctx.comp.id;
    if (!ctx.simState.capacitorBlown) ctx.simState.capacitorBlown = {};
    if (ctx.simState.capacitorBlown[id]) {
      ctx.flags.capacitorBlown[id] = true;
      ctx.flags.capacitorCharge[id] = 0;
      return;
    }
    ctx.flags.capacitorCharge[id] = ctx.simState.capacitorCharge[id] ?? 0;
  },

  visuals(ctx) {
    const { comp, simState, flags } = ctx;
    const id = comp.id;
    if (!simState.capacitorBlown) simState.capacitorBlown = {};
    if (!simState.capacitorOverVoltageMs) simState.capacitorOverVoltageMs = {};

    if (simState.capacitorBlown[id]) {
      flags.capacitorBlown[id] = true;
      flags.capacitorCharge[id] = 0;
      return;
    }

    const spiceV = simState.capacitorTerminalV?.[id] ?? lastSpiceVc.get(id) ?? 0;
    lastSpiceVc.set(id, spiceV);
    flags.capacitorCharge[id] = chargeFillFromVc(spiceV);
    simState.capacitorCharge[id] = flags.capacitorCharge[id];

    // Branch mA comes from SPICE sync — do not invent I from a visual ramp here.
    const spiceBranch = ctx.branchCurrentMa?.[id];
    if (spiceBranch !== undefined && Number.isFinite(spiceBranch)) {
      const ma = Math.abs(spiceBranch);
      if (ma >= CAP_WIRE_HIDE_MA) {
        simState.capacitorCurrentMa[id] = Math.min(CAP_WIRE_MAX_MA, ma);
        ctx.branchCurrentMa![id] = simState.capacitorCurrentMa[id];
      }
    }


    const nPos = ctx.pinNet('pos');
    const nNeg = ctx.pinNet('neg');
    if (nPos === null || nNeg === null) return;

    const vDrop = ctx.netVolts(nPos) - ctx.netVolts(nNeg);
    const defs = defaultsFor(comp);
    const rating = voltageRatingOf(comp, defs.rating);

    const blowOut = (_reason: string): void => {
      simState.capacitorBlown[id] = true;
      flags.capacitorBlown[id] = true;
      flags.capacitorCharge[id] = 0;
      simState.capacitorCharge[id] = 0;
      if (simState.capacitorTerminalV) simState.capacitorTerminalV[id] = 0;
      if (simState.capacitorCurrentMa) simState.capacitorCurrentMa[id] = 0;
      simState.capacitorOverVoltageMs[id] = 0;
      prevSpiceVc.delete(id);
      lastSpiceVc.delete(id);
    };

    const senseV = Math.abs(spiceV) > Math.abs(vDrop) ? spiceV : vDrop;
    if (defs.polarized && senseV < -REVERSE_SLACK_V) {
      blowOut('reverse');
      return;
    }

    const mag = defs.polarized ? senseV : Math.abs(senseV);
    const overRatio = mag / Math.max(rating, 0.1);
    if (overRatio >= BLOW_INSTANT_RATIO) {
      blowOut('overvolt-instant');
      return;
    }
    if (overRatio >= 1) {
      simState.capacitorOverVoltageMs[id] =
        (simState.capacitorOverVoltageMs[id] ?? 0) + ctx.blowDtMs;
      if ((simState.capacitorOverVoltageMs[id] ?? 0) >= BLOW_HOLD_MS) blowOut('overvolt-hold');
    } else {
      simState.capacitorOverVoltageMs[id] = 0;
    }
  },

  // Same as a resistor: publish branch mA onto both pin nets (pass 0).
  // Later parts (LED, etc.) may raise a shared net — that is normal aggregation.
  branchCurrentPass: 0,
  branchCurrent(ctx) {
    const ma = ctx.branchCurrentMa?.[ctx.comp.id];
    if (ma === undefined || ma < CAP_WIRE_HIDE_MA) return;
    const nPos = ctx.pinNet('pos');
    const nNeg = ctx.pinNet('neg');
    if (nPos !== null) ctx.setNetMa(nPos, ma);
    if (nNeg !== null) ctx.setNetMa(nNeg, ma);
  },

  seriesPins(_comp, pinId) {
    if (pinId === 'pos' || pinId === 'neg') return ['pos', 'neg'];
    return [];
  },

  overlay({ component, design, simFlags, simRunning }) {
    const id = component.id;
    if (!simRunning) return null;
    const w = design.width;
    const h = design.height;
    if (simFlags?.capacitorBlown?.[id]) {
      const cx = w / 2;
      const cy = h * 0.42;
      const hx = w * 0.32;
      const hy = h * 0.28;
      return (
        <g className="capacitor-blown-mark" pointerEvents="none" aria-hidden>
          <path
            d={`M ${cx - hx} ${cy - hy} L ${cx + hx} ${cy + hy}`}
            stroke="#ef5350"
            strokeWidth={1.6}
            opacity={0.9}
          />
          <path
            d={`M ${cx + hx} ${cy - hy} L ${cx - hx} ${cy + hy}`}
            stroke="#ef5350"
            strokeWidth={1.6}
            opacity={0.9}
          />
        </g>
      );
    }
    const charge = simFlags?.capacitorCharge?.[id] ?? 0;
    if (charge < 0.02) return null;
    // Footprint = SVG viewBox size; can fills most of it, leads at the bottom.
    const padX = w * 0.14;
    const bodyTop = h * 0.06;
    const bodyBottom = h * 0.72;
    const bodyH = Math.max(bodyBottom - bodyTop, 1);
    const fillH = bodyH * charge;
    const fillY = bodyBottom - fillH;
    const pulsing = charge > 0.08 && charge < 0.95;
    return (
      <g
        className={[
          'capacitor-package',
          charge > 0.05 ? 'is-charged' : '',
          pulsing ? 'is-charging' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ ['--cap-charge' as string]: charge }}
        pointerEvents="none"
        aria-hidden
      >
        <rect
          className="cap-charge-overlay"
          x={padX}
          y={fillY}
          width={Math.max(w - padX * 2, 1)}
          height={Math.max(fillH, 0.5)}
          rx={Math.min(w, h) * 0.08}
          opacity={0.22 + 0.5 * charge}
        />
      </g>
    );
  },
};

export const capacitorModule: PartModule = {
  palette: { category: 'passives', order: 10 },
  type: 'capacitor',

  definition: {
    type: 'capacitor',
    label: 'Capacitor',
    scale: 1,
    artwork: '/components/capacitor.svg',
    pins: [
      { id: 'pos', description: 'Positive', x: 14, y: 51, type: 'digital' },
      { id: 'neg', description: 'Negative', x: 32, y: 51, type: 'digital' },
    ],
  },

  spiceStamp(ctx) {
    stampCapacitor(ctx, false, DEFAULT_CAPACITANCE_VALUE, DEFAULT_CAPACITANCE_UNIT);
  },

  spiceCacheKey({ comp, capacitorBlown }) {
    const blown = capacitorBlown?.[comp.id] ? 'open' : 'ok';
    return `${comp.capacitanceValue}:${comp.capacitanceUnit}:${comp.capacitanceVoltageRating}:${blown}`;
  },

  ...capacitorHooks,

  properties: {
    title: 'Capacitor properties',
    fields: CAPACITOR_FIELDS,
    defaults: () => ({
      capacitanceValue: DEFAULT_CAPACITANCE_VALUE,
      capacitanceUnit: DEFAULT_CAPACITANCE_UNIT,
      capacitanceVoltageRating: DEFAULT_CAPACITANCE_VOLTAGE_RATING,
    }),
    load(raw, into) {
      loadCapacitance(
        raw,
        into,
        DEFAULT_CAPACITANCE_VALUE,
        DEFAULT_CAPACITANCE_UNIT,
        DEFAULT_CAPACITANCE_VOLTAGE_RATING,
      );
    },
  },
};

export const polarizedCapacitorModule: PartModule = {
  palette: { category: 'passives', order: 20 },
  type: 'polarized_capacitor',

  definition: {
    type: 'polarized_capacitor',
    label: 'Polarized Capacitor',
    scale: 1,
    artwork: '/components/polarized_capacitor.svg',
    pins: [
      { id: 'neg', description: 'Negative', x: 14, y: 51, type: 'digital' },
      { id: 'pos', description: 'Positive', x: 32, y: 51, type: 'digital' },
    ],
  },

  spiceStamp(ctx) {
    stampCapacitor(
      ctx,
      true,
      DEFAULT_POLARIZED_CAPACITANCE_VALUE,
      DEFAULT_POLARIZED_CAPACITANCE_UNIT,
    );
  },

  spiceCacheKey({ comp, capacitorBlown }) {
    const blown = capacitorBlown?.[comp.id] ? 'open' : 'ok';
    return `${comp.capacitanceValue}:${comp.capacitanceUnit}:${comp.capacitanceVoltageRating}:${blown}`;
  },

  ...capacitorHooks,

  properties: {
    title: 'Polarized capacitor properties',
    fields: CAPACITOR_FIELDS,
    defaults: () => ({
      capacitanceValue: DEFAULT_POLARIZED_CAPACITANCE_VALUE,
      capacitanceUnit: DEFAULT_POLARIZED_CAPACITANCE_UNIT,
      capacitanceVoltageRating: DEFAULT_POLARIZED_VOLTAGE_RATING,
    }),
    load(raw, into) {
      loadCapacitance(
        raw,
        into,
        DEFAULT_POLARIZED_CAPACITANCE_VALUE,
        DEFAULT_POLARIZED_CAPACITANCE_UNIT,
        DEFAULT_POLARIZED_VOLTAGE_RATING,
      );
    },
  },
};

/** True when the canvas has a simulating capacitor. */
export function circuitHasCapacitors(components: PlacedComponent[]): boolean {
  return components.some(
    (c) => c.type === 'capacitor' || c.type === 'polarized_capacitor',
  );
}

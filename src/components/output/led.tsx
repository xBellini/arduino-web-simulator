/**
 * What: Everything the simulator knows about a single-colour LED, in one file.
 * Role: part module — footprint and pins, SPICE diode model, MNA Norton stamp and the
 * conduction iteration, brightness/blow visuals, wire-current contribution, saved-file fields,
 * and the glow overlay.
 * Owns/exports: `ledModule`, plus `LED_ON_RESISTANCE_OHMS` and `ledForwardVoltage`, which the
 * supply current-limit model and other diode-like parts reuse.
 * Conventions: the LED is solved as a real diode by ngspice and as Vf-plus-R_on by the legacy
 * MNA, so brightness must read the *solved* conduction (`ledConducting`) rather than re-deciding
 * it. Overcurrent only blows the part when a physical series resistor exists — driving an LED
 * straight off a supply makes ngspice report an enormous current, and instantly destroying the
 * part on the first frame reads as a bug rather than a lesson.
 * To retune the failure model: the `BLOW_*` constants below.
 * To change the default colour-to-Vf mapping: `values/led.ts`.
 * Not-here: the RGB LED, which is a separate common-cathode part with three dies.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/parts/led.tsx` (tree reorganization)
 * - 24-09-2026 — Glow uses LED body silhouette path (not a small oval); blown-X on dome
 * - 24-09-2026 — Retuned glow/blown-X to current led.svg footprint (~14.7×29.5)
 * - 17-09-2026 — Changelog creation / migrated out of the per-subsystem type switches
 */
import type { CSSProperties } from 'react';
import type { PlacedComponent } from '../../types';
import {
  DEFAULT_LED_COLOR,
  DEFAULT_LED_FORWARD_CURRENT,
  DEFAULT_LED_FORWARD_VOLTAGE,
  defaultForwardVoltageForColor,
  isLedColorHex,
  VF_CONDUCT_SLACK_V,
} from '../../values/led';
import type { PartModule } from '../partModule';
import { BLOWN_RESISTOR_OHMS, MNA_OHM_FLOOR, resistorOhms } from '../passives/resistor';
import { getCapDisplayVoltage } from '../passives/capacitor';
import { getDefinition } from '../../registry/components';

/** Series resistance of a conducting LED in the legacy Norton model. */
export const LED_ON_RESISTANCE_OHMS = 25;

/** Assumed series resistance when the canvas has none to measure. */
const DEFAULT_SERIES_OHMS = 220;

const BLOW_RATIO = 1;
const BLOW_INSTANT_RATIO = 2;
const BLOW_HOLD_MS = 80;

const MIN_WIRE_CURRENT_MA = 0.05;

/** Eased LED sense voltage so glow tracks cap discharge, not SPICE stair-steps. */
const ledSenseSmoothV = new Map<string, number>();
/** Wire-current LPF — matches cap overlay responsiveness without SPICE stairs. */
const ledWireCurrentFilt = new Map<string, number>();

function netTouchesGround(
  components: PlacedComponent[],
  netOfPin: (componentId: string, pinId: string) => number | null,
  netId: number,
): boolean {
  for (const c of components) {
    const def = getDefinition(c.type);
    for (const pin of def.pins) {
      if (pin.type !== 'ground') continue;
      if (netOfPin(c.id, pin.id) === netId) return true;
    }
  }
  return false;
}

/**
 * Cap voltage for LED glow/current when C is across the LED (same nets) or returns
 * separately to GND (common breadboard: LED-k and C-neg on different GND jumpers).
 * Also covers C || (R+LED) when they share a ground return.
 */
function getParallelCapDisplayV(
  components: PlacedComponent[],
  netOfPin: (componentId: string, pinId: string) => number | null,
  anodeNet: number | null,
  cathodeNet: number | null,
): number | undefined {
  if (anodeNet === null || cathodeNet === null) return undefined;
  const cathodeGnd = netTouchesGround(components, netOfPin, cathodeNet);
  let best: number | undefined;
  for (const c of components) {
    if (c.type !== 'capacitor' && c.type !== 'polarized_capacitor') continue;
    const pos = netOfPin(c.id, 'pos');
    const neg = netOfPin(c.id, 'neg');
    if (pos === null || neg === null) continue;
    const exact = pos === anodeNet && neg === cathodeNet;
    const sharedHotGndReturns =
      pos === anodeNet &&
      (neg === cathodeNet ||
        (cathodeGnd && netTouchesGround(components, netOfPin, neg)));
    // C || (R+LED): cap on the supply side of R, LED mid-node — share GND return only.
    const sharedGndReturn =
      neg === cathodeNet ||
      (cathodeGnd && netTouchesGround(components, netOfPin, neg) && pos !== anodeNet);
    if (!exact && !sharedHotGndReturns && !sharedGndReturn) continue;
    const v = getCapDisplayVoltage(c.id);
    if (v === undefined) continue;
    // Across R+LED, LED only sees part of Vc — still useful for smooth fade; prefer exact.
    const weight = exact || sharedHotGndReturns ? v : v * 0.85;
    best = best === undefined ? weight : Math.max(best, weight);
  }
  return best;
}

export function ledForwardVoltage(comp: PlacedComponent): number {
  if (comp.ledForwardVoltage !== undefined) return comp.ledForwardVoltage;
  if (comp.ledColor) return defaultForwardVoltageForColor(comp.ledColor);
  return DEFAULT_LED_FORWARD_VOLTAGE;
}

function ledForwardCurrentMa(comp: PlacedComponent): number {
  return comp.ledForwardCurrent ?? 20;
}

/** ngspice `.model` parameters for a diode that hits `ifMa` at `vf`. */
export function ledSpiceModelParams(vf: number, ifMa: number): string {
  const ifA = Math.max(1e-6, ifMa / 1000);
  const n = 2;
  const vt = 0.02585;
  const expTerm = Math.exp(vf / (n * vt)) - 1;
  const is = ifA / Math.max(expTerm, 1e-30);
  const rs = Math.max(0.5, (vf / ifA) * 0.15);
  return `Is=${is.toExponential(3)} N=${n} Rs=${rs.toFixed(2)}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Resistance (ohms) of whatever sits in series with this LED. A resistor bridging anode to
 * cathode is a shunt, not a series element, so it reports 1 ohm — effectively "shorted out".
 */
function seriesResistanceOhms(
  components: PlacedComponent[],
  netOfPin: (componentId: string, pinId: string) => number | null,
  anodeNet: number | null,
  cathodeNet: number | null,
): number {
  if (anodeNet === null || cathodeNet === null) return DEFAULT_SERIES_OHMS;

  for (const comp of components) {
    if (comp.type !== 'resistor') continue;
    const ra = netOfPin(comp.id, 'a');
    const rb = netOfPin(comp.id, 'b');
    if (ra === null || rb === null) continue;

    const touchesAnode = ra === anodeNet || rb === anodeNet;
    const touchesCathode = ra === cathodeNet || rb === cathodeNet;
    if (touchesAnode && touchesCathode) return 1;
    if (touchesAnode || touchesCathode) return resistorOhms(comp, MNA_OHM_FLOOR);
  }

  return DEFAULT_SERIES_OHMS;
}

/** True when a resistor sits in series with the LED rather than shunting it. */
function hasSeriesResistor(
  components: PlacedComponent[],
  netOfPin: (componentId: string, pinId: string) => number | null,
  anodeNet: number | null,
  cathodeNet: number | null,
): boolean {
  if (anodeNet === null || cathodeNet === null) return false;
  for (const comp of components) {
    if (comp.type !== 'resistor') continue;
    const ra = netOfPin(comp.id, 'a');
    const rb = netOfPin(comp.id, 'b');
    if (ra === null || rb === null) continue;
    const touchesAnode = ra === anodeNet || rb === anodeNet;
    const touchesCathode = ra === cathodeNet || rb === cathodeNet;
    if (touchesAnode && touchesCathode) continue;
    if (touchesAnode || touchesCathode) return true;
  }
  return false;
}

/**
 * Branch current (mA). Prefer the series resistor's |dV|/R whenever the LED is clearly
 * forward-biased — SPICE Vd often sits slightly under catalog Vf, and gating on
 * `vf - 0.05` alone zeros current (cathode wire dark) while the resistor still shows mA.
 * Norton fallback only when no series R is found.
 */
export function ledBranchCurrentMa(
  components: PlacedComponent[],
  netOfPin: (componentId: string, pinId: string) => number | null,
  resistorMa: (resistor: PlacedComponent) => number,
  anodeNet: number | null,
  cathodeNet: number | null,
  vDrop: number,
  vf: number,
  seriesOhmsFallback: number,
): number {
  // Forward enough to be an LED loop (not reverse / noise).
  if (vDrop > 0.4) {
    let sawSeriesR = false;
    let rMa = 0;
    for (const comp of components) {
      if (comp.type !== 'resistor') continue;
      const ra = netOfPin(comp.id, 'a');
      const rb = netOfPin(comp.id, 'b');
      if (ra === null || rb === null) continue;

      const touchesAnode = ra === anodeNet || rb === anodeNet;
      const touchesCathode = ra === cathodeNet || rb === cathodeNet;
      if (touchesAnode && touchesCathode) continue;

      if (touchesAnode || touchesCathode) {
        sawSeriesR = true;
        const iMa = resistorMa(comp);
        if (iMa > rMa) rMa = iMa;
      }
    }
    // Supply path via R — use it when conducting from the pin.
    if (rMa >= MIN_WIRE_CURRENT_MA) return rMa;
    // Cap discharge (GPIO low / R idle): don't zero — sense still forward (logs: LED
    // wire stair-dropped while glow + cap |C·dV/dt| continued).
    if (sawSeriesR && vDrop >= vf - VF_CONDUCT_SLACK_V) {
      return Math.max(0, ((vDrop - vf) / Math.max(seriesOhmsFallback, LED_ON_RESISTANCE_OHMS)) * 1000);
    }
    if (sawSeriesR) return 0;
  }

  if (vDrop < vf - VF_CONDUCT_SLACK_V) return 0;

  if (vDrop >= vf - 0.02) {
    const internalMa = (Math.max(0, vDrop - vf) / LED_ON_RESISTANCE_OHMS) * 1000;
    if (internalMa > 0) return internalMa;
  }

  return Math.max(0, ((vDrop - vf) / seriesOhmsFallback) * 1000);
}

/**
 * Glow / blown-X / body tint in footprint design space (led.svg viewBox ~14.7×29.5).
 * Paths are SVG artwork translated from viewBox origin (-1000,-1000) → (0,0).
 * Paint order matches led.svg: base → flange shadow → highlights.
 */
const LED_BODY = {
  /** path#path2 cgfx__basecolor — full plastic including bottom flange. */
  base: 'm 13.6,15.06 v -8.26 c 0,-3.76 -3.04,-6.8 -6.8,-6.8 -3.76,0 -6.8,3.04 -6.8,6.8 v 8.26 2.03 3.37 c 1.38,1.14 3.9,1.91 6.8,1.91 4.37,0 7.91,-1.74 7.91,-3.88 0,-0.23 0,-1.15 0,-1.4 0,-0.74 -0.41,-1.43 -1.11,-2.03 z',
  /** path#path4 — darkens the flange / lower body (black @ 50%). */
  flangeShadow:
    'm 13.6,15.06 v -1.97 c 0,1.64 -3.04,2.96 -6.8,2.96 -3.76,0 -6.8,-1.33 -6.8,-2.96 v 0 7.37 c 1.38,1.14 3.9,1.91 6.8,1.91 4.37,0 7.91,-1.74 7.91,-3.88 0,-0.23 0,-1.15 0,-1.4 0,-0.74 -0.41,-1.43 -1.11,-2.03 z',
  /** path#path3 — white rim highlight. */
  highlightRim:
    'm 6.8,14.13 c 3.76,0 6.8,1.33 6.8,2.96 v -2.03 c -1.38,-1.17 -3.9,-1.96 -6.8,-1.96 -2.9,0 -5.42,0.79 -6.8,1.96 v 2.03 c 0,-1.64 3.04,-2.96 6.8,-2.96 z',
  /** path#path5 — soft white body highlight. */
  highlightBody:
    'm 13.6,15.06 v 2.03 c 0,1.64 -3.04,2.96 -6.8,2.96 -3.76,0 -6.8,-1.33 -6.8,-2.96 v 2.03 c 1.38,1.17 3.9,1.96 6.8,1.96 4.37,0 7.91,-1.79 7.91,-3.99 0,-0.74 -0.41,-1.43 -1.11,-2.03 z',
  /** path#path6 — bright white specular. */
  highlightSpec:
    'm 1.79,15.09 c 1.24,0.59 3.02,0.96 5.01,0.96 1.99,0 3.77,-0.37 5.01,-0.96 -1.24,-0.59 -3.02,-0.96 -5.01,-0.96 -1.99,0 -3.77,0.37 -5.01,0.96 z',
  /** path#path7 cgfx__mask — dome silhouette (glow / blown-X). */
  path: 'm 6.8,20.06 c 3.76,0 6.8,-1.33 6.8,-2.96 v -10.29 c 0,-3.76 -3.04,-6.8 -6.8,-6.8 -3.76,0 -6.8,3.04 -6.8,6.8 v 10.29 c 0,1.63 3.04,2.96 6.8,2.96 z',
  cx: 6.8,
  cy: 11.5,
  hx: 5.5,
  hy: 7.5,
} as const;

function LedGlowOverlay({
  component,
  lit,
  brightness,
  blown,
}: {
  component: PlacedComponent;
  lit: boolean;
  brightness: number;
  blown: boolean;
}) {
  const { cx, cy, hx, hy, path, base, flangeShadow, highlightRim, highlightBody, highlightSpec } =
    LED_BODY;
  const color = component.ledColor ?? DEFAULT_LED_COLOR;
  // Brightness (from SPICE V/I) drives glow — not binary lit. Cap discharge keeps a
  // visible fade while vDrop is still present even when below Vf "conducting".
  const drawGlow = brightness > 0.02 && !blown;
  const glowClass = brightness >= 0.55 ? 'is-lit' : 'is-dim';
  // Unlit body stays dark so lit brightness reads on the dome, not only the outer halo.
  const bodyColorPct = drawGlow ? Math.round(55 + 45 * brightness) : 28;
  const bodyFill = `color-mix(in srgb, ${color} ${bodyColorPct}%, #0d0d0d)`;
  const highlightScale = drawGlow ? 0.55 + 0.45 * brightness : 0.35;
  if (blown) {
    const deadFill = `color-mix(in srgb, ${color} 22%, #0d0d0d)`;
    const deadHighlight = 0.25;
    return (
      <g className="led-package is-blown" pointerEvents="none" aria-hidden>
        <path d={base} className="led-body-tint" fill={deadFill} />
        <path d={flangeShadow} fill="#000000" opacity={0.5} />
        <path d={highlightRim} fill="#ffffff" opacity={0.3 * deadHighlight} />
        <path d={highlightBody} fill="#ffffff" opacity={0.2 * deadHighlight} />
        <path d={highlightSpec} fill="#ffffff" opacity={0.7 * deadHighlight} />
        <path d={path} className="led-body-tint" fill={deadFill} />
        <path
          d={`M ${cx - hx} ${cy - hy} L ${cx + hx} ${cy + hy}`}
          stroke="#ef5350"
          strokeWidth={1.4}
          opacity={0.85}
        />
        <path
          d={`M ${cx + hx} ${cy - hy} L ${cx - hx} ${cy + hy}`}
          stroke="#ef5350"
          strokeWidth={1.4}
          opacity={0.85}
        />
      </g>
    );
  }

  return (
    <g
      className={drawGlow ? `led-package ${glowClass}` : 'led-package'}
      style={
        drawGlow
          ? ({
              '--led-brightness': brightness,
              '--led-glow': color,
            } as CSSProperties)
          : undefined
      }
      pointerEvents="none"
      aria-hidden
    >
      {/* Same stack as led.svg: base → flange shadow → highlights → dome mask. */}
      <path d={base} className="led-body-tint" fill={bodyFill} />
      <path d={flangeShadow} fill="#000000" opacity={0.5} />
      <path d={highlightRim} fill="#ffffff" opacity={0.3 * highlightScale} />
      <path d={highlightBody} fill="#ffffff" opacity={0.2 * highlightScale} />
      <path d={highlightSpec} fill="#ffffff" opacity={0.7 * highlightScale} />
      {/* Opaque dome mask (path7) — restores full top size after flange shadow. */}
      <path d={path} className="led-body-tint" fill={bodyFill} />
      {drawGlow ? (
        <path
          d={path}
          className="led-glow-layer"
          fill={`color-mix(in srgb, ${color} 75%, white)`}
          opacity={0.25 + 0.5 * brightness}
        />
      ) : null}
    </g>
  );
}

export const ledModule: PartModule = {
  type: 'led',

  definition: {
    type: 'led',
    label: 'LED',
    scale: 2.5,
    artwork: '/components/led.svg',
    pins: [
      { id: 'cathode', description: 'Cathode', x: 3, y: 29, type: 'digital' },
      { id: 'anode', description: 'Anode', x: 14, y: 29, type: 'digital' },
    ],
  },

  spiceStamp(ctx) {
    const na = ctx.pinNet('anode');
    const nk = ctx.pinNet('cathode');
    if (na === null || nk === null) return;

    // 0V sense — the worker reads V-source branch currents i(V…), not device @D[i].
    const sense = `n${ctx.sid}_isense`;
    ctx.line(`Vi${ctx.sid} ${ctx.node(na)} ${sense} 0`);

    if (ctx.ledBlown[ctx.comp.id]) {
      ctx.line(`R${ctx.sid} ${sense} ${ctx.node(nk)} ${BLOWN_RESISTOR_OHMS}`);
      ctx.instance(`Vi${ctx.sid}`);
      return;
    }

    const resolved = ctx.resolveModel();
    if (resolved) {
      const inst = `${resolved.deviceLetter}${ctx.sid}`;
      ctx.line(`${inst} ${sense} ${ctx.node(nk)} ${resolved.spiceName}`);
      ctx.instance(`Vi${ctx.sid}`);
      return;
    }

    const model = `LED_${ctx.sid}`;
    ctx.model(
      `.model ${model} D (${ledSpiceModelParams(
        ledForwardVoltage(ctx.comp),
        ledForwardCurrentMa(ctx.comp),
      )})`,
    );
    ctx.line(`D${ctx.sid} ${sense} ${ctx.node(nk)} ${model}`);
    ctx.instance(`Vi${ctx.sid}`);
  },

  spiceCacheKey({ comp, ledBlown }) {
    const blown = ledBlown[comp.id] ? 'open' : 'ok';
    return `${comp.ledForwardVoltage}:${comp.ledForwardCurrent}:${comp.ledColor}:${blown}`;
  },

  legacyStamp(ctx) {
    const na = ctx.pinNet('anode');
    const nk = ctx.pinNet('cathode');
    if (na === null || nk === null) return;
    if (ctx.ledBlown[ctx.comp.id]) {
      ctx.stampResistor(na, nk, BLOWN_RESISTOR_OHMS);
    } else if (ctx.ledOn[ctx.comp.id]) {
      ctx.stampLedOn(na, nk, ledForwardVoltage(ctx.comp));
    }
  },

  legacySettleConduction(ctx) {
    const id = ctx.comp.id;

    if (ctx.ledBlown[id]) {
      if (ctx.ledOn[id]) {
        ctx.ledOn[id] = false;
        return true;
      }
      return false;
    }

    const na = ctx.pinNet('anode');
    const nk = ctx.pinNet('cathode');
    if (na === null || nk === null) return false;

    const vDrop = (ctx.voltages.get(na) ?? 0) - (ctx.voltages.get(nk) ?? 0);
    const next = vDrop >= ledForwardVoltage(ctx.comp) - VF_CONDUCT_SLACK_V;
    if (ctx.ledOn[id] === next) return false;
    ctx.ledOn[id] = next;
    return true;
  },

  evaluate(ctx) {
    const id = ctx.comp.id;
    if (ctx.dcLedOn?.[id] !== undefined) {
      ctx.flags.ledLit[id] = ctx.dcLedOn[id];
      return;
    }
    const vA = ctx.levelVolts(ctx.netLevel(ctx.pinNet('anode')));
    const vK = ctx.levelVolts(ctx.netLevel(ctx.pinNet('cathode')));
    ctx.flags.ledLit[id] = vA - vK >= ledForwardVoltage(ctx.comp) - VF_CONDUCT_SLACK_V;
  },

  visuals(ctx) {
    const { comp, components, simState, flags, branchCurrentMa } = ctx;
    const id = comp.id;

    if (!simState.ledBlown) simState.ledBlown = {};
    if (!simState.ledOvercurrentMs) simState.ledOvercurrentMs = {};

    if (simState.ledBlown[id]) {
      flags.ledBlown[id] = true;
      flags.ledLit[id] = false;
      flags.ledBrightness[id] = 0;
      flags.ledCurrentMa[id] = 0;
      return;
    }

    const nA = ctx.pinNet('anode');
    const nK = ctx.pinNet('cathode');
    const vDrop = ctx.netVolts(nA) - ctx.netVolts(nK);
    const vf = ledForwardVoltage(comp);
    const ratedMa = comp.ledForwardCurrent ?? DEFAULT_LED_FORWARD_CURRENT;

    if (vDrop <= -0.05 && getParallelCapDisplayV(ctx.components, ctx.netOfPin, nA, nK) === undefined) {
      flags.ledLit[id] = false;
      flags.ledBrightness[id] = 0;
      flags.ledCurrentMa[id] = 0;
      ledSenseSmoothV.delete(id);
      simState.ledOvercurrentMs[id] = 0;
      return;
    }

    // Sense from solved voltages / SPICE cap Vc only — no GPIO-predicted Vf invent.
    const capV = getParallelCapDisplayV(ctx.components, ctx.netOfPin, nA, nK);
    const rawSense =
      capV !== undefined ? Math.max(0, capV, vDrop) : Math.max(0, vDrop);
    const dt = Math.min(0.05, Math.max(0.001, ctx.blowDtMs / 1000));
    let sense = ledSenseSmoothV.get(id) ?? rawSense;
    {
      const tau = rawSense >= sense - 0.02 ? 0.03 : 0.08;
      sense += (rawSense - sense) * (1 - Math.exp(-dt / tau));
    }
    ledSenseSmoothV.set(id, sense);

    const seriesOhms = seriesResistanceOhms(components, ctx.netOfPin, nA, nK);
    const seriesResistorPresent = hasSeriesResistor(components, ctx.netOfPin, nA, nK);
    const spiceMa = branchCurrentMa?.[id];
    let currentMa: number;
    // Prefer SPICE branch current whenever present — do not invent a GPIO "predicted" mA.
    if (spiceMa !== undefined && spiceMa >= MIN_WIRE_CURRENT_MA) {
      currentMa = spiceMa;
    } else {
      currentMa = ledBranchCurrentMa(
        components,
        ctx.netOfPin,
        ctx.resistorMa,
        nA,
        nK,
        sense,
        vf,
        seriesOhms,
      );
      const dtWire = dt;
      let filt = ledWireCurrentFilt.get(id) ?? currentMa;
      const attack = 1 - Math.exp(-dtWire / 0.04);
      const release = 1 - Math.exp(-dtWire / 0.12);
      filt += (currentMa - filt) * (currentMa > filt ? attack : release);
      ledWireCurrentFilt.set(id, filt);
      currentMa = filt;
    }
    flags.ledCurrentMa[id] = currentMa;

    const targetBrightness = Math.max(
      0,
      Math.min(1, Math.pow(Math.max(0, sense) / Math.max(vf, 0.1), 1.15) * 0.95),
    );
    {
      const prevB = flags.ledBrightness[id] ?? targetBrightness;
      flags.ledBrightness[id] = prevB + (targetBrightness - prevB) * (1 - Math.exp(-dt / 0.05));
    }
    flags.ledLit[id] = flags.ledBrightness[id] >= 0.06;


    const conducting = sense >= vf - VF_CONDUCT_SLACK_V;

    const blowOut = (_reason: string): void => {
      simState.ledBlown[id] = true;
      flags.ledBlown[id] = true;
      flags.ledLit[id] = false;
      flags.ledBrightness[id] = 0;
      ledSenseSmoothV.delete(id);
    };

    if (!conducting) {
      simState.ledOvercurrentMs[id] = 0;
      return;
    }

    const overRatio = currentMa / Math.max(ratedMa, 1);
    if (seriesResistorPresent && overRatio >= BLOW_INSTANT_RATIO) {
      blowOut('instant');
      return;
    }

    if (seriesResistorPresent && overRatio >= BLOW_RATIO) {
      simState.ledOvercurrentMs[id] = (simState.ledOvercurrentMs[id] ?? 0) + ctx.blowDtMs;
      if ((simState.ledOvercurrentMs[id] ?? 0) >= BLOW_HOLD_MS) blowOut('hold');
    } else {
      simState.ledOvercurrentMs[id] = 0;
    }
  },

  branchCurrentPass: 1,
  branchCurrent(ctx) {
    const { comp, flags } = ctx;
    if (flags.ledBlown?.[comp.id]) return;
    const nA = ctx.pinNet('anode');
    const nK = ctx.pinNet('cathode');
    const spiceMa = ctx.branchCurrentMa?.[comp.id];
    const visualMa = flags.ledCurrentMa[comp.id] ?? 0;
    // Never invent rated If (logs: visualMa=0 + lit → branchMa=50 spike before off).
    const branchMa =
      spiceMa !== undefined && spiceMa >= MIN_WIRE_CURRENT_MA ? spiceMa : visualMa;
    if (branchMa < MIN_WIRE_CURRENT_MA) return;
    if (nA !== null) {
      const prev = ctx.netMa(nA);
      if (prev === undefined || branchMa > prev) ctx.setNetMa(nA, branchMa);
    }
    if (nK !== null) {
      const prev = ctx.netMa(nK);
      if (prev === undefined || branchMa > prev) ctx.setNetMa(nK, branchMa);
    }
  },

  seriesPins(comp, pinId, flags) {
    if (flags.ledBlown?.[comp.id]) return [];
    if (pinId === 'anode') return ['cathode'];
    if (pinId === 'cathode') return ['anode'];
    return [];
  },

  properties: {
    editable: true,
    defaults: () => ({
      ledColor: DEFAULT_LED_COLOR,
      ledForwardVoltage: defaultForwardVoltageForColor(DEFAULT_LED_COLOR),
      ledForwardCurrent: DEFAULT_LED_FORWARD_CURRENT,
    }),
    load(raw, into) {
      into.ledColor = isLedColorHex(raw.ledColor) ? raw.ledColor : DEFAULT_LED_COLOR;
      const vf = raw.ledForwardVoltage;
      into.ledForwardVoltage =
        isFiniteNumber(vf) && vf > 0 && vf <= 10 ? vf : DEFAULT_LED_FORWARD_VOLTAGE;
      const ifMa = raw.ledForwardCurrent;
      into.ledForwardCurrent =
        isFiniteNumber(ifMa) && ifMa > 0 && ifMa <= 1000
          ? ifMa
          : DEFAULT_LED_FORWARD_CURRENT;
    },
  },

  overlay: ({ component, simFlags }) => {
    const id = component.id;
    return (
      <LedGlowOverlay
        component={component}
        lit={!!(simFlags?.ledLit[id] ?? false)}
        brightness={simFlags?.ledBrightness[id] ?? (simFlags?.ledLit[id] ? 1 : 0)}
        blown={simFlags?.ledBlown[id] ?? false}
      />
    );
  },
};

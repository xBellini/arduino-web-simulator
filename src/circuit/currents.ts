/**
 * What: Component- and net-level branch current (mA) from DC voltages and/or digital levels.
 *
 * Owns/exports: `resistorCurrentMa`, `ledBranchCurrentMa`, `buildNetBranchCurrentMa`, and
 * related per-type estimators used by visuals and meters.
 *
 * Conventions: Prefer SPICE/`branchCurrentMa` on `DcSolveResult` when present; estimators fill
 * gaps. Uses `LED_ON_RESISTANCE_OHMS` for conducting LEDs. Net aggregation powers wire animation
 * via `circuit/solver.ts` → circuit/currents.ts.
 *
 * To add ammeter/readout for a new part type, add a focused estimator function and call it from
 * `buildNetBranchCurrentMa` (keep mA sign convention consistent with neighbors).
 * To align blow/overcurrent visuals, pass the same `BranchCurrentFlags` shape
 * (`ledLit`, `rgbLedChannels`, blow maps) as circuit/visuals.ts.
 * To use digital-only levels, ensure `levelToVoltage` thresholds match circuit/solver.ts logic.
 *
 * Not here: SPICE branch-current readout — see spice/worker.ts and spice/client.ts mapping.
 *
 * Merged in from `src/sim/wireCurrent.ts`: Wire animation and label geometry after a solve — fills
 * `ComponentSimFlags.wireCurrentMa` and `wireFlowReversed` via {@link updateWireCurrents}.
 * Owns/exports: `updateWireCurrents`, `wireShowsCurrent`, `wireFlowDuration`, `pointAlongPolyline`,
 * `labelAngleAlongPolyline`. Conventions: Call only after `solveCircuit` (needs net levels, flags,
 * and `estimateNetCurrentMa`). Flow direction follows conventional current from sources; magnitude
 * zero or unavailable current hides animation; every finite positive magnitude animates. Series parts bridge BFS between pin pairs. To treat
 * a part as in-series for flow direction, implement `seriesPins` on its part module. To change when
 * dots appear, adjust `wireShowsCurrent` or duration in `wireFlowDuration`.
 * To add a new power-source pin role, implement `pinRole` on the module (or rely on registry
 * `power`/`ground` pin types). Not here: Branch mA per component or DC voltages — see branchCurrent
 * and circuit/dcSolver.ts.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | [src/sim/wireCurrent.ts] Changelog creation
#                     | [src/sim/wireCurrent.ts] Expanded What with practical how-to notes
#                     | [src/sim/wireCurrent.ts] Part modules supply `seriesPins` and `pinRole`; `isSinkPin` now takes sim flags
#                     | [src/sim/wireCurrent.ts] Deleted leftover series/source type arms; modules own pinRole and seriesPins
#                     | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | Named the claim order `BRANCH_PASS` and dispatch part modules per pass; `BranchCurrentFlags` now lives in the part module contract
#                     | Deleted leftover per-type claim loops; modules own every pass
# 09-10-2026 | Cursor | Header: branch currents now come from ngspice.worker (opOutputParse removed)
#                     | Merged `src/sim/wireCurrent.ts` into this file (tree reorganization)
#                     | Moved from `src/sim/branchCurrent.ts` (tree reorganization)
# 13-10-2026 | Codex | Read direct LCD leaf-wire currents from solver branches; show sampled logic without flow; shared rails retain existing estimates.
#                     | Prefer known endpoint logic over floating readings on backpack-to-LCD wires.
# 14-10-2026 | Codex | Resolve LED/resistor leaf-wire direction from declared terminals and solved voltage; whole-part paths retain solved-net legacy fallback.
# 15-10-2026 | Codex | Reverse measured terminal flow for source parts so supply current leaves positive and returns through negative.
#                     | Sum measured load-terminal currents through explicit junction trees; leave ambiguous or unmeasured branches on the existing fallback.
#                     | Animate small positive currents too; retain the 2.5-second slowest cycle and actual current labels, with zero/unavailable values static.
#                     | Resolve supply and return wire trees by signed measured terminal currents, including shared button pins; never copy button current across a net.
#                     | Show N/A on declared unmodeled supply terminals, including both RTC headers, without current animation.
# 17-10-2026 | Codex  | Follow named-net copper links when summing measured branch currents.
 */

import { isMcuBoard } from '../avr/pinMap';
import { formatCurrentMa } from '../values/electric';
import type { PlacedComponent, Wire } from '../types';
import { DEFAULT_RESISTANCE_UNIT, DEFAULT_RESISTANCE_VALUE, resistanceToOhms } from '../values/resistor';
import { namedNetLinks, netForPin, type CircuitNetlist, type NetLevel } from './netlist';
import { LED_ON_RESISTANCE_OHMS } from '../components/output/led';
import { VF_CONDUCT_SLACK_V } from '../values/led';
import { getPartModule } from '../components';
import type { BranchCurrentFlags } from '../components/partModule';
import { getDefinition } from '../registry/components';
import { estimateNetCurrentMa, type ComponentSimFlags } from './solver';

/**
 * Order in which parts claim a net's branch current. Earlier passes win: resistors and
 * ammeters measure a real current, LEDs and buzzers fill in nets nothing measured, and
 * buttons copy whatever the rest of the loop already produced.
 */
const BRANCH_PASS = {
  series: 0,
  diode: 1,
  multiDie: 2,
  load: 3,
  relay: 4,
} as const;

function pinNet(
  netlist: CircuitNetlist,
  componentId: string,
  pinId: string,
): number | null {
  return netForPin(netlist, { componentId, pinId });
}

function componentResistanceOhms(comp: PlacedComponent): number {
  const value = comp.resistanceValue ?? DEFAULT_RESISTANCE_VALUE;
  const unit = comp.resistanceUnit ?? DEFAULT_RESISTANCE_UNIT;
  return Math.max(1, resistanceToOhms(value, unit));
}

function levelToVoltage(level: NetLevel): number {
  if (level === 'high') return 5;
  if (level === 'low') return 0;
  return 2.5;
}

function netLevel(
  levels: Map<number, NetLevel>,
  netId: number | null,
): NetLevel {
  if (netId === null) return 'floating';
  return levels.get(netId) ?? 'floating';
}

function readNetVoltage(
  netVoltages: Map<number, number> | undefined,
  levels: Map<number, NetLevel>,
  netId: number | null,
): number | null {
  if (netId !== null && netVoltages?.has(netId)) {
    return netVoltages.get(netId)!;
  }
  if (netId === null) return null;
  const level = netLevel(levels, netId);
  if (level === 'floating') return null;
  return levelToVoltage(level);
}

/** Branch current (mA) through a resistor from solved net voltages. */
export function resistorCurrentMa(
  netlist: CircuitNetlist,
  comp: PlacedComponent,
  netVoltages: Map<number, number> | undefined,
  levels: Map<number, NetLevel>,
): number {
  const na = pinNet(netlist, comp.id, 'a');
  const nb = pinNet(netlist, comp.id, 'b');
  const va = readNetVoltage(netVoltages, levels, na);
  const vb = readNetVoltage(netVoltages, levels, nb);
  if (va === null || vb === null) return 0;
  const ohms = componentResistanceOhms(comp);
  return (Math.abs(va - vb) / ohms) * 1000;
}

/**
 * LED branch current (mA). Prefer series-resistor |ΔV|/R when forward-biased; SPICE Vd often
 * sits slightly under catalog Vf so a tight `vf - 0.05` gate wrongly zeroes current.
 */
export function ledBranchCurrentMa(
  netlist: CircuitNetlist,
  components: PlacedComponent[],
  anodeNet: number | null,
  cathodeNet: number | null,
  netVoltages: Map<number, number> | undefined,
  levels: Map<number, NetLevel>,
  vDrop: number,
  vf: number,
  seriesOhmsFallback: number,
): number {
  if (vDrop > 0.4) {
    let sawSeriesR = false;
    for (const comp of components) {
      if (comp.type !== 'resistor') continue;
      const ra = pinNet(netlist, comp.id, 'a');
      const rb = pinNet(netlist, comp.id, 'b');
      if (ra === null || rb === null) continue;

      const touchesAnode = ra === anodeNet || rb === anodeNet;
      const touchesCathode = ra === cathodeNet || rb === cathodeNet;
      if (touchesAnode && touchesCathode) continue;

      if (touchesAnode || touchesCathode) {
        sawSeriesR = true;
        const iMa = resistorCurrentMa(netlist, comp, netVoltages, levels);
        if (iMa >= 0.05) return iMa;
      }
    }
    if (sawSeriesR) return 0;
  }

  if (vDrop < vf - VF_CONDUCT_SLACK_V) return 0;

  if (vDrop >= vf - 0.02) {
    const internalMa =
      (Math.max(0, vDrop - vf) / LED_ON_RESISTANCE_OHMS) * 1000;
    if (internalMa > 0) return internalMa;
  }

  return Math.max(0, ((vDrop - vf) / seriesOhmsFallback) * 1000);
}

/**
 * One branch current (mA) per net — avoids double-counting resistor + LED on the same series node.
 */
export function buildNetBranchCurrentMa(
  netlist: CircuitNetlist,
  components: PlacedComponent[],
  flags: BranchCurrentFlags,
  netVoltages: Map<number, number> | undefined,
  levels: Map<number, NetLevel>,
  branchCurrentMa?: Record<string, number>,
): Map<number, number> {
  const result = new Map<number, number>();

  /**
   * Parts whose `branchCurrentPass` is `pass` claim nets first-come. Earlier passes
   * win: resistors/ammeters measure, LEDs/buzzers fill gaps, buttons copy the loop.
   */
  const runModulePass = (pass: number): void => {
    for (const comp of components) {
      const mod = getPartModule(comp.type);
      if (!mod?.branchCurrent || (mod.branchCurrentPass ?? 0) !== pass) continue;
      mod.branchCurrent({
        comp,
        components,
        netlist,
        levels,
        flags,
        netVoltages,
        branchCurrentMa,
        pinNet: (pinId) => pinNet(netlist, comp.id, pinId),
        netMa: (netId) => result.get(netId),
        setNetMa: (netId, ma) => result.set(netId, ma),
        resistorMa: (resistor) =>
          resistorCurrentMa(netlist, resistor, netVoltages, levels),
      });
    }
  };

  runModulePass(BRANCH_PASS.series);
  runModulePass(BRANCH_PASS.diode);
  runModulePass(BRANCH_PASS.multiDie);
  runModulePass(BRANCH_PASS.load);
  // Buttons copy the loop current onto every pin net so PSU+ → button 1a still animates.
  runModulePass(BRANCH_PASS.relay);

  return result;
}


/** Lower = closer to the positive supply (conventional current origin). */
const ROLE_SOURCE = 0;
const ROLE_PASSIVE = 50;
const ROLE_SINK = 100;

type PinRef = { componentId: string; pinId: string };

function pinRefKey(ref: PinRef): string {
  return `${ref.componentId}:${ref.pinId}`;
}

function parsePinRefKey(key: string): PinRef {
  const split = key.indexOf(':');
  return { componentId: key.slice(0, split), pinId: key.slice(split + 1) };
}

function isSourcePin(
  comp: PlacedComponent,
  pinId: string,
  flags: ComponentSimFlags,
): boolean {
  const role = getPartModule(comp.type)?.pinRole?.(comp, pinId, flags);
  if (role !== undefined) return role === 'source';

  const def = getDefinition(comp.type);
  const pin = def.pins.find((p) => p.id === pinId);
  return pin?.type === 'power';
}

function isSinkPin(
  comp: PlacedComponent,
  pinId: string,
  flags: ComponentSimFlags,
): boolean {
  const role = getPartModule(comp.type)?.pinRole?.(comp, pinId, flags);
  if (role !== undefined) return role === 'sink';

  const def = getDefinition(comp.type);
  const pin = def.pins.find((p) => p.id === pinId);
  return pin?.type === 'ground';
}

function pinRolePriority(
  comp: PlacedComponent,
  pinId: string,
  flags: ComponentSimFlags,
): number {
  if (isSourcePin(comp, pinId, flags)) return ROLE_SOURCE;
  if (isSinkPin(comp, pinId, flags)) return ROLE_SINK;
  return ROLE_PASSIVE;
}

/** Other pins reachable through this component in series (same branch current). */
function seriesNeighborPinIds(
  comp: PlacedComponent,
  pinId: string,
  flags: ComponentSimFlags,
): string[] {
  const mod = getPartModule(comp.type);
  return mod?.seriesPins?.(comp, pinId, flags) ?? [];
}

/**
 * Shortest series-path distance from any power source pin.
 * Pins on the same net share the same distance; crossing a 2-terminal part adds 1.
 */
function buildUpstreamDistance(
  netlist: CircuitNetlist,
  components: PlacedComponent[],
  flags: ComponentSimFlags,
): Map<string, number> {
  const compById = new Map(components.map((c) => [c.id, c]));
  const dist = new Map<string, number>();
  const queue: string[] = [];

  for (const comp of components) {
    const def = getDefinition(comp.type);
    for (const pin of def.pins) {
      if (!isSourcePin(comp, pin.id, flags)) continue;
      const key = pinRefKey({ componentId: comp.id, pinId: pin.id });
      if (dist.has(key)) continue;
      dist.set(key, 0);
      queue.push(key);
    }
  }

  for (let qi = 0; qi < queue.length; qi++) {
    const key = queue[qi]!;
    const d = dist.get(key)!;
    const ref = parsePinRefKey(key);
    const comp = compById.get(ref.componentId);
    if (!comp) continue;

    const netId = netForPin(netlist, ref);
    if (netId !== null) {
      for (const ep of netlist.nets.get(netId) ?? []) {
        const netKey = pinRefKey({ componentId: ep.componentId, pinId: ep.pinId });
        if (!dist.has(netKey)) {
          dist.set(netKey, d);
          queue.push(netKey);
        }
      }
    }

    for (const otherPinId of seriesNeighborPinIds(comp, ref.pinId, flags)) {
      const seriesKey = pinRefKey({ componentId: comp.id, pinId: otherPinId });
      const nextDist = d + 1;
      const prev = dist.get(seriesKey);
      if (prev === undefined || nextDist < prev) {
        dist.set(seriesKey, nextDist);
        queue.push(seriesKey);
      }
    }
  }

  return dist;
}

function upstreamRank(
  ref: PinRef,
  components: PlacedComponent[],
  flags: ComponentSimFlags,
  dist: Map<string, number>,
): number {
  const comp = components.find((c) => c.id === ref.componentId);
  const distance = dist.get(pinRefKey(ref)) ?? 999;
  const role = comp ? pinRolePriority(comp, ref.pinId, flags) : ROLE_PASSIVE;
  return distance * 1000 + role;
}

export function updateWireCurrents(
  wires: Wire[],
  netlist: CircuitNetlist,
  levels: Map<number, NetLevel>,
  components: PlacedComponent[],
  flags: ComponentSimFlags,
  netVoltages?: Map<number, number>,
  branchByNet?: Map<number, number>,
  branchCurrentMa?: Record<string, number>,
): void {
  flags.wireReadingLabel = {};
  const byId = new Map(components.map(comp => [comp.id, comp]));
  const degree = new Map<string, number>();
  const adjacent = new Map<string, Wire[]>();
  for (const wire of [...wires, ...namedNetLinks(components)]) for (const end of [wire.from, wire.to]) {
    const key = pinRefKey(end);
    degree.set(key, (degree.get(key) ?? 0) + 1);
    const edges = adjacent.get(key) ?? [];
    edges.push(wire);
    adjacent.set(key, edges);
  }
  const netCache = new Map<number, number>();
  const upstreamDist = buildUpstreamDistance(netlist, components, flags);

  for (const wire of wires) {
    let logic: NetLevel | undefined;
    for (const end of [wire.from, wire.to]) {
      const comp = byId.get(end.componentId);
      const read = comp && getPartModule(comp.type)?.wireLogicLevel;
      if (!read) continue;
      const sample = read(end.pinId, pin => netLevel(levels, pinNet(netlist, comp.id, pin)), comp);
      if (sample !== undefined && (logic === undefined || logic === 'floating')) logic = sample;
      if (logic !== undefined && logic !== 'floating') break;
    }
    if (logic !== undefined) {
      flags.wireReadingLabel[wire.id] = logic.toUpperCase();
      flags.wireCurrentMa[wire.id] = 0;
      flags.wireFlowReverse[wire.id] = false;
      continue;
    }
    // Unmodeled declared supply terminals must not inherit another load's current.
    if ([wire.from, wire.to].some(end => {
      const comp = byId.get(end.componentId);
      const mod = comp && getPartModule(comp.type);
      return mod?.wireCurrentPath?.(end.pinId) && !mod.spiceStamp;
    })) {
      flags.wireCurrentMa[wire.id] = 0;
      flags.wireReadingLabel[wire.id] = 'N/A';
      flags.wireFlowReverse[wire.id] = false;
      continue;
    }
    let hasCurrentPath = false;
    // Cut this wire and sum signed terminal currents on either resulting wire tree.
    // Shared component pins are vertices too: a button-to-resistor branch must not
    // inherit all the current on the button's supply net. Loops remain ambiguous.
    for (const [side, start] of [wire.from, wire.to].entries()) {
      const queue = [start];
      const visited = new Set<string>();
      let total = 0, measuredLeaves = 0, valid = true;
      while (queue.length && valid) {
        const pin = queue.pop()!;
        const key = pinRefKey(pin);
        if (visited.has(key)) { valid = false; break; }
        visited.add(key);
        const comp = byId.get(pin.componentId);
        const mod = comp && getPartModule(comp.type);
        if (!comp || isMcuBoard(comp.type) || mod?.standaloneSource) { valid = false; break; }
        const terminal = branchCurrentMa?.[comp.id + ':terminal:' + pin.pinId];
        const path = mod?.wireCurrentPath?.(pin.pinId);
        if (terminal !== undefined) {
          total += terminal;
          measuredLeaves++;
        } else if (path && mod?.spiceStamp) {
          const measured = branchCurrentMa?.[path.branch === undefined ? comp.id : comp.id + ':' + path.branch];
          const positive = pinNet(netlist, comp.id, path.positive);
          const negative = pinNet(netlist, comp.id, path.negative);
          const vp = positive === null ? undefined : netVoltages?.get(positive);
          const vn = negative === null ? undefined : netVoltages?.get(negative);
          if (measured === undefined || vp === undefined || vn === undefined) { valid = false; break; }
          total += measured * ((pin.pinId === path.positive) === (vp >= vn) ? 1 : -1);
          measuredLeaves++;
        } else if (mod?.spiceStamp) {
          valid = false; break;
        }
        // A digital-only part contributes no load to the SPICE model. Do not
        // invent its physical consumption, or traverse hidden copper as a wire.
        const sameNetPins = (netlist.nets.get(netForPin(netlist, pin) ?? -1) ?? [])
          .filter(ep => ep.componentId === comp.id && ep.pinId !== pin.pinId && degree.has(pinRefKey(ep)));
        if (!path && terminal === undefined && sameNetPins.length) { valid = false; break; }
        for (const next of adjacent.get(key) ?? []) {
          if (next.id === wire.id) continue;
          const other = pinRefKey(next.from) === key ? next.to : pinRefKey(next.to) === key ? next.from : null;
          if (other && !visited.has(pinRefKey(other))) queue.push(other);
        }
      }
      if (valid && measuredLeaves) {
        flags.wireCurrentMa[wire.id] = Math.abs(total);
        flags.wireReadingLabel[wire.id] = formatCurrentMa(Math.abs(total));
        flags.wireFlowReverse[wire.id] = (side === 0) === (total >= 0);
        hasCurrentPath = true;
        break;
      }
    }
    if (hasCurrentPath) continue;

    for (const [index, end] of [wire.from, wire.to].entries()) {
      const comp = byId.get(end.componentId);
      const path = comp && getPartModule(comp.type)?.wireCurrentPath?.(end.pinId);
      if (!path || degree.get(pinRefKey(end)) !== 1) continue;
      const a = pinNet(netlist, comp.id, path.positive), b = pinNet(netlist, comp.id, path.negative);
      const branchKey = path.branch === undefined ? comp.id : comp.id + ':' + path.branch;
      const ma = a === null || b === null || a === b ? 0
        : branchCurrentMa?.[branchKey] ?? (path.branch === undefined ? branchByNet?.get(a) : undefined);
      flags.wireCurrentMa[wire.id] = ma ?? 0;
      flags.wireReadingLabel[wire.id] = ma === undefined ? 'N/A' : formatCurrentMa(ma);
      const va = a === null ? undefined : netVoltages?.get(a);
      const vb = b === null ? undefined : netVoltages?.get(b);
      const intoLoad = (end.pinId === path.positive) === (va !== undefined && vb !== undefined && va >= vb);
      const intoPart = getPartModule(comp.type)?.standaloneSource ? !intoLoad : intoLoad;
      flags.wireFlowReverse[wire.id] = index === 0 ? intoPart : !intoPart;
      hasCurrentPath = true;
      break;
    }
    if (hasCurrentPath) continue;
    if ([wire.from, wire.to].some(end => {
      const comp = byId.get(end.componentId);
      return comp && comp.type !== 'wire_junction' && !isMcuBoard(comp.type) &&
        !getPartModule(comp.type)?.spiceStamp && degree.get(pinRefKey(end)) === 1;
    })) {
      flags.wireCurrentMa[wire.id] = 0;
      flags.wireReadingLabel[wire.id] = 'N/A';
      flags.wireFlowReverse[wire.id] = false;
      continue;
    }
    const netFrom = netForPin(netlist, wire.from);
    const netTo = netForPin(netlist, wire.to);
    const netId = netFrom ?? netTo;

    if (netId === null) {
      flags.wireCurrentMa[wire.id] = 0;
      flags.wireFlowReverse[wire.id] = false;
      continue;
    }

    let currentMa = netCache.get(netId);
    if (currentMa === undefined) {
      currentMa = estimateNetCurrentMa(
        netId,
        netlist,
        levels,
        components,
        flags,
        netVoltages,
        branchByNet,
      );
      netCache.set(netId, currentMa);
    }

    flags.wireCurrentMa[wire.id] = currentMa;
    if (!wireShowsCurrent(currentMa)) {
      flags.wireFlowReverse[wire.id] = false;
      continue;
    }

    const fromRank = upstreamRank(wire.from, components, flags, upstreamDist);
    const toRank = upstreamRank(wire.to, components, flags, upstreamDist);
    // Animation follows wire.from → wire.to; reverse when from is downstream of to.
    flags.wireFlowReverse[wire.id] = fromRank > toRank;
  }
}

export function wireShowsCurrent(currentMa: number | undefined): boolean {
  return currentMa !== undefined && Number.isFinite(currentMa) && currentMa > 0;
}

export function wireFlowDuration(currentMa: number): string {
  const speed = Math.max(
    0.35,
    Math.min(2.5, 1.2 / Math.sqrt(Math.max(currentMa, 0.1))),
  );
  return `${speed.toFixed(2)}s`;
}

export interface Point2 {
  x: number;
  y: number;
}

/** Point at fraction t (0–1) along a polyline by arc length. */
export function pointAlongPolyline(points: Point2[], t: number): Point2 {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };

  const segments: { a: Point2; b: Point2; len: number }[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segments.push({ a, b, len });
    total += len;
  }
  if (total <= 0) return { ...points[0] };

  let target = Math.max(0, Math.min(1, t)) * total;
  for (const seg of segments) {
    if (target <= seg.len) {
      const u = seg.len > 0 ? target / seg.len : 0;
      return {
        x: seg.a.x + (seg.b.x - seg.a.x) * u,
        y: seg.a.y + (seg.b.y - seg.a.y) * u,
      };
    }
    target -= seg.len;
  }
  return { ...points[points.length - 1] };
}

export function labelAngleAlongPolyline(points: Point2[]): number {
  if (points.length < 2) return 0;
  const before = pointAlongPolyline(points, 0.45);
  const after = pointAlongPolyline(points, 0.55);
  const angle = (Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI;
  if (angle > 90) return angle - 180;
  if (angle < -90) return angle + 180;
  return angle;
}

/**
 * What: Frame visual/sim-flag updates from solved physics — brightness, heat, failure.
 *
 * Owns/exports: `updateComponentVisuals` (mutates {@link ComponentSimFlags} and
 * {@link CircuitSimState} blow timers).
 *
 * Conventions: Called from `solveCircuit` after net levels/voltages are known. Each
 * simulating part owns its own `visuals` hook; this file only times the pass and
 * hands each part the helpers it needs (net voltage, neighbour-resistor current).
 *
 * To add blow/overheat behavior for a new part, implement `visuals` on its module
 * and persist timers on `CircuitSimState` if they must survive across frames.
 * To change LED brightness, edit `src/components/output/led.tsx` — not a switch here.
 *
 * Not here: Wire flow dots or ngspice — see circuit/currents.ts and circuit/dcSolver.ts.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | Part module `visuals` dispatch runs before the legacy per-type passes
#                     | Deleted leftover per-type visual passes; modules own brightness/heat/blow
# 09-10-2026 | Cursor | Moved from `src/sim/componentVisuals.ts` (tree reorganization)
# 15-10-2026 | Codex | Derive module lamps from solved supply polarity; MCU boards retain the existing powered-on simulation convention.
 */


import type { PlacedComponent } from '../types';
import type { CircuitNetlist, NetLevel } from './netlist';
import { netForPin } from './netlist';
import { resistorCurrentMa } from './currents';
import type { CircuitSimState, ComponentSimFlags } from './solver';
import { getPartModule } from '../components';
import { getDefinition } from '../registry/components';

const SUPPLY_V = 5;

function pinNet(
  netlist: CircuitNetlist,
  componentId: string,
  pinId: string,
): number | null {
  return netForPin(netlist, { componentId, pinId });
}

function levelToVoltage(level: NetLevel): number {
  if (level === 'high') return SUPPLY_V;
  if (level === 'low') return 0;
  return SUPPLY_V / 2;
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
): number {
  if (netId !== null && netVoltages?.has(netId)) {
    return netVoltages.get(netId)!;
  }
  return levelToVoltage(netLevel(levels, netId));
}

/** Compute brightness, heat, and failure visuals after the net solve. */
export function updateComponentVisuals(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  levels: Map<number, NetLevel>,
  simState: CircuitSimState,
  flags: ComponentSimFlags,
  simTimeMs: number,
  netVoltages?: Map<number, number>,
  ledConducting?: Record<string, boolean>,
  branchCurrentMa?: Record<string, number>,
): void {
  const prev = simState.lastVisualMs ?? simTimeMs;
  const dtMs = Math.max(0, simTimeMs - prev);
  const blowDtMs = dtMs > 0 ? dtMs : 16;
  simState.lastVisualMs = simTimeMs;

  flags.modulePowered = {};
  for (const comp of components) {
    const lamp = getDefinition(comp.type).powerIndicator;
    if (lamp) {
      const p = pinNet(netlist, comp.id, lamp.positive), n = pinNet(netlist, comp.id, lamp.negative);
      const vp = p === null ? undefined : netVoltages?.get(p);
      const vn = n === null ? undefined : netVoltages?.get(n);
      flags.modulePowered[comp.id] = lamp.poweredBoard === true ||
        (vp !== undefined && vn !== undefined && vp > vn);
    }
    const mod = getPartModule(comp.type);
    if (!mod?.visuals) continue;
    mod.visuals({
      comp,
      components,
      netlist,
      levels,
      simState,
      flags,
      dtMs,
      blowDtMs,
      netVoltages,
      ledConducting,
      branchCurrentMa,
      pinNet: (pinId) => pinNet(netlist, comp.id, pinId),
      netOfPin: (componentId, pinId) => pinNet(netlist, componentId, pinId),
      netVolts: (netId) => readNetVoltage(netVoltages, levels, netId),
      resistorMa: (resistor) =>
        resistorCurrentMa(netlist, resistor, netVoltages, levels),
    });
  }
}

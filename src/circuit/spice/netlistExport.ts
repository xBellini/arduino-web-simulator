/**
 * What: Canvas → ngspice DC deck exporter for `.OP` (nodes, elements, includes, maps).
 *
 * Owns/exports: `exportSpiceOpNetlist`, `SpiceNetlistExport`, `ButtonPressedState` (shared with
 * legacy DC).
 *
 * Conventions: Ground net → node `0`; others `n{netId}`. Each simulating part stamps itself
 * via `PartModule.spiceStamp`. MCU rails are appended after parts as `VmcuN` sources.
 * `spiceInstanceByComponentId` enables `#branch` lookup in spice/client.ts.
 *
 * To add a component to SPICE OP, implement `spiceStamp` on its part module (see `src/components/`).
 * To include a new library, resolve the model in spice/models.ts; `.include` is collected
 * automatically from catalog hits.
 *
 * Not here: Running ngspice or reading its results — see spice/client.ts and spice/worker.ts.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | Part module `spiceStamp` dispatch runs before the legacy type switch
#                     | Removed leftover type switch; all stamps live on part modules
# 25-09-2026 | Cursor | Capacitor companion Ic/dt threaded into spiceStamp for .OP dynamics
# 08-10-2026 | Cursor | Emit `.param vcc=5` when 74HC / Digital Logic libs are included (XSPICE auto_bridge)
#                     | Export options: skip/only digital ICs + forced net V sources (hybrid XSPICE↔Concord)
# 09-10-2026 | Cursor | Removed XSPICE hybrid glue (skip/only/forced-V options, `.param vcc`, gate I/O net helper)
#                     | Header: results are read by ngspice.worker (opOutputParse removed)
#                     | Moved from `src/sim/spice/netlistExport.ts` (tree reorganization)
 */


import type { PlacedComponent } from '../../types';
import type { CircuitNetlist, McuSourceMap } from '../netlist';
import { netForPin } from '../netlist';
import type { SupplyVoltageOverrides } from '../supplyLimit';
import { findGroundNetId } from '../mnaLegacy';
import type { SpiceCatalog } from './models';
import {
  collectLibPathsForComponents,
  resolveSpiceModelForComponent,
} from './models';
import { getPartModule } from '../../components';

export type ButtonPressedState = Record<string, boolean>;

export interface SpiceNetlistExport {
  netlist: string;
  /** Canvas net id → SPICE node name */
  netToNode: Map<number, string>;
  groundNetId: number | null;
  /** Library files referenced via .include (paths under public/spice/models/). */
  libPaths: string[];
  /** Canvas component id → SPICE instance name (e.g. R1, D2) for #branch lookup. */
  spiceInstanceByComponentId: Map<string, string>;
}

function spiceLibIncludePath(relativeLibPath: string): string {
  return `/lib/${relativeLibPath.replace(/\\/g, '/')}`;
}

function nodeName(netId: number, groundNetId: number | null): string {
  if (groundNetId !== null && netId === groundNetId) return '0';
  return `n${netId}`;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function trackSpiceInstance(
  map: Map<string, string>,
  componentId: string,
  instanceName: string,
): void {
  map.set(componentId, instanceName);
}

/**
 * Export canvas netlist → SPICE netlist for DC operating point (.op).
 */
export function exportSpiceOpNetlist(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs = 0,
  catalog: SpiceCatalog | null = null,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  supplyVoltageOverrides: SupplyVoltageOverrides = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
  nodeIc: Map<number, number> | null = null,
): SpiceNetlistExport | null {
  const groundNetId = findGroundNetId(netlist);
  if (groundNetId === null) return null;

  const netToNode = new Map<number, string>();
  for (const netId of netlist.nets.keys()) {
    netToNode.set(netId, nodeName(netId, groundNetId));
  }

  /** Nets already forced by an explicit V source (bench supply / oscillator). */
  const sourcedNets = new Set<number>();

  const lines: string[] = [
    '* Arduino Simulator — DC / transient export',
    '.title breadboard_export',
  ];
  const models: string[] = [];
  const spiceInstanceByComponentId = new Map<string, string>();

  const libPaths = collectLibPathsForComponents(components, catalog);
  for (const rel of libPaths) {
    lines.push(`.include ${spiceLibIncludePath(rel)}`);
  }
  if (libPaths.length > 0) lines.push('');

  for (const comp of components) {
    const sid = sanitizeId(comp.id);
    const mod = getPartModule(comp.type);
    if (!mod?.spiceStamp) continue;
    mod.spiceStamp({
      comp,
      sid,
      netlist,
      catalog,
      simTimeMs,
      resistorBlown,
      ledBlown,
      buttonPressed,
      capacitorBlown,
      supplyVoltageOverrides,
      pinNet: (pinId) => netForPin(netlist, { componentId: comp.id, pinId }),
      node: (netId) => nodeName(netId, groundNetId),
      line: (text) => lines.push(text),
      model: (text) => models.push(text),
      instance: (name) =>
        trackSpiceInstance(spiceInstanceByComponentId, comp.id, name),
      markSourced: (netId) => sourcedNets.add(netId),
      resolveModel: () => resolveSpiceModelForComponent(comp, catalog),
    });
  }

  // MCU board rails + GPIO outputs as ideal voltage sources to ground.
  let mcuSourceIndex = 0;
  for (const [netId, volts] of mcuSources) {
    if (netId === groundNetId || sourcedNets.has(netId)) continue;
    lines.push(`Vmcu${mcuSourceIndex} ${nodeName(netId, groundNetId)} 0 DC ${volts}`);
    sourcedNets.add(netId);
    mcuSourceIndex += 1;
  }

  if (models.length > 0) {
    lines.push('', ...models);
  }

  if (nodeIc && nodeIc.size > 0) {
    lines.push('');
    for (const [netId, volts] of nodeIc) {
      if (!Number.isFinite(volts)) continue;
      const n = nodeName(netId, groundNetId);
      if (n === '0') continue;
      lines.push(`.ic V(${n})=${volts}`);
    }
  }

  lines.push('', '.end');

  return {
    netlist: lines.join('\n'),
    netToNode,
    groundNetId,
    libPaths,
    spiceInstanceByComponentId,
  };
}

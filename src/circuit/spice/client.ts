/**
 * What: Browser ngspice DC `.OP` / capacitor `.tran` client — worker run, lib bundle, parse,
 * map to {@link DcSolveResult}, plus charge/discharge waveform cache for blink replay.
 *
 * Owns/exports: `solveDcWithNgspice`, `getCachedNgspiceDcResult`, `invalidateNgspiceCache`,
 * `commitNgspiceNodeIc`, `terminateNgspiceWorker`, `takeNgspiceWaveform`,
 * `lookupSpiceWaveCache` / `putSpiceWaveCache` / `prepareIcForSpiceWaveFill`,
 * `circuitKeyFromSolveSig` / `spiceWaveKindFromSolveSig` (plus internal cache generation).
 *
 * Conventions: Single engine — eecircuit-engine (ngspice-45.2 WASM) in the persistent module
 * worker `spice/worker.ts`, which returns structured node volts / V-source branch amps /
 * `.tran` samples (no stdout parsing). GPIO supersede drops the in-flight job's result but keeps
 * the engine alive; a timeout or worker crash terminates it and the next solve starts a fresh
 * one. No XSPICE code models; LAPLACE decks are refused in the worker. Cap `.tran` tstop ≈ 5×RC
 * from canvas C/R (clamped). Waveform samples are SPICE-only; the controller lerps between
 * them for smooth UI. Cache keys hash full circuit state; `invalidateNgspiceCache` bumps
 * generation so stale runs cannot overwrite.
 *
 * To include new state in cache invalidation, extend the key builder wherever components,
 * netlist, blows, buttons, and `mcuSources` are serialized.
 * To add a model file to the worker payload, ensure netlistExport `.include` paths match
 * `fetchSpiceLibFiles` from spice/models.ts.
 * To map a new element’s current, align SPICE instance names in netlistExport with
 * `spiceInstanceByComponentId` when reading `branchAmps`.
 *
 * Not here: Deck generation or catalog JSON schema — see netlistExport and spice/models.ts.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | Cache key asks part modules for their own `spiceCacheKey` fragment
#                     | Cache key is module-only (`spiceCacheKey`); leftover type arms deleted
# 25-09-2026 | Cursor | Stepped `.tran` + IC when capacitors present; capacitorBlown in cache key
# 28-09-2026 | Cursor | `.tran` tstop from circuit RC (~5τ) so large C can fully charge/discharge in SPICE
# 08-10-2026 | Cursor | Document parked /ngspice/xspice/; client stays Concord-only (no XSPICE worker)
#                     | A/B: USE_XSPICE_WORKER_AB routes to separate /ngspice/xspice/ worker
#                     | Dual-route: XSPICE worker only when deckNeedsXspice (74HC / digital.cm)
#                     | Hybrid 74HC: XSPICE IC-only OP + Concord analog with forced V (no mixed deck)
# 09-10-2026 | Cursor | Removed XSPICE worker routing, hybrid 74HC co-sim and xspiceIso debug; Concord only
#                     | Engine swap: Concord ngspice-26 → eecircuit-engine module worker, structured results instead of stdout parsing, persistent worker with kill + lazy restart on timeout/crash
#                     | Moved from `src/sim/spice/ngspiceClient.ts` (tree reorganization)
# 14-10-2026 | Codex | Invalidate cached measurements when GPIO ownership changes at unchanged voltage.
# 15-10-2026 | Codex | Preserve signed terminal-probe currents for wire branch accounting; existing component readings remain magnitudes.
 */


import type { PlacedComponent } from '../../types';
import type { CircuitNetlist, McuSourceMap } from '../netlist';
import { netForPin } from '../netlist';
import { solveDcCircuitLegacyOnce } from '../mnaLegacy';
import type { DcSolveResult } from '../mnaLegacy';
import {
  DEFAULT_LED_FORWARD_VOLTAGE,
  defaultForwardVoltageForColor,
  VF_CONDUCT_SLACK_V,
} from '../../values/led';
import {
  estimateSupplyCurrentMa,
  markSupplyCcMode,
  resolveCcVoltageOverrides,
  supplyOutputVolts,
  type SupplyVoltageOverrides,
} from '../supplyLimit';
import { exportSpiceOpNetlist, type ButtonPressedState } from './netlistExport';
import type { SpiceCatalog } from './models';
import { fetchSpiceLibFiles, loadSpiceCatalog } from './models';
import { getPartModule } from '../../components';
import { circuitHasCapacitors } from '../../components/passives/capacitor';
import {
  capacitanceToFarads,
  DEFAULT_CAPACITANCE_UNIT,
  DEFAULT_CAPACITANCE_VALUE,
  DEFAULT_POLARIZED_CAPACITANCE_UNIT,
  DEFAULT_POLARIZED_CAPACITANCE_VALUE,
} from '../../values/capacitor';
import { resistorOhms, SPICE_OHM_FLOOR } from '../../components/passives/resistor';

const OP_TIMEOUT_MS = 60_000;
/** Cap `.tran` must stay short or the UI waits forever (logs: 8s timeout → all OFF). */
const TRAN_TIMEOUT_MS = 8_000;
/** ~5τ settles to ~0.7%; keep under TRAN_TIMEOUT_MS with worker headroom. */
const TRAN_TSTOP_MAX_SEC = 2.5;
const TRAN_TSTOP_MIN_SEC = 0.05;
/** Settling multiples of RC for cacheable charge/discharge trajectories. */
const TRAN_SETTLE_TAU = 5;
const LED_CONDUCT_MIN_MA = 0.01;
/** Last node voltages used as `.ic` for the next capacitor `.tran` step. */
let lastNodeIc: Map<number, number> = new Map();
//let lastTranWallMs = 0;

/** SPICE `.tran` samples for UI playback (taken once via takeNgspiceWaveform). */
let pendingWaveform: { samples: DcSolveResult[]; tstopSec: number } | null = null;

/**
 * Cached full charge/discharge trajectories from SPICE, keyed by circuit parts (not GPIO).
 * Live .tran cannot keep up with blink (logs: edgeAge 400–1400ms ≫ tstop) — replay instead.
 */
export type SpiceWaveKind = 'charge' | 'discharge';
export type SpiceWaveform = { samples: DcSolveResult[]; tstopSec: number };
const spiceWaveCache = new Map<string, Partial<Record<SpiceWaveKind, SpiceWaveform>>>();

/** Live worker — terminated on GPIO edge so stale .tran cannot finish after the blink flips. */
let activeNgspiceWorker: Worker | null = null;
let activeNgspiceReject: ((err: Error) => void) | null = null;

/** Parts-only key from a runtime solve signature (`sources::parts`). */
export function circuitKeyFromSolveSig(solveSig: string): string {
  const i = solveSig.indexOf('::');
  return i >= 0 ? solveSig.slice(i + 2) : solveSig;
}

/** Max MCU/source rail voltage encoded in the signature head. */
export function maxMcuVoltsFromSolveSig(solveSig: string): number {
  const head = solveSig.split('::')[0] ?? '';
  let max = 0;
  if (!head) return 0;
  for (const part of head.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const v = Number(part.slice(eq + 1));
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

export function spiceWaveKindFromSolveSig(solveSig: string): SpiceWaveKind | null {
  const v = maxMcuVoltsFromSolveSig(solveSig);
  if (v >= 4) return 'charge';
  if (v < 1) return 'discharge';
  return null;
}

export function putSpiceWaveCache(
  circuitKey: string,
  kind: SpiceWaveKind,
  wave: SpiceWaveform,
): boolean {
  if (wave.samples.length < 2 || !spiceWaveformHasDynamics(wave)) {
    return false;
  }
  let entry = spiceWaveCache.get(circuitKey);
  if (!entry) {
    entry = {};
    spiceWaveCache.set(circuitKey, entry);
  }
  entry[kind] = wave;
  return true;
}

/** True when first→last (or mid) node voltages move enough to be a real RC trajectory. */
export function spiceWaveformHasDynamics(wave: SpiceWaveform): boolean {
  const first = wave.samples[0];
  if (!first) return false;
  let maxDelta = 0;
  for (const sample of wave.samples) {
    for (const [net, v0] of first.netVoltages) {
      maxDelta = Math.max(maxDelta, Math.abs(v0 - (sample.netVoltages.get(net) ?? 0)));
    }
  }
  return maxDelta >= 0.2;
}

export function lookupSpiceWaveCache(
  circuitKey: string,
  kind: SpiceWaveKind,
): SpiceWaveform | null {
  const entry = spiceWaveCache.get(circuitKey);
  const wave = entry?.[kind] ?? null;
  // Drop flat ON/OFF-only caches (logs: charge samples all Vc=1.93 / discharge all ~0).
  if (wave && !spiceWaveformHasDynamics(wave)) {
    if (entry) delete entry[kind];
    return null;
  }
  return wave;
}

/**
 * Seed `.ic` so a cache-fill .tran actually sweeps charge or discharge
 * (not a flat settle from an already-equilibrated IC).
 */
export function prepareIcForSpiceWaveFill(
  kind: SpiceWaveKind,
  circuitKey: string,
  components: PlacedComponent[],
  netlist: CircuitNetlist,
): void {
  if (kind === 'charge') {
    const ic = new Map(lastNodeIc);
    for (const c of components) {
      if (c.type !== 'capacitor' && c.type !== 'polarized_capacitor') continue;
      const nPos = netForPin(netlist, { componentId: c.id, pinId: 'pos' });
      const nNeg = netForPin(netlist, { componentId: c.id, pinId: 'neg' });
      if (nPos !== null) ic.set(nPos, 0);
      if (nNeg !== null) ic.set(nNeg, 0);
    }
    lastNodeIc = ic;
    return;
  }
  const charged = lookupSpiceWaveCache(circuitKey, 'charge');
  if (charged && charged.samples.length > 0) {
    lastNodeIc = new Map(charged.samples[charged.samples.length - 1]!.netVoltages);
  }
}

/** Consume the latest SPICE waveform (if any) for smooth UI playback of real samples. */
export function takeNgspiceWaveform(): SpiceWaveform | null {
  const w = pendingWaveform;
  pendingWaveform = null;
  return w;
}

/**
 * Largest C and smallest R on the canvas — used only to size the SPICE `.tran`
 * window so charge/discharge can finish. Voltages/currents still come from ngspice.
 */
function estimateCircuitRc(components: PlacedComponent[]): {
  maxC: number;
  minR: number;
  tau: number;
} {
  let maxC = 0;
  let minR = Number.POSITIVE_INFINITY;
  for (const c of components) {
    if (c.type === 'capacitor' || c.type === 'polarized_capacitor') {
      const defV =
        c.type === 'polarized_capacitor'
          ? DEFAULT_POLARIZED_CAPACITANCE_VALUE
          : DEFAULT_CAPACITANCE_VALUE;
      const defU =
        c.type === 'polarized_capacitor'
          ? DEFAULT_POLARIZED_CAPACITANCE_UNIT
          : DEFAULT_CAPACITANCE_UNIT;
      const value = c.capacitanceValue ?? defV;
      const unit = c.capacitanceUnit ?? defU;
      maxC = Math.max(maxC, capacitanceToFarads(value, unit));
    } else if (c.type === 'resistor') {
      minR = Math.min(minR, resistorOhms(c, SPICE_OHM_FLOOR));
    }
  }
  // No discrete R: still size from C with a 1 kΩ placeholder so large C gets a longer window.
  const r = Number.isFinite(minR) && minR > 0 ? minR : 1_000;
  return { maxC, minR: r, tau: maxC * r };
}

function tranStepSeconds(components: PlacedComponent[]): {
  tstep: number;
  tstop: number;
  maxC: number;
  minR: number;
  tau: number;
} {
  // Size `.tran` from circuit RC so large C can fully settle in SPICE (not a fixed 0.2s cut).
  const { maxC, minR, tau } = estimateCircuitRc(components);
  const tstop = Math.min(
    TRAN_TSTOP_MAX_SEC,
    Math.max(TRAN_TSTOP_MIN_SEC, TRAN_SETTLE_TAU * tau),
  );
  // ~20 steps across the window; keep ≥1 ms for ngspice stability.
  const tstep = Math.max(1e-3, Math.min(0.01, tstop / 20));
  //lastTranWallMs = performance.now();
  return { tstep, tstop, maxC, minR, tau };
}

function ledForwardVoltage(comp: PlacedComponent): number {
  if (comp.ledForwardVoltage !== undefined) return comp.ledForwardVoltage;
  if (comp.ledColor) return defaultForwardVoltageForColor(comp.ledColor);
  return DEFAULT_LED_FORWARD_VOLTAGE;
}

let cacheByKey = new Map<string, DcSolveResult>();
const inflightByKey = new Map<string, Promise<DcSolveResult | null>>();
/** Bumped on invalidate so stale in-flight ngspice runs cannot overwrite cache. */
let cacheGeneration = 0;

/** One solved point from the engine: node name (lowercase) → V, V-source name (uppercase) → A. */
type NgspicePoint = { nodeVolts: Map<string, number>; branchAmps: Map<string, number> };
type NgspiceRun = NgspicePoint & { waveSamples: NgspicePoint[]; errors: string[] };

type WorkerPoint = { nodeVolts: Record<string, number>; branchAmps: Record<string, number> };
type WorkerReply = {
  type: string;
  id: number;
  ok: boolean;
  error?: string;
  errors?: string[];
  engine?: string;
  version?: string;
  waveSamples?: WorkerPoint[];
} & Partial<WorkerPoint>;

function toPoint(p: Partial<WorkerPoint>): NgspicePoint {
  return {
    nodeVolts: new Map(Object.entries(p.nodeVolts ?? {})),
    branchAmps: new Map(Object.entries(p.branchAmps ?? {})),
  };
}

let nextJobId = 0;
const pendingJobs = new Map<number, (msg: WorkerReply) => void>();

/** Persistent engine worker; recreated lazily after a timeout or crash. */
function ngspiceWorker(): Worker {
  if (activeNgspiceWorker) return activeNgspiceWorker;
  const w = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'ngspice',
  });
  w.onmessage = (event: MessageEvent<WorkerReply>) => {
    const msg = event.data;
    if (msg.type === 'engine') {
      if (import.meta.env.DEV) console.info('[ngspice] engine', msg.engine, msg.version);
      return;
    }
    const done = pendingJobs.get(msg.id);
    if (!done) return;
    pendingJobs.delete(msg.id);
    done(msg);
  };
  w.onerror = (event) => {
    event.preventDefault();
    killNgspiceWorker(`ngspice worker crashed: ${event.message || 'unknown error'}`);
  };
  activeNgspiceWorker = w;
  return w;
}

/** Terminate the engine (hung or dead) and fail every job still waiting on it. */
function killNgspiceWorker(reason: string): void {
  const w = activeNgspiceWorker;
  activeNgspiceWorker = null;
  try {
    w?.terminate();
  } catch {
    /* already dead */
  }
  const waiting = [...pendingJobs.values()];
  pendingJobs.clear();
  for (const done of waiting) done({ type: 'killed', id: -1, ok: false, error: reason });
}

function runOpInWorker(netlist: string, libFiles: Record<string, string>): Promise<NgspiceRun> {
  return runAnalysisInWorker('op', netlist, libFiles);
}

function runTranInWorker(
  netlist: string,
  libFiles: Record<string, string>,
  tstep: number,
  tstop: number,
): Promise<NgspiceRun> {
  return runAnalysisInWorker('tran', netlist, libFiles, tstep, tstop);
}

function runAnalysisInWorker(
  type: 'op' | 'tran',
  netlist: string,
  libFiles: Record<string, string>,
  tstep?: number,
  tstop?: number,
): Promise<NgspiceRun> {
  return new Promise((resolve, reject) => {
    // Supersede any prior in-flight job (GPIO edges must not wait on a stale .tran result).
    abortNgspiceWorkerOnly();
    const w = ngspiceWorker();
    const id = ++nextJobId;
    let timer = 0;

    const rejectAbort = (err: Error) => {
      window.clearTimeout(timer);
      pendingJobs.delete(id);
      reject(err);
    };
    activeNgspiceReject = rejectAbort;

    timer = window.setTimeout(() => {
      if (activeNgspiceReject === rejectAbort) activeNgspiceReject = null;
      killNgspiceWorker(`ngspice ${type} timed out`);
    }, type === 'tran' ? TRAN_TIMEOUT_MS : OP_TIMEOUT_MS);

    pendingJobs.set(id, (msg) => {
      window.clearTimeout(timer);
      if (activeNgspiceReject === rejectAbort) activeNgspiceReject = null;
      if (!msg.ok) {
        reject(new Error(msg.error ?? `ngspice ${type} failed`));
        return;
      }
      resolve({
        ...toPoint(msg),
        waveSamples: (msg.waveSamples ?? []).map(toPoint),
        errors: msg.errors ?? [],
      });
    });

    w.postMessage({
      type,
      id,
      netlist,
      libFiles,
      ...(type === 'tran' ? { tstep, tstop } : {}),
    });
  });
}

/** Drop the in-flight job without clearing cache (GPIO edge supersede); the engine keeps running. */
function abortNgspiceWorkerOnly(): void {
  const rej = activeNgspiceReject;
  activeNgspiceReject = null;
  if (rej) rej(new Error('ngspice aborted for newer GPIO/solve'));
}

/**
 * Abort in-flight ngspice when MCU GPIO changes so we don't finish a stale .tran
 * after the blink has already flipped (logs: perpetual dropped-stale / phase lag).
 */
export function abortNgspiceInFlight(): void {
  abortNgspiceWorkerOnly();
  inflightByKey.clear();
  pendingWaveform = null;
}

function buildCacheKey(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs: number,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
): string {
  const compSig = components
    .map((c) => {
      const base = `${c.id}:${c.type}:${c.spiceModelId ?? ''}`;

      const extra = getPartModule(c.type)?.spiceCacheKey?.({
        comp: c,
        simTimeMs,
        resistorBlown,
        ledBlown,
        buttonPressed,
        capacitorBlown,
      });
      return extra ? `${base}:${extra}` : base;
    })
    .join('|');

  const wireSig = [...netlist.pinToNet.entries()].sort().join('|');
  const mcuSig = [...mcuSources.entries()]
    .map(([net, volts]) => net + '=' + volts + ':' + JSON.stringify(mcuSources.gpioPins?.get(net) ?? []))
    .sort()
    .join(',');
  const capBlow = Object.entries(capacitorBlown)
    .filter(([, v]) => v)
    .map(([id]) => id)
    .sort()
    .join(',');
  // Companion Ic is module state advanced by serialized OP refreshes — not part of the
  // electrical cache key (including it forced perpetual misses + stale holds).
  return `${compSig}::${wireSig}::${mcuSig}::cb=${capBlow}`;
}

function publishNgspiceCache(
  key: string,
  result: DcSolveResult,
  generation: number,
): void {
  if (generation !== cacheGeneration) return;
  cacheByKey.set(key, result);
}

function mapSpiceToDcResult(
  point: NgspicePoint,
  exportData: NonNullable<ReturnType<typeof exportSpiceOpNetlist>>,
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  ledBlown: Record<string, boolean> = {},
  ccOverrides: SupplyVoltageOverrides = {},
): DcSolveResult | null {
  const { nodeVolts, branchAmps } = point;
  const netVoltages = new Map<number, number>();

  for (const [netId, nodeName] of exportData.netToNode) {
    const v = nodeVolts.get(nodeName.toLowerCase());
    if (v !== undefined) {
      netVoltages.set(netId, v);
    } else if (nodeName === '0') {
      netVoltages.set(netId, 0);
    }
  }

  if (netVoltages.size === 0) return null;

  const branchCurrentMa: Record<string, number> = {};
  for (const [compId, instanceName] of exportData.spiceInstanceByComponentId) {
    const amps = branchAmps.get(instanceName.toUpperCase());
    if (amps !== undefined) {
      branchCurrentMa[compId] = (compId.includes(':terminal:') ? amps : Math.abs(amps)) * 1000;
    }
  }


  const ledConducting: Record<string, boolean> = {};
  for (const comp of components) {
    if (comp.type !== 'led') continue;

    if (ledBlown[comp.id]) {
      ledConducting[comp.id] = false;
      branchCurrentMa[comp.id] = 0;
      continue;
    }

    const na = netForPin(netlist, { componentId: comp.id, pinId: 'anode' });
    const nk = netForPin(netlist, { componentId: comp.id, pinId: 'cathode' });
    if (na === null || nk === null) continue;

    const vf = ledForwardVoltage(comp);
    const vDrop = (netVoltages.get(na) ?? 0) - (netVoltages.get(nk) ?? 0);
    const iMa = branchCurrentMa[comp.id];
    if (iMa !== undefined && iMa >= LED_CONDUCT_MIN_MA) {
      ledConducting[comp.id] = true;
    } else {
      ledConducting[comp.id] = vDrop >= vf - VF_CONDUCT_SLACK_V;
    }
  }

  const result: DcSolveResult = {
    netVoltages,
    ledConducting,
    branchCurrentMa: Object.keys(branchCurrentMa).length > 0 ? branchCurrentMa : undefined,
  };

  markSupplyCcMode(result, ccOverrides, components);
  return result;
}

async function runNgspiceOpOnce(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs: number,
  catalog: SpiceCatalog | null,
  libFiles: Record<string, string>,
  resistorBlown: Record<string, boolean>,
  ledBlown: Record<string, boolean>,
  supplyVoltageOverrides: SupplyVoltageOverrides = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
  preferTran = false,
): Promise<DcSolveResult | null> {
  const exportedNetlist = exportSpiceOpNetlist(
    components,
    netlist,
    simTimeMs,
    catalog,
    resistorBlown,
    ledBlown,
    supplyVoltageOverrides,
    buttonPressed,
    mcuSources,
    capacitorBlown,
    preferTran && lastNodeIc.size > 0 ? lastNodeIc : null,
  );
  if (!exportedNetlist) return null;

  let run: NgspiceRun;
  let analysisMode: 'tran' | 'op' | 'tran-fallback-op' = 'op';
  let tstep = 0;
  let tstop = 0;

  if (preferTran) {
    const tran = tranStepSeconds(components);
    tstep = tran.tstep;
    tstop = tran.tstop;
    try {
      run = await runTranInWorker(exportedNetlist.netlist, libFiles, tstep, tstop);
      analysisMode = 'tran';
    } catch (err) {
      run = await runOpInWorker(exportedNetlist.netlist, libFiles);
      analysisMode = 'tran-fallback-op';
    }
  } else {
    run = await runOpInWorker(exportedNetlist.netlist, libFiles);
  }

  if (import.meta.env.DEV && run.errors.some((l) => l.trim())) {
    console.debug('[ngspice]', run.errors.join('\n').trim());
  }

  const result = mapSpiceToDcResult(
    run,
    exportedNetlist,
    components,
    netlist,
    ledBlown,
    supplyVoltageOverrides,
  );
  if (result && preferTran && analysisMode === 'tran') {
    const samples: DcSolveResult[] = [];
    for (const point of run.waveSamples) {
      const sample = mapSpiceToDcResult(
        point,
        exportedNetlist,
        components,
        netlist,
        ledBlown,
        supplyVoltageOverrides,
      );
      if (sample) samples.push(sample);
    }
    pendingWaveform =
      samples.length > 1 ? { samples, tstopSec: tstop } : null;
  } else {
    pendingWaveform = null;
  }
  // Do NOT commit lastNodeIc here — stale in-flight solves must not poison the next
  // `.ic` step. Controller calls {@link commitNgspiceNodeIc} only when it paints.
  return result;
}

/** Persist node voltages as `.ic` for the next capacitor `.tran` step (paint-path only). */
export function commitNgspiceNodeIc(netVoltages: Map<number, number>): void {
  lastNodeIc = new Map(netVoltages);
}

function legacyMeasureSupplyCurrentMa(
  compId: string,
  outputVolts: number,
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs: number,
  resistorBlown: Record<string, boolean>,
  ledBlown: Record<string, boolean>,
  buttonPressed: ButtonPressedState = {},
): number | undefined {
  const probe = solveDcCircuitLegacyOnce(
    components,
    netlist,
    simTimeMs,
    resistorBlown,
    ledBlown,
    { [compId]: outputVolts },
    buttonPressed,
  );
  if (!probe) return undefined;
  const comp = components.find((c) => c.id === compId);
  if (!comp) return undefined;
  return estimateSupplyCurrentMa(
    comp,
    netlist,
    probe.netVoltages,
    components,
    probe.ledConducting,
    resistorBlown,
    ledBlown,
  );
}

/**
 * CV pass in ngspice, CC backoff voltage via fast legacy bisection, final pass in ngspice.
 * Avoids dozens of ngspice worker startups during CC bisection.
 */
async function solveWithCcBackoff(
  key: string,
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs: number,
  resistorBlown: Record<string, boolean>,
  ledBlown: Record<string, boolean>,
  buttonPressed: ButtonPressedState = {},
  generation: number,
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
  preferTran = false,
): Promise<DcSolveResult | null> {
  const catalog = await loadSpiceCatalog();
  const exportedCv = exportSpiceOpNetlist(
    components,
    netlist,
    simTimeMs,
    catalog,
    resistorBlown,
    ledBlown,
    {},
    buttonPressed,
    mcuSources,
    capacitorBlown,
    preferTran && lastNodeIc.size > 0 ? lastNodeIc : null,
  );
  if (!exportedCv) return null;

  const libFiles =
    exportedCv.libPaths.length > 0 ? await fetchSpiceLibFiles(exportedCv.libPaths) : {};

  const cvResult = await runNgspiceOpOnce(
    components,
    netlist,
    simTimeMs,
    catalog,
    libFiles,
    resistorBlown,
    ledBlown,
    {},
    buttonPressed,
    mcuSources,
    capacitorBlown,
    preferTran,
  );
  if (!cvResult) return null;

  if (!preferTran) publishNgspiceCache(key, cvResult, generation);

  const cvBranchCurrentMa = { ...(cvResult.branchCurrentMa ?? {}) };
  for (const comp of components) {
    if (comp.type !== 'power_supply' || cvBranchCurrentMa[comp.id] !== undefined) continue;
    const iMa = legacyMeasureSupplyCurrentMa(
      comp.id,
      supplyOutputVolts(comp),
      components,
      netlist,
      simTimeMs,
      resistorBlown,
      ledBlown,
      buttonPressed,
    );
    if (iMa !== undefined) cvBranchCurrentMa[comp.id] = iMa;
  }

  const measureLegacy = (compId: string, outputVolts: number) =>
    legacyMeasureSupplyCurrentMa(
      compId,
      outputVolts,
      components,
      netlist,
      simTimeMs,
      resistorBlown,
      ledBlown,
      buttonPressed,
    );

  const ccOverrides = resolveCcVoltageOverrides(
    components,
    measureLegacy,
    cvBranchCurrentMa,
  );

  if (Object.keys(ccOverrides).length === 0) return cvResult;

  const ccResult = await runNgspiceOpOnce(
    components,
    netlist,
    simTimeMs,
    catalog,
    libFiles,
    resistorBlown,
    ledBlown,
    ccOverrides,
    buttonPressed,
    mcuSources,
    capacitorBlown,
    preferTran,
  );
  const final = ccResult ?? cvResult;
  if (!preferTran) publishNgspiceCache(key, final, generation);
  return final;
}

/** Last successful ngspice .OP / .tran result when cache key matches. */
export function getCachedNgspiceDcResult(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs = 0,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
): DcSolveResult | null {
  const key = buildCacheKey(
    components,
    netlist,
    simTimeMs,
    resistorBlown,
    ledBlown,
    buttonPressed,
    mcuSources,
    capacitorBlown,
  );
  return cacheByKey.get(key) ?? null;
}

export function invalidateNgspiceCache(): void {
  cacheGeneration += 1;
  cacheByKey = new Map();
  inflightByKey.clear();
  lastNodeIc = new Map();
  //lastTranWallMs = 0;
  pendingWaveform = null;
  spiceWaveCache.clear();
}

/**
 * Run ngspice `.OP`, or stepped `.tran` when capacitors are present (native SPICE C).
 * Refresh coalescing (one in-flight + latest pending) is in SimulationController.
 */
export async function solveDcWithNgspice(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs = 0,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
): Promise<DcSolveResult | null> {
  return solveDcWithNgspiceUnlocked(
    components,
    netlist,
    simTimeMs,
    resistorBlown,
    ledBlown,
    buttonPressed,
    mcuSources,
    capacitorBlown,
  );
}

async function solveDcWithNgspiceUnlocked(
  components: PlacedComponent[],
  netlist: CircuitNetlist,
  simTimeMs = 0,
  resistorBlown: Record<string, boolean> = {},
  ledBlown: Record<string, boolean> = {},
  buttonPressed: ButtonPressedState = {},
  mcuSources: McuSourceMap = new Map(),
  capacitorBlown: Record<string, boolean> = {},
): Promise<DcSolveResult | null> {
  const preferTran = circuitHasCapacitors(components);
  const key = buildCacheKey(
    components,
    netlist,
    simTimeMs,
    resistorBlown,
    ledBlown,
    buttonPressed,
    mcuSources,
    capacitorBlown,
  );

  // Caps re-run each refresh so `.tran` + `.ic` advance; do not cache — a published
  // stale HIGH/LOW under the wrong key made syncCapacitorState flash wrong Vc.
  if (!preferTran) {
    const cached = cacheByKey.get(key);
    if (cached) return cached;
  }

  const inflight = inflightByKey.get(key);
  if (inflight) return inflight;

  const generation = cacheGeneration;
  const promise = (async () => {
    try {
      return await solveWithCcBackoff(
        key,
        components,
        netlist,
        simTimeMs,
        resistorBlown,
        ledBlown,
        buttonPressed,
        generation,
        mcuSources,
        capacitorBlown,
        preferTran,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[ngspice] OP/tran failed:', msg);
      return null;
    } finally {
      inflightByKey.delete(key);
    }
  })();

  inflightByKey.set(key, promise);
  return promise;
}

export function terminateNgspiceWorker(): void {
  abortNgspiceInFlight();
  invalidateNgspiceCache();
}

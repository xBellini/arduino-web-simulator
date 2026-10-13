/**
 * What: Sim performance counters + live overlay data (AVR throughput, drift, solve cost).
 * Role: Feed {@link SimPerfOverlay} during Run — no pacing changes.
 * Owns/exports: `SIM_PERF_ENABLED`, snapshot type, record/finish helpers, `isSimPerfEnabled`.
 *
 * Conventions: When `SIM_PERF_ENABLED`, AvrRunner / Worker host / solve frames push metrics.
 * Instruction totals use CPU cycle deltas (not per-instruction counting).
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Cycle-delta batches; Worker path support
#                     | Promoted from debug probe to always-on Run overlay; removed NDJSON ingest
# 09-10-2026 | Cursor | Removed `readSimPerfBenchState` (only the deleted bench-sim-perf script used it)
#                     | Moved from `src/sim/simPerf.ts` (tree reorganization)
 */

export const SIM_PERF_ENABLED = true;

const CPU_FREQ_HZ = 16_000_000;

export type SimPerfSnapshot = {
  simTimeMs: number;
  wallElapsedMs: number;
  driftMs: number;
  cyclesBehind: number;
  instructionsLastBatch: number;
  instructionsPerSec: number;
  effectiveMhz: number;
  catchupResyncCount: number;
  gpioListenerCallsLastBatch: number;
  feedLcdCallsLastBatch: number;
  avrBatchWallMs: number;
  solveFrameWallMs: number;
  solveBackend: 'ngspice' | 'legacy' | null;
  ngspiceRanLastFrame: boolean;
  updatedAt: number;
};

function pushSnapshotToUi(snap: SimPerfSnapshot): void {
  if (typeof window === 'undefined') return;
  void import('../store/simLiveStore').then((m) => m.applySimPerfSnapshot(snap));
}

let enabledCache: boolean | null = null;

export function isSimPerfEnabled(): boolean {
  if (!SIM_PERF_ENABLED) return false;
  if (enabledCache !== null) return enabledCache;
  return true;
}

/** Force-enable/disable for tests (overrides default when non-null). */
export function setSimPerfEnabledForTests(on: boolean): void {
  enabledCache = on;
}

let runWallStartMs = 0;
let catchupResyncCount = 0;

let batchInstructions = 0;
let batchGpioListenerCalls = 0;
let batchFeedLcdCalls = 0;
let batchAvrWallMs = 0;

let lastSolveFrameMs = 0;
let lastSolveBackend: SimPerfSnapshot['solveBackend'] = null;
let lastNgspiceRan = false;

let rollWallMs = 0;
let rollCycles = 0;
let instructionsPerSec = 0;
let effectiveMhz = 0;

let lastUiPushMs = 0;
let lastCycles = 0;
let lastCyclesBehind = 0;

export function resetSimPerfRun(): void {
  if (!isSimPerfEnabled()) return;
  const now = performance.now();
  runWallStartMs = now;
  rollWallMs = now;
  rollCycles = 0;
  catchupResyncCount = 0;
  batchInstructions = 0;
  batchGpioListenerCalls = 0;
  batchFeedLcdCalls = 0;
  batchAvrWallMs = 0;
  lastSolveFrameMs = 0;
  lastSolveBackend = null;
  lastNgspiceRan = false;
  instructionsPerSec = 0;
  effectiveMhz = 0;
  lastUiPushMs = 0;
  lastCycles = 0;
  lastCyclesBehind = 0;
  pushSnapshotToUi(buildSnapshot(now));
}

export function recordCatchupResync(): void {
  if (!isSimPerfEnabled()) return;
  catchupResyncCount++;
}

export function recordGpioListenerCall(): void {
  if (!isSimPerfEnabled()) return;
  batchGpioListenerCalls++;
}

export function recordFeedLcdBus(): void {
  if (!isSimPerfEnabled()) return;
  batchFeedLcdCalls++;
}

export function recordSolveFrame(
  wallMs: number,
  backend: SimPerfSnapshot['solveBackend'],
  ngspiceRan: boolean,
): void {
  if (!isSimPerfEnabled()) return;
  lastSolveFrameMs = wallMs;
  lastSolveBackend = backend;
  lastNgspiceRan = ngspiceRan;
}

function buildSnapshot(now: number): SimPerfSnapshot {
  const wallElapsedMs = runWallStartMs > 0 ? now - runWallStartMs : 0;
  const simTimeMs = (lastCycles / CPU_FREQ_HZ) * 1000;
  const driftMs = wallElapsedMs - simTimeMs;

  return {
    simTimeMs,
    wallElapsedMs,
    driftMs,
    cyclesBehind: lastCyclesBehind,
    instructionsLastBatch: batchInstructions,
    instructionsPerSec,
    effectiveMhz,
    catchupResyncCount,
    gpioListenerCallsLastBatch: batchGpioListenerCalls,
    feedLcdCallsLastBatch: batchFeedLcdCalls,
    avrBatchWallMs: batchAvrWallMs,
    solveFrameWallMs: lastSolveFrameMs,
    solveBackend: lastSolveBackend,
    ngspiceRanLastFrame: lastNgspiceRan,
    updatedAt: now,
  };
}

/**
 * End of one AVR execute batch — roll 1 s throughput and maybe push UI.
 */
export function finishAvrBatch(
  cpuCycles: number,
  cyclesBehind: number,
  batchWallMs: number,
  _batchExitReason?: 'caught_up' | 'work_budget' | 'idle_at_target',
  _avrLoopWallMs?: number,
  _maxWorkMsUsed?: number,
): SimPerfSnapshot | null {
  if (!isSimPerfEnabled()) return null;

  const prevCycles = lastCycles;
  lastCyclesBehind = cyclesBehind;
  batchAvrWallMs = batchWallMs;

  const instrBatch = Math.max(0, cpuCycles - prevCycles);
  lastCycles = cpuCycles;
  const gpioBatch = batchGpioListenerCalls;
  const feedBatch = batchFeedLcdCalls;

  const now = performance.now();
  const rollDt = now - rollWallMs;
  if (rollDt >= 1000) {
    const dc = cpuCycles - rollCycles;
    instructionsPerSec = Math.round((dc / rollDt) * 1000);
    effectiveMhz = (dc / rollDt) * (1000 / 1e6);
    rollWallMs = now;
    rollCycles = cpuCycles;
  }

  batchInstructions = 0;
  batchGpioListenerCalls = 0;
  batchFeedLcdCalls = 0;

  const snap = buildSnapshot(now);
  snap.instructionsLastBatch = instrBatch;
  snap.gpioListenerCallsLastBatch = gpioBatch;
  snap.feedLcdCallsLastBatch = feedBatch;
  snap.avrBatchWallMs = batchWallMs;

  if (now - lastUiPushMs >= 100) {
    lastUiPushMs = now;
    pushSnapshotToUi(snap);
  }

  return snap;
}


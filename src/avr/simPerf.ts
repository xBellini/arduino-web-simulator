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


// Temporary bounded timing capture. No UI subscriptions or console logging.
type StutterEvent = { t: number; kind: string; a: number; b: number; c: number; detail?: string };
const traceCapacity = 30000;
const traceEvents: (StutterEvent | undefined)[] = new Array(traceCapacity);
let traceWritten = 0;
let traceEnabled = import.meta.env.DEV && typeof window !== 'undefined';
export function recordStutter(kind: string, a = 0, b = 0, c = 0, detail?: string): void {
  if (!traceEnabled) return;
  traceEvents[traceWritten++ % traceCapacity] = { t: performance.now(), kind, a, b, c, detail };
}
export function recordCanvasCommit(_id: string, phase: string, actualDuration: number,
  baseDuration: number, startTime: number, commitTime: number): void {
  recordStutter('canvas-commit', actualDuration, commitTime - startTime, baseDuration, phase);
}
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const snapshot = () => ({
    version: 1, timeOrigin: performance.timeOrigin, capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent, capacity: traceCapacity, totalWritten: traceWritten,
    overwritten: Math.max(0, traceWritten - traceCapacity),
    schema: {
      'avr-tick': ['batchWallMs', 'deliveryMs', 'cycles', 'cyclesBehind'],
      'avr-handler': ['durationMs'], 'canvas-build': ['durationMs'],
      'canvas-commit': ['renderDurationMs', 'renderStartToCommitMs (not commit duration)', 'baseDurationMs', 'phase'],
      'frame-gap': ['gapMs'], 'timer-gap': ['lateMs'],
      'long-task': ['durationMs', 'startTimeMs'],
    },
    events: Array.from({ length: Math.min(traceWritten, traceCapacity) }, (_, i) =>
      traceEvents[(Math.max(0, traceWritten - traceCapacity) + i) % traceCapacity]),
  });
  const api = {
    snapshot,
    clear() { traceEvents.fill(undefined); traceWritten = 0; recordStutter('clear'); },
    start() { traceEnabled = true; recordStutter('capture-start'); },
    stop() { recordStutter('capture-stop'); traceEnabled = false; },
    mark(label = 'noticed-stutter') { recordStutter('mark', 0, 0, 0, label.slice(0, 120)); },
    save() {
      // Freeze before serialization/download so export overhead is not evidence.
      api.stop();
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot())], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url;
      a.download = 'sim-stutter-' + Date.now() + '.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
  Object.assign(window, { stutterTrace: api });
  let frame = 0, previousFrame = performance.now();
  const onFrame = (now: number) => {
    if (document.visibilityState === 'visible' && now - previousFrame > 50)
      recordStutter('frame-gap', now - previousFrame);
    previousFrame = now; frame = requestAnimationFrame(onFrame);
  };
  frame = requestAnimationFrame(onFrame);
  let previousTimer = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - previousTimer > 300) recordStutter('timer-gap', now - previousTimer - 250);
    previousTimer = now;
  }, 250);
  const visibility = () => {
    previousFrame = performance.now(); previousTimer = previousFrame;
    recordStutter('visibility', 0, 0, 0, document.visibilityState);
  };
  const interaction = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    recordStutter(event.type, 0, 0, 0, target?.closest('button')?.textContent?.trim().slice(0, 60)
      ?? target?.tagName);
  };
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('pointerdown', interaction, true);
  document.addEventListener('pointerup', interaction, true);
  let observer: PerformanceObserver | undefined;
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) recordStutter('long-task', entry.duration, entry.startTime);
    });
    observer.observe({ type: 'longtask' });
  }
  recordStutter('capture-start', 0, 0, 0, 'longtask=' + !!observer + ';visibility=' + document.visibilityState);
  import.meta.hot?.dispose(() => {
    traceEnabled = false; cancelAnimationFrame(frame); clearInterval(timer); observer?.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('pointerdown', interaction, true);
    document.removeEventListener('pointerup', interaction, true);
    delete (window as unknown as { stutterTrace?: unknown }).stutterTrace;
  });
}

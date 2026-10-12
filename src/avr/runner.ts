/**
 * What: avr8js ATmega328P runner — 16 MHz flash execution with wall-clock pacing and USART.
 *
 * Owns/exports: `AvrRunner`, `CPU_FREQ_HZ`, `AvrExecuteOptions`, `AvrExecuteOptionsProvider`;
 * hardware: `cpu`, `timer0/1/2`, `portB/C/D`, `usart`, `twi`, `taskScheduler`.
 *
 * Conventions: Construct with validated HEX (`loadHex` into 32 KiB program). `execute` schedules
 * slices via {@link MicroTaskScheduler}; `onTick` runs each batch (hook gpioBridge there).
 * Interaction mode lowers `maxWorkMs`/`maxSliceMs` via options provider.
 * Inner slices use **cycle quanta** (not per-instruction `performance.now()`) — Chrome's
 * timer is far too expensive in the hot loop and was capping ~8 MHz.
 *
 * To reload firmware, create a new `AvrRunner` or add a reset path that reloads flash and CPU PC.
 * To throttle during canvas drag, pass an `AvrExecuteOptionsProvider` returning lighter ms budgets.
 * To tap serial output, subscribe to `usart` callbacks in the app layer (not in this file).
 * To attach I2C slaves, replace `twi.eventHandler` (see `twiBus.ts` in the AVR Worker).
 *
 * Not here: Circuit solve or sketch compile — see gpioBridge and compileSketch.
 * Prefer {@link AvrWorkerHost} for production Run (Worker + WASM pacing); this class remains
 * the in-thread core used by the worker and headless benches.
 *
 * Merged in from `src/sim/taskScheduler.ts`: Cooperative scheduler for time-sliced AVR emulation
 * (~60 Hz + catch-up). Owns/exports: `MicroTaskScheduler` (`start`, `stop`, `isRunning`,
 * `postTask`, `postTaskImmediate`). Conventions: No-op when not `start()`ed; only one pending
 * rAF/timeout/port message at a time. Main thread: `postTask` = rAF. Worker idle: short
 * `setTimeout`. Worker catch-up: MessageChannel (resists background setTimeout clamping better than
 * `setTimeout(0)` alone).
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/sim/avrRunner.ts` (tree reorganization)
 * - 09-10-2026 — Merged `src/sim/taskScheduler.ts` into this file (tree reorganization)
 * - 05-10-2026 — Instantiated AVRTWI (Wire / ideal I2C master)
 * - 05-10-2026 — Reverted rate-limit/re-anchor experiment (caused focused drift)
 * - 05-10-2026 — Same wall-clock pacing regardless of focus/visibility (no freerun branch)
 * - 05-10-2026 — Cycle-quanta hot loop; Worker/WASM host preferred
 * - 05-10-2026 — Catch-up execute when cyclesBehind
 * - 17-09-2026 — Idle slice 12 ms; next batch always on rAF (no setTimeout catch-up)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 * - [src/sim/taskScheduler.ts] 05-10-2026 — Worker catch-up via MessageChannel; idle still timed
 * - [src/sim/taskScheduler.ts] 05-10-2026 — Worker-safe postTask (no rAF in workers)
 * - [src/sim/taskScheduler.ts] 17-09-2026 — Expanded What with practical how-to notes
 * - [src/sim/taskScheduler.ts] 17-09-2026 — Changelog creation
 */
import { avrInstruction, AVRIOPort, AVRTimer, AVRTWI, AVRUSART, CPU, portBConfig, portCConfig, portDConfig, timer0Config, timer1Config, timer2Config, twiConfig, usart0Config } from 'avr8js';
import { loadHex } from './firmware';
import { SIM_PERF_ENABLED, finishAvrBatch } from './simPerf';

export class MicroTaskScheduler {
  private alive = false;
  private frameId: number | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private pendingImmediate = false;
  private readonly hasRaf =
    typeof requestAnimationFrame === 'function' &&
    typeof cancelAnimationFrame === 'function';
  private readonly channel: MessageChannel | null =
    typeof MessageChannel === 'function' ? new MessageChannel() : null;
  private immediateCallback: (() => void) | null = null;

  constructor() {
    if (this.channel) {
      this.channel.port1.onmessage = () => {
        this.pendingImmediate = false;
        const cb = this.immediateCallback;
        this.immediateCallback = null;
        if (this.alive && cb) cb();
      };
    }
  }

  start(): void {
    this.alive = true;
  }

  stop(): void {
    this.alive = false;
    this.immediateCallback = null;
    this.pendingImmediate = false;
    if (this.frameId !== null) {
      if (this.hasRaf) cancelAnimationFrame(this.frameId);
      else clearTimeout(this.frameId);
      this.frameId = null;
    }
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  isRunning(): boolean {
    return this.alive;
  }

  /** Next batch on the next animation frame (~60 Hz), or ~4 ms in a Worker. */
  postTask(callback: () => void): void {
    if (!this.alive) return;
    if (this.hasRaf) {
      this.frameId = requestAnimationFrame(() => {
        this.frameId = null;
        if (this.alive) callback();
      });
      return;
    }
    // Idle cadence in Worker (not MessageChannel — that would busy-loop when caught up).
    this.frameId = setTimeout(() => {
      this.frameId = null;
      if (this.alive) callback();
    }, 4) as unknown as number;
  }

  /** Run another batch ASAP when the emulator is behind wall-clock time. */
  postTaskImmediate(callback: () => void): void {
    if (!this.alive) return;
    if (this.channel) {
      this.immediateCallback = callback;
      if (!this.pendingImmediate) {
        this.pendingImmediate = true;
        this.channel.port2.postMessage(null);
      }
      return;
    }
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      if (this.alive) callback();
    }, 0);
  }
}

const FLASH_BYTES = 0x8000;
export const CPU_FREQ_HZ = 16_000_000;
/** Max wall time spent emulating in one scheduled callback (idle). Kept under one
 *  display frame so canvas paint and the circuit solve rAF still run. */
const MAX_CALLBACK_WORK_MS = 12;
/** Max wall time for one inner emulation slice (idle). */
const MAX_SLICE_MS = 8;
/** Lighter budget while the user pans/drags the canvas. */
const INTERACT_CALLBACK_WORK_MS = 10;
const INTERACT_SLICE_MS = 4;
/** Extra execute budget while emulated cycles lag wall-clock target. */
const CATCHUP_CALLBACK_WORK_MS = 40;
const CATCHUP_SLICE_MS = 12;
/** Schedule ASAP when behind by more than ~1 ms of emulated time. */
const CATCHUP_BEHIND_CYCLES = CPU_FREQ_HZ / 1000;
/**
 * Instructions between wall-clock checks. Sized for ~0.5 ms at a ~8 MHz floor so we still
 * yield under load, while avoiding per-instruction `performance.now()` (hypothesis K).
 */
const DEFAULT_CYCLE_QUANTUM = 4096;
/** Assume at least this host MHz when converting slice ms → cycle quantum. */
const MIN_HOST_MHZ_FOR_QUANTUM = 8;

export interface AvrExecuteOptions {
  maxWorkMs?: number;
  maxSliceMs?: number;
  /** Override cycle quantum (tests / WASM pacer). */
  cycleQuantum?: number;
  /** @deprecated Ignored — pacing is identical whether the window is focused or not. */
  tabHidden?: boolean;
}

export type AvrExecuteOptionsProvider = () => AvrExecuteOptions;

export class AvrRunner {
  readonly program = new Uint16Array(FLASH_BYTES);
  readonly cpu: CPU;
  readonly timer0: AVRTimer;
  readonly timer1: AVRTimer;
  readonly timer2: AVRTimer;
  readonly portB: AVRIOPort;
  readonly portC: AVRIOPort;
  readonly portD: AVRIOPort;
  readonly usart: AVRUSART;
  readonly twi: AVRTWI;
  readonly taskScheduler = new MicroTaskScheduler();
  private wallClockStartMs = 0;
  private cyclesAtWallClockStart = 0;
  /** Last execute() batch metrics (for Worker tick IPC / simPerf). */
  lastBatchMeta: {
    batchWallMs: number;
    avrLoopWallMs: number;
    batchExitReason: 'caught_up' | 'work_budget' | 'idle_at_target';
    maxWorkMsUsed: number;
    instructionsDelta: number;
  } | null = null;

  constructor(hex: string) {
    loadHex(hex, new Uint8Array(this.program.buffer));
    this.cpu = new CPU(this.program);
    this.timer0 = new AVRTimer(this.cpu, timer0Config);
    this.timer1 = new AVRTimer(this.cpu, timer1Config);
    this.timer2 = new AVRTimer(this.cpu, timer2Config);
    this.portB = new AVRIOPort(this.cpu, portBConfig);
    this.portC = new AVRIOPort(this.cpu, portCConfig);
    this.portD = new AVRIOPort(this.cpu, portDConfig);
    this.usart = new AVRUSART(this.cpu, usart0Config, CPU_FREQ_HZ);
    this.twi = new AVRTWI(this.cpu, twiConfig, CPU_FREQ_HZ);
    this.taskScheduler.start();
  }

  execute(
    onTick: (cpu: CPU) => void,
    optionsProvider?: AvrExecuteOptionsProvider,
  ): void {
    if (!this.taskScheduler.isRunning()) return;

    const options = optionsProvider?.() ?? {};
    const behind = this.cyclesBehind();
    const baseWorkMs = options.maxWorkMs ?? MAX_CALLBACK_WORK_MS;
    const baseSliceMs = options.maxSliceMs ?? MAX_SLICE_MS;
    const maxWorkMs =
      behind > CATCHUP_BEHIND_CYCLES
        ? Math.max(baseWorkMs, CATCHUP_CALLBACK_WORK_MS)
        : baseWorkMs;
    const maxSliceMs =
      behind > CATCHUP_BEHIND_CYCLES
        ? Math.max(baseSliceMs, CATCHUP_SLICE_MS)
        : baseSliceMs;
    const cycleQuantum =
      options.cycleQuantum ??
      Math.max(
        DEFAULT_CYCLE_QUANTUM,
        Math.floor(maxSliceMs * MIN_HOST_MHZ_FOR_QUANTUM * 1000),
      );
    const callbackStart = performance.now();
    const loopStart = performance.now();
    const cyclesAtBatchStart = this.cpu.cycles;
    let batchExitReason: 'caught_up' | 'work_budget' | 'idle_at_target' =
      'idle_at_target';
    while (performance.now() - callbackStart < maxWorkMs) {
      const targetCycles = this.targetCyclesForNow(performance.now());
      if (this.cpu.cycles >= targetCycles) {
        batchExitReason = 'caught_up';
        break;
      }

      // Cycle quantum: only sample the wall clock between quanta.
      const sliceDeadline = performance.now() + maxSliceMs;
      while (this.cpu.cycles < targetCycles) {
        const quantumEnd = Math.min(
          targetCycles,
          this.cpu.cycles + cycleQuantum,
        );
        while (this.cpu.cycles < quantumEnd) {
          avrInstruction(this.cpu);
          this.cpu.tick();
        }
        if (performance.now() >= sliceDeadline) break;
      }
    }
    const avrLoopWallMs = performance.now() - loopStart;
    const batchWallMs = performance.now() - callbackStart;

    if (batchExitReason !== 'caught_up') {
      const targetNow = this.targetCyclesForNow(performance.now());
      batchExitReason =
        this.cpu.cycles >= targetNow ? 'idle_at_target' : 'work_budget';
    }

    this.lastBatchMeta = {
      batchWallMs,
      avrLoopWallMs,
      batchExitReason,
      maxWorkMsUsed: maxWorkMs,
      instructionsDelta: Math.max(0, this.cpu.cycles - cyclesAtBatchStart),
    };

    if (SIM_PERF_ENABLED) {
      finishAvrBatch(
        this.cpu.cycles,
        this.cyclesBehind(),
        batchWallMs,
        batchExitReason,
        avrLoopWallMs,
        maxWorkMs,
      );
    }

    onTick(this.cpu);
    this.scheduleNext(onTick, optionsProvider);
  }

  /** Emulated cycles behind wall-clock target (0 when caught up). */
  cyclesBehind(_tabHidden?: boolean): number {
    return Math.max(
      0,
      this.targetCyclesForNow(performance.now()) - this.cpu.cycles,
    );
  }

  static idleExecuteOptions(): AvrExecuteOptions {
    return { maxWorkMs: MAX_CALLBACK_WORK_MS, maxSliceMs: MAX_SLICE_MS };
  }

  static interactExecuteOptions(): AvrExecuteOptions {
    return {
      maxWorkMs: INTERACT_CALLBACK_WORK_MS,
      maxSliceMs: INTERACT_SLICE_MS,
    };
  }

  /** Resync wall clock without resetting CPU state (e.g. after UI interaction). */
  syncWallClock(): void {
    this.wallClockStartMs = performance.now();
    this.cyclesAtWallClockStart = this.cpu.cycles;
  }

  private targetCyclesForNow(now: number): number {
    if (this.wallClockStartMs === 0) {
      this.wallClockStartMs = now;
      this.cyclesAtWallClockStart = this.cpu.cycles;
    }

    const wallElapsedMs = now - this.wallClockStartMs;
    return (
      this.cyclesAtWallClockStart +
      Math.floor((wallElapsedMs / 1000) * CPU_FREQ_HZ)
    );
  }

  private scheduleNext(
    onTick: (cpu: CPU) => void,
    optionsProvider?: AvrExecuteOptionsProvider,
  ): void {
    const run = () => this.execute(onTick, optionsProvider);
    const behind = this.cyclesBehind();
    if (behind > CATCHUP_BEHIND_CYCLES) {
      this.taskScheduler.postTaskImmediate(run);
    } else {
      this.taskScheduler.postTask(run);
    }
  }

  stop(): void {
    this.taskScheduler.stop();
    this.wallClockStartMs = 0;
    this.cyclesAtWallClockStart = 0;
  }

  reset(): void {
    this.cpu.reset();
    this.wallClockStartMs = 0;
    this.cyclesAtWallClockStart = 0;
  }
}

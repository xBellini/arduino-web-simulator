/**
 * What: Main-thread host for `worker.ts` — mirrors GPIO ports for gpioBridge,
 * forwards USART/LCD, and surfaces cpu.cycles for sim time.
 *
 * Owns/exports: `AvrWorkerHost`, `AvrPortMirror`, `AvrWorkerHostCallbacks`.
 *
 * Conventions: Start with HEX + LCD targets; `onTick` runs after each Worker tick with
 * port mirrors updated. Prefer this over in-thread `AvrRunner` for production Run.
 * Pacing is identical whether the window is focused or not (Worker owns the timebase).
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Worker + WASM AVR path
#                     | No focus/visibility pacing branch; Worker always wall-clock
#                     | Prime EN high before lcd-bus fall (I2C backpack only posts E low)
# 09-10-2026 | Cursor | Moved from `src/sim/avrWorkerHost.ts` (tree reorganization)
# 13-10-2026 | Codex | Apply backpack snapshots before each tick solve; clear them on stop/restart.
# 14-10-2026 | Codex | Ignore retired worker messages and detach callbacks on stop so old LCD writes and cycle counts cannot enter a new run.
# 15-10-2026 | Codex  | Mirror matrix snapshots and send changed solved power states; clear displays on stop.
#                     | Forward serial input and receive completion separately from output text.
 */

import { setMax7219Snapshots, clearMax7219Snapshots, max7219PowerSamples } from '../components/modules/max7219Matrix8x8';
import { setPcfBackpackSnapshot, clearPcfBackpackSnapshots } from '../components/modules/pcf8574LcdBackpack';
import { PinState, type AVRIOPort } from 'avr8js';
import {
  AVR_WORKER_PROTOCOL,
  type AvrPortSnapshot,
  type AvrWorkerInMessage,
  type AvrWorkerOutMessage,
} from './workerProtocol';
import type { AvrPortName } from './pinMap';
import { feedLcdParallelBus, setLcdGpioProbeActive } from '../components/output/lcdParallel';
import { finishAvrBatch, isSimPerfEnabled, recordStutter } from './simPerf';
import type { AvrExecuteOptions } from './runner';

type PortListener = (value: number, oldValue: number) => void;

/** Minimal AVRIOPort stand-in fed by Worker snapshots. */
export class AvrPortMirror implements Pick<
  AVRIOPort,
  'pinState' | 'setPin' | 'addListener' | 'removeListener'
> {
  private states: PinState[] = Array.from({ length: 8 }, () => PinState.Input);
  private listeners: PortListener[] = [];
  private setPinHandler: ((bit: number, high: boolean) => void) | null = null;

  bindSetPin(handler: (bit: number, high: boolean) => void): void {
    this.setPinHandler = handler;
  }

  pinState(index: number): PinState {
    return this.states[index] ?? PinState.Input;
  }

  setPin(index: number, value: boolean): void {
    this.setPinHandler?.(index, value);
  }

  addListener(listener: PortListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: PortListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  applySnapshot(pinStates: number[]): void {
    for (let i = 0; i < 8; i++) {
      const next = (pinStates[i] ?? PinState.Input) as PinState;
      const prev = this.states[i] ?? PinState.Input;
      this.states[i] = next;
      if (prev !== next) {
        const oldVal =
          prev === PinState.High || prev === PinState.InputPullUp ? 1 << i : 0;
        const newVal =
          next === PinState.High || next === PinState.InputPullUp ? 1 << i : 0;
        if (oldVal !== newVal) {
          for (const l of this.listeners) l(newVal, oldVal);
        }
      }
    }
  }
}

export type AvrWorkerHostCallbacks = {
  onSerialByte: (byte: number) => void;
  onSerialReceive?: () => void;
  onTick: () => void;
  onError?: (message: string) => void;
};

/**
 * Drop-in replacement surface for the parts of AvrRunner that SimulationController uses.
 */
export class AvrWorkerHost {
  readonly portB = new AvrPortMirror();
  readonly portC = new AvrPortMirror();
  readonly portD = new AvrPortMirror();
  /** Fake CPU handle — only `.cycles` is read by the controller. */
  readonly cpu = { cycles: 0 };

  private worker: Worker | null = null;
  private ready = false;
  private matrixPowerKey = '';
  private pendingStart: AvrWorkerInMessage | null = null;
  private optionsProvider: (() => AvrExecuteOptions) | null = null;
  private callbacks: AvrWorkerHostCallbacks | null = null;
  private lastPostedWorkMs: number | null = null;
  private lastPostedSliceMs: number | null = null;
  backend: 'js' | 'wasm' = 'js';

  constructor() {
    this.portB.bindSetPin((bit, high) => this.postInput('B', bit, high));
    this.portC.bindSetPin((bit, high) => this.postInput('C', bit, high));
    this.portD.bindSetPin((bit, high) => this.postInput('D', bit, high));
  }

  private portMirror(name: AvrPortName): AvrPortMirror {
    return name === 'B' ? this.portB : name === 'C' ? this.portC : this.portD;
  }

  private post(msg: AvrWorkerInMessage): void {
    this.worker?.postMessage(msg);
  }

  sendSerial(text: string): void {
    if (this.ready) this.post({ v: AVR_WORKER_PROTOCOL, type: 'serial-input', bytes: Array.from(new TextEncoder().encode(text)) });
  }

  private postInput(port: AvrPortName, bit: number, high: boolean): void {
    this.post({
      v: AVR_WORKER_PROTOCOL,
      type: 'set-inputs',
      pins: [{ port, bit, high }],
    });
  }

  private applyPorts(ports: AvrPortSnapshot[]): void {
    for (const snap of ports) {
      this.portMirror(snap.port).applySnapshot(snap.pinStates);
    }
  }

  private pushOptions(force = false): void {
    const samples = max7219PowerSamples();
    const key = JSON.stringify(samples);
    if (key !== this.matrixPowerKey) {
      this.matrixPowerKey = key;
      this.post({ v: AVR_WORKER_PROTOCOL, type: 'max7219-power', samples });
    }
    const opts = this.optionsProvider?.() ?? {};
    const maxWorkMs = opts.maxWorkMs ?? 12;
    const maxSliceMs = opts.maxSliceMs ?? 8;
    if (
      !force &&
      maxWorkMs === this.lastPostedWorkMs &&
      maxSliceMs === this.lastPostedSliceMs
    ) {
      return;
    }
    this.lastPostedWorkMs = maxWorkMs;
    this.lastPostedSliceMs = maxSliceMs;
    this.post({
      v: AVR_WORKER_PROTOCOL,
      type: 'set-options',
      maxWorkMs,
      maxSliceMs,
      // Always false: Worker pacing must not depend on window focus/visibility.
      tabHidden: false,
    });
  }

  async start(
    hex: string,
    lcdTargets: Extract<AvrWorkerInMessage, { type: 'start' }>['lcdTargets'],
    callbacks: AvrWorkerHostCallbacks,
    optionsProvider?: () => AvrExecuteOptions,
    twiSlaves: Extract<AvrWorkerInMessage, { type: 'start' }>['twiSlaves'] = [],
    max7219Targets: Extract<AvrWorkerInMessage, { type: 'start' }>['max7219Targets'] = [],
  ): Promise<void> {
    this.stop();
    recordStutter('avr-start');
    this.callbacks = callbacks;
    this.optionsProvider = optionsProvider ?? null;

    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'avr-core',
    });
    const worker = this.worker;

    this.worker.onmessage = (ev: MessageEvent<AvrWorkerOutMessage>) => {
      if (this.worker !== worker) return;
      const msg = ev.data;
      if (!msg || msg.v !== AVR_WORKER_PROTOCOL) return;

      switch (msg.type) {
        case 'ready':
          this.ready = true;
          this.backend = msg.backend;
          if (this.pendingStart) {
            this.post(this.pendingStart);
            this.pendingStart = null;
            this.pushOptions(true);
          }
          break;
        case 'tick': {
          const traceStart = performance.now();
          if (msg.sentAt !== undefined) recordStutter('avr-tick', msg.perf?.batchWallMs ?? -1,
            performance.timeOrigin + traceStart - msg.sentAt, msg.cycles, String(msg.cyclesBehind));
          setMax7219Snapshots(msg.matrices ?? []);
          this.cpu.cycles = msg.cycles;
          this.applyPorts(msg.ports);
          for (const sample of msg.backpackPorts ?? [])
            setPcfBackpackSnapshot(sample.id, sample.port, sample.sda, sample.scl);
          if (msg.perf && isSimPerfEnabled()) {
            finishAvrBatch(
              msg.cycles,
              msg.cyclesBehind,
              msg.perf.batchWallMs,
              msg.perf.batchExitReason,
              msg.perf.avrLoopWallMs,
              msg.perf.maxWorkMsUsed,
            );
          }
          this.callbacks?.onTick();
          recordStutter('avr-handler', performance.now() - traceStart);
          break;
        }
        case 'serial-received':
          this.callbacks?.onSerialReceive?.();
          break;
        case 'usart':
          this.callbacks?.onSerialByte(msg.byte);
          break;
        case 'lcd-bus':
          // I2C backpack only posts on E falling (en already low). Parallel GPIO probe
          // posts both edges. Prime en=true so latchParallelOnEnableFall sees a fall.
          feedLcdParallelBus(msg.id, msg.cols, msg.rows, {
            ...msg.pins,
            en: true,
          });
          feedLcdParallelBus(msg.id, msg.cols, msg.rows, msg.pins);
          break;
        case 'error':
          this.callbacks?.onError?.(msg.message);
          break;
        default:
          break;
      }
    };

    this.worker.onerror = (err) => {
      if (this.worker !== worker) return;
      this.callbacks?.onError?.(String(err.message ?? err));
    };

    setLcdGpioProbeActive(lcdTargets.length > 0);

    const startMsg: AvrWorkerInMessage = {
      v: AVR_WORKER_PROTOCOL,
      type: 'start',
      hex,
      lcdTargets,
      twiSlaves,
      max7219Targets,
    };
    if (this.ready) {
      this.post(startMsg);
      this.pushOptions(true);
    } else {
      this.pendingStart = startMsg;
    }
  }

  stop(): void {
    clearMax7219Snapshots();
    this.matrixPowerKey = '';
    clearPcfBackpackSnapshots();
    this.lastPostedWorkMs = null;
    this.lastPostedSliceMs = null;
    setLcdGpioProbeActive(false);
    if (this.worker) {
      recordStutter('avr-stop');
      this.post({ v: AVR_WORKER_PROTOCOL, type: 'stop' });
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.pendingStart = null;
    this.cpu.cycles = 0;
    this.callbacks = null;
  }

  /** Call when execute options may have changed (interact vs idle). */
  refreshOptions(): void {
    if (this.ready) this.pushOptions();
  }

  syncWallClock(): void {
    this.post({ v: AVR_WORKER_PROTOCOL, type: 'sync-wall' });
  }
}

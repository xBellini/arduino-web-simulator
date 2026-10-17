/**
 * What: AVR emulation Web Worker — owns avr8js AvrRunner + LCD EN probe + TWI bus + WASM pacer.
 * Role: Run the 16 MHz timebase off the UI thread; post GPIO/USART/LCD/perf to main.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Worker + WASM AVR path (session 520145)
#                     | Ideal TWI bus + I2C LCD backpack (datasheet PCF8574 slave)
# 09-10-2026 | Cursor | Moved from `src/sim/avr.worker.ts` (tree reorganization)
#                     | Register DS3231 + AT24C32 TWI slaves; tick RTC from AVR cycles
# 13-10-2026 | Codex | Report PCF latches and sampled PINC levels alongside GPIO ticks.
# 15-10-2026 | Codex  | Run SimulIDE MAX7219 models in the AVR worker and batch display state.
#                     | Update the renamed max7219Bridge import; behavior unchanged.
#                     | Receive queued monitor bytes through USART character timing; report completed reception and clear queued bytes on stop.
 */

/// <reference lib="webworker" />

import { Max7219Bus, type Max7219Target } from './max7219Bridge';
import { PinState } from 'avr8js';
import { AvrRunner, CPU_FREQ_HZ } from './runner';
import {
  AVR_WORKER_PROTOCOL,
  type AvrPortSnapshot,
  type AvrWorkerInMessage,
  type AvrWorkerOutMessage,
  type AvrWorkerTwiSlave,
} from './workerProtocol';
import type { AvrPortName } from './pinMap';
import { TwiSlaveBus } from './twiBus';
import { createPcfBackpackTwiSlave } from '../components/modules/pcf8574LcdBackpack';
import { createDs3231ModuleSlaves } from '../components/modules/ds3231Rtc';
import type { Ds3231 } from './ds3231';

type PacerExports = {
  cycleQuantumForSlice(sliceMs: number, minHostMhz: number): number;
};

let runner: AvrRunner | null = null;
const serialInputQueue: number[] = [];
let matrixBus: Max7219Bus | null = null;
let matrixTargets: Max7219Target[] = [];
let twiBus: TwiSlaveBus | null = null;
let tabHidden = false;
let maxWorkMs = 12;
let maxSliceMs = 8;
let cycleQuantum = 4096;
let backend: 'js' | 'wasm' = 'js';
let pacer: PacerExports | null = null;
let lcdTargets: Extract<
  AvrWorkerInMessage,
  { type: 'start' }
>['lcdTargets'] = [];
let twiSlaves: AvrWorkerTwiSlave[] = [];
let rtcCores: Ds3231[] = [];
const backpackPorts = new Map<string, number>();

function post(msg: AvrWorkerOutMessage): void {
  self.postMessage(msg);
}

async function loadPacer(): Promise<void> {
  try {
    const res = await fetch(new URL('/avr/avr-pacer.wasm', self.location.href));
    if (!res.ok) throw new Error(`wasm fetch ${res.status}`);
    const bytes = await res.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports as Record<string, unknown>;
    const fn = ex.cycleQuantumForSlice;
    if (typeof fn !== 'function') throw new Error('missing export');
    pacer = {
      cycleQuantumForSlice: (sliceMs, minHostMhz) =>
        (fn as (a: number, b: number) => number)(sliceMs, minHostMhz),
    };
    backend = 'wasm';
  } catch {
    pacer = null;
    backend = 'js';
  }
}

function refreshQuantum(): void {
  if (pacer) {
    cycleQuantum = pacer.cycleQuantumForSlice(maxSliceMs, 8);
  } else {
    cycleQuantum = Math.max(4096, Math.floor(maxSliceMs * 8 * 1000));
  }
}

function portSnapshot(name: AvrPortName): AvrPortSnapshot {
  const port =
    name === 'B' ? runner!.portB : name === 'C' ? runner!.portC : runner!.portD;
  const pinStates: number[] = [];
  for (let bit = 0; bit < 8; bit++) {
    pinStates.push(port.pinState(bit));
  }
  return { port: name, pinStates };
}

function sampleLcdBus(
  bus: Extract<AvrWorkerInMessage, { type: 'start' }>['lcdTargets'][0]['bus'],
): { rs: boolean; rw: boolean; en: boolean; db: boolean[] } {
  const read = (ref: { port: AvrPortName; bit: number } | undefined) => {
    if (!ref || !runner) return false;
    const port =
      ref.port === 'B'
        ? runner.portB
        : ref.port === 'C'
          ? runner.portC
          : runner.portD;
    const st = port.pinState(ref.bit);
    return st === PinState.High || st === PinState.InputPullUp;
  };
  return {
    rs: read(bus.rs),
    rw: read(bus.rw),
    en: read(bus.en),
    db: bus.db.map((ref) => (ref ? read(ref) : false)),
  };
}

function attachLcdProbe(): () => void {
  if (!runner || lcdTargets.length === 0) return () => {};

  const detachers: Array<() => void> = [];
  for (const t of lcdTargets) {
    for (const portName of ['B', 'C', 'D'] as AvrPortName[]) {
      const enMask = t.enMasks[portName] ?? 0;
      if (enMask === 0) continue;
      const port =
        portName === 'B'
          ? runner.portB
          : portName === 'C'
            ? runner.portC
            : runner.portD;
      const listener = (value: number, oldValue: number) => {
        if (((value ^ oldValue) & enMask) === 0) return;
        post({
          v: AVR_WORKER_PROTOCOL,
          type: 'lcd-bus',
          id: t.id,
          cols: t.cols,
          rows: t.rows,
          pins: sampleLcdBus(t.bus),
        });
      };
      port.addListener(listener);
      detachers.push(() => port.removeListener(listener));
    }
  }
  return () => {
    for (const d of detachers) d();
  };
}

function attachTwiBus(): void {
  if (!runner) return;
  twiBus = new TwiSlaveBus(runner.twi);
  runner.twi.eventHandler = twiBus;
  rtcCores = [];
  backpackPorts.clear();
  for (const s of twiSlaves) {
    if (s.type === 'pcf8574_lcd_backpack') {
      twiBus.register(
        s.addr,
        createPcfBackpackTwiSlave(s.linkedLcds, (lcd, pins) => {
          post({
            v: AVR_WORKER_PROTOCOL,
            type: 'lcd-bus',
            id: lcd.id,
            cols: lcd.cols,
            rows: lcd.rows,
            pins,
          });
        }, port => backpackPorts.set(s.id, port)),
      );
    } else if (s.type === 'ds3231_rtc') {
      const created = createDs3231ModuleSlaves(new Date());
      twiBus.register(s.rtcAddr, created.rtc);
      twiBus.register(s.eepromAddr, created.eeprom);
      rtcCores.push(created.core);
    }
  }
}

let detachLcd: (() => void) | null = null;

function stopRunner(): void {
  serialInputQueue.length = 0;
  matrixBus?.dispose();
  matrixBus = null;
  detachLcd?.();
  detachLcd = null;
  rtcCores = [];
  twiBus = null;
  if (runner) {
    runner.stop();
    runner = null;
  }
}

function startRunner(hex: string): void {
  stopRunner();
  runner = new AvrRunner(hex);
  runner.usart.onByteTransmit = (value) => {
    post({ v: AVR_WORKER_PROTOCOL, type: 'usart', byte: value });
  };
  runner.usart.onRxComplete = () => {
    post({ v: AVR_WORKER_PROTOCOL, type: 'serial-received' });
    const next = serialInputQueue.shift();
    if (next !== undefined && !runner?.usart.writeByte(next)) serialInputQueue.length = 0;
  };
  matrixBus = new Max7219Bus(runner, matrixTargets);
  attachTwiBus();
  detachLcd = attachLcdProbe();
  refreshQuantum();

  const optionsProvider = () => ({
    maxWorkMs,
    maxSliceMs,
    cycleQuantum,
    tabHidden,
  });

  runner.execute(() => {
    if (!runner) return;
    const cycles = runner.cpu.cycles;
    for (const rtc of rtcCores) rtc.advanceToCycle(cycles);
    const meta = runner.lastBatchMeta;
    post({
      v: AVR_WORKER_PROTOCOL,
      type: 'tick',
      sentAt: import.meta.env.DEV ? performance.timeOrigin + performance.now() : undefined,
      cycles: runner.cpu.cycles,
      cyclesBehind: runner.cyclesBehind(tabHidden),
      ports: [portSnapshot('B'), portSnapshot('C'), portSnapshot('D')],
      matrices: matrixBus?.snapshots(),
      backpackPorts: [...backpackPorts].map(([id, port]) => {
        const sample = (bit: number): 'high' | 'low' | undefined => {
          // Byte-level TWI: sample PINC, never invent clock edges.
          if (runner!.portC.pinState(bit) === PinState.Input) return undefined;
          return (runner!.cpu.data[runner!.portC.portConfig.PIN] & (1 << bit)) !== 0 ? 'high' : 'low';
        };
        return { id, port, sda: sample(4), scl: sample(5) };
      }),
      perf: meta
        ? {
            batchWallMs: meta.batchWallMs,
            avrLoopWallMs: meta.avrLoopWallMs,
            batchExitReason: meta.batchExitReason,
            maxWorkMsUsed: meta.maxWorkMsUsed,
            instructionsLastBatch: meta.instructionsDelta,
            backend,
          }
        : undefined,
    });
  }, optionsProvider);
}

self.onmessage = (ev: MessageEvent<AvrWorkerInMessage>) => {
  const msg = ev.data;
  if (!msg || msg.v !== AVR_WORKER_PROTOCOL) return;

  switch (msg.type) {
    case 'start':
      matrixTargets = msg.max7219Targets ?? [];
      lcdTargets = msg.lcdTargets;
      twiSlaves = msg.twiSlaves ?? [];
      startRunner(msg.hex);
      break;
    case 'max7219-power':
      matrixBus?.setPower(msg.samples);
      break;
    case 'stop':
      stopRunner();
      break;
    case 'serial-input':
      if (!runner || !runner.usart.rxEnable) break;
      serialInputQueue.push(...msg.bytes.slice(0, Math.max(0, 4096 - serialInputQueue.length)));
      if (!runner.usart.rxBusy) {
        const next = serialInputQueue.shift();
        if (next !== undefined && !runner.usart.writeByte(next)) serialInputQueue.length = 0;
      }
      break;
    case 'set-inputs':
      if (!runner) break;
      for (const p of msg.pins) {
        const port =
          p.port === 'B'
            ? runner.portB
            : p.port === 'C'
              ? runner.portC
              : runner.portD;
        port.setPin(p.bit, p.high);
      }
      break;
    case 'set-options':
      maxWorkMs = msg.maxWorkMs;
      maxSliceMs = msg.maxSliceMs;
      tabHidden = msg.tabHidden;
      refreshQuantum();
      break;
    case 'sync-wall':
      runner?.syncWallClock();
      break;
    default:
      break;
  }
};

void loadPacer().then(() => {
  post({ v: AVR_WORKER_PROTOCOL, type: 'ready', backend });
});

void CPU_FREQ_HZ;

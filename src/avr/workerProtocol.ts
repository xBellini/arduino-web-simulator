/**
 * What: Typed message protocol between the main-thread AVR host and the AVR Worker.
 * Role: Keep GPIO/LCD/USART/TWI/timebase IPC explicit and versionable.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Worker + WASM AVR path
#                     | twiSlaves on start (I2C LCD backpack / PCF)
# 09-10-2026 | Cursor | Moved from `src/sim/avrWorkerProtocol.ts` (tree reorganization)
#                     | `ds3231_rtc` TWI slave (DS3231 @ 0x68 + AT24C32 @ 0x57)
# 13-10-2026 | Codex | Batch PCF port latches and observed AVR I2C pin levels with each tick.
 */

import type { AvrPortName } from './pinMap';

export const AVR_WORKER_PROTOCOL = 1 as const;

/** Snapshot of one GPIO port for DC solve / UI (not cycle-accurate LCD). */
export type AvrPortSnapshot = {
  port: AvrPortName;
  /** PIN/PORT/DDR raw style: bit i high means pin i driven/read high for pinState decode. */
  pinStates: number[]; // 8 entries, PinState enum values
};

export type AvrWorkerTwiSlave =
  | {
      type: 'pcf8574_lcd_backpack';
      id: string;
      /** 7-bit I2C address (fixed 0x27 until properties editor). */
      addr: number;
      /** Parallel LCDs wired to this backpack's LCD header (RS/E/D4–D7). */
      linkedLcds: Array<{ id: string; cols: number; rows: number }>;
    }
  | {
      type: 'ds3231_rtc';
      id: string;
      /** 7-bit DS3231 address (0x68). */
      rtcAddr: number;
      /** 7-bit AT24C32 address (0x57). */
      eepromAddr: number;
    };

export type AvrWorkerInMessage =
  | {
      v: typeof AVR_WORKER_PROTOCOL;
      type: 'start';
      hex: string;
      /** LCD probe targets (EN-edge → bus sample posted to main). */
      lcdTargets: Array<{
        id: string;
        cols: number;
        rows: number;
        /** port → bitmask of EN bits on that port */
        enMasks: Partial<Record<AvrPortName, number>>;
        /** pin map for sampling RS/RW/EN/DBx from MCU ports */
        bus: {
          rs?: { port: AvrPortName; bit: number };
          rw?: { port: AvrPortName; bit: number };
          en?: { port: AvrPortName; bit: number };
          db: Array<{ port: AvrPortName; bit: number } | null>;
        };
      }>;
      /** Ideal I2C slaves registered on AVRTWI (in-worker). */
      twiSlaves: AvrWorkerTwiSlave[];
    }
  | { v: typeof AVR_WORKER_PROTOCOL; type: 'stop' }
  | {
      v: typeof AVR_WORKER_PROTOCOL;
      type: 'set-inputs';
      /** pinId (d0..) → level */
      pins: Array<{ port: AvrPortName; bit: number; high: boolean }>;
    }
  | {
      v: typeof AVR_WORKER_PROTOCOL;
      type: 'set-options';
      maxWorkMs: number;
      maxSliceMs: number;
      tabHidden: boolean;
    }
  | { v: typeof AVR_WORKER_PROTOCOL; type: 'sync-wall' };

export type AvrWorkerOutMessage =
  | {
      v: typeof AVR_WORKER_PROTOCOL;
      type: 'ready';
      backend: 'js' | 'wasm';
    }
  | {
      v: typeof AVR_WORKER_PROTOCOL;
      type: 'tick';
      cycles: number;
      cyclesBehind: number;
      ports: AvrPortSnapshot[];
      backpackPorts?: Array<{ id: string; port: number; sda?: 'high' | 'low'; scl?: 'high' | 'low' }>;
      /** Optional Sim perf batch metrics for the overlay. */
      perf?: {
        batchWallMs: number;
        avrLoopWallMs: number;
        batchExitReason: 'caught_up' | 'work_budget' | 'idle_at_target';
        maxWorkMsUsed: number;
        instructionsLastBatch: number;
        backend: 'js' | 'wasm';
      };
    }
  | {
      v: typeof AVR_WORKER_PROTOCOL;
      type: 'usart';
      byte: number;
    }
  | {
      v: typeof AVR_WORKER_PROTOCOL;
      type: 'lcd-bus';
      id: string;
      cols: number;
      rows: number;
      pins: {
        rs: boolean;
        rw: boolean;
        en: boolean;
        db: boolean[];
      };
    }
  | {
      v: typeof AVR_WORKER_PROTOCOL;
      type: 'error';
      message: string;
    };

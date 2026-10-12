/**
 * What: AT24C32 32-kbit I2C EEPROM as an ideal TWI slave (the chip on ZS-042 RTC modules).
 * Role: 4096-byte array, 16-bit word address, 32-byte page writes, sequential read.
 * Owns/exports: `AT24C32_I2C_ADDR`, `AT24C32_SIZE`, `createAt24c32`, `createAt24c32TwiSlave`.
 * Conventions: Default 7-bit address 0x57 (A2=A1=A0 high — typical unsoldered ZS-042 pads).
 * Word address is 12 bits (4 KiB). Page writes wrap inside a 32-byte page; sequential
 * reads wrap the whole array. Not electrically modelled (no write-cycle delay, no WP pin).
 * Not-here: DS3231 RTC registers — see `src/avr/ds3231.ts`.
 *
 * Provenance: Microchip/Atmel AT24C32 datasheet (I2C EEPROM protocol). No MIT IC emulator
 * was vendored; this is a datasheet slave like the PCF8574 latch.
 *
 * Changelog:
 * - 09-10-2026 — Datasheet AT24C32 I2C slave for the DS3231 RTC module
 */
import type { TwiSlave } from './twiBus';

/** 7-bit address when A2/A1/A0 are high (common DS3231 module default). */
export const AT24C32_I2C_ADDR = 0x57;

export const AT24C32_SIZE = 4096;
const PAGE_SIZE = 32;
const ADDR_MASK = AT24C32_SIZE - 1;

export interface At24c32 {
  read(addr: number): number;
  write(addr: number, value: number): void;
  /** Current address pointer (12-bit). */
  ptr: number;
}

export function createAt24c32(): At24c32 {
  const mem = new Uint8Array(AT24C32_SIZE);
  let ptr = 0;

  return {
    get ptr() {
      return ptr;
    },
    set ptr(v: number) {
      ptr = v & ADDR_MASK;
    },
    read(addr: number) {
      return mem[addr & ADDR_MASK]!;
    },
    write(addr: number, value: number) {
      mem[addr & ADDR_MASK] = value & 0xff;
    },
  };
}

/**
 * I2C: up to two address bytes after a write-connect, then data.
 * Page writes wrap on 32-byte boundaries; reads increment through the whole array.
 */
export function createAt24c32TwiSlave(ic: At24c32): TwiSlave {
  let addrBytes = 0;
  let addrAcc = 0;

  return {
    connect(_addr, write) {
      if (write) {
        addrBytes = 0;
        addrAcc = 0;
      }
      return true;
    },
    writeByte(value) {
      const v = value & 0xff;
      if (addrBytes === 0) {
        addrAcc = (v & 0x0f) << 8;
        addrBytes = 1;
        return true;
      }
      if (addrBytes === 1) {
        ic.ptr = addrAcc | v;
        addrBytes = 2;
        return true;
      }
      const pageBase = ic.ptr & ~(PAGE_SIZE - 1);
      ic.write(ic.ptr, v);
      ic.ptr = pageBase | ((ic.ptr + 1) & (PAGE_SIZE - 1));
      return true;
    },
    readByte() {
      const v = ic.read(ic.ptr);
      ic.ptr = (ic.ptr + 1) & ADDR_MASK;
      return v;
    },
  };
}

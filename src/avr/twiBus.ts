/**
 * What: Ideal I2C / TWI slave bus for avr8js `AVRTWI` (in-worker).
 * Role: Route start/connect/write/read to registered 7-bit slaves; NACK unknown addresses.
 * Owns/exports: `TwiSlave`, `TwiSlaveBus`.
 * Conventions: Always complete start/stop; connect/write ACK only when a slave handles them.
 * Not-here: Bit-bang GPIO I2C, pull-up SPICE, multi-master.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Changelog creation / ideal TWI slave bus for Wire
# 09-10-2026 | Cursor | Removed `twiBusSelfCheck` (only the deleted bench-twi script used it)
#                     | Moved from `src/sim/twiBus.ts` (tree reorganization)
#                     | Slave API also used by DS3231 / AT24C32
 */
import type { AVRTWI, TWIEventHandler } from 'avr8js';

/** Minimal slave API (PCF8574, DS3231, AT24C32, …). */
export interface TwiSlave {
  /** Return true to ACK address (write=true → master write). */
  connect(addr: number, write: boolean): boolean;
  /** Return true to ACK data byte. */
  writeByte(value: number): boolean;
  /** Supply byte for master read; `ack` is master's TWEA for this byte. */
  readByte(ack: boolean): number;
}

/**
 * `TWIEventHandler` that multiplexes registered 7-bit addresses onto one AVRTWI.
 */
export class TwiSlaveBus implements TWIEventHandler {
  private readonly slaves = new Map<number, TwiSlave>();
  private active: TwiSlave | null = null;

  constructor(private readonly twi: AVRTWI) {}

  clear(): void {
    this.slaves.clear();
    this.active = null;
  }

  /** Register or replace a slave at a 7-bit address (0…127). */
  register(addr: number, slave: TwiSlave): void {
    this.slaves.set(addr & 0x7f, slave);
  }

  unregister(addr: number): void {
    this.slaves.delete(addr & 0x7f);
    this.active = null;
  }

  start(_repeated: boolean): void {
    this.active = null;
    this.twi.completeStart();
  }

  stop(): void {
    this.active = null;
    this.twi.completeStop();
  }

  connectToSlave(addr: number, write: boolean): void {
    const slave = this.slaves.get(addr & 0x7f) ?? null;
    const ack = slave ? slave.connect(addr & 0x7f, write) : false;
    this.active = ack ? slave : null;
    this.twi.completeConnect(ack);
  }

  writeByte(value: number): void {
    const ack = this.active ? this.active.writeByte(value & 0xff) : false;
    this.twi.completeWrite(ack);
  }

  readByte(ack: boolean): void {
    const value = this.active ? this.active.readByte(ack) & 0xff : 0xff;
    this.twi.completeRead(value);
  }
}


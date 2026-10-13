/**
 * What: DS3231 RTC IC as an ideal I2C slave for the AVR TWI bus.
 * Role: Datasheet register file (timekeeping, alarms, control/status, aging, temperature)
 * plus a `TwiSlave` that ACK's at 0x68. Time advances from **AVR cycle counts**
 * (`advanceToCycle`), not a hand-rolled wall-clock overlay.
 * Owns/exports: `DS3231_I2C_ADDR`, `createDs3231`, `Ds3231`, `createDs3231TwiSlave`.
 * Conventions: BCD calendar per Analog Devices DS3231 datasheet (Rev 10+). Hours bit6
 * selects 12/24h. Sequential I2C pointer wraps 0x00…0x12. EOSC=1 stops the oscillator.
 * Temperature registers power up at 25.00 °C (datasheet typical); this is a register
 * default, not a SPICE-measured quantity. SQW / 32 kHz pins are not driven electrically.
 * Not-here: Module artwork, AT24C32 EEPROM, palette — see `src/components/modules/ds3231Rtc.ts`.
 *
 * Provenance: No MIT/BSD IC-level emulator was available to vendor (QEMU's Dallas RTC
 * is GPL-2). Behaviour follows the Analog Devices DS3231 datasheet register map, same
 * datasheet-slave approach as the PCF8574 latch.
 *
# Changelog
# Date       | Author | Remarks
# 09-10-2026 | Cursor | Datasheet DS3231 I2C slave (timekeeping + alarms + TWI adapter)
 */
import type { TwiSlave } from './twiBus';

export const DS3231_I2C_ADDR = 0x68;

const REG_SEC = 0x00;
const REG_MIN = 0x01;
const REG_HOUR = 0x02;
const REG_DOW = 0x03;
const REG_DATE = 0x04;
const REG_MONTH = 0x05;
const REG_YEAR = 0x06;
const REG_A1_SEC = 0x07;
const REG_A1_MIN = 0x08;
const REG_A1_HOUR = 0x09;
const REG_A1_DYDT = 0x0a;
const REG_A2_MIN = 0x0b;
const REG_A2_HOUR = 0x0c;
const REG_A2_DYDT = 0x0d;
const REG_CONTROL = 0x0e;
const REG_STATUS = 0x0f;
const REG_AGING = 0x10;
const REG_TEMP_MSB = 0x11;
const REG_TEMP_LSB = 0x12;
const REG_LAST = 0x12;

const CTL_EOSC = 1 << 7;
const STS_OSF = 1 << 7;
const STS_EN32KHZ = 1 << 3;
const STS_A2F = 1 << 1;
const STS_A1F = 1 << 0;

const MONTH_DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface Ds3231Options {
  /** Host local time used as the battery-backed power-on clock. */
  wallClock: Date;
  /** AVR cycle count at construction (usually 0). */
  startCycle: number;
  /** MCU clock (avr8js is 16 MHz). One RTC second = this many cycles. */
  cyclesPerSecond: number;
}

export interface Ds3231 {
  writeReg(addr: number, value: number): void;
  readReg(addr: number): number;
  /** Advance calendar from AVR cycles since the previous call / start. */
  advanceToCycle(cycle: number): void;
}

function toBcd(n: number): number {
  const v = Math.max(0, n | 0);
  return (((v / 10) | 0) << 4) | (v % 10);
}

function fromBcd(v: number): number {
  return ((v >> 4) & 0x0f) * 10 + (v & 0x0f);
}

function isLeapYear(year00: number): boolean {
  return year00 % 4 === 0;
}

function daysInMonth(year00: number, month: number): number {
  if (month === 2) return isLeapYear(year00) ? 29 : 28;
  return MONTH_DAYS[month] ?? 31;
}

function encodeHours(h24: number, twelveHour: boolean): number {
  if (!twelveHour) return toBcd(h24) & 0x3f;
  const pm = h24 >= 12;
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return 0x40 | (pm ? 0x20 : 0) | (toBcd(h12) & 0x1f);
}

function decodeHours(reg: number): { h24: number; twelveHour: boolean } {
  if ((reg & 0x40) === 0) {
    return { h24: fromBcd(reg & 0x3f) % 24, twelveHour: false };
  }
  const pm = (reg & 0x20) !== 0;
  let h12 = fromBcd(reg & 0x1f);
  if (h12 === 12) h12 = 0;
  return { h24: (h12 + (pm ? 12 : 0)) % 24, twelveHour: true };
}

function nextPtr(ptr: number): number {
  return ptr >= REG_LAST ? 0 : ptr + 1;
}

export function createDs3231(opts: Ds3231Options): Ds3231 {
  const regs = new Uint8Array(REG_LAST + 1);
  let lastCycle = opts.startCycle;
  let fracCycles = 0;
  const cps = Math.max(1, opts.cyclesPerSecond | 0);

  const wall = opts.wallClock;
  const h24 = wall.getHours();
  regs[REG_SEC] = toBcd(wall.getSeconds());
  regs[REG_MIN] = toBcd(wall.getMinutes());
  regs[REG_HOUR] = encodeHours(h24, false);
  const dow = wall.getDay(); // 0=Sun … 6=Sat; DS3231 is 1=Sun … 7=Sat
  regs[REG_DOW] = toBcd(dow === 0 ? 1 : dow + 1);
  regs[REG_DATE] = toBcd(wall.getDate());
  const year = wall.getFullYear();
  regs[REG_MONTH] = toBcd(wall.getMonth() + 1) | (year >= 2100 ? 0x80 : 0);
  regs[REG_YEAR] = toBcd(year % 100);
  // Datasheet POR: control 1XX11100 with EOSC=0, RS2=RS1=INTCN=1 → 0x1C.
  // Battery-backed sim: OSF=0 so sketches do not see a "lost power" flag.
  regs[REG_CONTROL] = 0x1c;
  regs[REG_STATUS] = STS_EN32KHZ;
  regs[REG_AGING] = 0;
  regs[REG_TEMP_MSB] = 25; // 25.00 °C typical
  regs[REG_TEMP_LSB] = 0;

  function oscillatorOn(): boolean {
    return (regs[REG_CONTROL] & CTL_EOSC) === 0;
  }

  function field(reg: number, mask: number): number {
    return fromBcd(regs[reg] & mask);
  }

  function tickOneSecond(): void {
    let sec = field(REG_SEC, 0x7f) + 1;
    let min = field(REG_MIN, 0x7f);
    const hourDec = decodeHours(regs[REG_HOUR]);
    let hour = hourDec.h24;
    let dow = Math.max(1, field(REG_DOW, 0x07));
    let date = Math.max(1, field(REG_DATE, 0x3f));
    let month = Math.max(1, field(REG_MONTH, 0x1f));
    let year00 = field(REG_YEAR, 0xff);
    let century = (regs[REG_MONTH] & 0x80) !== 0;

    if (sec >= 60) {
      sec = 0;
      min += 1;
    }
    if (min >= 60) {
      min = 0;
      hour += 1;
    }
    if (hour >= 24) {
      hour = 0;
      dow = dow >= 7 ? 1 : dow + 1;
      date += 1;
      const dim = daysInMonth(year00, month);
      if (date > dim) {
        date = 1;
        month += 1;
        if (month > 12) {
          month = 1;
          year00 += 1;
          if (year00 >= 100) {
            year00 = 0;
            century = !century;
          }
        }
      }
    }

    regs[REG_SEC] = toBcd(sec);
    regs[REG_MIN] = toBcd(min);
    regs[REG_HOUR] = encodeHours(hour, hourDec.twelveHour);
    regs[REG_DOW] = toBcd(dow);
    regs[REG_DATE] = toBcd(date);
    regs[REG_MONTH] = toBcd(month) | (century ? 0x80 : 0);
    regs[REG_YEAR] = toBcd(year00);
    matchAlarms(sec, min, hour, dow, date);
  }

  function alarmHourH24(reg: number): number {
    return decodeHours(reg & 0x7f).h24;
  }

  function matchAlarms(
    sec: number,
    min: number,
    hour: number,
    dow: number,
    date: number,
  ): void {
    const a1m1 = (regs[REG_A1_SEC] & 0x80) !== 0;
    const a1m2 = (regs[REG_A1_MIN] & 0x80) !== 0;
    const a1m3 = (regs[REG_A1_HOUR] & 0x80) !== 0;
    const a1m4 = (regs[REG_A1_DYDT] & 0x80) !== 0;
    const a1Ok =
      (a1m1 || field(REG_A1_SEC, 0x7f) === sec) &&
      (a1m2 || field(REG_A1_MIN, 0x7f) === min) &&
      (a1m3 || alarmHourH24(regs[REG_A1_HOUR]) === hour) &&
      (a1m4 ||
        ((regs[REG_A1_DYDT] & 0x40) !== 0
          ? field(REG_A1_DYDT, 0x0f) === dow
          : field(REG_A1_DYDT, 0x3f) === date));
    if (a1Ok) regs[REG_STATUS] |= STS_A1F;

    // Alarm 2 has no seconds register; it fires at second 00 when other fields match.
    const a2m2 = (regs[REG_A2_MIN] & 0x80) !== 0;
    const a2m3 = (regs[REG_A2_HOUR] & 0x80) !== 0;
    const a2m4 = (regs[REG_A2_DYDT] & 0x80) !== 0;
    const a2Ok =
      sec === 0 &&
      (a2m2 || field(REG_A2_MIN, 0x7f) === min) &&
      (a2m3 || alarmHourH24(regs[REG_A2_HOUR]) === hour) &&
      (a2m4 ||
        ((regs[REG_A2_DYDT] & 0x40) !== 0
          ? field(REG_A2_DYDT, 0x0f) === dow
          : field(REG_A2_DYDT, 0x3f) === date));
    if (a2Ok) regs[REG_STATUS] |= STS_A2F;
  }

  return {
    writeReg(addr: number, value: number) {
      const a = addr & 0xff;
      const v = value & 0xff;
      if (a > REG_LAST) return;
      if (a === REG_TEMP_MSB || a === REG_TEMP_LSB) return;
      if (a === REG_STATUS) {
        // Flags are sticky until software writes 0; writing 1 is ignored.
        let next = regs[REG_STATUS];
        if ((v & STS_OSF) === 0) next &= ~STS_OSF;
        if ((v & STS_A1F) === 0) next &= ~STS_A1F;
        if ((v & STS_A2F) === 0) next &= ~STS_A2F;
        next = (next & ~(STS_EN32KHZ)) | (v & STS_EN32KHZ);
        regs[REG_STATUS] = next;
        return;
      }
      if (a === REG_SEC) {
        regs[REG_SEC] = v & 0x7f;
        return;
      }
      if (a === REG_MIN) {
        regs[REG_MIN] = v & 0x7f;
        return;
      }
      if (a === REG_DOW) {
        regs[REG_DOW] = v & 0x07;
        return;
      }
      if (a === REG_DATE) {
        regs[REG_DATE] = v & 0x3f;
        return;
      }
      regs[a] = v;
    },
    readReg(addr: number) {
      const a = addr & 0xff;
      if (a > REG_LAST) return 0;
      return regs[a]!;
    },
    advanceToCycle(cycle: number) {
      if (!oscillatorOn()) {
        lastCycle = cycle;
        return;
      }
      const delta = cycle - lastCycle;
      lastCycle = cycle;
      if (delta <= 0) return;
      fracCycles += delta;
      while (fracCycles >= cps) {
        fracCycles -= cps;
        tickOneSecond();
      }
    },
  };
}

/** I2C: first write byte is the register pointer; reads/writes auto-increment 0x00…0x12. */
export function createDs3231TwiSlave(ic: Ds3231): TwiSlave {
  let ptr = 0;
  let primed = false;

  return {
    connect(_addr, write) {
      primed = write;
      return true;
    },
    writeByte(value) {
      const v = value & 0xff;
      if (primed) {
        ptr = v <= REG_LAST ? v : 0;
        primed = false;
        return true;
      }
      ic.writeReg(ptr, v);
      ptr = nextPtr(ptr);
      return true;
    },
    readByte() {
      const v = ic.readReg(ptr);
      ptr = nextPtr(ptr);
      return v;
    },
  };
}

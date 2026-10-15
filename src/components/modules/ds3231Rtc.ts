/**
 * What: ZS-042 style DS3231 + AT24C32 RTC module — footprint, dual I2C headers, TWI slaves.
 * Role: PartModule packaging around the datasheet DS3231 and AT24C32 ICs. No on-module
 * display; sketches talk to it over Wire (Uno SDA/SCL). Left 6-pin and right 4-pin headers
 * share SCL/SDA/VCC/GND copper.
 * Owns/exports: `ds3231RtcModule`, `DS3231_RTC_TYPE`, `isDs3231RtcType`,
 * `createDs3231ModuleSlaves`.
 * Conventions: Artwork is `public/components/ds3231_rtc.svg` (viewBox 0 0 182 110).
 * Pin x/y match that file's `data-terminal-*` (left x=7, right x=172, 12-unit pitch).
 * Left header top→bottom: 32K, SQW, SCL, SDA, VCC, GND. Right header: SCL, SDA, VCC, GND.
 * RTC default @ 0x68 (`rtcI2cAddr` editable in properties), EEPROM fixed @ 0x57.
 * SQW/32K are not driven. Ideal I2C (no pull-up SPICE).
 * Not-here: IC register maps — `src/avr/ds3231.ts` and `src/avr/at24c32.ts`.
 *
# Changelog
# Date       | Author | Remarks
# 09-10-2026 | Cursor | DS3231 RTC module (I2C + AT24C32)
#                     | Drop generated SVG; footprint is `public/components/ds3231_rtc.svg`
# 12-10-2026 | Cursor | properties.editable: rtcI2cAddr (default 0x68) for Wire/library match
# 13-10-2026 | Codex | Own RTC address form and palette placement; add clock/time/I2C keywords; retain address parser and hex display.
# 15-10-2026 | Codex | Declare both RTC supply headers for N/A wire overlays without a guessed electrical load.
#                     | Light the artwork power LED red from solved supply polarity; current remains unavailable.
 */
import type { PartModule } from '../partModule';
import type { TwiSlave } from '../../avr/twiBus';
import { CPU_FREQ_HZ } from '../../avr/runner';
import {
  DS3231_I2C_ADDR,
  createDs3231,
  createDs3231TwiSlave,
  type Ds3231,
} from '../../avr/ds3231';
import {
  AT24C32_I2C_ADDR,
  createAt24c32,
  createAt24c32TwiSlave,
} from '../../avr/at24c32';

export const DS3231_RTC_TYPE = 'ds3231_rtc';
export { DS3231_I2C_ADDR, AT24C32_I2C_ADDR };

/** Inclusive 7-bit address range accepted by the properties editor / project load. */
export const RTC_I2C_ADDR_MIN = 0x03;
export const RTC_I2C_ADDR_MAX = 0x77;

export function isDs3231RtcType(type: string): boolean {
  return type === DS3231_RTC_TYPE;
}

/** Parse a 7-bit I2C address from number or hex/decimal string; null if invalid. */
export function parseRtcI2cAddr(raw: unknown): number | null {
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (!t) return null;
    n = t.startsWith('0x') ? Number.parseInt(t, 16) : Number.parseInt(t, 10);
  } else {
    return null;
  }
  if (!Number.isInteger(n) || n < RTC_I2C_ADDR_MIN || n > RTC_I2C_ADDR_MAX) {
    return null;
  }
  return n;
}

export function createDs3231ModuleSlaves(wallClock = new Date()): {
  rtc: TwiSlave;
  eeprom: TwiSlave;
  core: Ds3231;
} {
  const core = createDs3231({
    wallClock,
    startCycle: 0,
    cyclesPerSecond: CPU_FREQ_HZ,
  });
  return {
    rtc: createDs3231TwiSlave(core),
    eeprom: createAt24c32TwiSlave(createAt24c32()),
    core,
  };
}

/** Left/right header pairs that are the same PCB net. */
const HEADER_SHORTS: ReadonlyArray<readonly [string, string]> = [
  ['scl', 'scl_r'],
  ['sda', 'sda_r'],
  ['vcc', 'vcc_r'],
  ['gnd', 'gnd_r'],
];

export const ds3231RtcModule: PartModule = {
  palette: { category: 'modules', order: 50, keywords: ['rtc', 'clock', 'time', 'i2c'] },
  type: DS3231_RTC_TYPE,
  internalPinShorts: HEADER_SHORTS,

  // Supply current is unavailable until this module has an electrical model.
  wireCurrentPath(pinId) {
    if (pinId === 'vcc' || pinId === 'gnd') {
      return { branch: 'supply', positive: 'vcc', negative: 'gnd' };
    }
    if (pinId === 'vcc_r' || pinId === 'gnd_r') {
      return { branch: 'supply', positive: 'vcc_r', negative: 'gnd_r' };
    }
  },

  definition: {
    type: DS3231_RTC_TYPE,
    label: 'DS3231 RTC',
    powerIndicator: { x: 62, y: 16, width: 8, height: 7.5, color: '#ff3636', positive: 'vcc', negative: 'gnd' },
    scale: 2,
    artwork: '/components/ds3231_rtc.svg',
    pins: [
      { id: '32k', description: '32K', x: 7, y: 26, type: 'digital' },
      { id: 'sqw', description: 'SQW', x: 7, y: 38, type: 'digital' },
      { id: 'scl', description: 'SCL', x: 7, y: 50, type: 'digital' },
      { id: 'sda', description: 'SDA', x: 7, y: 62, type: 'digital' },
      { id: 'vcc', description: 'VCC', x: 7, y: 74, type: 'power' },
      { id: 'gnd', description: 'GND', x: 7, y: 86, type: 'ground' },
      { id: 'scl_r', description: 'SCL', x: 172, y: 36, type: 'digital' },
      { id: 'sda_r', description: 'SDA', x: 172, y: 48, type: 'digital' },
      { id: 'vcc_r', description: 'VCC', x: 172, y: 60, type: 'power' },
      { id: 'gnd_r', description: 'GND', x: 172, y: 72, type: 'ground' },
    ],
  },

  properties: {
    title: 'DS3231 RTC properties',
    fields: [{
      key: 'rtcI2cAddr', label: 'RTC I2C address', kind: 'integer',
      parse: parseRtcI2cAddr,
      format: value => '0x' + value.toString(16).toUpperCase().padStart(2, '0'),
      error: 'Address must be 7-bit hex 0x03–0x77',
      hint: 'Default 0x68. Sketch / library must use the same address.',
    }],
    defaults: () => ({
      rtcI2cAddr: DS3231_I2C_ADDR,
    }),
    load(raw, into) {
      into.rtcI2cAddr = parseRtcI2cAddr(raw.rtcI2cAddr) ?? DS3231_I2C_ADDR;
    },
  },
};

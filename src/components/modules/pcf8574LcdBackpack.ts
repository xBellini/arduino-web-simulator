/**
 * What: Everything the simulator knows about the PCF8574 LCD I2C backpack, in one file.
 * Role: PartModule — footprint/pins, datasheet PCF port latch (module behaviour, not SPICE),
 * board P0–P7→HD44780 map, and the TWI slave factory the AVR worker registers.
 * Owns/exports: `pcf8574LcdBackpackModule`, `isPcf8574LcdBackpackType`,
 * `PCF8574_LCD_BACKPACK_TYPE`, `PCF8574_DEFAULT_ADDR`, `createPcf8574`,
 * `pcfPortToParallelPins`, `PCF_BIT_*`, `createPcfBackpackTwiSlave`.
 * Conventions: Pin x/y from `pcf8574_lcd_backpack.svg` `data-terminal-*` (viewBox 0 0 182 82).
 * LCD header along the bottom edge; **logical** lcd1→lcd16 is left→right to mate above a
 * parallel LCD (SVG silk may still show mirrored pad numbering — wiring uses these ids).
 * This part is the **backpack board only** (no LCD glass). Wire lcd* to a parallel LCD.
 * Addr fixed 0x27 until a properties editor. Ideal I2C (no pull-up SPICE).
 * Not-here: SPICE of pot/jumper/transistor; address jumpers; glass glyphs (on the LCD part).
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Backpack-only part (not an LCD); pins from SVG data-terminal-*
#                     | Single-file module (pins + PCF behaviour + board map); was split across sim/
#                     | Remapped lcd1–lcd16 left→right for stacking above LCD (artwork unchanged)
# 09-10-2026 | Cursor | Moved from `src/parts/pcf8574LcdBackpack.ts` (tree reorganization)
 */
import type { PartModule } from '../partModule';
import type { TwiSlave } from '../../avr/twiBus';
import type { ParallelPinLevels } from '../../avr/hd44780';

export const PCF8574_LCD_BACKPACK_TYPE = 'pcf8574_lcd_backpack';

/** Fixed backpack address until properties editor (schematic A0–A2 high → 0x27). */
export const PCF8574_DEFAULT_ADDR = 0x27;

export function isPcf8574LcdBackpackType(type: string): boolean {
  return type === PCF8574_LCD_BACKPACK_TYPE;
}

// ---------------------------------------------------------------------------
// Board quirk: PCF port byte → HD44780 parallel levels (schematic hard-wire)
// ---------------------------------------------------------------------------

export const PCF_BIT_RS = 0;
export const PCF_BIT_RW = 1;
export const PCF_BIT_E = 2;
export const PCF_BIT_BT = 3;
export const PCF_BIT_D4 = 4;
export const PCF_BIT_D5 = 5;
export const PCF_BIT_D6 = 6;
export const PCF_BIT_D7 = 7;

export function pcfPortToParallelPins(port: number): ParallelPinLevels {
  const p = port & 0xff;
  const bit = (n: number) => (p & (1 << n)) !== 0;
  return {
    rs: bit(PCF_BIT_RS),
    rw: bit(PCF_BIT_RW),
    en: bit(PCF_BIT_E),
    db: [
      false,
      false,
      false,
      false,
      bit(PCF_BIT_D4),
      bit(PCF_BIT_D5),
      bit(PCF_BIT_D6),
      bit(PCF_BIT_D7),
    ],
  };
}

// ---------------------------------------------------------------------------
// Datasheet PCF8574 port latch (minimal digital slave — not a SPICE netlist)
// ---------------------------------------------------------------------------

export interface Pcf8574 {
  readonly latch: number;
  inputLowMask: number;
  writePort(value: number): void;
  readPort(): number;
  portByte(): number;
}

/** Power-on latch 0xFF; write replaces latch; read applies external lows. */
export function createPcf8574(initialLatch = 0xff): Pcf8574 {
  let latch = initialLatch & 0xff;
  let inputLowMask = 0;

  return {
    get latch() {
      return latch;
    },
    get inputLowMask() {
      return inputLowMask;
    },
    set inputLowMask(v: number) {
      inputLowMask = v & 0xff;
    },
    writePort(value: number) {
      latch = value & 0xff;
    },
    readPort() {
      return latch & ~inputLowMask & 0xff;
    },
    portByte() {
      return latch & ~inputLowMask & 0xff;
    },
  };
}

export type PcfBackpackLinkedLcd = {
  id: string;
  cols: number;
  rows: number;
};

/**
 * TWI slave for the AVR worker: ACK at backpack addr; on E falling edge notify linked LCDs.
 */
export function createPcfBackpackTwiSlave(
  linkedLcds: PcfBackpackLinkedLcd[],
  onLcdBus: (
    lcd: PcfBackpackLinkedLcd,
    pins: ParallelPinLevels,
  ) => void,
): TwiSlave {
  const pcf = createPcf8574(0xff);
  let lastEnHigh = false;

  return {
    connect() {
      return true;
    },
    writeByte(value: number) {
      pcf.writePort(value);
      const enHigh = (value & (1 << PCF_BIT_E)) !== 0;
      const falling = lastEnHigh && !enHigh;
      lastEnHigh = enHigh;
      if (falling) {
        const pins = pcfPortToParallelPins(pcf.portByte());
        for (const lcd of linkedLcds) onLcdBus(lcd, pins);
      }
      return true;
    },
    readByte() {
      return pcf.readPort();
    },
  };
}

// ---------------------------------------------------------------------------
// Footprint
// ---------------------------------------------------------------------------

const LCD_HEADER_DESCS = [
  'VSS',
  'VDD',
  'VO',
  'RS',
  'RW',
  'E',
  'D0',
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'D7',
  'LED+',
  'LED-',
] as const;

function lcdHeaderPins(): PartModule['definition']['pins'] {
  // Left→right lcd1…lcd16 so the backpack can sit above a parallel LCD (pin 1 left).
  // Artwork keep rotate(180); only these connection coords are remapped.
  return LCD_HEADER_DESCS.map((description, i) => ({
    id: `lcd${i + 1}`,
    description,
    x: 9 + i * 10,
    y: 74,
    type:
      description === 'VSS' || description === 'LED-'
        ? ('ground' as const)
        : description === 'VDD' || description === 'LED+'
          ? ('power' as const)
          : description === 'VO'
            ? ('analog' as const)
            : ('digital' as const),
  }));
}

export const pcf8574LcdBackpackModule: PartModule = {
  type: PCF8574_LCD_BACKPACK_TYPE,

  definition: {
    type: PCF8574_LCD_BACKPACK_TYPE,
    label: 'PCF8574 LCD backpack',
    scale: 2,
    artwork: '/components/pcf8574_lcd_backpack.svg',
    pins: [
      { id: 'gnd', description: 'GND', x: 9.5, y: 54, type: 'ground' },
      { id: 'vcc', description: 'VCC', x: 9.5, y: 44, type: 'power' },
      { id: 'sda', description: 'SDA', x: 9.5, y: 34, type: 'digital' },
      { id: 'scl', description: 'SCL', x: 9.5, y: 24, type: 'digital' },
      ...lcdHeaderPins(),
    ],
  },
};

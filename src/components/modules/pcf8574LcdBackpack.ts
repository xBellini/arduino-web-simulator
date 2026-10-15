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
 * Worker latch/PINC snapshots drive signal labels. Power paths use an ideal fitted
 * backlight jumper and P3 switch, feeding the LCD's existing solver loads.
 * Not-here: pot and PCF quiescent draw, transistor analog behavior, address jumpers, LCD glass.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Backpack-only part (not an LCD); pins from SVG data-terminal-*
#                     | Single-file module (pins + PCF behaviour + board map); was split across sim/
#                     | Remapped lcd1–lcd16 left→right for stacking above LCD (artwork unchanged)
# 09-10-2026 | Cursor | Moved from `src/parts/pcf8574LcdBackpack.ts` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
#                     | Add sampled worker signal overlays and solved LCD supply/backlight paths.
# 15-10-2026 | Codex | Light the artwork power LED blue from solved supply polarity with a static overlay.
 */
import type { PartModule } from '../partModule';
import type { NetLevel } from '../../circuit/netlist';
import type { TwiSlave } from '../../avr/twiBus';
import type { ParallelPinLevels } from '../../avr/hd44780';

export const PCF8574_LCD_BACKPACK_TYPE = 'pcf8574_lcd_backpack';

/** Fixed backpack address until properties editor (schematic A0–A2 high → 0x27). */
export const PCF8574_DEFAULT_ADDR = 0x27;

// Per-instance worker state; cleared on stop/restart. TWI remains byte-level:
// pin samples show AVR state, never synthetic SCL pulses.
const snapshots = new Map<string, { port: number; sda?: NetLevel; scl?: NetLevel }>();
export function setPcfBackpackSnapshot(id: string, port: number, sda?: NetLevel, scl?: NetLevel): void {
  snapshots.set(id, { port: port & 0xff, sda, scl });
}
export function clearPcfBackpackSnapshots(): void { snapshots.clear(); }
const headerBits: Record<string, number> = { lcd4: 0, lcd5: 1, lcd6: 2, lcd11: 4, lcd12: 5, lcd13: 6, lcd14: 7 };
const backlightOn = (id: string) => ((snapshots.get(id)?.port ?? 0xff) & (1 << PCF_BIT_BT)) !== 0;
// Numerical connection resistance in legacy MNA, not a rated board load.
const CONNECTION_OHMS = 0.001;

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
  onPort?: (port: number) => void,
): TwiSlave {
  const pcf = createPcf8574(0xff);
  let lastEnHigh = false;
  onPort?.(pcf.portByte());

  return {
    connect() {
      return true;
    },
    writeByte(value: number) {
      pcf.writePort(value);
      onPort?.(pcf.portByte());
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
  palette: { category: 'modules', order: 40 },
  type: PCF8574_LCD_BACKPACK_TYPE,

  // Jumper-fitted board: header VDD/LED+ share supply; P3 switches LED-.
  // Reference board topology: https://www.handsontec.com/dataspecs/I2C_LCD_Interface.pdf (p. 2).
  // Supply reading covers attached LCD loads, excluding unmodeled PCF/pot draw.
  internalPinShorts: [['gnd', 'lcd1'], ['lcd2', 'lcd15']],
  ensurePins: ['vcc', 'lcd16'],
  spiceCacheKey: ({ comp }) => backlightOn(comp.id) ? 'backlight:on' : 'backlight:off',
  spiceStamp(ctx) {
    const vcc = ctx.pinNet('vcc'), header = ctx.pinNet('lcd2');
    const gnd = ctx.pinNet('gnd'), cathode = ctx.pinNet('lcd16');
    if (vcc !== null && header !== null && vcc !== header) {
      const sense = 'V' + ctx.sid + '_supply';
      ctx.line(sense + ' ' + ctx.node(vcc) + ' ' + ctx.node(header) + ' 0');
      ctx.instance(sense, 'supply');
    }
    if (gnd !== null && cathode !== null && gnd !== cathode) {
      if (backlightOn(ctx.comp.id)) ctx.line('V' + ctx.sid + '_switch ' + ctx.node(cathode) + ' ' + ctx.node(gnd) + ' 0');
      else ctx.line('R' + ctx.sid + '_open ' + ctx.node(cathode) + ' ' + ctx.node(gnd) + ' 1e12');
    }
  },
  legacyStamp(ctx) {
    const vcc = ctx.pinNet('vcc'), header = ctx.pinNet('lcd2');
    const gnd = ctx.pinNet('gnd'), cathode = ctx.pinNet('lcd16');
    if (vcc !== null && header !== null && vcc !== header)
      ctx.stampResistor(vcc, header, CONNECTION_OHMS, 'supply');
    if (gnd !== null && cathode !== null && gnd !== cathode)
      ctx.stampResistor(cathode, gnd, backlightOn(ctx.comp.id) ? CONNECTION_OHMS : 1e12);
  },
  wireCurrentPath(pin) {
    return pin === 'vcc' || pin === 'gnd' ? { branch: 'supply', positive: 'vcc', negative: 'gnd' } : undefined;
  },
  wireLogicLevel(pin, level, comp) {
    if (pin === 'sda' || pin === 'scl') return snapshots.get(comp.id)?.[pin] ?? level(pin);
    const bit = headerBits[pin];
    if (bit === undefined) return undefined;
    if (level('vcc') !== 'high' || level('gnd') !== 'low') return 'floating';
    const port = snapshots.get(comp.id)?.port;
    return port === undefined ? 'floating' : (port & (1 << bit)) !== 0 ? 'high' : 'low';
  },

  definition: {
    type: PCF8574_LCD_BACKPACK_TYPE,
    label: 'PCF8574 LCD backpack',
    scale: 2,
    powerIndicator: { x: 145, y: 29, width: 6, height: 7, color: '#339dff', positive: 'vcc', negative: 'gnd' },
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

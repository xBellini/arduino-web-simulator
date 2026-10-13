/**
 * What: Project facade over the vendored HD44780 IC model (vrEmuLcd character engine).
 * Role: stable API for LCD PartModules — never import vendor types from parts directly.
 * Owns/exports: `createHd44780`, `Hd44780`, parallel bus latch helpers, command re-exports.
 * Conventions: bus-agnostic IC (`write(rs, byte)`); E-edge / 4-bit assembly live in latch helpers
 * used by PartModules. Not placeable / not in `components/index` or the palette.
 * To add another display size: `createHd44780({ cols, rows })` only.
 * Not-here: SVG overlay, registry pins — see `src/components/lcd*.tsx`.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Changelog creation / facade over vrEmuLcdChar + parallel latch
# 09-10-2026 | Cursor | Moved from `src/sim/hd44780.ts` (tree reorganization)
 */
import {
  createVrEmuLcdChar,
  LCD_CMD_CLEAR,
  LCD_CMD_DISPLAY,
  LCD_CMD_DISPLAY_ON,
  LCD_CMD_ENTRY_MODE,
  LCD_CMD_ENTRY_MODE_INCREMENT,
  LCD_CMD_FUNCTION,
  LCD_CMD_HOME,
  LCD_CMD_SET_CGRAM_ADDR,
  LCD_CMD_SET_DRAM_ADDR,
  type VrEmuLcdChar,
} from './vendor/vrEmuLcd/vrEmuLcdChar';

export {
  LCD_CMD_CLEAR,
  LCD_CMD_DISPLAY,
  LCD_CMD_DISPLAY_ON,
  LCD_CMD_ENTRY_MODE,
  LCD_CMD_ENTRY_MODE_INCREMENT,
  LCD_CMD_FUNCTION,
  LCD_CMD_HOME,
  LCD_CMD_SET_CGRAM_ADDR,
  LCD_CMD_SET_DRAM_ADDR,
};

export interface Hd44780Options {
  cols: number;
  rows: number;
}

export interface Hd44780 {
  readonly cols: number;
  readonly rows: number;
  /** RS=0 command, RS=1 data — full 8-bit byte (after nibble assembly). */
  write(rs: 0 | 1, byte: number): void;
  getCell(col: number, row: number): number;
  /** 5×8 glyph: array of 5 column bytes, bit7 = top pixel. */
  glyphColumns(code: number): Uint8Array;
  /** 8 rows × 5 bits (true = on) for overlay drawing. */
  glyphBitmap(code: number): boolean[][];
  isDisplayOn(): boolean;
  isCursorAt(col: number, row: number): boolean;
  cursorFlags(): number;
  /** Underlying engine (tests / advanced). */
  readonly engine: VrEmuLcdChar;
}

export function createHd44780(opts: Hd44780Options): Hd44780 {
  const engine = createVrEmuLcdChar(opts.cols, opts.rows);

  function glyphBitmap(code: number): boolean[][] {
    const cols = engine.charBits(code);
    const rows: boolean[][] = [];
    for (let y = 0; y < 8; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < 5; x++) {
        row.push(((cols[x] ?? 0) & (0x80 >> y)) !== 0);
      }
      rows.push(row);
    }
    return rows;
  }

  return {
    cols: engine.cols,
    rows: engine.rows,
    engine,
    write(rs, byte) {
      const b = byte & 0xff;
      if (rs) engine.writeByte(b);
      else engine.sendCommand(b);
    },
    getCell: (c, r) => engine.getCell(c, r),
    glyphColumns: (code) => engine.charBits(code),
    glyphBitmap,
    isDisplayOn: () => engine.isDisplayOn(),
    isCursorAt: (c, r) => engine.isCursorAt(c, r),
    cursorFlags: () => engine.cursorFlags(),
  };
}

/** Parallel HD44780 bus latch state (per placed LCD instance). */
export interface Hd44780ParallelLatch {
  lastEnHigh: boolean;
  /** Pending high nibble in 4-bit transfers; null = expect high nibble next. */
  pendingHighNibble: number | null;
  /**
   * After LiquidCrystal's single-nibble `0x2` wake, transfers are high+low pairs.
   * Before that, init pulses are single nibbles on D4–D7 (`0x3`, `0x2`).
   */
  fourBitPaired: boolean;
}

export function createParallelLatch(): Hd44780ParallelLatch {
  return {
    lastEnHigh: false,
    pendingHighNibble: null,
    fourBitPaired: false,
  };
}

export interface ParallelPinLevels {
  rs: boolean;
  rw: boolean;
  en: boolean;
  /** db0..db7 */
  db: boolean[];
}

function byteFromDb(db: boolean[]): number {
  let v = 0;
  for (let i = 0; i < 8; i++) if (db[i]) v |= 1 << i;
  return v;
}

/**
 * On EN falling edge (write, RW low), feed the HD44780.
 * Matches Arduino `LiquidCrystal` 4-bit init (single-nibble 0x3 / 0x2, then pairs)
 * and full 8-bit writes when D0–D3 are used.
 */
export function latchParallelOnEnableFall(
  ic: Hd44780,
  latch: Hd44780ParallelLatch,
  pins: ParallelPinLevels,
): boolean {
  const enHigh = pins.en;
  const falling = latch.lastEnHigh && !enHigh;
  latch.lastEnHigh = enHigh;
  if (!falling) return false;
  if (pins.rw) return false;

  const rs: 0 | 1 = pins.rs ? 1 : 0;
  const byte8 = byteFromDb(pins.db);
  const lowerBusy = pins.db[0] || pins.db[1] || pins.db[2] || pins.db[3];
  const nib = (byte8 >> 4) & 0x0f;

  // 8-bit path: any activity on D0–D3 → full byte
  if (lowerBusy) {
    latch.pendingHighNibble = null;
    latch.fourBitPaired = (byte8 & 0xf0) === 0x20 && (byte8 & 0x10) === 0;
    ic.write(rs, byte8);
    return true;
  }

  // 4-bit path on D4–D7
  if (!latch.fourBitPaired) {
    // Init: one enable per nibble; 0x2 switches to paired mode
    ic.write(rs, (nib << 4) & 0xf0);
    if (nib === 0x2) {
      latch.fourBitPaired = true;
      latch.pendingHighNibble = null;
    }
    return true;
  }

  if (latch.pendingHighNibble === null) {
    latch.pendingHighNibble = nib;
    return false;
  }
  const full = ((latch.pendingHighNibble & 0x0f) << 4) | (nib & 0x0f);
  latch.pendingHighNibble = null;
  ic.write(rs, full);
  return true;
}

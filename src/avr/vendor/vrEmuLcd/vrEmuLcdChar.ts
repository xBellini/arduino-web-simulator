/**
 * What: Character-mode HD44780U controller engine — TypeScript port of vrEmuLcd (MIT).
 * Role: IC behavioral model (DDRAM / CGRAM / commands). Not a placeable part.
 * Owns/exports: `createVrEmuLcdChar`, command constants, `VrEmuLcdChar` instance API.
 * Conventions: Logic mirrors `vrEmuLcd.c` character path; graphics LCD mode omitted.
 * Not-here: GPIO latch, canvas overlay — see `src/sim/hd44780.ts` and LCD PartModules.
 *
 * Changelog:
 * - 05-10-2026 — Changelog creation / TS port of vrEmuLcd character mode + A02 font
 */
import { FONT_A02 } from './fontA02';

export const LCD_CMD_CLEAR = 0x01;
export const LCD_CMD_HOME = 0x02;
export const LCD_CMD_ENTRY_MODE = 0x04;
export const LCD_CMD_ENTRY_MODE_INCREMENT = 0x02;
export const LCD_CMD_ENTRY_MODE_SHIFT = 0x01;
export const LCD_CMD_DISPLAY = 0x08;
export const LCD_CMD_DISPLAY_ON = 0x04;
export const LCD_CMD_DISPLAY_CURSOR = 0x02;
export const LCD_CMD_DISPLAY_CURSOR_BLINK = 0x01;
export const LCD_CMD_SHIFT = 0x10;
export const LCD_CMD_SHIFT_DISPLAY = 0x08;
export const LCD_CMD_SHIFT_RIGHT = 0x04;
export const LCD_CMD_FUNCTION = 0x20;
export const LCD_CMD_SET_CGRAM_ADDR = 0x40;
export const LCD_CMD_SET_DRAM_ADDR = 0x80;

const CHAR_WIDTH_PX = 5;
const CHAR_HEIGHT_PX = 8;
const DDRAM_SIZE = 128;
const DDRAM_VISIBLE_SIZE = 80;
const CGRAM_STORAGE_CHARS = 16;
const DEFAULT_CGRAM_BYTE = 0xaa;

const ROW_OFFSETS = [0x00, 0x40, 0x14, 0x54];

export interface VrEmuLcdChar {
  readonly cols: number;
  readonly rows: number;
  sendCommand(command: number): void;
  writeByte(data: number): void;
  /** DDRAM character code at display cell (accounts for scroll). */
  getCell(col: number, row: number): number;
  /** 5 column bytes (MSB = top row), like vrEmuLcdCharBits. */
  charBits(code: number): Uint8Array;
  isDisplayOn(): boolean;
  /** Absolute DDRAM offset for (row,col). */
  getDataOffset(row: number, col: number): number;
  /** True when address counter points at this cell (for cursor). */
  isCursorAt(col: number, row: number): boolean;
  cursorFlags(): number;
}

interface LcdState {
  cols: number;
  rows: number;
  entryModeFlags: number;
  displayFlags: number;
  scrollOffset: number;
  ddRam: Uint8Array;
  ddIndex: number;
  /** Flat CGRAM: 16 chars × 8 bytes; first 5 bytes per char are column bitmaps. */
  cgRam: Uint8Array;
  /** Index into cgRam when CGRAM selected; null = DDRAM. */
  cgIndex: number | null;
  dataWidthCols: number;
}

function clampGeometry(cols: number, rows: number): { cols: number; rows: number } {
  let c = cols;
  let r = rows;
  if (c < 8) c = 8;
  if (c > 40) c = 40;
  if (r < 1) r = 1;
  if (r > 4) r = 4;
  if (r === 3) r = 2;
  return { cols: c, rows: r };
}

function dataWidthForRows(rows: number): number {
  if (rows === 1) return 80;
  if (rows === 2) return 40;
  return 20; // 4 rows
}

export function createVrEmuLcdChar(cols: number, rows: number): VrEmuLcdChar {
  const g = clampGeometry(cols, rows);
  const state: LcdState = {
    cols: g.cols,
    rows: g.rows,
    entryModeFlags: LCD_CMD_ENTRY_MODE_INCREMENT,
    displayFlags: 0,
    scrollOffset: 0,
    ddRam: new Uint8Array(DDRAM_SIZE).fill(0x20),
    ddIndex: 0,
    cgRam: new Uint8Array(CGRAM_STORAGE_CHARS * CHAR_HEIGHT_PX).fill(DEFAULT_CGRAM_BYTE),
    cgIndex: null,
    dataWidthCols: dataWidthForRows(g.rows),
  };

  function increment(): void {
    state.ddIndex++;
    const offset = state.ddIndex;
    if (state.rows > 1) {
      if (offset === 0x28) state.ddIndex = 0x40;
      else if (offset === 0x68 || offset >= DDRAM_SIZE) state.ddIndex = 0;
    } else if (offset >= DDRAM_VISIBLE_SIZE) {
      state.ddIndex = 0;
    }
  }

  function decrement(): void {
    state.ddIndex--;
    const offset = state.ddIndex;
    if (state.rows > 1) {
      if (offset === -1) state.ddIndex = 0x67;
      else if (offset === 0x39) state.ddIndex = 0x27;
    }
    if (state.ddIndex < 0) {
      state.ddIndex += DDRAM_VISIBLE_SIZE;
    } else if (state.ddIndex >= DDRAM_SIZE) {
      state.ddIndex = 0;
    }
  }

  function doShift(): void {
    if (state.cgIndex !== null) {
      if (state.entryModeFlags & LCD_CMD_ENTRY_MODE_INCREMENT) {
        state.cgIndex++;
        if (state.cgIndex >= state.cgRam.length) state.cgIndex = 0;
      } else {
        state.cgIndex--;
        if (state.cgIndex < 0) state.cgIndex = state.cgRam.length - 1;
      }
      return;
    }
    if (state.entryModeFlags & LCD_CMD_ENTRY_MODE_SHIFT) {
      if (state.entryModeFlags & LCD_CMD_ENTRY_MODE_INCREMENT) state.scrollOffset++;
      else state.scrollOffset--;
    }
    if (state.entryModeFlags & LCD_CMD_ENTRY_MODE_INCREMENT) increment();
    else decrement();
  }

  function getDataOffset(row: number, col: number): number {
    let r = row;
    if (r >= state.rows) r = state.rows - 1;
    while (state.scrollOffset < 0) state.scrollOffset += state.dataWidthCols;
    const dataCol = (col + state.scrollOffset) % state.dataWidthCols;
    let rowOffset = r * state.dataWidthCols;
    if (state.rows > 1) rowOffset = ROW_OFFSETS[r] ?? 0;
    return rowOffset + dataCol;
  }

  function charBits(code: number): Uint8Array {
    const c = code & 0xff;
    if (c < CGRAM_STORAGE_CHARS) {
      const base = (c % CGRAM_STORAGE_CHARS) * CHAR_HEIGHT_PX;
      return state.cgRam.subarray(base, base + CHAR_WIDTH_PX);
    }
    const romIndex = c - CGRAM_STORAGE_CHARS;
    const start = romIndex * CHAR_WIDTH_PX;
    return Uint8Array.from(FONT_A02.slice(start, start + CHAR_WIDTH_PX));
  }

  function sendCommand(command: number): void {
    const cmd = command & 0xff;
    if (cmd & LCD_CMD_SET_DRAM_ADDR) {
      state.ddIndex = cmd & 0x7f;
      state.cgIndex = null;
    } else if (cmd & LCD_CMD_SET_CGRAM_ADDR) {
      state.cgIndex = cmd & 0x3f;
    } else if (cmd & LCD_CMD_FUNCTION) {
      // Character mode: function-set width/lines ignored for memory map (geometry fixed at create).
    } else if (cmd & LCD_CMD_SHIFT) {
      if (cmd & LCD_CMD_SHIFT_DISPLAY) {
        if (cmd & LCD_CMD_SHIFT_RIGHT) state.scrollOffset--;
        else state.scrollOffset++;
      } else if (cmd & LCD_CMD_SHIFT_RIGHT) {
        increment();
      } else {
        decrement();
      }
    } else if (cmd & LCD_CMD_DISPLAY) {
      state.displayFlags = cmd;
    } else if (cmd & LCD_CMD_ENTRY_MODE) {
      state.entryModeFlags = cmd;
    } else if (cmd & LCD_CMD_HOME) {
      state.ddIndex = 0;
      state.scrollOffset = 0;
    } else if (cmd & LCD_CMD_CLEAR) {
      state.ddRam.fill(0x20);
      state.ddIndex = 0;
      state.scrollOffset = 0;
    }
  }

  function writeByte(data: number): void {
    const d = data & 0xff;
    if (state.cgIndex !== null) {
      const row = state.cgIndex % CHAR_HEIGHT_PX;
      const startAddr = state.cgIndex - row;
      for (let i = 0; i < CHAR_WIDTH_PX; i++) {
        const bit = d & ((0x01 << (CHAR_WIDTH_PX - 1)) >> i);
        if (bit) state.cgRam[startAddr + i] |= 0x80 >> row;
        else state.cgRam[startAddr + i] &= ~(0x80 >> row);
      }
    } else {
      state.ddRam[state.ddIndex] = d;
    }
    doShift();
  }

  return {
    cols: state.cols,
    rows: state.rows,
    sendCommand,
    writeByte,
    getCell(col, row) {
      return state.ddRam[getDataOffset(row, col)] ?? 0x20;
    },
    charBits,
    isDisplayOn: () => (state.displayFlags & LCD_CMD_DISPLAY_ON) !== 0,
    getDataOffset,
    isCursorAt(col, row) {
      return getDataOffset(row, col) === state.ddIndex;
    },
    cursorFlags: () =>
      state.displayFlags & (LCD_CMD_DISPLAY_CURSOR | LCD_CMD_DISPLAY_CURSOR_BLINK),
  };
}

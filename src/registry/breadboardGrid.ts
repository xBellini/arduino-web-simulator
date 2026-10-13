/**
 * What: Single source of truth for breadboard hole grid and board dimensions.
 * Role: tie/rail geometry for the procedural `breadboard` part and canvas snap alignment.
 * Owns/exports: pitch constants (`BB_COL`, `BB_ROW`, …), `BB_WIDTH`/`BB_HEIGHT`, rail Ys,
 * `holeX`/`holeY`, `tiePinId`, `rowLabel`, `pinSpanCols`, IC slot bounds, tie row helpers.
 * Conventions: column pitch equals row pitch (`BB_COL === BB_ROW`) so rotated two-lead parts
 * still land on holes; pin ids `tp*`/`tn*`/`bp*`/`bn*` for rails, `r,c` via `tiePinId(r,c)`
 * for tie matrix; registry `breadboardPins()` must stay in sync with these formulas.
 * To change board size: adjust `BB_COLS`/`BB_ROWS` and re-check `BB_WIDTH`/`BB_HEIGHT` derivations;
 * update `components.ts` breadboard pin loop if column count changes.
 * To place a new THT part on a row: set pin `y` to `THT_PIN_Y` or a `holeY(row)` value and
 * `x` to `holeX(col)` / `pinSpanCols` spacing from `PIN_INSET`.
 * To bridge the IC gap: use row indices and `BB_IC_ROW_SPAN` so vertical spans are whole
 * multiples of `BB_ROW`.
 * Not-here: component registry entries (except consuming these constants) or wire routing logic.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
 */

export const BB_COL = 18;
/** Row pitch matches column pitch so rotated parts (e.g. diode) seat on tie rows. */
export const BB_ROW = BB_COL;
export const BB_LEFT = 14;
/** First pin column inset — matches breadboard left tie column. */
export const PIN_INSET = BB_LEFT;
export const BB_COLS = 50;
/** Five rows per tie band (a–e and f–j), with an IC channel between them. */
export const BB_ROWS = 10;
export const BB_ROWS_PER_BAND = 5;
/**
 * Row count from the last top-band hole (e) to the first bottom-band hole (f).
 * Must be a whole multiple of BB_ROW so parts can bridge the IC slot (e.g. vertical diode = 3 rows).
 */
export const BB_IC_ROW_SPAN = 3;
/** Clearance between row e and row f tie lines (IC body sits in the remainder). */
export const BB_IC_ROW_GAP = (BB_IC_ROW_SPAN - 1) * BB_ROW;

export const BB_ROW_Y0 = 46;

export const BB_RAIL_TOP_PLUS_Y = 10;
/** +/− rails are one hole pitch (BB_ROW) apart — matches the body grid so a
 *  two-lead part (e.g. a polarized cap) can bridge the rails directly. */
export const BB_RAIL_TOP_MINUS_Y = BB_RAIL_TOP_PLUS_Y + BB_ROW;

export function holeX(col: number): number {
  return PIN_INSET + col * BB_COL;
}

export function holeY(row: number): number {
  if (row < BB_ROWS_PER_BAND) {
    return BB_ROW_Y0 + row * BB_ROW;
  }
  return (
    BB_ROW_Y0 +
    (BB_ROWS_PER_BAND - 1) * BB_ROW +
    BB_IC_ROW_GAP +
    (row - BB_ROWS_PER_BAND + 1) * BB_ROW
  );
}

export const BB_TIE_LAST_Y = holeY(BB_ROWS - 1);
export const BB_RAIL_BOT_PLUS_Y = BB_TIE_LAST_Y + BB_ROW;
export const BB_RAIL_BOT_MINUS_Y = BB_TIE_LAST_Y + 2 * BB_ROW;

export const BB_WIDTH = holeX(BB_COLS - 1) + BB_LEFT;
export const BB_HEIGHT = BB_RAIL_BOT_MINUS_Y + BB_ROW;

/** Y bounds of the horizontal IC slot between the two row bands. */
export const BB_IC_SLOT_TOP = holeY(BB_ROWS_PER_BAND - 1) + BB_ROW / 2 + 2;
export const BB_IC_SLOT_BOTTOM = holeY(BB_ROWS_PER_BAND) - BB_ROW / 2 - 2;

/** Standard pin row for THT parts sitting on a breadboard tie row. */
export const THT_PIN_Y = BB_ROW_Y0;

export function tieRowYs(): number[] {
  return Array.from({ length: BB_ROWS }, (_, r) => holeY(r));
}

export function tieBandRowYs(band: 0 | 1): number[] {
  const start = band === 0 ? 0 : BB_ROWS_PER_BAND;
  return Array.from({ length: BB_ROWS_PER_BAND }, (_, i) => holeY(start + i));
}

/** Two pins with `emptyHoles` empty columns between them (LED: 0 → adjacent cols 0,1). */
export function pinSpanCols(emptyHoles: number): [number, number] {
  return [0, emptyHoles + 1];
}

/** Three adjacent pin columns (transistor, potentiometer). */
export function pinSpanCols3(): [number, number, number] {
  return [0, 1, 2];
}

export function pinAtCol(col: number, row = 0): { x: number; y: number } {
  return { x: holeX(col), y: holeY(row) };
}

export function rowLabel(row: number): string {
  return String.fromCharCode('a'.charCodeAt(0) + row);
}

export function tiePinId(row: number, col: number): string {
  return `${rowLabel(row)}${col + 1}`;
}

/** Y positions of the four power/ground rail hole rows (top +/−, bottom +/−). */
export function railRowYs(): number[] {
  return [
    BB_RAIL_TOP_PLUS_Y,
    BB_RAIL_TOP_MINUS_Y,
    BB_RAIL_BOT_PLUS_Y,
    BB_RAIL_BOT_MINUS_Y,
  ];
}

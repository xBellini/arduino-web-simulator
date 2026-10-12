/**
 * What: Parallel LCD display color presets and validation for placed components.
 * Role: Properties panel + glass overlay; ghost segments are derived from background only.
 *
 * Changelog:
 * - 09-10-2026 — Moved from `src/utils/lcdDisplay.ts` (tree reorganization); added Changelog
 */

export const LCD_BACKGROUND_PRESETS = [
  { hex: '#1a2640', label: 'Blue glass' },
  { hex: '#1a3a2a', label: 'Green glass (classic)' },
  { hex: '#0d2818', label: 'Dark green' },
  { hex: '#1e1e1e', label: 'Neutral gray' },
  { hex: '#252018', label: 'Warm amber tint' },
] as const;

export const LCD_CHARACTER_PRESETS = [
  { hex: '#c6f56f', label: 'Lime (classic)' },
  { hex: '#ffffff', label: 'White' },
  { hex: '#ffd54f', label: 'Amber' },
  { hex: '#81d4fa', label: 'Ice blue' },
  { hex: '#ff8a80', label: 'Soft red' },
] as const;

export type LcdBackgroundHex = (typeof LCD_BACKGROUND_PRESETS)[number]['hex'];
export type LcdCharacterHex = (typeof LCD_CHARACTER_PRESETS)[number]['hex'];

export const DEFAULT_LCD_BACKGROUND: LcdBackgroundHex = '#1a3a2a';
export const DEFAULT_LCD_CHARACTER: LcdCharacterHex = '#c6f56f';

/** @deprecated Loaded from older saves — maps to {@link DEFAULT_LCD_CHARACTER}. */
export const DEFAULT_LCD_HIGHLIGHT = DEFAULT_LCD_CHARACTER;

export type LcdPropertiesPatch = {
  lcdBackgroundColor: LcdBackgroundHex;
  lcdCharacterColor: LcdCharacterHex;
};

const BACKGROUND_HEXES = new Set<string>(
  LCD_BACKGROUND_PRESETS.map((p) => p.hex),
);
const CHARACTER_HEXES = new Set<string>(
  LCD_CHARACTER_PRESETS.map((p) => p.hex),
);

export function isLcdBackgroundHex(value: unknown): value is LcdBackgroundHex {
  return typeof value === 'string' && BACKGROUND_HEXES.has(value);
}

export function isLcdCharacterHex(value: unknown): value is LcdCharacterHex {
  return typeof value === 'string' && CHARACTER_HEXES.has(value);
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const n = (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** Inactive dot segments — always slightly clearer than the glass background. */
export function lcdSegmentColor(background: string): string {
  const bg = parseHex(background);
  if (!bg) return '#2a4a38';
  const lift = 0.16;
  return toHex(
    bg.r + (255 - bg.r) * lift,
    bg.g + (255 - bg.g) * lift,
    bg.b + (255 - bg.b) * lift,
  );
}

/** @deprecated Use {@link lcdSegmentColor}. */
export const lcdIdlePixelColor = lcdSegmentColor;

export function lcdColorsFromComponent(comp: {
  lcdBackgroundColor?: string;
  lcdCharacterColor?: string;
  /** Legacy field name. */
  lcdHighlightColor?: string;
}): {
  background: LcdBackgroundHex;
  character: LcdCharacterHex;
  segment: string;
} {
  const background = isLcdBackgroundHex(comp.lcdBackgroundColor)
    ? comp.lcdBackgroundColor
    : DEFAULT_LCD_BACKGROUND;
  const charRaw = comp.lcdCharacterColor ?? comp.lcdHighlightColor;
  const character = isLcdCharacterHex(charRaw)
    ? charRaw
    : DEFAULT_LCD_CHARACTER;
  return { background, character, segment: lcdSegmentColor(background) };
}

export function loadLcdColorFields(
  raw: Record<string, unknown>,
  into: {
    lcdBackgroundColor?: string;
    lcdCharacterColor?: string;
    lcdHighlightColor?: string;
  },
): void {
  into.lcdBackgroundColor = isLcdBackgroundHex(raw.lcdBackgroundColor)
    ? raw.lcdBackgroundColor
    : DEFAULT_LCD_BACKGROUND;
  const charRaw = raw.lcdCharacterColor ?? raw.lcdHighlightColor;
  into.lcdCharacterColor = isLcdCharacterHex(charRaw)
    ? charRaw
    : DEFAULT_LCD_CHARACTER;
}

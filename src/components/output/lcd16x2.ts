/**
 * What: 16×2 parallel HD44780 character LCD module.
 * Role: PartModule — artwork + GPIO latch into shared HD44780 IC + glass overlay.
 * Owns/exports: `lcd16x2Module`.
 * Conventions: pins match former STATIC_REGISTRY entry; IC from `src/avr/hd44780.ts`.
 * Not-here: I2C backpack — see `pcf8574LcdBackpack.ts` (board only; wire to this LCD).
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Changelog creation / simulating parallel 16×2
#                     | Glass rect matched to SVG bluish display area (260×63)
# 09-10-2026 | Cursor | Moved from `src/parts/lcd16x2.ts` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import { createParallelLcdModule } from './lcdParallel';

export const lcd16x2Module = createParallelLcdModule({
  palette: { category: 'output', order: 30 },
  type: 'lcd_16x2',
  label: '16x2 LCD',
  cols: 16,
  rows: 2,
  scale: 2,
  artwork: '/components/lcd_16x2.svg',
  // Matches cgfx backlight rect in lcd_16x2.svg (viewBox-local coords).
  glass: { x: 27.5, y: 39.4, width: 260, height: 63 },
  pins: [
    { id: 'gnd', description: 'GND', x: 27.5, y: 5.5, type: 'ground' },
    { id: 'vcc', description: 'VCC', x: 37.5, y: 5.5, type: 'power' },
    { id: 'contrast_pin', description: 'Contrast', x: 47.5, y: 5.5, type: 'analog' },
    { id: 'rs', description: 'RS', x: 57.5, y: 5.5, type: 'digital' },
    { id: 'rw', description: 'RW', x: 67.5, y: 5.5, type: 'digital' },
    { id: 'en', description: 'EN', x: 77.5, y: 5.5, type: 'digital' },
    { id: 'db0', description: 'B0', x: 87.5, y: 5.5, type: 'digital' },
    { id: 'db1', description: 'B1', x: 97.5, y: 5.5, type: 'digital' },
    { id: 'db2', description: 'B2', x: 107.5, y: 5.5, type: 'digital' },
    { id: 'db3', description: 'B3', x: 117.5, y: 5.5, type: 'digital' },
    { id: 'db4', description: 'B4', x: 127.5, y: 5.5, type: 'digital' },
    { id: 'db5', description: 'B5', x: 137.5, y: 5.5, type: 'digital' },
    { id: 'db6', description: 'B6', x: 147.5, y: 5.5, type: 'digital' },
    { id: 'db7', description: 'B7', x: 157.5, y: 5.5, type: 'digital' },
    { id: 'led_a', description: 'LED+', x: 167.5, y: 5.5, type: 'power' },
    { id: 'led_k', description: 'LED-', x: 177.5, y: 5.5, type: 'ground' },
  ],
});

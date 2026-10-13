/**
 * What: 20×4 parallel HD44780 character LCD module.
 * Role: PartModule — artwork + GPIO latch into shared HD44780 IC + glass overlay.
 * Owns/exports: `lcd20x4Module`.
 * Conventions: pin/glass coords are viewBox-local for `lcd_20x4.svg` (same header pitch as 16×2).
 * Not-here: I2C / RTC.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Changelog creation / simulating parallel 20×4 (placeholder SVG OK)
#                     | Pins + glass matched to lcd_20x4.svg (was placeholder layout)
# 09-10-2026 | Cursor | Moved from `src/parts/lcd20x4.ts` (tree reorganization)
 */
import { createParallelLcdModule } from './lcdParallel';

export const lcd20x4Module = createParallelLcdModule({
  type: 'lcd_20x4',
  label: '20x4 LCD',
  cols: 20,
  rows: 4,
  scale: 2,
  artwork: '/components/lcd_20x4.svg',
  // Matches cgfx backlight rect in lcd_20x4.svg (viewBox-local coords).
  glass: { x: 27.5, y: 39.55, width: 325, height: 126 },
  pins: [
    { id: 'gnd', description: 'GND', x: 27.5, y: 5.55, type: 'ground' },
    { id: 'vcc', description: 'VCC', x: 37.5, y: 5.55, type: 'power' },
    { id: 'contrast_pin', description: 'Contrast', x: 47.5, y: 5.55, type: 'analog' },
    { id: 'rs', description: 'RS', x: 57.5, y: 5.55, type: 'digital' },
    { id: 'rw', description: 'RW', x: 67.5, y: 5.55, type: 'digital' },
    { id: 'en', description: 'EN', x: 77.5, y: 5.55, type: 'digital' },
    { id: 'db0', description: 'B0', x: 87.5, y: 5.55, type: 'digital' },
    { id: 'db1', description: 'B1', x: 97.5, y: 5.55, type: 'digital' },
    { id: 'db2', description: 'B2', x: 107.5, y: 5.55, type: 'digital' },
    { id: 'db3', description: 'B3', x: 117.5, y: 5.55, type: 'digital' },
    { id: 'db4', description: 'B4', x: 127.5, y: 5.55, type: 'digital' },
    { id: 'db5', description: 'B5', x: 137.5, y: 5.55, type: 'digital' },
    { id: 'db6', description: 'B6', x: 147.5, y: 5.55, type: 'digital' },
    { id: 'db7', description: 'B7', x: 157.5, y: 5.55, type: 'digital' },
    { id: 'led_a', description: 'LED+', x: 167.5, y: 5.55, type: 'power' },
    { id: 'led_k', description: 'LED-', x: 177.5, y: 5.55, type: 'ground' },
  ],
});

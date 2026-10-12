# Parallel HD44780 LCD bench (sim)

## IC model

- Vendored from [vrEmuLcd](https://github.com/visrealm/vrEmuLcd) (MIT) under `src/avr/vendor/vrEmuLcd/`
- Facade: `src/avr/hd44780.ts` (not placeable; not in the palette)
- Rule: `.cursor/rules/ic-controller-models.mdc`

## Parts

| Type | Palette | Notes |
|------|---------|--------|
| `lcd_16x2` | Output | Simulating — parallel bus |
| `lcd_20x4` | Output | Simulating — placeholder SVG until you drop final art |
| `pcf8574_lcd_backpack` | Modules | PCF8574 backpack board only (no LCD); datasheet PCF @ 0x27; wire LCD header to parallel LCD |

Replace `public/components/lcd_20x4.svg` with your artwork, then retune pin `x`/`y` and `glass` in `src/components/output/lcd20x4.ts` (subtract viewBox min-x/min-y if needed).

## Suggested wiring (4-bit)

Nano/Uno → parallel LCD:

| LCD | MCU |
|-----|-----|
| RS | D12 |
| EN | D11 |
| D4 | D5 |
| D5 | D4 |
| D6 | D3 |
| D7 | D2 |
| RW | GND |
| VSS | GND |
| VDD | 5V |

Match pins in `LiquidCrystal lcd(12, 11, 5, 4, 3, 2);`

**Contrast (VO):** on a real panel, VO→5V blanks the glass. The sim overlay ignores VO — leave it floating or use a pot if you care about hardware fidelity.

**How the sim latches:** LiquidCrystal EN pulses are microseconds long. Frame-rate DC solves miss them; during Run the AVR Worker probes GPIO EN edges and posts bus samples to the HD44780 model (`src/avr/worker.ts` + `lcdParallel`).

**Sim perf:** while Run is active, the canvas shows a **Sim perf** overlay (sim/wall time, effective MHz, solve cost). No URL flag required.

## Sketch

[`docs/sketches/lcd_fake_clock/lcd_fake_clock.ino`](../docs/sketches/lcd_fake_clock/lcd_fake_clock.ino) — `millis()` fake clock, no RTC/Wire. Use `lcd.begin(16, 2)` for the 16×2; row 2 (`setCursor(0, 2)`) is only valid on 20×4.

1. Place Nano + `lcd_20x4` (or `lcd_16x2`)
2. Wire as above
3. Paste/compile the sketch (or Import HEX)
4. Run — glass overlay shows glyphs when the HD44780 display is on

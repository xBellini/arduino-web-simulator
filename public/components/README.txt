Part artwork (public/components/)
============================

Each component type (except breadboard) has an SVG named after the registry
key, e.g. led.svg for type "led".

Many files are imported from scripts/reference/ (TinkerCAD exports). Those
often use viewBox="-1000 -1000 2000 2000". That is fine — resize/crop the SVG
(or change viewBox) so the art fills the footprint, then align pin x/y in
src/registry/components.ts to the same coordinate space.

For footprint-aligned art, prefer:

  viewBox="0 0 {width} {height}"

matching width/height on the ComponentDefinition.

DIP packages (dip4/6/8/14/16/18/20/24/28/40) are shared footprints: one SVG
per package, with an optional chip-name overlay (`marking: 'chip'` + instance
`partLabel`). Pins come from `dipPackagePins` in `src/registry/components.ts`.

Footprint size is read from each SVG's viewBox (width × height). Registry
entries only set `scale`, pins, and metadata — not width/height.

Placeholders (no TinkerCAD source yet): resistor, potentiometer, buzzer,
power_supply, voltmeter, ammeter, ohmmeter, oscillator, lcd_20x4 (swap in
final art; retune pins/glass in src/components/output/lcd20x4.ts).

HD44780 IC behavior is vendored (not a palette part): src/avr/vendor/vrEmuLcd
+ facade src/avr/hd44780.ts — see docs/lcd-parallel-bench.md.

DS3231 RTC module: keep artwork in public/components/ds3231_rtc.svg. I2C slaves are
src/avr/ds3231.ts and src/avr/at24c32.ts (no on-module display).

Regenerate those placeholders only with:

  npm run export-components-svg

(That script does not overwrite TinkerCAD imports.)

/**
 * What: Populates `public/components/` with per-component SVG assets for the palette and docs: copies
 * known TinkerCAD/Nano references from `scripts/reference/` by registry type, and writes minimal
 * placeholder SVGs only when no reference file exists. Invoked as `npm run export-components-svg`.
 * How-to: `npm run export-components-svg` from repo root refreshes `public/components/<type>.svg` for every entry in
 * `TINKER_IMPORTS` (add a `registryType: 'filename.svg'` row after dropping a file into `scripts/reference/`).
 * Placeholders at the bottom of this file cover types without a TinkerCAD import — edit `writePlaceholder` calls
 * or swap a type into `TINKER_IMPORTS` once you have a real SVG. Re-run after `fetch-tinkercad-svg.mjs` updates references.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `scripts/export-parts-svg.mjs` (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'public', 'parts');
const refDir = join(__dirname, 'reference');

mkdirSync(outDir, { recursive: true });

/** Registry type → reference filename under scripts/reference/ */
const TINKER_IMPORTS = {
  arduino_uno: 'tinkercad-132521-uno.svg',
  arduino_nano: 'arduino-nano-title-image.svg',
  led: 'tinkercad-58422.svg',
  diode: 'tinkercad-58320-diode.svg',
  transistor_npn: 'tinkercad-58468-npn.svg',
  transistor_pnp: 'tinkercad-58571-pnp.svg',
  button: 'tinkercad-144786.svg',
  servo: 'tinkercad-58632-servo.svg',
  mosfet_n: 'tinkercad-58627.svg',
  mosfet_p: 'tinkercad-59076.svg',
  capacitor: 'tinkercad-capacitor.svg',
  polarized_capacitor: 'tinkercad-polarized-cap.svg',
  rgb_led: 'tinkercad-rgb-led.svg',
  slide_switch: 'tinkercad-slide-switch.svg',
  seven_segment: 'tinkercad-seven-seg.svg',
  dip_switch_4: 'tinkercad-dip-switch-4.svg',
  dip_switch_6: 'tinkercad-dip-switch-6.svg',
  lcd_16x2: 'tinkercad-lcd-16x2.svg',
  lcd_i2c: 'tinkercad-lcd-i2c.svg',
  dip6: 'tinkercad-dip6.svg',
  dip8: 'tinkercad-dip8.svg',
  dip14: 'tinkercad-dip14.svg',
  dip16: 'tinkercad-dip16.svg',
};

function svg(w, h, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
${body}
</svg>
`;
}

function writePlaceholder(name, w, h, body) {
  writeFileSync(join(outDir, `${name}.svg`), svg(w, h, body));
  console.log(`placeholder ${name}.svg (${w}x${h})`);
}

for (const [type, file] of Object.entries(TINKER_IMPORTS)) {
  const src = join(refDir, file);
  copyFileSync(src, join(outDir, `${type}.svg`));
  console.log(`imported ${type}.svg <- ${file}`);
}

// Placeholders — no TinkerCAD reference in scripts/reference/
writePlaceholder(
  'resistor',
  76,
  32,
  `  <!-- Leads + body only — color bands are drawn live by ResistorBandOverlay -->
  <line x1="2" y1="16" x2="14" y2="16" stroke="#9e9e9e" stroke-width="2" stroke-linecap="round"/>
  <line x1="68" y1="16" x2="74" y2="16" stroke="#9e9e9e" stroke-width="2" stroke-linecap="round"/>
  <rect x="14" y="10" width="54" height="12" rx="3" fill="#D4A574" stroke="#8d6e63" stroke-width="1"/>`,
);
writePlaceholder(
  'potentiometer',
  56,
  72,
  `  <rect x="8" y="8" width="40" height="40" rx="4" fill="#8d6e63"/>
  <circle cx="28" cy="28" r="12" fill="#5d4037"/>
  <line x1="28" y1="28" x2="28" y2="16" stroke="#eceff1" stroke-width="2"/>
  <line x1="14" y1="52" x2="14" y2="64" stroke="#9e9e9e" stroke-width="2"/>
  <line x1="28" y1="52" x2="28" y2="64" stroke="#9e9e9e" stroke-width="2"/>
  <line x1="42" y1="52" x2="42" y2="64" stroke="#9e9e9e" stroke-width="2"/>`,
);
writePlaceholder(
  'buzzer',
  40,
  56,
  `  <circle cx="20" cy="24" r="16" fill="#37474f" stroke="#212121" stroke-width="2"/>
  <circle cx="20" cy="24" r="8" fill="#263238"/>
  <line x1="14" y1="40" x2="14" y2="48" stroke="#9e9e9e" stroke-width="2"/>
  <line x1="26" y1="40" x2="26" y2="48" stroke="#9e9e9e" stroke-width="2"/>`,
);
writePlaceholder(
  'power_supply',
  80,
  72,
  `  <rect x="4" y="4" width="72" height="48" rx="4" fill="#455a64"/>
  <rect x="12" y="12" width="56" height="20" rx="2" fill="#263238"/>
  <text x="40" y="26" text-anchor="middle" fill="#c5e1a5" font-size="10">PSU</text>
  <line x1="14" y1="52" x2="14" y2="56" stroke="#ef5350" stroke-width="2"/>
  <line x1="50" y1="52" x2="50" y2="56" stroke="#42a5f5" stroke-width="2"/>`,
);
writePlaceholder(
  'voltmeter',
  72,
  56,
  `  <rect x="4" y="4" width="64" height="36" rx="4" fill="#546e7a"/>
  <text x="36" y="26" text-anchor="middle" fill="#eceff1" font-size="14">V</text>
  <line x1="14" y1="40" x2="14" y2="48" stroke="#9e9e9e" stroke-width="2"/>
  <line x1="50" y1="40" x2="50" y2="48" stroke="#9e9e9e" stroke-width="2"/>`,
);
writePlaceholder(
  'ammeter',
  76,
  32,
  `  <rect x="14" y="6" width="48" height="20" rx="3" fill="#546e7a"/>
  <text x="38" y="20" text-anchor="middle" fill="#eceff1" font-size="12">A</text>
  <line x1="4" y1="16" x2="14" y2="16" stroke="#9e9e9e" stroke-width="2"/>
  <line x1="62" y1="16" x2="72" y2="16" stroke="#9e9e9e" stroke-width="2"/>`,
);
writePlaceholder(
  'ohmmeter',
  72,
  56,
  `  <rect x="4" y="4" width="64" height="36" rx="4" fill="#546e7a"/>
  <text x="36" y="26" text-anchor="middle" fill="#eceff1" font-size="14">Ω</text>
  <line x1="14" y1="40" x2="14" y2="48" stroke="#9e9e9e" stroke-width="2"/>
  <line x1="50" y1="40" x2="50" y2="48" stroke="#9e9e9e" stroke-width="2"/>`,
);
writePlaceholder(
  'oscillator',
  64,
  56,
  `  <rect x="4" y="4" width="56" height="36" rx="4" fill="#5c6bc0"/>
  <text x="32" y="26" text-anchor="middle" fill="#eceff1" font-size="11">OSC</text>
  <line x1="14" y1="40" x2="14" y2="48" stroke="#9e9e9e" stroke-width="2"/>
  <line x1="50" y1="40" x2="50" y2="48" stroke="#9e9e9e" stroke-width="2"/>`,
);

console.log(`\nDone. Parts in ${outDir}`);

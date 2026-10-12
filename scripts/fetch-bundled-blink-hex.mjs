/**
 * What: Regenerates the `BLINK_DEFAULT_HEX` line in `src/avr/firmware.ts` by POSTing the default
 * ATmega328P blink sketch to Wokwi Hexi (`hexi.wokwi.com/build`), for the simulator’s preloaded
 * Uno/Nano blink firmware without a local Arduino toolchain.
 * How-to: `npm run fetch-bundled-blink` or `node scripts/fetch-bundled-blink-hex.mjs` from repo root
 * (requires internet). Edit the `sketch` template string in this file to change default firmware, then re-run;
 * only the one-line `export const BLINK_DEFAULT_HEX = …;` in `firmware.ts` is replaced. Non-zero exit on
 * HTTP errors, missing hex in the JSON response, or if that line is missing.
 *
 * Changelog:
 * - 09-10-2026 — Writes into `src/avr/firmware.ts` (blinkDefaultHex.ts merged there)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sketch = `// Blink — built-in LED on pin 13 (Uno/Nano)
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("ON");
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("OFF");
  delay(500);
}`;

const resp = await fetch('https://hexi.wokwi.com/build', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sketch }),
});

if (!resp.ok) {
  console.error('HTTP', resp.status);
  process.exit(1);
}

const { hex, stderr } = await resp.json();
if (!hex) {
  console.error('No hex:', stderr);
  process.exit(1);
}

const outPath = join(__dirname, '../src/avr/firmware.ts');
const src = readFileSync(outPath, 'utf8');
const line = /^export const BLINK_DEFAULT_HEX = .*;$/m;
if (!line.test(src)) {
  console.error('No `export const BLINK_DEFAULT_HEX = …;` line in', outPath);
  process.exit(1);
}
writeFileSync(outPath, src.replace(line, () => `export const BLINK_DEFAULT_HEX = ${JSON.stringify(hex)};`), 'utf8');
console.log('Updated', outPath, `(${hex.length} chars)`);

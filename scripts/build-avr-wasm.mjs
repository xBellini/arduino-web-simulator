/**
 * What: Build AssemblyScript AVR WASM helpers (`src/avr/pacer/avr-pacer.ts`) into
 * `public/avr/avr-pacer.wasm`, which the AVR worker fetches. Run: `npm run build:avr-wasm`.
 *
# Changelog
# Date       | Author | Remarks
# 09-10-2026 | Cursor | Source moved from `assembly/` to `src/avr/pacer/`; added header
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'avr');
mkdirSync(outDir, { recursive: true });

const asc = join(root, 'node_modules', 'assemblyscript', 'bin', 'asc');
const result = spawnSync(
  process.execPath,
  [
    asc,
    join(root, 'src', 'avr', 'pacer', 'avr-pacer.ts'),
    '-o',
    join(outDir, 'avr-pacer.wasm'),
    '--optimize',
    '--exportRuntime',
  ],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log('Wrote public/avr/avr-pacer.wasm');

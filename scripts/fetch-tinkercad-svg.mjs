/**
 * What: Downloads a TinkerCAD Circuits packaged device JSON by footprint id (or reads `--file`),
 * extracts the breadboard SVG payload, optionally normalizes via external tools, and writes
 * reference SVGs under `scripts/reference/` for geometry pipelines and `export-components-svg.mjs`.
 * How-to: `node scripts/fetch-tinkercad-svg.mjs <numericFootprintId>` saves to
 * `scripts/reference/tinkercad-<id>.svg` by default; add `--out path/to/custom.svg` to override.
 * Import a local export with `node scripts/fetch-tinkercad-svg.mjs --file path/to/device.json`.
 * After fetching, run `generate-*-geometry.mjs`, `svg-to-geometry.mjs`, or `npm run export-components-svg`
 * as needed; pair Uno parts with a terminals JSON when the footprint provides one.
 *
 * Changelog:
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ASSET_BASE = 'https://editor.tinkercad.com/assets_30ucufg/js/packaged_devices';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(
    `Usage: node scripts/fetch-tinkercad-svg.mjs <footprintId> [--out path.svg]\n` +
      `       node scripts/fetch-tinkercad-svg.mjs --file <device.json> [--out path.svg]`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
const localFile = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
const footprintId = args.find((a) => !a.startsWith('--') && a !== localFile);
const outIdx = args.indexOf('--out');

/** Slug for default output filename when importing a local file. */
function localFileSlug(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

const defaultOut = localFile
  ? path.join(root, 'scripts', 'reference', `tinkercad-${localFileSlug(localFile)}.svg`)
  : path.join(root, 'scripts', 'reference', `tinkercad-${footprintId}.svg`);
const outPath = outIdx >= 0 ? path.resolve(root, args[outIdx + 1] ?? '') : defaultOut;

if (!localFile && (!footprintId || !/^\d+$/.test(footprintId))) {
  usage();
}

function cleanBreadboardSvg(svg) {
  return svg
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<path class="cgfx__selected"[\s\S]*?\/>/g, '')
    .replace(/<line class="cgfx__selected"[\s\S]*?\/>/g, '')
    .replace(/<rect class="cgfx__selected"[\s\S]*?\/>/g, '')
    .replace(/<path class="cgfx__hitarea"[\s\S]*?\/>/g, '')
    .replace(/<line class="cgfx__hitarea"[\s\S]*?\/>/g, '')
    .replace(/<polygon class="cgfx__hitarea"[\s\S]*?\/>/g, '')
    .replace(/<circle class="cgfx__[^"]*hitarea[^"]*"[\s\S]*?\/>/g, '')
    .replace(/<polygon class="cgfx__breakdown"[\s\S]*?\/>/g, '')
    .replace(/<line class="cgfx__origin[\s\S]*?\/>/g, '')
    .replace(/ display="none"/g, '')
    .trim();
}

async function fetchDeviceJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return res.json();
  } catch (err) {
    const tmp = path.join(root, 'scripts', '.tmp-tinkercad-device.json');
    if (process.platform === 'win32') {
      const psExe = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const psCmd = `Invoke-WebRequest -Uri '${url}' -OutFile '${tmp.replace(/'/g, "''")}' -UseBasicParsing`;
      const ps = spawnSync(psExe, ['-NoProfile', '-Command', psCmd], {
        encoding: 'utf8',
      });
      if (ps.status !== 0) {
        throw new Error(
          `fetch and PowerShell failed: ${ps.stderr || (err instanceof Error ? err.message : err)}`,
        );
      }
    } else {
      const curl = spawnSync('curl', ['-sL', url, '-o', tmp], { encoding: 'utf8' });
      if (curl.status !== 0) {
        throw new Error(`fetch and curl failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    const json = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    fs.unlinkSync(tmp);
    return json;
  }
}

const deviceUrl = localFile ? path.resolve(localFile) : `${ASSET_BASE}/${footprintId}.json`;
let device;
if (localFile) {
  try {
    device = JSON.parse(fs.readFileSync(deviceUrl, 'utf8'));
  } catch (err) {
    console.error(`Failed to read ${deviceUrl}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
} else {
  try {
    device = await fetchDeviceJson(deviceUrl);
  } catch (err) {
    console.error(`Failed to fetch ${deviceUrl}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
const breadboard = device.device?.breadboard;
if (!breadboard?.svg) {
  console.error('No breadboard SVG found in device JSON');
  process.exit(1);
}

const inner = cleanBreadboardSvg(breadboard.svg);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1000 -1000 2000 2000">\n${inner}\n</svg>`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, svg);

const terminals = breadboard.schematic_symbol_terminals_attributes ?? [];
const meta = {
  footprintId: footprintId ? Number(footprintId) : (device.footprint_id ?? null),
  footprintName: device.footprint_name ?? device.device?.name ?? device.name ?? null,
  source: deviceUrl,
  svgOut: path.relative(root, outPath),
  terminals: terminals.map((t) => ({
    name: t.name,
    x: t.x,
    y: t.y,
    dir: t.dir,
  })),
};

const metaPath = outPath.replace(/\.svg$/i, '.json');
fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

console.log(`Saved ${path.relative(root, outPath)}`);
console.log(`Saved ${path.relative(root, metaPath)}`);
console.log(`Device: ${meta.footprintName ?? footprintId}`);
if (terminals.length) {
  console.log('Terminals:', terminals.map((t) => `${t.name} (${t.x}, ${t.y})`).join(', '));
}

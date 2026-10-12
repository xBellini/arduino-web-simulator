/**
 * What: Crops raw TinkerCAD breadboard SVGs into footprint-sized `public/components/*.svg`
 * (Inkscape-style translate into a tight viewBox, same pattern as DIP/MOSFET parts).
 * How-to: fetch with `node scripts/fetch-tinkercad-svg.mjs <id> --out scripts/reference/...`,
 * then `node scripts/crop-tinkercad-components.mjs`. Artwork only — no SPICE/sim logic.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `scripts/crop-tinkercad-parts.mjs` (tree reorganization)
 * - 28-09-2026 — Keypad 4×4 + LDR crops; renamed from crop-relay-svgs.mjs
 * - 28-09-2026 — SPDT (62×42) + DPDT (80×40) crops from TinkerCAD DIL12/DIL16
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{
 *   type: string;
 *   src: string;
 *   w: number;
 *   h: number;
 *   originX?: number;
 *   originY?: number;
 *   clean?: (inner: string) => string;
 * }} CropJob
 *
 * originX/originY: TinkerCAD point that should sit at the footprint center (default 0,0).
 */

/** @type {CropJob[]} */
const JOBS = [
  // Body ~59×40 centered at origin; terminals x±25 y±15
  { type: 'relay_spdt', src: 'scripts/reference/tinkercad-relay-spdt.svg', w: 62, h: 42 },
  // Body ~76.5×36.5; terminals x±35 y±15
  { type: 'relay_dpdt', src: 'scripts/reference/tinkercad-relay-dpdt.svg', w: 80, h: 40 },
  // Full keypad face is in translate(0,-227); header pins at y=0. Body ±137 × ±150.
  {
    type: 'keypad_4x4',
    src: 'scripts/reference/tinkercad-keypad-4x4.svg',
    w: 280,
    h: 390,
    originX: 0,
    originY: -186,
  },
  // Breadboard view-wires only: sensor ~ (0,-17), legs at (±5,0)
  {
    type: 'ldr',
    src: 'scripts/reference/tinkercad-ldr.svg',
    w: 26,
    h: 30,
    originX: 0,
    originY: -13,
    clean: cleanLdr,
  },
];

function stripOuterSvg(svg) {
  return svg
    .replace(/^[\s\S]*?<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .trim();
}

/** Keep LDR breadboard legs+body; drop top-view, brightness slider, hitareas. */
function cleanLdr(inner) {
  const wires = inner.match(
    /<g class="cgfx__view-wires"[^>]*>[\s\S]*?<\/g>/i,
  )?.[0];
  if (!wires) return inner;
  return wires
    .replace(/<ellipse class="cgfx__selected"[\s\S]*?\/>/gi, '')
    .replace(/<[^>]*class="cgfx__hitarea[^"]*"[\s\S]*?\/>/gi, '')
    .replace(/\sdisplay="[^"]*"/gi, '');
}

for (const job of JOBS) {
  const raw = fs.readFileSync(path.join(root, job.src), 'utf8');
  let inner = stripOuterSvg(raw);
  if (job.clean) inner = job.clean(inner);
  const ox = job.originX ?? 0;
  const oy = job.originY ?? 0;
  // Place TinkerCAD (ox,oy) at the center of the footprint window.
  const tx = -1000 + job.w / 2 - ox;
  const ty = -1000 + job.h / 2 - oy;
  const out = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1000 -1000 ${job.w} ${job.h}" width="${job.w}" height="${job.h}">
  <g transform="translate(${tx},${ty})">
${inner}
  </g>
</svg>
`;
  const dest = path.join(root, 'public', 'parts', `${job.type}.svg`);
  fs.writeFileSync(dest, out);
  console.log(
    `wrote ${path.relative(root, dest)} (${job.w}×${job.h}, origin ${ox},${oy} → translate ${tx},${ty})`,
  );
}

/**
 * What: One-shot build script that generates `src/registry/arduinoUnoGeometry.ts` from the
 * TinkerCAD Uno reference SVG (`scripts/reference/tinkercad-132521-uno.svg`) and terminal
 * JSON. Invokes `svg-to-geometry.mjs` with tuned origin/scale, auto-shifts the model when
 * hit bounds clip left/top (USB and power jack), merges terminal coordinates from the reference
 * package, and emits typed path constants plus pin/terminal maps for canvas hit-testing and wiring.
 * How-to: from repo root run `node scripts/generate-uno-geometry.mjs` after refreshing the reference
 * SVG/JSON (e.g. via `fetch-tinkercad-svg.mjs`); output is overwritten at `src/registry/arduinoUnoGeometry.ts`.
 * Tune `BASE_ORIGIN_X`, `BASE_ORIGIN_Y`, or `SCALE` near the top if pins or the board outline drift;
 * terminal labels come from `scripts/reference/tinkercad-132521-uno.json` — edit that file or the slug
 * logic here if a pin rename breaks TypeScript keys. Prefer this script over calling `svg-to-geometry.mjs`
 * directly so the two-pass origin correction and pin merge stay in sync.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = path.join(root, 'scripts/reference/tinkercad-132521-uno.svg');
const terminalsPath = path.join(root, 'scripts/reference/tinkercad-132521-uno.json');
const outFile = path.join(root, 'src/registry/arduinoUnoGeometry.ts');

const BASE_ORIGIN_X = 146;
const BASE_ORIGIN_Y = 105;
const SCALE = 1;

function loadModel(originX, originY) {
  return JSON.parse(
    execSync(
      `node scripts/svg-to-geometry.mjs "${svg}" --origin ${originX},${originY} --scale ${SCALE} --rename path0=boardBody --json`,
      { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    ),
  );
}

const pass1 = loadModel(BASE_ORIGIN_X, BASE_ORIGIN_Y);
const offsetX = pass1.hitBounds.x < 0 ? -pass1.hitBounds.x : 0;
const offsetY = pass1.hitBounds.y < 0 ? -pass1.hitBounds.y : 0;
const ORIGIN_X = BASE_ORIGIN_X + offsetX;
const ORIGIN_Y = BASE_ORIGIN_Y + offsetY;
const model = offsetX || offsetY ? loadModel(ORIGIN_X, ORIGIN_Y) : pass1;

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function styleFor(el) {
  const parts = [];
  const fill = el.fill?.trim();
  const stroke = el.stroke?.trim();
  if (fill && fill !== 'none') parts.push(`fill: '${esc(fill)}'`);
  else parts.push("fill: 'none'");
  if (stroke && stroke !== 'none') parts.push(`stroke: '${esc(stroke)}'`);
  if (el.opacity) parts.push(`opacity: ${el.opacity}`);
  return parts.join(', ');
}

const slug = (name) => {
  const base = name
    .replace(/3\.3V/i, 'v33')
    .replace(/^5V$/i, 'v5')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
  return /^\d/.test(base) ? `p_${base}` : base;
};

const terminals = JSON.parse(fs.readFileSync(terminalsPath, 'utf8')).terminals;
const seen = {};
const pinLines = [];
for (const p of terminals) {
  let key = slug(p.name);
  if (seen[key]) key = `${key}${seen[key]++}`;
  else seen[key] = 2;
  const x = Math.round((ORIGIN_X + p.x * SCALE) * 10) / 10;
  const y = Math.round((ORIGIN_Y + p.y * SCALE) * 10) / 10;
  pinLines.push(`  ${key}: { x: ${x}, y: ${y}, label: '${esc(p.name)}' },`);
}

const hit = model.hitBounds;
const footprintW = Math.ceil(hit.x + hit.width);
const footprintH = Math.ceil(hit.y + hit.height);

const lines = [];
lines.push('/**');
lines.push(' * Arduino Uno R3 — SVG paths in footprint space (TinkerCAD 132521).');
lines.push(' * Group transforms flattened; terminals at (origin + tcX, origin + tcY).');
lines.push(` * Origin (${ORIGIN_X.toFixed(2)}, ${ORIGIN_Y}) after left-edge normalize (+${offsetX.toFixed(2)}).`);
lines.push(' */');
lines.push('');

lines.push('export const ARDUINO_UNO_PATHS = {');
for (const [key, p] of Object.entries(model.paths)) {
  lines.push(`  ${key}: '${esc(p.d)}',`);
}
lines.push('} as const;');
lines.push('');

lines.push('export const ARDUINO_UNO_PATH_STYLES = {');
for (const [key, p] of Object.entries(model.paths)) {
  lines.push(`  ${key}: { ${styleFor(p)} },`);
}
lines.push('} as const;');
lines.push('');

if (model.rectList?.length) {
  lines.push('export const ARDUINO_UNO_RECTS = {');
  for (const r of model.rectList) {
    lines.push(
      `  ${r.key}: { x: ${r.x}, y: ${r.y}, width: ${r.width}, height: ${r.height}, rx: ${r.rx} },`,
    );
  }
  lines.push('} as const;');
  lines.push('');

  lines.push('export const ARDUINO_UNO_RECT_STYLES = {');
  for (const r of model.rectList) {
    lines.push(`  ${r.key}: { ${styleFor(r)} },`);
  }
  lines.push('} as const;');
  lines.push('');
}

if (model.circleList?.length) {
  lines.push('export const ARDUINO_UNO_CIRCLES = {');
  for (const c of model.circleList) {
    lines.push(`  ${c.key}: { cx: ${c.cx}, cy: ${c.cy}, r: ${c.r} },`);
  }
  lines.push('} as const;');
  lines.push('');

  lines.push('export const ARDUINO_UNO_CIRCLE_STYLES = {');
  for (const c of model.circleList) {
    lines.push(`  ${c.key}: { ${styleFor(c)} },`);
  }
  lines.push('} as const;');
  lines.push('');
}

if (model.lineList?.length) {
  lines.push('export const ARDUINO_UNO_LINES = {');
  for (const l of model.lineList) {
    lines.push(`  ${l.key}: { x1: ${l.x1}, y1: ${l.y1}, x2: ${l.x2}, y2: ${l.y2} },`);
  }
  lines.push('} as const;');
  lines.push('');

  lines.push('export const ARDUINO_UNO_LINE_STYLES = {');
  for (const l of model.lineList) {
    const stroke = l.stroke?.trim();
    const parts = ["fill: 'none'"];
    if (stroke && stroke !== 'none') parts.push(`stroke: '${esc(stroke)}'`);
    else parts.push("stroke: '#424242'");
    lines.push(`  ${l.key}: { ${parts.join(', ')} },`);
  }
  lines.push('} as const;');
  lines.push('');
}

lines.push('/** Document-order draw list — preserves TinkerCAD z-order. */');
lines.push('export const ARDUINO_UNO_LAYERS = [');
for (const layer of model.layerList) {
  lines.push(`  { type: '${layer.type}', key: '${layer.key}' },`);
}
lines.push('] as const;');
lines.push('');

lines.push('export const ARDUINO_UNO_PINS = {');
lines.push(...pinLines);
lines.push('} as const;');
lines.push('');

lines.push(
  `export const ARDUINO_UNO_FOOTPRINT = { width: ${footprintW}, height: ${footprintH} } as const;`,
);
lines.push('');
const icBody = model.paths.path5?.d;
if (icBody) {
  const nums = icBody.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]);
    maxX = Math.max(maxX, nums[i]);
    minY = Math.min(minY, nums[i + 1]);
    maxY = Math.max(maxY, nums[i + 1]);
  }
  const icX = Math.round(((minX + maxX) / 2) * 10) / 10;
  const icY = Math.round(((minY + maxY) / 2) * 10) / 10;
  lines.push('/** Centered on traced IC package body (path5). */');
  lines.push('export const ARDUINO_UNO_IC_LABEL = {');
  lines.push("  text: 'ATmega328P',");
  lines.push(`  x: ${icX},`);
  lines.push(`  y: ${icY},`);
  lines.push('  fontSize: 7,');
  lines.push('} as const;');
  lines.push('');
}
lines.push(
  `export const ARDUINO_UNO_BODY_HIT = { x: ${Math.floor(hit.x)}, y: ${Math.floor(hit.y)}, width: ${Math.ceil(hit.width)}, height: ${Math.ceil(hit.height)} } as const;`,
);
lines.push('');

fs.writeFileSync(outFile, `${lines.join('\n')}`);
console.log(`Wrote ${path.relative(root, outFile)}`);
console.log(`  ${model.layerList.length} layers, footprint ${footprintW}×${footprintH}`);
console.log(`  Origin (${ORIGIN_X.toFixed(2)}, ${ORIGIN_Y}), normalize +${offsetX.toFixed(2)} x`);

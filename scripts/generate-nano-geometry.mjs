/**
 * What: Generates `src/registry/arduinoNanoGeometry.ts` from `scripts/reference/arduino-nano-title-image.svg`
 * by embedding raw `<path>` elements (skipping the baked MCU label path), computing pin circles from
 * pitch and label order for top/bottom headers, and exporting viewBox dimensions plus a separate IC
 * label position for canvas rendering and wiring hit targets.
 * How-to: from repo root run `node scripts/generate-nano-geometry.mjs` after updating
 * `scripts/reference/arduino-nano-title-image.svg`; overwrites `src/registry/arduinoNanoGeometry.ts`.
 * Adjust `TOP_PIN_LABELS` / `BOTTOM_PIN_LABELS`, `PIN_PITCH`, `TOP_ROW_Y_NUDGE`, or `NANO_SVG_SKIP_PATH_INDEX`
 * if a new SVG changes path order or header layout; tune `IC_LABEL_X` / `IC_LABEL_Y` for the on-chip text overlay.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(root, 'scripts/reference/arduino-nano-title-image.svg');
const outFile = path.join(root, 'src/registry/arduinoNanoGeometry.ts');

const VIEW_W = 450;
const VIEW_H = 250;
const PIN_PITCH = 20.623;
const CIRCLE_R = 5;
/** Fine-tune top header row Y (SVG y↓); traced square center needs a slight upward nudge. */
const TOP_ROW_Y_NUDGE = -10;

/** Left-to-right from top-left / bottom-left (USB on the left). */
const TOP_PIN_LABELS = [
  'VIN', 'GND', 'RST', '5V', 'A7', 'A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0', 'REF', '3.3V', 'D13',
];
const BOTTOM_PIN_LABELS = [
  'TX1', 'RX0', 'RST', 'GND', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12',
];

function extractPathElements(svgText) {
  const re = /<path\b[^>]*\/>/gi;
  return [...svgText.matchAll(re)].map((m) => m[0]);
}

/** IC label position (tuned: slightly right of x=252 to sit on chip center). */
const IC_LABEL_X = 265;
const IC_LABEL_Y = 101.1;

/** Drop baked-in MCU label path; we render ARDUINO_NANO_IC_LABEL separately. */
const NANO_SVG_SKIP_PATH_INDEX = 24;

/** Pin attach points from the pin-header path (path index 20). */
function extractPinCenters(pinPathD) {
  const [bottomPart, topPart = ''] = pinPathD.split(/zm-293\.73-135\.04/);
  if (!bottomPart || !topPart) throw new Error('Pin header rows not found in reference SVG');

  function countCircles(section) {
    const first = section.includes('zm25.623 10a5 5') || section.includes('m25.623 10a5 5') ? 1 : 0;
    const rest = (section.match(/zm20\.623 0a5 5/g) ?? []).length;
    return first + rest;
  }

  function parseBottomSquareCorner(section) {
    const match = section.match(/m(-?\d+\.?\d*) (-?\d+\.?\d*)h10v10h-10/);
    if (!match) throw new Error('Bottom row square not found');
    return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
  }

  /** Trace pen to the top-row square corner (after zm-293.73-135.04). */
  function traceTopSquareCorner(pathD) {
    const tokens = pathD.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
    let i = 0;
    let cmd = '';
    let x = 0;
    let y = 0;
    const read = () => parseFloat(tokens[i++]);

    while (i < tokens.length) {
      const t = tokens[i];
      if (/^[a-zA-Z]$/.test(t)) {
        cmd = tokens[i++];
        if (cmd === 'z' || cmd === 'Z') continue;
      } else if (!cmd) {
        i++;
        continue;
      }

      const upper = cmd.toUpperCase();
      if (upper === 'M') {
        const nx = read();
        const ny = read();
        if (cmd === 'm' && Math.abs(nx + 293.73) < 0.01 && Math.abs(ny + 135.04) < 0.01) {
          x += nx;
          y += ny;
          return { x, y };
        }
        x = cmd === 'm' ? x + nx : nx;
        y = cmd === 'm' ? y + ny : ny;
      } else if (upper === 'H') {
        x = cmd === 'h' ? x + read() : read();
      } else if (upper === 'V') {
        y = cmd === 'v' ? y + read() : read();
      } else if (upper === 'A') {
        read();
        read();
        read();
        read();
        read();
        const dx = read();
        const dy = read();
        x = cmd === 'a' ? x + dx : dx;
        y = cmd === 'a' ? y + dy : dy;
      } else {
        while (i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) i++;
      }
    }
    throw new Error('Top row square corner not found in pin path');
  }

  function buildCircleRow(squareX, squareY, circleY, firstCircleX, section) {
    const circleCount = countCircles(section);
    if (circleCount !== 14) throw new Error(`Expected 14 circles per row, got ${circleCount}`);

    const pts = [{ x: squareX, y: Math.round(squareY * 1000) / 1000 }];
    for (let i = 0; i < circleCount; i++) {
      pts.push({
        x: Math.round((firstCircleX + i * PIN_PITCH) * 1000) / 1000,
        y: Math.round(circleY * 1000) / 1000,
      });
    }
    return pts;
  }

  const bottomCorner = parseBottomSquareCorner(bottomPart);
  const bottomSquareX = bottomCorner.x + CIRCLE_R;
  const bottomSquareY = bottomCorner.y + CIRCLE_R;
  const bottomFirstCircleX = bottomCorner.x + 25.623;
  const bottom = buildCircleRow(
    bottomSquareX,
    bottomSquareY,
    bottomSquareY,
    bottomFirstCircleX,
    bottomPart,
  );

  const topCorner = traceTopSquareCorner(pinPathD);
  const topSquareX = topCorner.x + CIRCLE_R;
  const topSquareY = topCorner.y + CIRCLE_R + TOP_ROW_Y_NUDGE;
  const topFirstCircleX = topCorner.x + 25.623;
  const top = buildCircleRow(
    topSquareX,
    topSquareY,
    topSquareY,
    topFirstCircleX,
    topPart,
  );

  return { top, bottom };
}

function slug(name) {
  const base = name
    .replace(/3\.3V/i, 'v33')
    .replace(/^5V$/i, 'v5')
    .replace(/^REF$/i, 'aref')
    .replace(/^TX1$/i, 'd1')
    .replace(/^RX0$/i, 'd0')
    .replace(/^RST$/i, 'reset')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
  return /^\d/.test(base) ? `p_${base}` : base;
}

const svgText = fs.readFileSync(svgPath, 'utf8');
const pathEls = extractPathElements(svgText);
const pinPathMatch = pathEls[20]?.match(/d="([^"]+)"/);
if (!pinPathMatch) throw new Error('Pin header path not found at index 20');
const { top, bottom } = extractPinCenters(pinPathMatch[1]);

const seen = {};
const pinLines = [];
function addPin(label, pt) {
  let key = slug(label);
  if (seen[key]) key = `${key}${seen[key]++}`;
  else seen[key] = 2;
  pinLines.push(
    `  ${key}: { x: ${Math.round(pt.x * 10) / 10}, y: ${Math.round(pt.y * 10) / 10}, label: '${label.replace(/'/g, "\\'")}' },`,
  );
}
for (let i = 0; i < 15; i++) addPin(TOP_PIN_LABELS[i], top[i]);
for (let i = 0; i < 15; i++) addPin(BOTTOM_PIN_LABELS[i], bottom[i]);

const svgInner = pathEls
  .filter((_, i) => i !== NANO_SVG_SKIP_PATH_INDEX)
  .join('\n    ');
const icLabel = { x: IC_LABEL_X, y: IC_LABEL_Y };

const lines = [];
lines.push('/**');
lines.push(' * Arduino Nano — reference SVG embedded verbatim (450×250 viewBox).');
lines.push(' * Source: datacapturecontrol.com arduino-nano-title-image.svg');
lines.push(' */');
lines.push('');
lines.push(`export const ARDUINO_NANO_FOOTPRINT = { width: ${VIEW_W}, height: ${VIEW_H} } as const;`);
lines.push('');
lines.push('export const ARDUINO_NANO_BODY_HIT = { x: 46, y: 30, width: 346, height: 143 } as const;');
lines.push('');
lines.push('/** Raw <path/> elements from reference SVG, document order. */');
lines.push('export const ARDUINO_NANO_SVG_INNER = String.raw`');
lines.push(`    ${svgInner}`);
lines.push('`;');
lines.push('');
lines.push('export const ARDUINO_NANO_IC_LABEL = {');
lines.push("  text: 'ATmega328P',");
lines.push(`  x: ${icLabel.x},`);
lines.push(`  y: ${icLabel.y},`);
lines.push('  fontSize: 6,');
lines.push('} as const;');
lines.push('');
lines.push('export const ARDUINO_NANO_PINS = {');
lines.push(...pinLines);
lines.push('} as const;');
lines.push('');

fs.writeFileSync(outFile, `${lines.join('\n')}`);
console.log(`Wrote ${path.relative(root, outFile)}`);
console.log(`  ${pathEls.length} SVG paths, footprint ${VIEW_W}×${VIEW_H}, ${pinLines.length} pins`);
console.log('  bottom TX1', bottom[14], 'top VIN', top[14]);

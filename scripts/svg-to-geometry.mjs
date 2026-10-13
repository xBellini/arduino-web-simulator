/**
 * What: CLI utility that parses reference SVGs (especially TinkerCAD breadboard exports) into
 * TypeScript modules of raw SVG path strings and bounds metadata for the simulator canvas. Supports
 * explicit `--origin`/`--scale` or repeatable `--map` anchor pairs, optional layer cleaning,
 * group filtering, path renaming, JSON stdout for downstream scripts, and writes prefixed exports
 * (e.g. `BUTTON_PATHS`) to `--out` or prints to stdout.
 * How-to: `node scripts/svg-to-geometry.mjs --help` lists all flags; run from repo root. Example —
 * `node scripts/svg-to-geometry.mjs scripts/reference/tinkercad-144786.svg --prefix BUTTON --name button
 * --out src/registry/buttonGeometry.ts`. Use `--json` when a wrapper script (e.g. `generate-uno-geometry.mjs`)
 * needs bounds without writing a `.ts` file. Add `--rename path0=boardBody` to stabilize export keys;
 * `--exclude-fill` / `--only-group` trim TinkerCAD debug layers (on by default unless `--no-clean`).
 * Without `--out`, geometry prints to stdout (redirect to a file if needed).
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

function usage() {
  console.log(`Usage: node scripts/svg-to-geometry.mjs <input.svg> [options]

Options:
  --origin cx,cy --scale n     Explicit translate + scale transform
  --map sx,sy=dx,dy            Anchor map (repeatable; computes uniform scale + origin)
  --out path.ts                Output TypeScript file (default: stdout)
  --prefix NAME                Export prefix, e.g. BUTTON -> BUTTON_PATHS (default: GEOM)
  --name label                 Source part name for file header comment
  --only-group classSubstring  Only trace inside the first matching <g>
  --exclude-class a,b          Extra class names to exclude
  --exclude-fill #hex,#hex     Drop elements whose fill matches (e.g. body text)
  --rename oldKey=newName      Rename a generated key (repeatable)
  --no-clean                   Do not strip TinkerCAD debug/hit layers
  --no-flatten                 Skip baking nested <g transform> groups
  --json                       Print JSON to stdout instead of TypeScript
`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) usage();

const inputPath = args.find((a) => !a.startsWith('--') && a.endsWith('.svg'));
if (!inputPath) usage();

const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const hasFlag = (flag) => args.includes(flag);
const outPath = getArg('--out');
const prefix = (getArg('--prefix') ?? 'GEOM').toUpperCase();
const partName = getArg('--name') ?? path.basename(inputPath, '.svg');
const onlyGroup = getArg('--only-group');
const extraExclude = (getArg('--exclude-class') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** Fills to drop (e.g. in-body silkscreen text) — matched case-insensitively. */
const excludeFills = new Set(
  (getArg('--exclude-fill') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const jsonOut = hasFlag('--json');
const cleanSvg = !hasFlag('--no-clean');
const flattenGroups = !hasFlag('--no-flatten');

const renameMap = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--rename' && args[i + 1]) {
    const eq = args[i + 1].indexOf('=');
    if (eq > 0) renameMap[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
  }
}

const originArg = getArg('--origin');
const scaleArg = getArg('--scale');
const mapArgs = args.filter((a) => a.startsWith('--map ')).map((a) => a.slice(6));
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--map' && args[i + 1]) mapArgs.push(args[i + 1]);
}

function parsePair(text) {
  const [a, b] = text.split(',').map((n) => parseFloat(n.trim()));
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`Invalid coordinate pair: ${text}`);
  }
  return { x: a, y: b };
}

function parseMap(text) {
  const eq = text.indexOf('=');
  if (eq < 0) throw new Error(`Invalid --map (expected sx,sy=dx,dy): ${text}`);
  const src = parsePair(text.slice(0, eq));
  const dst = parsePair(text.slice(eq + 1));
  return { sx: src.x, sy: src.y, dx: dst.x, dy: dst.y };
}

function average(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fitTransformFromMaps(maps) {
  if (maps.length < 2) {
    throw new Error('--map requires at least two anchor pairs');
  }
  const scales = [];
  for (let i = 0; i < maps.length; i++) {
    for (let j = i + 1; j < maps.length; j++) {
      const a = maps[i];
      const b = maps[j];
      const dsx = b.sx - a.sx;
      const dsy = b.sy - a.sy;
      const ddx = b.dx - a.dx;
      const ddy = b.dy - a.dy;
      if (Math.abs(dsx) > 1e-6) scales.push(ddx / dsx);
      if (Math.abs(dsy) > 1e-6) scales.push(ddy / dsy);
    }
  }
  if (scales.length === 0) throw new Error('Could not infer scale from --map pairs');
  const scale = average(scales);
  const spread = Math.max(...scales) - Math.min(...scales);
  if (spread > 0.01) {
    console.warn(
      `Warning: non-uniform scale inferred (spread ${spread.toFixed(4)}). Using average ${scale.toFixed(4)}.`,
    );
  }
  const cx = average(maps.map((m) => m.dx - m.sx * scale));
  const cy = average(maps.map((m) => m.dy - m.sy * scale));
  return { cx, cy, scale, mode: 'map' };
}

function resolveTransform() {
  const maps = mapArgs.map(parseMap);
  if (originArg && scaleArg) {
    const { x: cx, y: cy } = parsePair(originArg);
    const scale = parseFloat(scaleArg);
    if (!Number.isFinite(scale)) throw new Error(`Invalid --scale: ${scaleArg}`);
    return { cx, cy, scale, mode: 'origin' };
  }
  if (maps.length > 0) return fitTransformFromMaps(maps);
  throw new Error('Provide --origin cx,cy --scale n and/or at least two --map sx,sy=dx,dy pairs');
}

const transform = resolveTransform();
const tx = (x) => transform.cx + x * transform.scale;
const ty = (y) => transform.cy + y * transform.scale;
const tr = (r) => r * transform.scale;

function fmt(n) {
  return Number(n.toFixed(2)).toString();
}

function cleanReferenceSvg(svg) {
  if (!cleanSvg) return svg;
  return svg
    .replace(/^[\s\S]*?<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .replace(/<path class="cgfx__selected"[\s\S]*?\/>/gi, '')
    .replace(/<line class="cgfx__selected"[\s\S]*?\/>/gi, '')
    .replace(/<rect class="cgfx__selected"[\s\S]*?\/>/gi, '')
    .replace(/<path class="cgfx__hitarea"[\s\S]*?\/>/gi, '')
    .replace(/<line class="cgfx__hitarea"[\s\S]*?\/>/gi, '')
    .replace(/<polygon class="cgfx__hitarea"[\s\S]*?\/>/gi, '')
    .replace(/<circle class="cgfx__[^"]*hitarea[^"]*"[\s\S]*?\/>/gi, '')
    .replace(/<polygon class="cgfx__breakdown"[\s\S]*?\/>/gi, '')
    .replace(/<line class="cgfx__origin[\s\S]*?\/>/gi, '')
    .replace(/<g class="cgfx__terminal"[\s\S]*?<\/g>/gi, '')
    .replace(/<g class="cgfx__pressed"[\s\S]*?<\/g>/gi, '')
    .replace(/ display="none"/gi, '')
    .trim();
}

function extractGroup(svg, classNeedle) {
  const re = new RegExp(
    `<g\\s+[^>]*class="[^"]*${classNeedle}[^"]*"[^>]*>([\\s\\S]*?)<\\/g>`,
    'i',
  );
  const m = svg.match(re);
  if (!m) throw new Error(`Group not found: ${classNeedle}`);
  return m[1];
}

function parseAttrs(tag) {
  const attrs = {};
  // Handle double-quoted, single-quoted, and unquoted attribute values
  // (TinkerCAD SVGs mix all three, e.g. style='…' and r=3).
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    attrs[m[1]] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  const style = attrs.style ?? '';
  for (const part of style.split(';')) {
    const [k, v] = part.split(':').map((s) => s.trim());
    if (k && v) attrs[k] = v;
  }
  return attrs;
}

// --- SVG group transform flattening (TinkerCAD nests USB, headers, reset, etc.) ---

function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrix(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function applyMatrix(m, x, y) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

function matrixFromTransform(transformStr) {
  if (!transformStr?.trim()) return identityMatrix();
  let m = identityMatrix();
  const re = /(matrix|translate|rotate|scale)\s*\(([^)]*)\)/gi;
  let match;
  while ((match = re.exec(transformStr))) {
    const nums = match[2]
      .split(/[\s,]+/)
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n));
    const kind = match[1].toLowerCase();
    let op = identityMatrix();
    if (kind === 'matrix' && nums.length >= 6) {
      op = { a: nums[0], b: nums[1], c: nums[2], d: nums[3], e: nums[4], f: nums[5] };
    } else if (kind === 'translate') {
      op.e = nums[0] ?? 0;
      op.f = nums[1] ?? 0;
    } else if (kind === 'rotate') {
      const deg = nums[0] ?? 0;
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      op = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      if (nums.length >= 3) {
        const cx = nums[1];
        const cy = nums[2];
        const t1 = { a: 1, b: 0, c: 0, d: 1, e: cx, f: cy };
        const t2 = { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy };
        op = multiplyMatrix(multiplyMatrix(t1, op), t2);
      }
    } else if (kind === 'scale') {
      op.a = nums[0] ?? 1;
      op.d = nums.length >= 2 ? nums[1] : op.a;
    }
    m = multiplyMatrix(m, op);
  }
  return m;
}

function matrixScale(m) {
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  return (sx + sy) / 2;
}

/** Sample an SVG elliptical arc into polyline points (SVG 1.1 spec). */
function svgArcToPoints(x0, y0, rx, ry, phiDeg, largeArc, sweep, x1, y1, segments = 10) {
  if (rx === 0 || ry === 0) return [{ x: x1, y: y1 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x0 - x1) / 2;
  const dy = (y0 - y1) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const sq = Math.max(
    0,
    (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) /
      (rx * rx * y1p * y1p + ry * ry * x1p * x1p),
  );
  const coef = sign * Math.sqrt(sq);
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * (-ry * x1p)) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x1) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y1) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = (ux * vx + uy * vy) / Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const pts = [];
  for (let s = 1; s <= segments; s++) {
    const t = theta1 + (dTheta * s) / segments;
    pts.push({
      x: cosPhi * rx * Math.cos(t) - sinPhi * ry * Math.sin(t) + cx,
      y: sinPhi * rx * Math.cos(t) + cosPhi * ry * Math.sin(t) + cy,
    });
  }
  return pts;
}

function applyMatrixToPath(d, m) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let prevCmd = '';
  let lastC2x = 0;
  let lastC2y = 0;
  let lastQ1x = 0;
  let lastQ1y = 0;
  const read = () => parseFloat(tokens[i++]);
  const emit = (x, y) => {
    const p = applyMatrix(m, x, y);
    return `${fmt(p.x)} ${fmt(p.y)}`;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[a-zA-Z]$/.test(t)) cmd = tokens[i++];
    else if (!cmd) {
      i++;
      continue;
    }

    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();

    if (c === 'M' || c === 'L') {
      const x = read();
      const y = read();
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(`${c === 'M' ? 'M' : 'L'} ${emit(nx, ny)}`);
      cx = nx;
      cy = ny;
      if (c === 'M') {
        sx = cx;
        sy = cy;
        // Implicit coordinate pairs after a moveto are linetos.
        cmd = rel ? 'l' : 'L';
      }
      prevCmd = c;
    } else if (c === 'H') {
      const x = read();
      cx = rel ? cx + x : x;
      out.push(`L ${emit(cx, cy)}`);
      prevCmd = c;
    } else if (c === 'V') {
      const y = read();
      cy = rel ? cy + y : y;
      out.push(`L ${emit(cx, cy)}`);
      prevCmd = c;
    } else if (c === 'C') {
      const x1 = read();
      const y1 = read();
      const x2 = read();
      const y2 = read();
      const x = read();
      const y = read();
      const nx1 = rel ? cx + x1 : x1;
      const ny1 = rel ? cy + y1 : y1;
      const nx2 = rel ? cx + x2 : x2;
      const ny2 = rel ? cy + y2 : y2;
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(`C ${emit(nx1, ny1)} ${emit(nx2, ny2)} ${emit(nx, ny)}`);
      lastC2x = nx2;
      lastC2y = ny2;
      cx = nx;
      cy = ny;
      prevCmd = c;
    } else if (c === 'S') {
      const x2 = read();
      const y2 = read();
      const x = read();
      const y = read();
      let nx1 = cx;
      let ny1 = cy;
      if (prevCmd === 'C' || prevCmd === 'S') {
        nx1 = 2 * cx - lastC2x;
        ny1 = 2 * cy - lastC2y;
      }
      const nx2 = rel ? cx + x2 : x2;
      const ny2 = rel ? cy + y2 : y2;
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(`C ${emit(nx1, ny1)} ${emit(nx2, ny2)} ${emit(nx, ny)}`);
      lastC2x = nx2;
      lastC2y = ny2;
      cx = nx;
      cy = ny;
      prevCmd = c;
    } else if (c === 'Q') {
      const x1 = read();
      const y1 = read();
      const x = read();
      const y = read();
      const nx1 = rel ? cx + x1 : x1;
      const ny1 = rel ? cy + y1 : y1;
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(`Q ${emit(nx1, ny1)} ${emit(nx, ny)}`);
      lastQ1x = nx1;
      lastQ1y = ny1;
      cx = nx;
      cy = ny;
      prevCmd = c;
    } else if (c === 'T') {
      const x = read();
      const y = read();
      let nx1 = cx;
      let ny1 = cy;
      if (prevCmd === 'Q' || prevCmd === 'T') {
        nx1 = 2 * cx - lastQ1x;
        ny1 = 2 * cy - lastQ1y;
      }
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(`Q ${emit(nx1, ny1)} ${emit(nx, ny)}`);
      lastQ1x = nx1;
      lastQ1y = ny1;
      cx = nx;
      cy = ny;
      prevCmd = c;
    } else if (c === 'A') {
      const rx = read();
      const ry = read();
      const rot = read();
      const large = !!read();
      const sweep = !!read();
      const x = read();
      const y = read();
      const ex = rel ? cx + x : x;
      const ey = rel ? cy + y : y;
      for (const p of svgArcToPoints(cx, cy, rx, ry, rot, large, sweep, ex, ey)) {
        out.push(`L ${emit(p.x, p.y)}`);
      }
      cx = ex;
      cy = ey;
      prevCmd = c;
    } else if (c === 'Z') {
      out.push('Z');
      cx = sx;
      cy = sy;
      prevCmd = c;
    } else {
      throw new Error(`Unsupported path command during flatten: ${cmd}`);
    }
  }

  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function applyMatrixToPathElement(d, m) {
  // Process the whole path in one pass so chained relative subpaths (m…z m…)
  // keep pen continuity; per-subpath M markers are emitted inline.
  return applyMatrixToPath(d.trim(), m);
}

/** Resolve the effective fill from a `fill` attr or inline `style="fill:..."`. */
function effectiveFill(attrs) {
  let fill = attrs.fill;
  if (!fill && attrs.style) {
    const m = attrs.style.match(/fill\s*:\s*([^;]+)/i);
    if (m) fill = m[1].trim();
  }
  return fill ? fill.toLowerCase() : null;
}

/** Resolve the effective stroke from a `stroke` attr or inline `style="stroke:..."`. */
function effectiveStroke(attrs) {
  let stroke = attrs.stroke;
  if (!stroke && attrs.style) {
    const m = attrs.style.match(/stroke\s*:\s*([^;]+)/i);
    if (m) stroke = m[1].trim();
  }
  return stroke ? stroke.toLowerCase() : null;
}

/** True when an element's fill or stroke is in the --exclude-fill set. */
function matchesExcludedPaint(attrs) {
  if (excludeFills.size === 0) return false;
  const fill = effectiveFill(attrs);
  const stroke = effectiveStroke(attrs);
  return (
    (fill !== null && excludeFills.has(fill)) ||
    (stroke !== null && excludeFills.has(stroke))
  );
}

function shouldExcludeGroup(attrs) {
  const cls = attrs.class ?? '';
  const needles = [
    'selected',
    'hitarea',
    'origin',
    'terminal',
    'terminalname',
    'terminaltype',
    'pressed',
    'breakdown',
    'debug',
    'direction',
    'reference',
    ...extraExclude,
  ];
  if (attrs.display === 'none' || attrs.opacity === '0') return true;
  if (matchesExcludedPaint(attrs)) return true;
  return needles.some((n) => cls.includes(n));
}

function inheritedStyleFromAttrs(attrs) {
  const style = {};
  if (attrs.fill && attrs.fill !== 'none') style.fill = attrs.fill;
  if (attrs.stroke && attrs.stroke !== 'none') style.stroke = attrs.stroke;
  if (attrs.opacity) style.opacity = attrs.opacity;
  return style;
}

function mergeInheritedStyle(attrs, inherited = {}) {
  const own = inheritedStyleFromAttrs(attrs);
  return { ...inherited, ...own };
}

function applyInheritedStyle(attrs, inherited = {}) {
  if (!attrs.fill && inherited.fill) attrs.fill = inherited.fill;
  if (!attrs.stroke && inherited.stroke) attrs.stroke = inherited.stroke;
  if (!attrs.opacity && inherited.opacity) attrs.opacity = inherited.opacity;
  return attrs;
}

function attrsToTag(kind, attrs) {
  const parts = [`<${kind}`];
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== '' && k !== 'transform') parts.push(`${k}="${v}"`);
  }
  return `${parts.join(' ')} />`;
}

function polygonToPath(pointsStr, m) {
  const nums = pointsStr
    .trim()
    .split(/[\s,]+/)
    .map((s) => parseFloat(s))
    .filter((n) => Number.isFinite(n));
  const parts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const p = applyMatrix(m, nums[i], nums[i + 1]);
    parts.push(`${parts.length ? 'L' : 'M'} ${fmt(p.x)} ${fmt(p.y)}`);
  }
  if (parts.length) parts.push('Z');
  return parts.join(' ');
}

function transformLeafTag(kind, rawAttrs, matrix, inherited = {}) {
  const attrs = applyInheritedStyle({ ...rawAttrs }, inherited);
  const local = matrixFromTransform(attrs.transform);
  const m = multiplyMatrix(matrix, local);
  delete attrs.transform;

  if (kind === 'polygon' && rawAttrs.points) {
    attrs.d = polygonToPath(rawAttrs.points, m);
    delete attrs.points;
    return attrsToTag('path', attrs);
  }

  if (kind === 'path' && attrs.d) {
    attrs.d = applyMatrixToPathElement(attrs.d, m);
    return attrsToTag('path', attrs);
  }
  if (kind === 'line') {
    const p1 = applyMatrix(m, parseFloat(attrs.x1), parseFloat(attrs.y1));
    const p2 = applyMatrix(m, parseFloat(attrs.x2), parseFloat(attrs.y2));
    attrs.x1 = fmt(p1.x);
    attrs.y1 = fmt(p1.y);
    attrs.x2 = fmt(p2.x);
    attrs.y2 = fmt(p2.y);
    return attrsToTag('line', attrs);
  }
  if (kind === 'rect') {
    const x = parseFloat(attrs.x);
    const y = parseFloat(attrs.y);
    const w = parseFloat(attrs.width);
    const h = parseFloat(attrs.height);
    const corners = [
      applyMatrix(m, x, y),
      applyMatrix(m, x + w, y),
      applyMatrix(m, x + w, y + h),
      applyMatrix(m, x, y + h),
    ];
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    attrs.x = fmt(Math.min(...xs));
    attrs.y = fmt(Math.min(...ys));
    attrs.width = fmt(Math.max(...xs) - Math.min(...xs));
    attrs.height = fmt(Math.max(...ys) - Math.min(...ys));
    if (attrs.rx) attrs.rx = fmt(parseFloat(attrs.rx) * matrixScale(m));
    return attrsToTag('rect', attrs);
  }
  if (kind === 'circle') {
    const c = applyMatrix(m, parseFloat(attrs.cx), parseFloat(attrs.cy));
    attrs.cx = fmt(c.x);
    attrs.cy = fmt(c.y);
    attrs.r = fmt(parseFloat(attrs.r) * matrixScale(m));
    return attrsToTag('circle', attrs);
  }
  return '';
}

function findMatchingCloseG(svg, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < svg.length) {
    const slice = svg.slice(i);
    if (/^<g[\s>/]/i.test(slice)) {
      depth++;
      i += slice.match(/^<g[\s>/]/i)[0].length;
    } else if (/^<\/g>/i.test(slice)) {
      depth--;
      i += 4;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return svg.length;
}

function flattenSvgGroups(svg, matrix = identityMatrix(), inherited = {}, out = []) {
  let pos = 0;
  while (pos < svg.length) {
    const slice = svg.slice(pos);
    const ws = slice.match(/^\s+/);
    if (ws) {
      pos += ws[0].length;
      continue;
    }

    const gMatch = slice.match(/^<g\s([^>]*)>/i);
    if (gMatch) {
      const attrs = parseAttrs(gMatch[1]);
      const innerStart = pos + gMatch[0].length;
      const innerEnd = findMatchingCloseG(svg, pos);
      if (!shouldExcludeGroup(attrs)) {
        const childMatrix = multiplyMatrix(matrix, matrixFromTransform(attrs.transform));
        const childInherited = mergeInheritedStyle(attrs, inherited);
        flattenSvgGroups(svg.slice(innerStart, innerEnd - 4), childMatrix, childInherited, out);
      }
      pos = innerEnd;
      continue;
    }

    const leafMatch = slice.match(/^<(path|line|rect|circle|polygon)\b([^>]*)\/?>/i);
    if (leafMatch) {
      const kind = leafMatch[1].toLowerCase();
      const attrs = parseAttrs(leafMatch[2]);
      if (!shouldExclude(leafMatch[0], attrs)) {
        const tag = transformLeafTag(kind, attrs, matrix, inherited);
        if (tag) out.push(tag);
      }
      pos += leafMatch[0].length;
      continue;
    }

    const skip = slice.match(/^<[^>]+>/);
    if (skip) {
      pos += skip[0].length;
      continue;
    }
    pos++;
  }
  return out.join('\n');
}

function shouldExclude(tag, attrs) {
  const cls = attrs.class ?? '';
  const defaults = ['selected', 'hitarea', 'origin', 'terminal', 'pressed', 'breakdown', 'debug'];
  const needles = [...defaults, ...extraExclude];
  if (attrs.display === 'none' || attrs.opacity === '0') return true;
  if (matchesExcludedPaint(attrs)) return true;
  return needles.some((n) => cls.includes(n));
}

function slugify(name) {
  return name
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/^./, (c) => c.toLowerCase());
}

function transformPath(d) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let prevCmd = '';
  let lastC2x = 0;
  let lastC2y = 0;
  let lastQ1x = 0;
  let lastQ1y = 0;
  const read = () => parseFloat(tokens[i++]);

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[a-zA-Z]$/.test(t)) cmd = tokens[i++];
    else if (!cmd) {
      i++;
      continue;
    }

    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();

    if (c === 'M' || c === 'L') {
      const x = read();
      const y = read();
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(`${c === 'M' ? 'M' : 'L'} ${fmt(tx(nx))} ${fmt(ty(ny))}`);
      cx = nx;
      cy = ny;
      if (c === 'M') {
        sx = cx;
        sy = cy;
        // Implicit coordinate pairs after a moveto are linetos.
        cmd = rel ? 'l' : 'L';
      }
      prevCmd = c;
    } else if (c === 'H') {
      const x = read();
      cx = rel ? cx + x : x;
      out.push(`L ${fmt(tx(cx))} ${fmt(ty(cy))}`);
      prevCmd = c;
    } else if (c === 'V') {
      const y = read();
      cy = rel ? cy + y : y;
      out.push(`L ${fmt(tx(cx))} ${fmt(ty(cy))}`);
      prevCmd = c;
    } else if (c === 'C') {
      const x1 = read();
      const y1 = read();
      const x2 = read();
      const y2 = read();
      const x = read();
      const y = read();
      const nx1 = rel ? cx + x1 : x1;
      const ny1 = rel ? cy + y1 : y1;
      const nx2 = rel ? cx + x2 : x2;
      const ny2 = rel ? cy + y2 : y2;
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(
        `C ${fmt(tx(nx1))} ${fmt(ty(ny1))} ${fmt(tx(nx2))} ${fmt(ty(ny2))} ${fmt(tx(nx))} ${fmt(ty(ny))}`,
      );
      lastC2x = nx2;
      lastC2y = ny2;
      cx = nx;
      cy = ny;
      prevCmd = c;
    } else if (c === 'S') {
      const x2 = read();
      const y2 = read();
      const x = read();
      const y = read();
      let nx1 = cx;
      let ny1 = cy;
      if (prevCmd === 'C' || prevCmd === 'S') {
        nx1 = 2 * cx - lastC2x;
        ny1 = 2 * cy - lastC2y;
      }
      const nx2 = rel ? cx + x2 : x2;
      const ny2 = rel ? cy + y2 : y2;
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(
        `C ${fmt(tx(nx1))} ${fmt(ty(ny1))} ${fmt(tx(nx2))} ${fmt(ty(ny2))} ${fmt(tx(nx))} ${fmt(ty(ny))}`,
      );
      lastC2x = nx2;
      lastC2y = ny2;
      cx = nx;
      cy = ny;
      prevCmd = c;
    } else if (c === 'Q') {
      const x1 = read();
      const y1 = read();
      const x = read();
      const y = read();
      const nx1 = rel ? cx + x1 : x1;
      const ny1 = rel ? cy + y1 : y1;
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(
        `Q ${fmt(tx(nx1))} ${fmt(ty(ny1))} ${fmt(tx(nx))} ${fmt(ty(ny))}`,
      );
      lastQ1x = nx1;
      lastQ1y = ny1;
      cx = nx;
      cy = ny;
      prevCmd = c;
    } else if (c === 'T') {
      const x = read();
      const y = read();
      let nx1 = cx;
      let ny1 = cy;
      if (prevCmd === 'Q' || prevCmd === 'T') {
        nx1 = 2 * cx - lastQ1x;
        ny1 = 2 * cy - lastQ1y;
      }
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      out.push(
        `Q ${fmt(tx(nx1))} ${fmt(ty(ny1))} ${fmt(tx(nx))} ${fmt(ty(ny))}`,
      );
      lastQ1x = nx1;
      lastQ1y = ny1;
      cx = nx;
      cy = ny;
      prevCmd = c;
    } else if (c === 'A') {
      const rx = read();
      const ry = read();
      const rot = read();
      const large = !!read();
      const sweep = !!read();
      const x = read();
      const y = read();
      const ex = rel ? cx + x : x;
      const ey = rel ? cy + y : y;
      for (const p of svgArcToPoints(cx, cy, rx, ry, rot, large, sweep, ex, ey)) {
        out.push(`L ${fmt(tx(p.x))} ${fmt(ty(p.y))}`);
      }
      cx = ex;
      cy = ey;
      prevCmd = c;
    } else if (c === 'Z') {
      out.push('Z');
      cx = sx;
      cy = sy;
      prevCmd = c;
    } else {
      throw new Error(`Unsupported path command: ${cmd} in ${d.slice(0, 40)}...`);
    }
  }

  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function transformPathElement(d) {
  // Single pass keeps chained relative subpaths (m…z m…) continuous.
  return transformPath(d.trim());
}

function parseElements(svg) {
  const elements = [];
  const tagRe = /<(path|line|rect|circle)\b([^>]*)\/?>/gi;
  let m;
  while ((m = tagRe.exec(svg))) {
    const kind = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    if (shouldExclude(m[0], attrs)) continue;

    const meta = {
      kind,
      class: attrs.class ?? '',
      fill: attrs.fill ?? '',
      opacity: attrs.opacity ?? '',
      stroke: attrs.stroke ?? '',
      strokeWidth: attrs['stroke-width'] ?? '',
    };

    if (kind === 'path' && attrs.d) {
      elements.push({ ...meta, name: 'path', d: transformPathElement(attrs.d) });
    } else if (kind === 'line') {
      elements.push({
        ...meta,
        name: 'line',
        x1: tx(parseFloat(attrs.x1)),
        y1: ty(parseFloat(attrs.y1)),
        x2: tx(parseFloat(attrs.x2)),
        y2: ty(parseFloat(attrs.y2)),
      });
    } else if (kind === 'rect') {
      elements.push({
        ...meta,
        name: 'rect',
        x: tx(parseFloat(attrs.x)),
        y: ty(parseFloat(attrs.y)),
        width: tr(parseFloat(attrs.width)),
        height: tr(parseFloat(attrs.height)),
        rx: attrs.rx ? tr(parseFloat(attrs.rx)) : 0,
      });
    } else if (kind === 'circle') {
      elements.push({
        ...meta,
        name: 'circle',
        cx: tx(parseFloat(attrs.cx)),
        cy: ty(parseFloat(attrs.cy)),
        r: tr(parseFloat(attrs.r)),
      });
    }
  }
  return elements;
}

function boundsFromElements(elements) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const el of elements) {
    if (el.name === 'line') {
      add(el.x1, el.y1);
      add(el.x2, el.y2);
    } else if (el.name === 'rect') {
      add(el.x, el.y);
      add(el.x + el.width, el.y + el.height);
    } else if (el.name === 'circle') {
      add(el.cx - el.r, el.cy - el.r);
      add(el.cx + el.r, el.cy + el.r);
    } else if (el.name === 'path') {
      const nums = el.d.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
      for (let i = 0; i + 1 < nums.length; i += 2) add(nums[i], nums[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function nameFor(el, index, used) {
  const fromClass = el.class
    .split(/\s+/)
    .map((c) => c.replace(/^cgfx__/, ''))
    .find((c) => c && !['switch', 'led', 'up'].includes(c));
  let base = fromClass ? slugify(fromClass) : `${el.name}${index}`;
  if (base === 'basecolor') base = 'body';
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}${n++}`;
  }
  used.add(name);
  return name;
}

function applyRenames(obj) {
  const next = { ...obj };
  for (const [from, to] of Object.entries(renameMap)) {
    if (from in next) {
      next[to] = next[from];
      delete next[from];
    }
  }
  return next;
}

function buildModel(elements) {
  const used = new Set();
  const paths = {};
  const lines = [];
  const rects = [];
  const circles = [];
  const layerList = [];
  let pathIdx = 0;
  let lineIdx = 0;
  let rectIdx = 0;
  let circleIdx = 0;

  for (const el of elements) {
    if (el.name === 'path') {
      const key = nameFor(el, pathIdx++, used);
      paths[key] = {
        d: el.d,
        fill: el.fill,
        opacity: el.opacity,
        stroke: el.stroke,
        strokeWidth: el.strokeWidth,
      };
      layerList.push({ type: 'path', key });
    } else if (el.name === 'line') {
      const key = nameFor(el, lineIdx++, used);
      lines.push({
        key,
        x1: el.x1,
        y1: el.y1,
        x2: el.x2,
        y2: el.y2,
        stroke: el.stroke,
        strokeWidth: el.strokeWidth,
      });
      layerList.push({ type: 'line', key });
    } else if (el.name === 'rect') {
      const key = nameFor(el, rectIdx++, used);
      rects.push({
        key,
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        rx: el.rx,
        fill: el.fill,
        stroke: el.stroke,
        strokeWidth: el.strokeWidth,
      });
      layerList.push({ type: 'rect', key });
    } else if (el.name === 'circle') {
      const key = nameFor(el, circleIdx++, used);
      circles.push({
        key,
        cx: el.cx,
        cy: el.cy,
        r: el.r,
        fill: el.fill,
        opacity: el.opacity,
        stroke: el.stroke,
        strokeWidth: el.strokeWidth,
      });
      layerList.push({ type: 'circle', key });
    }
  }

  const renamedLayers = layerList.map((layer) => ({
    type: layer.type,
    key: renameMap[layer.key] ?? layer.key,
  }));

  return {
    transform,
    paths: applyRenames(paths),
    lines: applyRenames(Object.fromEntries(lines.map((l) => [l.key, l]))),
    lineList: lines.map((l) => ({ ...l, key: renameMap[l.key] ?? l.key })),
    rects: applyRenames(Object.fromEntries(rects.map((r) => [r.key, r]))),
    rectList: rects.map((r) => ({ ...r, key: renameMap[r.key] ?? r.key })),
    circles: applyRenames(Object.fromEntries(circles.map((c) => [c.key, c]))),
    circleList: circles.map((c) => ({ ...c, key: renameMap[c.key] ?? c.key })),
    layerList: renamedLayers,
    hitBounds: boundsFromElements(elements),
    source: path.resolve(inputPath),
  };
}

function esc(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function emitTypeScript(model) {
  const t = model.transform;
  const lines = [];
  lines.push('/**');
  lines.push(` * Auto-generated from reference SVG: ${partName}`);
  lines.push(` * Source: ${model.source}`);
  lines.push(
    ` * Transform: translate(${fmt(t.cx)}, ${fmt(t.cy)}) scale(${fmt(t.scale)})`,
  );
  lines.push(' * Review names, draw order, colors, and pin positions before wiring into the app.');
  lines.push(' */');
  lines.push('');

  const pathKeys = Object.keys(model.paths);
  if (pathKeys.length) {
    lines.push(`export const ${prefix}_PATHS = {`);
    for (const key of pathKeys) {
      lines.push(`  ${key}: '${esc(model.paths[key].d)}',`);
    }
    lines.push('} as const;');
    lines.push('');
  }

  if (model.lines && typeof model.lineList !== 'undefined') {
    const linesArr = model.lineList ?? [];
    if (linesArr.length) {
      lines.push(`export const ${prefix}_LINES = {`);
      for (const line of linesArr) {
        lines.push(
          `  ${line.key}: { x1: ${fmt(line.x1)}, y1: ${fmt(line.y1)}, x2: ${fmt(line.x2)}, y2: ${fmt(line.y2)} },`,
        );
      }
      lines.push('} as const;');
      lines.push('');
    }
  }

  const rectList = model.rectList ?? [];
  if (rectList.length) {
    lines.push(`export const ${prefix}_RECTS = {`);
    for (const rect of rectList) {
      lines.push(
        `  ${rect.key}: { x: ${fmt(rect.x)}, y: ${fmt(rect.y)}, width: ${fmt(rect.width)}, height: ${fmt(rect.height)}, rx: ${fmt(rect.rx)} },`,
      );
    }
    lines.push('} as const;');
    lines.push('');
  }

  const circleList = model.circleList ?? [];
  if (circleList.length) {
    lines.push(`export const ${prefix}_CIRCLES = {`);
    for (const c of circleList) {
      lines.push(
        `  ${c.key}: { cx: ${fmt(c.cx)}, cy: ${fmt(c.cy)}, r: ${fmt(c.r)} },`,
      );
    }
    lines.push('} as const;');
    lines.push('');
  }

  if (model.layerList && model.layerList.length) {
    lines.push(
      `/** Draw order (document order) — iterate to render layers back-to-front. */`,
    );
    lines.push(`export const ${prefix}_LAYERS = [`);
    for (const layer of model.layerList) {
      lines.push(`  { type: '${layer.type}', key: '${layer.key}' },`);
    }
    lines.push('] as const;');
    lines.push('');

    const collectionFor = {
      path: model.paths,
      line: model.lines,
      rect: model.rects,
      circle: model.circles,
    };
    const styleEntries = [];
    for (const layer of model.layerList) {
      const src = collectionFor[layer.type]?.[layer.key] ?? {};
      const style = {};
      if (src.fill !== undefined && src.fill !== '') style.fill = src.fill;
      if (src.stroke !== undefined && src.stroke !== '') style.stroke = src.stroke;
      if (src.opacity !== undefined && src.opacity !== '') {
        const n = Number(src.opacity);
        style.opacity = Number.isFinite(n) ? n : src.opacity;
      }
      if (src.strokeWidth !== undefined && src.strokeWidth !== '') {
        const n = Number(src.strokeWidth);
        style.strokeWidth = Number.isFinite(n) ? n : src.strokeWidth;
      }
      styleEntries.push(`  ${layer.key}: ${JSON.stringify(style)},`);
    }
    lines.push(
      `/** Per-layer presentation pulled from the source SVG (fill/stroke/opacity/strokeWidth). */`,
    );
    lines.push(`export const ${prefix}_STYLES: Record<string, {`);
    lines.push(`  fill?: string; stroke?: string; opacity?: number; strokeWidth?: number;`);
    lines.push(`}> = {`);
    for (const entry of styleEntries) lines.push(entry);
    lines.push('};');
    lines.push('');
  }

  if (model.hitBounds) {
    const b = model.hitBounds;
    lines.push(`export const ${prefix}_HIT_BOUNDS = {`);
    lines.push(`  x: ${fmt(b.x)},`);
    lines.push(`  y: ${fmt(b.y)},`);
    lines.push(`  width: ${fmt(b.width)},`);
    lines.push(`  height: ${fmt(b.height)},`);
    lines.push('} as const;');
    lines.push('');
  }

  const colors = {};
  for (const p of Object.values(model.paths)) if (p.fill) colors[p.fill] = p.fill;
  for (const r of rectList) if (r.fill) colors[r.fill] = r.fill;
  for (const c of circleList) if (c.fill) colors[c.fill] = c.fill;
  if (Object.keys(colors).length) {
    lines.push(`/** Fill colors found in source SVG — map to component palette in ComponentShape. */`);
    lines.push(`export const ${prefix}_SOURCE_COLORS = ${JSON.stringify(colors, null, 2)} as const;`);
    lines.push('');
  }

  return `${lines.join('\n')}`;
}

// --- run ---
let svg = fs.readFileSync(path.resolve(inputPath), 'utf8');
svg = cleanReferenceSvg(svg);
if (onlyGroup) svg = extractGroup(svg, onlyGroup);
if (flattenGroups) svg = flattenSvgGroups(svg);

const elements = parseElements(svg);
if (elements.length === 0) {
  console.error('No traceable elements found after filtering.');
  process.exit(1);
}

const model = buildModel(elements);

if (jsonOut) {
  const out = JSON.stringify(model, null, 2);
  if (outPath) fs.writeFileSync(path.resolve(outPath), `${out}\n`);
  else console.log(out);
} else {
  const ts = emitTypeScript(model);
  if (outPath) {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, ts);
    console.log(`Wrote ${path.relative(root, abs)}`);
    console.log(
      `  ${Object.keys(model.paths).length} paths, ${(model.lineList ?? []).length} lines, ${(model.rectList ?? []).length} rects, ${(model.circleList ?? []).length} circles`,
    );
    console.log(
      `  Transform: origin (${fmt(transform.cx)}, ${fmt(transform.cy)}), scale ${fmt(transform.scale)}`,
    );
  } else {
    console.log(ts);
  }
}

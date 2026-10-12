/**
 * What: Design-space width/height for each part SVG, derived automatically at build time.
 * Role: footprint dimensions for `getDesignDefinition` and default hitboxes — not pin coords.
 * Owns/exports: `getPartFootprint(type)`; internal `FOOTPRINTS` map.
 * Conventions: one file `public/components/<name>.svg` → key `<name>`; size = viewBox third and
 * fourth numbers (`min-x min-y width height` → uses width/height only); invalid/missing
 * viewBox logs a warning and omits the entry; `getPartFootprint` throws if lookup fails.
 * To add a footprint: add `public/components/<type>.svg` with `viewBox="0 0 W H"` (W/H > 0);
 * reference that `<type>` as registry `type` or as `package` for shared shells — no edit here.
 * To fix wrong canvas size: adjust the SVG viewBox (or art bounds), rebuild; registry `scale`
 * multiplies these numbers — do not duplicate width/height in `components.ts`.
 * To debug: check console for `[partFootprints]` warnings when a viewBox is missing/invalid.
 * Not-here: breadboard (uses `breadboardGrid` sizes), palette crops, or pin placement.
 *
 * Changelog:
 * - 17-09-2026 — Removed unused listPartFootprints helper
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

const svgModules = import.meta.glob('../../public/components/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function parseViewBoxSize(svgText: string): { width: number; height: number } | null {
  const match = svgText.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (!match) return null;
  const parts = match[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const width = parts[2];
  const height = parts[3];
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

const FOOTPRINTS: Record<string, { width: number; height: number }> = {};

for (const [path, raw] of Object.entries(svgModules)) {
  const file = path.split('/').pop() ?? '';
  const type = file.replace(/\.svg$/i, '');
  if (!type) continue;
  const size = parseViewBoxSize(raw);
  if (!size) {
    console.warn(`[partFootprints] missing/invalid viewBox in ${file}`);
    continue;
  }
  FOOTPRINTS[type] = size;
}

/** Design-space size from `public/components/<type>.svg` viewBox width/height. */
export function getPartFootprint(type: string): { width: number; height: number } {
  const size = FOOTPRINTS[type];
  if (!size) {
    throw new Error(
      `No SVG footprint for "${type}" — add public/components/${type}.svg with a viewBox`,
    );
  }
  return size;
}

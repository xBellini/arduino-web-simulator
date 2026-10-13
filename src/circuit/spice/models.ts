/**
 * What: SPICE parts catalog loader — types + fetch/cache for `public/spice/catalog.json` and libs.
 *
 * Owns/exports: `SpiceCatalog`, `SpiceCatalogPart`, `SpiceModelKind`, `SpicePartCategory`,
 * `loadSpiceCatalog`, cached getters, `lookupSpicePart`, `defaultPartIdForComponent`,
 * `fetchSpiceLibFiles`, URL helpers for catalog/model paths.
 *
 * Conventions: Catalog is versioned JSON; `componentDefaults` maps registry `type` → part id.
 * Lib paths are relative under `public/spice/models/` (downloaded KiCad library), except paths
 * starting `bundled/`, which live in `public/spice/bundled/` (our own vendor models, e.g. TI
 * SN74HCxx; their catalog entries come from `public/spice/bundled/catalog.json`, merged in by
 * `scripts/fetch-spice-libraries.mjs`). Async load once at sim startup; sync
 * lookups assume cache populated.
 *
 * To ship a new part, add an entry to catalog.json (and model `.lib`), set `componentDefaults`
 * or document `spiceModelId` override on placed components.
 * To add a default for a new component type, extend `componentDefaults` / `futureDefaults` in
 * the catalog source script, then regenerate catalog.json.
 * To fetch libs for a build, pass collected paths from spice/models.ts into `fetchSpiceLibFiles`.
 *
 * Not here: Per-instance SPICE lines — see spice/models.ts and netlistExport.
 *
 * Merged in from `src/sim/spice/spiceModelResolver.ts`: Maps placed components → catalog SPICE
 * part, device letter, model name, and lib path. Owns/exports: `ResolvedSpiceModel`,
 * `resolveSpiceModelForComponent`, `collectLibPathsForComponents`. Conventions: `null` return →
 * netlistExport uses inline/native/synthetic element. Default LEDs skip catalog unless
 * `comp.spiceModelId` is set. Subckts use `X` prefix; letter from `deviceLetterForPart`. To default
 * a new registry type to a catalog part, set `componentDefaults` in catalog.json (spice/models.ts) —
 * resolver picks it via `defaultPartIdForComponent`. To force a user-selected model, set
 * `spiceModelId` on the placed component instance. To collect worker libs for a schematic, call
 * `collectLibPathsForComponents` before `fetchSpiceLibFiles`. Not here: Emitting SPICE instance
 * lines — see netlistExport.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | [src/sim/spice/spiceModelResolver.ts] Changelog creation
#                     | [src/sim/spice/spiceModelResolver.ts] Expanded What with practical how-to notes
#                     | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Merged `src/sim/spice/spiceModelResolver.ts` into this file (tree reorganization)
#                     | `bundled/` lib paths resolve to `public/spice/bundled/` (TI models out of the fetched library)
#                     | Moved from `src/sim/spice/modelCatalog.ts` (tree reorganization)
 */

import type { PlacedComponent } from '../../types';

export type SpiceModelKind = 'model' | 'subckt' | 'native';

export type SpicePartCategory =
  | 'diode'
  | 'bjt'
  | 'fet'
  | 'digital'
  | 'opamp'
  | 'optocoupler'
  | 'triac'
  | 'diac'
  | 'eeprom'
  | 'adc'
  | 'dac'
  | 'resistor'
  | 'capacitor'
  | 'other';

export interface SpiceCatalogPart {
  id: string;
  category: SpicePartCategory;
  kind: SpiceModelKind;
  deviceClass: string;
  lib: string | null;
  alternateLibs?: string[];
}

export interface SpiceCatalog {
  version: number;
  generatedAt: string;
  source: string;
  modelCount: number;
  libFileCount: number;
  parts: Record<string, SpiceCatalogPart>;
  defaults: Record<string, string>;
  componentDefaults: Record<string, string>;
  futureDefaults: Record<string, string>;
}

let catalogCache: SpiceCatalog | null = null;
let catalogPromise: Promise<SpiceCatalog | null> | null = null;

export function spiceCatalogUrl(): string {
  return `${import.meta.env.BASE_URL}spice/catalog.json`;
}

/** `bundled/<rel>` → `public/spice/bundled/<rel>`; any other path → `public/spice/models/<path>`. */
export function spiceModelLibUrl(relativeLibPath: string): string {
  const bundled = /^bundled\//.test(relativeLibPath);
  const rel = bundled ? relativeLibPath.slice('bundled/'.length) : relativeLibPath;
  const dir = bundled ? 'spice/bundled/' : 'spice/models/';
  return `${import.meta.env.BASE_URL}${dir}${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** Load catalog.json once (served from public/spice/). Returns null if missing/offline fetch fails. */
export async function loadSpiceCatalog(): Promise<SpiceCatalog | null> {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = (async () => {
      try {
        const res = await fetch(spiceCatalogUrl());
        if (!res.ok) return null;
        catalogCache = (await res.json()) as SpiceCatalog;
        return catalogCache;
      } catch {
        return null;
      }
    })();
  }
  return catalogPromise;
}

export function lookupSpicePart(
  catalog: SpiceCatalog,
  partId: string,
): SpiceCatalogPart | null {
  return catalog.parts[partId] ?? null;
}

export function defaultPartIdForComponent(
  catalog: SpiceCatalog,
  componentType: string,
): string | null {
  return catalog.componentDefaults[componentType] ?? catalog.defaults[componentType] ?? null;
}

/** Fetch raw text for a library file under public/spice/models/. */
export async function fetchSpiceLibFile(relativeLibPath: string): Promise<string | null> {
  try {
    const res = await fetch(spiceModelLibUrl(relativeLibPath));
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchSpiceLibFiles(
  relativePaths: Iterable<string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const unique = [...new Set(relativePaths)];
  await Promise.all(
    unique.map(async (rel) => {
      const text = await fetchSpiceLibFile(rel);
      if (text != null) out[rel] = text;
    }),
  );
  return out;
}

export interface ResolvedSpiceModel {
  partId: string;
  part: SpiceCatalogPart;
  /** SPICE instance prefix: D, Q, M, X, R, C, … */
  deviceLetter: string;
  /** Name referenced on the instance line (model or subckt name). */
  spiceName: string;
  /** Relative path under public/spice/models/ — null for native/synthetic. */
  libPath: string | null;
}

function deviceLetterForPart(part: SpiceCatalogPart): string {
  if (part.kind === 'subckt') return 'X';
  const dc = part.deviceClass.toUpperCase();
  if (dc === 'D') return 'D';
  if (dc === 'NPN' || dc === 'PNP' || dc === 'Q') return 'Q';
  if (dc.includes('MOS') || dc === 'NMOS' || dc === 'PMOS') return 'M';
  if (dc === 'R') return 'R';
  if (dc === 'C') return 'C';
  if (dc === 'V') return 'V';
  return 'X';
}

/**
 * Resolve which catalog part + library to use for a placed component.
 * Returns null → caller uses legacy inline .model or native element.
 */
export function resolveSpiceModelForComponent(
  comp: PlacedComponent,
  catalog: SpiceCatalog | null,
): ResolvedSpiceModel | null {
  if (!catalog) return null;

  const partId = comp.spiceModelId ?? defaultPartIdForComponent(catalog, comp.type);
  if (!partId) return null;

  const part = lookupSpicePart(catalog, partId);
  if (!part || part.kind === 'native') return null;

  // LEDs: prefer property-derived synthetic model unless user picked a catalog part explicitly.
  if (comp.type === 'led' && comp.spiceModelId == null) return null;

  return {
    partId,
    part,
    deviceLetter: deviceLetterForPart(part),
    spiceName: part.id,
    libPath: part.lib,
  };
}

export function collectLibPathsForComponents(
  components: PlacedComponent[],
  catalog: SpiceCatalog | null,
): string[] {
  const paths = new Set<string>();
  if (!catalog) return [];
  for (const comp of components) {
    const resolved = resolveSpiceModelForComponent(comp, catalog);
    if (resolved?.libPath) paths.add(resolved.libPath);
  }
  return [...paths];
}

/**
 * What: Left sidebar parts library — browse registry, enter placement mode, search/filter. Exports Palette;
 * data from PALETTE_CATEGORIES + getDefinition (src/registry/components). Click toggles startPlacement(type)
 * / cancelPlacement via SimContext; active row follows state.placementType. Search matches label, type id,
 * and category label (componentMatchesQuery). To surface a new part: register in COMPONENT_REGISTRY and add
 * palette metadata beside its definition — no Palette edit unless you change UX (new filter,
 * sort). Thumbnails are PaletteIcon → ComponentShape. Placement rules/snap live in SimCanvas/geometry — not here.
 *
 * Merged in from `src/components/PaletteIcon.tsx`: Memoized palette row thumbnail — mini SVG
 * preview of one registry type. Exports PaletteIcon; uses createPaletteStub + paletteViewBox from
 * this file and renders ComponentShape inside .palette-icon svg (viewBox per type,
 * preserveAspectRatio meet). Optional simFlags: e.g. led gets ledLit palette_preview so glow shows
 * in the list. To fix a cropped/wrong preview: adjust paletteViewBox/createPaletteStub for that
 * type in this file, not ComponentShape canvas logic. To preview another sim state (RGB
 * on): extend the simFlags useMemo branch for type === '…'. Registry definition/artwork changes
 * flow from components registry.
 *
 * Merged in from `src/utils/paletteIcon.ts`: Palette sidebar icon viewBox crops and default
 * property stubs for previews. Role: small SVG previews in the parts library — not canvas placement
 * size. Owns/exports: `paletteViewBox(type)`, `createPaletteStub(type)`. Conventions: default
 * viewBox is full footprint from `getDefinition`; `VIEWBOX_OVERRIDES` are `"minX minY width
 * height"` strings for wide/tall parts only; stubs mirror new-part defaults (resistor/LED fields,
 * etc.). To improve a cramped palette icon: add or tweak `VIEWBOX_OVERRIDES[type]` — does not
 * change canvas footprint or pins. To preview a new part type correctly: extend `createPaletteStub`
 * switch/default branch with the same optional fields `SimContext` sets on place. Not-here:
 * registry pins, hitboxes, or `PALETTE_CATEGORIES` ordering (`components.ts`).
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | [src/utils/paletteIcon.ts] Changelog creation
#                     | [src/utils/paletteIcon.ts] Expanded What with practical how-to notes
#                     | [src/utils/paletteIcon.ts] Stubs seed from the part module's shared `properties.defaults`
#                     | [src/components/PaletteIcon.tsx] Changelog creation
#                     | [src/components/PaletteIcon.tsx] Expanded What with practical how-to notes
#                     | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Merged `src/components/PaletteIcon.tsx` into this file (tree reorganization)
#                     | Merged `src/utils/paletteIcon.ts` into this file (tree reorganization)
#                     | Moved from `src/components/Palette.tsx` (tree reorganization)
# 13-10-2026 | Codex | Use derived membership and include part-owned keywords in search.
 */
import { useCallback, useEffect, useMemo, useState, memo } from 'react';
import { PALETTE_CATEGORIES, getDefinition, type PaletteCategoryId } from '../../registry/components';
import { useSim } from '../../store/SimContext';
import { ComponentShape } from '../canvas/ComponentShape';
import { createComponentSimFlags } from '../../avr/gpioBridge';
import { getPartModule } from '../../components';
import type { PlacedComponent } from '../../types';

/** Tighter crops so wide/tall parts read clearly at palette size. */
const VIEWBOX_OVERRIDES: Partial<Record<string, string>> = {
  breadboard: '0 0 200 70',
  arduino_uno: '30 15 380 180',
  arduino_nano: '40 25 370 200',
  servo: '10 20 124 90',
};

export function paletteViewBox(type: string): string {
  const override = VIEWBOX_OVERRIDES[type];
  if (override) return override;
  const def = getDefinition(type);
  return `0 0 ${def.width} ${def.height}`;
}

export function createPaletteStub(type: string): PlacedComponent {
  const def = getDefinition(type);
  const pinStates = Object.fromEntries(
    def.pins.map((pin) => [pin.id, 'floating' as const]),
  );

  const component: PlacedComponent = {
    id: 'palette_preview',
    type,
    x: 0,
    y: 0,
    rotation: 0,
    pinStates,
    ...getPartModule(type)?.properties?.defaults?.(),
  };

  return component;
}

interface PaletteIconProps {
  type: string;
}

export const PaletteIcon = memo(function PaletteIcon({ type }: PaletteIconProps) {
  const component = useMemo(() => createPaletteStub(type), [type]);
  const viewBox = useMemo(() => paletteViewBox(type), [type]);
  const simFlags = useMemo(() => {
    const flags = createComponentSimFlags();
    if (type === 'led') {
      flags.ledLit = { palette_preview: true };
    }
    return flags;
  }, [type]);

  return (
    <span className="palette-icon" aria-hidden="true">
      <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
        <ComponentShape
          component={component}
          selected={false}
          simFlags={simFlags}
        />
      </svg>
    </span>
  );
});

function categoryForType(type: string | null): PaletteCategoryId | null {
  if (!type) return null;
  for (const category of PALETTE_CATEGORIES) {
    if ((category.types as readonly string[]).includes(type)) {
      return category.id;
    }
  }
  return null;
}

function componentMatchesQuery(
  type: string,
  categoryLabel: string,
  query: string,
): boolean {
  if (!query) return true;
  const def = getDefinition(type);
  const haystack = [
    def.label,
    type,
    type.replace(/_/g, ' '),
    categoryLabel,
    ...(def.palette?.keywords ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export function Palette() {
  const { state, startPlacement, cancelPlacement } = useSim();
  const { placementType } = state;

  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;

  const [expanded, setExpanded] = useState<Set<PaletteCategoryId>>(() =>
    new Set(PALETTE_CATEGORIES.map((c) => c.id)),
  );

  const visibleCategories = useMemo(
    () =>
      PALETTE_CATEGORIES.map((category) => ({
        ...category,
        types: category.types.filter((type) =>
          componentMatchesQuery(type, category.label, normalizedQuery),
        ),
      })).filter((category) => category.types.length > 0 || !isSearching),
    [normalizedQuery, isSearching],
  );

  const activeCategory = useMemo(
    () => categoryForType(placementType),
    [placementType],
  );

  useEffect(() => {
    if (!activeCategory) return;
    setExpanded((prev) => {
      if (prev.has(activeCategory)) return prev;
      const next = new Set(prev);
      next.add(activeCategory);
      return next;
    });
  }, [activeCategory]);

  useEffect(() => {
    if (!isSearching) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const category of visibleCategories) {
        next.add(category.id);
      }
      return next;
    });
  }, [isSearching, visibleCategories]);

  const toggleCategory = useCallback((id: PaletteCategoryId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleItemClick = useCallback(
    (type: string, active: boolean) => {
      if (active) cancelPlacement();
      else startPlacement(type);
    },
    [cancelPlacement, startPlacement],
  );

  return (
    <aside className="palette" aria-label="Component palette">
      <div className="palette-header">
        <h2 className="palette-title">Components</h2>
        <p className="palette-hint">Click a part to place on canvas</p>
      </div>

      <div className="palette-search-wrap">
        <input
          type="search"
          className="palette-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search components…"
          aria-label="Search components"
          spellCheck={false}
        />
        {query && (
          <button
            type="button"
            className="palette-search-clear"
            onClick={() => setQuery('')}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      <nav className="palette-menu" aria-label="Component categories">
        {visibleCategories.length === 0 && (
          <p className="palette-search-empty">No components match &ldquo;{query.trim()}&rdquo;</p>
        )}
        {visibleCategories.map((category) => {
          const isOpen = expanded.has(category.id);
          const sectionId = `palette-section-${category.id}`;

          return (
            <section
              key={category.id}
              className={`palette-section${isOpen ? ' is-open' : ''}`}
              aria-labelledby={`${sectionId}-heading`}
            >
              <button
                id={`${sectionId}-heading`}
                type="button"
                className="palette-section-toggle"
                aria-expanded={isOpen}
                aria-controls={sectionId}
                onClick={() => toggleCategory(category.id)}
              >
                <span className="palette-section-label">{category.label}</span>
                <span className="palette-section-count">{category.types.length}</span>
                <span className="palette-section-chevron" aria-hidden />
              </button>

              <div
                className="palette-section-body"
                aria-hidden={!isOpen}
                inert={!isOpen}
              >
                <div className="palette-section-body-inner">
                  <ul id={sectionId} className="palette-list">
                    {category.types.map((type) => {
                      const def = getDefinition(type);
                      const active = placementType === type;
                      return (
                        <li key={type}>
                          <button
                            type="button"
                            className={`palette-item${active ? ' active' : ''}`}
                            onClick={() => handleItemClick(type, active)}
                            title={def.label}
                            aria-pressed={active}
                            tabIndex={isOpen ? 0 : -1}
                          >
                            <PaletteIcon type={type} />
                            <span className="palette-item-label">{def.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </section>
          );
        })}
      </nav>
    </aside>
  );
}

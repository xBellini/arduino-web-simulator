/**
 * What: Flags which part types get a properties panel or chip silkscreen editing.
 * Role: UI gate — reads `PartModule.properties.editable` plus registry `marking`.
 * Owns/exports: `componentHasEditableProperties(type)`, `componentHasChipMarking(type)`.
 * Conventions: a simulating part opts in via `properties.editable` on its module;
 * registry `marking: 'chip' | 'value'` still enables the panel for package ICs.
 * To enable a value editor on a new simulating part: set `properties.editable: true`
 * on its module (and implement `defaults` / `load`).
 * To show only silkscreen rename: use `marking: 'chip'` and `PlacedComponent.partLabel`.
 * Not-here: actual property form controls — only capability checks.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | Part modules declare `properties.editable` instead of joining LEGACY_EDITABLE
#                     | Removed LEGACY_EDITABLE; modules and marking cover every editable type
# 09-10-2026 | Cursor | Moved from `src/utils/componentProperties.ts` (tree reorganization)
 */
import { getDefinition } from '../../registry/components';
import { getPartModule } from '../../components';

/** Types that open a properties panel (value editors or chip marking). */
export function componentHasEditableProperties(
  type: string | undefined,
): boolean {
  if (!type) return false;
  if (getPartModule(type)?.properties?.editable) return true;
  try {
    const marking = getDefinition(type).marking;
    return marking === 'chip' || marking === 'value';
  } catch {
    return false;
  }
}

export function componentHasChipMarking(type: string | undefined): boolean {
  if (!type) return false;
  try {
    return getDefinition(type).marking === 'chip';
  } catch {
    return false;
  }
}

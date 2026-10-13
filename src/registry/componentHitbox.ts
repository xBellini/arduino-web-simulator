/**
 * What: Clickable body bounds for parts in design and world space.
 * Role: selection, drag, placement pivot, and wire obstacle rects — not rendering.
 * Owns/exports: `COMPONENT_HITBOX_OVERRIDES`, `getDesignHitbox`, `getComponentBodyHitbox`,
 * `componentPlacementPivot`, `worldToComponentLocal`, `pointInComponentHitbox`.
 * Conventions: override rects are in SVG design space (pre-`scale`); default hitbox is the
 * full viewBox `0 0 width height` from `getDesignDefinition`; lookup tries `type` then
 * `def.package`; scaled hitboxes add a small `HIT_PAD` for easier grabbing.
 * To add a HITBOX override: only when the default viewBox is wrong — art drawn outside
 * 0…w/0…h (negative Y, oversized silkscreen), or you need a tighter body than the SVG page.
 * Add `type: { x, y, width, height }` to `COMPONENT_HITBOX_OVERRIDES` (or the shared
 * `package` key if all DIP8 variants share one box); measure in the same coords as pin art.
 * Skip overrides when the viewBox already matches the intended grab area.
 * To verify: place the part, drag near edges, and check wire routing avoids `getComponentBodyHitbox`.
 * Not-here: pin hit targets, palette icons, or registry pin lists.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 06-10-2026 | Cursor | Zero hitbox for wire_junction (dots only; do not steal wire hits)
 */
import type { PlacedComponent } from '../types';
import {
  getDefinition,
  getDefinitionScale,
  getDesignDefinition,
} from './components';

export interface LocalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Optional hitbox overrides in SVG design space.
 * Default is the full SVG viewBox (`0 0 width height` from `partFootprints`).
 * Only add an entry when the clickable body must differ from the viewBox
 * (e.g. art drawn outside 0…w / 0…h, or a tighter body than the page).
 */
export const COMPONENT_HITBOX_OVERRIDES: Partial<Record<string, LocalRect>> = {
  // Invisible tee nodes — selection via wires/junction dots only.
  wire_junction: { x: 0, y: 0, width: 0, height: 0 },
};

const HIT_PAD = 2;

function scaleRect(rect: LocalRect, scale: number): LocalRect {
  if (scale === 1) return rect;
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** Design-space hitbox: override if present, otherwise full SVG viewBox. */
export function getDesignHitbox(type: string): LocalRect {
  const def = getDesignDefinition(type);
  const override =
    COMPONENT_HITBOX_OVERRIDES[type] ??
    (def.package ? COMPONENT_HITBOX_OVERRIDES[def.package] : undefined);
  if (override) return { ...override };
  return { x: 0, y: 0, width: def.width, height: def.height };
}

/** Scaled + padded hitbox for drag / selection outline. */
export function getComponentBodyHitbox(type: string): LocalRect {
  const scaled = scaleRect(getDesignHitbox(type), getDefinitionScale(type));
  return {
    x: scaled.x - HIT_PAD,
    y: scaled.y - HIT_PAD,
    width: scaled.width + HIT_PAD * 2,
    height: scaled.height + HIT_PAD * 2,
  };
}

/**
 * Local point that should sit under the cursor while placing a part.
 * Defaults to footprint center; uses hitbox center when the box extends
 * outside the footprint origin (e.g. art with negative local Y).
 */
export function componentPlacementPivot(
  type: string,
  def: { width: number; height: number },
): { x: number; y: number } {
  const bounds = scaleRect(getDesignHitbox(type), getDefinitionScale(type));
  const outsideFootprint =
    bounds.y < 0 ||
    bounds.x < 0 ||
    bounds.x + bounds.width > def.width ||
    bounds.y + bounds.height > def.height;
  if (outsideFootprint) {
    return {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
  }
  return { x: def.width / 2, y: def.height / 2 };
}

export function worldToComponentLocal(
  comp: PlacedComponent,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  const def = getDefinition(comp.type);
  const cx = comp.x + def.width / 2;
  const cy = comp.y + def.height / 2;
  let dx = worldX - cx;
  let dy = worldY - cy;

  if (comp.rotation !== 0) {
    const rad = (-comp.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    dx = rx;
    dy = ry;
  }

  return { x: dx + def.width / 2, y: dy + def.height / 2 };
}

export function pointInComponentHitbox(
  comp: PlacedComponent,
  worldX: number,
  worldY: number,
): boolean {
  const local = worldToComponentLocal(comp, worldX, worldY);
  const hit = getComponentBodyHitbox(comp.type);
  return (
    local.x >= hit.x &&
    local.x <= hit.x + hit.width &&
    local.y >= hit.y &&
    local.y <= hit.y + hit.height
  );
}

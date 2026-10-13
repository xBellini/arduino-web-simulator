/**
 * What: React hook — measure a popover element and clamp its top-left to the viewport.
 * Role: bridge DOM measurements to `clampPopupPosition` for menus/floating panels.
 * Owns/exports: `useClampToViewport(ref, x, y) → { x, y }`.
 * Conventions: runs in `useLayoutEffect` when `ref`, `x`, or `y` change; uses
 * `getBoundingClientRect` width/height; falls back to raw `x`/`y` if ref unset.
 * To use on a new popover: attach `ref` to the positioned root, pass anchor coordinates,
 * apply returned `{ x, y }` as `left`/`top` (or transform) in client space.
 * To adjust inset: change margin in `clampPopup.ts` or add a parameter there first.
 * Not-here: focus trap, portal mounting, or canvas coordinate conversion.
 *
 * Merged in from `src/utils/clampPopup.ts`: Pure math to keep a fixed-size popup inside the browser
 * viewport. Role: clamp top-left `{ x, y }` given element width/height — no DOM reads except
 * `window`. Owns/exports: `clampPopupPosition(x, y, width, height, margin?)`. Conventions:
 * coordinates are viewport/client px; default `margin` is 8; uses `window.innerWidth` /
 * `innerHeight` (call only in browser context). To keep a new floating panel on-screen: measure the
 * element, pass its size into `clampPopupPosition` on open or move; or use `useClampToViewport` for
 * measured refs. To allow edge bleed: pass a smaller margin; to force inset from edges, increase
 * margin. Not-here: React lifecycle, scroll containers, or canvas transforms — window viewport
 * only.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | [src/utils/clampPopup.ts] Changelog creation
#                     | [src/utils/clampPopup.ts] Expanded What with practical how-to notes
#                     | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Merged `src/utils/clampPopup.ts` into this file (tree reorganization)
#                     | Moved from `src/hooks/useClampToViewport.ts` (tree reorganization)
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

export function clampPopupPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  margin = 8,
): { x: number; y: number } {
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

/** Measure an element after mount and clamp its top-left position to the viewport. */
export function useClampToViewport(
  ref: RefObject<HTMLElement | null>,
  x: number,
  y: number,
): { x: number; y: number } {
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setPos({ x, y });
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    setPos(clampPopupPosition(x, y, width, height));
  }, [ref, x, y]);

  return pos;
}

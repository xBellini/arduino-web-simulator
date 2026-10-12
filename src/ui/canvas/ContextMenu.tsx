/**
 * What: Reusable screen-space context menu (createPortal to document.body). Exports ContextMenu and
 * ContextMenuItem { id, label, shortcut?, disabled?, danger?, onSelect }. Props: x/y client coords, items[],
 * onClose. useClampToViewport on menu ref; outside pointerdown + Escape call onClose; item click runs
 * onSelect then closes. SimCanvas constructs items arrays (delete, rotate, properties, wire joints, etc.) —
 * add a menu action by appending a ContextMenuItem in SimCanvas builders, not new buttons here. Danger styling
 * uses .context-menu-item.danger in index.css. Property editor portals are separate components.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/components/ContextMenu.tsx` (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useClampToViewport } from '../editors/popup';

export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const pos = useClampToViewport(menuRef, x, y);
  const onCloseRef = useRef(onClose);
  const itemsRef = useRef(items);

  onCloseRef.current = onClose;
  itemsRef.current = items;

  useEffect(() => {
    const isInsideMenu = (target: EventTarget | null) => {
      const menu = menuRef.current;
      if (!menu || !target) return false;
      if (menu.contains(target as Node)) return true;
      return false;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (isInsideMenu(e.target)) return;
      onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const handleItemPointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    item: ContextMenuItem,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (item.disabled) return;
    item.onSelect();
    onCloseRef.current();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`context-menu-item${item.danger ? ' danger' : ''}`}
          disabled={item.disabled}
          onPointerDown={(e) => handleItemPointerDown(e, item)}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <span className="context-menu-shortcut">{item.shortcut}</span>
          )}
        </button>
      ))}
    </div>,
    document.body,
  );
}

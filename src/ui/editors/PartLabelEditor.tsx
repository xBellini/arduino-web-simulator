/**
 * What: Portal popover to edit placed partLabel (user silkscreen text on ICs/packages). Exports
 * PartLabelEditor; props: screen x/y, footprintLabel (title), initialLabel, onSave(partLabel), onClose.
 * useClampToViewport keeps the panel on-screen; Escape/outside-click closes via refs to avoid stale handlers.
 * SimCanvas opens this from context menu when the part supports custom labels; onSave should patch
 * PlacedComponent.partLabel in store (caller owns persistence). To enable labeling for a new package: set
 * marking/registry + context action in SimCanvas — not this file. Display of saved text on-canvas is
 * ComponentOverlays BodyMarkingOverlay / partLabel field, not the editor UI.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 24-09-2026 | Cursor | Textarea so multi-line TO package markings (`partNumber\\ntype`) survive edits
# 09-10-2026 | Cursor | Moved from `src/components/PartLabelEditor.tsx` (tree reorganization)
# 17-10-2026 | Codex  | Reuse text editor for named nets with single-line names and removal by clearing.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClampToViewport } from './popup';

interface PartLabelEditorProps {
  x: number;
  y: number;
  /** Footprint name shown in the title, e.g. DIP8 */
  footprintLabel: string;
  initialLabel: string;
  netName?: boolean;
  onSave: (partLabel: string) => void;
  onClose: () => void;
}

export function PartLabelEditor({
  x,
  y,
  footprintLabel,
  initialLabel,
  netName = false,
  onSave,
  onClose,
}: PartLabelEditorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useClampToViewport(panelRef, x, y);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  const onSaveRef = useRef(onSave);
  const [label, setLabel] = useState(initialLabel);

  onCloseRef.current = onClose;
  onSaveRef.current = onSave;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const isInsidePanel = (target: EventTarget | null) => {
      const panel = panelRef.current;
      if (!panel || !target) return false;
      return panel.contains(target as Node);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (isInsidePanel(e.target)) return;
      onCloseRef.current();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onSaveRef.current(label.trim());
        onCloseRef.current();
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [label]);

  return createPortal(
    <div
      onPointerDown={e => { if (netName) e.stopPropagation(); }}
      ref={panelRef}
      className="resistor-value-editor part-label-editor"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={netName ? 'Named net' : `${footprintLabel} marking`}
    >
      <div className="resistor-value-editor-title">{netName ? 'Named net' : footprintLabel + ' marking'}</div>
      <div className="resistor-value-editor-form">
        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">{netName ? 'Net name' : 'Chip name'}</span>
          <textarea
            ref={inputRef}
            className="resistor-value-editor-input"
            rows={netName ? 1 : 3}
            maxLength={netName ? 64 : undefined}
            value={label}
            placeholder={netName ? "e.g. VCC or SDA" : "e.g. NE555"}
            onChange={(e) => setLabel(netName ? e.target.value.replace(/[\r\n]/g, '') : e.target.value)}
          />
        </label>
        <p className="instrument-properties-hint">
          {netName ? 'Matching names connect across this circuit (case-sensitive). Clear the name to remove it. Ctrl+Enter saves.' : <>Uses the shared {footprintLabel} artwork; this text is drawn on top. Multi-line labels (Ctrl+Enter to save) keep part number and type on separate lines.</>}
        </p>
      </div>
      <div className="resistor-value-editor-actions">
        <button
          type="button"
          className="resistor-value-editor-btn"
          onClick={() => onClose()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="resistor-value-editor-btn primary"
          onClick={() => {
            onSave(label.trim());
            onClose();
          }}
        >
          Save
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * What: Floating portal editor for LED placed-component fields: color, Vf, If. Exports LedPropertiesEditor;
 * onSave receives LedPropertiesPatch from values/led (parseForwardVoltage/parseForwardCurrent on save).
 * Screen-anchored x/y + useClampToViewport; same dismiss pattern as ResistorValueEditor (outside pointer,
 * Escape). SimCanvas mounts it when user edits an LED (double-click/context). To add a new LED field:
 * extend LedPropertiesPatch + values/led, add control here, apply patch in SimCanvas/store reducer. LED
 * glow/blown rendering is ComponentOverlays + sim flags — not this panel. Default color constants: values/led.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/components/LedPropertiesEditor.tsx` (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClampToViewport } from './popup';
import type { LedColorHex } from '../../values/led';
import {
  LED_COLOR_OPTIONS,
  parseForwardCurrent,
  parseForwardVoltage,
  type LedPropertiesPatch,
} from '../../values/led';

interface LedPropertiesEditorProps {
  x: number;
  y: number;
  initialColor: LedColorHex;
  initialForwardVoltage: number;
  initialForwardCurrent: number;
  onSave: (patch: LedPropertiesPatch) => void;
  onClose: () => void;
}

export function LedPropertiesEditor({
  x,
  y,
  initialColor,
  initialForwardVoltage,
  initialForwardCurrent,
  onSave,
  onClose,
}: LedPropertiesEditorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useClampToViewport(panelRef, x, y);
  const onCloseRef = useRef(onClose);
  const onSaveRef = useRef(onSave);

  const [color, setColor] = useState<LedColorHex>(initialColor);
  const [forwardVoltageText, setForwardVoltageText] = useState(
    String(initialForwardVoltage),
  );
  const [forwardCurrentText, setForwardCurrentText] = useState(
    String(initialForwardCurrent),
  );
  const [error, setError] = useState<string | null>(null);

  onCloseRef.current = onClose;
  onSaveRef.current = onSave;

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
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const trySave = () => {
    const forwardVoltage = parseForwardVoltage(forwardVoltageText);
    if (forwardVoltage === null) {
      setError('Forward voltage must be between 0 and 10 V');
      return;
    }

    const forwardCurrent = parseForwardCurrent(forwardCurrentText);
    if (forwardCurrent === null) {
      setError('Forward current must be between 0 and 1000 mA');
      return;
    }

    onSaveRef.current({
      ledColor: color,
      ledForwardVoltage: forwardVoltage,
      ledForwardCurrent: forwardCurrent,
    });
    onCloseRef.current();
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    trySave();
  };

  return createPortal(
    <div
      ref={panelRef}
      className="resistor-value-editor"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="LED properties"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="resistor-value-editor-title">LED properties</div>
      <form className="resistor-value-editor-form" onSubmit={onSubmit}>
        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">Color</span>
          <span className="resistor-value-editor-field-group">
            <span
              className="led-color-swatch"
              style={{ backgroundColor: color }}
              aria-hidden
            />
            <select
              className="resistor-value-editor-select resistor-value-editor-select-fill"
              value={color}
              onChange={(e) => {
                setColor(e.target.value as LedColorHex);
                if (error) setError(null);
              }}
              aria-label="LED color"
            >
              {LED_COLOR_OPTIONS.map((option) => (
                <option key={option.hex} value={option.hex}>
                  {option.label}
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">Forward voltage</span>
          <span className="resistor-value-editor-field-group">
            <input
              type="text"
              inputMode="decimal"
              className="resistor-value-editor-input"
              value={forwardVoltageText}
              onChange={(e) => {
                setForwardVoltageText(e.target.value);
                if (error) setError(null);
              }}
              aria-label="Forward voltage"
            />
            <span className="resistor-value-editor-unit">V</span>
          </span>
        </label>

        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">Forward current</span>
          <span className="resistor-value-editor-field-group">
            <input
              type="text"
              inputMode="decimal"
              className="resistor-value-editor-input"
              value={forwardCurrentText}
              onChange={(e) => {
                setForwardCurrentText(e.target.value);
                if (error) setError(null);
              }}
              aria-label="Forward current"
            />
            <span className="resistor-value-editor-unit">mA</span>
          </span>
        </label>

        {error && <div className="resistor-value-editor-error">{error}</div>}
        <div className="resistor-value-editor-actions">
          <button type="button" className="resistor-value-editor-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="resistor-value-editor-btn primary">
            Apply
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

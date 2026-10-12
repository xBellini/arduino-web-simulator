/**
 * What: Portal editor for resistor value, unit (Ω/kΩ/MΩ), power rating, and tolerance. Exports
 * ResistorValueEditor; onSave → ResistorPropertiesPatch via parseResistanceValue and RESISTANCE_* option
 * lists from values/resistor. Initial values come from PlacedComponent fields SimCanvas passes in. To
 * support a new rating/tolerance enum: update types + values/resistor lists, then add a <select> row here.
 * Color bands on the part SVG update through ComponentOverlays/ResistorBandOverlay when store fields change.
 * Ngspice/netlist resistance mapping lives in sim layer — not this UI file.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/components/ResistorValueEditor.tsx` (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClampToViewport } from './popup';
import type {
  ResistancePowerRating,
  ResistanceTolerance,
  ResistanceUnit,
} from '../../types';
import {
  parseResistanceValue,
  RESISTANCE_POWER_RATINGS,
  RESISTANCE_TOLERANCES,
  RESISTANCE_UNITS,
  type ResistorPropertiesPatch,
  TOLERANCE_LABELS,
  UNIT_LABELS,
} from '../../values/resistor';

interface ResistorValueEditorProps {
  x: number;
  y: number;
  initialValue: number;
  initialUnit: ResistanceUnit;
  initialPowerRating: ResistancePowerRating;
  initialTolerance: ResistanceTolerance;
  onSave: (patch: ResistorPropertiesPatch) => void;
  onClose: () => void;
}

export function ResistorValueEditor({
  x,
  y,
  initialValue,
  initialUnit,
  initialPowerRating,
  initialTolerance,
  onSave,
  onClose,
}: ResistorValueEditorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useClampToViewport(panelRef, x, y);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const onSaveRef = useRef(onSave);

  const [valueText, setValueText] = useState(String(initialValue));
  const [unit, setUnit] = useState<ResistanceUnit>(initialUnit);
  const [powerRating, setPowerRating] =
    useState<ResistancePowerRating>(initialPowerRating);
  const [tolerance, setTolerance] =
    useState<ResistanceTolerance>(initialTolerance);
  const [error, setError] = useState<string | null>(null);

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
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const trySave = () => {
    const parsed = parseResistanceValue(valueText);
    if (parsed === null) {
      setError('Enter a positive number');
      return;
    }
    onSaveRef.current({
      resistanceValue: parsed,
      resistanceUnit: unit,
      resistancePowerRating: powerRating,
      resistanceTolerance: tolerance,
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
      aria-label="Resistor properties"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="resistor-value-editor-title">Resistor properties</div>
      <form className="resistor-value-editor-form" onSubmit={onSubmit}>
        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">Resistance</span>
          <span className="resistor-value-editor-field-group">
            <input
              ref={inputRef}
              type="text"
              inputMode="decimal"
              className="resistor-value-editor-input"
              value={valueText}
              onChange={(e) => {
                setValueText(e.target.value);
                if (error) setError(null);
              }}
              aria-label="Resistance value"
            />
            <select
              className="resistor-value-editor-select"
              value={unit}
              onChange={(e) => setUnit(e.target.value as ResistanceUnit)}
              aria-label="Resistance unit"
            >
              {RESISTANCE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">Power rating</span>
          <select
            className="resistor-value-editor-select resistor-value-editor-select-wide"
            value={powerRating}
            onChange={(e) =>
              setPowerRating(e.target.value as ResistancePowerRating)
            }
            aria-label="Power rating"
          >
            {RESISTANCE_POWER_RATINGS.map((rating) => (
              <option key={rating} value={rating}>
                {rating}
              </option>
            ))}
          </select>
        </label>

        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">Tolerance</span>
          <select
            className="resistor-value-editor-select resistor-value-editor-select-wide"
            value={tolerance}
            onChange={(e) =>
              setTolerance(e.target.value as ResistanceTolerance)
            }
            aria-label="Tolerance"
          >
            {RESISTANCE_TOLERANCES.map((t) => (
              <option key={t} value={t}>
                {TOLERANCE_LABELS[t]}
              </option>
            ))}
          </select>
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

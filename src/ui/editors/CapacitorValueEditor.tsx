/**

 * What: Portal editor for capacitor value, unit (pF/nF/µF/mF), and voltage rating.

 * Exports CapacitorValueEditor; onSave → CapacitorPropertiesPatch via parse helpers

 * from values/capacitor. Shared by ceramic and polarized caps.

 *

 * Changelog:
 * - 09-10-2026 ? Moved from `src/components/CapacitorValueEditor.tsx` (tree reorganization)

 * - 25-09-2026 — Voltage rating field

 * - 25-09-2026 — Changelog creation

 */

import { useEffect, useRef, useState } from 'react';

import { createPortal } from 'react-dom';

import { useClampToViewport } from './popup';

import type { CapacitanceUnit } from '../../types';

import {

  CAPACITANCE_UNIT_LABELS,

  CAPACITANCE_UNITS,

  parseCapacitanceValue,

  type CapacitorPropertiesPatch,

} from '../../values/capacitor';



interface CapacitorValueEditorProps {

  x: number;

  y: number;

  title: string;

  initialValue: number;

  initialUnit: CapacitanceUnit;

  initialVoltageRating: number;

  onSave: (patch: CapacitorPropertiesPatch) => void;

  onClose: () => void;

}



export function CapacitorValueEditor({

  x,

  y,

  title,

  initialValue,

  initialUnit,

  initialVoltageRating,

  onSave,

  onClose,

}: CapacitorValueEditorProps) {

  const panelRef = useRef<HTMLDivElement>(null);

  const pos = useClampToViewport(panelRef, x, y);

  const inputRef = useRef<HTMLInputElement>(null);

  const onCloseRef = useRef(onClose);

  const onSaveRef = useRef(onSave);



  const [valueText, setValueText] = useState(String(initialValue));

  const [unit, setUnit] = useState<CapacitanceUnit>(initialUnit);

  const [voltageText, setVoltageText] = useState(String(initialVoltageRating));

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

    const parsed = parseCapacitanceValue(valueText);

    if (parsed === null) {

      setError('Enter a positive capacitance');

      return;

    }

    const rating = parseCapacitanceValue(voltageText);

    if (rating === null) {

      setError('Enter a positive voltage rating');

      return;

    }

    onSaveRef.current({

      capacitanceValue: parsed,

      capacitanceUnit: unit,

      capacitanceVoltageRating: rating,

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

      aria-label={title}

      onPointerDown={(e) => e.stopPropagation()}

    >

      <div className="resistor-value-editor-title">{title}</div>

      <form className="resistor-value-editor-form" onSubmit={onSubmit}>

        <label className="resistor-value-editor-row">

          <span className="resistor-value-editor-label">Capacitance</span>

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

              aria-label="Capacitance value"

            />

            <select

              className="resistor-value-editor-select"

              value={unit}

              onChange={(e) => setUnit(e.target.value as CapacitanceUnit)}

              aria-label="Capacitance unit"

            >

              {CAPACITANCE_UNITS.map((u) => (

                <option key={u} value={u}>

                  {CAPACITANCE_UNIT_LABELS[u]}

                </option>

              ))}

            </select>

          </span>

        </label>



        <label className="resistor-value-editor-row">

          <span className="resistor-value-editor-label">Voltage rating</span>

          <span className="resistor-value-editor-field-group">

            <input

              type="text"

              inputMode="decimal"

              className="resistor-value-editor-input"

              value={voltageText}

              onChange={(e) => {

                setVoltageText(e.target.value);

                if (error) setError(null);

              }}

              aria-label="Voltage rating"

            />

            <span className="resistor-value-editor-unit">V</span>

          </span>

        </label>



        {error ? (

          <div className="resistor-value-editor-error" role="alert">

            {error}

          </div>

        ) : null}



        <div className="resistor-value-editor-actions">

          <button

            type="button"

            className="resistor-value-editor-btn"

            onClick={() => onCloseRef.current()}

          >

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



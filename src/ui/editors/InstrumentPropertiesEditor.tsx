/**
 * What: Portal property sheet for bench instruments (currently power_supply and oscillator). Exports
 * InstrumentPropertiesEditor and internal NumberStepper; branches on component.type, writes Partial<
 * PlacedComponent> through onSave. Supply fields use electricUnits (voltage/current units, steps, limits);
 * oscillator frequency uses instrumentsGeometry defaults. SimCanvas opens editor and merges patch into store.
 * To add another instrument's editable params: new `if (component.type === '…')` save handler + JSX block
 * mirroring power_supply/Oscillator patterns; live dial readouts on the SVG stay in ComponentOverlays. LED/
 * resistor editors are separate components — not this file.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Moved from `src/components/InstrumentPropertiesEditor.tsx` (tree reorganization)
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClampToViewport } from './popup';
import type { CurrentUnit, PlacedComponent, VoltageUnit } from '../../types';
import {
  CURRENT_UNIT_LABELS,
  CURRENT_UNITS,
  convertCurrentValue,
  convertVoltageValue,
  currentStepConfig,
  DEFAULT_SUPPLY_CURRENT_LIMIT_UNIT,
  DEFAULT_SUPPLY_VOLTAGE_UNIT,
  parseSupplyNumeric,
  VOLTAGE_UNIT_LABELS,
  VOLTAGE_UNITS,
  voltageStepConfig,
} from '../../values/electric';
import {
  DEFAULT_OSCILLATOR_FREQUENCY_HZ,
  DEFAULT_SUPPLY_VOLTAGE,
} from '../../values/electric';

interface InstrumentPropertiesEditorProps {
  x: number;
  y: number;
  component: PlacedComponent;
  onSave: (patch: Partial<PlacedComponent>) => void;
  onClose: () => void;
}

function clampNumber(value: number, min: number, max?: number): number {
  const floored = Math.max(min, value);
  return max !== undefined ? Math.min(max, floored) : floored;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

interface NumberStepperProps<TUnit extends string = string> {
  value: string;
  onChange: (value: string) => void;
  min: number;
  max?: number;
  step: number;
  decimals?: number;
  coarseStep?: number;
  units?: readonly TUnit[];
  unit?: TUnit;
  onUnitChange?: (unit: TUnit) => void;
  unitLabels?: Record<TUnit, string>;
  staticUnit?: string;
  'aria-label': string;
}

function NumberStepper<TUnit extends string = string>({
  value,
  onChange,
  min,
  max,
  step,
  decimals = 1,
  coarseStep,
  units,
  unit,
  onUnitChange,
  unitLabels,
  staticUnit,
  'aria-label': ariaLabel,
}: NumberStepperProps<TUnit>) {
  const adjust = (delta: number) => {
    const current = Number.parseFloat(value);
    const base = Number.isFinite(current) ? current : min;
    const next = roundTo(clampNumber(base + delta, min, max), decimals);
    onChange(String(next));
  };

  const unitControl =
    staticUnit !== undefined ? (
      <span className="number-stepper-unit">{staticUnit}</span>
    ) : units !== undefined && unit !== undefined && onUnitChange && unitLabels ? (
      <select
        className="number-stepper-unit-select"
        value={unit}
        onChange={(e) => onUnitChange(e.target.value as TUnit)}
        aria-label={`${ariaLabel} unit`}
      >
        {units.map((u) => (
          <option key={u} value={u}>
            {unitLabels[u]}
          </option>
        ))}
      </select>
    ) : null;

  if (coarseStep !== undefined) {
    return (
      <div className="number-stepper-dual">
        <div className="number-stepper-dual-value">
          <input
            className="number-stepper-input number-stepper-input-wide"
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            aria-label={ariaLabel}
            onChange={(e) => onChange(e.target.value)}
          />
          {unitControl}
        </div>
        <div className="number-stepper-dual-controls">
          <button
            type="button"
            className="number-stepper-btn is-coarse"
            aria-label={`Decrease ${ariaLabel} by ${coarseStep}`}
            onClick={() => adjust(-coarseStep)}
          >
            −{coarseStep}
          </button>
          <button
            type="button"
            className="number-stepper-btn is-fine"
            aria-label={`Decrease ${ariaLabel} by ${step}`}
            onClick={() => adjust(-step)}
          >
            −{step}
          </button>
          <button
            type="button"
            className="number-stepper-btn is-fine"
            aria-label={`Increase ${ariaLabel} by ${step}`}
            onClick={() => adjust(step)}
          >
            +{step}
          </button>
          <button
            type="button"
            className="number-stepper-btn is-coarse"
            aria-label={`Increase ${ariaLabel} by ${coarseStep}`}
            onClick={() => adjust(coarseStep)}
          >
            +{coarseStep}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="number-stepper">
      <button
        type="button"
        className="number-stepper-btn"
        aria-label={`Decrease ${ariaLabel} by ${step}`}
        onClick={() => adjust(-step)}
      >
        −
      </button>
      <input
        className="number-stepper-input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="number-stepper-btn"
        aria-label={`Increase ${ariaLabel} by ${step}`}
        onClick={() => adjust(step)}
      >
        +
      </button>
      {unitControl}
    </div>
  );
}

function initialCurrentLimitState(component: PlacedComponent): {
  value: string;
  unit: CurrentUnit;
} {
  if (component.supplyCurrentLimit !== undefined) {
    return {
      value: String(component.supplyCurrentLimit),
      unit: component.supplyCurrentLimitUnit ?? DEFAULT_SUPPLY_CURRENT_LIMIT_UNIT,
    };
  }

  const legacyMa = component.supplyCurrentLimitMa;
  if (legacyMa === 0) {
    return { value: '0', unit: 'A' };
  }
  if (legacyMa !== undefined && Number.isFinite(legacyMa)) {
    if (legacyMa >= 1000 && legacyMa % 1000 === 0) {
      return { value: String(legacyMa / 1000), unit: 'A' };
    }
    return { value: String(legacyMa), unit: 'mA' };
  }

  return { value: '1', unit: 'A' };
}

export function InstrumentPropertiesEditor({
  x,
  y,
  component,
  onSave,
  onClose,
}: InstrumentPropertiesEditorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useClampToViewport(panelRef, x, y);
  const onCloseRef = useRef(onClose);
  const onSaveRef = useRef(onSave);

  const [supplyVoltage, setSupplyVoltage] = useState(
    String(component.supplyVoltage ?? DEFAULT_SUPPLY_VOLTAGE),
  );
  const [supplyVoltageUnit, setSupplyVoltageUnit] = useState<VoltageUnit>(
    component.supplyVoltageUnit ?? DEFAULT_SUPPLY_VOLTAGE_UNIT,
  );
  const [supplyEnabled, setSupplyEnabled] = useState(
    component.supplyEnabled !== false,
  );
  const initialCurrentLimit = initialCurrentLimitState(component);
  const [supplyCurrentLimit, setSupplyCurrentLimit] = useState(initialCurrentLimit.value);
  const [supplyCurrentLimitUnit, setSupplyCurrentLimitUnit] = useState<CurrentUnit>(
    initialCurrentLimit.unit,
  );
  const [oscillatorFrequencyHz, setOscillatorFrequencyHz] = useState(
    String(component.oscillatorFrequencyHz ?? DEFAULT_OSCILLATOR_FREQUENCY_HZ),
  );
  const [oscillatorEnabled, setOscillatorEnabled] = useState(
    component.oscillatorEnabled !== false,
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

  const handleVoltageUnitChange = (nextUnit: VoltageUnit) => {
    const parsed = parseSupplyNumeric(supplyVoltage);
    if (parsed !== null) {
      const converted = convertVoltageValue(parsed, supplyVoltageUnit, nextUnit);
      const { decimals } = voltageStepConfig(nextUnit);
      setSupplyVoltage(String(roundTo(converted, decimals)));
    }
    setSupplyVoltageUnit(nextUnit);
  };

  const handleCurrentUnitChange = (nextUnit: CurrentUnit) => {
    const parsed = parseSupplyNumeric(supplyCurrentLimit);
    if (parsed !== null) {
      const converted = convertCurrentValue(parsed, supplyCurrentLimitUnit, nextUnit);
      const { decimals } = currentStepConfig(nextUnit);
      setSupplyCurrentLimit(String(roundTo(converted, decimals)));
    }
    setSupplyCurrentLimitUnit(nextUnit);
  };

  const handleSave = () => {
    if (component.type === 'power_supply') {
      const voltage = parseSupplyNumeric(supplyVoltage);
      if (voltage === null || voltage < 0) {
        setError('Voltage must be 0 or greater.');
        return;
      }
      const limit = parseSupplyNumeric(supplyCurrentLimit);
      if (limit === null || limit < 0) {
        setError('Current limit must be 0 (unlimited) or greater.');
        return;
      }
      onSaveRef.current({
        supplyVoltage: voltage,
        supplyVoltageUnit,
        supplyEnabled,
        supplyCurrentLimit: limit,
        supplyCurrentLimitUnit,
      });
      onCloseRef.current();
      return;
    }

    if (component.type === 'oscillator') {
      const freq = Number.parseFloat(oscillatorFrequencyHz);
      if (!Number.isFinite(freq) || freq <= 0 || freq > 100) {
        setError('Frequency must be between 0.01 and 100 Hz.');
        return;
      }
      onSaveRef.current({ oscillatorFrequencyHz: freq, oscillatorEnabled });
      onCloseRef.current();
    }
  };

  const voltageSteps = voltageStepConfig(supplyVoltageUnit);
  const currentSteps = currentStepConfig(supplyCurrentLimitUnit);
  const title =
    component.type === 'power_supply' ? 'Power supply' : 'Oscillator';

  return createPortal(
    <div
      ref={panelRef}
      className="resistor-value-editor instrument-properties-editor"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`${title} properties`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="resistor-value-editor-title">{title}</div>

      {component.type === 'power_supply' && (
        <div className="instrument-properties-form">
          <div className="instrument-prop-row instrument-prop-row-stepper">
            <span className="instrument-prop-label">Output</span>
            <NumberStepper
              value={supplyVoltage}
              onChange={(next) => {
                setSupplyVoltage(next);
                setError(null);
              }}
              min={0}
              step={voltageSteps.step}
              coarseStep={voltageSteps.coarseStep}
              decimals={voltageSteps.decimals}
              units={VOLTAGE_UNITS}
              unit={supplyVoltageUnit}
              onUnitChange={handleVoltageUnitChange}
              unitLabels={VOLTAGE_UNIT_LABELS}
              aria-label="output voltage"
            />
          </div>
          <div className="instrument-prop-row instrument-prop-row-stepper">
            <span className="instrument-prop-label">Current limit</span>
            <NumberStepper
              value={supplyCurrentLimit}
              onChange={(next) => {
                setSupplyCurrentLimit(next);
                setError(null);
              }}
              min={0}
              step={currentSteps.step}
              coarseStep={currentSteps.coarseStep}
              decimals={currentSteps.decimals}
              units={CURRENT_UNITS}
              unit={supplyCurrentLimitUnit}
              onUnitChange={handleCurrentUnitChange}
              unitLabels={CURRENT_UNIT_LABELS}
              aria-label="current limit"
            />
          </div>
          <p className="instrument-properties-hint">
            CV below limit · CC sags voltage when load would exceed limit
          </p>
          <label className="instrument-prop-toggle">
            <input
              type="checkbox"
              checked={supplyEnabled}
              onChange={(e) => setSupplyEnabled(e.target.checked)}
            />
            <span>Enabled</span>
          </label>
        </div>
      )}

      {component.type === 'oscillator' && (
        <div className="instrument-properties-form">
          <div className="instrument-prop-row">
            <span className="instrument-prop-label">Frequency</span>
            <NumberStepper
              value={oscillatorFrequencyHz}
              onChange={(next) => {
                setOscillatorFrequencyHz(next);
                setError(null);
              }}
              min={0.01}
              max={100}
              step={0.1}
              staticUnit="Hz"
              decimals={2}
              aria-label="frequency"
            />
          </div>
          <label className="instrument-prop-toggle">
            <input
              type="checkbox"
              checked={oscillatorEnabled}
              onChange={(e) => setOscillatorEnabled(e.target.checked)}
            />
            <span>Enabled</span>
          </label>
          <p className="instrument-properties-hint">Square wave · 50% duty</p>
        </div>
      )}

      {error && <div className="resistor-value-editor-error">{error}</div>}

      <div className="resistor-value-editor-actions">
        <button type="button" className="resistor-value-editor-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="resistor-value-editor-btn primary"
          onClick={handleSave}
        >
          Save
        </button>
      </div>
    </div>,
    document.body,
  );
}

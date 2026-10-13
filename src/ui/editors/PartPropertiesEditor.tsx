/** Shared form for part-owned field schemas; specialized editors keep their own UI.
 *
# Changelog
# Date       | Author | Remarks
# 13-10-2026 | Codex | Add shared form for resistor/capacitors/LED/RTC, first-input focus, validation, Apply/Cancel/Enter/Escape/outside dismissal.
#                     | Replaces ResistorValueEditor, CapacitorValueEditor, LedPropertiesEditor and Ds3231PropertiesEditor.
#                     | Unit selectors occupy separate labeled rows; LED color retains its swatch and presets.
#                     | Apply/Enter saves valid drafts; invalid numbers/selections keep the form open. Cancel/Escape/outside click discards edits.
#                     | Reuse existing defaults and numeric/address parsers; persisted keys and project version remain unchanged.
#                     | Temporary migration tests were run and subsequently removed at the project owner’s request.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PlacedComponent } from '../../types';
import type { PartEditorProps, PartProperties, PartPropertyField } from '../../components/partModule';
import { useClampToViewport } from './popup';

export type PropertyDraft = Record<string, string | boolean>;

export function createPropertyDraft(properties: PartProperties, component: PlacedComponent): PropertyDraft {
  const defaults = properties.defaults?.() ?? {};
  return Object.fromEntries((properties.fields ?? []).map(field => {
    const value = component[field.key] ?? defaults[field.key];
    return [field.key, field.kind === 'boolean' ? Boolean(value)
      : typeof value === 'number' && field.format ? field.format(value) : String(value ?? '')];
  }));
}

export function parsePropertyDraft(fields: readonly PartPropertyField[], draft: PropertyDraft):
  { patch: Partial<PlacedComponent>; error?: never } | { error: string; patch?: never } {
  const entries: [string, string | number | boolean][] = [];
  for (const field of fields) {
    const raw = draft[field.key];
    let value: string | number | boolean;
    if (field.kind === 'boolean') {
      if (typeof raw !== 'boolean') return { error: `Invalid ${field.label}` };
      value = raw;
    } else if (field.kind === 'select' || field.kind === 'color') {
      if (typeof raw !== 'string' || !field.options?.some(option => option.value === raw)) {
        return { error: `Select a valid ${field.label.toLowerCase()}` };
      }
      value = raw;
    } else {
      const text = String(raw ?? '');
      const parsed = field.parse ? field.parse(text) : text.trim() ? Number(text) : null;
      if (parsed === null || !Number.isFinite(parsed) || (field.kind === 'integer' && !Number.isInteger(parsed))) {
        return { error: field.error ?? `Enter a valid ${field.label.toLowerCase()}` };
      }
      value = parsed;
    }
    entries.push([field.key, value]);
  }
  return { patch: Object.fromEntries(entries) as Partial<PlacedComponent> };
}

export function PartPropertiesEditor({ properties, title, component, x, y, onSave, onClose }:
  PartEditorProps & { properties: PartProperties; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClampToViewport(ref, x, y);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [draft, setDraft] = useState(() => createPropertyDraft(properties, component));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLInputElement>('input');
    first?.focus();
    if (first?.type === 'text') first.select();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) closeRef.current();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  const change = (key: string, value: string | boolean) => {
    setDraft(previous => ({ ...previous, [key]: value }));
    setError(null);
  };
  return createPortal(
    <div ref={ref} className="resistor-value-editor" style={{ left: pos.x, top: pos.y }}
      role="dialog" aria-label={title} onPointerDown={event => event.stopPropagation()}>
      <div className="resistor-value-editor-title">{title}</div>
      <form className="resistor-value-editor-form" onSubmit={event => {
        event.preventDefault();
        const result = parsePropertyDraft(properties.fields ?? [], draft);
        if (result.error !== undefined) { setError(result.error); return; }
        onSave(result.patch);
        onClose();
      }}>
        {(properties.fields ?? []).map(field => (
          <div key={field.key}>
            <label className="resistor-value-editor-row">
              <span className="resistor-value-editor-label">{field.label}</span>
              <span className="resistor-value-editor-field-group">
                {field.kind === 'color' && <span className="led-color-swatch" style={{ backgroundColor: String(draft[field.key]) }} aria-hidden />}
                {field.kind === 'select' || field.kind === 'color' ? (
                  <select className="resistor-value-editor-select resistor-value-editor-select-fill"
                    aria-label={field.label} value={String(draft[field.key])} onChange={event => change(field.key, event.target.value)}>
                    {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : field.kind === 'boolean' ? (
                  <input type="checkbox" aria-label={field.label} checked={Boolean(draft[field.key])}
                    onChange={event => change(field.key, event.target.checked)} />
                ) : (
                  <input type="text" inputMode={field.format ? 'text' : 'decimal'} className="resistor-value-editor-input"
                    aria-label={field.label} value={String(draft[field.key])} spellCheck={false} autoComplete="off"
                    onChange={event => change(field.key, event.target.value)} />
                )}
                {field.unit && <span className="resistor-value-editor-unit">{field.unit}</span>}
              </span>
            </label>
            {field.hint && <p className="resistor-value-editor-hint">{field.hint}</p>}
          </div>
        ))}
        {error && <div className="resistor-value-editor-error" role="alert">{error}</div>}
        <div className="resistor-value-editor-actions">
          <button type="button" className="resistor-value-editor-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="resistor-value-editor-btn primary">Apply</button>
        </div>
      </form>
    </div>, document.body,
  );
}

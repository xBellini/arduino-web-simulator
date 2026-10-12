/**
 * What: Floating editor for parallel LCD background + character color presets.
 * Role: SimCanvas opens on double-click / context menu when the LCD module is editable.
 *
 * Changelog:
 * - 09-10-2026 — Moved from `src/components/LcdPropertiesEditor.tsx` (tree reorganization); added Changelog
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useClampToViewport } from './popup';
import { createHd44780 } from '../../avr/hd44780';
import {
  LCD_BACKGROUND_PRESETS,
  LCD_CHARACTER_PRESETS,
  lcdSegmentColor,
  type LcdBackgroundHex,
  type LcdCharacterHex,
  type LcdPropertiesPatch,
} from '../../values/lcd';

interface LcdPropertiesEditorProps {
  x: number;
  y: number;
  title: string;
  initialBackground: LcdBackgroundHex;
  initialCharacter: LcdCharacterHex;
  onSave: (patch: LcdPropertiesPatch) => void;
  onClose: () => void;
}

const PREVIEW_COLS = 16;
const PREVIEW_ROWS = 1;
/** Classic Arduino LiquidCrystal demo text. */
const PREVIEW_LINES = ['Hello, World!'] as const;

function LcdGlassPreview({
  background,
  character,
  segment,
}: {
  background: string;
  character: string;
  segment: string;
}): ReactNode {
  const glyphs = useMemo(() => {
    const ic = createHd44780({ cols: PREVIEW_COLS, rows: PREVIEW_ROWS });
    return PREVIEW_LINES.map((line) => {
      const codes: number[] = [];
      for (let c = 0; c < PREVIEW_COLS; c++) {
        const ch = line[c];
        codes.push(ch ? ch.charCodeAt(0) : 0x20);
      }
      return codes.map((code) => ic.glyphBitmap(code));
    });
  }, []);

  const glassW = 248;
  const glassH = 28;
  const cellW = glassW / PREVIEW_COLS;
  const cellH = glassH / PREVIEW_ROWS;
  const padX = cellW * 0.1;
  const padY = cellH * 0.12;
  const pixW = (cellW - padX * 2) / 5;
  const pixH = (cellH - padY * 2) / 8;

  const cells: ReactNode[] = [];
  for (let r = 0; r < PREVIEW_ROWS; r++) {
    for (let c = 0; c < PREVIEW_COLS; c++) {
      const bitmap = glyphs[r]![c]!;
      const ox = c * cellW + padX;
      const oy = r * cellH + padY;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 5; x++) {
          cells.push(
            <rect
              key={`${r}-${c}-${y}-${x}`}
              x={ox + x * pixW}
              y={oy + y * pixH}
              width={Math.max(0.4, pixW * 0.82)}
              height={Math.max(0.4, pixH * 0.82)}
              fill={bitmap[y]?.[x] ? character : segment}
            />,
          );
        }
      }
    }
  }

  return (
    <svg
      className="lcd-color-preview-glass"
      viewBox={`0 0 ${glassW} ${glassH}`}
      width="100%"
      role="img"
      aria-label="LCD preview: Hello, World!"
    >
      <rect
        x={0}
        y={0}
        width={glassW}
        height={glassH}
        rx={2}
        ry={2}
        fill={background}
      />
      {cells}
    </svg>
  );
}

export function LcdPropertiesEditor({
  x,
  y,
  title,
  initialBackground,
  initialCharacter,
  onSave,
  onClose,
}: LcdPropertiesEditorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useClampToViewport(panelRef, x, y);
  const onCloseRef = useRef(onClose);
  const onSaveRef = useRef(onSave);

  const [background, setBackground] =
    useState<LcdBackgroundHex>(initialBackground);
  const [character, setCharacter] =
    useState<LcdCharacterHex>(initialCharacter);

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

  const segment = lcdSegmentColor(background);

  const trySave = () => {
    onSaveRef.current({
      lcdBackgroundColor: background,
      lcdCharacterColor: character,
    });
    onCloseRef.current();
  };

  return createPortal(
    <div
      ref={panelRef}
      className="resistor-value-editor lcd-properties-editor"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={title}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="resistor-value-editor-title">{title}</div>
      <form
        className="resistor-value-editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          trySave();
        }}
      >
        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">Background</span>
          <span className="resistor-value-editor-field-group">
            <span
              className="led-color-swatch"
              style={{ backgroundColor: background }}
              aria-hidden
            />
            <select
              className="resistor-value-editor-select resistor-value-editor-select-fill"
              value={background}
              onChange={(e) =>
                setBackground(e.target.value as LcdBackgroundHex)
              }
              aria-label="LCD background preset"
            >
              {LCD_BACKGROUND_PRESETS.map((option) => (
                <option key={option.hex} value={option.hex}>
                  {option.label}
                </option>
              ))}
            </select>
          </span>
        </label>

        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">Characters</span>
          <span className="resistor-value-editor-field-group">
            <span
              className="led-color-swatch"
              style={{ backgroundColor: character }}
              aria-hidden
            />
            <select
              className="resistor-value-editor-select resistor-value-editor-select-fill"
              value={character}
              onChange={(e) =>
                setCharacter(e.target.value as LcdCharacterHex)
              }
              aria-label="LCD character color preset"
            >
              {LCD_CHARACTER_PRESETS.map((option) => (
                <option key={option.hex} value={option.hex}>
                  {option.label}
                </option>
              ))}
            </select>
          </span>
        </label>

        <div className="lcd-color-preview">
          <LcdGlassPreview
            background={background}
            character={character}
            segment={segment}
          />
          <span className="lcd-color-preview-caption">Preview</span>
        </div>

        <div className="resistor-value-editor-actions">
          <button
            type="button"
            className="resistor-value-editor-btn"
            onClick={onClose}
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

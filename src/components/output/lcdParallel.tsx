/**
 * What: Shared parallel HD44780 LCD PartModule factory (16×2 / 20×4).
 * Role: GPIO E-edge latch into vendored IC + glass glyph overlay. Not the IC itself.
 * Owns/exports: `createParallelLcdModule`, `feedLcdParallelBus`, `clearLcdSimState`,
 * `setLcdGpioProbeActive`, `isParallelLcdType`, `parallelLcdGeometry`.
 * Conventions: pin ids match registry parallel LCDs (rs/rw/en/db0–db7). Glass rect is in
 * design/viewBox units of the part SVG. Cycle-accurate EN edges come from
 * the AVR worker (`src/avr/workerHost.ts` → `feedLcdParallelBus`) during Run; frame
 * `evaluate` is a fallback only.
 * Not-here: I2C backpack; HD44780 core — see `src/avr/hd44780.ts`.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Changelog creation / parallel LCD module factory
#                     | GPIO probe feeds bus; evaluate skips latch while probe active
#                     | Per-instance background + highlight colors (properties panel)
# 09-10-2026 | Cursor | Header: EN edges come from avrWorkerHost (unused lcdGpioProbe.ts deleted)
#                     | Moved from `src/parts/lcdParallel.tsx` (tree reorganization)
# 13-10-2026 | Codex | Forward variant palette metadata; register custom LCD editor preserving color preview.
#                     | Show solved HIGH/LOW/FLOATING on directly connected data/control wires; representative source-backed nominal loads supply solved controller/backlight currents.
 */
import { LcdPropertiesEditor } from '../../ui/editors/LcdPropertiesEditor';
import type { ReactNode } from 'react';
import {
  createHd44780,
  createParallelLatch,
  latchParallelOnEnableFall,
  type Hd44780,
  type Hd44780ParallelLatch,
  type ParallelPinLevels,
} from '../../avr/hd44780';
import type { ComponentRegistryEntry } from '../../types';
import {
  DEFAULT_LCD_BACKGROUND,
  DEFAULT_LCD_CHARACTER,
  lcdColorsFromComponent,
  loadLcdColorFields,
} from '../../values/lcd';
import type { EvaluateCtx, PartModule, PartOverlayProps } from '../partModule';

export interface LcdGlassRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParallelLcdSpec {
  palette?: import('../../types').PaletteMetadata;
  type: string;
  label: string;
  cols: number;
  rows: number;
  scale: number;
  artwork: string;
  pins: ComponentRegistryEntry['pins'];
  /** Character grid area over the SVG glass. */
  glass: LcdGlassRect;
}

const icById = new Map<string, Hd44780>();
const latchById = new Map<string, Hd44780ParallelLatch>();

/** True while `attachLcdGpioProbe` owns EN-edge sampling (AVR run). */
let gpioProbeActive = false;

export function setLcdGpioProbeActive(active: boolean): void {
  gpioProbeActive = active;
}

export function isParallelLcdType(type: string): boolean {
  return type === 'lcd_16x2' || type === 'lcd_20x4';
}

export function parallelLcdGeometry(type: string): { cols: number; rows: number } {
  if (type === 'lcd_20x4') return { cols: 20, rows: 4 };
  return { cols: 16, rows: 2 };
}

function ensureInstance(id: string, cols: number, rows: number): {
  ic: Hd44780;
  latch: Hd44780ParallelLatch;
} {
  let ic = icById.get(id);
  let latch = latchById.get(id);
  if (!ic) {
    ic = createHd44780({ cols, rows });
    icById.set(id, ic);
  }
  if (!latch) {
    latch = createParallelLatch();
    latchById.set(id, latch);
  }
  return { ic, latch };
}

/** Cycle-accurate bus feed from {@link attachLcdGpioProbe}. */
export function feedLcdParallelBus(
  componentId: string,
  cols: number,
  rows: number,
  pins: ParallelPinLevels,
): void {
  const { ic, latch } = ensureInstance(componentId, cols, rows);
  latchParallelOnEnableFall(ic, latch, pins);
}

/** Drop IC state when sim stops (fresh begin() on next Run). */
export function clearLcdSimState(componentId?: string): void {
  if (componentId) {
    icById.delete(componentId);
    latchById.delete(componentId);
    return;
  }
  icById.clear();
  latchById.clear();
}

function pinHigh(ctx: EvaluateCtx, pinId: string): boolean {
  const net = ctx.pinNet(pinId);
  const level = ctx.netLevel(net);
  return level === 'high';
}

function LcdGlassOverlay({
  componentId,
  cols,
  rows,
  glass,
  simRunning,
  colors,
}: {
  componentId: string;
  cols: number;
  rows: number;
  glass: LcdGlassRect;
  simRunning?: boolean;
  colors: ReturnType<typeof lcdColorsFromComponent>;
}): ReactNode {
  if (!simRunning) return null;
  const ic = icById.get(componentId);
  const { background, character, segment } = colors;
  if (!ic || !ic.isDisplayOn()) {
    return (
      <rect
        x={glass.x}
        y={glass.y}
        width={glass.width}
        height={glass.height}
        fill={background}
        opacity={0.85}
        pointerEvents="none"
      />
    );
  }

  const cellW = glass.width / cols;
  const cellH = glass.height / rows;
  const padX = cellW * 0.08;
  const padY = cellH * 0.08;
  const pixW = (cellW - padX * 2) / 5;
  const pixH = (cellH - padY * 2) / 8;
  const on = character;
  const off = segment;

  const cells: ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const code = ic.getCell(c, r);
      const bitmap = ic.glyphBitmap(code);
      const ox = glass.x + c * cellW + padX;
      const oy = glass.y + r * cellH + padY;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 5; x++) {
          cells.push(
            <rect
              key={`${r}-${c}-${y}-${x}`}
              x={ox + x * pixW}
              y={oy + y * pixH}
              width={Math.max(0.15, pixW * 0.85)}
              height={Math.max(0.15, pixH * 0.85)}
              fill={bitmap[y]?.[x] ? on : off}
              pointerEvents="none"
            />,
          );
        }
      }
      if (ic.isCursorAt(c, r) && ic.cursorFlags()) {
        cells.push(
          <rect
            key={`cur-${r}-${c}`}
            x={ox}
            y={oy + 7 * pixH}
            width={5 * pixW * 0.85}
            height={Math.max(0.2, pixH * 0.85)}
            fill={on}
            opacity={0.9}
            pointerEvents="none"
          />,
        );
      }
    }
  }

  return (
    <g className="lcd-glass-overlay" pointerEvents="none">
      <rect
        x={glass.x}
        y={glass.y}
        width={glass.width}
        height={glass.height}
        fill={background}
        opacity={0.9}
      />
      {cells}
    </g>
  );
}

// Representative nominal 5 V loads, shared by the generic 16x2 and 20x4 parts.
// Source: Newhaven NHD-0216K1Z-NSW-BBW-L, Electrical Characteristics, PDF page 6:
// https://newhavendisplay.com/content/specs/NHD-0216K1Z-NSW-BBW-L.pdf
// Typical IDD = 1 mA and ILED = 32 mA at 5 V. These are reference-module
// ratings, not universal LCD ratings. Equivalent resistors reproduce that
// operating point only; no claim of a measured I/V curve or damage model.
// Both SPICE and legacy stamp the loads; overlays read solved branch currents.
const LCD_LOADS = [
  { branch: 'logic', positive: 'vcc', negative: 'gnd', ohms: 5 / 0.001 },
  { branch: 'backlight', positive: 'led_a', negative: 'led_k', ohms: 5 / 0.032 },
] as const;
const LCD_SIGNALS = new Set(['rs', 'rw', 'en', ...Array.from({ length: 8 }, (_, i) => 'db' + i)]);

export function createParallelLcdModule(spec: ParallelLcdSpec): PartModule {
  const { type, label, cols, rows, scale, artwork, pins, glass } = spec;

  return {
    palette: spec.palette,
    type,

    definition: {
      type,
      label,
      scale,
      artwork,
      pins,
    },

    spiceStamp(ctx) {
      for (const load of LCD_LOADS) {
        const a = ctx.pinNet(load.positive), b = ctx.pinNet(load.negative);
        if (a === null || b === null || a === b) continue;
        const sense = 'V' + ctx.sid + '_' + load.branch;
        const internal = ctx.sid + '_' + load.branch + '_sense';
        ctx.line(sense + ' ' + ctx.node(a) + ' ' + internal + ' 0');
        ctx.line('R' + ctx.sid + '_' + load.branch + ' ' + internal + ' ' + ctx.node(b) + ' ' + load.ohms);
        ctx.instance(sense, load.branch);
      }
    },
    legacyStamp(ctx) {
      for (const load of LCD_LOADS) {
        const a = ctx.pinNet(load.positive), b = ctx.pinNet(load.negative);
        if (a !== null && b !== null) ctx.stampResistor(a, b, load.ohms, load.branch);
      }
    },
    wireCurrentPath(pin) {
      return LCD_LOADS.find(load => pin === load.positive || pin === load.negative);
    },
    wireLogicLevel(pin, level) {
      return LCD_SIGNALS.has(pin) ? level(pin) : undefined;
    },

    evaluate(ctx) {
      // Frame-rate net samples miss µs-scale EN pulses; GPIO probe owns latching
      // while the AVR is running. Fallback path keeps circuit-only / tests working.
      if (gpioProbeActive) return;
      const db = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => pinHigh(ctx, `db${i}`));
      feedLcdParallelBus(ctx.comp.id, cols, rows, {
        rs: pinHigh(ctx, 'rs'),
        rw: pinHigh(ctx, 'rw'),
        en: pinHigh(ctx, 'en'),
        db,
      });
    },

    properties: {
      Editor: ({ component, x, y, onSave, onClose }) => (
        <LcdPropertiesEditor x={x} y={y} title={cols + '×' + rows + ' LCD display'}
          initialBackground={lcdColorsFromComponent(component).background}
          initialCharacter={lcdColorsFromComponent(component).character}
          onSave={onSave} onClose={onClose} />
      ),
      defaults: () => ({
        lcdBackgroundColor: DEFAULT_LCD_BACKGROUND,
        lcdCharacterColor: DEFAULT_LCD_CHARACTER,
      }),
      load(raw, into) {
        loadLcdColorFields(raw, into);
      },
    },

    overlay(props: PartOverlayProps) {
      if (!props.simRunning) {
        clearLcdSimState(props.component.id);
        return null;
      }
      return (
        <LcdGlassOverlay
          componentId={props.component.id}
          cols={cols}
          rows={rows}
          glass={glass}
          simRunning={props.simRunning}
          colors={lcdColorsFromComponent(props.component)}
        />
      );
    },
  };
}

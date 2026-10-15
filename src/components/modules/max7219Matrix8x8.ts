/**
 * What: MAX7219 8×8 LED matrix module as a placeable part — footprint and header pinout.
 * Role: package the worker's SimulIDE controller state as one five-pin module.
 * Display brightness maps the controller intensity to a visible color range;
 * this is presentation only, not solved LED current. Inactive lenses are black.
 * Supply validity requires a solved 4.0–5.5 V (MAX7219 datasheet operating range).
 * No supply-current model is available; current remains unavailable.
 * Owns/exports: `max7219Matrix8x8Module`.
 * Conventions: pin x/y in footprint space (SVG `data-terminal-*` minus viewBox min-x/min-y;
 * viewBox is `25 0 199 134`).
 * Controller behavior lives in libraries/simulide/max72xx.ts; bus glue in avr/max7219Bridge.ts.
 *
# Changelog
# Date       | Author | Remarks
# 03-10-2026 | Cursor | Changelog creation / moved out of STATIC_REGISTRY (definition only)
# 05-10-2026 | Cursor | Pin x: footprint space (terminal 32 − viewBox min-x 25 → 7)
# 09-10-2026 | Cursor | Moved from `src/parts/max7219Matrix8x8.ts` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
# 15-10-2026 | Codex | Add solved power gating and static matrix overlay from batched controller state; no blur or animation.
#                     | Treat pending DC results as unknown, not power loss, to preserve controller RAM across GPIO cache misses.
#                     | Paint all inactive pixels black, including stopped/unpowered modules; keep minimum intensity visibly colored.
#                     | Reference the relocated controller library directly for snapshot types; behavior unchanged.
#                     | Add saved module-wide LED color presets through the shared properties editor; preserve black off pixels and intensity scaling.
 */
import { createElement, useSyncExternalStore } from 'react';
import type { PartModule, PartOverlayProps } from '../partModule';
import type { Max72xxSnapshot } from '../../libraries/simulide/max72xx';

const LED_COLORS = [
  { value: '#ff8c64', label: 'Orange-red (default)' },
  { value: '#ff3030', label: 'Red' },
  { value: '#ffb000', label: 'Amber' },
  { value: '#ffff00', label: 'Yellow' },
  { value: '#30ff60', label: 'Green' },
  { value: '#4090ff', label: 'Blue' },
  { value: '#ffffff', label: 'White' },
];

const snapshots = new Map<string, Max72xxSnapshot>();
const power = new Map<string, boolean>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const max7219PowerSamples = () => [...power].map(([id, powered]) => ({ id, powered }));
export function setMax7219Snapshots(samples: Array<Max72xxSnapshot & { id: string }>): void {
  let changed = false;
  for (const sample of samples) {
    const old = snapshots.get(sample.id);
    if (old?.intensity === sample.intensity && old.rows.every((row, i) => row === sample.rows[i])) continue;
    snapshots.set(sample.id, sample);
    changed = true;
  }
  if (changed) for (const listener of listeners) listener();
}
export function clearMax7219Snapshots(): void {
  snapshots.clear();
  power.clear();
  for (const listener of listeners) listener();
}
function MatrixOverlay({ component, simRunning }: PartOverlayProps) {
  const state = useSyncExternalStore(subscribe, () => snapshots.get(component.id));
  // Presentation range keeps the selected color visible at register zero.
  const brightness = 0.35 + 0.65 * Math.max(0, Math.min(15, (state?.intensity ?? 1) - 1)) / 15;
  const color = LED_COLORS.find(option => option.value === component.ledColor)?.value ?? LED_COLORS[0].value;
  const fill = `rgb(${[1, 3, 5].map(offset => Math.round(parseInt(color.slice(offset, offset + 2), 16) * brightness)).join(',')})`;
  return createElement('g', { pointerEvents: 'none', 'data-max7219': component.id },
    Array.from({ length: 64 }, (_, pixel) => {
      const x = pixel % 8, y = Math.floor(pixel / 8);
      const lit = simRunning && state && (state.rows[y] & (0x80 >> x));
      return createElement('circle', {
        key: pixel, cx: 79.9 + 15.6 * x, cy: 9.9 + 15.6 * y, r: 5.55,
        fill: lit ? fill : '#000000',
      });
    }));
}

export const max7219Matrix8x8Module: PartModule = {
  palette: { category: 'modules', order: 10 },
  type: 'max7219_matrix_8x8',
  properties: {
    title: 'MAX7219 matrix properties',
    fields: [{ key: 'ledColor', label: 'LED color', kind: 'color', options: LED_COLORS }],
    defaults: () => ({ ledColor: LED_COLORS[0].value }),
    load(raw, into) {
      into.ledColor = LED_COLORS.find(option => option.value === raw.ledColor)?.value ?? LED_COLORS[0].value;
    },
  },
  applyDcResult: ({ comp, dc, pinNet }) => {
    // A cache miss is not a measured brownout. The initial solve is awaited by
    // the controller; later measured out-of-range supplies reset the worker IC.
    if (!dc) return;
    const positive = pinNet('vcc'), negative = pinNet('gnd');
    const vcc = positive === null ? undefined : dc?.netVoltages.get(positive);
    const gnd = negative === null ? undefined : dc?.netVoltages.get(negative);
    const voltage = vcc === undefined || gnd === undefined ? NaN : vcc - gnd;
    power.set(comp.id, voltage >= 4 && voltage <= 5.5);
  },
  overlay: props => createElement(MatrixOverlay, props),
  measurements: ({ voltage }) => [{ label: 'Supply', value: voltage('vcc', 'gnd'), unit: 'V' }],
  wireLogicLevel: (pin, level) => ['din', 'cs', 'clk'].includes(pin) ? level(pin) : undefined,

  definition: {
    type: 'max7219_matrix_8x8',
    label: 'MAX7219 8×8',
    scale: 2,
    artwork: '/components/max7219_matrix_8x8.svg',
    pins: [
      { id: 'vcc', description: 'VCC', x: 7, y: 52, type: 'power' },
      { id: 'gnd', description: 'GND', x: 7, y: 62, type: 'ground' },
      { id: 'din', description: 'DIN', x: 7, y: 72, type: 'digital' },
      { id: 'cs', description: 'CS', x: 7, y: 82, type: 'digital' },
      { id: 'clk', description: 'CLK', x: 7, y: 92, type: 'digital' },
    ],
  },
};

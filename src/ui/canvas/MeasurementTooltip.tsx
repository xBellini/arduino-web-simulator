/**
 * What: One delayed, text-only measurement tooltip shared by canvas hit targets.
 * Reads the live store at most five times per second only while visible; updates
 * stay inside this component. Part-specific rows belong to PartModule.measurements.
 * Voltages and branch currents require solver samples; missing data is unavailable.
 * Pointer interaction, scrolling, leaving the canvas and unmount cancel all timers.
 *
# Changelog
# Date       | Author | Remarks
# 14-10-2026 | Codex | Add delayed hover readings with one panel, bounded updates and no animation/filter effects.
 */
import { memo, useEffect, useState, type RefObject } from 'react';
import { getPartModule } from '../../components';
import type { PartMeasurement } from '../../components/partModule';
import { buildCircuitNetlist, netForPin } from '../../circuit/netlist';
import { getDefinition } from '../../registry/components';
import { getSimLiveSnapshot } from '../../store/simLiveStore';
import type { PinRef, PlacedComponent, Wire } from '../../types';

type Props = { container: RefObject<HTMLDivElement | null>; components: PlacedComponent[]; wires: Wire[] };
type Panel = { title: string; rows: PartMeasurement[]; x: number; y: number };
const finite = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? value : undefined;

export function formatMeasurement(row: PartMeasurement): string {
  if (row.value === undefined || (typeof row.value === 'number' && !Number.isFinite(row.value))) return 'Unavailable';
  if (typeof row.value === 'string') return row.value;
  return `${Number(row.value.toPrecision(4))}${row.unit ? ` ${row.unit}` : ''}`;
}

export const MeasurementTooltip = memo(function MeasurementTooltip({ container, components, wires }: Props) {
  const [panel, setPanel] = useState<Panel | null>(null);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    // Net numbering uses the same topology builder and component order as the solver.
    const netlist = buildCircuitNetlist(components, wires);
    let hovered: Element | null = null;
    let delay: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setInterval> | undefined;
    let previous = '';
    const clear = () => {
      clearTimeout(delay); clearInterval(refresh);
      hovered = null; previous = ''; setPanel(null);
    };
    const move = (event: PointerEvent) => {
      if (event.buttons || event.pointerType === 'touch') { clear(); return; }
      const target = event.target instanceof Element ? event.target.closest('[data-measure-component], [data-measure-wire]') : null;
      if (target === hovered) return;
      clear();
      if (!target) return;
      hovered = target;
      const bounds = root.getBoundingClientRect();
      const x = Math.max(8, Math.min(event.clientX - bounds.left + 16, bounds.width - 288));
      const y = Math.max(8, Math.min(event.clientY - bounds.top + 16, bounds.height - 230));
      const sample = () => {
        const live = getSimLiveSnapshot();
        const debug = live.ngspiceDebug;
        const voltageAt = (pin: PinRef) => {
          const net = netForPin(netlist, pin);
          return net === null ? undefined : finite(debug?.netVoltages[net]);
        };
        const pinCurrent = (pin: PinRef) => {
          const part = components.find(c => c.id === pin.componentId);
          const path = part && getPartModule(part.type)?.wireCurrentPath?.(pin.pinId);
          if (!path) return undefined;
          const sample = finite(debug?.branchCurrentMa[path.branch ? `${pin.componentId}:${path.branch}` : pin.componentId]);
          return sample === undefined ? undefined : Math.abs(sample);
        };
        const component = components.find(c => c.id === target.getAttribute('data-measure-component'));
        const wire = wires.find(w => w.id === target.getAttribute('data-measure-wire'));
        const pinId = target.getAttribute('data-measure-pin');
        let title = 'Wire';
        let rows: PartMeasurement[];
        if (wire) {
          // A solitary connection carries the terminal's solved branch current,
          // including a genuine zero. Flow flags alone use zero for missing data.
          const leaf = [wire.from, wire.to].find(pin => wires.filter(w =>
            [w.from, w.to].some(p => p.componentId === pin.componentId && p.pinId === pin.pinId)).length === 1 && pinCurrent(pin) !== undefined);
          const flow = finite(live.simFlags.wireCurrentMa[wire.id]);
          rows = [
            { label: 'Voltage to circuit ground', value: voltageAt(wire.from), unit: 'V' },
            { label: 'Current magnitude', value: leaf ? pinCurrent(leaf) : flow !== undefined && flow > 0 ? flow : undefined, unit: 'mA' },
          ];
        } else if (component) {
          title = getDefinition(component.type).label;
          if (pinId) {
            const pin = getDefinition(component.type).pins.find(p => p.id === pinId);
            title += ` · ${pin?.description ?? pinId}`;
            const state = live.pinStatesByComponent[component.id]?.[pinId];
            rows = [
              { label: 'Voltage to circuit ground', value: voltageAt({ componentId: component.id, pinId }), unit: 'V' },
              { label: 'Terminal current magnitude', value: pinCurrent({ componentId: component.id, pinId }), unit: 'mA' },
              { label: 'Logic state', value: state?.toUpperCase() },
            ];
          } else {
            const current = finite(debug?.branchCurrentMa[component.id]);
            rows = getPartModule(component.type)?.measurements?.({
              component, flags: live.simFlags, currentMa: current === undefined ? undefined : Math.abs(current),
              voltage: (positive, negative) => {
                const a = voltageAt({ componentId: component.id, pinId: positive });
                const b = voltageAt({ componentId: component.id, pinId: negative });
                return a === undefined || b === undefined ? undefined : a - b;
              },
            }) ?? [{ label: 'Measurements', value: 'Hover a pin for voltage' }];
          }
        } else { clear(); return; }
        const next = { title, rows, x, y };
        // Solver noise below displayed precision does not need a React update.
        const key = JSON.stringify([title, rows.map(row => [row.label, formatMeasurement(row)]), x, y]);
        if (key !== previous) { previous = key; setPanel(next); }
      };
      delay = setTimeout(() => { sample(); refresh = setInterval(sample, 200); }, 400);
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerleave', clear);
    root.addEventListener('pointerdown', clear, true);
    root.addEventListener('wheel', clear, true);
    root.addEventListener('contextmenu', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      clearTimeout(delay); clearInterval(refresh);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerleave', clear);
      root.removeEventListener('pointerdown', clear, true);
      root.removeEventListener('wheel', clear, true);
      root.removeEventListener('contextmenu', clear, true);
      window.removeEventListener('blur', clear);
    };
  }, [container, components, wires]);
  if (!panel) return null;
  return <div role="tooltip" className="measurement-tooltip" style={{ left: panel.x, top: panel.y }}>
    <strong>{panel.title}</strong>
    <dl>{panel.rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{formatMeasurement(row)}</dd></div>)}</dl>
  </div>;
});

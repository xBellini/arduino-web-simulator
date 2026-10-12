/**
 * What: SVG `<g class="wire-flow-layer">` animating current along routed wires during sim. Exports
 * WireFlowOverlay; props wires, simFlags (wireCurrentMa map), getWirePath from SimCanvas geometry. Skips wires
 * when !wireShowsCurrent(ma); uses roundedPolylinePath, wireFlowDuration, reverse class from circuit/currents.
 * CSS animation via --wire-flow-duration on pulse paths (index.css @keyframes wire-flow-dash). To change
 * when flow appears or direction rules: edit circuit/currents helpers. To change look: index.css .wire-flow-*.
 * Static wire strokes and routing handles remain in SimCanvas — not this overlay.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/components/WireFlowOverlay.tsx` (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */
import type { CSSProperties } from 'react';
import type { Wire } from '../../types';
import type { ComponentSimFlags } from '../../circuit/solver';
import { formatCurrentMa } from '../../values/electric';
import { roundedPolylinePath } from './geometry';
import {
  labelAngleAlongPolyline,
  pointAlongPolyline,
  wireFlowDuration,
  wireShowsCurrent,
} from '../../circuit/currents';

interface WireFlowOverlayProps {
  wires: Wire[];
  simFlags: ComponentSimFlags;
  getWirePath: (wire: Wire) => { x: number; y: number }[] | null;
}

export function WireFlowOverlay({
  wires,
  simFlags,
  getWirePath,
}: WireFlowOverlayProps) {
  return (
    <g className="wire-flow-layer" aria-hidden>
      {wires.map((wire) => {
        const currentMa = simFlags.wireCurrentMa[wire.id];
        if (!wireShowsCurrent(currentMa)) return null;

        const points = getWirePath(wire);
        if (!points || points.length < 2) return null;

        const d = roundedPolylinePath(points);
        const reverse = simFlags.wireFlowReverse[wire.id] ?? false;
        const labelPoint = pointAlongPolyline(points, 0.5);
        const labelAngle = labelAngleAlongPolyline(points);
        const duration = wireFlowDuration(currentMa ?? 0);

        const labelText = formatCurrentMa(currentMa ?? 0);
        const labelWidth = Math.max(36, labelText.length * 5.5 + 14);
        const labelHeight = 14;

        return (
          <g
            key={`flow-${wire.id}`}
            className={`wire-flow-group${reverse ? ' is-reverse' : ''}`}
            style={{ '--wire-flow-duration': duration } as CSSProperties}
          >
            <path d={d} className="wire wire-flow-track" fill="none" />
            <path d={d} className="wire wire-flow-pulse" fill="none" />
            <g
              transform={`translate(${labelPoint.x}, ${labelPoint.y}) rotate(${labelAngle})`}
            >
              <rect
                x={-labelWidth / 2}
                y={-labelHeight / 2}
                width={labelWidth}
                height={labelHeight}
                rx={3}
                className="wire-current-label-bg"
              />
              <text
                textAnchor="middle"
                dominantBaseline="middle"
                className="wire-current-label"
                y={0}
              >
                {labelText}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

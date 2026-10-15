/**
 * What: SVG `<g class="wire-flow-layer">` animating current along routed wires during sim. Exports
 * WireFlowOverlay; props wires, simFlags (wireCurrentMa map), getWirePath from SimCanvas geometry. Skips wires
 * without current or an explicit reading label; uses roundedPolylinePath, wireFlowDuration, reverse class from circuit/currents.
 * CSS animation via --wire-flow-duration on pulse paths (index.css @keyframes wire-flow-dash). To change
 * when flow appears or direction rules: edit circuit/currents helpers. To change look: index.css .wire-flow-*.
 * Static wire strokes and routing handles remain in SimCanvas — not this overlay.
 * HIGH signals use a non-directional breathing highlight; its timing is decorative,
 * not a measurement of bus frequency or electrical current. LOW/FLOATING stay static.
 * Shared collinear stretches are painted once in stable wire order. Labels are culled separately;
 * hidden readings remain available on wire hover. Visual ownership never combines electrical readings.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Moved from `src/components/WireFlowOverlay.tsx` (tree reorganization)
# 13-10-2026 | Codex | Show sampled logic labels without current animation; retain existing current overlays.
#                     | Add a distinct breathing overlay for HIGH signals; LOW/FLOATING remain static.
# 15-10-2026 | Codex | Omit overlapping labels and their flow/signal overlays using padded rotated bounds; retain base wires and hover measurements.
#                     | Deduplicate shared path intervals including reverse/partial overlaps; preserve unique branches independently of label visibility and paint glow only on retained paths.
#                     | Cache overlay paths, shared intervals and label layout across viewport renders; invalidate on readings, routes or live wire edits.
 */
import { useMemo, type CSSProperties } from 'react';
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
  liveEditPath?: { x: number; y: number }[];
}

export function WireFlowOverlay({
  wires,
  simFlags,
  getWirePath,
  liveEditPath,
}: WireFlowOverlayProps) {
  const overlay = useMemo(() => {
  // These are SVG world coordinates, so pan/zoom needs no DOM measurement or layout pass.
  const labelBounds: { left: number; right: number; top: number; bottom: number }[] = [];
  const painted: { x: number; y: number }[][] = [];
  return (
    <g className="wire-flow-layer" aria-hidden>
      {wires.map((wire) => {
        const currentMa = simFlags.wireCurrentMa[wire.id];
        const explicitLabel = simFlags.wireReadingLabel?.[wire.id];
        const signalHigh = explicitLabel === 'HIGH';
        const isSignal = signalHigh || explicitLabel === 'LOW' || explicitLabel === 'FLOATING';
        const flowing = !isSignal && wireShowsCurrent(currentMa);
        if (!flowing && explicitLabel === undefined) return null;

        const points = getWirePath(wire);
        if (!points || points.length < 2) return null;

        const runs: { x: number; y: number }[][] = [];
        if (flowing || signalHigh) {
          for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i];
            const dx = b.x - a.x, dy = b.y - a.y;
            const length = Math.hypot(dx, dy);
            if (length < 1e-6) continue;
            const ux = dx / length, uy = dy / length;
            let intervals = [[0, length]];
            // Only collinear intervals overlap: a crossing or a nearby parallel wire is distinct.
            for (const [c, e] of painted) {
              if (Math.abs((c.x - a.x) * uy - (c.y - a.y) * ux) > 1e-6 ||
                  Math.abs((e.x - a.x) * uy - (e.y - a.y) * ux) > 1e-6) continue;
              const t0 = (c.x - a.x) * ux + (c.y - a.y) * uy;
              const t1 = (e.x - a.x) * ux + (e.y - a.y) * uy;
              const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
              intervals = intervals.flatMap(([start, end]) => {
                if (hi <= start || lo >= end) return [[start, end]];
                return [...(lo > start ? [[start, lo]] : []), ...(hi < end ? [[hi, end]] : [])];
              });
            }
            for (const [start, end] of intervals) {
              if (end - start < 1e-6) continue;
              const from = { x: a.x + ux * start, y: a.y + uy * start };
              const to = { x: a.x + ux * end, y: a.y + uy * end };
              const last = runs[runs.length - 1];
              if (last && Math.hypot(last[last.length - 1].x - from.x, last[last.length - 1].y - from.y) < 1e-6) last.push(to);
              else runs.push([from, to]);
              painted.push([from, to]);
            }
          }
        }
        const d = runs.map((run) => roundedPolylinePath(run)).join(' ');
        const reverse = simFlags.wireFlowReverse[wire.id] ?? false;
        const labelPoint = pointAlongPolyline(points, 0.5);
        const labelAngle = labelAngleAlongPolyline(points);
        const duration = wireFlowDuration(currentMa ?? 0);

        const labelText = explicitLabel ?? formatCurrentMa(currentMa ?? 0);
        const labelWidth = Math.max(36, labelText.length * 5.5 + 14);
        const labelHeight = 14;
        const radians = labelAngle * Math.PI / 180;
        const halfWidth = (Math.abs(Math.cos(radians)) * labelWidth + Math.abs(Math.sin(radians)) * labelHeight) / 2 + 2;
        const halfHeight = (Math.abs(Math.sin(radians)) * labelWidth + Math.abs(Math.cos(radians)) * labelHeight) / 2 + 2;
        const bounds = {
          left: labelPoint.x - halfWidth, right: labelPoint.x + halfWidth,
          top: labelPoint.y - halfHeight, bottom: labelPoint.y + halfHeight,
        };
        const showLabel = !labelBounds.some((other) =>
          bounds.left < other.right && bounds.right > other.left &&
          bounds.top < other.bottom && bounds.bottom > other.top,
        );
        if (showLabel) labelBounds.push(bounds);
        if (!d && !showLabel) return null;

        return (
          <g
            key={`flow-${wire.id}`}
            className={`wire-flow-group${reverse ? ' is-reverse' : ''}`}
            style={{ '--wire-flow-duration': duration } as CSSProperties}
          >
            {d && signalHigh && <path d={d} className="wire wire-signal-high" fill="none" />}
            {d && flowing && <path d={d} className="wire wire-current-glow" fill="none" />}
            {d && flowing && <path d={d} className="wire wire-flow-track" fill="none" />}
            {d && flowing && <path d={d} className="wire wire-flow-pulse" fill="none" />}
            {showLabel && <g
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
            </g>}
          </g>
        );
      })}
    </g>
  );
  }, [wires, getWirePath, liveEditPath, simFlags.wireCurrentMa, simFlags.wireReadingLabel, simFlags.wireFlowReverse]);
  return overlay;
}

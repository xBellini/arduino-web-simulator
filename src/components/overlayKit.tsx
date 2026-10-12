/**
 * What: Shared SVG chrome that more than one part overlay draws.
 * Role: keeps instrument-style parts (meters, supply, oscillator) visually identical without
 * any of them importing another part's file.
 * Owns/exports: `InstrumentReadout`.
 * Conventions: coordinates are the part's own SVG design space, so each caller passes the box
 * that fits its artwork display panel. Everything here is `pointerEvents="none"` — overlays
 * must never intercept canvas drags or pin clicks.
 * To add a primitive: put it here only once a second part needs it; a one-off belongs in that
 * part's own file.
 * Not-here: part-specific art (LED glow, resistor bands, pot knob) — those live with their part.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/parts/overlayKit.tsx` (tree reorganization)
 * - 25-09-2026 — Text baselines scale with panel height
 * - 17-09-2026 — Changelog creation / extracted from ComponentOverlays for part modules
 */

/** Dark LCD-style panel with a small label and a right-aligned monospace value. */
export function InstrumentReadout({
  x,
  y,
  width,
  height,
  label,
  value,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  value: string;
}) {
  const labelY = y + Math.min(9, height * 0.42);
  const valueY = y + height - Math.min(4, height * 0.22);
  return (
    <g className="instrument-readout" pointerEvents="none">
      <rect x={x} y={y} width={width} height={height} rx={2} fill="#1a1a1a" opacity={0.85} />
      <text x={x + 4} y={labelY} fill="#90a4ae" fontSize={7}>
        {label}
      </text>
      <text
        x={x + width - 4}
        y={valueY}
        textAnchor="end"
        fill="#c5e1a5"
        fontSize={9}
        fontFamily="ui-monospace, monospace"
      >
        {value}
      </text>
    </g>
  );
}

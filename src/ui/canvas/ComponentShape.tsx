/**
 * What: SVG `<g>` that renders one placed part on the canvas or in palette thumbnails. Owns
 * ComponentShape; reads getDesignDefinition/getDefinitionScale from the registry. Breadboard is the
 * only type drawn procedurally (BreadboardPackage + breadboardGrid coords); everything else uses
 * PartArtwork then ComponentOverlays. Outer className toggles selection and type-specific sim states
 * (button pressed, buzzer, resistor heat/blown); optional CSS var --over-power for resistor glow.
 * To show a new registry part: usually no change here if it has artwork — add pins/SVG in registry.
 * For sim-visible body state without overlay: extend the className/style block on `<g>` for that
 * component.type. For glow/bands/readouts: add a branch in ComponentOverlays, not here.
 *
 * Merged in from `src/components/PartArtwork.tsx`: Embeds registry SVG artwork as an SVG `<image>`
 * filling the part footprint (0,0 → width×height). Exports PartArtwork; props def:
 * ComponentDefinition, optional className (default part-artwork). Size comes from def.width/height
 * (viewBox-derived in registry — do not hardcode here). preserveAspectRatio is "none" so art aligns
 * with pin coordinates after ComponentShape scale transform. To add a part image: put file under
 * public/components/, set artwork:'/components/foo.svg' and matching width/height/pins in registry; no
 * PartArtwork edit unless you need a new class for CSS (e.g. filter). Breadboard body is NOT here —
 * ComponentShape BreadboardPackage. Overlays/sim HUD: ComponentOverlays.
 *
 * Merged in from `src/components/PinLabel.tsx`: Small SVG callout centered on a pin (local coords):
 * rounded rect + pin name text. Exports PinLabel; single prop label string. Width derived from
 * PIN_LABEL_* constants at file top; sits above pin dot using PIN_DOT_RADIUS + PIN_LABEL_GAP.
 * Parent `<g>` must translate to pin world position — SimCanvas pin layer. Styling via index.css
 * .pin-label-bg / .pin-label-text and .pin-interactive hover rules. To change typography or
 * padding: tweak constants here + CSS; to change when labels appear or which string: SimCanvas
 * wiring/hover logic. Snap radius and hit targets are geometry/SimCanvas — not PinLabel.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | [src/components/PinLabel.tsx] Changelog creation
#                     | [src/components/PinLabel.tsx] Expanded What with practical how-to notes
#                     | [src/components/PartArtwork.tsx] Changelog creation
#                     | [src/components/PartArtwork.tsx] Expanded What with practical how-to notes
#                     | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Merged `src/components/PartArtwork.tsx` into this file (tree reorganization)
#                     | Merged `src/components/PinLabel.tsx` into this file (tree reorganization)
#                     | Moved from `src/components/ComponentShape.tsx` (tree reorganization)
# 16-10-2026 | Codex | Subscribe button shapes directly to their pressed state; unrelated parts and editor UI stay untouched.
 */
import { useCallback, useSyncExternalStore, type CSSProperties } from 'react';
import { getButtonPressed, subscribeButtonPressed } from '../../store/simLiveStore';
import { getDesignDefinition, getDefinitionScale } from '../../registry/components';
import { BB_COLS, BB_IC_SLOT_BOTTOM, BB_IC_SLOT_TOP, BB_RAIL_BOT_MINUS_Y, BB_RAIL_BOT_PLUS_Y, BB_RAIL_TOP_MINUS_Y, BB_RAIL_TOP_PLUS_Y, holeX, tieBandRowYs, tieRowYs } from '../../registry/breadboardGrid';
import type { PlacedComponent, ComponentDefinition } from '../../types';
import type { ComponentSimFlags } from '../../avr/gpioBridge';
import { ComponentOverlays } from './ComponentOverlays';

const PIN_LABEL_FONT_SIZE = 9;
const PIN_LABEL_PAD_X = 5;
const PIN_LABEL_PAD_Y = 3;
const PIN_LABEL_CHAR_WIDTH = 5.3;
const PIN_LABEL_GAP = 5;
const PIN_DOT_RADIUS = 4;

type PinLabelProps = {
  label: string;
};

export function PinLabel({ label }: PinLabelProps) {
  const width = Math.max(
    Math.ceil(label.length * PIN_LABEL_CHAR_WIDTH + PIN_LABEL_PAD_X * 2),
    22,
  );
  const height = PIN_LABEL_FONT_SIZE + PIN_LABEL_PAD_Y * 2;
  const x = -width / 2;
  const y = -(PIN_DOT_RADIUS + PIN_LABEL_GAP + height);

  return (
    <g className="pin-label-box">
      <rect x={x} y={y} width={width} height={height} rx={3} className="pin-label-bg" />
      <text
        x={0}
        y={y + height / 2}
        className="pin-label-text"
        dominantBaseline="central"
        textAnchor="middle"
      >
        {label}
      </text>
    </g>
  );
}

interface PartArtworkProps {
  def: ComponentDefinition;
  className?: string;
}

export function PartArtwork({ def, className }: PartArtworkProps) {
  if (!def.artwork) return null;
  return (
    <image
      href={def.artwork}
      x={0}
      y={0}
      width={def.width}
      height={def.height}
      className={className ?? 'part-artwork'}
      // Footprint size matches the SVG viewBox; stretch uniformly via `scale`.
      preserveAspectRatio="none"
    />
  );
}

interface Props {
  component: PlacedComponent;
  selected?: boolean;
  simFlags?: ComponentSimFlags;
  simRunning?: boolean;
}

function BreadboardConnectionGuides({
  blockX,
  keyPrefix,
}: {
  blockX: (col: number) => number;
  keyPrefix: string;
}) {
  const pad = 7;
  return (
    <>
      {([0, 1] as const).flatMap((band) => {
        const rows = tieBandRowYs(band);
        const y1 = rows[0] - pad;
        const y2 = rows[rows.length - 1] + pad;
        return Array.from({ length: BB_COLS }, (_, c) => (
          <line
            key={`${keyPrefix}-col-${band}-${c}`}
            x1={blockX(c)}
            y1={y1}
            x2={blockX(c)}
            y2={y2}
            className="breadboard-col-line"
          />
        ));
      })}
    </>
  );
}

function BreadboardHoles({
  blockX,
  keyPrefix,
}: {
  blockX: (col: number) => number;
  keyPrefix: string;
}) {
  return (
    <>
      {Array.from({ length: BB_COLS }, (_, c) => (
        <g key={`${keyPrefix}-holes-${c}`}>
          {tieRowYs().map((y) => (
            <g key={`${keyPrefix}-${c}-${y}`}>
              <circle cx={blockX(c)} cy={y} r={3.5} className="breadboard-hole" />
              <circle cx={blockX(c)} cy={y} r={1.2} className="breadboard-hole-inner" />
            </g>
          ))}
        </g>
      ))}
    </>
  );
}

function BreadboardRailConnectionLines() {
  const x1 = holeX(0);
  const x2 = holeX(BB_COLS - 1);
  return (
    <>
      {[BB_RAIL_TOP_PLUS_Y, BB_RAIL_BOT_PLUS_Y].map((y) => (
        <line
          key={`plus-${y}`}
          x1={x1}
          y1={y}
          x2={x2}
          y2={y}
          className="breadboard-rail-line breadboard-rail-line-plus"
        />
      ))}
      {[BB_RAIL_TOP_MINUS_Y, BB_RAIL_BOT_MINUS_Y].map((y) => (
        <line
          key={`minus-${y}`}
          x1={x1}
          y1={y}
          x2={x2}
          y2={y}
          className="breadboard-rail-line breadboard-rail-line-minus"
        />
      ))}
    </>
  );
}

function BreadboardRailHoles() {
  const renderRail = (y: number, variant: 'plus' | 'minus') =>
    Array.from({ length: BB_COLS }, (_, c) => (
      <g key={`rail-${variant}-${y}-${c}`}>
        <circle
          cx={holeX(c)}
          cy={y}
          r={3.5}
          className={`breadboard-rail-hole breadboard-rail-hole-${variant}`}
        />
        <circle
          cx={holeX(c)}
          cy={y}
          r={1.2}
          className={`breadboard-rail-hole-inner breadboard-rail-hole-inner-${variant}`}
        />
      </g>
    ));

  return (
    <>
      {[BB_RAIL_TOP_PLUS_Y, BB_RAIL_BOT_PLUS_Y].flatMap((y) => renderRail(y, 'plus'))}
      {[BB_RAIL_TOP_MINUS_Y, BB_RAIL_BOT_MINUS_Y].flatMap((y) => renderRail(y, 'minus'))}
    </>
  );
}

function BreadboardPackage({ width, height }: { width: number; height: number }) {
  return (
    <>
      <rect x={2} y={2} width={width - 4} height={height - 4} rx={4} className="breadboard-body" />
      <rect
        x={6}
        y={BB_RAIL_TOP_PLUS_Y - 6}
        width={width - 12}
        height={12}
        rx={2}
        className="breadboard-rail-plus"
      />
      <rect
        x={6}
        y={BB_RAIL_TOP_MINUS_Y - 6}
        width={width - 12}
        height={12}
        rx={2}
        className="breadboard-rail-minus"
      />
      <rect
        x={6}
        y={BB_RAIL_BOT_PLUS_Y - 6}
        width={width - 12}
        height={12}
        rx={2}
        className="breadboard-rail-plus"
      />
      <rect
        x={6}
        y={BB_RAIL_BOT_MINUS_Y - 6}
        width={width - 12}
        height={12}
        rx={2}
        className="breadboard-rail-minus"
      />
      <BreadboardRailConnectionLines />
      <rect
        x={8}
        y={BB_IC_SLOT_TOP}
        width={width - 16}
        height={BB_IC_SLOT_BOTTOM - BB_IC_SLOT_TOP}
        rx={2}
        className="breadboard-ic-slot"
      />
      <BreadboardRailHoles />
      <BreadboardConnectionGuides blockX={holeX} keyPrefix="tie" />
      <BreadboardHoles blockX={holeX} keyPrefix="tie" />
    </>
  );
}

export function ComponentShape({
  component,
  selected,
  simFlags,
  simRunning,
}: Props) {
  const subscribePressed = useCallback((listener: () => void) =>
    component.type === 'button' && simRunning
      ? subscribeButtonPressed(component.id, listener)
      : () => {}, [component.id, component.type, simRunning]);
  const readPressed = useCallback(() => !!simRunning && getButtonPressed(component.id), [component.id, simRunning]);
  const simButtonPressed = useSyncExternalStore(subscribePressed, readPressed, readPressed);
  const design = getDesignDefinition(component.type);
  const scale = getDefinitionScale(component.type);
  const id = component.id;
  const flags = simFlags;

  const heat = simRunning ? (flags?.resistorHeatLevel[id] ?? 0) : 0;
  const overrated = simRunning ? (flags?.resistorOverrated[id] ?? false) : false;
  const resistorBlown = simRunning ? (flags?.resistorBlown[id] ?? false) : false;
  const isCap =
    component.type === 'capacitor' || component.type === 'polarized_capacitor';
  const capCharge = simRunning && isCap ? (flags?.capacitorCharge[id] ?? 0) : 0;
  const capBlown = simRunning && isCap ? (flags?.capacitorBlown[id] ?? false) : false;

  const body = (
    <>
      {component.type === 'breadboard' ? (
        <BreadboardPackage width={design.width} height={design.height} />
      ) : (
        <PartArtwork def={design} />
      )}

      <ComponentOverlays
        component={component}
        design={design}
        simFlags={simFlags}
        simRunning={simRunning}
      />
    </>
  );

  return (
    <g
      className={[
        'component-shape',
        selected ? 'selected' : '',
        component.type === 'button' && simButtonPressed ? 'is-button-pressed' : '',
        component.type === 'buzzer' && flags?.buzzerActive?.[id] ? 'is-buzzer-active' : '',
        component.type === 'resistor' && overrated ? 'is-resistor-hot' : '',
        component.type === 'resistor' && resistorBlown ? 'is-resistor-blown' : '',
        isCap && capBlown ? 'is-capacitor-blown' : '',
        isCap && !capBlown && capCharge > 0.05 ? 'is-capacitor-charged' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        component.type === 'resistor' && heat > 0
          ? ({ '--over-power': heat } as CSSProperties)
          : isCap && capCharge > 0
            ? ({ '--cap-charge': capCharge } as CSSProperties)
            : undefined
      }
    >
      {scale === 1 ? body : <g transform={`scale(${scale})`}>{body}</g>}
    </g>
  );
}

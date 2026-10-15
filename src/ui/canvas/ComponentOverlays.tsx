/**
 * What: SVG layers on top of PartArtwork inside ComponentShape — sim visuals and silkscreen,
 * not the base footprint image.
 *
 * Exports ComponentOverlays. Chip/value silkscreen comes from `design.marking`; every
 * simulating part draws its own chrome via `PartModule.overlay` (LED glow, resistor bands,
 * pot knob, meter HUDs). Artwork-only types have no overlay.
 *
 * Readouts pull live values from simFlags keyed by component.id; coords are footprint-local.
 * To add overlay for a simulating part: implement `overlay` on its module in `src/components/`.
 * To add silkscreen on a package IC: set `marking: 'chip'` (or `'value'`) on the registry entry.
 * TO-92 / TO-220 casing legends: `pins[i].letter ?? pins[i].description`.
 * Registry artwork/pins are NOT here — src/registry and PartArtwork.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | Renders the part module's own `overlay` before the legacy per-type blocks
#                     | Dropped leftover per-type overlay blocks; modules own their chrome
# 24-09-2026 | Cursor | Multi-line chip marking (newline-separated `partLabel` lines)
#                     | PinLettersOverlay for TO packages; to92 smaller / to220 lower chip marking
#                     | Casing from pin label / pinLetters; letter layout local to this file
# 25-09-2026 | Cursor | Casing from pin.letter ?? description; drop pinLetters
#                     | Drop capacitor body value marking (value only in properties editor)
# 09-10-2026 | Cursor | Moved from `src/components/ComponentOverlays.tsx` (tree reorganization)
# 14-10-2026 | Codex | Add yellow GPIO overload warning with measured pin currents in a hover tooltip; simulation only.
#                     | Render static part-declared power LEDs only while running and powered, without filters or animation.
#                     | Add a small static two-layer halo to powered module LEDs without blur filters or animation.
#                     | Drive the yellow Uno L lamp from live D13 HIGH/LOW, including LED_BUILTIN, with no sketch-specific handling.
 */
import type { ReactNode } from 'react';
import { pinStateForComponent } from '../../store/simLiveStore';
import type { ComponentDefinition, PlacedComponent } from '../../types';
import {
  DEFAULT_RESISTANCE_UNIT,
  DEFAULT_RESISTANCE_VALUE,
  formatResistanceCompact,
} from '../../values/resistor';
import { getPartModule } from '../../components';
import type { PartOverlayProps as OverlayProps } from '../../components/partModule';

/**
 * TO-92 casing legends on the flat face (plastic ≈ y 8–29; leads at y 38).
 * Outer slots nudged inward toward the center lead.
 */
const TO92_LETTER_Y = 25;
const TO92_LETTER_OFFSETS = [
  { dx: 3.4, dy: 0 },
  { dx: -0.4, dy: 0 },
  { dx: -3.7, dy: 0 },
] as const;
/** TO-220 casing legends: on the plastic below the metal tab. */
const TO220_LETTER_Y = 36;

function packageIdOf(design: ComponentDefinition): string {
  return design.package ?? design.type;
}

function pinLetterPos(
  packageId: string,
  index: number,
  pinX: number,
): { x: number; y: number } | null {
  if (packageId === 'to92') {
    const off = TO92_LETTER_OFFSETS[index] ?? { dx: 0, dy: 0 };
    return { x: pinX + off.dx, y: TO92_LETTER_Y + off.dy };
  }
  if (packageId === 'to220') {
    return { x: pinX, y: TO220_LETTER_Y };
  }
  return null;
}

/** Chip name or part value drawn on top of a shared footprint SVG. */
function BodyMarkingOverlay({
  component,
  width,
  height,
  marking,
  packageId,
}: {
  component: PlacedComponent;
  width: number;
  height: number;
  marking: 'chip' | 'value';
  packageId: string;
}) {
  let text: string;
  if (marking === 'chip') {
    text = component.partLabel?.trim() || '';
    if (!text) return null;
  } else {
    const value = component.resistanceValue ?? DEFAULT_RESISTANCE_VALUE;
    const unit = component.resistanceUnit ?? DEFAULT_RESISTANCE_UNIT;
    text = formatResistanceCompact(value, unit);
  }

  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());

  let fontSize: number;
  let centerY: number;
  if (packageId === 'to92') {
    fontSize = Math.min(6, Math.max(4.5, width / 5));
    // Footprint includes leads; bias up onto the plastic face (above pin letters).
    centerY = height / 2 - 4;
  } else if (packageId === 'to220') {
    fontSize = Math.min(12, Math.max(7, width / 10));
    centerY = height / 2 + 3;
  } else {
    fontSize = Math.min(12, Math.max(7, width / 10));
    centerY = height / 2;
  }

  const lineHeight = fontSize * 1.15;
  const blockHeight = lineHeight * Math.max(lines.length, 1);
  const firstBaselineY = centerY - blockHeight / 2 + lineHeight / 2;

  return (
    <text
      className="part-body-marking"
      x={width / 2}
      y={firstBaselineY}
      textAnchor="middle"
      dominantBaseline="middle"
      fontSize={fontSize}
      pointerEvents="none"
    >
      {lines.map((line, i) => (
        <tspan
          key={i}
          x={width / 2}
          dy={i === 0 ? 0 : lineHeight}
        >
          {line || '\u00a0'}
        </tspan>
      ))}
    </text>
  );
}

/** Molded lead legends on TO plastic. Text: `letter` override or `description`. */
function PinLettersOverlay({ design }: { design: ComponentDefinition }) {
  const packageId = packageIdOf(design);
  const pins = design.pins;
  if (pins.length === 0) return null;

  const fontSize = packageId === 'to92' ? 4.5 : 4.2;
  const nodes: ReactNode[] = [];

  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    const text = (pin.letter ?? pin.description)?.trim();
    if (!text) continue;
    const pos = pinLetterPos(packageId, i, pin.x);
    if (!pos) continue;
    nodes.push(
      <text
        key={`${pin.id}:${text}`}
        className="part-pin-letter"
        x={pos.x}
        y={pos.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
      >
        {text}
      </text>,
    );
  }

  if (nodes.length === 0) return null;

  return (
    <g className="part-pin-letters" pointerEvents="none" aria-hidden>
      {nodes}
    </g>
  );
}

/**
 * Sim-only / property chrome drawn on top of package artwork
 * (LED glow, resistor bands, meter readouts, pot wiper, chip marking, …).
 */
export function ComponentOverlays({
  component,
  design,
  simFlags,
  simRunning,
}: OverlayProps) {
  const partOverlay = getPartModule(component.type)?.overlay;
  const packageId = packageIdOf(design);


  return (
    <>
      {design.marking && (
        <BodyMarkingOverlay
          component={component}
          width={design.width}
          height={design.height}
          marking={design.marking}
          packageId={packageId}
        />
      )}
      {simRunning && [
        { lamp: design.powerIndicator, on: simFlags?.modulePowered?.[component.id], label: 'Power on', kind: 'power' },
        { lamp: design.pinIndicator, on: design.pinIndicator &&
          pinStateForComponent(component.id, design.pinIndicator.pin, 'floating') === 'high', label: 'L LED on (D13)', kind: 'pin' },
      ].map(({ lamp, on, label, kind }) => lamp && on && (
        <g key={kind} data-power-indicator={kind === 'power' ? component.id : undefined}
          data-pin-indicator={kind === 'pin' ? component.id : undefined} aria-label={label} pointerEvents="none" fill={lamp.color}>
          <rect x={lamp.x - 3} y={lamp.y - 3}
            width={lamp.width + 6} height={lamp.height + 6}
            rx={3.5} opacity={0.08} />
          <rect x={lamp.x - 1.5} y={lamp.y - 1.5}
            width={lamp.width + 3} height={lamp.height + 3}
            rx={2} opacity={0.18} />
          <rect
          x={lamp.x} y={lamp.y}
          width={lamp.width} height={lamp.height}
          rx={0.5} />
        </g>
      ))}
      <PinLettersOverlay design={design} />
      {partOverlay?.({ component, design, simFlags, simRunning })}

    </>
  );
}

/** Render above the canvas body hit layer so the native SVG tooltip receives hover. */
export function GpioOvercurrentOverlay({ component, design, simFlags, simRunning }: OverlayProps) {
  const overloaded = simRunning ? Object.entries(simFlags?.gpioOvercurrentMa?.[component.id] ?? {}) : [];
  const warning = overloaded.length ? 'GPIO current exceeds 20 mA: ' + overloaded.map(([id, ma]) => {
    const name = design.pins.find(pin => pin.id === id)?.description ?? id.toUpperCase();
    return name + ' (' + ma.toFixed(2) + ' mA)';
  }).join(', ') + '. Reduce the load or use an external driver. This is a warning, not a current limiter.' : '';
  return <>
      {warning && (
        <g className="gpio-overcurrent-warning" transform={`translate(${design.width * 0.85}, ${design.height * 0.35})`}
          role="img" aria-label={warning} tabIndex={0} style={{ pointerEvents: 'all', cursor: 'help' }}>
          <title>{warning}</title>
          <path d="M 0 -11 L 11 9 L -11 9 Z" fill="#ffd54f" stroke="#372b00" strokeWidth="1.2" strokeLinejoin="round" />
          <text y="5" textAnchor="middle" fill="#211900" fontSize="16" fontWeight="bold" pointerEvents="none">!</text>
        </g>
      )}
  </>;
}

/**
 * What: Everything the simulator knows about a three-pin potentiometer, in one file.
 * Role: part module — footprint, digital wiper voltage divider, pot-position flag, knob overlay.
 * Owns/exports: `potentiometerModule`.
 * Conventions: pin 2 is the wiper. Position 0…1 interpolates voltage between pin 1 and pin 3.
 * There is no SPICE model (open at DC between 1 and 3 except the digital overlay drive).
 * Wheel-while-running lives in SimCanvas — it writes `simState.potPositions`.
 * To change the knob graphic: the overlay below (centre 28,28 in the SVG).
 * Not-here: resistor colour bands or a resistance value editor.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 09-10-2026 | Cursor | Moved from `src/parts/potentiometer.tsx` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import type { PartModule } from '../partModule';

function PotKnobOverlay({ position }: { position: number }) {
  const angle = -135 + position * 270;
  return (
    <g
      className="pot-knob-overlay"
      transform={`rotate(${angle} 28 28)`}
      pointerEvents="none"
    >
      <line
        x1={28}
        y1={28}
        x2={28}
        y2={14}
        stroke="#eceff1"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </g>
  );
}

export const potentiometerModule: PartModule = {
  palette: { category: 'passives', order: 30 },
  type: 'potentiometer',

  definition: {
    type: 'potentiometer',
    label: 'Potentiometer',
    scale: 1,
    artwork: '/components/potentiometer.svg',
    pins: [
      { id: '1', description: '1', x: 14, y: 64, type: 'digital' },
      { id: '2', description: 'Wiper', x: 32, y: 64, type: 'digital' },
      { id: '3', description: '3', x: 50, y: 64, type: 'digital' },
    ],
  },

  evaluate(ctx) {
    const pos = ctx.simState.potPositions[ctx.comp.id] ?? 0.5;
    const v1 = ctx.levelVolts(ctx.netLevel(ctx.pinNet('1')));
    const v3 = ctx.levelVolts(ctx.netLevel(ctx.pinNet('3')));
    const vw = v1 + pos * (v3 - v1);
    ctx.drive(ctx.pinNet('2'), ctx.voltsToLevel(vw), 2);
  },

  publishState(ctx) {
    ctx.flags.potPositions[ctx.comp.id] =
      ctx.simState.potPositions[ctx.comp.id] ?? 0.5;
  },

  overlay: ({ component, simFlags }) => (
    <PotKnobOverlay position={simFlags?.potPositions[component.id] ?? 0.5} />
  ),
};

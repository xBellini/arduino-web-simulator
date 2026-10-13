/**
 * What: Everything the simulator knows about the square-wave signal generator, in one file.
 * Role: part module — footprint, SPICE/legacy source at the current phase, digital drive,
 * flow-trace pin roles, saved-file fields, and the HIGH/LOW readout.
 * Owns/exports: `oscillatorModule`.
 * Conventions: there is no transient analysis. Each frame samples the waveform at `simTimeMs`
 * and stamps a plain DC source at that instant, so the frame rate is also the sampling rate —
 * frequencies near the frame rate will alias. The ngspice cache key therefore has to include
 * the half-period index, or a cached result would freeze the output.
 * To raise the frequency ceiling: the clamp lives in `properties.load` (currently 100 Hz).
 * Not-here: MCU-generated PWM, which comes from the AVR port bridge instead.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 09-10-2026 | Cursor | Moved from `src/parts/oscillator.tsx` (tree reorganization)
 */
import type { PlacedComponent } from '../../types';
import type { PartModule } from '../partModule';
import { InstrumentReadout } from '../overlayKit';

/** Logic-high output level. */
const OUTPUT_HIGH_V = 5;

/** Fraction through the current period, in [0, 1). */
function phaseAt(comp: PlacedComponent, simTimeMs: number): number {
  const freq = comp.oscillatorFrequencyHz ?? 1;
  const periodMs = freq > 0 ? 1000 / freq : 1000;
  return periodMs > 0 ? (simTimeMs % periodMs) / periodMs : 0;
}

function isHigh(comp: PlacedComponent, simTimeMs: number): boolean {
  return phaseAt(comp, simTimeMs) < 0.5;
}

export const oscillatorModule: PartModule = {
  type: 'oscillator',
  standaloneSource: true,

  definition: {
    type: 'oscillator',
    label: 'Oscillator',
    scale: 2,
    artwork: '/components/oscillator.svg',
    pins: [
      { id: 'out', description: 'OUT', x: 14, y: 48, type: 'digital' },
      { id: 'gnd', description: 'GND', x: 50, y: 48, type: 'ground' },
    ],
  },

  spiceStamp(ctx) {
    if (ctx.comp.oscillatorEnabled === false) return;
    const nOut = ctx.pinNet('out');
    const nGnd = ctx.pinNet('gnd');
    if (nOut === null || nGnd === null) return;
    const volts = isHigh(ctx.comp, ctx.simTimeMs) ? OUTPUT_HIGH_V : 0;
    ctx.line(`V${ctx.sid} ${ctx.node(nOut)} ${ctx.node(nGnd)} DC ${volts}`);
    ctx.markSourced(nOut);
    ctx.instance(`V${ctx.sid}`);
  },

  spiceCacheKey({ comp, simTimeMs }) {
    const freq = comp.oscillatorFrequencyHz ?? 1;
    const periodMs = freq > 0 ? 1000 / freq : 1000;
    // Period index, not phase — the cache must miss once per period, not once per frame.
    const period = periodMs > 0 ? Math.floor(simTimeMs / periodMs) : 0;
    return `${comp.oscillatorFrequencyHz}:${comp.oscillatorEnabled}:${period}`;
  },

  legacyFixedVoltages(ctx) {
    if (ctx.comp.oscillatorEnabled === false) return;
    const nOut = ctx.pinNet('out');
    const nGnd = ctx.pinNet('gnd');
    if (nOut !== null) {
      ctx.setFixed(nOut, isHigh(ctx.comp, ctx.simTimeMs) ? OUTPUT_HIGH_V : 0);
    }
    if (nGnd !== null && !ctx.hasFixed(nGnd)) ctx.setFixed(nGnd, 0);
  },

  evaluate(ctx) {
    const id = ctx.comp.id;
    if (ctx.comp.oscillatorEnabled === false) {
      ctx.flags.oscillatorOutputHigh[id] = false;
      return;
    }
    const high = isHigh(ctx.comp, ctx.simTimeMs);
    ctx.flags.oscillatorOutputHigh[id] = high;
    ctx.drive(ctx.pinNet('out'), high ? 'high' : 'low', 3);
  },

  pinRole(comp, pinId, flags) {
    if (
      pinId === 'out' &&
      comp.oscillatorEnabled !== false &&
      flags.oscillatorOutputHigh[comp.id]
    ) {
      return 'source';
    }
    if (pinId === 'gnd') return 'sink';
    return undefined;
  },

  properties: {
    editable: true,
    defaults: () => ({ oscillatorFrequencyHz: 1, oscillatorEnabled: true }),
    load(raw, into) {
      const hz = raw.oscillatorFrequencyHz;
      into.oscillatorFrequencyHz =
        typeof hz === 'number' && Number.isFinite(hz) && hz > 0 && hz <= 100 ? hz : 1;
      if (typeof raw.oscillatorEnabled === 'boolean') {
        into.oscillatorEnabled = raw.oscillatorEnabled;
      }
    },
  },

  overlay: ({ component, simFlags, simRunning }) => {
    const high = simFlags?.oscillatorOutputHigh?.[component.id];
    return (
      <InstrumentReadout
        x={8}
        y={10}
        width={48}
        height={22}
        label="OSC"
        value={simRunning && high !== undefined ? (high ? 'HIGH' : 'LOW') : '---'}
      />
    );
  },
};

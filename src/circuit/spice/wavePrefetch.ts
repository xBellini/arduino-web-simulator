/**
 * What: Prefetch SPICE charge/discharge waveform caches before AVR starts.
 * Role: Move cold `.tran` fills to startup so GPIO edges can replay immediately.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Prefetch at Run
# 09-10-2026 | Cursor | Moved from `src/sim/spiceWavePrefetch.ts` (tree reorganization)
 */


import type { PlacedComponent } from '../../types';
import {
  boardPowerSources,
  netForPin,
  type CircuitNetlist,
  type McuSourceMap,
} from '../netlist';
import { ARDUINO_DIGITAL_PIN_MAP } from '../../avr/pinMap';
import type { ButtonPressedState } from './netlistExport';
import {
  canUseNgspiceOp,
  prepareIcForSpiceWaveFill,
  putSpiceWaveCache,
  refreshDcOperatingPoint,
  takeNgspiceWaveform,
} from '../dcSolver';

/** Board rails + every wired MCU GPIO net driven high (5 V) or low (0 V). */
export function syntheticDrivenMcuSources(
  netlist: CircuitNetlist,
  mcu: PlacedComponent,
  driveHigh: boolean,
): McuSourceMap {
  const sources = boardPowerSources([mcu], netlist);
  const volts = driveHigh ? 5 : 0;
  for (const pinId of Object.keys(ARDUINO_DIGITAL_PIN_MAP)) {
    const netId = netForPin(netlist, { componentId: mcu.id, pinId });
    if (netId === null) continue;
    if (!sources.has(netId)) sources.set(netId, volts);
  }
  return sources;
}

export type SpiceWavePrefetchResult = {
  charge: boolean;
  discharge: boolean;
  chargeMs: number;
  dischargeMs: number;
  skipped: boolean;
  reason?: string;
};

/**
 * Fill charge then discharge `.tran` caches for `circuitKey`.
 * Call only when the circuit has capacitors and ngspice can export.
 * AVR must not be stepping yet (no GPIO-edge aborts during fill).
 */
export async function prefetchSpiceWaveCache(options: {
  components: PlacedComponent[];
  netlist: CircuitNetlist;
  mcu: PlacedComponent;
  circuitKey: string;
  resistorBlown?: Record<string, boolean>;
  ledBlown?: Record<string, boolean>;
  capacitorBlown?: Record<string, boolean>;
  buttonPressed?: ButtonPressedState;
}): Promise<SpiceWavePrefetchResult> {
  const {
    components,
    netlist,
    mcu,
    circuitKey,
    resistorBlown = {},
    ledBlown = {},
    capacitorBlown = {},
    buttonPressed = {},
  } = options;

  const chargeSources = syntheticDrivenMcuSources(netlist, mcu, true);
  if (
    !canUseNgspiceOp(
      components,
      netlist,
      0,
      resistorBlown,
      ledBlown,
      buttonPressed,
      chargeSources,
      capacitorBlown,
    )
  ) {
    return {
      charge: false,
      discharge: false,
      chargeMs: 0,
      dischargeMs: 0,
      skipped: true,
      reason: 'ngspice-unavailable',
    };
  }

  let chargeOk = false;
  let dischargeOk = false;

  const tCharge0 = performance.now();
  prepareIcForSpiceWaveFill('charge', circuitKey, components, netlist);
  await refreshDcOperatingPoint(
    components,
    netlist,
    0,
    resistorBlown,
    ledBlown,
    buttonPressed,
    chargeSources,
    capacitorBlown,
  );
  const chargeWave = takeNgspiceWaveform();
  if (chargeWave) {
    chargeOk = putSpiceWaveCache(circuitKey, 'charge', chargeWave);
  }
  const chargeMs = performance.now() - tCharge0;

  const tDis0 = performance.now();
  prepareIcForSpiceWaveFill('discharge', circuitKey, components, netlist);
  const dischargeSources = syntheticDrivenMcuSources(netlist, mcu, false);
  await refreshDcOperatingPoint(
    components,
    netlist,
    0,
    resistorBlown,
    ledBlown,
    buttonPressed,
    dischargeSources,
    capacitorBlown,
  );
  const dischargeWave = takeNgspiceWaveform();
  if (dischargeWave) {
    dischargeOk = putSpiceWaveCache(circuitKey, 'discharge', dischargeWave);
  }
  const dischargeMs = performance.now() - tDis0;

  return {
    charge: chargeOk,
    discharge: dischargeOk,
    chargeMs,
    dischargeMs,
    skipped: false,
  };
}

/**
 * What: Run/stop orchestration — compile or hex, AVR runner, GPIO bridge, DC operating point,
 * and SPICE waveform playback (lerp between real `.tran` samples for cap charge UI).
 * Role: single controller instance wired from `SimProvider`; updates `simLiveStore` each tick.
 * Owns/exports: `SimulationController`, `SimRunStatus`, callback interfaces, run options types.
 * Conventions: circuit snapshot comes from editor components/wires; ngspice refresh rate capped;
 * pin states for UI via `applySimLivePinStates`; status/compiler/serial via injected callbacks.
 * Cap charge/discharge uses cached SPICE trajectories replayed in wall-clock sync with GPIO edges.
 * To change run behavior: edit methods on `SimulationController` (compile path, hex load, stop
 * cleanup) — keep React out of this file.
 * To add a new sim-visible flag: extend `ComponentSimFlags` / bridge in `avr/gpioBridge.ts`,
 * then push through `simLiveStore` writers called here.
 * To change DC cadence (throttle, static skip): edit `runSolveFrame` — MCU and circuit-only
 * both use it, so do not re-introduce a second solve in `startCircuitOnly`.
 * Not-here: editor reducer, canvas rendering, or registry definitions.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
#                     | MCU and circuit-only share `runSolveFrame` (one DC solve, throttled ngspice, static skip)
#                     | Circuit-only: skip overlay/UI when the solve signature is unchanged (MCU path untouched)
# 25-09-2026 | Cursor | Capacitor .tran refresh (~25 Hz) even when cache hits; capacitorBlown in signature
# 28-09-2026 | Cursor | Lerp SPICE waveform samples each frame for smooth cap charge overlay
# 05-10-2026 | Cursor | Clear HD44780 LCD instance maps on halt
#                     | Attach LCD GPIO EN-edge probe for cycle-accurate HD44780 latch
#                     | Run AVR in Worker + WASM pacer (cycle-quanta hot loop)
#                     | Prefetch SPICE charge/discharge waves before AVR start
# 08-10-2026 | Cursor | Debug F4: sample avgRafDtMs while Concord runs with XSPICE parked on disk
# 09-10-2026 | Cursor | Removed XSPICE-era F4 rAF debug instrumentation
# 14-10-2026 | Codex | Invalidate cached measurements when GPIO ownership changes at unchanged voltage.
 */

import type { PinState, PlacedComponent, Wire } from '../types';
import { bundledBlinkHex, compileSketch } from '../avr/firmware';
import {
  computeMcuSources,
  createCircuitBridge,
  createGpioBridge,
  pinStatesFromNets,
  syncCircuitOnly,
  syncMcuWithNets,
  type GpioBridge,
} from '../avr/gpioBridge';
import type { McuSourceMap, NetLevel } from '../circuit/netlist';
import { getCachedNgspiceDcResult, hasStandaloneCircuit, invalidateNgspiceCache, commitNgspiceNodeIc, refreshDcOperatingPoint, solveDcCircuit, terminateNgspiceWorker, canUseNgspiceOp, takeNgspiceWaveform, abortNgspiceInFlight, lookupSpiceWaveCache, putSpiceWaveCache, circuitKeyFromSolveSig, spiceWaveKindFromSolveSig, prepareIcForSpiceWaveFill } from '../circuit/dcSolver';
import type { SpiceWaveform } from '../circuit/spice/client';
import { prefetchSpiceWaveCache, syntheticDrivenMcuSources } from '../circuit/spice/wavePrefetch';
import { circuitHasCapacitors, tickCapacitorChargeVisuals } from '../components/passives/capacitor';
import { clearLcdSimState } from '../components/output/lcdParallel';
import { updateComponentVisuals } from '../circuit/visuals';
import { updateWireCurrents } from '../circuit/currents';
import { buildNetBranchCurrentMa } from '../circuit/currents';
import type { DcSolveResult } from '../circuit/mnaLegacy';
import { getPartModule } from '../components';
import { isMcuBoard } from '../avr/pinMap';
import { AvrRunner, CPU_FREQ_HZ } from '../avr/runner';
import { AvrWorkerHost } from '../avr/workerHost';
import { buildLcdWorkerTargets } from '../avr/workerTargets';
import { buildTwiWorkerTargets } from '../avr/workerTargets';
import type { ComponentSimFlags } from '../avr/gpioBridge';
import type { AVRIOPort } from 'avr8js';
// LCD EN probe runs inside the AVR Worker; main only applies posted bus samples.
import {
  isSimPerfEnabled,
  recordSolveFrame,
  resetSimPerfRun,
} from '../avr/simPerf';
import {
  validateHexForAtmega328P,
  type HexValidationResult,
} from '../avr/firmware';
import {
  applySimLivePinStates,
  resetSimLiveState,
  setDcSolverBackend,
  type DcSolverBackend,
  type NgspiceDcDebug,
} from './simLiveStore';

export type SimRunStatus = 'idle' | 'compiling' | 'running' | 'error';

/** Min interval between ngspice .OP refresh attempts for an unchanged circuit (~25 Hz). */
const NGSPICE_REFRESH_MIN_MS = 40;

/**
 * Blend two SPICE `.tran` samples. Endpoints are ngspice values; the blend is only
 * for smooth UI between the sparse WAVE samples (not an invented RC model).
 */
function lerpDcSolveResult(
  a: DcSolveResult,
  b: DcSolveResult,
  t: number,
): DcSolveResult {
  const u = Math.max(0, Math.min(1, t));
  if (u <= 0) return a;
  if (u >= 1) return b;
  const netVoltages = new Map<number, number>();
  for (const [net, va] of a.netVoltages) {
    const vb = b.netVoltages.get(net) ?? va;
    netVoltages.set(net, va + (vb - va) * u);
  }
  for (const [net, vb] of b.netVoltages) {
    if (!netVoltages.has(net)) netVoltages.set(net, vb);
  }
  const ledConducting: Record<string, boolean> = { ...a.ledConducting };
  if (u >= 0.5) {
    for (const [id, on] of Object.entries(b.ledConducting)) {
      ledConducting[id] = on;
    }
  }
  let branchCurrentMa: Record<string, number> | undefined;
  if (a.branchCurrentMa || b.branchCurrentMa) {
    branchCurrentMa = {};
    const ids = new Set([
      ...Object.keys(a.branchCurrentMa ?? {}),
      ...Object.keys(b.branchCurrentMa ?? {}),
    ]);
    for (const id of ids) {
      const ia = a.branchCurrentMa?.[id] ?? 0;
      const ib = b.branchCurrentMa?.[id] ?? 0;
      branchCurrentMa[id] = ia + (ib - ia) * u;
    }
  }
  return {
    netVoltages,
    ledConducting,
    branchCurrentMa,
    supplyCurrentLimited:
      u >= 0.5 ? b.supplyCurrentLimited : a.supplyCurrentLimited,
  };
}

export interface SimulationCallbacks {
  onStatus: (status: SimRunStatus, message?: string) => void;
  onCompilerOutput: (text: string) => void;
  /** Append to the compiler panel (prefetch / status notes). */
  onCompilerAppend?: (text: string) => void;
  onSerialOutput: (text: string) => void;
}

export interface RunFirmwareOptions {
  sketch?: string;
  hex?: string;
  hexFilename?: string;
  components: PlacedComponent[];
  wires: Wire[];
}

export class SimulationController {
  private runner: AvrWorkerHost | null = null;
  private bridge: GpioBridge | null = null;
  /** Detach HD44780 GPIO EN-edge probe (set in startHex). */
  private detachLcdGpioProbe: (() => void) | null = null;
  private circuitOnly = false;
  private circuitStartMs = 0;
  private circuitRafId: number | null = null;
  private netLevels = new Map<number, NetLevel>();
  private buttonPressed: Record<string, boolean> = {};
  private callbacks: SimulationCallbacks;
  private isCanvasInteracting: () => boolean;
  private syncScheduled = false;
  private lastPinUiMs = 0;
  private frameSyncScheduled = false;
  private lastNgspiceRefreshMs = 0;
  private lastRefreshSig = '';
  private lastSolveSig = '';
  /** Circuit-only: signature for which overlay+UI were already applied (MCU never uses this). */
  private frameAppliedForSig = '';
  private lastDc: DcSolveResult | null = null;
  /** True only when `lastDc` came from a completed ngspice solve (not legacy interim). */
  private lastDcFromNgspice = false;
  /** `runtimeSolveSignature` that `lastDc` was solved for — never paint across a sig change. */
  private lastSpiceSig = '';
  /** One ngspice refresh in flight; newer requests replace `ngspiceCoalesce`. */
  private ngspiceBusy = false;
  private ngspiceCoalesce: {
    requestSig: string;
    components: PlacedComponent[];
    simTimeMs: number;
    resistorBlown: Record<string, boolean>;
    ledBlown: Record<string, boolean>;
    capacitorBlown: Record<string, boolean>;
    mcuSources: McuSourceMap;
  } | null = null;
  /** Playback of SPICE `.tran` waveform samples (real SPICE points, wall-clock synced to GPIO edge). */
  private spiceWavePlay: {
    samples: DcSolveResult[];
    startedAt: number;
    durationMs: number;
    sig: string;
    idx: number;
  } | null = null;
  /** Signature of the ngspice request currently in flight (for abort/supersede). */
  private ngspiceInFlightSig = '';
  /** Wall time of the latest GPIO/solve-signature edge — waveform catch-up uses this. */
  private gpioEdgeAtMs = 0;
  private gpioEdgeSig = '';
  private lastCapabilitySig: string | null = null;
  private ngspiceCapableCache = false;
  private uiRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncPortsFn: (() => void) | null = null;
  private pendingPinStates: {
    byComponent: Record<string, Record<string, PinState>>;
    simFlags: ComponentSimFlags;
    dcSolverBackend: DcSolverBackend;
    ngspiceDebug: NgspiceDcDebug | null;
  } | null = null;
  private getExecuteOptions = () =>
    this.isCanvasInteracting()
      ? AvrRunner.interactExecuteOptions()
      : AvrRunner.idleExecuteOptions();

  constructor(
    callbacks: SimulationCallbacks,
    options?: { isCanvasInteracting?: () => boolean },
  ) {
    this.callbacks = callbacks;
    this.isCanvasInteracting = options?.isCanvasInteracting ?? (() => false);
  }

  isRunning(): boolean {
    return this.runner !== null || this.circuitOnly;
  }

  setButtonPressed(componentId: string, pressed: boolean): void {
    const prev = this.buttonPressed[componentId];
    if (prev === pressed) return;
    this.buttonPressed[componentId] = pressed;
    if (this.isRunning()) {
      // Cache key includes press state — no need to wipe ngspice cache or in-flight solves.
      this.syncPortsFn?.();
      this.syncScheduled = false;
      this.flushPendingPinUi();
    }
  }

  setPotPosition(componentId: string, position: number): void {
    if (!this.bridge) return;
    this.bridge.simState.potPositions[componentId] = Math.max(
      0,
      Math.min(1, position),
    );
  }

  async runFirmware(options: RunFirmwareOptions): Promise<void> {
    this.haltRunner();
    const { components, wires } = options;
    const mcus = components.filter((c) => isMcuBoard(c.type));
    if (mcus.length === 0) {
      if (hasStandaloneCircuit(components)) {
        this.callbacks.onCompilerOutput(
          'Circuit simulation (no MCU) — DC solver for supply, resistors, and LEDs.\n',
        );
        this.startCircuitOnly(components, wires);
        return;
      }
      this.callbacks.onStatus('error', 'Place an Arduino Uno or Nano on the canvas, or add a power supply for a passive circuit.');
      return;
    }

    const mcu = mcus[0]!;
    if (mcus.length > 1) {
      this.callbacks.onCompilerOutput(
        `Note: ${mcus.length} boards on canvas — simulating ${mcu.type} only.\n`,
      );
    }

    try {
      let hex: string;
      let compilerOutput: string;

      if (options.hex) {
        this.callbacks.onStatus('compiling');
        const validation = validateHexForAtmega328P(options.hex);
        if (!validation.ok) {
          this.callbacks.onCompilerOutput(
            validation.message ?? 'Invalid HEX file.',
          );
          this.callbacks.onStatus('error', validation.message);
          return;
        }
        hex = options.hex;
        compilerOutput = formatHexLoadMessage(options.hexFilename, validation);
      } else if (options.sketch !== undefined) {
        const localHex = bundledBlinkHex(options.sketch);
        if (localHex) {
          hex = localHex;
          compilerOutput = 'Using bundled blink firmware (local).';
        } else {
          this.callbacks.onStatus('compiling');
          const result = await compileSketch(options.sketch);
          compilerOutput = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
          if (!result.hex) {
            this.callbacks.onCompilerOutput(compilerOutput);
            this.callbacks.onStatus('error', 'Compile failed — see compiler output.');
            return;
          }
          hex = result.hex;
        }
      } else {
        this.callbacks.onStatus('error', 'No sketch or HEX firmware provided.');
        return;
      }

      this.callbacks.onCompilerOutput(compilerOutput);
      await this.startHex(hex, mcu, components, wires);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Run failed';
      this.callbacks.onCompilerOutput(msg);
      this.callbacks.onStatus('error', msg);
    }
  }

  async compileAndRun(
    sketch: string,
    components: PlacedComponent[],
    wires: Wire[],
  ): Promise<void> {
    await this.runFirmware({ sketch, components, wires });
  }

  private async startHex(
    hex: string,
    mcu: PlacedComponent,
    components: PlacedComponent[],
    wires: Wire[],
  ): Promise<void> {
    resetSimLiveState();
    if (isSimPerfEnabled()) resetSimPerfRun();
    const host = new AvrWorkerHost();
    this.runner = host;
    const ports = {
      B: host.portB as unknown as AVRIOPort,
      C: host.portC as unknown as AVRIOPort,
      D: host.portD as unknown as AVRIOPort,
    };
    this.bridge = createGpioBridge(components, wires, ports);
    this.netLevels = new Map();

    const syncPorts = () => this.runSolveFrame(components, mcu);
    this.syncPortsFn = syncPorts;

    // Prefetch SPICE RC trajectories before AVR edges can abort fills.
    if (circuitHasCapacitors(components)) {
      this.callbacks.onStatus(
        'compiling',
        'Preparing SPICE waveforms…',
      );
      this.callbacks.onCompilerAppend?.(
        '\nPreparing SPICE charge/discharge waveforms…\n',
      );
      const { resistorBlown, ledBlown, capacitorBlown } = this.bridge.simState;
      const chargeSources = syntheticDrivenMcuSources(
        this.bridge.netlist,
        mcu,
        true,
      );
      const circuitKey = circuitKeyFromSolveSig(
        runtimeSolveSignature(
          components,
          0,
          chargeSources,
          this.buttonPressed,
          resistorBlown,
          ledBlown,
          capacitorBlown,
        ),
      );
      const prefetch = await prefetchSpiceWaveCache({
        components,
        netlist: this.bridge.netlist,
        mcu,
        circuitKey,
        resistorBlown,
        ledBlown,
        capacitorBlown,
        buttonPressed: this.buttonPressed,
      });
      if (!this.runner) return; // halted during prefetch
      const parts: string[] = [];
      if (prefetch.skipped) {
        parts.push(
          `SPICE prefetch skipped (${prefetch.reason ?? 'unknown'}).`,
        );
      } else {
        parts.push(
          `SPICE prefetch: charge ${prefetch.charge ? 'ok' : 'miss'} (${prefetch.chargeMs.toFixed(0)} ms), discharge ${prefetch.discharge ? 'ok' : 'miss'} (${prefetch.dischargeMs.toFixed(0)} ms).`,
        );
      }
      this.callbacks.onCompilerAppend?.(parts.join(' ') + '\n');
    }

    this.callbacks.onStatus('running');
    syncPorts();
    requestAnimationFrame(() => {
      if (!this.runner) return;
      this.scheduleFrameSync();
      void host.start(
        hex,
        buildLcdWorkerTargets(components, wires),
        {
          onSerialByte: (value) => {
            this.callbacks.onSerialOutput(String.fromCharCode(value));
          },
          onTick: () => {
            host.refreshOptions();
            this.scheduleFrameSync();
          },
          onError: (message) => {
            this.callbacks.onCompilerOutput(message);
            this.callbacks.onStatus('error', message);
          },
        },
        this.getExecuteOptions,
        buildTwiWorkerTargets(components, wires),
      );
    });
  }

  /**
   * One DC solve + overlay tick. Shared by AVR `syncPorts` and circuit-only rAF so
   * bench circuits do not run a second MNA or an unthrottled ngspice refresh.
   * Unchanged DC inputs reuse the last result (oscillator phase is in the signature
   * via each part's `spiceCacheKey`). Circuit-only also skips the overlay/UI when the
   * signature is unchanged (MCU co-sim always runs the overlay — GPIO can change).
   */
  private runSolveFrame(
    components: PlacedComponent[],
    mcu: PlacedComponent | null,
  ): void {
    if (!this.bridge) return;
    if (mcu && !this.runner) return;
    if (!mcu && !this.circuitOnly) return;

    const simTimeMs = this.runner
      ? (this.runner.cpu.cycles / CPU_FREQ_HZ) * 1000
      : performance.now() - this.circuitStartMs;
    const { resistorBlown, ledBlown, capacitorBlown } = this.bridge.simState;
    const mcuSources = mcu ? computeMcuSources(this.bridge, mcu) : new Map();
    // Live GPIO volts for visuals during ngspice wait (LED must not use stale SPICE V).
    this.bridge.simState.mcuSourceVolts = Object.fromEntries(
      [...mcuSources.entries()].map(([n, v]) => [String(n), v]),
    );
    this.bridge.lastMcuSources = mcuSources;

    const cachedDc = getCachedNgspiceDcResult(
      components,
      this.bridge.netlist,
      simTimeMs,
      resistorBlown,
      ledBlown,
      this.buttonPressed,
      mcuSources,
      capacitorBlown,
    );

    const solveSig = runtimeSolveSignature(
      components,
      simTimeMs,
      mcuSources,
      this.buttonPressed,
      resistorBlown,
      ledBlown,
      capacitorBlown,
    );

    if (solveSig !== this.gpioEdgeSig) {
      this.gpioEdgeAtMs = performance.now();
      this.gpioEdgeSig = solveSig;
    }

    const solvePerfT0 = isSimPerfEnabled() ? performance.now() : 0;
    let solvePerfBackend: 'ngspice' | 'legacy' | null = null;
    let solvePerfNgspice = false;
    const finishSolvePerf = (): void => {
      if (!isSimPerfEnabled()) return;
      recordSolveFrame(
        performance.now() - solvePerfT0,
        solvePerfBackend,
        solvePerfNgspice,
      );
    };

    const applyFrame = (
      result: DcSolveResult | null,
      backend: 'ngspice' | 'legacy',
    ): void => {
      if (!this.bridge) return;
      if (mcu && !this.runner) return;
      if (!mcu && !this.circuitOnly) return;
      if (isSimPerfEnabled()) {
        solvePerfBackend = backend;
        if (backend === 'ngspice') solvePerfNgspice = true;
      }
      setDcSolverBackend(backend);
      this.netLevels = mcu
        ? syncMcuWithNets(
            this.bridge,
            mcu,
            components,
            this.buttonPressed,
            simTimeMs,
            result,
          )
        : syncCircuitOnly(
            this.bridge,
            components,
            this.buttonPressed,
            simTimeMs,
            result,
          );
      const pinMap = pinStatesFromNets(
        components,
        this.bridge.netlist,
        this.netLevels,
      );
      this.queueUiUpdate(pinMap, this.bridge.simFlags, backend, result);
      if (!mcu) this.frameAppliedForSig = solveSig;
    };

    // Advance SPICE waveform playback — lerp between real .tran samples each frame.
    let waveFrameApplied = false;
    if (this.spiceWavePlay) {
      if (this.spiceWavePlay.sig !== solveSig) {
        this.spiceWavePlay = null;
      } else {
        const play = this.spiceWavePlay;
        const u = Math.max(
          0,
          Math.min(1, (performance.now() - play.startedAt) / play.durationMs),
        );
        const n = play.samples.length;
        const fIdx = u * Math.max(n - 1, 0);
        const i0 = Math.min(n - 1, Math.floor(fIdx + 1e-9));
        const i1 = Math.min(n - 1, i0 + 1);
        const frac = i0 === i1 ? 0 : fIdx - i0;
        const sample =
          i0 === i1
            ? play.samples[i0]!
            : lerpDcSolveResult(play.samples[i0]!, play.samples[i1]!, frac);
        play.idx = i0;
        this.lastDc = sample;
        this.lastDcFromNgspice = true;
        this.lastSpiceSig = solveSig;
        applyFrame(sample, 'ngspice');
        commitNgspiceNodeIc(sample.netVoltages);
        waveFrameApplied = true;
        if (u >= 1) {
          const last = play.samples[play.samples.length - 1]!;
          commitNgspiceNodeIc(last.netVoltages);
          this.spiceWavePlay = null;
        }
      }
    }

    // Bench-only: after the first apply for this signature, do not re-run overlay or
    // React every rAF. Still allow a throttled ngspice fill/upgrade. MCU never enters.
    if (!mcu && solveSig === this.frameAppliedForSig) {
      let needsTick = false;
      for (const c of components) {
        if (getPartModule(c.type)?.publishState) {
          needsTick = true;
          break;
        }
      }
      if (!needsTick) {
        for (const v of Object.values(this.bridge.simState.ledOvercurrentMs)) {
          if (v > 0) {
            needsTick = true;
            break;
          }
        }
      }
      if (!needsTick) {
        for (const v of Object.values(this.bridge.simState.resistorOverPowerMs)) {
          if (v > 0) {
            needsTick = true;
            break;
          }
        }
      }
      if (!needsTick) {
        for (const v of Object.values(this.bridge.simState.capacitorOverVoltageMs ?? {})) {
          if (v > 0) {
            needsTick = true;
            break;
          }
        }
      }
      if (!needsTick) {
        if (solveSig !== this.lastCapabilitySig) {
          this.ngspiceCapableCache = canUseNgspiceOp(
            components,
            this.bridge.netlist,
            simTimeMs,
            resistorBlown,
            ledBlown,
            this.buttonPressed,
            mcuSources,
            capacitorBlown,
          );
          this.lastCapabilitySig = solveSig;
        }
        if (this.ngspiceCapableCache && cachedDc === null) {
          const now = performance.now();
          const sigChanged = solveSig !== this.lastRefreshSig;
          if (
            sigChanged ||
            now - this.lastNgspiceRefreshMs >= NGSPICE_REFRESH_MIN_MS
          ) {
            this.lastNgspiceRefreshMs = now;
            this.lastRefreshSig = solveSig;
            void refreshDcOperatingPoint(
              components,
              this.bridge.netlist,
              simTimeMs,
              resistorBlown,
              ledBlown,
              this.buttonPressed,
              mcuSources,
              capacitorBlown,
            )
              .then(({ result, backend }) => {
                if (!this.bridge) return;
                if (!this.circuitOnly) return;
                if (backend !== 'ngspice') return;
                if (result) commitNgspiceNodeIc(result.netVoltages);
                this.lastDc = result;
                applyFrame(result, backend);
              })
              .catch(() => {});
          }
        }
        if (isSimPerfEnabled()) finishSolvePerf();
        return;
      }
    }

    let interim = cachedDc;
    let interimBackend: 'ngspice' | 'legacy' = cachedDc ? 'ngspice' : 'legacy';

    if (solveSig !== this.lastCapabilitySig) {
      this.ngspiceCapableCache = canUseNgspiceOp(
        components,
        this.bridge.netlist,
        simTimeMs,
        resistorBlown,
        ledBlown,
        this.buttonPressed,
        mcuSources,
        capacitorBlown,
      );
      this.lastCapabilitySig = solveSig;
    }
    const ngspiceCapable = this.ngspiceCapableCache;
    const hasCaps = circuitHasCapacitors(components);

    if (!interim) {
      if (ngspiceCapable) {
        // Hold only when the electrical signature still matches the stored OP.
        // Holding across GPIO edges paints stale V/I (looks "inexplicable").
        if (
          this.lastDc &&
          this.lastDcFromNgspice &&
          solveSig === this.lastSpiceSig
        ) {
          interim = this.lastDc;
          interimBackend = 'ngspice';
        } else {
          interim = null;
        }
      } else if (solveSig === this.lastSolveSig && this.lastDc) {
        interim = this.lastDc;
        interimBackend = this.lastDcFromNgspice ? 'ngspice' : 'legacy';
      } else {
        interim = solveDcCircuit(
          components,
          this.bridge.netlist,
          simTimeMs,
          resistorBlown,
          ledBlown,
          this.buttonPressed,
          mcuSources,
          capacitorBlown,
        );
        interimBackend = 'legacy';
        this.lastDc = interim;
        this.lastDcFromNgspice = false;
        this.lastSpiceSig = '';
      }
    } else {
      this.lastDc = interim;
      this.lastDcFromNgspice = true;
      this.lastSpiceSig = solveSig;
    }
    this.lastSolveSig = solveSig;


    if (interim && !waveFrameApplied) applyFrame(interim, interimBackend);
    else if (!waveFrameApplied && ngspiceCapable && hasCaps && this.bridge) {
      // Hold last SPICE solve until the new .tran lands — no invented fill/current.
      tickCapacitorChargeVisuals(
        components,
        this.bridge.simState,
        this.bridge.simFlags,
        16,
      );
      const branchMa: Record<string, number> = {
        ...(this.lastDc?.branchCurrentMa ?? {}),
      };
      updateComponentVisuals(
        components,
        this.bridge.netlist,
        this.netLevels,
        this.bridge.simState,
        this.bridge.simFlags,
        simTimeMs,
        this.lastDc?.netVoltages,
        this.lastDc?.ledConducting,
        branchMa,
      );
      const netMa = buildNetBranchCurrentMa(
        this.bridge.netlist,
        components,
        this.bridge.simFlags,
        this.lastDc?.netVoltages,
        this.netLevels,
        branchMa,
      );
      updateWireCurrents(
        this.bridge.wires,
        this.bridge.netlist,
        this.netLevels,
        components,
        this.bridge.simFlags,
        this.lastDc?.netVoltages,
        netMa,
      );
      const pinMap = pinStatesFromNets(
        components,
        this.bridge.netlist,
        this.netLevels,
      );
      this.queueUiUpdate(
        pinMap,
        this.bridge.simFlags,
        'ngspice',
        this.lastDc,
      );
    } else if (ngspiceCapable) setDcSolverBackend('ngspice');

    const now = performance.now();
    const sigChanged = solveSig !== this.lastRefreshSig;
    const dueRefresh = now - this.lastNgspiceRefreshMs >= NGSPICE_REFRESH_MIN_MS;
    const shouldRefresh =
      ngspiceCapable &&
      (cachedDc === null || (hasCaps && dueRefresh) || sigChanged);
    const wavePlaying =
      !!this.spiceWavePlay &&
      this.spiceWavePlay.sig === solveSig &&
      now - this.spiceWavePlay.startedAt < this.spiceWavePlay.durationMs;

    // Prefer cached SPICE trajectories on GPIO edges — live .tran is always late vs blink.
    if (sigChanged && hasCaps && ngspiceCapable && !wavePlaying) {
      const kind = spiceWaveKindFromSolveSig(solveSig);
      const cKey = circuitKeyFromSolveSig(solveSig);
      const cached = kind ? lookupSpiceWaveCache(cKey, kind) : null;
      if (cached) {
        if (this.ngspiceBusy) {
          abortNgspiceInFlight();
          this.ngspiceBusy = false;
          this.ngspiceInFlightSig = '';
          this.ngspiceCoalesce = null;
        }
        this.lastNgspiceRefreshMs = now;
        this.lastRefreshSig = solveSig;
        this.startSpiceWavePlayback(cached, solveSig, applyFrame);
        if (isSimPerfEnabled()) finishSolvePerf();
        return;
      }
    }

    if (shouldRefresh && (sigChanged || dueRefresh) && !wavePlaying) {
      this.lastNgspiceRefreshMs = now;
      this.lastRefreshSig = solveSig;
      this.enqueueNgspiceRefresh(
        {
          requestSig: solveSig,
          components,
          simTimeMs,
          resistorBlown,
          ledBlown,
          capacitorBlown,
          mcuSources,
        },
        mcu,
        applyFrame,
      );
    }
    if (isSimPerfEnabled()) finishSolvePerf();
  }

  /**
   * Play a SPICE waveform (cached or just-solved) in real time from sample 0.
   * Values are exclusively from ngspice — no invented RC ramps.
   */
  private startSpiceWavePlayback(
    wave: SpiceWaveform,
    sig: string,
    applyFrame: (result: DcSolveResult | null, backend: 'ngspice' | 'legacy') => void,
  ): void {
    // Commit the *current* sample only — committing the end IC at start made the next
    // SPICE fill start already settled (flat charge/discharge caches).
    commitNgspiceNodeIc(wave.samples[0]!.netVoltages);
    const durationMs = Math.max(16, wave.tstopSec * 1000);
    this.spiceWavePlay = {
      samples: wave.samples,
      startedAt: performance.now(),
      durationMs,
      sig,
      idx: -1,
    };
    this.lastDc = wave.samples[0]!;
    this.lastDcFromNgspice = true;
    this.lastSpiceSig = sig;
    applyFrame(wave.samples[0]!, 'ngspice');
  }

  /**
   * At most one ngspice OP in flight. A newer request replaces any pending one so GPIO
   * edges are not stuck behind a multi-second FIFO of stale HIGH/LOW solves.
   */
  private enqueueNgspiceRefresh(
    req: {
      requestSig: string;
      components: PlacedComponent[];
      simTimeMs: number;
      resistorBlown: Record<string, boolean>;
      ledBlown: Record<string, boolean>;
      capacitorBlown: Record<string, boolean>;
      mcuSources: McuSourceMap;
    },
    mcu: PlacedComponent | null,
    applyFrame: (result: DcSolveResult | null, backend: 'ngspice' | 'legacy') => void,
  ): void {
    if (this.ngspiceBusy) {
      if (this.ngspiceInFlightSig && this.ngspiceInFlightSig !== req.requestSig) {
        // GPIO flipped while SPICE still solving the previous half-cycle — kill it and
        // start the current edge immediately (logs: perpetual dropped-stale / phase lag).
        abortNgspiceInFlight();
        this.ngspiceBusy = false;
        this.ngspiceInFlightSig = '';
        this.ngspiceCoalesce = null;
        this.spiceWavePlay = null;
        // fall through and start immediately
      } else {
        this.ngspiceCoalesce = req;
        return;
      }
    }
    // GPIO edge: abort prior waveform so visuals track the blink, not a stale .tran.
    if (this.spiceWavePlay && this.spiceWavePlay.sig !== req.requestSig) {
      this.spiceWavePlay = null;
    }
    // Same electrical state already animating from SPICE — don't re-queue.
    if (
      this.spiceWavePlay &&
      this.spiceWavePlay.sig === req.requestSig &&
      performance.now() - this.spiceWavePlay.startedAt < this.spiceWavePlay.durationMs
    ) {
      return;
    }
    this.ngspiceBusy = true;
    this.ngspiceInFlightSig = req.requestSig;
    const bridge = this.bridge;
    if (!bridge) {
      this.ngspiceBusy = false;
      this.ngspiceInFlightSig = '';
      return;
    }
    const fillKind = spiceWaveKindFromSolveSig(req.requestSig);
    if (fillKind) {
      prepareIcForSpiceWaveFill(
        fillKind,
        circuitKeyFromSolveSig(req.requestSig),
        req.components,
        bridge.netlist,
      );
    }
    void refreshDcOperatingPoint(
      req.components,
      bridge.netlist,
      req.simTimeMs,
      req.resistorBlown,
      req.ledBlown,
      this.buttonPressed,
      req.mcuSources,
      req.capacitorBlown,
    )
      .then(({ result, backend }) => {
        if (!this.bridge) return;
        if (mcu && !this.runner) return;
        if (!mcu && !this.circuitOnly) return;
        // Superseded by a newer GPIO-edge flight.
        if (this.ngspiceInFlightSig !== req.requestSig) return;
        if (backend === 'ngspice' && result) {
          const sigMatch = req.requestSig === this.lastSolveSig;
          if (!sigMatch) {
            takeNgspiceWaveform();
            return;
          }
          const wave = takeNgspiceWaveform();
          if (wave && wave.samples.length > 1) {
            const kind = spiceWaveKindFromSolveSig(req.requestSig);
            const cKey = circuitKeyFromSolveSig(req.requestSig);
            if (kind) {
              putSpiceWaveCache(cKey, kind, wave);
            }
            // First fill may be late vs edge — still play remaining SPICE points in real time
            // from now (cache hits on later edges start immediately at the GPIO edge).
            const edgeAgeMs =
              this.gpioEdgeSig === req.requestSig
                ? performance.now() - this.gpioEdgeAtMs
                : 0;
            const tstopMs = Math.max(16, wave.tstopSec * 1000);
            if (edgeAgeMs >= tstopMs) {
              const end = wave.samples[wave.samples.length - 1]!;
              this.spiceWavePlay = null;
              this.lastDc = end;
              this.lastDcFromNgspice = true;
              this.lastSpiceSig = req.requestSig;
              commitNgspiceNodeIc(end.netVoltages);
              applyFrame(end, backend);
            } else if (edgeAgeMs > 8) {
              const u0 = edgeAgeMs / tstopMs;
              const startIdx = Math.min(
                wave.samples.length - 1,
                Math.max(0, Math.floor(u0 * (wave.samples.length - 1))),
              );
              const sliced: SpiceWaveform = {
                samples: wave.samples.slice(startIdx),
                tstopSec: wave.tstopSec * (1 - u0),
              };
              this.startSpiceWavePlayback(sliced, req.requestSig, applyFrame);
            } else {
              this.startSpiceWavePlayback(wave, req.requestSig, applyFrame);
            }
          } else {
            this.spiceWavePlay = null;
            this.lastDc = result;
            this.lastDcFromNgspice = true;
            this.lastSpiceSig = req.requestSig;
            commitNgspiceNodeIc(result.netVoltages);
            applyFrame(result, backend);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        // Ignore finally from an aborted/superseded flight.
        if (this.ngspiceInFlightSig !== req.requestSig) return;
        this.ngspiceBusy = false;
        this.ngspiceInFlightSig = '';
        const next = this.ngspiceCoalesce;
        this.ngspiceCoalesce = null;
        if (!next || !this.bridge) return;
        const play = this.spiceWavePlay;
        const playing =
          !!play &&
          performance.now() - play.startedAt < play.durationMs;
        if (playing && next.requestSig === play!.sig) return;
        this.enqueueNgspiceRefresh(next, mcu, applyFrame);
      });
  }

  private startCircuitOnly(
    components: PlacedComponent[],
    wires: Wire[],
  ): void {
    resetSimLiveState();
    this.circuitOnly = true;
    this.circuitStartMs = performance.now();
    this.bridge = createCircuitBridge(components, wires);
    this.netLevels = new Map();

    const sync = () => this.runSolveFrame(components, null);

    this.syncPortsFn = sync;
    this.callbacks.onStatus('running');
    sync();

    // Pre-cache ngspice OP for open + pressed so press/release is instant.
    const { resistorBlown, ledBlown, capacitorBlown } = this.bridge.simState;
    for (const btn of components.filter((c) => c.type === 'button')) {
      void refreshDcOperatingPoint(
        components,
        this.bridge.netlist,
        0,
        resistorBlown,
        ledBlown,
        {},
        new Map(),
        capacitorBlown,
      );
      void refreshDcOperatingPoint(
        components,
        this.bridge.netlist,
        0,
        resistorBlown,
        ledBlown,
        { [btn.id]: true },
        new Map(),
        capacitorBlown,
      );
    }

    const loop = () => {
      if (!this.circuitOnly) return;
      this.circuitRafId = requestAnimationFrame(loop);
      if (this.isCanvasInteracting()) return;
      sync();
    };
    this.circuitRafId = requestAnimationFrame(loop);
  }

  /** Run circuit solve at most once per animation frame. */
  private scheduleFrameSync(): void {
    if (this.frameSyncScheduled) return;
    this.frameSyncScheduled = true;
    requestAnimationFrame(() => {
      this.frameSyncScheduled = false;
      if (!this.runner) return;
      if (this.isCanvasInteracting()) {
        this.scheduleFrameSync();
        return;
      }
      this.syncPortsFn?.();
    });
  }

  /** Batch GPIO updates so simulation does not flood React. */
  private queueUiUpdate(
    byComponent?: Record<string, Record<string, PinState>>,
    simFlags?: ComponentSimFlags,
    dcSolverBackend: DcSolverBackend = null,
    dcResult?: DcSolveResult | null,
  ): void {
    if (byComponent && simFlags) {
      this.pendingPinStates = {
        byComponent,
        simFlags,
        dcSolverBackend,
        ngspiceDebug: ngspiceDebugFromResult(dcSolverBackend, dcResult),
      };
    }
    if (this.syncScheduled) return;
    this.syncScheduled = true;
    requestAnimationFrame(() => {
      this.syncScheduled = false;
      if (!this.runner && !this.circuitOnly) return;
      this.flushPendingPinUi();
    });
  }

  /** Push throttled pin UI update to the live visual store. */
  flushPendingPinUi(): void {
    if (!this.pendingPinStates) return;
    if (this.isCanvasInteracting()) {
      this.scheduleUiRetry();
      return;
    }

    const now = performance.now();
    if (now - this.lastPinUiMs < 16) {
      this.scheduleUiRetry();
      return;
    }

    const pending = this.pendingPinStates;
    this.pendingPinStates = null;
    this.lastPinUiMs = now;
    applySimLivePinStates(
      pending.byComponent,
      pending.simFlags,
      pending.dcSolverBackend,
      pending.ngspiceDebug,
    );
  }

  /** Re-run circuit solve + flush visuals (after canvas interaction). */
  forceVisualSync(): void {
    if (this.uiRetryTimer !== null) {
      clearTimeout(this.uiRetryTimer);
      this.uiRetryTimer = null;
    }
    if (!this.isCanvasInteracting()) {
      this.syncPortsFn?.();
    }
    this.flushPendingPinUi();
  }

  private scheduleUiRetry(): void {
    if (this.uiRetryTimer !== null) return;
    this.uiRetryTimer = setTimeout(() => {
      this.uiRetryTimer = null;
      if (!this.runner && !this.circuitOnly) return;
      this.flushPendingPinUi();
    }, 16);
  }

  /** Stop AVR + bridge without changing UI status (used before a new run). */
  private haltRunner(): void {
    this.syncScheduled = false;
    this.frameSyncScheduled = false;
    this.pendingPinStates = null;
    this.syncPortsFn = null;
    this.lastNgspiceRefreshMs = 0;
    this.lastRefreshSig = '';
    this.lastSolveSig = '';
    this.frameAppliedForSig = '';
    this.lastDc = null;
    this.lastDcFromNgspice = false;
    this.lastSpiceSig = '';
    this.spiceWavePlay = null;
    this.ngspiceInFlightSig = '';
    this.gpioEdgeAtMs = 0;
    this.gpioEdgeSig = '';
    this.ngspiceBusy = false;
    this.ngspiceCoalesce = null;
    this.lastCapabilitySig = null;
    this.ngspiceCapableCache = false;
    this.circuitOnly = false;
    terminateNgspiceWorker();
    invalidateNgspiceCache();
    if (this.circuitRafId !== null) {
      cancelAnimationFrame(this.circuitRafId);
      this.circuitRafId = null;
    }
    if (this.uiRetryTimer !== null) {
      clearTimeout(this.uiRetryTimer);
      this.uiRetryTimer = null;
    }
    if (this.detachLcdGpioProbe) {
      this.detachLcdGpioProbe();
      this.detachLcdGpioProbe = null;
    }
    if (this.runner) {
      this.runner.stop();
      this.runner = null;
    }
    this.bridge = null;
    this.netLevels.clear();
    this.buttonPressed = {};
    clearLcdSimState();
  }

  stop(): void {
    this.haltRunner();
    this.callbacks.onStatus('idle');
  }
}

/**
 * Cheap signature of the only inputs that change between frames during a run
 * (GPIO/board source voltages, button presses, blown parts). Components and
 * wires are fixed while a sim runs, so an unchanged signature means the ngspice
 * cache key is unchanged too — used to gate redundant capability checks and
 * refresh attempts without rebuilding the full netlist/cache key every frame.
 */
function runtimeSolveSignature(
  components: PlacedComponent[],
  simTimeMs: number,
  mcuSources: McuSourceMap,
  buttonPressed: Record<string, boolean>,
  resistorBlown: Record<string, boolean>,
  ledBlown: Record<string, boolean>,
  capacitorBlown: Record<string, boolean> = {},
): string {
  const sources = [...mcuSources.entries()]
    .map(([net, volts]) => net + '=' + volts + ':' + JSON.stringify(mcuSources.gpioPins?.get(net) ?? []))
    .sort()
    .join(',');
  const parts = components
    .map((c) => {
      const extra = getPartModule(c.type)?.spiceCacheKey?.({
        comp: c,
        simTimeMs,
        resistorBlown,
        ledBlown,
        buttonPressed,
        capacitorBlown,
      });
      return extra ? `${c.id}:${extra}` : '';
    })
    .filter(Boolean)
    .join('|');
  return `${sources}::${parts}`;
}

function ngspiceDebugFromResult(
  backend: DcSolverBackend,
  result?: DcSolveResult | null,
): NgspiceDcDebug | null {
  if (backend !== 'ngspice' || !result) return null;
  return {
    branchCurrentMa: { ...(result.branchCurrentMa ?? {}) },
    netVoltages: Object.fromEntries(result.netVoltages),
    ledConducting: { ...result.ledConducting },
  };
}

function formatHexLoadMessage(
  filename: string | undefined,
  validation: HexValidationResult,
): string {
  const name = filename ?? 'firmware.hex';
  const lines = [
    `Loaded Intel HEX: ${name}`,
    `Program data: ${validation.dataBytes ?? 0} bytes (ATmega328P)`,
  ];
  if (validation.entryPoint !== undefined) {
    lines.push(`Entry point: 0x${validation.entryPoint.toString(16).toUpperCase()}`);
  }
  lines.push('Source: Arduino IDE / avr-gcc export');
  return lines.join('\n');
}

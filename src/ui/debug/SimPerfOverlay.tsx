/**
 * What: Always-on Run overlay for AVR throughput, sim/wall drift, and solve cost.
 * Role: Subscribe to the independent performance snapshot in `simLiveStore` while running.
 * Owns/exports: `SimPerfOverlay`.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | Changelog creation
#                     | Permanent overlay (no ?simPerf=1 gate); removed agent ingest notes
# 09-10-2026 | Cursor | Moved from `src/components/SimPerfOverlay.tsx` (tree reorganization)
# 22-10-2026 | Codex | Subscribe directly to performance metrics with useSyncExternalStore; preserve the readout while avoiding parent canvas renders.
 */
import { useSyncExternalStore } from 'react';
import { getSimPerfSnapshot, subscribeSimPerf, type SimPerfSnapshot } from '../../store/simLiveStore';

function fmtMs(ms: number): string {
  if (Math.abs(ms) >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${ms.toFixed(0)} ms`;
}

function fmtMhz(mhz: number): string {
  return `${mhz.toFixed(2)} MHz (target 16.00)`;
}

type Props = {
  perf: SimPerfSnapshot;
};

export function SimPerfOverlay() {
  const perf = useSyncExternalStore(subscribeSimPerf, getSimPerfSnapshot, getSimPerfSnapshot);
  return perf ? <SimPerfReadout perf={perf} /> : null;
}

function SimPerfReadout({ perf }: Props) {
  const driftWarn = Math.abs(perf.driftMs) > 500;
  const mhzWarn = perf.effectiveMhz > 0 && perf.effectiveMhz < 12;
  const catchupWarn = perf.catchupResyncCount > 0;

  return (
    <div className="sim-perf-overlay" aria-label="Sim performance">
      <div className="sim-perf-header">Sim perf</div>
      <table className="sim-perf-table">
        <tbody>
          <tr>
            <th>Sim time</th>
            <td className="sim-perf-num">{(perf.simTimeMs / 1000).toFixed(2)} s</td>
          </tr>
          <tr>
            <th>Wall elapsed</th>
            <td className="sim-perf-num">{(perf.wallElapsedMs / 1000).toFixed(2)} s</td>
          </tr>
          <tr className={driftWarn ? 'sim-perf-warn' : ''}>
            <th>Drift (wall − sim)</th>
            <td className="sim-perf-num">{fmtMs(perf.driftMs)}</td>
          </tr>
          <tr>
            <th>Cycles behind</th>
            <td className="sim-perf-num">{perf.cyclesBehind.toLocaleString()}</td>
          </tr>
          <tr className={mhzWarn ? 'sim-perf-warn' : ''}>
            <th>Effective (1 s roll)</th>
            <td className="sim-perf-num">{fmtMhz(perf.effectiveMhz)}</td>
          </tr>
          <tr>
            <th>Instr / s (roll)</th>
            <td className="sim-perf-num">{perf.instructionsPerSec.toLocaleString()}</td>
          </tr>
          <tr className={catchupWarn ? 'sim-perf-warn' : ''}>
            <th>Catch-up resyncs</th>
            <td className="sim-perf-num">{perf.catchupResyncCount}</td>
          </tr>
          <tr>
            <th>Last AVR batch</th>
            <td className="sim-perf-num">
              {perf.instructionsLastBatch.toLocaleString()} instr ·{' '}
              {perf.avrBatchWallMs.toFixed(2)} ms wall
            </td>
          </tr>
          <tr>
            <th>LCD GPIO calls / batch</th>
            <td className="sim-perf-num">
              {perf.gpioListenerCallsLastBatch.toLocaleString()} listener ·{' '}
              {perf.feedLcdCallsLastBatch.toLocaleString()} feed
            </td>
          </tr>
          <tr>
            <th>Last solve frame</th>
            <td className="sim-perf-num">
              {perf.solveFrameWallMs.toFixed(2)} ms · {perf.solveBackend ?? '—'}
              {perf.ngspiceRanLastFrame ? ' · ngspice ran' : ''}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

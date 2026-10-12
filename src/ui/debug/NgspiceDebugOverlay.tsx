/**
 * What: Dev-only HTML panel listing ngspice DC branch currents and node voltages for the live circuit.
 * Exports NgspiceDebugOverlay; props components[] + debug: NgspiceDcDebug from simLiveStore. Formats mA/µA and
 * volts locally; labels rows via getDefinition(comp.type). SimCanvas shows it when sim is running and
 * liveSnap.dcSolverBackend === 'ngspice' with ngspiceDebug populated. To expose a new solved quantity: extend
 * NgspiceDcDebug in simLiveStore/sim pipeline first, then add a table section here. User-facing instrument
 * readouts stay on ComponentOverlays; solver/netlist build is src/circuit — not this overlay.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/components/NgspiceDebugOverlay.tsx` (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */
import { useMemo } from 'react';
import { getDefinition } from '../../registry/components';
import type { NgspiceDcDebug } from '../../store/simLiveStore';
import type { PlacedComponent } from '../../types';

function formatCurrentMa(ma: number): string {
  const abs = Math.abs(ma);
  if (abs >= 100) return `${ma.toFixed(1)} mA`;
  if (abs >= 1) return `${ma.toFixed(2)} mA`;
  if (abs >= 0.01) return `${ma.toFixed(3)} mA`;
  return `${(ma * 1000).toFixed(1)} µA`;
}

function formatVoltage(v: number): string {
  return `${v.toFixed(3)} V`;
}

function componentLabel(comp: PlacedComponent): string {
  return getDefinition(comp.type).label;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 6)}…` : id;
}

type Props = {
  components: PlacedComponent[];
  debug: NgspiceDcDebug;
};

export function NgspiceDebugOverlay({ components, debug }: Props) {
  const branchRows = useMemo(() => {
    const compById = new Map(components.map((c) => [c.id, c]));
    return Object.entries(debug.branchCurrentMa)
      .map(([id, ma]) => {
        const comp = compById.get(id);
        return {
          id,
          label: comp ? componentLabel(comp) : 'Unknown',
          ma,
          ledOn: comp?.type === 'led' ? debug.ledConducting[id] : undefined,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }, [components, debug.branchCurrentMa, debug.ledConducting]);

  const netRows = useMemo(
    () =>
      Object.entries(debug.netVoltages)
        .map(([netId, volts]) => ({ netId: Number(netId), volts }))
        .filter((row) => Number.isFinite(row.netId))
        .sort((a, b) => a.netId - b.netId),
    [debug.netVoltages],
  );

  return (
    <div className="ngspice-debug-overlay" aria-label="ngspice DC debug">
      <div className="ngspice-debug-header">ngspice DC</div>

      <div className="ngspice-debug-section">
        <div className="ngspice-debug-section-title">Branch current</div>
        {branchRows.length === 0 ? (
          <p className="ngspice-debug-empty">No branch data</p>
        ) : (
          <table className="ngspice-debug-table">
            <thead>
              <tr>
                <th>Part</th>
                <th>I</th>
              </tr>
            </thead>
            <tbody>
              {branchRows.map((row) => (
                <tr key={row.id}>
                  <td title={row.id}>
                    {row.label}
                    <span className="ngspice-debug-id">{shortId(row.id)}</span>
                    {row.ledOn !== undefined && (
                      <span
                        className={`ngspice-debug-led${row.ledOn ? ' is-on' : ''}`}
                      >
                        {row.ledOn ? ' ON' : ' off'}
                      </span>
                    )}
                  </td>
                  <td className="ngspice-debug-num">{formatCurrentMa(row.ma)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {netRows.length > 0 && (
        <div className="ngspice-debug-section">
          <div className="ngspice-debug-section-title">Node voltage</div>
          <table className="ngspice-debug-table ngspice-debug-table-nets">
            <tbody>
              {netRows.map((row) => (
                <tr key={row.netId}>
                  <td>Net {row.netId}</td>
                  <td className="ngspice-debug-num">{formatVoltage(row.volts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

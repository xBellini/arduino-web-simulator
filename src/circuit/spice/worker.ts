/**
 * What: Module Web Worker that runs eecircuit-engine (ngspice-45.2 WASM, MIT, npm
 * `eecircuit-engine`) for the canvas `.op` / capacitor `.tran` solves. One `Simulation` instance
 * is started on first use and kept for the worker's lifetime; jobs run strictly one at a time.
 *
 * Protocol: main thread posts `{ type: 'op' | 'tran', id, netlist, libFiles, tstep?, tstop? }`.
 * Worker replies `{ type: 'engine', engine, version }` once after start, then per job
 * `{ type: 'op-result' | 'tran-result', id, ok, nodeVolts, branchAmps, waveSamples, errors, error? }`.
 * - `nodeVolts`: node name (lowercase) → V; `branchAmps`: V-source name (uppercase) → A.
 * - `.op`: single point. `.tran`: values are the last time point; `waveSamples` holds
 *   {@link WAVE_N} points picked from the engine vectors (first, last, evenly spaced by index).
 *
 * Conventions: `.include /lib/<rel>` lines from netlistExport are replaced by the matching
 * `libFiles[rel]` text (the engine has no filesystem API). Deck + library text pass through
 * `convertPspiceCompat`; decks with LAPLACE/XSPICE constructs are refused before reaching the
 * engine (they hang or kill it). A deck ngspice rejects still resolves `runSim` with the
 * *previous* run's vectors, so any error line in `getError()` fails the job. A dead or hung
 * engine is handled by the client terminating this worker on timeout. ngspice-45 raises diode
 * `Is` below 1e-28 to 1e-28 (measured), unlike Concord ngspice-26.
 *
 * Not here: Cache, GPIO supersede, mapping to DcSolveResult — see spice/client.ts.
 *
# Changelog
# Date       | Author | Remarks
# 09-10-2026 | Cursor | Changelog creation (replaces Concord ngspice-26 pipe-mode worker)
#                     | Moved from `src/sim/spice/ngspice.worker.ts` (tree reorganization)
 */

import { Simulation } from 'eecircuit-engine';
import { convertPspiceCompat, findUnsupportedConstructs } from './pspiceCompat';

const ENGINE = 'eecircuit-engine 1.7.0';
/** Same sample count the Concord worker exported along `.tran`. */
const WAVE_N = 16;
/** Option set the Concord worker applied before `tran` (as `set` commands there). */
const TRAN_OPTIONS = '.options method=gear reltol=0.02 abstol=1e-5 chgtol=1e-11 trtol=7';

type Job = {
  type: 'op' | 'tran';
  id: number;
  netlist: string;
  libFiles?: Record<string, string>;
  tstep?: number;
  tstop?: number;
};

type Point = { nodeVolts: Record<string, number>; branchAmps: Record<string, number> };

let simPromise: Promise<Simulation> | null = null;
let chain: Promise<void> = Promise.resolve();

function engine(): Promise<Simulation> {
  if (!simPromise) {
    simPromise = (async () => {
      const sim = new Simulation();
      await sim.start();
      const version = /ngspice-[\w.+]+/.exec(sim.getInitInfo())?.[0] ?? 'unknown';
      self.postMessage({ type: 'engine', engine: ENGINE, version });
      return sim;
    })();
  }
  return simPromise;
}

function buildDeck(job: Job): { deck: string; unsupported: string[] } {
  const libs = job.libFiles ?? {};
  const body = job.netlist
    .split(/\r?\n/)
    .flatMap((line) => {
      const inc = /^\s*\.include\s+\/lib\/(.+?)\s*$/i.exec(line);
      if (inc) {
        const text = libs[inc[1]!];
        return text === undefined ? [`* missing library ${inc[1]}`] : [text];
      }
      if (/^\s*\.end\s*$/i.test(line)) return [];
      return [line];
    })
    .join('\n');
  const converted = convertPspiceCompat(body);
  const analysis =
    job.type === 'tran'
      ? [TRAN_OPTIONS, `.tran ${job.tstep && job.tstep > 0 ? job.tstep : 1e-4} ${job.tstop && job.tstop > 0 ? job.tstop : 1e-3}`]
      : ['.op'];
  return {
    deck: [converted, ...analysis, '.end'].join('\n'),
    unsupported: findUnsupportedConstructs(converted),
  };
}

function pointAt(data: { name: string; values: number[] }[], index: number): Point {
  const nodeVolts: Record<string, number> = {};
  const branchAmps: Record<string, number> = {};
  for (const vec of data) {
    const value = vec.values[Math.min(index, vec.values.length - 1)];
    if (value === undefined || !Number.isFinite(value)) continue;
    const v = /^v\((.+)\)$/i.exec(vec.name);
    if (v) {
      nodeVolts[v[1]!.toLowerCase()] = value;
      continue;
    }
    const i = /^i\((.+)\)$/i.exec(vec.name) ?? /^(.+)#branch$/i.exec(vec.name);
    if (i) branchAmps[i[1]!.toUpperCase()] = value;
  }
  return { nodeVolts, branchAmps };
}

function waveIndices(length: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < WAVE_N; s++) {
    if (s === 0) out.push(0);
    else if (s === WAVE_N - 1) out.push(length - 1);
    else out.push(Math.min(length - 1, Math.floor((length * s) / (WAVE_N - 1))));
  }
  return out;
}

async function runJob(job: Job): Promise<void> {
  const resultType = job.type === 'tran' ? 'tran-result' : 'op-result';
  const reply = (payload: Record<string, unknown>) =>
    self.postMessage({ type: resultType, id: job.id, ...payload });
  const { deck, unsupported } = buildDeck(job);
  if (unsupported.length > 0) {
    reply({ ok: false, error: `unsupported by engine: ${unsupported.join(', ')}`, errors: [] });
    return;
  }
  try {
    const sim = await engine();
    sim.setNetList(deck);
    const res = await sim.runSim();
    const errors = sim.getError();
    // A rejected deck still resolves runSim with the previous run's vectors.
    const fatal = errors.find((l) => /interrupted due to error|^\s*error\b|fatal/i.test(l));
    if (fatal) {
      reply({ ok: false, error: fatal.trim(), errors });
      return;
    }
    if (res.dataType !== 'real' || res.numPoints < 1 || res.data.length === 0) {
      reply({ ok: false, error: errors[0] ?? `ngspice ${job.type} returned no data`, errors });
      return;
    }
    const data = res.data as { name: string; values: number[] }[];
    const last = pointAt(data, res.numPoints - 1);
    const waveSamples =
      job.type === 'tran' ? waveIndices(res.numPoints).map((i) => pointAt(data, i)) : [];
    reply({ ok: true, ...last, waveSamples, errors });
  } catch (err) {
    reply({ ok: false, error: String(err instanceof Error ? err.message : err), errors: [] });
  }
}

self.onmessage = (event: MessageEvent<Job>) => {
  const job = event.data;
  if (!job || (job.type !== 'op' && job.type !== 'tran')) return;
  chain = chain.then(() => runJob(job));
};

void engine();

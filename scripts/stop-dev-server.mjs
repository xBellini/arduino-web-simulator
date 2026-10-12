/**
 * What: Dev helper that finds processes listening on the Vite dev port (default 5173, overridable
 * via `VITE_PORT`) using `netstat` on Windows and force-kills them with `taskkill`. Used by npm
 * scripts and `Localhost_starter.bat` before starting a fresh dev server when a previous instance
 * is stuck.
 * How-to: `npm run dev:stop` or `node scripts/stop-dev-server.mjs` from the repo root (Windows only).
 * Match Vite’s port with `set VITE_PORT=5174` (cmd) or `$env:VITE_PORT=5174` (PowerShell) before running
 * if you changed `server.port` in `vite.config.js`. Exits 0 with a message when nothing is listening;
 * otherwise prints each stopped PID. Extend by swapping the `netstat`/`taskkill` calls if you need Linux/macOS support.
 *
 * Changelog:
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

import { execSync } from 'node:child_process';

const PORT = process.env.VITE_PORT ?? '5173';

function listListeningPids(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const pid = line.trim().split(/\s+/).at(-1);
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

const pids = listListeningPids(PORT);
if (pids.length === 0) {
  console.log(`No process listening on port ${PORT}.`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'inherit' });
    console.log(`Stopped PID ${pid} (port ${PORT}).`);
  } catch {
    console.warn(`Could not stop PID ${pid}.`);
  }
}

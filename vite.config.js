/**
 * What: Vite configuration for the Arduino Simulator SPA: React plugin, custom user-projects
 * middleware for local sketch storage, and local arduino-cli compile API, on port 5173 with
 * strict binding (`host: true`) so both IPv4 and IPv6 localhost URLs work on Windows.
 * How-to: dev server via `npm run dev` or `Localhost_starter.bat`; production bundle via `npm run build`
 * (output in `dist/`). Change `server.port` / `strictPort` here if 5173 is taken — then set `VITE_PORT` when
 * running `scripts/stop-dev-server.mjs`. Add Vite plugins in the `plugins` array; user project API is wired
 * through `userProjectsPlugin(process.cwd())` — see `scripts/vite/vite-plugin-user-projects.js`; compile API via
 * `compilePlugin()` — see `scripts/vite/vite-plugin-compile.js`.
 *
 * Changelog:
 * - 09-10-2026 — Dev-server plugins moved to `scripts/vite/`
 * - 09-10-2026 — `worker.format: 'es'` (production build failed: iife cannot bundle the module workers)
 * - 24-09-2026 — Registered local `/api/compile` (arduino-cli) plugin
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { userProjectsPlugin } from './scripts/vite/vite-plugin-user-projects.js';
import { compilePlugin } from './scripts/vite/vite-plugin-compile.js';

export default defineConfig({
  plugins: [react(), userProjectsPlugin(process.cwd()), compilePlugin()],
  // AVR + ngspice workers are `type: 'module'` and code-split; the default 'iife' cannot bundle them.
  worker: { format: 'es' },
  server: {
    // Bind IPv4 + IPv6 so http://127.0.0.1:5173/ works (Windows often resolves localhost to ::1 only).
    host: true,
    port: 5173,
    strictPort: true,
  },
});

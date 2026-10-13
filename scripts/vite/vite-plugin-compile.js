/**
 * What: Vite middleware plugin exposing `/api/compile` for local sketch → Intel HEX via
 * `arduino-cli` (ATmega328P / `arduino:avr:uno`) during development only.
 * How-to: active with `npm run dev`; registered from `vite.config.js`. Requires `arduino-cli`
 * on PATH and `arduino-cli core install arduino:avr` (one-time, needs network). After that,
 * compile is offline. Routes: `GET /api/compile` → availability; `POST /api/compile` with
 * `{ sketch }` → `{ stdout, stderr, hex }` or error JSON.
 *
# Changelog
# Date       | Author | Remarks
# 24-09-2026 | Cursor | Changelog creation / local arduino-cli compile API
# 09-10-2026 | Cursor | Moved from `vite-plugin-compile.js` (tree reorganization)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FQBN = 'arduino:avr:uno';
const CLI = 'arduino-cli';
const COMPILE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean, spawnError?: string }>}
 */
function runArduinoCli(args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(CLI, args, {
        windowsHide: true,
        // Windows: resolve arduino-cli.cmd / .exe on PATH
        shell: process.platform === 'win32',
      });
    } catch (err) {
      finish({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        code: null,
        stdout,
        stderr,
        timedOut: false,
        spawnError: err.message,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, timedOut: false });
    });
  });
}

/** @type {{ at: number, result: object } | null} */
let availabilityCache = null;
const AVAIL_CACHE_MS = 30_000;

async function probeAvailability() {
  const now = Date.now();
  if (availabilityCache && now - availabilityCache.at < AVAIL_CACHE_MS) {
    return availabilityCache.result;
  }

  const version = await runArduinoCli(['version'], PROBE_TIMEOUT_MS);
  if (version.spawnError || version.timedOut || version.code !== 0) {
    const result = {
      available: false,
      cli: false,
      core: false,
      message: version.spawnError
        ? `arduino-cli not found on PATH (${version.spawnError}). Install from https://arduino.github.io/arduino-cli/ and restart the dev server.`
        : version.timedOut
          ? 'arduino-cli version probe timed out.'
          : `arduino-cli not usable: ${(version.stderr || version.stdout || 'unknown error').trim()}`,
    };
    availabilityCache = { at: now, result };
    return result;
  }

  const board = await runArduinoCli(
    ['board', 'details', '--fqbn', FQBN],
    PROBE_TIMEOUT_MS,
  );
  if (board.spawnError || board.timedOut || board.code !== 0) {
    const result = {
      available: false,
      cli: true,
      core: false,
      message:
        'arduino-cli found, but board/core for arduino:avr:uno is missing. Run once (needs network): arduino-cli core install arduino:avr',
    };
    availabilityCache = { at: now, result };
    return result;
  }

  const result = {
    available: true,
    cli: true,
    core: true,
    fqbn: FQBN,
    message: 'Local arduino-cli compile ready (offline after core install).',
  };
  availabilityCache = { at: now, result };
  return result;
}

function findHexFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.hex')) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = findHexFile(full);
      if (nested) return nested;
    }
  }
  return null;
}

function rmTemp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function compileSketchBody(sketch) {
  const avail = await probeAvailability();
  if (!avail.available) {
    return {
      status: 503,
      body: {
        unavailable: true,
        error: avail.message,
        stdout: '',
        stderr: avail.message,
        hex: '',
      },
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arduino-sim-compile-'));
  const sketchDir = path.join(tempRoot, 'sketch');
  const outDir = path.join(tempRoot, 'out');
  try {
    fs.mkdirSync(sketchDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(sketchDir, 'sketch.ino'), sketch, 'utf-8');

    const result = await runArduinoCli(
      [
        'compile',
        '--fqbn',
        FQBN,
        '--export-binaries',
        '--output-dir',
        outDir,
        sketchDir,
      ],
      COMPILE_TIMEOUT_MS,
    );

    if (result.timedOut) {
      return {
        status: 422,
        body: {
          compileError: true,
          stdout: result.stdout,
          stderr: `Local arduino-cli compile timed out after ${COMPILE_TIMEOUT_MS / 1000}s.`,
          hex: '',
        },
      };
    }

    if (result.code !== 0) {
      return {
        status: 422,
        body: {
          compileError: true,
          stdout: result.stdout,
          stderr: (result.stderr || result.stdout || 'Compile failed.').trim(),
          hex: '',
        },
      };
    }

    const hexPath = findHexFile(outDir);
    if (!hexPath) {
      return {
        status: 422,
        body: {
          compileError: true,
          stdout: result.stdout,
          stderr: 'arduino-cli succeeded but no .hex was found in the output directory.',
          hex: '',
        },
      };
    }

    const hex = fs.readFileSync(hexPath, 'utf-8');
    return {
      status: 200,
      body: {
        stdout: result.stdout,
        stderr: 'Compiled with local arduino-cli (arduino:avr:uno).',
        hex,
        usedLocalCompile: true,
      },
    };
  } finally {
    rmTemp(tempRoot);
  }
}

/** Dev-only API: local arduino-cli sketch compile → Intel HEX. */
export function compilePlugin() {
  return {
    name: 'arduino-compile',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url?.startsWith('/api/compile')) {
          next();
          return;
        }

        if (url !== '/api/compile') {
          next();
          return;
        }

        if (req.method === 'GET') {
          try {
            const status = await probeAvailability();
            sendJson(res, 200, status);
          } catch (err) {
            sendJson(res, 500, {
              available: false,
              message: err instanceof Error ? err.message : 'Availability probe failed',
            });
          }
          return;
        }

        if (req.method === 'POST') {
          try {
            const raw = await readBody(req);
            let sketch = '';
            try {
              const parsed = JSON.parse(raw);
              sketch = typeof parsed.sketch === 'string' ? parsed.sketch : '';
            } catch {
              sendJson(res, 400, {
                unavailable: false,
                compileError: true,
                error: 'Invalid JSON body; expected { sketch: string }',
                stdout: '',
                stderr: 'Invalid JSON body; expected { sketch: string }',
                hex: '',
              });
              return;
            }

            if (!sketch.trim()) {
              sendJson(res, 400, {
                compileError: true,
                error: 'Empty sketch',
                stdout: '',
                stderr: 'Empty sketch',
                hex: '',
              });
              return;
            }

            // Invalidate availability cache before compile so a freshly installed core is seen
            availabilityCache = null;
            const { status, body } = await compileSketchBody(sketch);
            sendJson(res, status, body);
          } catch (err) {
            sendJson(res, 500, {
              unavailable: true,
              error: err instanceof Error ? err.message : 'Compile request failed',
              stdout: '',
              stderr: err instanceof Error ? err.message : 'Compile request failed',
              hex: '',
            });
          }
          return;
        }

        next();
      });
    },
  };
}

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
# 15-10-2026 | Codex | Read an explicitly selected local HEX for automatic reload; restrict requests to same-origin loopback and reject changing or oversized files.
#                     | Select any HEX with a local Windows picker; use an absolute PowerShell path, report errors, and dispose the process on cancellation.
#                     | Remove the invisible owner window that prevented the file picker from appearing.
#                     | Raise only the picker process's dialog to the foreground so it does not open behind other applications.
#                     | Temporarily attach the picker input thread to the foreground thread when activating the file dialog.
#                     | Use the foreground window as the HEX dialog's native owner instead of forcing focus with a timer.
#                     | Close an abandoned picker normally so its owner is re-enabled after cancellation or timeout.
# 22-10-2026 | Codex | Report flash/static RAM from an adjacent AVR ELF after matching its flash bytes to the imported HEX; unavailable metadata never prevents import.
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

/** Read the same AVR sections used by Arduino's size recipe, verifying load bytes first. */
function readAvrMemoryUsage(elf, hex) {
  const unavailable = reason => ({ available: false, reason });
  if (elf.length < 52 || elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 1 || elf[5] !== 1 || elf.readUInt16LE(18) !== 83)
    return unavailable('Unsupported ELF: expected a 32-bit little-endian AVR executable.');
  if (elf.readUInt16LE(16) !== 2) return unavailable('ELF is not a linked executable.');
  const flash = new Map();
  let upper = 0, eof = false;
  for (const raw of hex.replace(/^\uFEFF/, '').trim().split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (eof || !/^:[0-9a-f]+$/i.test(line) || line.length % 2 !== 1) return unavailable('HEX cannot be verified.');
    const bytes = Buffer.from(line.slice(1), 'hex');
    if (bytes.length !== bytes[0] + 5 || (bytes.reduce((a, b) => a + b, 0) & 255)) return unavailable('HEX checksum or length is invalid.');
    const address = bytes.readUInt16BE(1), type = bytes[3], data = bytes.subarray(4, -1);
    if (type === 0) for (let i = 0; i < data.length; i++) {
      const a = upper + address + i;
      if (flash.has(a) && flash.get(a) !== data[i]) return unavailable('HEX has conflicting records.');
      flash.set(a, data[i]);
    }
    else if (type === 1) { if (data.length) return unavailable('Invalid HEX EOF.'); eof = true; }
    else if (type === 2 || type === 4) {
      if (data.length !== 2) return unavailable('Invalid HEX address record.');
      upper = data.readUInt16BE(0) * (type === 2 ? 16 : 65536);
    } else if (type !== 3 && type !== 5) return unavailable('Unsupported HEX record.');
  }
  if (!eof) return unavailable('HEX is incomplete.');
  const phoff = elf.readUInt32LE(28), phsize = elf.readUInt16LE(42), phnum = elf.readUInt16LE(44);
  const shoff = elf.readUInt32LE(32), shsize = elf.readUInt16LE(46), shnum = elf.readUInt16LE(48), namesIndex = elf.readUInt16LE(50);
  if (phsize < 32 || shsize < 40 || !shnum || namesIndex >= shnum || phoff + phsize * phnum > elf.length || shoff + shsize * shnum > elf.length)
    return unavailable('ELF headers are incomplete.');
  let matched = 0;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phsize;
    if (elf.readUInt32LE(p) !== 1) continue;
    const offset = elf.readUInt32LE(p + 4), address = elf.readUInt32LE(p + 12), size = elf.readUInt32LE(p + 16);
    if (offset + size > elf.length) return unavailable('ELF load segment is incomplete.');
    if (address >= 0x800000) continue; // AVR RAM/EEPROM address spaces are not flash.
    for (let j = 0; j < size; j++) {
      if (flash.get(address + j) !== elf[offset + j]) return unavailable('ELF does not match the imported HEX.');
      matched++;
    }
  }
  if (!matched) return unavailable('ELF contains no verifiable flash image.');
  const namesHeader = shoff + namesIndex * shsize;
  const namesOffset = elf.readUInt32LE(namesHeader + 16), namesSize = elf.readUInt32LE(namesHeader + 20);
  if (namesOffset + namesSize > elf.length) return unavailable('ELF section names are incomplete.');
  const names = elf.subarray(namesOffset, namesOffset + namesSize);
  let flashBytes = 0, ramBytes = 0, hasText = false;
  for (let i = 0; i < shnum; i++) {
    const p = shoff + i * shsize, nameIndex = elf.readUInt32LE(p), size = elf.readUInt32LE(p + 20);
    const end = names.indexOf(0, nameIndex);
    if (nameIndex >= names.length || end < 0) return unavailable('Invalid ELF section name.');
    const name = names.toString('utf8', nameIndex, end);
    if (name === '.text') hasText = true;
    if (['.text', '.data', '.bootloader'].includes(name)) flashBytes += size;
    if (['.data', '.bss', '.noinit'].includes(name)) ramBytes += size;
  }
  return hasText ? { available: true, flashBytes, ramBytes } : unavailable('ELF has no program section.');
}

/** Dev-only API: local arduino-cli sketch compile → Intel HEX. */
export function compilePlugin() {
  let pickerOpen = false;
  let usageCache = null;
  return {
    name: 'arduino-compile',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url === '/api/compile/hex-file') {
          const remote = req.socket.remoteAddress;
          const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
          const origin = req.headers.origin;
          if (!local || !origin || origin !== `http://${req.headers.host}` || req.method !== 'POST' ||
              !req.headers['content-type']?.startsWith('application/json')) {
            sendJson(res, 403, { error: 'HEX watching requires a local, same-origin request.' });
            return;
          }
          res.setHeader('Cache-Control', 'no-store');
          try {
            let { filename, pick } = JSON.parse(await readBody(req));
            if (pick) {
              if (process.platform !== 'win32') { sendJson(res, 501, { error: 'Local HEX picker requires Windows.' }); return; }
              if (pickerOpen) { sendJson(res, 409, { error: 'The HEX file picker is already open.' }); return; }
              pickerOpen = true;
              try {
                filename = await new Promise((resolve, reject) => {
                  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Threading.Tasks;
public sealed class HexPickerWindow : IWin32Window {
  public IntPtr Handle { get; private set; }
  public HexPickerWindow() { Handle = GetForegroundWindow(); }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public DialogResult Show(OpenFileDialog dialog) {
    var cancelled = Task.Run(() => Console.ReadLine());
    using (var timer = new Timer()) {
      timer.Interval = 100;
      timer.Tick += delegate {
        if (!cancelled.IsCompleted) return;
        IntPtr window = FindWindow("#32770", dialog.Title);
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        if (window != IntPtr.Zero && processId == System.Diagnostics.Process.GetCurrentProcess().Id) {
          timer.Stop();
          SendMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
        }
      };
      timer.Start();
      return dialog.ShowDialog(this);
    }
  }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object HexPickerWindow
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Import HEX firmware'
$dialog.Filter = 'Intel HEX (*.hex)|*.hex'
$dialog.CheckFileExists = $true
try {
  if ($owner.Show($dialog) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }
} finally { $dialog.Dispose() }`;
                  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
                  const child = spawn(executable, ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
                  let output = '', stderr = '';
                  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
                  child.stdout.on('data', chunk => { output += chunk; });
                  child.stderr.on('data', chunk => { stderr += chunk; });
                  child.stdin.on('error', () => {}); // The dialog may close before cancellation reaches it.
                  const cancel = () => { if (!child.stdin.destroyed) child.stdin.end(); };
                  res.on('close', cancel);
                  const timeout = setTimeout(() => { cancel(); reject(new Error('HEX file selection timed out.')); }, 120000);
                  child.on('error', error => { clearTimeout(timeout); res.off('close', cancel); reject(error); });
                  child.on('close', code => {
                    clearTimeout(timeout); res.off('close', cancel);
                    if (code === 0) resolve(output.trim().replace(/^\uFEFF/, ''));
                    else reject(new Error('HEX picker failed: ' + (stderr.trim() || 'process exited before selection')));
                  });
                });
              } finally { pickerOpen = false; }
              if (!filename) { sendJson(res, 200, { cancelled: true }); return; }
            }
            if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.hex') {
              sendJson(res, 400, { error: 'Enter the full path to a .hex file.' });
              return;
            }
            const before = await fs.promises.stat(filename);
            if (!before.isFile() || before.size > 1024 * 1024) {
              sendJson(res, 400, { error: 'Select a HEX file smaller than 1 MB.' });
              return;
            }
            const hex = await fs.promises.readFile(filename, 'utf8');
            const after = await fs.promises.stat(filename);
            if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
              sendJson(res, 409, { error: 'HEX is being rebuilt; waiting for it to finish.' });
              return;
            }
            let memoryUsage = { available: false, reason: 'Matching ELF unavailable.' };
            const elfPath = filename.replace(/(?:\.with_bootloader)?\.hex$/i, '.elf');
            try {
              const stat = await fs.promises.stat(elfPath);
              const key = JSON.stringify([filename, before.mtimeMs, before.ctimeMs, before.size, elfPath, stat.mtimeMs, stat.ctimeMs, stat.size]);
              if (usageCache?.key === key) memoryUsage = usageCache.value;
              else {
                if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('ELF is not a supported file (maximum 16 MB).');
                const elf = await fs.promises.readFile(elfPath);
                const stable = await fs.promises.stat(elfPath);
                if (stat.mtimeMs !== stable.mtimeMs || stat.ctimeMs !== stable.ctimeMs || stat.size !== stable.size) throw new Error('ELF is being rebuilt.');
                memoryUsage = readAvrMemoryUsage(elf, hex);
                usageCache = { key, value: memoryUsage };
              }
            } catch (error) {
              if (error.code !== 'ENOENT') memoryUsage.reason = error.message || 'Cannot read matching ELF.';
            }
            sendJson(res, 200, { hex, memoryUsage, filename: path.basename(filename), ...(pick ? { path: filename } : {}) });
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : 'Cannot read the HEX file.' });
          }
          return;
        }
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

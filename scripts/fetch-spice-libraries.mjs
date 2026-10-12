/**
 * What: Downloads and unpacks the KiCad-Spice-Library archive, copies `.lib`/`.mod` models into
 * `public/spice/models/`, indexes subcircuits and primitives, and writes `public/spice/catalog.json`
 * with searchable part ids, default model mappings for canvas component types, and metadata for
 * ngspice netlist generation. Run via `npm run fetch-spice-models`.
 * How-to: `npm run fetch-spice-models` from repo root (network + `tar` or PowerShell expand on Windows).
 * Outputs land under `public/spice/models/` and `public/spice/catalog.json` — commit or refresh those after
 * a run so the SPA sees new parts. Edit `COMPONENT_DEFAULTS` / `FUTURE_DEFAULTS` here to change which catalog
 * id backs each canvas type; re-run to rebuild the index. Uses a temp zip under the script dir during download.
 *
 * Hand-maintained models in `public/spice/bundled/` (with `bundled/catalog.json`) are merged into the
 * generated catalog and are never deleted by a fetch.
 *
 * Changelog:
 * - 09-10-2026 — Merge `public/spice/bundled/catalog.json` (TI gate models) into the generated catalog
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const modelsRoot = path.join(root, 'public', 'spice', 'models');
const catalogPath = path.join(root, 'public', 'spice', 'catalog.json');
/** Hand-maintained models outside the fetched library (`lib` paths start with `bundled/`). */
const bundledCatalogPath = path.join(root, 'public', 'spice', 'bundled', 'catalog.json');

const KICAD_ZIP =
  'https://codeload.github.com/kicad-spice-library/KiCad-Spice-Library/zip/refs/heads/master';

/** Canvas component type → default catalog part id (must exist after index). */
const COMPONENT_DEFAULTS = {
  diode: '1N4148',
  led: 'LED_GENERAL',
  transistor_npn: '2N2222',
  transistor_pnp: '2N2907',
  mosfet_n: '2N7002',
  mosfet_p: 'IRF9540',
  resistor: 'R_GENERIC',
  capacitor: 'C_GENERIC',
};

/** Future palette parts → suggested default models (catalog only for now). */
const FUTURE_DEFAULTS = {
  opamp: 'LM358',
  comparator: 'LM393',
  shift_register: '74HC595',
  logic_gate: '74HC00',
  eeprom: '24C02',
  adc: 'MCP3208',
  dac: 'MCP4725',
  triac: 'BT136',
  diac: 'DB3',
};

const LIB_EXTENSIONS = new Set(['.lib', '.mod', '.LIB', '.MOD', '.cir', '.sp']);

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function extractZip(zipPath, extractTo) {
  rmDir(extractTo);
  fs.mkdirSync(extractTo, { recursive: true });
  try {
    execSync(`tar -xf "${zipPath}" -C "${extractTo}"`, { stdio: 'inherit' });
    return;
  } catch {
    /* tar unavailable or failed — try PowerShell */
  }
  const ps =
    process.env.SYSTEMROOT != null
      ? path.join(process.env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
  execSync(
    `"${ps}" -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractTo.replace(/'/g, "''")}' -Force"`,
    { stdio: 'inherit' },
  );
}

function findModelsDir(extractRoot) {
  for (const name of fs.readdirSync(extractRoot)) {
    const candidate = path.join(extractRoot, name, 'Models');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  throw new Error('Models directory not found in extracted archive');
}

function walkLibFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkLibFiles(full, base));
      continue;
    }
    const ext = path.extname(entry.name);
    if (LIB_EXTENSIONS.has(ext)) {
      out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

/** Parse .model and .subckt names from SPICE library text. */
function indexSpiceFile(text, relPath) {
  const parts = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    i += 1;
    if (!line || line.startsWith('*')) continue;

    const modelMatch = line.match(/^\.model\s+(\S+)\s+(\S+)/i);
    if (modelMatch) {
      parts.push({
        id: modelMatch[1],
        kind: 'model',
        deviceClass: modelMatch[2].toUpperCase(),
        lib: relPath,
      });
      continue;
    }

    const subMatch = line.match(/^\.subckt\s+(\S+)/i);
    if (subMatch) {
      parts.push({
        id: subMatch[1],
        kind: 'subckt',
        deviceClass: 'X',
        lib: relPath,
      });
      // skip until .ends
      while (i < lines.length && !/^\s*\.ends\b/i.test(lines[i])) i += 1;
      continue;
    }
  }
  return parts;
}

function categorizePart(id, deviceClass, relPath) {
  const lower = id.toLowerCase();
  const libLower = relPath.toLowerCase();
  if (libLower.includes('digital logic') || /^74|^54|^40|^45/.test(id)) return 'digital';
  if (deviceClass === 'D' || lower.includes('led') || libLower.includes('diode')) return 'diode';
  if (deviceClass === 'NPN' || deviceClass === 'PNP' || deviceClass === 'Q') return 'bjt';
  if (deviceClass.includes('MOS') || deviceClass === 'NJF' || deviceClass === 'PJF') return 'fet';
  if (libLower.includes('operational amplifier') || /^lm|^tl|^op/i.test(id)) return 'opamp';
  if (libLower.includes('optocoupler')) return 'optocoupler';
  if (/triac|bt1/i.test(lower)) return 'triac';
  if (/diac|db3/i.test(lower)) return 'diac';
  if (/24c|eeprom|at24/i.test(lower)) return 'eeprom';
  if (/adc|ads|mcp3/i.test(lower)) return 'adc';
  if (/dac|mcp47/i.test(lower)) return 'dac';
  if (deviceClass === 'R') return 'resistor';
  if (deviceClass === 'C') return 'capacitor';
  return 'other';
}

function buildCatalog(modelsDir) {
  const libFiles = walkLibFiles(modelsDir);
  const byId = new Map();

  for (const rel of libFiles) {
    const full = path.join(modelsDir, rel);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const entry of indexSpiceFile(text, rel)) {
      const category = categorizePart(entry.id, entry.deviceClass, rel);
      const existing = byId.get(entry.id);
      if (existing) {
        existing.alternateLibs = existing.alternateLibs ?? [];
        if (existing.lib !== entry.lib) existing.alternateLibs.push(entry.lib);
        continue;
      }
      byId.set(entry.id, {
        id: entry.id,
        category,
        kind: entry.kind,
        deviceClass: entry.deviceClass,
        lib: entry.lib,
      });
    }
  }

  // Synthetic passives (native SPICE elements — no .model file required)
  byId.set('R_GENERIC', {
    id: 'R_GENERIC',
    category: 'resistor',
    kind: 'native',
    deviceClass: 'R',
    lib: null,
  });
  byId.set('C_GENERIC', {
    id: 'C_GENERIC',
    category: 'capacitor',
    kind: 'native',
    deviceClass: 'C',
    lib: null,
  });

  const parts = Object.fromEntries([...byId.entries()].sort(([a], [b]) => a.localeCompare(b)));

  const defaults = { ...COMPONENT_DEFAULTS };
  for (const [key, partId] of Object.entries(FUTURE_DEFAULTS)) {
    if (parts[partId]) defaults[key] = partId;
  }

  // Fill component defaults only when part exists in catalog
  for (const [compType, partId] of Object.entries(COMPONENT_DEFAULTS)) {
    if (!parts[partId]) {
      console.warn(`  warning: default ${compType} → ${partId} not found in libraries`);
      delete defaults[compType];
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'kicad-spice-library/KiCad-Spice-Library',
    modelCount: Object.keys(parts).length,
    libFileCount: libFiles.length,
    parts,
    defaults,
    componentDefaults: COMPONENT_DEFAULTS,
    futureDefaults: FUTURE_DEFAULTS,
  };
}

const SPICE_README_BODY = `- \`models/\` — \`.lib\` / \`.mod\` files by category (Diode, Transistor, Digital Logic, …). Downloaded; replaced on every fetch.
- \`bundled/\` — our own vendor models (TI SN74HCxx gates) plus \`bundled/catalog.json\`. Kept across fetches; catalog \`lib\` paths for these start with \`bundled/\`.
- \`catalog.json\` — index of \`.model\` / \`.subckt\` names → library path (fetched index + \`bundled/catalog.json\` merged).

**Offline:** served from \`/spice/models/\` and \`/spice/bundled/\`; the ngspice worker inlines \`.include\` files from these folders.
`;

async function main() {
  const tmp = path.join(root, '.tmp-spice-fetch');
  const zipPath = path.join(tmp, 'kicad-spice-library.zip');
  const extractRoot = path.join(tmp, 'extract');

  console.log('Fetching KiCad-Spice-Library (Models/) …');
  rmDir(modelsRoot);
  fs.mkdirSync(tmp, { recursive: true });

  const bytes = await download(KICAD_ZIP, zipPath);
  console.log(`  downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  console.log('Extracting …');
  extractZip(zipPath, extractRoot);
  const srcModels = findModelsDir(extractRoot);
  copyDir(srcModels, modelsRoot);

  const libCount = walkLibFiles(modelsRoot).length;
  console.log(`  copied ${libCount} library files → public/spice/models/`);

  console.log('Building catalog.json …');
  const catalog = buildCatalog(modelsRoot);
  const bundled = JSON.parse(fs.readFileSync(bundledCatalogPath, 'utf8'));
  Object.assign(catalog.parts, bundled.parts);
  Object.assign(catalog.componentDefaults, bundled.componentDefaults);
  catalog.modelCount = Object.keys(catalog.parts).length;
  console.log(`  merged ${Object.keys(bundled.parts).length} bundled models from public/spice/bundled/`);
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  console.log(`  indexed ${catalog.modelCount} models / subcircuits`);

  rmDir(tmp);

  fs.writeFileSync(
    path.join(root, 'public', 'spice', 'README.md'),
    `# SPICE model library

Fetched from [KiCad-Spice-Library](https://github.com/kicad-spice-library/KiCad-Spice-Library) (originally aggregated from ngspice model collections and vendor libraries).

\`\`\`bash
npm run fetch-spice-models
\`\`\`

${SPICE_README_BODY}`,
  );

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * What: Browser sketch → Intel HEX pipeline (local arduino-cli via Vite, Hexi remote, blink fallback).
 *
 * Owns/exports: `compileSketch`, `DEFAULT_SKETCH`, `normalizeSketch`, `isBundledBlinkSketch`,
 * `bundledBlinkHex`, `CompileResult`.
 *
 * Conventions: bundled blink short-circuits first (offline). Then prefer `/api/compile` when the
 * Vite plugin reports arduino-cli ready (offline after one-time core install). Infrastructure
 * miss falls through to Hexi; real sketch compile errors from local CLI are thrown (no silent
 * Hexi). Hexi needs network; 12 s timeout.
 *
 * To add another offline firmware bundle, add a detector like `isBundledBlinkSketch`, import
 * hex from `bundled/`, and branch inside `compileSketch` before network paths.
 * To change default editor template, update `DEFAULT_SKETCH` and regenerate
 * `BLINK_DEFAULT_HEX` (bottom of firmware.ts) if blink should still compile offline.
 *
 * Not here: Flash load/validate or AVR execution — see the HEX section of firmware.ts and runner.ts.
 * Not here: Vite middleware that shells arduino-cli — see scripts/vite/vite-plugin-compile.js.
 *
 * Merged in from `src/sim/intelHex.ts`: Intel HEX parse/validate/load for ATmega328P flash (32 KiB
 * / `0x8000`). Owns/exports: `HexValidationResult`, `normalizeHexText`, `validateHex`, `loadHex`.
 * Conventions: Record types 00/01/02/04 supported; checksum must pass. `loadHex` writes into a
 * caller-provided `Uint8Array` (AvrRunner uses a `Uint16Array` backing buffer). Validation reports
 * `dataBytes` and optional `entryPoint`. To preflight upload UI, call `validateHex` on
 * `normalizeHexText(userPaste)` before run. To support a larger MCU, change `FLASH_SIZE_BYTES` and
 * audit AvrRunner buffer sizing together. To fix IDE copy/paste issues, extend `normalizeHexText`
 * (BOM/CRLF already handled). Not here: Remote compile or bundled templates — see compileSketch and
 * `BLINK_DEFAULT_HEX` (bottom of firmware.ts).
 *
 * Merged in from `src/utils/compileApi.ts`: Optional HTTP client for the Vite-dev `/api/compile`
 * local arduino-cli endpoint. Role: probe availability and POST sketch source for Intel HEX — used
 * by `compileSketch`. Owns/exports: `isLocalCompileApiAvailable`, `compileSketchLocal`,
 * `LocalCompileUnavailableError`, `LocalCompileFailedError`. Conventions: GET `/api/compile` → `{
 * available }`; POST `{ sketch }` → CompileResult-shaped JSON. Infrastructure miss (503 /
 * available:false) vs sketch compile failure (422) are separate errors so callers can fall back to
 * Hexi only when the local toolchain is missing. Not-here: Hexi remote build or blink bundled HEX —
 * see `firmware.ts`.
 *
 * Merged in from `src/sim/bundled/blinkDefaultHex.ts`: Offline blink firmware blob — full Intel HEX
 * string for default LED_BUILTIN sketch. Owns/exports: `BLINK_DEFAULT_HEX` only (large string
 * constant). Conventions: Must stay in sync with `DEFAULT_SKETCH` in compileSketch and
 * `isBundledBlinkSketch` heuristics. Image is ATmega328P @ 16 MHz; CRLF-separated records. To
 * refresh after sketch/toolchain change, run `node scripts/fetch-bundled-blink-hex.mjs` and commit
 * the updated export (do not hand-edit hex lines). To add a second bundled sketch, prefer a new
 * file under `bundled/` plus compileSketch wiring. To verify size, use `validateHex` in a
 * one-off script — not at runtime import. Not here: Compile logic or detection — see compileSketch.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | [src/sim/bundled/blinkDefaultHex.ts] Changelog creation
#                     | [src/sim/bundled/blinkDefaultHex.ts] Expanded What with practical how-to notes
# 24-09-2026 | Cursor | [src/utils/compileApi.ts] Changelog creation / local compile API client
# 17-09-2026 | Cursor | [src/sim/intelHex.ts] Changelog creation
#                     | [src/sim/intelHex.ts] Expanded What with practical how-to notes
#                     | Changelog creation
#                     | Expanded What with practical how-to notes
# 24-09-2026 | Cursor | Prefer local `/api/compile` (arduino-cli) before Hexi
# 09-10-2026 | Cursor | Merged `src/sim/intelHex.ts` into this file (tree reorganization)
#                     | Merged `src/utils/compileApi.ts` into this file (tree reorganization)
#                     | Merged `src/sim/bundled/blinkDefaultHex.ts` into this file (tree reorganization)
#                     | Moved from `src/sim/compileSketch.ts` (tree reorganization)
 */


const API_BASE = '/api/compile';

export class LocalCompileUnavailableError extends Error {
  readonly unavailable = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'LocalCompileUnavailableError';
  }
}

export class LocalCompileFailedError extends Error {
  readonly compileError = true as const;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, stdout = '', stderr = '') {
    super(message);
    this.name = 'LocalCompileFailedError';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export interface LocalCompileResult {
  stdout: string;
  stderr: string;
  hex: string;
  usedLocalCompile?: boolean;
}

export async function isLocalCompileApiAvailable(): Promise<boolean> {
  try {
    const res = await fetch(API_BASE);
    if (!res.ok) return false;
    const data = (await res.json()) as { available?: boolean };
    return data.available === true;
  } catch {
    return false;
  }
}

export async function compileSketchLocal(source: string): Promise<LocalCompileResult> {
  let res: Response;
  try {
    res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sketch: source }),
    });
  } catch {
    throw new LocalCompileUnavailableError(
      'Local compile API unreachable (is the Vite dev server running?).',
    );
  }

  let data: {
    unavailable?: boolean;
    compileError?: boolean;
    error?: string;
    stdout?: string;
    stderr?: string;
    hex?: string;
    usedLocalCompile?: boolean;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new LocalCompileUnavailableError('Local compile API returned invalid JSON.');
  }

  if (res.status === 503 || data.unavailable) {
    throw new LocalCompileUnavailableError(
      data.error || data.stderr || 'Local arduino-cli compile is not available.',
    );
  }

  if (!res.ok || data.compileError || !data.hex) {
    const stderr = (data.stderr || data.error || 'Local compile failed.').trim();
    throw new LocalCompileFailedError(stderr, data.stdout ?? '', stderr);
  }

  return {
    stdout: data.stdout ?? '',
    stderr: data.stderr ?? 'Compiled with local arduino-cli.',
    hex: data.hex,
    usedLocalCompile: true,
  };
}

const FLASH_SIZE_BYTES = 0x8000;

export interface HexValidationResult {
  ok: boolean;
  message?: string;
  dataBytes?: number;
  entryPoint?: number;
}

/** Normalize line endings and strip BOM. */
export function normalizeHexText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function parseHexLine(line: string): {
  byteCount: number;
  address: number;
  recordType: number;
  data: number[];
} | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(':') || trimmed.length < 11) return null;

  const byteCount = Number.parseInt(trimmed.slice(1, 3), 16);
  const address = Number.parseInt(trimmed.slice(3, 7), 16);
  const recordType = Number.parseInt(trimmed.slice(7, 9), 16);
  const expectedLen = 1 + 2 + 4 + 2 + byteCount * 2 + 2;
  if (trimmed.length < expectedLen) return null;

  let checksum = byteCount + ((address >> 8) & 0xff) + (address & 0xff) + recordType;
  const data: number[] = [];
  for (let i = 0; i < byteCount; i++) {
    const b = Number.parseInt(trimmed.slice(9 + i * 2, 11 + i * 2), 16);
    if (Number.isNaN(b)) return null;
    data.push(b);
    checksum += b;
  }

  const checksumByte = Number.parseInt(
    trimmed.slice(9 + byteCount * 2, 11 + byteCount * 2),
    16,
  );
  if (Number.isNaN(checksumByte) || (checksum + checksumByte) & 0xff) {
    return null;
  }

  return { byteCount, address, recordType, data };
}

/** Load Intel HEX into a byte buffer (AVR flash image). */
export function loadHex(source: string, target: Uint8Array): void {
  target.fill(0xff);
  let upperAddress = 0;

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const rec = parseHexLine(line);
    if (!rec) continue;

    if (rec.recordType === 0x00) {
      const base = upperAddress + rec.address;
      for (let i = 0; i < rec.data.length; i++) {
        const addr = base + i;
        if (addr >= 0 && addr < target.length) {
          target[addr] = rec.data[i];
        }
      }
    } else if (rec.recordType === 0x01) {
      break;
    } else if (rec.recordType === 0x02) {
      upperAddress = ((rec.data[0] << 8) | rec.data[1]) << 4;
    } else if (rec.recordType === 0x04) {
      upperAddress = ((rec.data[0] << 8) | rec.data[1]) << 16;
    }
  }
}

/** Validate hex text from Arduino IDE / avr-gcc for ATmega328P. */
export function validateHexForAtmega328P(source: string): HexValidationResult {
  const text = normalizeHexText(source);
  if (!text.includes(':')) {
    return { ok: false, message: 'Not a valid Intel HEX file (no records found).' };
  }

  let upperAddress = 0;
  let dataBytes = 0;
  let maxAddr = -1;
  let entryPoint: number | undefined;
  let sawData = false;
  let lineNo = 0;

  for (const rawLine of text.split('\n')) {
    lineNo += 1;
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith(':')) {
      return { ok: false, message: `Invalid line ${lineNo}: expected Intel HEX record.` };
    }

    const rec = parseHexLine(line);
    if (!rec) {
      return { ok: false, message: `Invalid or corrupt HEX record on line ${lineNo}.` };
    }

    if (rec.recordType === 0x00) {
      sawData = true;
      const base = upperAddress + rec.address;
      for (let i = 0; i < rec.data.length; i++) {
        const addr = base + i;
        if (addr >= FLASH_SIZE_BYTES) {
          return {
            ok: false,
            message: `Flash data at 0x${addr.toString(16)} exceeds ATmega328P flash (32 KB).`,
          };
        }
        dataBytes += 1;
        maxAddr = Math.max(maxAddr, addr);
      }
    } else if (rec.recordType === 0x01) {
      break;
    } else if (rec.recordType === 0x02) {
      upperAddress = ((rec.data[0] << 8) | rec.data[1]) << 4;
    } else if (rec.recordType === 0x04) {
      upperAddress = ((rec.data[0] << 8) | rec.data[1]) << 16;
    } else if (rec.recordType === 0x05 && rec.data.length === 4) {
      entryPoint =
        (rec.data[0] << 24) |
        (rec.data[1] << 16) |
        (rec.data[2] << 8) |
        rec.data[3];
    }
  }

  if (!sawData) {
    return { ok: false, message: 'HEX file contains no program data.' };
  }

  if (maxAddr >= FLASH_SIZE_BYTES) {
    return {
      ok: false,
      message: 'HEX targets flash outside ATmega328P range (max 0x7FFF).',
    };
  }

  return { ok: true, dataBytes, entryPoint };
}

export function parseHexFile(text: string, filename: string): {
  hex: string;
  filename: string;
  validation: HexValidationResult;
} {
  const hex = normalizeHexText(text);
  const validation = validateHexForAtmega328P(hex);
  return { hex, filename, validation };
}

export const ARDUINO_IDE_HEX_HINT =
  'Arduino IDE: Sketch → Export compiled Binary (or copy the .hex from the verbose build output folder).';

const HEXI_URL = 'https://hexi.wokwi.com/build';
const COMPILE_TIMEOUT_MS = 12_000;

export interface CompileResult {
  stdout: string;
  stderr: string;
  hex: string;
  usedBundledFallback?: boolean;
  usedLocalCompile?: boolean;
}

export const DEFAULT_SKETCH = `// Blink — built-in LED on pin 13 (Uno/Nano)
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("ON");
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("OFF");
  delay(500);
}
`.trim();

/** Normalize sketch text so template / editor copies compare reliably. */
export function normalizeSketch(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\u2014/g, '-')
    .replace(/\u2212/g, '-')
    .trim();
}

export function isBundledBlinkSketch(source: string): boolean {
  const normalized = normalizeSketch(source);
  if (normalized === normalizeSketch(DEFAULT_SKETCH)) return true;

  return (
    /pinMode\s*\(\s*LED_BUILTIN\s*,\s*OUTPUT\s*\)/.test(normalized) &&
    /digitalWrite\s*\(\s*LED_BUILTIN\s*,\s*HIGH\s*\)/.test(normalized) &&
    /digitalWrite\s*\(\s*LED_BUILTIN\s*,\s*LOW\s*\)/.test(normalized) &&
    /delay\s*\(\s*500\s*\)/.test(normalized)
  );
}

/** Local precompiled firmware for blink demo / template (no network). */
export function bundledBlinkHex(source: string): string | null {
  return isBundledBlinkSketch(source) ? BLINK_DEFAULT_HEX : null;
}

function bundledBlinkResult(): CompileResult {
  return {
    stdout: '',
    stderr: 'Using bundled blink firmware (local).',
    hex: BLINK_DEFAULT_HEX,
    usedBundledFallback: true,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function compileWithHexi(source: string): Promise<CompileResult> {
  try {
    const resp = await fetchWithTimeout(
      HEXI_URL,
      {
        method: 'POST',
        mode: 'cors',
        cache: 'no-cache',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sketch: source }),
      },
      COMPILE_TIMEOUT_MS,
    );

    if (!resp.ok) {
      throw new Error(`Compiler HTTP ${resp.status}`);
    }

    const result = (await resp.json()) as CompileResult;
    if (!result.hex) {
      throw new Error(result.stderr?.trim() || 'Compile returned no hex.');
    }
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Online compiler timed out after ${COMPILE_TIMEOUT_MS / 1000}s. Check your network, use local arduino-cli (npm run dev), or import a .hex file from Arduino IDE.`,
      );
    }
    throw err;
  }
}

export async function compileSketch(source: string): Promise<CompileResult> {
  const bundled = bundledBlinkHex(source);
  if (bundled) {
    return bundledBlinkResult();
  }

  if (await isLocalCompileApiAvailable()) {
    try {
      const local = await compileSketchLocal(source);
      return {
        stdout: local.stdout,
        stderr: local.stderr,
        hex: local.hex,
        usedLocalCompile: true,
      };
    } catch (err) {
      if (err instanceof LocalCompileFailedError) {
        throw new Error(err.stderr || err.message);
      }
      if (!(err instanceof LocalCompileUnavailableError)) {
        throw err;
      }
      // Infrastructure miss — fall through to Hexi
    }
  }

  return compileWithHexi(source);
}

export const BLINK_DEFAULT_HEX = ":100000000C945D000C9485000C9485000C94850084\r\n:100010000C9485000C9485000C9485000C9485004C\r\n:100020000C9485000C9485000C9485000C9485003C\r\n:100030000C9485000C9485000C9485000C9485002C\r\n:100040000C9497020C9485000C9465020C943F026A\r\n:100050000C9485000C9485000C9485000C9485000C\r\n:100060000C9485000C9485000000000024002700FB\r\n:100070002A0000000000250028002B0004040404CE\r\n:100080000404040402020202020203030303030342\r\n:10009000010204081020408001020408102001021F\r\n:1000A00004081020000000080002010000030407FB\r\n:1000B00000000000000000009D0311241FBECFEFD0\r\n:1000C000D8E0DEBFCDBF11E0A0E0B1E0E4EAF7E0A8\r\n:1000D00002C005900D92AC31B107D9F721E0ACE137\r\n:1000E000B1E001C01D92A23CB207E1F710E0CDE5FE\r\n:1000F000D0E004C02197FE010E94CA03CC35D1078D\r\n:10010000C9F70E94E1020C94D0030C940000E1EBCB\r\n:10011000F0E02491EDE9F0E09491E9E8F0E0E49179\r\n:10012000EE23C9F0222339F0233001F1A8F4213065\r\n:1001300019F1223029F1F0E0EE0FFF1FEE58FF4FCA\r\n:10014000A591B4912FB7F894EC91811126C09095A8\r\n:100150009E239C932FBF08952730A9F02830C9F023\r\n:10016000243049F7209180002F7D03C0209180002A\r\n:100170002F7720938000DFCF24B52F7724BDDBCFEE\r\n:1001800024B52F7DFBCF2091B0002F772093B000B6\r\n:10019000D2CF2091B0002F7DF9CF9E2BDACFAF9236\r\n:1001A000BF92CF92DF92EF92FF920F931F93CF9364\r\n:1001B000DF936C017B018B01040F151FEB015E01C6\r\n:1001C000AE18BF08C017D10759F06991D601ED915B\r\n:1001D000FC910190F081E02DC6010995892B79F7FA\r\n:1001E000C501DF91CF911F910F91FF90EF90DF90AC\r\n:1001F000CF90BF90AF900895FC01538D448D252F73\r\n:1002000030E0842F90E0821B930B541710F0CF96B0\r\n:10021000089501970895FC01918D828D981761F0E2\r\n:10022000A28DAE0FBF2FB11D5D968C91928D9F5FF9\r\n:100230009F73928F90E008958FEF9FEF0895FC01D8\r\n:10024000918D828D981731F0828DE80FF11D858D8B\r\n:1002500090E008958FEF9FEF0895FC01918D228D1E\r\n:10026000892F90E0805C9F4F821B91098F739927A3\r\n:10027000089585E291E00E942D0121E0892B09F487\r\n:1002800020E0822F089580E090E0892B29F00E94E1\r\n:10029000390181110C9400000895FC01A48DA80F70\r\n:1002A000B92FB11DA35ABF4F2C91848D90E00196B8\r\n:1002B0008F739927848FA689B7892C93A089B189D8\r\n:1002C0008C91837080648C93938D848D981306C079\r\n:1002D0000288F389E02D80818F7D80830895EF92DD\r\n:1002E000FF920F931F93CF93DF93EC0181E0888FF0\r\n:1002F0009B8D8C8D98131AC0E889F989808185FFC0\r\n:1003000015C09FB7F894EE89FF896083E889F98961\r\n:1003100080818370806480839FBF81E090E0DF9163\r\n:10032000CF911F910F91FF90EF900895F62E0B8DB6\r\n:1003300010E00F5F1F4F0F731127E02E8C8D8E1171\r\n:100340000CC00FB607FCFACFE889F989808185FFD8\r\n:10035000F5CFCE010E944D01F1CFEB8DEC0FFD2FBB\r\n:10036000F11DE35AFF4FF0829FB7F8940B8FEA8993\r\n:10037000FB8980818062CFCFCF93DF93EC01888DA2\r\n:100380008823B9F0AA89BB89E889F9898C9185FD10\r\n:1003900003C0808186FD0DC00FB607FCF7CF8C919E\r\n:1003A00085FFF2CF808185FFEDCFCE010E944D0108\r\n:1003B000E9CFDF91CF9108953FB7F8948091210163\r\n:1003C00090912201A0912301B091240126B5A89B10\r\n:1003D00005C02F3F19F00196A11DB11D3FBFBA2FD7\r\n:1003E000A92F982F8827BC01CD01620F711D811D97\r\n:1003F000911D42E0660F771F881F991F4A95D1F71C\r\n:1004000008958F929F92AF92BF92CF92DF92EF9218\r\n:10041000FF920E94DC014B015C0184EFC82EDD24B9\r\n:10042000D394E12CF12C0E94DC01681979098A0926\r\n:100430009B09683E734081059105A8F321E0C21A2B\r\n:10044000D108E108F10888EE880E83E0981EA11C0F\r\n:10045000B11CC114D104E104F10429F7FF90EF901D\r\n:10046000DF90CF90BF90AF909F908F90089542E023\r\n:1004700050E062E171E085E291E00C94CF001F92C0\r\n:100480000F920FB60F9211242F933F934F935F93C8\r\n:100490006F937F938F939F93AF93BF93EF93FF934C\r\n:1004A00085E291E00E944D01FF91EF91BF91AF91E4\r\n:1004B0009F918F917F916F915F914F913F912F917C\r\n:1004C0000F900FBE0F901F9018951F920F920FB6AE\r\n:1004D0000F9211242F938F939F93EF93FF93E091AB\r\n:1004E0003501F09136018081E0913B01F0913C01B2\r\n:1004F00082FD1BC0908180913E018F5F8F732091A0\r\n:100500003F01821741F0E0913E01F0E0EB5DFE4FCC\r\n:10051000958F80933E01FF91EF919F918F912F9145\r\n:100520000F900FBE0F901F9018958081F4CF1F92EF\r\n:100530000F920FB60F9211242F933F938F939F9397\r\n:10054000AF93BF9380911D0190911E01A0911F0157\r\n:10055000B091200130911C0123E0230F2D3758F575\r\n:100560000196A11DB11D20931C0180931D01909344\r\n:100570001E01A0931F01B093200180912101909151\r\n:100580002201A0912301B09124010196A11DB11D6A\r\n:100590008093210190932201A0932301B093240121\r\n:1005A000BF91AF919F918F913F912F910F900FBE6F\r\n:1005B0000F901F90189526E8230F0296A11DB11DDC\r\n:1005C000D2CF789484B5826084BD84B5816084BDC7\r\n:1005D00085B5826085BD85B5816085BD80916E00E1\r\n:1005E000816080936E001092810080918100826012\r\n:1005F000809381008091810081608093810080914F\r\n:1006000080008160809380008091B100846080933D\r\n:10061000B1008091B00081608093B00080917A0039\r\n:10062000846080937A0080917A00826080937A005F\r\n:1006300080917A00816080937A0080917A0080684E\r\n:1006400080937A001092C100EDE9F0E02491E9E88E\r\n:10065000F0E08491882399F090E0880F991FFC01C5\r\n:10066000E859FF4FA591B491FC01EE58FF4F8591D9\r\n:1006700094918FB7F894EC91E22BEC938FBFE091BB\r\n:100680003501F091360182E08083E0913101F091F3\r\n:1006900032011082E0913301F09134018FEC8083BC\r\n:1006A00010923D01E0913901F0913A0186E080839A\r\n:1006B000E0913701F0913801808180618083E09181\r\n:1006C0003701F0913801808188608083E0913701A3\r\n:1006D000F0913801808180688083E0913701F0914A\r\n:1006E000380180818F7D8083C0E0D0E081E00E946E\r\n:1006F000870042E050E065E171E085E291E00E9410\r\n:10070000CF000E9437020E94010280E00E94870011\r\n:1007100043E050E068E171E085E291E00E94CF00A3\r\n:100720000E9437020E940102209701F30E943901C2\r\n:100730008823E1F20E940000D9CFE5E2F1E01382C4\r\n:10074000128288EE93E0A0E0B0E084839583A683D4\r\n:10075000B78384E091E09183808385EC90E0958776\r\n:10076000848784EC90E09787868780EC90E0918B7B\r\n:10077000808B81EC90E0938B828B82EC90E0958B68\r\n:10078000848B86EC90E0978B868B118E128E138E65\r\n:10079000148E0895EE0FFF1F0590F491E02D09943B\r\n:0407A000F894FFCFFB\r\n:1007A400000000006F01CF00FC00BC012D010B0113\r\n:0C07B4001F010D0A004F4E004F4646008A\r\n:00000001FF\r\n";

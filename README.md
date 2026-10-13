# Arduino Simulator

Browser-based breadboard editor with **AVR firmware simulation** (Arduino Uno / Nano, ATmega328P via [avr8js](https://github.com/wokwi/avr8js)) and **ngspice** circuit analysis. Wire parts on the canvas, write or import a sketch, and **Run** — MCU pins and board power rails drive the same netlist the simulator solves. You can also run **circuit-only** setups (bench supply / oscillator, no Arduino).

## Features

- Visual canvas: place parts, route wires, pan/zoom, undo/redo, save/load
- Sketch IDE with Serial Monitor; templates (blink, I2C LCD, DS3231 RTC, …)
- Firmware from in-app compile, **Import .hex** (Arduino IDE), or bundled blink
- Digital MCU co-sim + passive/instrument DC (and capacitor `.tran` when ngspice is available)
- Modules on ideal I2C (e.g. PCF8574 LCD backpack, DS3231 RTC)
- Component palette: boards, breadboard, passives, semiconductors, I/O, modules, ICs, instruments

## Quick start

**Windows one-click:** double-click `Localhost_starter.bat` in the project root.

```bash
npm install                 # includes the ngspice engine (eecircuit-engine)
npm run fetch-spice-models  # ~13 MB, once
npm run dev
```

Open the URL printed in the terminal (usually [http://localhost:5173](http://localhost:5173)). A modern Chromium-based browser works best.

### Optional: local sketch compile (`arduino-cli`)

With `npm run dev`, **Run** prefers a local compile when `arduino-cli` and the AVR core are installed (offline after one-time setup):

1. Install [arduino-cli](https://arduino.github.io/arduino-cli/) on your `PATH`
2. Once: `arduino-cli core install arduino:avr`
3. Restart `npm run dev` if needed

FQBN is `arduino:avr:uno`. If the CLI is missing, the app falls back to [Wokwi Hexi](https://hexi.wokwi.com/) (network). Production builds have no `/api/compile` — use Hexi, **Import .hex**, or bundled blink.

### If `npm install` fails with certificate errors

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
npm install
```

## How to use the simulator

### UI layout

| Area | What it’s for |
|------|----------------|
| **Left** | Component palette (search + categories) |
| **Center** | Breadboard canvas |
| **Right** | Sketch IDE + Serial Monitor |
| **Top toolbar** | Run / Stop, undo/redo, Save, load project |

### Tutorial A — Blink (MCU + LED)

1. From **Boards**, place an **Arduino Uno**.
2. From **Output**, place an **LED**; from **Passives**, place a **Resistor** (optional but recommended).
3. Wire: Uno **pin 13** → resistor → LED anode; LED cathode → Uno **GND**.
4. In the Sketch IDE, keep the default blink sketch (or **Template ▾ → Blink**).
5. Click **Run** (or **Ctrl+Enter**). The LED should blink; Serial may print ON/OFF.

Editing the circuit while running **stops** the simulation — click **Run** again after changes.

### Tutorial B — Passive circuit (no Arduino)

1. Place a **Power Supply**, **Resistor**, and **LED**.
2. Wire: supply **+** → resistor → LED → supply **−**.
3. Click **Run**. The LED lights from the bench supply (ngspice / legacy DC).

### Tutorial C — Firmware from Arduino IDE

1. In Arduino IDE, set the board to **Uno** (or compatible ATmega328P).
2. **Sketch → Export compiled Binary** (or take the `.hex` from the build folder).
3. In this simulator’s Sketch IDE, click **Import .hex** and choose that file.
4. Place Uno + wiring as needed, then **Run**.

The imported HEX is kept **in memory** (filename only for the label). After you recompile in Arduino IDE, **Import .hex** again to pick up the new binary.

### Tutorial D — I2C module (DS3231)

1. Place **Arduino Uno** and **DS3231 RTC** (Modules).
2. Wire Uno **SDA/SCL** (or **A4/A5**) and **5V/GND** to the module (either header).
3. Use **Template ▾ → DS3231 RTC (I2C)**, or your own sketch/library at address **`0x68`**.
4. To change the RTC address the sim ACKs on: double-click the module (or right-click → **Change properties**) and match that address in your sketch. EEPROM on the module stays at **`0x57`**.
5. **Run** and watch Serial for the time string.

### Wiring gotchas

- You must **draw every connection** — breadboard rows are **not** auto-shorted yet.
- Circuits need a **ground return** (− / GND); open loops float and show no current.
- Crossing wires do not join; use a shared pin or an intentional **tee** (click an existing wire while routing).

## Controls reference

| Action | How |
|--------|-----|
| **Place** | Palette → click part → click canvas (**R** / **Shift+R** rotate before place) |
| **Wire** | Click pin → optional corners → other pin; **Esc** / right-click cancels; click a wire to **tee** |
| **Select / move** | Click part or wire; drag bodies or wire handles |
| **Properties** | Double-click part, or right-click → **Change properties** (R, C, LED, LCD, instruments, DS3231 address, chip marking, …) |
| **Copy / paste** | **Ctrl+C** / **Ctrl+V** |
| **Delete / undo** | Focus canvas, then **Del**; **Ctrl+Z** / **Ctrl+Y** |
| **Pan / zoom** | Right-drag, middle-drag, or **Space+drag**; mouse wheel zooms |
| **Run / Stop** | Toolbar or Sketch IDE; **Ctrl+Enter** runs |

**Palette categories:** Boards · Prototyping · Passives · Semiconductors · Output · Input · Modules · ICs · Instruments.

## Firmware sources

On **Run**, firmware comes from (in practice):

1. **Loaded HEX** — if you used **Import .hex**
2. **In-app sketch** — local `arduino-cli` when available, else Hexi
3. **Bundled blink** — offline fallback for the default blink sketch

## Save and load

Projects are JSON (`components`, `wires`, `viewport`, optional `sketch` / `sketchName`). Transient UI (sim state, imported HEX body) is not saved with the circuit.

- **Dev (`npm run dev`):** Save writes under `user_projects/`; the toolbar dropdown reloads those files.
- **Production build:** Save downloads a file; **Load file…** opens one from disk.

## Known limits

- Digital MCU co-sim only — no ADC / `analogRead` or PWM electrical model yet (GPIO sources are ideal)
- Breadboard rows are not conductive until you wire them
- Ideal I2C (TWI) — no pull-up SPICE on SDA/SCL; modules must share the MCU I2C nets to appear on the bus
- Capacitors need ngspice `.tran` (legacy MNA has no C stamp)
- First ngspice solve after load waits for the WASM engine (~20 MB) to start
- Background tabs may throttle the AVR worker; on return the sim may briefly catch up faster than 16 MHz
- Most 74HC gates simulate with TI behavioral models; **74HC20 / 74HC21** do not simulate yet (falls back to legacy MNA for those circuits)

## Status

**Working today:** canvas editor; Sketch IDE; Hexi / local arduino-cli / Import .hex / bundled blink; GPIO + rail co-sim; circuit-only mode; ngspice with legacy fallback; core passives/semiconductors/instruments; I2C modules (PCF8574 backpack, DS3231); sketch templates.

**Roadmap:** ADC / `analogRead`; PWM / `analogWrite` electrical model; breadboard row conductivity; optional save of imported HEX with the project; more palette polish.

## Project layout

See **[docs/PROJECT_MAP.md](docs/PROJECT_MAP.md)** for a fuller map. In short:

- `src/ui/` — canvas, editors, palette, Sketch IDE
- `src/components/` — simulating parts (`PartModule` files)
- `src/registry/` — boards, breadboard, artwork-only packages, palette order
- `src/avr/` — ATmega328P worker, firmware/HEX, GPIO/I2C
- `src/circuit/` — nets and solvers (`spice/` = ngspice pipeline)
- `public/components/` — SVG artwork; `public/spice/` — SPICE models

### Adding parts (contributors)

- **Simulating part:** `public/components/<type>.svg` → `src/components/<category>/<type>.ts(x)` → register in `src/components/index.ts` (include `palette` metadata and optional `properties.fields` in that module)
- **Artwork-only:** SVG + `STATIC_REGISTRY` entry with `palette` metadata
- Simple forms: declare `properties.fields` with labels, kinds, options, and existing parsers. Defaults still come from `properties.defaults`; project loading still uses `properties.load`.
- Custom forms: register `properties.Editor` for specialized controls. No canvas branches or editor registration list are needed.
- Omit `palette` for internal-only parts; category labels/order remain central, membership/order live with parts.
- Verification: `npm run build` checks types and production bundling.
- Details: `public/components/README.txt`, `docs/PROJECT_MAP.md`

## Behavior changes — 13 October 2026

- All 63 palette entries retain their categories and order. Membership now comes from each part; entries without palette metadata stay hidden.
- Palette search also matches part keywords: DS3231 is discoverable using "clock", "time", or "i2c".
- Resistor, both capacitors, LED and RTC use a shared property form. Units appear on separate labeled rows; LED color retains its swatch and presets.
- Shared forms focus their first input. Apply/Enter validates and saves; Cancel, Escape or clicking outside discards the draft. Invalid numbers or selections keep the form open with an error.
- Existing numeric/address parsers, defaults and saved field names remain unchanged; no project-file migration or stricter numeric-string parsing is introduced.
- LCD previews and instrument steppers/unit conversion retain their custom editors. Custom editors take precedence over schemas; chip-name editing is a fallback rather than a second simultaneous dialog.
- Electrical hooks remain unchanged. Edits still use updateComponent for undo and stopping running simulations.
- Removed ResistorValueEditor, CapacitorValueEditor, LedPropertiesEditor and Ds3231PropertiesEditor; their forms now live in part schemas and PartPropertiesEditor.
- The temporary migration regression files and `test:parts` command were removed after verification, at the project owner’s request. Runtime behavior is unchanged.

## Documentation

This README is the user-facing overview (run, use, limits). Implementation notes and per-file history live in source file headers and [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md).

## Changelog

```
# Date       | Author | Remarks
# 13-10-2026 | Cursor | GitHub-friendly README rewrite (how-to tutorials, slim controls)
#                     | Changelog convention: Date | Author | Remarks (oldest first)
# 13-10-2026 | Codex | Part-owned palette/forms migration, behavior notes, removed editor files and test:parts command.
# 13-10-2026 | Codex | Remove temporary test files and test:parts npm script; update verification instructions. No runtime behavior changes.
```

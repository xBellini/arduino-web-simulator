# Arduino Simulator (Phase 1)

Visual breadboard editor with **AVR firmware simulation** (ATmega328P via avr8js) and **ngspice** DC analysis for passive and instrument circuits — with or without an Arduino on the canvas. MCU sketches and the wired circuit are **digitally co-simulated**: `digitalWrite` pins and board `5V`/`GND` rails are SPICE sources; `digitalRead` follows solved net levels. Board **GND pins** (and same-voltage power taps) are shorted like PCB copper.

**No invented results:** voltages, currents, and capacitor charge come from **AVR** and/or **SPICE** (legacy MNA only if ngspice is unavailable). See `.cursor/rules/no-invent-simulation.mdc`.

## Stack

- **TypeScript** + **React** + **Vite**
- SVG canvas with pan/zoom
- **avr8js** — ATmega328P in a dedicated Web Worker (cycle-quanta pacing; optional AssemblyScript WASM helper via `npm run build:avr-wasm`)
- **ngspice** — [eecircuit-engine](https://github.com/eelab-dev/EEcircuit-engine) (ngspice-45.2 WebAssembly, MIT, installed from npm) in a Web Worker; legacy MNA fallback. Supports the standard SPICE devices (R/C/L/V/I, D, BJT, MOSFET, JFET, switches, E/F/G/H, B). PSpice-style `TABLE`, `VSWITCH` and `POLY` in model files are rewritten automatically. Not supported: XSPICE code models and `LAPLACE`/`FREQ` sources (such decks are refused and fall back to legacy). The first solve after page load waits for the ~20 MB engine to start
- **Wokwi Hexi** — sketch compile fallback; optional local **arduino-cli** via Vite `/api/compile`
- Components: simulating modules in `src/components/<category>/`; boards / breadboard / artwork-only in `src/registry/components.ts`

## Run locally

**One-click:** double-click `Localhost_starter.bat` in the project root.

```bash
cd arduino-simulator
npm install                 # includes the ngspice engine (eecircuit-engine)
npm run fetch-spice-models  # ~13 MB, once
npm run dev
```

Open the URL shown in the terminal (usually http://localhost:5173).

### Local sketch compile (`arduino-cli`)

With `npm run dev`, **Run** prefers local compile when `arduino-cli` and `arduino:avr` are installed (offline after core install).

1. Install [arduino-cli](https://arduino.github.io/arduino-cli/) on `PATH`
2. Once: `arduino-cli core install arduino:avr`
3. Restart `npm run dev` if needed

FQBN is `arduino:avr:uno`. Production builds have no `/api/compile` — use Hexi, **Import .hex**, or bundled blink. Missing CLI falls back to Hexi (network).

### If `npm install` fails with certificate errors

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
npm install
```

## Adding parts / artwork

- **Simulating part:** `public/components/<type>.svg` → `src/components/<category>/<type>.ts(x)` (`PartModule`) → register in `src/components/index.ts` → list in `PALETTE_CATEGORIES`. See `src/components/partModule.ts`.
- **Artwork-only:** SVG + `STATIC_REGISTRY` entry + palette listing (no `src/components` module).
- **Package IC:** blank `dip*` / `to92` / `to220` shells in the registry; named chips set `package` and omit `scale` to inherit the shell. Details: `public/components/README.txt`, `docs/PROJECT_MAP.md`.

## Usage

| Action | How |
|--------|-----|
| **Place** | Components menu → click part → click canvas (snaps to holes). **R** / **Shift+R** rotate hologram |
| **Wire** | Click pin/hole → corners (each click sticks at that point) → pin B; Esc/right-click cancels. Near pins, snap + crosshair lock to pin center. Free runs stay on the pin/bend axis; sideways/up moves snap in breadboard-pitch steps from that axis (not the absolute board grid). Routes leave board headers along the exit stub first, then turn. Click an existing wire while routing to tee (junction node + shared net). Crossing/overlapping runs do not join — only shared pins or intentional tees are nodes |
| **Select / move** | Click body to drag; select wires to drag segments/handles (ortho stays ortho on release; drag snaps in steps from the segment, not the board grid); double-click segment to insert joint |
| **Part menu** | Right-click part → Copy, Paste, Change properties, Rotate, Delete |
| **Copy / paste** | Ctrl+C / Ctrl+V; canvas menu paste at cursor |
| **Properties** | Double-click resistor, LED, LCD (display presets), instruments, DIP/TO marking, capacitor |
| **Delete / undo** | Click the canvas (or a part/wire) first, then Del; Ctrl+Z / Ctrl+Y |
| **Save / Load** | Toolbar Save / dropdown / Load file… |
| **Run / Stop** | Toolbar or Sketch IDE; **Ctrl+Enter** runs. MCU needs Uno/Nano + sketch/HEX; passive needs PSU/oscillator + ground return. Editing the circuit auto-stops sim |
| **Buttons / pot** | Hold button while running; scroll pot to set wiper |
| **Pan / zoom** | Right-drag / middle / Space+drag pan; wheel zoom |

**Palette categories:** Boards · Prototyping · Passives · Semiconductors · Output · Input · Modules · ICs · Instruments.

**ICs:** NE555 plus 74HC combinational gates (00/02/03/04/08/10/11/20/21/27/32/86). **00/02/03/04/08/10/11/27/32/86 simulate** with TI's SN74HCxx behavioral models (`public/spice/bundled/Texas Instruments/`); wire VCC (pin 14) and GND (pin 7) or the chip does nothing. The 74HC03 is open drain, so its outputs need a pull-up. TI publishes no SN74HC20 / SN74HC21 model, so those two still stamp into `Digital Logic/74HC.LIB` (XSPICE digital devices, which the engine can't run) and **do not simulate yet** — a circuit containing one falls back to legacy MNA.

**Passive example:** Power supply → resistor → LED → supply −; **Run**.

**Arduino IDE HEX:** Export compiled binary → Sketch IDE **Import .hex** → **Run**.

## Circuit simulation

| Mode | Requires | What runs |
|------|----------|-----------|
| **MCU sketch** | Uno or Nano + sketch/HEX | AVR Worker + GPIO bridge; driven pins + rails as DC sources |
| **Circuit-only** | Power supply or oscillator | ngspice `.OP` / `.tran` + overlay |

```
Wires → buildCircuitNetlist()
     → MCU sources (rails + GPIO) / bench sources
     → ngspice (.OP or RC-sized .tran)  [legacy MNA fallback]
     → overlay visuals + simLiveStore
```

On **Run** with capacitors, the controller prefetches SPICE charge/discharge waveforms before starting the AVR Worker so GPIO edges can replay cached `.tran` samples immediately (compiler panel notes prefetch status).

| Piece | Role |
|-------|------|
| **Math engine** | ngspice (preferred) or legacy MNA — voltages/currents |
| **Failure rules** | Blow detection; blown parts exported as ~1 GΩ open |
| **Visuals** | Glow, heat, wire flow, meters — mirror solved values |

Solver badge under the Sketch IDE timer: green **ngspice** / yellow **legacy**. Caps use SPICE `C` and RC-sized `.tran` (UI lerps real samples). Stamped parts include R, V, D/LED/RGB, Q, M, C, buttons, ammeter sense, MCU rails/GPIO. While a sketch is running, a **Sim perf** overlay shows sim/wall time, effective MHz (~16 target), and solve cost.

### Wiring

- Wire every connection (breadboard rows are **not** auto-shorted yet)
- Passive circuits need a ground return (− / GND)
- Open loops → floating nets → no current

### Known limits

- Digital MCU co-sim only (no ADC / PWM electrical model yet; sources are ideal)
- Wire / TWI master is live (ideal I2C). PCF8574 LCD backpack is the board only (no glass); wire its LCD header to a parallel LCD, or link is detected when RS/E nets match. **DS3231 RTC module** (with AT24C32 EEPROM) sits on the same bus: RTC I2C address defaults to `0x68` (editable in part properties — sketch/library must match); EEPROM fixed at `0x57`; wire SDA/SCL/VCC/GND to the Uno (either header)
- No breadboard row auto-nets
- Caps need ngspice `.tran` (legacy MNA has no C stamp)
- Compile: local arduino-cli in dev, else Hexi / Import .hex / bundled blink
- Background / unfocused tabs: the browser may throttle the AVR Worker; on return the sim catch-up can briefly run faster than 16 MHz to clear wall-clock debt

## Project file

JSON: `version`, `components`, `wires`, `viewport`, optional `sketch` / `sketchName`. Transient UI is not saved.

**Dev:** Save writes `user_projects/`; dropdown reloads. Production: browser download / file picker.

## Project layout

See **[docs/PROJECT_MAP.md](docs/PROJECT_MAP.md)**. In short:

- `src/ui/` — canvas, property editors, palette, sketch IDE, debug overlays
- `src/components/` — one file per simulating component, in palette-style folders (`IC/Logic Gates/`, `passives/`, `output/`, …)
- `src/registry/` — boards, breadboard, artwork-only packages, palette order
- `src/avr/` — ATmega328P worker, firmware compile/HEX, GPIO/I2C bridges
- `src/circuit/` — nets, solvers, currents; `src/circuit/spice/` is the ngspice pipeline
- `src/store/`, `src/project/`, `src/values/` — app state, save/load, component value helpers
- `public/components/` — component SVG artwork; `public/spice/` — SPICE models (`models/` is downloaded, `bundled/` is ours)
- `scripts/` — authoring/dev tooling (`scripts/vite/` holds the dev-server plugins)

Snapshots: `.\backup-local.ps1` (see `.cursor/rules/local-snapshots.mdc`).

## Phase 1 status

### Done

- avr8js @ 16 MHz in a Web Worker (cycle-quanta pacing; optional WASM pacer); Sketch IDE; Hexi + local arduino-cli + Import .hex + bundled blink
- Digital co-sim (GPIO + board rails as sources; GND/rail shorts on MCU)
- Circuit-only mode; ngspice worker + legacy fallback; solver badge
- Cap SPICE companion (RC-sized `.tran`, waveform cache, Run-time prefetch, smooth fill)
- Always-on Sim perf overlay during Run
- Core passives/semiconductors/instruments with blow/heat/wire-flow visuals
- Multi-board warning
- Sketch templates (incl. I2C 20×4 LCD)

### Still to tackle

1. Analog ADC / `analogRead`
2. PWM visualization / `analogWrite` electrical model
3. Per-pin output impedance
4. Breadboard row conductivity
5. Optional save of imported HEX with the circuit

## Phase 0 status

### Done

- Canvas editor: pan/zoom, select, wire, undo/redo, rotate, copy/paste, save/load
- Breadboard snap grid; package SVGs; context menus; property editors (R, LED, instruments, caps, chip marking)
- Wire routing polish: step-from-anchor draft snap (off-grid pins stay straight); intentional tee join; pin-only junction nodes; draft corners stick at click; resize/commit keeps ortho (no short-jog diagonals); segment drag snaps relative to the run; exit-stub-first routing after board headers

### Still to tackle

1. Placement hologram alignment (buzzer, micro servo)
2. LED / potentiometer property follow-ups
3. Optional extra palette parts

## Documentation

Keep this README aligned with user-facing behavior (`.cursor/rules/readme-updates.mdc`). Per-file history stays in source headers — not here.

# Project map (plain language)

This guide lists the **important files** and what they do. You do not need to know TypeScript to use it.

The app is four layers working together:

1. **UI** (`src/ui/`) — place components, draw wires, pan/zoom, property editors, sketch IDE  
2. **Simulator components** (`src/components/`) — one file per component type, grouped like the palette  
3. **Circuit solve** (`src/circuit/`) — figures out voltages and currents (ngspice, with a simpler backup solver)  
4. **Arduino** (`src/avr/`) — compiles and runs firmware on a virtual ATmega328P  

For how to use the simulator day to day, see the main [README](../README.md).

---

## Project tree

Visual map of the repo (skips `node_modules/`, `dist/`, and local backup folders). Short note on each file; deeper “where do I…” tables follow below.

```
arduino-simulator/
├── README.md                      # Run / use / add components overview
├── package.json                   # npm scripts (dev, build, fetch assets)
├── package-lock.json              # Locked dependency versions
├── index.html                     # Vite HTML shell
├── Localhost_starter.bat          # One-click install + npm run dev + browser
├── Backup.bat / backup-local.ps1  # Dated local snapshot (keeps 10 newest)
├── .gitignore / .npmrc            # Git ignore; npm CA / registry hints
├── tsconfig.json                  # TypeScript project references root
├── tsconfig.app.json              # App/browser TS config (excludes src/avr/pacer)
├── tsconfig.node.json             # Node tooling TS config
├── vite.config.js                 # Vite + React; mounts the dev-server plugins
│
├── docs/
│   ├── PROJECT_MAP.md             # This guide
│   ├── lcd-parallel-bench.md      # Parallel LCD wiring + EN-edge latch notes
│   └── sketches/                  # Example .ino sketches referenced by the docs
│
├── .cursor/rules/                 # Always-on agent rules for this repo
│
├── user_projects/                 # Circuits saved during npm run dev
│   └── *.json
│
├── public/                        # Static assets served as-is
│   ├── favicon.svg
│   ├── components/
│   │   ├── README.txt             # SVG / viewBox artwork notes
│   │   └── *.svg                  # One footprint per component (incl. module SVGs)
│   ├── avr/
│   │   └── avr-pacer.wasm         # WASM pacer (`npm run build:avr-wasm`)
│   └── spice/
│       ├── README.md              # What lives where
│       ├── catalog.json           # Index of SPICE model names (generated + bundled)
│       ├── models/                # Downloaded KiCad .lib files (`npm run fetch-spice-models`)
│       └── bundled/               # Our own models (TI SN74HCxx) + bundled/catalog.json
│
├── scripts/                       # Authoring helpers (not used at runtime)
│   ├── vite/                      # Dev-server plugins loaded by vite.config.js
│   │   ├── vite-plugin-user-projects.js # Dev API: save/load JSON under user_projects/
│   │   └── vite-plugin-compile.js # Dev API: local arduino-cli → Intel HEX
│   ├── fetch-spice-libraries.mjs  # Download SPICE libs + build catalog (merges bundled/)
│   ├── fetch-bundled-blink-hex.mjs# Refresh the blink HEX line in src/avr/firmware.ts
│   ├── fetch-tinkercad-svg.mjs    # Pull reference SVGs for authoring
│   ├── export-components-svg.mjs  # Batch export / normalize component SVGs
│   ├── crop-tinkercad-components.mjs # Crop TinkerCAD SVGs to footprint size
│   ├── svg-to-geometry.mjs        # SVG → pin/geometry helper
│   ├── generate-uno-geometry.mjs  # Uno board pin layout generator
│   ├── generate-nano-geometry.mjs # Nano board pin layout generator
│   ├── build-avr-wasm.mjs         # Compile src/avr/pacer/avr-pacer.ts → WASM
│   ├── stop-dev-server.mjs        # Kill stuck Vite on the dev port
│   └── reference/                 # Cached TinkerCAD SVG/JSON samples
│
└── src/
    ├── main.tsx                   # React DOM entry
    ├── App.tsx                    # App shell (toolbar, palette, canvas, IDE)
    ├── index.css                  # Global styles
    ├── types.ts                   # Shared shapes: pins, components, wires, viewport
    ├── vite-env.d.ts              # Vite/client type shims
    │
    ├── ui/                        # Everything on screen
    │   ├── Toolbar.tsx            # Tools, Run/Stop, save/load
    │   ├── canvas/
    │   │   ├── SimCanvas.tsx      # Place, wire, select, pan/zoom
    │   │   ├── ComponentShape.tsx # One placed component (artwork, pin labels, CSS sim state)
    │   │   ├── ComponentOverlays.tsx # Chip text, glow, meters, cap fill, …
    │   │   ├── WireFlowOverlay.tsx# Animated current dashes on wires
    │   │   ├── ContextMenu.tsx    # Right-click menus
    │   │   └── geometry.ts        # Coordinates, wire paths, pin snap
    │   ├── editors/               # Property popovers
    │   │   ├── ResistorValueEditor.tsx / CapacitorValueEditor.tsx / LedPropertiesEditor.tsx
    │   │   ├── LcdPropertiesEditor.tsx / InstrumentPropertiesEditor.tsx
    │   │   ├── PartLabelEditor.tsx# DIP/TO marking text
    │   │   ├── editable.ts        # Which components open a properties panel
    │   │   └── popup.ts           # Keep popovers inside the viewport (hook + math)
    │   ├── palette/
    │   │   └── Palette.tsx        # Left library + thumbnail icons and crops
    │   ├── ide/
    │   │   ├── IdePanel.tsx       # Sketch tab chrome + Serial + solver badge
    │   │   ├── SketchEditor.tsx   # Code editor + Import .hex / templates
    │   │   └── templates.ts       # Sketch template snippets
    │   └── debug/
    │       ├── SimPerfOverlay.tsx # Always-on Run overlay: MHz / drift / solve
    │       └── NgspiceDebugOverlay.tsx # On-canvas DC debug readouts
    │
    ├── components/                # Simulator components (PartModule per file)
    │   ├── partModule.ts          # PartModule contract (definition + optional electrical)
    │   ├── index.ts               # Master list of simulating types
    │   ├── overlayKit.tsx         # Shared meter-style readouts
    │   ├── IC/Logic Gates/        # 74HC00…74HC86 gates (TI models; 20/21 not yet)
    │   ├── passives/              # resistor, capacitor, potentiometer
    │   ├── semiconductors/        # diode, NPN/PNP, N/P-MOSFET
    │   ├── output/                # led, rgbLed, lcd16x2, lcd20x4, lcdParallel, buzzer
    │   ├── input/                 # button, keypad4x4, buttonMatrix4x4
    │   ├── modules/               # rfidRc522, max7219Matrix8x8, microsdModule, pcf8574LcdBackpack, ds3231Rtc, ne555
    │   └── instruments/           # powerSupply, voltmeter, ammeter, ohmmeter, oscillator
    │
    ├── registry/                  # Placement catalog (boards + artwork-only)
    │   ├── components.ts          # Boards, breadboard, shells, palette order
    │   ├── packagePins.ts         # Shared DIP / TO-92 / TO-220 pin geometry
    │   ├── partFootprints.ts      # Reads SVG viewBox → design size
    │   ├── breadboardGrid.ts      # Hole spacing / snap grid
    │   └── componentHitbox.ts     # Click/selection box
    │
    ├── avr/                       # Arduino side
    │   ├── runner.ts              # ATmega328P core (avr8js) + time-slice scheduler
    │   ├── worker.ts              # Worker: cycle-quanta AVR + LCD EN + TWI bus
    │   ├── workerHost.ts          # Main-thread host; mirrors ports; USART/LCD bridge
    │   ├── workerProtocol.ts      # Typed Worker ↔ host messages
    │   ├── workerTargets.ts       # LCD pin maps + PCF8574 I2C slaves for the Worker
    │   ├── firmware.ts            # Compile (arduino-cli → Hexi), Intel HEX load, bundled blink HEX
    │   ├── pinMap.ts              # Uno/Nano pin ids → AVR ports
    │   ├── gpioBridge.ts          # MCU pins ↔ circuit nets
    │   ├── twiBus.ts              # Ideal TWI slave bus for AVRTWI
    │   ├── simPerf.ts             # Throughput / drift counters for SimPerfOverlay
    │   ├── hd44780.ts             # HD44780 IC facade (vendored; not placeable)
    │   ├── ds3231.ts              # DS3231 I2C RTC (datasheet slave; not placeable)
    │   ├── at24c32.ts             # AT24C32 I2C EEPROM (datasheet slave; not placeable)
    │   ├── vendor/vrEmuLcd/       # MIT vrEmuLcd sources + TS char engine
    │   └── pacer/                 # AssemblyScript source of avr-pacer.wasm
    │
    ├── circuit/                   # Electrical side
    │   ├── netlist.ts             # Wires → nets; MCU GND/rail shorts
    │   ├── solver.ts              # Per-frame digital overlay + component hooks
    │   ├── dcSolver.ts            # DC front door (ngspice cache → legacy)
    │   ├── mnaLegacy.ts           # Built-in linear MNA backup
    │   ├── currents.ts            # Branch currents + per-wire flow currents
    │   ├── supplyLimit.ts         # Bench PSU CC / voltage sag
    │   ├── visuals.ts             # Glow, heat, blow after solve
    │   └── spice/
    │       ├── netlistExport.ts   # Canvas → SPICE .OP / .tran deck
    │       ├── client.ts          # Worker client; .tran + waveform cache
    │       ├── worker.ts          # Engine worker (eecircuit-engine, ngspice-45.2 WASM)
    │       ├── models.ts          # Load catalog.json + .lib text; pick a model per component
    │       ├── pspiceCompat.ts    # PSpice TABLE / VSWITCH / POLY → ngspice rewrites
    │       └── wavePrefetch.ts    # Prefetch charge/discharge .tran at Run
    │
    ├── store/                     # App state + Run/Stop
    │   ├── SimContext.tsx         # Components, wires, viewport, undo, save
    │   ├── simulationController.ts# Run/Stop; AVR Worker; SPICE prefetch + wave play
    │   ├── simLiveStore.ts        # Fast pin colors / wire-flow / Sim perf snapshot
    │   └── history.ts             # Undo/redo snapshots
    │
    ├── project/                   # Files in and out
    │   ├── projectFile.ts         # Save/load project JSON + /api/user-projects client
    │   ├── clipboard.ts           # Copy/paste selection
    │   └── sketchFile.ts          # .ino download helper
    │
    └── values/                    # Component value helpers (units, defaults, parsing)
        ├── resistor.ts            # Ohms, tolerances, colour bands
        ├── capacitor.ts           # Farads, cap defaults
        ├── electric.ts            # V / mA units, supply fields, instrument defaults + formatters
        ├── led.ts                 # LED colours, RGB channels, Vf/If
        └── lcd.ts                 # LCD glass colour presets
```

---

## Where do I…?

| Task | Go here |
|------|---------|
| Add or change a **simulating** component (LED, resistor, PSU, …) | `src/components/<category>/<name>.ts` (or `.tsx`) |
| See **what a component file must provide** (pins, optional electrical behaviour) | `src/components/partModule.ts` |
| **Turn a new component on** for the solvers | `src/components/index.ts` (one line in the list) |
| Change the **picture** / footprint size | `public/components/<name>.svg` (`viewBox` = size) |
| Boards, breadboard, **artwork-only** parts, **palette order** | `src/registry/components.ts` |
| Shared ideas: pin, placed component, wire | `src/types.ts` |
| **Run / Stop** simulation | `src/store/simulationController.ts` (AVR Worker + SPICE prefetch) |
| AVR Worker / WASM pacing | `src/avr/worker.ts`, `src/avr/workerHost.ts`, `src/avr/pacer/avr-pacer.ts` |
| Sketch compile / HEX / default blink | `src/avr/firmware.ts` |
| SPICE deck, engine, models | `src/circuit/spice/` |
| Add a vendor SPICE model (like the TI gates) | `public/spice/bundled/` + `public/spice/bundled/catalog.json` |
| Sim perf overlay | `src/avr/simPerf.ts`, `src/ui/debug/SimPerfOverlay.tsx` |
| Editor state (components on canvas, undo, save) | `src/store/SimContext.tsx` |
| Click / drag / wire on the canvas | `src/ui/canvas/SimCanvas.tsx` |
| Sidebar component list | `src/ui/palette/Palette.tsx` |
| Sketch editor / Serial / Run badge | `src/ui/ide/IdePanel.tsx`, `SketchEditor.tsx` |
| Saved projects (dev) | `user_projects/` |
| Local backup snapshot | `Backup.bat` / `backup-local.ps1` |

---

## How a new simulating component is wired

Short version (no code behaviour is described here — only where to edit):

1. Draw or copy an SVG into `public/components/<type>.svg` with a valid `viewBox`.  
2. Create `src/components/<category>/<type>.ts` (copy a neighbour like `passives/resistor.tsx` or `modules/ne555.ts`). Put name, pins, and artwork (or `package`) in `definition`. With `package`, omit `scale` to inherit the footprint’s size; set `scale` only to override. Add electrical behaviour only if you need it.  
3. Register the component in `src/components/index.ts`.  
4. Add the type string to a palette category in `src/registry/components.ts`. Do **not** put simulating components in `STATIC_REGISTRY`.

Full checklist and package-IC notes: [README → Adding a component](../README.md#adding-a-component).

**Artwork-only** parts (placeable picture, no sim yet): skip `src/components/`; add SVG + entry in `STATIC_REGISTRY` + palette line.

---

## Folder roles

| Folder | What lives there |
|--------|------------------|
| `src/ui/` | React UI only: canvas, editors, palette, IDE, debug overlays. No solver math. |
| `src/components/` | One PartModule per component type: definition, SPICE stamp, legacy stamp, visuals. |
| `src/registry/` | Placement metadata: boards, artwork-only parts, footprints, hitboxes, palette order. |
| `src/avr/` | Everything that runs or feeds the ATmega328P: worker, firmware, GPIO/TWI bridges, HD44780 IC. |
| `src/circuit/` | Nets, solvers, currents, visuals after a solve; `spice/` holds the ngspice pipeline. |
| `src/store/` | React state, undo, Run/Stop orchestration. |
| `src/project/` | Project JSON, clipboard, sketch files, dev save API. |
| `src/values/` | Units, defaults and parsers for component values. |
| `public/spice/models/` | Downloaded library — replaced on every fetch; do not hand-edit. |
| `public/spice/bundled/` | Hand-maintained vendor models; merged into `catalog.json` by the fetch script. |
| `scripts/` | Authoring and dev tooling — not loaded by the running app (except `scripts/vite/` by the dev server). |

---

## Intentionally not covered here

- `node_modules/` — installed libraries  
- `dist/` — production build output  
- `../arduino-simulator-backup-*` — local snapshots from `backup-local.ps1`  
- Inside `public/spice/catalog.json` — huge generated index; use `src/circuit/spice/models.ts` / the spice README instead  
- Most of `scripts/reference/` — authoring / test artifacts, not the running app  

---

## Related docs

- [README](../README.md) — run, use, add components, architecture status  
- [lcd-parallel-bench.md](./lcd-parallel-bench.md) — parallel LCD wiring + EN-edge latch  
- [public/components/README.txt](../public/components/README.txt) — SVG artwork notes  
- [public/spice/README.md](../public/spice/README.md) — SPICE model folders  

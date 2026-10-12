/**
 * Provenance: HD44780 controller behavioral model derived from vrEmuLcd (MIT).
 *
 * Upstream: https://github.com/visrealm/vrEmuLcd
 * Copyright (c) 2020 Troy Schrapel
 *
 * This directory keeps the original C sources (`vrEmuLcd.c` / `.h`), LICENSE, and the
 * A02 font extracted from `vrEmuLcd.c` (`fontA02.ts`). Upstream's JS/WASM build is not kept. The runnable browser model is the TypeScript port in
 * `vrEmuLcdChar.ts` (character-mode IC only — no product UI / graphics LCD).
 *
 * Do not register this IC in the palette; LCD PartModules import the facade at
 * `src/sim/hd44780.ts`.
 */

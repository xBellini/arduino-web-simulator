/**
 * What: Static ATmega328P pin map — registry ids (d0–d13, a0–a5) → avr8js port + bit.
 *
 * Owns/exports: `AvrPortName`, `McuPinMapping`, `ARDUINO_DIGITAL_PIN_MAP`, `isMcuBoard`.
 *
 * Conventions: Keys match component registry MCU pin ids, not silkscreen “D13” alone (use
 * `d13`). Only Uno/Nano types return true from `isMcuBoard`. No runtime mutation of the map.
 *
 * To support a new board with the same MCU, add its `type` to `isMcuBoard` if pinout matches;
 * otherwise fork a separate map module rather than overloading entries here.
 * To wire a new header pin, add one entry to `ARDUINO_DIGITAL_PIN_MAP` and mirror it in the
 * component definition pins in the registry.
 * To resolve port/bit in bridge code, index `ARDUINO_DIGITAL_PIN_MAP[pinId]` then use
 * `ports[mapping.port]`.
 *
 * Not here: Reading/writing `AVRIOPort` or netlist endpoints — see gpioBridge and circuit/netlist.ts.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/sim/pinMap.ts` (tree reorganization)
 * - 05-10-2026 — Uno header sda/scl alias a4/a5 (TWI)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

export type AvrPortName = 'B' | 'C' | 'D';

export interface McuPinMapping {
  port: AvrPortName;
  bit: number;
}

/** Registry pin id (d0…d13, a0…a5) → port bit on ATmega328P. */
export const ARDUINO_DIGITAL_PIN_MAP: Record<string, McuPinMapping> = {
  d0: { port: 'D', bit: 0 },
  d1: { port: 'D', bit: 1 },
  d2: { port: 'D', bit: 2 },
  d3: { port: 'D', bit: 3 },
  d4: { port: 'D', bit: 4 },
  d5: { port: 'D', bit: 5 },
  d6: { port: 'D', bit: 6 },
  d7: { port: 'D', bit: 7 },
  d8: { port: 'B', bit: 0 },
  d9: { port: 'B', bit: 1 },
  d10: { port: 'B', bit: 2 },
  d11: { port: 'B', bit: 3 },
  d12: { port: 'B', bit: 4 },
  d13: { port: 'B', bit: 5 },
  a0: { port: 'C', bit: 0 },
  a1: { port: 'C', bit: 1 },
  a2: { port: 'C', bit: 2 },
  a3: { port: 'C', bit: 3 },
  a4: { port: 'C', bit: 4 },
  a5: { port: 'C', bit: 5 },
  /** Uno I2C header — same Port C bits as A4/A5. */
  sda: { port: 'C', bit: 4 },
  scl: { port: 'C', bit: 5 },
};

export function isMcuBoard(type: string): boolean {
  return type === 'arduino_uno' || type === 'arduino_nano';
}

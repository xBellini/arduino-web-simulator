/**
 * What: Single-display TypeScript adaptation of SimulIDE's MAX72xx controller.
 * Adapts upstream registers with local MAX7219 datasheet corrections.
 * No Qt UI, voltage threshold, chaining or electrical current model is imported.
 * LOAD rising latches the last 16 bits; every CLK rising shifts, even LOAD high.
 * Snapshot intensity is 1..16 (register value + 1), not electrical current.
 * See PROVENANCE.txt and COPYING for attribution and remaining limits.
 * Copyright (C) 2018 Santiago González; adaptation AGPL-3.0-only.
 *
# Changelog
# Date       | Author | Remarks
# 15-10-2026 | Codex  | Adapt the vendored single-slot controller for worker execution.
#                     | Correct LOAD latching, Code B, power-up intensity and test overrides per datasheet.
#                     | Move to src/libraries/simulide with source/license records; no AVR dependency or behavior change.
 */
export type Max72xxSnapshot = { rows: number[]; intensity: number };

export class Max72xx {
  readonly ram = new Uint8Array(8);
  intensity = 1;
  decodeMode = 0;
  scanLimit = 0;
  shutdown = true;
  test = false;
  private rxReg = 0;
  private load = false;
  private clock = false;

  pins(cs: boolean, clk: boolean, din: boolean): void {
    const rising = clk && !this.clock;
    if (rising) this.rxReg = ((this.rxReg << 1) | Number(din)) & 0xffff;
    if (cs && !this.load) this.processCommand();
    this.clock = clk;
    this.load = cs;
  }

  private processCommand(): void {
    const addr = (this.rxReg >> 8) & 15;
    const data = this.rxReg & 255;
    if (addr >= 1 && addr <= 8) this.ram[addr - 1] = data;
    else switch (addr) {
      case 9: this.decodeMode = data; break;
      case 10: this.intensity = 1 + (data & 15); break;
      case 11: this.scanLimit = data & 7; break;
      case 12: this.shutdown = !(data & 1); break;
      case 15: this.test = !!(data & 1); break;
    }
  }

  snapshot(): Max72xxSnapshot {
    // Datasheet Table 5: DP A B C D E F G; D4..D6 ignored in Code B mode.
    const codeB = [0x7e, 0x30, 0x6d, 0x79, 0x33, 0x5b, 0x5f, 0x70,
      0x7f, 0x7b, 0x01, 0x4f, 0x37, 0x0e, 0x67, 0x00];
    return {
      rows: Array.from(this.ram, (value, row) => this.test ? 255
        : this.shutdown || row > this.scanLimit ? 0
          : this.decodeMode & (1 << row) ? codeB[value & 15] | (value & 128) : value),
      intensity: this.test ? 16 : this.intensity,
    };
  }
}

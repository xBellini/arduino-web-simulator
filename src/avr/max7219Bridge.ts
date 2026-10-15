/**
 * What: Wire the adapted SimulIDE controller to AVR GPIO, including hardware SPI
 * pin overrides. Models live entirely in the worker; callers batch snapshots.
 * Power validity comes from the host's DC solve. Unpowered modules reset and
 * ignore clocks. Floating signal pins do not count as driven logic.
 *
# Changelog
# Date       | Author | Remarks
# 15-10-2026 | Codex  | Bridge connected GPIO to the vendored MAX72xx single-module model.
#                     | Import the AVR-independent controller from src/libraries/simulide; behavior unchanged.
#                     | Rename to max7219Bridge.ts to distinguish AVR wiring from the chip and component.
 */
import { PinState } from 'avr8js';
import type { AvrRunner } from './runner';
import type { AvrPortName } from './pinMap';
import { Max72xx } from '../libraries/simulide/max72xx';
export type { Max72xxSnapshot } from '../libraries/simulide/max72xx';

export type Max7219Target = {
  id: string;
  powered: boolean;
  din: { port: AvrPortName; bit: number };
  clk: { port: AvrPortName; bit: number };
  cs: { port: AvrPortName; bit: number };
};

export class Max7219Bus {
  private devices: Array<{ target: Max7219Target; core: Max72xx }>;
  private detach: Array<() => void> = [];
  constructor(runner: AvrRunner, targets: Max7219Target[]) {
    this.devices = targets.map(target => ({ target: { ...target }, core: new Max72xx() }));
    const ports = { B: runner.portB, C: runner.portC, D: runner.portD };
    for (const device of this.devices) {
      const { target } = device;
      const sample = () => {
        if (!target.powered) return;
        const states = [target.cs, target.clk, target.din].map(ref => ports[ref.port].pinState(ref.bit));
        if (states.some(state => state === PinState.Input)) return;
        device.core.pins(...states.map(state => state === PinState.High || state === PinState.InputPullUp) as [boolean, boolean, boolean]);
      };
      for (const name of new Set([target.cs.port, target.clk.port, target.din.port])) {
        ports[name].addListener(sample);
        this.detach.push(() => ports[name].removeListener(sample));
      }
      sample();
    }
  }
  setPower(samples: Array<{ id: string; powered: boolean }>): void {
    for (const sample of samples) {
      const device = this.devices.find(d => d.target.id === sample.id);
      if (!device || device.target.powered === sample.powered) continue;
      device.target.powered = sample.powered;
      device.core = new Max72xx();
    }
  }
  snapshots() {
    return this.devices.map(({ target, core }) => ({ id: target.id, ...core.snapshot() }));
  }
  dispose(): void { for (const detach of this.detach) detach(); }
}

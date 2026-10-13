/**
 * What: Registry of part modules — the one place a new simulating component is switched on.
 * Role: lookup table the solvers, visuals, persistence, and UI consult.
 * Owns/exports: `PART_MODULES`, `getPartModule`.
 * Conventions: keys are `PlacedComponent.type` strings and must match each module's `type`.
 * Artwork-only parts (DIP shells, switches) stay in `src/registry/components.ts`.
 * Parallel LCDs (`lcd_16x2`, `lcd_20x4`) and PCF8574 LCD backpack are modules.
 * To add a part: create `src/components/<type>.ts(x)` exporting a `PartModule`, then one line here.
 * Not-here: the hook contract (`partModule.ts`) or any part behaviour.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / part module registry introduced
#                     | Registered remaining simulating parts (sources, button, semiconductors, meters)
#                     | Registered NE555 (definition-only; analog timer still pending)
# 03-10-2026 | Cursor | Registered RFID-RC522, MAX7219 8×8, microSD (definition-only; no SPI sim yet)
# 05-10-2026 | Cursor | Registered Keypad 4×4 (definition-only; no matrix scan yet)
#                     | Registered Button Matrix 4×4 (tactile; distinct from Keypad 4×4)
#                     | Registered parallel lcd_16x2 / lcd_20x4 (HD44780 IC facade)
#                     | Registered pcf8574_lcd_backpack (backpack board only; no LCD glass)
# 08-10-2026 | Cursor | Registered 74HC combinational gates (definition-only; no spiceStamp yet)
# 09-10-2026 | Cursor | Moved from `src/parts/index.ts` (tree reorganization)
#                     | Registered ds3231_rtc (I2C DS3231 + AT24C32)
 */
import type { PartModule } from './partModule';
import { resistorModule } from './passives/resistor';
import { ledModule } from './output/led';
import { rgbLedModule } from './output/rgbLed';
import { diodeModule } from './semiconductors/diode';
import { powerSupplyModule } from './instruments/powerSupply';
import { oscillatorModule } from './instruments/oscillator';
import { buttonModule } from './input/button';
import { transistorNpnModule } from './semiconductors/transistorNpn';
import { transistorPnpModule } from './semiconductors/transistorPnp';
import { mosfetNModule } from './semiconductors/mosfetN';
import { mosfetPModule } from './semiconductors/mosfetP';
import { capacitorModule, polarizedCapacitorModule } from './passives/capacitor';
import { potentiometerModule } from './passives/potentiometer';
import { buzzerModule } from './output/buzzer';
import { voltmeterModule } from './instruments/voltmeter';
import { ammeterModule } from './instruments/ammeter';
import { ohmmeterModule } from './instruments/ohmmeter';
import { ne555Module } from './modules/ne555';
import { hc00Module } from './IC/Logic Gates/74hc00';
import { hc02Module } from './IC/Logic Gates/74hc02';
import { hc03Module } from './IC/Logic Gates/74hc03';
import { hc04Module } from './IC/Logic Gates/74hc04';
import { hc08Module } from './IC/Logic Gates/74hc08';
import { hc10Module } from './IC/Logic Gates/74hc10';
import { hc11Module } from './IC/Logic Gates/74hc11';
import { hc20Module } from './IC/Logic Gates/74hc20';
import { hc21Module } from './IC/Logic Gates/74hc21';
import { hc27Module } from './IC/Logic Gates/74hc27';
import { hc32Module } from './IC/Logic Gates/74hc32';
import { hc86Module } from './IC/Logic Gates/74hc86';
import { rfidRc522Module } from './modules/rfidRc522';
import { max7219Matrix8x8Module } from './modules/max7219Matrix8x8';
import { microsdModule } from './modules/microsdModule';
import { keypad4x4Module } from './input/keypad4x4';
import { buttonMatrix4x4Module } from './input/buttonMatrix4x4';
import { lcd16x2Module } from './output/lcd16x2';
import { lcd20x4Module } from './output/lcd20x4';
import { pcf8574LcdBackpackModule } from './modules/pcf8574LcdBackpack';
import { ds3231RtcModule } from './modules/ds3231Rtc';

export const PART_MODULES: Record<string, PartModule> = {
  resistor: resistorModule,
  led: ledModule,
  rgb_led: rgbLedModule,
  diode: diodeModule,
  power_supply: powerSupplyModule,
  oscillator: oscillatorModule,
  button: buttonModule,
  transistor_npn: transistorNpnModule,
  transistor_pnp: transistorPnpModule,
  mosfet_n: mosfetNModule,
  mosfet_p: mosfetPModule,
  capacitor: capacitorModule,
  polarized_capacitor: polarizedCapacitorModule,
  potentiometer: potentiometerModule,
  buzzer: buzzerModule,
  voltmeter: voltmeterModule,
  ammeter: ammeterModule,
  ohmmeter: ohmmeterModule,
  ne555: ne555Module,
  '74hc00': hc00Module,
  '74hc02': hc02Module,
  '74hc03': hc03Module,
  '74hc04': hc04Module,
  '74hc08': hc08Module,
  '74hc10': hc10Module,
  '74hc11': hc11Module,
  '74hc20': hc20Module,
  '74hc21': hc21Module,
  '74hc27': hc27Module,
  '74hc32': hc32Module,
  '74hc86': hc86Module,
  rfid_rc522: rfidRc522Module,
  max7219_matrix_8x8: max7219Matrix8x8Module,
  microsd_module: microsdModule,
  keypad_4x4: keypad4x4Module,
  button_matrix_4x4: buttonMatrix4x4Module,
  lcd_16x2: lcd16x2Module,
  lcd_20x4: lcd20x4Module,
  pcf8574_lcd_backpack: pcf8574LcdBackpackModule,
  ds3231_rtc: ds3231RtcModule,
};

export function getPartModule(type: string): PartModule | undefined {
  return PART_MODULES[type];
}

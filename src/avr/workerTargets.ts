/**
 * What: Build Worker LCD probe descriptors from the placed circuit (EN masks + bus pin map).
 *
 * Merged in from `src/sim/buildTwiWorkerTargets.ts`: Build Worker TWI slave descriptors for PCF8574
 * LCD backpacks on the MCU bus. Role: Ideal I2C discovery — SDA/SCL nets must reach Uno/Nano I2C
 * pins; no pull-up SPICE. Also links backpack → parallel LCD parts whose RS/E (etc.) share the
 * backpack LCD-header nets.
 *
# Changelog
# Date       | Author | Remarks
# 05-10-2026 | Cursor | [src/sim/buildTwiWorkerTargets.ts] Changelog creation / lcd_i2c TWI targets
#                     | [src/sim/buildTwiWorkerTargets.ts] pcf8574_lcd_backpack (not lcd_i2c composite); optional parallel LCD link
#                     | Worker + WASM AVR path
# 09-10-2026 | Cursor | Merged `src/sim/buildTwiWorkerTargets.ts` into this file (tree reorganization)
#                     | Moved from `src/sim/buildLcdWorkerTargets.ts` (tree reorganization)
#                     | Discover DS3231 RTC modules on the MCU I2C nets
# 12-10-2026 | Cursor | DS3231 rtcAddr from placed rtcI2cAddr (default 0x68)
 */
import type { PlacedComponent, Wire } from '../types';
import { isParallelLcdType, parallelLcdGeometry } from '../components/output/lcdParallel';
import { buildCircuitNetlist, netForPin } from '../circuit/netlist';
import { ARDUINO_DIGITAL_PIN_MAP, isMcuBoard, type AvrPortName } from './pinMap';
import type { AvrWorkerInMessage } from './workerProtocol';
import { isPcf8574LcdBackpackType, PCF8574_LCD_BACKPACK_TYPE, PCF8574_DEFAULT_ADDR } from '../components/modules/pcf8574LcdBackpack';
import {
  isDs3231RtcType,
  DS3231_RTC_TYPE,
  DS3231_I2C_ADDR,
  AT24C32_I2C_ADDR,
} from '../components/modules/ds3231Rtc';

type LcdTarget = Extract<
  AvrWorkerInMessage,
  { type: 'start' }
>['lcdTargets'][number];

function mcuPinForLcdPin(
  netlist: ReturnType<typeof buildCircuitNetlist>,
  lcdId: string,
  lcdPinId: string,
): string | null {
  const netId = netForPin(netlist, { componentId: lcdId, pinId: lcdPinId });
  if (netId === null) return null;
  for (const ep of netlist.nets.get(netId) ?? []) {
    if (!isMcuBoard(ep.componentType)) continue;
    if (ARDUINO_DIGITAL_PIN_MAP[ep.pinId]) return ep.pinId;
  }
  return null;
}

function refForLcdPin(
  netlist: ReturnType<typeof buildCircuitNetlist>,
  lcdId: string,
  lcdPinId: string,
): { port: AvrPortName; bit: number } | undefined {
  const mcuPin = mcuPinForLcdPin(netlist, lcdId, lcdPinId);
  if (!mcuPin) return undefined;
  const map = ARDUINO_DIGITAL_PIN_MAP[mcuPin];
  if (!map) return undefined;
  return { port: map.port, bit: map.bit };
}

export function buildLcdWorkerTargets(
  components: PlacedComponent[],
  wires: Wire[],
): LcdTarget[] {
  const lcds = components.filter((c) => isParallelLcdType(c.type));
  if (lcds.length === 0) return [];

  const netlist = buildCircuitNetlist(components, wires);
  if (!netlist.mcu) return [];

  return lcds.map((lcd) => {
    const geo = parallelLcdGeometry(lcd.type);
    const en = refForLcdPin(netlist, lcd.id, 'en');
    const enMasks: Partial<Record<AvrPortName, number>> = {};
    if (en) {
      enMasks[en.port] = (enMasks[en.port] ?? 0) | (1 << en.bit);
    }
    return {
      id: lcd.id,
      cols: geo.cols,
      rows: geo.rows,
      enMasks,
      bus: {
        rs: refForLcdPin(netlist, lcd.id, 'rs'),
        rw: refForLcdPin(netlist, lcd.id, 'rw'),
        en,
        db: [0, 1, 2, 3, 4, 5, 6, 7].map(
          (i) => refForLcdPin(netlist, lcd.id, `db${i}`) ?? null,
        ),
      },
    };
  });
}

type TwiSlaveTarget = Extract<
  AvrWorkerInMessage,
  { type: 'start' }
>['twiSlaves'][number];

const MCU_SDA = new Set(['sda', 'a4']);
const MCU_SCL = new Set(['scl', 'a5']);

/** Backpack LCD header pin → parallel LCD pin id (HD44780) — for docs / future pin drive. */
export const BACKPACK_LCD_HEADER_MAP: Array<{
  backpack: string;
  parallel: string;
}> = [
  { backpack: 'lcd4', parallel: 'rs' },
  { backpack: 'lcd5', parallel: 'rw' },
  { backpack: 'lcd6', parallel: 'en' },
  { backpack: 'lcd11', parallel: 'db4' },
  { backpack: 'lcd12', parallel: 'db5' },
  { backpack: 'lcd13', parallel: 'db6' },
  { backpack: 'lcd14', parallel: 'db7' },
];

function mcuOwnsNetPins(
  netlist: ReturnType<typeof buildCircuitNetlist>,
  netId: number | null,
  pinIds: Set<string>,
): boolean {
  if (netId === null) return false;
  for (const ep of netlist.nets.get(netId) ?? []) {
    if (!isMcuBoard(ep.componentType)) continue;
    if (pinIds.has(ep.pinId)) return true;
  }
  return false;
}

function linkedParallelLcds(
  netlist: ReturnType<typeof buildCircuitNetlist>,
  backpackId: string,
  components: PlacedComponent[],
): Array<{ id: string; cols: number; rows: number }> {
  const enNet = netForPin(netlist, {
    componentId: backpackId,
    pinId: 'lcd6',
  });
  if (enNet === null) return [];

  const out: Array<{ id: string; cols: number; rows: number }> = [];
  for (const lcd of components) {
    if (!isParallelLcdType(lcd.type)) continue;
    const lcdEn = netForPin(netlist, { componentId: lcd.id, pinId: 'en' });
    if (lcdEn === null || lcdEn !== enNet) continue;
    // Prefer also matching RS so random shared EN nets don't false-link
    const bpRs = netForPin(netlist, {
      componentId: backpackId,
      pinId: 'lcd4',
    });
    const lcdRs = netForPin(netlist, { componentId: lcd.id, pinId: 'rs' });
    if (bpRs !== null && lcdRs !== null && bpRs !== lcdRs) continue;
    const geo = parallelLcdGeometry(lcd.type);
    out.push({ id: lcd.id, cols: geo.cols, rows: geo.rows });
  }
  return out;
}

export function buildTwiWorkerTargets(
  components: PlacedComponent[],
  wires: Wire[],
): TwiSlaveTarget[] {
  const backpacks = components.filter((c) =>
    isPcf8574LcdBackpackType(c.type),
  );
  const rtcs = components.filter((c) => isDs3231RtcType(c.type));
  if (backpacks.length === 0 && rtcs.length === 0) return [];

  const netlist = buildCircuitNetlist(components, wires);
  if (!netlist.mcu) return [];

  const out: TwiSlaveTarget[] = [];
  for (const bp of backpacks) {
    const sdaNet = netForPin(netlist, { componentId: bp.id, pinId: 'sda' });
    const sclNet = netForPin(netlist, { componentId: bp.id, pinId: 'scl' });
    if (!mcuOwnsNetPins(netlist, sdaNet, MCU_SDA)) continue;
    if (!mcuOwnsNetPins(netlist, sclNet, MCU_SCL)) continue;
    out.push({
      type: PCF8574_LCD_BACKPACK_TYPE,
      id: bp.id,
      addr: PCF8574_DEFAULT_ADDR,
      linkedLcds: linkedParallelLcds(netlist, bp.id, components),
    });
  }
  for (const rtc of rtcs) {
    const sdaNet = netForPin(netlist, { componentId: rtc.id, pinId: 'sda' });
    const sclNet = netForPin(netlist, { componentId: rtc.id, pinId: 'scl' });
    if (!mcuOwnsNetPins(netlist, sdaNet, MCU_SDA)) continue;
    if (!mcuOwnsNetPins(netlist, sclNet, MCU_SCL)) continue;
    out.push({
      type: DS3231_RTC_TYPE,
      id: rtc.id,
      rtcAddr: rtc.rtcI2cAddr ?? DS3231_I2C_ADDR,
      eepromAddr: AT24C32_I2C_ADDR,
    });
  }
  return out;
}

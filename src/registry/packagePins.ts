/**
 * What: Shared lead geometry for DIP and TO package footprints. Blank shells and named
 * IC / transistor modules share the same pin coords so parts never hardcode x/y when
 * they reuse a package SVG. Owns/exports: `dipPackagePins`, `dipDevicePins`,
 * `to92DevicePins`, `to220DevicePins`, `DipPackageId`, `DipLead`, `ToLead`.
 * Conventions: DIP pin 1 is bottom-left, numbering bottom L→R then top R→L (CCW).
 * Named DIPs call `dipDevicePins('dip14', { 1: { id, description }, … })` — map keys
 * are 1-based package pin numbers; values supply sim `id` / hover text / optional
 * `letter` / `type`. TO helpers take L→R lead triples. Complete DIP maps required
 * (every pin 1..2×perRow); missing or extra keys throw.
 * Not-here: package SVG artwork (`public/components/dip*.svg`) or part spiceStamp / evaluate.
 *
 * Changelog:
 * - 08-10-2026 — Restored DIP helpers (`dipPackagePins` / `dipDevicePins`) onto Concord baseline
 * - 07-10-2026 — DIP geometry + dipDevicePins(packageId, pinMap); bare shells share coords
 * - 25-09-2026 — Leaf module; description + optional letter (no pinLetters array)
 * - 24-09-2026 — Changelog creation / TO-92 and TO-220 pin helpers
 */
import type { PinDefinition } from '../types';

export type ToLead = {
  id: string;
  description: string;
  letter?: string;
};

type Triple = [ToLead, ToLead, ToLead];

export type DipPackageId =
  | 'dip4'
  | 'dip6'
  | 'dip8'
  | 'dip14'
  | 'dip16'
  | 'dip18'
  | 'dip20'
  | 'dip24'
  | 'dip28'
  | 'dip40';

export type DipLead = {
  id: string;
  description: string;
  letter?: string;
  type?: PinDefinition['type'];
};

const DIP_GEOM: Record<DipPackageId, { perRow: number; closerPins: boolean }> = {
  dip4: { perRow: 2, closerPins: false },
  dip6: { perRow: 3, closerPins: false },
  dip8: { perRow: 4, closerPins: false },
  dip14: { perRow: 7, closerPins: false },
  dip16: { perRow: 8, closerPins: false },
  dip18: { perRow: 9, closerPins: false },
  dip20: { perRow: 10, closerPins: false },
  dip24: { perRow: 12, closerPins: false },
  dip28: { perRow: 14, closerPins: false },
  dip40: { perRow: 20, closerPins: true },
};

/** DIP IC pins: bottom 1..n left→right, top continues counter-clockwise. */
export function dipPackagePins(opts: {
  perRow: number;
  closerPins: boolean;
}): PinDefinition[] {
  const { perRow, closerPins } = opts;
  const pins: PinDefinition[] = [];
  for (let i = 0; i < perRow; i++) {
    const n = i + 1;
    if (!closerPins) {
      pins.push({ id: String(n), description: String(n), x: 6 + i * 10, y: 32, type: 'digital' });
    } else {
      pins.push({ id: String(n), description: String(n), x: 6 + i * 8, y: 42, type: 'digital' });
    }
  }
  for (let i = 0; i < perRow; i++) {
    const n = perRow * 2 - i;
    if (!closerPins) {
      pins.push({ id: String(n), description: String(n), x: 6 + i * 10, y: 0, type: 'digital' });
    } else {
      pins.push({ id: String(n), description: String(n), x: 6 + i * 8, y: 0, type: 'digital' });
    }
  }
  return pins;
}

/**
 * Named DIP device: assign datasheet pin ids onto package pin numbers.
 * Example: `dipDevicePins('dip14', { 1: { id: '1a', description: '1A' }, … })`.
 */
export function dipDevicePins(
  packageId: DipPackageId,
  pinMap: Record<number, DipLead>,
): PinDefinition[] {
  const geom = DIP_GEOM[packageId];
  if (!geom) {
    throw new Error(`Unknown DIP package: ${packageId}`);
  }
  const shell = dipPackagePins(geom);
  const pinCount = geom.perRow * 2;
  const keys = Object.keys(pinMap).map(Number);
  if (keys.length !== pinCount) {
    throw new Error(
      `dipDevicePins(${packageId}): expected ${pinCount} pins, got ${keys.length}`,
    );
  }
  for (let n = 1; n <= pinCount; n++) {
    if (pinMap[n] == null) {
      throw new Error(`dipDevicePins(${packageId}): missing package pin ${n}`);
    }
  }
  return shell.map((pad) => {
    const n = Number(pad.id);
    const lead = pinMap[n]!;
    return {
      id: lead.id,
      description: lead.description,
      ...(lead.letter !== undefined ? { letter: lead.letter } : {}),
      x: pad.x,
      y: pad.y,
      type: lead.type ?? 'digital',
    };
  });
}

/** TO-92 leads L→R (design space). */
export function to92DevicePins(leads: Triple): PinDefinition[] {
  const xs = [2, 12, 22] as const;
  return leads.map((lead, i) => ({
    id: lead.id,
    description: lead.description,
    ...(lead.letter !== undefined ? { letter: lead.letter } : {}),
    x: xs[i],
    y: 38,
    type: 'digital' as const,
  }));
}

/** TO-220 leads L→R (design space). */
export function to220DevicePins(leads: Triple): PinDefinition[] {
  const xs = [5, 15, 25] as const;
  return leads.map((lead, i) => ({
    id: lead.id,
    description: lead.description,
    ...(lead.letter !== undefined ? { letter: lead.letter } : {}),
    x: xs[i],
    y: 44,
    type: 'digital' as const,
  }));
}

/**
 * What: Everything the simulator knows about a two-pin piezo buzzer, in one file.
 * Role: part module — footprint, digital "active" flag (≥2.5 V across +/−), glow level,
 * series path, and a 30 mA placeholder for wire animation (no SPICE model).
 * Owns/exports: `buzzerModule`.
 * Conventions: active is a voltage threshold, not a frequency. CSS `is-buzzer-active` is
 * applied in ComponentShape from `flags.buzzerActive`.
 * To change the trip voltage: the 2.5 V compare in `evaluate`.
 * Not-here: the MCU tone / PWM electrical model (not simulated).
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 09-10-2026 | Cursor | Moved from `src/parts/buzzer.ts` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import type { PartModule } from '../partModule';

const BUZZER_MA = 30;

export const buzzerModule: PartModule = {
  palette: { category: 'output', order: 50 },
  type: 'buzzer',

  definition: {
    type: 'buzzer',
    label: 'Buzzer',
    scale: 1,
    artwork: '/components/buzzer.svg',
    pins: [
      { id: 'pos', description: '+', x: 32, y: 48, type: 'digital' },
      { id: 'neg', description: '−', x: 14, y: 48, type: 'ground' },
    ],
  },

  evaluate(ctx) {
    const vP = ctx.levelVolts(ctx.netLevel(ctx.pinNet('pos')));
    const vN = ctx.levelVolts(ctx.netLevel(ctx.pinNet('neg')));
    ctx.flags.buzzerActive[ctx.comp.id] = vP - vN >= 2.5;
  },

  visuals(ctx) {
    ctx.flags.buzzerLevel[ctx.comp.id] = ctx.flags.buzzerActive[ctx.comp.id] ? 1 : 0;
  },

  branchCurrentPass: 3,
  branchCurrent(ctx) {
    if (!ctx.flags.buzzerActive[ctx.comp.id]) return;
    const nPos = ctx.pinNet('pos');
    const nNeg = ctx.pinNet('neg');
    if (nPos !== null && ctx.netMa(nPos) === undefined) ctx.setNetMa(nPos, BUZZER_MA);
    if (nNeg !== null && ctx.netMa(nNeg) === undefined) ctx.setNetMa(nNeg, BUZZER_MA);
  },

  seriesPins(_comp, pinId) {
    if (pinId === 'pos') return ['neg'];
    if (pinId === 'neg') return ['pos'];
    return [];
  },
};

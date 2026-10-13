/**
 * What: Everything the simulator knows about the common-cathode RGB LED, in one file.
 * Role: part module — footprint, three SPICE/legacy diodes, per-channel conduction,
 * additive glow overlay, and branch current per anode plus the shared cathode.
 * Owns/exports: `rgbLedModule`.
 * Conventions: each colour die is a separate diode from its anode pin to `cathode`.
 * Drive is digital (on/off, no PWM). Channel keys `r`/`g`/`b` match `RGB_LED_CHANNELS`.
 * SPICE instance names are not tracked (legacy behaviour — no #branch lookup per die).
 * To retune Vf/If: `values/led.ts` `RGB_LED_CHANNELS` (pin ids must match this footprint).
 * Not-here: the single-colour LED module.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / migrated out of the per-subsystem type switches
# 24-09-2026 | Cursor | Glow uses rgb_led.svg body silhouette (not old oval outside footprint)
#                     | Wire mA from series-R (not rated If); sub-threshold ignored; seriesPins
# 09-10-2026 | Cursor | Moved from `src/parts/rgbLed.tsx` (tree reorganization)
# 13-10-2026 | Codex | Declare palette category/order beside this part; preserve placement order and electrical behavior.
 */
import type { CSSProperties } from 'react';
import { netForPin, type NetLevel } from '../../circuit/netlist';
import { RGB_LED_CHANNELS, VF_CONDUCT_SLACK_V } from '../../values/led';
import { ledBranchCurrentMa, ledSpiceModelParams } from './led';
import type { PartModule } from '../partModule';

/**
 * Body silhouette from public/components/rgb_led.svg path7/path8, translated from
 * viewBox origin (-1000,-1000) into footprint design space (~32×34.4).
 */
const RGB_LED_BODY_PATH =
  'm 22.82,15.135 v -8.26 c 0,-3.76 -3.04,-6.8 -6.8,-6.8 -3.76,0 -6.8,3.04 -6.8,6.8 v 8.26 2.03 3.37 c 1.38,1.14 3.9,1.91 6.8,1.91 4.37,0 7.91,-1.74 7.91,-3.88 0,-0.23 0,-1.15 0,-1.4 0,-0.74 -0.41,-1.43 -1.11,-2.03 z';

const MIN_WIRE_CURRENT_MA = 0.05;
const DEFAULT_SERIES_OHMS = 220;

function netVoltsFromBranchCtx(
  netVoltages: Map<number, number> | undefined,
  levels: Map<number, NetLevel>,
  netId: number | null,
): number {
  if (netId === null) return 0;
  if (netVoltages?.has(netId)) return netVoltages.get(netId)!;
  const level = levels.get(netId);
  if (level === 'high') return 5;
  if (level === 'low') return 0;
  return 0;
}

function RgbLitOverlay({
  channels,
}: {
  channels?: { r: boolean; g: boolean; b: boolean };
}) {
  if (!channels) return null;
  const r = channels.r ? 255 : 0;
  const g = channels.g ? 255 : 0;
  const b = channels.b ? 255 : 0;
  if (!r && !g && !b) return null;
  const color = `rgb(${r}, ${g}, ${b})`;
  return (
    <path
      d={RGB_LED_BODY_PATH}
      fill={color}
      opacity={0.55}
      className="led-package is-lit rgb-led-lit-overlay led-glow-layer"
      style={{ '--led-glow': color, '--led-brightness': 1 } as CSSProperties}
      pointerEvents="none"
    />
  );
}

export const rgbLedModule: PartModule = {
  palette: { category: 'output', order: 10 },
  type: 'rgb_led',

  definition: {
    type: 'rgb_led',
    label: 'RGB LED',
    scale: 2,
    artwork: '/components/rgb_led.svg',
    pins: [
      { id: 'red', description: 'R', x: 1, y: 35, type: 'digital' },
      { id: 'cathode', description: 'Cathode', x: 11, y: 35, type: 'ground' },
      { id: 'blue', description: 'B', x: 21, y: 35, type: 'digital' },
      { id: 'green', description: 'G', x: 31, y: 35, type: 'digital' },
    ],
  },

  spiceStamp(ctx) {
    const nk = ctx.pinNet('cathode');
    if (nk === null) return;
    for (const ch of RGB_LED_CHANNELS) {
      const na = ctx.pinNet(ch.anodePin);
      if (na === null) continue;
      const model = `RGB_${ctx.sid}_${ch.key}`;
      ctx.model(
        `.model ${model} D (${ledSpiceModelParams(ch.forwardVoltage, ch.forwardCurrentMa)})`,
      );
      ctx.line(`D${ctx.sid}_${ch.key} ${ctx.node(na)} ${ctx.node(nk)} ${model}`);
    }
  },

  legacyStamp(ctx) {
    const nk = ctx.pinNet('cathode');
    if (nk === null) return;
    for (const ch of RGB_LED_CHANNELS) {
      const na = ctx.pinNet(ch.anodePin);
      if (na === null) continue;
      if (ctx.ledOn[`${ctx.comp.id}:${ch.key}`]) {
        ctx.stampLedOn(na, nk, ch.forwardVoltage);
      }
    }
  },

  legacySettleConduction(ctx) {
    const nk = ctx.pinNet('cathode');
    if (nk === null) return false;
    let changed = false;
    for (const ch of RGB_LED_CHANNELS) {
      const na = ctx.pinNet(ch.anodePin);
      if (na === null) continue;
      const key = `${ctx.comp.id}:${ch.key}`;
      const vDrop = (ctx.voltages.get(na) ?? 0) - (ctx.voltages.get(nk) ?? 0);
      const next = vDrop >= ch.forwardVoltage - VF_CONDUCT_SLACK_V;
      if (ctx.ledOn[key] !== next) {
        ctx.ledOn[key] = next;
        changed = true;
      }
    }
    return changed;
  },

  visuals(ctx) {
    const id = ctx.comp.id;
    const vK = ctx.netVolts(ctx.pinNet('cathode'));
    const channelOn = (channel: (typeof RGB_LED_CHANNELS)[number]): boolean => {
      const conduct = ctx.ledConducting?.[`${id}:${channel.key}`];
      if (conduct !== undefined) return conduct;
      const net = ctx.pinNet(channel.anodePin);
      if (net === null) return false;
      return ctx.netVolts(net) - vK >= channel.forwardVoltage - VF_CONDUCT_SLACK_V;
    };
    ctx.flags.rgbLedChannels[id] = Object.fromEntries(
      RGB_LED_CHANNELS.map((ch) => [ch.key, channelOn(ch)]),
    ) as { r: boolean; g: boolean; b: boolean };
  },

  branchCurrentPass: 2,
  branchCurrent(ctx) {
    const channels = ctx.flags.rgbLedChannels?.[ctx.comp.id];
    if (!channels) return;
    const nK = ctx.pinNet('cathode');
    const netOfPin = (componentId: string, pinId: string) =>
      netForPin(ctx.netlist, { componentId, pinId });
    let cathodeMa = 0;
    for (const ch of RGB_LED_CHANNELS) {
      if (!channels[ch.key]) continue;
      const nA = ctx.pinNet(ch.anodePin);
      const vDrop =
        netVoltsFromBranchCtx(ctx.netVoltages, ctx.levels, nA) -
        netVoltsFromBranchCtx(ctx.netVoltages, ctx.levels, nK);
      const measuredMa = ledBranchCurrentMa(
        ctx.components,
        netOfPin,
        ctx.resistorMa,
        nA,
        nK,
        vDrop,
        ch.forwardVoltage,
        DEFAULT_SERIES_OHMS,
      );
      const anodePrev = nA !== null ? ctx.netMa(nA) : undefined;
      // Prefer a meaningful series-R claim already on the anode; never copy sub-threshold noise.
      const channelMa =
        anodePrev !== undefined && anodePrev >= MIN_WIRE_CURRENT_MA
          ? anodePrev
          : measuredMa;

      cathodeMa += channelMa;
      if (nA !== null && ctx.netMa(nA) === undefined && channelMa >= MIN_WIRE_CURRENT_MA) {
        ctx.setNetMa(nA, channelMa);
      }
    }
    if (nK !== null && cathodeMa >= MIN_WIRE_CURRENT_MA && ctx.netMa(nK) === undefined) {
      ctx.setNetMa(nK, cathodeMa);
    }
  },

  seriesPins(comp, pinId, flags) {
    const channels = flags.rgbLedChannels?.[comp.id];
    if (!channels) return [];
    if (pinId === 'cathode') {
      return RGB_LED_CHANNELS.filter((ch) => channels[ch.key]).map((ch) => ch.anodePin);
    }
    const ch = RGB_LED_CHANNELS.find((c) => c.anodePin === pinId);
    if (ch && channels[ch.key]) return ['cathode'];
    return [];
  },

  overlay: ({ component, simFlags, simRunning }) =>
    simRunning ? (
      <RgbLitOverlay channels={simFlags?.rgbLedChannels[component.id]} />
    ) : null,
};

/**
 * What: The contract a single part file implements to own everything about one component type.
 * Role: seam between the subsystems (SPICE export, legacy MNA, digital solve, visuals, currents,
 * persistence, UI) and per-part code, so a part lives in one file instead of nine.
 * Owns/exports: `PartModule` plus one context interface per hook.
 * Conventions: every hook exists only because it replaces an existing `switch (comp.type)` arm —
 * no speculative hooks. Hooks never import solver modules; everything a part needs (net lookup,
 * matrix stamping, drive setting) arrives on its context object. That keeps `src/components/*` a leaf
 * of the import graph and prevents cycles with the solvers that dispatch into it.
 * To add a part: create `src/components/<type>.ts` exporting a `PartModule`, register it in
 * `src/components/index.ts`, and implement only the hooks that part actually needs.
 * To add a hook: first delete the `switch` arm it replaces — a hook with no call site is dead code.
 * Not-here: any part implementation, the registry index, or artwork — see `src/components/index.ts`,
 * `src/registry/components.ts`, and `public/components/*.svg`.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation / part module contract introduced
# 23-09-2026 | Cursor | `definition.scale` optional when `package` is set (inherits footprint)
# 09-10-2026 | Cursor | Moved from `src/parts/partModule.ts` (tree reorganization)
#                     | `internalPinShorts` for module PCB copper (DS3231 dual headers)
 */
import type { ReactNode } from 'react';
import type {
  ComponentDefinition,
  ComponentRegistryEntry,
  PlacedComponent,
} from '../types';
import type { CircuitNetlist, NetLevel } from '../circuit/netlist';
import type { SpiceCatalog } from '../circuit/spice/models';
import type { ResolvedSpiceModel } from '../circuit/spice/models';
import type { SupplyVoltageOverrides } from '../circuit/supplyLimit';
import type { CircuitSimState, ComponentSimFlags } from '../circuit/solver';
import type { DcSolveResult } from '../circuit/mnaLegacy';

/** Net id for one of the current component's pins; null when that pin is unwired. */
export type PinNetLookup = (pinId: string) => number | null;

/** Drive strength when a part forces a net level. Higher wins in `resolveGroups`. */
export type DrivePriority = 0 | 1 | 2 | 3;

/** Per-component failure and press state the solvers thread through every pass. */
export interface SolveStateMaps {
  resistorBlown: Record<string, boolean>;
  ledBlown: Record<string, boolean>;
  buttonPressed: Record<string, boolean>;
  /** Open after reverse/overvoltage; optional until callers thread it. */
  capacitorBlown?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// SPICE .OP deck export — replaces arms in circuit/spice/netlistExport.ts
// ---------------------------------------------------------------------------

export interface SpiceStampCtx extends SolveStateMaps {
  comp: PlacedComponent;
  /** Component id sanitized for SPICE instance names (`R<sid>`, `D<sid>`, …). */
  sid: string;
  netlist: CircuitNetlist;
  catalog: SpiceCatalog | null;
  simTimeMs: number;
  supplyVoltageOverrides: SupplyVoltageOverrides;
  pinNet: PinNetLookup;
  /** SPICE node name for a net id — `'0'` for the ground net, else `n<netId>`. */
  node: (netId: number) => string;
  /** Append an element line to the deck. */
  line: (text: string) => void;
  /** Append a `.model` line; models are emitted after all elements. */
  model: (text: string) => void;
  /** Record the instance name so ngspice `#branch` current maps back to this component. */
  instance: (name: string) => void;
  /** Mark a net as already driven by this part, so MCU rails do not stamp over it. */
  markSourced: (netId: number) => void;
  /** Catalog model for this component, or null when it should use a synthetic model. */
  resolveModel: () => ResolvedSpiceModel | null;
}

export interface SpiceCacheKeyCtx extends SolveStateMaps {
  comp: PlacedComponent;
  simTimeMs: number;
}

// ---------------------------------------------------------------------------
// Legacy nodal solver — replaces arms in circuit/mnaLegacy.ts
// ---------------------------------------------------------------------------

/** Pass that pins nets to known voltages before the matrix is built. */
export interface FixedVoltageCtx {
  comp: PlacedComponent;
  netlist: CircuitNetlist;
  simTimeMs: number;
  supplyVoltageOverrides: SupplyVoltageOverrides;
  pinNet: PinNetLookup;
  setFixed: (netId: number, volts: number) => void;
  hasFixed: (netId: number) => boolean;
}

/** Matrix-stamping pass. Runs once per solver iteration. */
export interface LegacyStampCtx extends SolveStateMaps {
  comp: PlacedComponent;
  netlist: CircuitNetlist;
  /** Conduction decided by the previous iteration; keyed by component id (or `id:channel`). */
  ledOn: Record<string, boolean>;
  pinNet: PinNetLookup;
  /** Stamp a conductance of `1/ohms` between two nets. */
  stampResistor: (na: number, nb: number, ohms: number) => void;
  /** Stamp the Norton equivalent of a forward-biased diode (Vf in series with R_on). */
  stampLedOn: (anode: number, cathode: number, vf: number) => void;
}

/** Between iterations: decide whether this part's conduction state flipped. */
export interface SettleConductionCtx extends SolveStateMaps {
  comp: PlacedComponent;
  netlist: CircuitNetlist;
  voltages: Map<number, number>;
  ledOn: Record<string, boolean>;
  pinNet: PinNetLookup;
}

// ---------------------------------------------------------------------------
// Digital net solve — replaces arms in circuit/solver.ts
// ---------------------------------------------------------------------------

/**
 * Seed flags from the DC solve before the digital passes begin. Runs once per solve.
 * Only for flags the evaluate pass then reads — anything else belongs in `publishState`.
 */
export interface ApplyDcResultCtx {
  comp: PlacedComponent;
  netlist: CircuitNetlist;
  flags: ComponentSimFlags;
  dc: DcSolveResult | null;
  pinNet: PinNetLookup;
}

/**
 * Net merging. Runs twice per pass: `'static'` for connections that always exist (button leg
 * pairs, ammeter shunt) and `'dynamic'` for ones that depend on the levels the evaluate step
 * just produced (pressed contact, saturated transistor, charged capacitor).
 * The state maps below are empty during the `'static'` phase.
 */
export interface UnionCtx {
  comp: PlacedComponent;
  netlist: CircuitNetlist;
  phase: 'static' | 'dynamic';
  /** True when ngspice models the button as resistors, so the digital short must not double up. */
  spiceButtonModel: boolean;
  buttonPressed: Record<string, boolean>;
  transistorOn: Record<string, boolean>;
  mosfetOn: Record<string, boolean>;
  capacitorCharge: Record<string, number>;
  pinNet: PinNetLookup;
  union: (a: number, b: number) => void;
}

/** Read net levels, publish sim flags, and optionally drive nets. */
export interface EvaluateCtx {
  comp: PlacedComponent;
  netlist: CircuitNetlist;
  levels: Map<number, NetLevel>;
  simState: CircuitSimState;
  flags: ComponentSimFlags;
  simTimeMs: number;
  /** LED conduction from the DC solve; authoritative over the digital estimate when present. */
  dcLedOn?: Record<string, boolean>;
  pinNet: PinNetLookup;
  netLevel: (netId: number | null) => NetLevel;
  /** Digital level to volts (5 V, 0 V, or the threshold for floating). */
  levelVolts: (level: NetLevel) => number;
  voltsToLevel: (volts: number) => NetLevel;
  drive: (netId: number | null, level: NetLevel, priority: DrivePriority) => void;
}

/**
 * Runs once after the iteration loop has settled. This is where time-integrated state advances
 * (capacitor charge) and where settled `simState` is copied into `flags` for the UI.
 */
export interface PublishStateCtx {
  comp: PlacedComponent;
  simState: CircuitSimState;
  flags: ComponentSimFlags;
  levels: Map<number, NetLevel>;
  /** Solve-clock ms since the previous frame; computed once, so every part sees the same value. */
  dtMs: number;
  pinNet: PinNetLookup;
  netLevel: (netId: number | null) => NetLevel;
  levelVolts: (level: NetLevel) => number;
}

/**
 * Meter faces. Runs last, once per-net branch currents are known — which is why this is
 * separate from `visuals`.
 */
export interface ReadingCtx {
  comp: PlacedComponent;
  components: PlacedComponent[];
  netlist: CircuitNetlist;
  levels: Map<number, NetLevel>;
  flags: ComponentSimFlags;
  netVoltages?: Map<number, number>;
  /** ngspice `#branch` currents (mA) by component id. */
  branchCurrentMa?: Record<string, number>;
  pinNet: PinNetLookup;
  netOfPin: (componentId: string, pinId: string) => number | null;
  netLevel: (netId: number | null) => NetLevel;
  levelVolts: (level: NetLevel) => number;
  /** Best-effort current (mA) flowing on a net, from branch data or a neighbouring part. */
  netCurrentMa: (netId: number) => number;
}

// ---------------------------------------------------------------------------
// Post-solve visuals — replaces arms in circuit/visuals.ts
// ---------------------------------------------------------------------------

export interface VisualCtx {
  comp: PlacedComponent;
  /** Full canvas list — LEDs need it to find their series resistor. */
  components: PlacedComponent[];
  netlist: CircuitNetlist;
  levels: Map<number, NetLevel>;
  simState: CircuitSimState;
  flags: ComponentSimFlags;
  /** Real elapsed ms since the last visual pass; 0 on the first frame. */
  dtMs: number;
  /** Same as `dtMs` but floored at 16 ms, for failure timers that must still advance. */
  blowDtMs: number;
  netVoltages?: Map<number, number>;
  ledConducting?: Record<string, boolean>;
  /** ngspice `#branch` currents (mA) by component id, when the SPICE backend ran. */
  branchCurrentMa?: Record<string, number>;
  pinNet: PinNetLookup;
  /** Net lookup for a *different* component — LEDs use it to probe their series resistor. */
  netOfPin: (componentId: string, pinId: string) => number | null;
  /** Solved net voltage, falling back to the digital level model when unsolved. */
  netVolts: (netId: number | null) => number;
  /** |dV|/R for any resistor on the canvas, using the strict branch-current voltage model. */
  resistorMa: (resistor: PlacedComponent) => number;
}

// ---------------------------------------------------------------------------
// Wire current animation — replaces arms in circuit/currents.ts
// ---------------------------------------------------------------------------

export interface BranchCurrentFlags {
  ledCurrentMa: Record<string, number>;
  ledLit: Record<string, boolean>;
  buzzerActive: Record<string, boolean>;
  resistorBlown?: Record<string, boolean>;
  ledBlown?: Record<string, boolean>;
  rgbLedChannels?: Record<string, { r: boolean; g: boolean; b: boolean }>;
}

export interface BranchCurrentCtx {
  comp: PlacedComponent;
  /** Full canvas list — some parts estimate through a neighbouring resistor. */
  components: PlacedComponent[];
  netlist: CircuitNetlist;
  levels: Map<number, NetLevel>;
  flags: BranchCurrentFlags;
  netVoltages?: Map<number, number>;
  branchCurrentMa?: Record<string, number>;
  pinNet: PinNetLookup;
  /** Current (mA) an earlier pass already assigned to this net, if any. */
  netMa: (netId: number) => number | undefined;
  /** Claim a net's branch current. Later passes must not overwrite earlier ones. */
  setNetMa: (netId: number, ma: number) => void;
  /** |dV|/R for any resistor on the canvas — several parts estimate through a neighbour. */
  resistorMa: (resistor: PlacedComponent) => number;
}

/** Pin classification for the source-to-sink flow trace. */
export type PinRole = 'source' | 'sink';

// ---------------------------------------------------------------------------
// Persistence + UI — replaces arms in project/projectFile.ts, store/SimContext.tsx,
// ui/palette/Palette.tsx, and ui/editors/editable.ts
// ---------------------------------------------------------------------------

export interface PartProperties {
  /**
   * Instance fields written when the part is newly placed. Also used for the palette preview,
   * so the two can never drift apart.
   */
  defaults?: () => Partial<PlacedComponent>;
  /**
   * Copy persisted fields off untrusted JSON onto a loading component.
   * Must validate every field: a saved project is user-editable input.
   */
  load?: (raw: Record<string, unknown>, into: PlacedComponent) => void;
  /** True when double-clicking the part opens a value editor (beyond chip renaming). */
  editable?: boolean;
}

export interface PartOverlayProps {
  component: PlacedComponent;
  design: ComponentDefinition;
  simFlags?: ComponentSimFlags;
  simRunning?: boolean;
}

// ---------------------------------------------------------------------------

export interface PartModule {
  /** Must equal the key this module is registered under and `definition.type`. */
  type: string;
  /** Catalog entry: pins, artwork, package, marking; `scale` optional (inherits from `package`). */
  definition: ComponentRegistryEntry;

  spiceStamp?: (ctx: SpiceStampCtx) => void;
  /** Extra cache-key fragment for fields that change the ngspice result. */
  spiceCacheKey?: (ctx: SpiceCacheKeyCtx) => string;

  legacyFixedVoltages?: (ctx: FixedVoltageCtx) => void;
  legacyStamp?: (ctx: LegacyStampCtx) => void;
  /** Return true when conduction changed, which forces another solver iteration. */
  legacySettleConduction?: (ctx: SettleConductionCtx) => boolean;

  applyDcResult?: (ctx: ApplyDcResultCtx) => void;
  netUnions?: (ctx: UnionCtx) => void;
  evaluate?: (ctx: EvaluateCtx) => void;
  publishState?: (ctx: PublishStateCtx) => void;

  visuals?: (ctx: VisualCtx) => void;
  readings?: (ctx: ReadingCtx) => void;

  /**
   * Ordering within `buildNetBranchCurrentMa`: lower passes run first and win ties.
   * Resistors seed nets, LEDs and buzzers fill the gaps, buttons copy whatever the loop
   * already produced — so the order is behaviour, not style. Defaults to 0.
   */
  branchCurrentPass?: number;
  branchCurrent?: (ctx: BranchCurrentCtx) => void;
  /** Pins carrying the same branch current as `pinId` (series path through the part). */
  seriesPins?: (
    comp: PlacedComponent,
    pinId: string,
    flags: ComponentSimFlags,
  ) => string[];
  /** Override the pin-type default for flow tracing; undefined falls through to `pin.type`. */
  pinRole?: (
    comp: PlacedComponent,
    pinId: string,
    flags: ComponentSimFlags,
  ) => PinRole | undefined;

  properties?: PartProperties;
  overlay?: (props: PartOverlayProps) => ReactNode;

  /** Pin ids that must exist as nets even when unwired (button legs). */
  ensurePins?: string[];
  /**
   * Pin-id pairs that are the same PCB copper (duplicate headers). Applied in
   * `buildCircuitNetlist` so I2C discovery sees either header as one net.
   */
  internalPinShorts?: ReadonlyArray<readonly [string, string]>;
  /** True when this part can run a circuit-only sim without an MCU board. */
  standaloneSource?: boolean;
}

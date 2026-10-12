/**
 * What: Versioned JSON save/load for circuit + viewport + optional sketch text.
 * Role: parse/validate/migrate on load; serialize editor state on save/download.
 * Owns/exports: `PROJECT_FILE_VERSION`, `ProjectFile`, `SimSnapshot`, `parseProjectJson`,
 * `createProjectFile`, `projectFileToJson`, download helper, `maxIdSuffix`, normalization.
 * Conventions: unknown component types fail load; optional fields validated via guards from
 * `resistor.ts`, `led.ts`, `electric.ts`; sketch fields optional on disk.
 * To persist a new `PlacedComponent` field: add to `types.ts`, set defaults on place in
 * `SimContext`, validate/normalize in `parseProjectJson` (and migration if renaming).
 * To bump schema: increment `PROJECT_FILE_VERSION`, branch migration in parser, keep backward load.
 * To allocate ids after load: use `maxIdSuffix` on component/wire ids before creating new ones.
 * Not-here: server API (`projectFile.ts`) or undo snapshots (`history.ts` — similar shape).
 *
 * Merged in from `src/utils/userProjectsApi.ts`: Optional HTTP client for server-backed project
 * JSON at `/api/user-projects`. Role: list/load/save text blobs — caller owns parse via
 * `projectFile.ts`. Owns/exports: `isUserProjectsApiAvailable`, `listUserProjects`,
 * `loadUserProjectFile`, `saveUserProjectFile`, `normalizeProjectFilename`. Conventions: GET base
 * URL probes availability; filenames URL-encoded; save uses PUT with raw JSON body; empty name →
 * `arduino-circuit.json`. To wire cloud save in UI: stringify with `projectFileToJson`,
 * `saveUserProjectFile(name, json)`. To open from server: `loadUserProjectFile` then
 * `parseProjectJson`. To disable gracefully: call `isUserProjectsApiAvailable` before showing
 * server UI. Not-here: local download, sketch `.ino` handling, or auth — dev server route only.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/utils/projectFile.ts` (tree reorganization)
 * - 09-10-2026 — Merged `src/utils/userProjectsApi.ts` into this file (tree reorganization)
 * - 17-09-2026 — Part modules validate their own persisted fields via `properties.load`
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 * - [src/utils/userProjectsApi.ts] 17-09-2026 — Expanded What with practical how-to notes
 * - [src/utils/userProjectsApi.ts] 17-09-2026 — Changelog creation
 */
import { getDefinition } from '../registry/components';
import { getPartModule } from '../components';
import type { PinState, PlacedComponent, Viewport, Wire } from '../types';

export const PROJECT_FILE_VERSION = 1;

export interface ProjectFile {
  version: number;
  components: PlacedComponent[];
  wires: Wire[];
  viewport: Viewport;
  /** In-app sketch source (optional, saved with circuit). */
  sketch?: string;
  /** Sketch basename without .ino (optional). */
  sketchName?: string;
}

export interface SimSnapshot {
  components: PlacedComponent[];
  wires: Wire[];
  viewport: Viewport;
  sketch?: string;
  sketchName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPinState(value: unknown): value is PinState {
  return value === 'low' || value === 'high' || value === 'floating';
}

function parsePoint(value: unknown, label: string): { x: number; y: number } {
  if (!isRecord(value) || !isNumber(value.x) || !isNumber(value.y)) {
    throw new Error(`Invalid ${label}: expected { x, y } numbers`);
  }
  return { x: value.x, y: value.y };
}

function parsePinRef(value: unknown, label: string): {
  componentId: string;
  pinId: string;
} {
  if (
    !isRecord(value) ||
    typeof value.componentId !== 'string' ||
    typeof value.pinId !== 'string'
  ) {
    throw new Error(`Invalid ${label}: expected { componentId, pinId }`);
  }
  return { componentId: value.componentId, pinId: value.pinId };
}

function parseComponent(value: unknown, index: number): PlacedComponent {
  if (!isRecord(value)) {
    throw new Error(`Invalid component at index ${index}`);
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.type !== 'string' ||
    !isNumber(value.x) ||
    !isNumber(value.y) ||
    !isNumber(value.rotation) ||
    !isRecord(value.pinStates)
  ) {
    throw new Error(`Component at index ${index} is missing required fields`);
  }

  let def;
  try {
    def = getDefinition(value.type);
  } catch {
    throw new Error(`Unknown component type "${value.type}" at index ${index}`);
  }

  const pinStates: Record<string, PinState> = {};
  for (const pin of def.pins) {
    const state = value.pinStates[pin.id];
    pinStates[pin.id] = isPinState(state) ? state : 'floating';
  }

  const component: PlacedComponent = {
    id: value.id,
    type: value.type,
    x: value.x,
    y: value.y,
    rotation: value.rotation,
    pinStates,
  };

  getPartModule(value.type)?.properties?.load?.(value, component);

  if (def.marking === 'chip' && typeof value.partLabel === 'string') {
    const trimmed = value.partLabel.trim();
    if (trimmed) component.partLabel = trimmed;
  }

  return component;
}

function parseWire(
  value: unknown,
  index: number,
  componentIds: Set<string>,
): Wire {
  if (!isRecord(value)) {
    throw new Error(`Invalid wire at index ${index}`);
  }
  if (typeof value.id !== 'string' || !Array.isArray(value.bends)) {
    throw new Error(`Wire at index ${index} is missing required fields`);
  }

  const from = parsePinRef(value.from, `wire ${index} from`);
  const to = parsePinRef(value.to, `wire ${index} to`);

  for (const end of [from, to]) {
    if (!componentIds.has(end.componentId)) {
      throw new Error(
        `Wire at index ${index} references unknown component "${end.componentId}"`,
      );
    }
  }

  const bends = value.bends.map((bend, bendIndex) =>
    parsePoint(bend, `wire ${index} bend ${bendIndex}`),
  );

  return {
    id: value.id,
    from,
    to,
    bends,
  };
}

function validateWirePins(components: PlacedComponent[], wires: Wire[]): void {
  const compById = new Map(components.map((c) => [c.id, c]));

  for (let i = 0; i < wires.length; i++) {
    const wire = wires[i];
    for (const end of [wire.from, wire.to]) {
      const comp = compById.get(end.componentId);
      if (!comp) continue;
      const def = getDefinition(comp.type);
      if (!def.pins.some((p) => p.id === end.pinId)) {
        throw new Error(
          `Wire at index ${i} references unknown pin "${end.pinId}" on ${comp.type}`,
        );
      }
    }
  }
}

function parseViewport(value: unknown): Viewport {
  if (!isRecord(value) || !isNumber(value.x) || !isNumber(value.y) || !isNumber(value.zoom)) {
    throw new Error('Invalid viewport: expected { x, y, zoom } numbers');
  }
  if (value.zoom <= 0) {
    throw new Error('Invalid viewport: zoom must be greater than 0');
  }
  return { x: value.x, y: value.y, zoom: value.zoom };
}

/** Build a portable project document from the current simulation state. */
export function createProjectFile(snapshot: SimSnapshot): ProjectFile {
  const project: ProjectFile = {
    version: PROJECT_FILE_VERSION,
    components: snapshot.components.map((c) => ({
      ...c,
      pinStates: { ...c.pinStates },
    })),
    wires: snapshot.wires.map((w) => ({
      ...w,
      from: { ...w.from },
      to: { ...w.to },
      bends: w.bends.map((b) => ({ ...b })),
    })),
    viewport: { ...snapshot.viewport },
  };
  if (snapshot.sketch !== undefined) {
    project.sketch = snapshot.sketch;
  }
  if (snapshot.sketchName !== undefined) {
    project.sketchName = snapshot.sketchName;
  }
  return project;
}

/** Parse and validate JSON loaded from disk. */
export function parseProjectFile(json: unknown): ProjectFile {
  if (!isRecord(json)) {
    throw new Error('Invalid project file: expected a JSON object');
  }
  if (json.version !== PROJECT_FILE_VERSION) {
    throw new Error(
      `Unsupported project version ${String(json.version)} (expected ${PROJECT_FILE_VERSION})`,
    );
  }
  if (!Array.isArray(json.components) || !Array.isArray(json.wires)) {
    throw new Error('Invalid project file: components and wires must be arrays');
  }

  const components = json.components.map(parseComponent);
  const componentIds = new Set(components.map((c) => c.id));
  const wires = json.wires.map((wire, index) => parseWire(wire, index, componentIds));
  validateWirePins(components, wires);

  const viewport = parseViewport(json.viewport);

  const project: ProjectFile = {
    version: PROJECT_FILE_VERSION,
    components,
    wires,
    viewport,
  };
  if (typeof json.sketch === 'string') {
    project.sketch = json.sketch;
  }
  if (typeof json.sketchName === 'string' && json.sketchName.trim()) {
    project.sketchName = json.sketchName.trim();
  }
  return project;
}

export function projectFileToJson(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

export function parseProjectJson(text: string): ProjectFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file');
  }
  return parseProjectFile(parsed);
}

/** Trigger a browser download of the project file. */
export function downloadProjectFile(
  project: ProjectFile,
  filename = 'arduino-circuit.json',
): void {
  const blob = new Blob([projectFileToJson(project)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Highest numeric suffix from ids like `wire_12` — keeps new ids unique after load. */
export function maxIdSuffix(components: PlacedComponent[], wires: Wire[]): number {
  let max = 0;
  for (const id of [...components.map((c) => c.id), ...wires.map((w) => w.id)]) {
    const match = id.match(/_(\d+)$/);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return max;
}

const API_BASE = '/api/user-projects';

export async function isUserProjectsApiAvailable(): Promise<boolean> {
  try {
    const res = await fetch(API_BASE);
    return res.ok;
  } catch {
    return false;
  }
}

export async function listUserProjects(): Promise<string[]> {
  const res = await fetch(API_BASE);
  if (!res.ok) {
    throw new Error('Could not list project files');
  }
  const data = (await res.json()) as { files?: string[] };
  return data.files ?? [];
}

export async function loadUserProjectFile(name: string): Promise<string> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(name)}`);
  if (!res.ok) {
    throw new Error(`Could not load "${name}"`);
  }
  return res.text();
}

export async function saveUserProjectFile(name: string, json: string): Promise<void> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: json,
  });
  if (!res.ok) {
    throw new Error(`Could not save "${name}"`);
  }
}

export function normalizeProjectFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'arduino-circuit.json';
  return trimmed.endsWith('.json') ? trimmed : `${trimmed}.json`;
}

export function projectNameFromFilename(filename: string): string {
  return filename.replace(/\.json$/i, '');
}

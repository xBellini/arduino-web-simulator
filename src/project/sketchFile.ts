/**
 * What: Client-side `.ino` filename and download helpers for the sketch editor.
 * Role: normalize names, parse uploaded source, trigger browser download — no compile.
 * Owns/exports: `normalizeSketchFilename`, `sketchNameFromFilename`, `parseInoSource`,
 * `downloadSketchFile`.
 * Conventions: empty name → `sketch.ino`; strips a first-line comment like `// folder.ino`;
 * downloads as UTF-8 plain text.
 * To wire a new export path: pass raw source + desired basename through `normalizeSketchFilename`
 * then `downloadSketchFile`.
 * To accept user uploads: run bytes through `parseInoSource` before storing in project state.
 * Not-here: compilation (`compileSketch`), templates (`sketch/templates.ts`), or project JSON schema.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `src/utils/sketchFile.ts` (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */

export function normalizeSketchFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'sketch.ino';
  const base = trimmed.replace(/\.ino$/i, '');
  return `${base}.ino`;
}

export function sketchNameFromFilename(filename: string): string {
  return filename.replace(/\.ino$/i, '') || 'sketch';
}

/** Strip optional folder-style .ino header line if present. */
export function parseInoSource(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && /^\s*\/\/\s*.+\.ino\s*$/.test(lines[0])) {
    return lines.slice(1).join('\n').trimStart();
  }
  return text.replace(/\r\n/g, '\n');
}

export function downloadSketchFile(source: string, filename: string): void {
  const name = normalizeSketchFilename(filename);
  const blob = new Blob([source], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

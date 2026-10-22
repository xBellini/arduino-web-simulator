/**
 * What: Top global command bar — project I/O, undo/redo, run/stop sim. Exports Toolbar; pulls saveProject,
 * loadProjectFromJson, undo/redo, compileAndRun, stopSimulation from SimContext. Hidden file input triggers
 * JSON import; save uses download or the user-projects API (projectFile.ts) when dev server exposes listUserProjects/loadUserProjectFile.
 * To add a global action: new button in JSX calling a SimContext method (or local handler + context API);
 * match existing .toolbar-actions patterns. Sketch/serial/hex controls live in IdePanel — not Toolbar. Circuit
 * document schema and persistence logic: store/SimContext + utils — not this strip.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Moved from `src/components/Toolbar.tsx` (tree reorganization)
# 17-10-2026 | Codex  | Toolbar Net label tool names then previews a label before placement.
# 20-10-2026 | Codex  | Automatically retain changed EEPROM locally per circuit and board across refreshes; circuit files remain explicit saves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PartLabelEditor } from './editors/PartLabelEditor';
import { useSim } from '../store/SimContext';
import {
  listUserProjects,
  loadUserProjectFile,
  normalizeProjectFilename,
  projectNameFromFilename,
} from '../project/projectFile';

export function Toolbar() {
  const {
    state,
    startNetLabelPlacement,
    cancelPlacement,
    saveProject,
    loadProjectFromJson,
    undo,
    redo,
    canUndo,
    canRedo,
    compileAndRun,
    stopSimulation,
  } = useSim();
  const [labelEditor, setLabelEditor] = useState<{ x: number; y: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [userProjectsEnabled, setUserProjectsEnabled] = useState(false);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [activeProject, setActiveProject] = useState('arduino-circuit.json');

  const refreshProjectList = useCallback(async () => {
    try {
      const files = await listUserProjects();
      setProjectFiles(files);
      return files;
    } catch {
      setProjectFiles([]);
      return [];
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await listUserProjects();
        setUserProjectsEnabled(true);
        await refreshProjectList();
      } catch {
        setUserProjectsEnabled(false);
      }
    })();
  }, [refreshProjectList]);

  const handleSave = async () => {
    const defaultName = projectNameFromFilename(activeProject);
    const input = window.prompt('Save project as', defaultName);
    if (input === null) return;

    try {
      const filename = normalizeProjectFilename(input);
      const where = await saveProject(filename);
      setActiveProject(filename);
      if (where === 'folder') {
        await refreshProjectList();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save project';
      window.alert(message);
    }
  };

  const handleLoadClick = () => {
    fileInputRef.current?.click();
  };

  const handleProjectPick = async (filename: string) => {
    if (!filename) return;
    try {
      const text = await loadUserProjectFile(filename);
      loadProjectFromJson(text, filename);
      setActiveProject(filename);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load project';
      window.alert(message);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      loadProjectFromJson(text, file.name);
      setActiveProject(file.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load project file';
      window.alert(message);
    }
  };

  return (
    <header className="toolbar">
      <div className="toolbar-brand">
        <img className="brand-icon" src="/favicon.svg" alt="" aria-hidden/>
        <span>Arduino Simulator</span>
        <span className="phase-badge phase-badge-sim">Phase 1 · AVR</span>
      </div>

      <div className="toolbar-actions">
        <button type="button" className="action-btn" aria-pressed={!!state.netLabelPlacement}
          onClick={e => { if (state.netLabelPlacement) cancelPlacement(); else setLabelEditor({ x: e.clientX, y: e.clientY }); }}
          title="Place a named electrical connection">Net label</button>
        {labelEditor && <PartLabelEditor netName footprintLabel="Net" initialLabel=""
          x={labelEditor.x} y={labelEditor.y} onClose={() => setLabelEditor(null)}
          onSave={name => { if (name) startNetLabelPlacement(name); }} />}
        {state.netLabelPlacement && <span className="wire-hint">Click to place · Snap to a pin or junction · Esc/right-click cancels</span>}
        <button
          type="button"
          className="action-btn action-btn-run"
          onClick={() => void compileAndRun()}
          disabled={state.simStatus === 'compiling' || state.simStatus === 'running'}
          title="Compile sketch and run simulation"
        >
          Run
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={stopSimulation}
          disabled={state.simStatus !== 'running' && state.simStatus !== 'compiling'}
          title="Stop simulation"
        >
          Stop
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl+Y)"
        >
          Redo
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={() => void handleSave()}
          title={
            userProjectsEnabled
              ? 'Save to user_projects folder'
              : 'Save circuit to JSON file'
          }
        >
          Save
        </button>
        {userProjectsEnabled && projectFiles.length > 0 && (
          <select
            className="project-select"
            value={activeProject}
            onChange={(e) => void handleProjectPick(e.target.value)}
            title="Open a saved project from user_projects"
          >
            {projectFiles.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="action-btn"
          onClick={handleLoadClick}
          title="Load circuit from a JSON file on disk"
        >
          Load file…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          onChange={(e) => void handleFileChange(e)}
        />

        {state.placementType && (
          <span className="wire-hint">
            Left-click to place · R rotate (Shift+R −90°) · Right-click or Esc to cancel
          </span>
        )}
        {state.wireDraft && (
          <span className="wire-hint">
            Left-click corners · Click pin to finish · Right-click or Esc to cancel
          </span>
        )}
        {state.selectedWireIds.length > 0 && !state.wireDraft && (
          <span className="wire-hint">
            Drag segments or handles · Double-click to add joint · Shift+click to multi-select · Del to delete
          </span>
        )}
        {!state.netLabelPlacement && !state.placementType && !state.wireDraft && state.selectedWireIds.length === 0 && (
          <span className="wire-hint wire-hint-subtle">
            Marquee selects parts and wires · Shift adds to selection
          </span>
        )}
      </div>
    </header>
  );
}

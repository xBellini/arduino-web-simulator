/**
 * What: Right IDE column — sketch source, build log tab, serial monitor, firmware/load helpers. Exports
 * IdePanel; SketchEditor for code; SimContext for sketchSource, compileAndRun/stop, templates, hex.
 * SerialMonitor subscribes independently to buffered serial text in simLiveStore.
 * simLiveStore subscription drives run elapsed time and live output while simStatus === 'running'. To add a
 * sketch template: register in sketch/templates and wire a menu entry in template dropdown here. To add a
 * new file import type: mirror ino/hex hidden inputs + handler calling context loader. Canvas editing,
 * palette, and ngspice overlay are SimCanvas/App — not IdePanel. Compiler/toolchain: sim/ and SimContext.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Moved from `src/components/IdePanel.tsx` (tree reorganization)
# 15-10-2026 | Codex | Isolate serial text and autoscroll in a memoized monitor subscribing to buffered output; serial batches no longer rebuild the IDE or canvas.
 */
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSim } from '../../store/SimContext';
import { getSerialOutput, subscribeSerialOutput, getSimLiveSnapshot, subscribeSimLive } from '../../store/simLiveStore';
import { ARDUINO_IDE_HEX_HINT } from '../../avr/firmware';
import { SKETCH_TEMPLATES } from './templates';
import { SketchEditor } from './SketchEditor';

type IdeTab = 'code' | 'build';

const SerialMonitor = memo(function SerialMonitor() {
  const text = useSyncExternalStore(subscribeSerialOutput, getSerialOutput, getSerialOutput);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return <pre ref={ref} className="sim-log serial-log ide-serial-log">{text || '(no output yet)'}</pre>;
});

export function IdePanel() {
  const {
    state,
    setSketchSource,
    newSketch,
    saveSketchToFile,
    loadSketchFromFile,
    applySketchTemplate,
    compileAndRun,
    stopSimulation,
    clearSerialOutput,
    loadHexFirmware,
    clearLoadedHex,
  } = useSim();

  const [tab, setTab] = useState<IdeTab>('code');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmNewSketch, setConfirmNewSketch] = useState(false);
  const hexInputRef = useRef<HTMLInputElement>(null);
  const inoInputRef = useRef<HTMLInputElement>(null);
  const templateRef = useRef<HTMLDivElement>(null);
  const runStartedAtRef = useRef(0);
  const [runElapsedSec, setRunElapsedSec] = useState(0);

  const {
    simStatus,
    simErrorMessage,
    sketchSource,
    sketchName,
    compilerOutput,
    loadedHex,
    loadedHexName,
  } = state;

  const running = simStatus === 'running';
  const busy = simStatus === 'compiling';
  const usingHex = loadedHex !== null;

  const simLiveSnap = useSyncExternalStore(
    subscribeSimLive,
    getSimLiveSnapshot,
    getSimLiveSnapshot,
  );
  const dcSolverBackend = simLiveSnap.dcSolverBackend;

  useEffect(() => {
    if (!running) {
      setRunElapsedSec(0);
      return;
    }

    runStartedAtRef.current = performance.now();
    let timer = 0;

    const tick = () => {
      setRunElapsedSec((performance.now() - runStartedAtRef.current) / 1000);
      timer = window.setTimeout(tick, 100);
    };

    timer = window.setTimeout(tick, 100);
    return () => window.clearTimeout(timer);
  }, [running]);

  const handleRun = useCallback(() => {
    void compileAndRun();
  }, [compileAndRun]);

  const handleHexPick = () => hexInputRef.current?.click();
  const handleInoPick = () => inoInputRef.current?.click();

  const handleHexFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const err = loadHexFirmware(text, file.name);
      if (err) {
        setFileError(err);
        setTab('build');
        return;
      }
      setFileError(null);
      setTab('build');
    } catch {
      setFileError('Could not read the selected file.');
      setTab('build');
    }
  };

  const handleInoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      loadSketchFromFile(text, file.name);
      setFileError(null);
      setTab('code');
    } catch {
      setFileError('Could not read the selected sketch.');
    }
  };

  const handleNewSketch = () => {
    if (sketchSource.trim()) {
      setConfirmNewSketch(true);
      return;
    }
    newSketch();
    setTab('code');
    setFileError(null);
  };

  const confirmNewSketchAction = () => {
    newSketch();
    setTab('code');
    setFileError(null);
    setConfirmNewSketch(false);
  };

  const handleTemplate = (id: string) => {
    applySketchTemplate(id);
    setTemplateOpen(false);
    setTab('code');
  };

  useEffect(() => {
    if (simStatus === 'error') {
      setTab('build');
    }
  }, [simStatus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tab !== 'code' || usingHex) return;
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return;
      e.preventDefault();
      if (!busy && !running) handleRun();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, usingHex, busy, running, handleRun]);

  useEffect(() => {
    if (!templateOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (templateRef.current && !templateRef.current.contains(e.target as Node)) {
        setTemplateOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [templateOpen]);

  return (
    <aside className="sim-panel ide-panel" aria-label="Sketch IDE">
      <input
        ref={hexInputRef}
        type="file"
        accept=".hex,.HEX"
        className="sr-only"
        onChange={(e) => void handleHexFile(e)}
        aria-hidden
        tabIndex={-1}
      />
      <input
        ref={inoInputRef}
        type="file"
        accept=".ino,.txt"
        className="sr-only"
        onChange={(e) => void handleInoFile(e)}
        aria-hidden
        tabIndex={-1}
      />

      <div className="sim-panel-header">
        <h2 className="sim-panel-title">Sketch IDE</h2>
        <div className="sim-panel-status-stack">
          <span className={`sim-status sim-status-${simStatus}`}>
            {simStatus === 'idle' && 'Stopped'}
            {simStatus === 'compiling' && (usingHex ? 'Loading HEX…' : 'Compiling…')}
            {simStatus === 'running' && `Running · ${runElapsedSec.toFixed(2)}s`}
            {simStatus === 'error' && 'Error'}
          </span>
          {running &&
            (dcSolverBackend === 'ngspice' ? (
              <span className="sim-solver-badge sim-solver-badge-ngspice">
                ngspice solver
              </span>
            ) : (
              <span className="sim-solver-badge sim-solver-badge-legacy">
                legacy DC solver
              </span>
            ))}
        </div>
      </div>

      <div className="ide-sketch-bar">
        <span className="ide-sketch-name" title={sketchName}>
          {sketchName}.ino
        </span>
        {usingHex ? (
          <span className="ide-sketch-mode ide-sketch-mode-hex">External HEX</span>
        ) : (
          <span className="ide-sketch-mode">In-app sketch</span>
        )}
      </div>

      {(simErrorMessage || fileError) && (
        <div className="ide-error-banner" role="alert">
          {simErrorMessage || fileError}
        </div>
      )}

      {confirmNewSketch && (
        <div className="ide-confirm-banner">
          <span>Start a new sketch? Unsaved editor changes will be lost.</span>
          <div className="ide-confirm-actions">
            <button
              type="button"
              className="sim-btn sim-btn-run"
              onClick={confirmNewSketchAction}
            >
              New sketch
            </button>
            <button
              type="button"
              className="sim-btn"
              onClick={() => setConfirmNewSketch(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="ide-workflow-hint">
        Write simple sketches here. For libraries, multiple files, or larger projects, use{' '}
        <strong>Arduino IDE</strong> and import the compiled <strong>.hex</strong>.
      </p>

      {usingHex && loadedHexName && (
        <div className="sim-firmware-banner">
          <span className="sim-firmware-label" title={loadedHexName}>
            HEX: {loadedHexName}
          </span>
          <button
            type="button"
            className="sim-firmware-clear"
            onClick={clearLoadedHex}
            disabled={running || busy}
            title="Switch back to in-app sketch IDE"
          >
            Use sketch
          </button>
        </div>
      )}

      <div className="ide-file-toolbar">
        <button
          type="button"
          className="sim-btn"
          onClick={handleNewSketch}
          disabled={running || busy}
          title="New blank sketch"
        >
          New
        </button>
        <button
          type="button"
          className="sim-btn"
          onClick={handleInoPick}
          disabled={running || busy}
          title="Open .ino file"
        >
          Open
        </button>
        <button
          type="button"
          className="sim-btn"
          onClick={saveSketchToFile}
          disabled={running || usingHex}
          title="Save sketch as .ino"
        >
          Save
        </button>
        <div className="ide-template-wrap" ref={templateRef}>
          <button
            type="button"
            className="sim-btn"
            onClick={() => setTemplateOpen((o) => !o)}
            disabled={running || busy || usingHex}
            aria-expanded={templateOpen}
            title="Load a starter template"
          >
            Template ▾
          </button>
          {templateOpen && (
            <div className="ide-template-menu" role="menu">
              {SKETCH_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  className="ide-template-item"
                  onClick={() => handleTemplate(t.id)}
                >
                  <span className="ide-template-label">{t.label}</span>
                  <span className="ide-template-desc">{t.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="sim-toolbar">
        <button
          type="button"
          className="sim-btn sim-btn-run"
          onClick={handleRun}
          disabled={busy || running}
          title={usingHex ? 'Run loaded HEX firmware' : 'Compile sketch and run'}
        >
          Run
        </button>
        <button
          type="button"
          className="sim-btn"
          onClick={stopSimulation}
          disabled={!running && !busy}
        >
          Stop
        </button>
        <button
          type="button"
          className="sim-btn ide-btn-import"
          onClick={handleHexPick}
          disabled={running || busy}
          title={ARDUINO_IDE_HEX_HINT}
        >
          Import .hex
        </button>
        <button
          type="button"
          className="sim-btn sim-btn-ghost"
          onClick={clearSerialOutput}
          title="Clear serial and build log"
        >
          Clear log
        </button>
      </div>

      <div className="sim-tabs" role="tablist">
        {(
          [
            ['code', 'Code'],
            ['build', 'Build'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`sim-tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="ide-main">
        <div className="ide-editor-pane">
          {tab === 'code' && (
            <>
              {usingHex ? (
                <div className="ide-hex-overlay">
                  <p>
                    Running firmware from <strong>{loadedHexName}</strong>. Click{' '}
                    <strong>Use sketch</strong> to edit in the IDE again.
                  </p>
                </div>
              ) : null}
              <SketchEditor
                value={sketchSource}
                onChange={setSketchSource}
                disabled={running}
                readOnly={usingHex}
                aria-label="Arduino sketch source"
              />
            </>
          )}
          {tab === 'build' && (
            <pre className="sim-log compiler-log">
              {compilerOutput || '(build output appears here after Run)'}
            </pre>
          )}
        </div>

        <div className="ide-serial-pane">
          <div className="ide-serial-header">
            <span>Serial monitor</span>
            <span className="ide-serial-meta">9600 baud</span>
          </div>
          <SerialMonitor />
        </div>
      </div>

      <p className="sim-panel-foot">
        Simple sketches compile via Wokwi Hexi · Ctrl+Enter to run · Sketch saved with circuit
        project
      </p>
    </aside>
  );
}

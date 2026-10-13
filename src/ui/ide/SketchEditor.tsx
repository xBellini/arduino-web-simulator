/**
 * What: Controlled textarea + line-number gutter for Arduino sketch text. Exports SketchEditor; props value/
 * onChange, optional disabled/readOnly, aria-label. Tab inserts two spaces; gutter scroll syncs to textarea
 * scrollTop. Parent (IdePanel) owns sketchSource via SimContext — this component is presentational only. To
 * change editor chrome (font, colors): index.css .sketch-editor* rules. To add lint/autocomplete: extend here
 * or swap editor — keep onChange contract. Compile, serial, and sim run: IdePanel/SimContext — not SketchEditor.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 09-10-2026 | Cursor | Moved from `src/components/SketchEditor.tsx` (tree reorganization)
 */
import { useCallback, useEffect, useRef } from 'react';

interface SketchEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  'aria-label'?: string;
}

export function SketchEditor({
  value,
  onChange,
  disabled = false,
  readOnly = false,
  'aria-label': ariaLabel = 'Arduino sketch',
}: SketchEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);

  const lineCount = Math.max(1, value.split('\n').length);

  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const gutter = gutterRef.current;
    if (ta && gutter) {
      gutter.scrollTop = ta.scrollTop;
    }
  }, []);

  useEffect(() => {
    syncScroll();
  }, [value, syncScroll]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || readOnly || disabled) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = `${value.slice(0, start)}  ${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + 2;
    });
  };

  return (
    <div className={`sketch-editor-shell${disabled || readOnly ? ' sketch-editor-readonly' : ''}`}>
      <pre ref={gutterRef} className="sketch-editor-gutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <span key={i} className="sketch-editor-line-num">
            {i + 1}
          </span>
        ))}
      </pre>
      <textarea
        ref={textareaRef}
        className="sketch-editor-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        disabled={disabled}
        readOnly={readOnly}
        aria-label={ariaLabel}
        wrap="off"
      />
    </div>
  );
}

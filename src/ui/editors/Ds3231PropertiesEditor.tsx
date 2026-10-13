/**
 * What: Floating portal editor for DS3231 RTC module properties — primarily the 7-bit
 * I2C address the sim ACKs on (default 0x68) so Wire / RTC libraries can match.
 * Exports Ds3231PropertiesEditor; onSave receives `{ rtcI2cAddr }`. Screen-anchored
 * x/y + useClampToViewport; same dismiss pattern as LedPropertiesEditor (outside
 * pointer, Escape). SimCanvas mounts it for type `ds3231_rtc`. EEPROM address is
 * fixed at 0x57 and is not edited here.
 *
# Changelog
# Date       | Author | Remarks
# 12-10-2026 | Cursor | Changelog creation / RTC I2C address editor
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClampToViewport } from './popup';
import {
  DS3231_I2C_ADDR,
  RTC_I2C_ADDR_MAX,
  RTC_I2C_ADDR_MIN,
  parseRtcI2cAddr,
} from '../../components/modules/ds3231Rtc';

export interface Ds3231PropertiesPatch {
  rtcI2cAddr: number;
}

interface Ds3231PropertiesEditorProps {
  x: number;
  y: number;
  initialRtcI2cAddr: number;
  onSave: (patch: Ds3231PropertiesPatch) => void;
  onClose: () => void;
}

function formatHexAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`;
}

export function Ds3231PropertiesEditor({
  x,
  y,
  initialRtcI2cAddr,
  onSave,
  onClose,
}: Ds3231PropertiesEditorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useClampToViewport(panelRef, x, y);
  const onCloseRef = useRef(onClose);
  const onSaveRef = useRef(onSave);

  const [addrText, setAddrText] = useState(
    formatHexAddr(initialRtcI2cAddr || DS3231_I2C_ADDR),
  );
  const [error, setError] = useState<string | null>(null);

  onCloseRef.current = onClose;
  onSaveRef.current = onSave;

  useEffect(() => {
    const isInsidePanel = (target: EventTarget | null) => {
      const panel = panelRef.current;
      if (!panel || !target) return false;
      return panel.contains(target as Node);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (isInsidePanel(e.target)) return;
      onCloseRef.current();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const trySave = () => {
    const addr = parseRtcI2cAddr(addrText);
    if (addr === null) {
      setError(
        `Address must be 7-bit hex ${formatHexAddr(RTC_I2C_ADDR_MIN)}–${formatHexAddr(RTC_I2C_ADDR_MAX)}`,
      );
      return;
    }
    onSaveRef.current({ rtcI2cAddr: addr });
    onCloseRef.current();
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    trySave();
  };

  return createPortal(
    <div
      ref={panelRef}
      className="resistor-value-editor"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="DS3231 RTC properties"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="resistor-value-editor-title">DS3231 RTC properties</div>
      <form className="resistor-value-editor-form" onSubmit={onSubmit}>
        <label className="resistor-value-editor-row">
          <span className="resistor-value-editor-label">RTC I2C address</span>
          <span className="resistor-value-editor-field-group">
            <input
              type="text"
              inputMode="text"
              className="resistor-value-editor-input"
              value={addrText}
              onChange={(e) => {
                setAddrText(e.target.value);
                if (error) setError(null);
              }}
              aria-label="RTC I2C address"
              spellCheck={false}
              autoComplete="off"
            />
          </span>
        </label>
        <p className="resistor-value-editor-hint" style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', opacity: 0.75 }}>
          Default {formatHexAddr(DS3231_I2C_ADDR)}. Sketch / library must use the same address.
        </p>

        {error && <div className="resistor-value-editor-error">{error}</div>}
        <div className="resistor-value-editor-actions">
          <button type="button" className="resistor-value-editor-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="resistor-value-editor-btn primary">
            Apply
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

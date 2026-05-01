import { CSSProperties, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { memuExtras } from 'utils/context-extra';
import { cancelMemorize } from 'utils/network';
import { MemuTaskStatus } from 'utils/types';

const containerStyle: CSSProperties = {
  position: 'fixed',
  bottom: 16,
  right: 16,
  zIndex: 10000,
  background: 'var(--SmartThemeBlurTintColor, #1a1a2e)',
  border: '1px solid var(--SmartThemeBorderColor, #444)',
  borderRadius: 8,
  padding: '10px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 13,
  color: 'var(--SmartThemeBodyColor, #ccc)',
  boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
  minWidth: 180,
};

const barOuter: CSSProperties = {
  flex: 1,
  height: 4,
  background: 'var(--SmartThemeBorderColor, #444)',
  borderRadius: 2,
  minWidth: 60,
  overflow: 'hidden',
};

const cancelBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--SmartThemeBodyColor, #ccc)',
  cursor: 'pointer',
  fontSize: 14,
  padding: '0 2px',
  opacity: 0.7,
};

export default function MemorizeProgress(): JSX.Element | null {
  const [tick, setTick] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [sawNumericProgress, setSawNumericProgress] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  void tick;
  const summary = memuExtras.summary;
  if (!summary) return null;
  const status = summary.summaryTaskStatus;
  const progress = summary.progress;
  useEffect(() => {
    const active = status === MemuTaskStatus.PENDING || status === MemuTaskStatus.PROCESSING;
    if (!active) {
      setCancelling(false);
      setSawNumericProgress(false);
      return;
    }
    if (progress && progress.total > 0) {
      setSawNumericProgress(true);
    }
  }, [status, progress?.current, progress?.total]);

  if (status !== MemuTaskStatus.PENDING && status !== MemuTaskStatus.PROCESSING) {
    return null;
  }

  const inConsolidationPhase = !cancelling && !progress && sawNumericProgress;
  const label = cancelling
    ? 'Cancelling...'
    : inConsolidationPhase
      ? 'Finalizing...'
      : progress
      ? `Memorizing... (${progress.current}/${progress.total})`
      : 'Memorizing...';
  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  async function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    const info = memuExtras.baseInfo;
    if (!info) return;
    await cancelMemorize(info.userId, info.characterId);
  }

  return createPortal(
    <div style={containerStyle}>
      <span>{label}</span>
      {!cancelling && progress && progress.total > 0 && (
        <div style={barOuter}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--SmartThemeQuoteColor, #6a9fb5)', borderRadius: 2, transition: 'width 0.3s' }} />
        </div>
      )}
      {!cancelling && (
        <button type="button" style={cancelBtn} onClick={() => void handleCancel()}>
          Cancel
        </button>
      )}
    </div>,
    document.body,
  );
}

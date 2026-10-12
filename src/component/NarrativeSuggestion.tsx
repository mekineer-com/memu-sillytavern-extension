import { CSSProperties, useState } from 'react';
import { sendNarrativeSuggestion } from 'utils/network';
import { memuExtras, st } from 'utils/context-extra';
import { currentScope, isMemuActive, refreshSoulCard } from 'memory/utils';

const LS_LAST_SENT = 'memu-narrative-suggestion-last';
const LS_COOLDOWN_UNTIL = 'memu-narrative-suggestion-cooldown-until';
const COOLDOWN_MS = 10 * 60 * 1000;

function isCoolingDown(): boolean {
  const until = Number(localStorage.getItem(LS_COOLDOWN_UNTIL) || 0);
  return Date.now() < until;
}

type Status = 'idle' | 'pending' | 'ok' | 'err';

export default function NarrativeSuggestion({ enabled = false }: { enabled?: boolean }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [lastSent, setLastSent] = useState<string>(() => localStorage.getItem(LS_LAST_SENT) ?? '');
  const coolingDown = isCoolingDown();

  async function handleSend() {
    const scope = currentScope();
    const suggestion = text.trim();
    if (!suggestion || coolingDown) return;
    try {
      if (!(await isMemuActive()) || currentScope() !== scope) return;
      const ctx = st.getContext();
      const userId = memuExtras.baseInfo?.userId ?? '';
      const soulId = String(ctx.characters?.[ctx.characterId]?.name || '').trim();
      if (!userId || !soulId) throw new Error('Select a soul before sending a suggestion.');
      setStatus('pending');
      setError('');
      await sendNarrativeSuggestion(userId, soulId, suggestion);
      localStorage.setItem(LS_LAST_SENT, suggestion);
      localStorage.setItem(LS_COOLDOWN_UNTIL, String(Date.now() + COOLDOWN_MS));
      setLastSent(suggestion);
      setText('');
      setStatus(currentScope() === scope ? 'ok' : 'idle');
      if (currentScope() !== scope) return;
      try {
        await refreshSoulCard();
      } catch (error) {
        window.alert(`Suggestion considered, but ST card refresh failed: ${String(error)}`);
      } finally {
        if (currentScope() !== scope) setStatus('idle');
      }
    } catch (error) {
      if (currentScope() === scope) {
        setError(String(error));
        setStatus('err');
      } else {
        setStatus('idle');
      }
    }
  }

  const statusIcon =
    status === 'pending' ? <i className="fa-solid fa-spinner fa-spin" style={{ color: 'var(--SmartThemeEmColor)' }} /> :
    status === 'ok'      ? <i className="fa-solid fa-check"   style={{ color: '#4caf50' }} /> :
    status === 'err'     ? <span style={{ color: '#e53935' }}>!</span> :
    null;

  const rowStyle: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 24 }}>
      <div style={rowStyle}>
        <input
          type="text"
          className="text_pole"
          style={{ flex: 1 }}
          value={text}
          onChange={(e) => { setText(e.target.value); setStatus('idle'); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSend(); }}
          placeholder="e.g. more poetic, shorter replies…"
          disabled={!enabled || status === 'pending'}
        />
        <button
          type="button"
          className="menu_button"
          onClick={() => void handleSend()}
          disabled={!enabled || !text.trim() || coolingDown || status === 'pending'}
        >
          Send
        </button>
        <span title={status === 'err' ? error : status === 'ok' ? 'Suggestion considered, not necessarily adopted.' : undefined} aria-label={status === 'err' ? error : undefined} style={{ width: 18, display: 'flex', alignItems: 'center' }}>{statusIcon}</span>
      </div>
      {lastSent && (
        <small style={{ opacity: 0.75 }}>Last sent: {lastSent}</small>
      )}
    </div>
  );
}

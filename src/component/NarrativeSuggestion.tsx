import { CSSProperties, useState } from 'react';
import { sendNarrativeSuggestion } from 'utils/network';
import { memuExtras, st } from 'utils/context-extra';
import { getCsrfTokenCached } from 'utils/csrf';

const LS_LAST_SENT = 'memu-narrative-suggestion-last';
const LS_COOLDOWN_UNTIL = 'memu-narrative-suggestion-cooldown-until';
const COOLDOWN_MS = 10 * 60 * 1000;

function lsLastWrittenKey(characterName: string): string {
  return `memu-narrative-last-written-${characterName}`;
}

function isCoolingDown(): boolean {
  const until = Number(localStorage.getItem(LS_COOLDOWN_UNTIL) || 0);
  return Date.now() < until;
}

async function writeDescriptionToCard(characterName: string, narrativeSelf: string): Promise<void> {
  const ctx = st.getContext() as any;
  const character = ctx?.characters?.[ctx?.characterId];
  if (!character?.avatar) throw new Error('No active character');

  const csrfToken = await getCsrfTokenCached();
  const resp = await fetch('/api/characters/edit-attribute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({
      avatar_url: character.avatar,
      ch_name: character.name,
      field: 'description',
      value: narrativeSelf,
    }),
  });
  if (!resp.ok) throw new Error(`edit-attribute failed: ${resp.status}`);

  // Refresh in-memory character so the rest of the UI sees the new value.
  await (ctx.getOneCharacter as (url: string) => Promise<void>)(character.avatar);

  localStorage.setItem(lsLastWrittenKey(characterName), narrativeSelf);
}

function getOverrideState(characterName: string): boolean {
  const lastWritten = localStorage.getItem(lsLastWrittenKey(characterName));
  if (!lastWritten) return false; // first-time: no override
  const ctx = st.getContext() as any;
  const currentDesc = String(ctx?.characters?.[ctx?.characterId]?.description ?? '');
  return currentDesc !== lastWritten;
}

type Status = 'idle' | 'pending' | 'ok' | 'err';

export default function NarrativeSuggestion() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [lastSent, setLastSent] = useState<string>(() => localStorage.getItem(LS_LAST_SENT) ?? '');
  const coolingDown = isCoolingDown();

  const characterName = memuExtras.baseInfo?.characterName ?? '';
  const overrideActive = characterName ? getOverrideState(characterName) : false;

  async function handleSend() {
    const suggestion = text.trim();
    if (!suggestion || coolingDown || overrideActive) return;

    const userId = memuExtras.baseInfo?.userId ?? '';
    const soulId = characterName;
    if (!userId || !soulId) {
      setStatus('err');
      return;
    }

    setStatus('pending');
    try {
      const result = await sendNarrativeSuggestion(userId, soulId, suggestion);
      localStorage.setItem(LS_LAST_SENT, suggestion);
      localStorage.setItem(LS_COOLDOWN_UNTIL, String(Date.now() + COOLDOWN_MS));
      setLastSent(suggestion);
      setText('');

      if (result.narrative_self) {
        await writeDescriptionToCard(soulId, result.narrative_self);
      }

      setStatus('ok');
    } catch {
      setStatus('err');
    }
  }

  const statusIcon =
    status === 'pending' ? <i className="fa-solid fa-spinner fa-spin" style={{ color: 'var(--SmartThemeEmColor)' }} /> :
    status === 'ok'      ? <i className="fa-solid fa-check"   style={{ color: '#4caf50' }} /> :
    status === 'err'     ? <i className="fa-solid fa-xmark"   style={{ color: '#e53935' }} /> :
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
          disabled={status === 'pending'}
        />
        <button
          type="button"
          className="menu_button"
          onClick={() => void handleSend()}
          disabled={!text.trim() || coolingDown || overrideActive || status === 'pending'}
        >
          Send
        </button>
        <span style={{ width: 18, display: 'flex', alignItems: 'center' }}>{statusIcon}</span>
      </div>
      {overrideActive && (
        <small style={{ opacity: 0.85, color: 'var(--SmartThemeWarnColor, #e6a817)' }}>
          Manual override active — soul can't update narrative_self until card matches last written value
        </small>
      )}
      {lastSent && !overrideActive && (
        <small style={{ opacity: 0.75 }}>Last sent: {lastSent}</small>
      )}
    </div>
  );
}

/**
 * memU Inspect Panel — renders alongside Prompt Inspector's popup.
 *
 * Watches for PI's popup in the DOM (via MutationObserver). When it appears,
 * injects a collapsible memU section showing the last retrieve response:
 * prior context, retrieved items with scores, categories.
 */

export type InspectData = {
    timestamp: number;
    query?: string;
    workingNote?: string;
    memoryCache?: string[];
    intentions?: Array<{ text: string; priority?: number; active?: boolean; ephemeral?: boolean }>;
    status?: 'pending' | 'ok' | 'error';
    error?: string;
    userId?: string;
    soulId?: string;
    categories?: Array<{ name: string; score: number; summary?: string }>;
    items?: Array<{ summary: string; score: number; memory_type: string; id?: string }>;
    resources?: any[];
    method?: string;
    conversationId?: string;
    turnStatus?: 'pending' | 'ok' | 'error';
    turnError?: string;
    turnContract?: any;
    turnPrompt?: string;
    turnSystemPrompt?: string;
};

let _lastInspectData: InspectData | null = null;

export function stashInspectData(data: InspectData): void {
    _lastInspectData = data;
    scheduleRefresh();
}

export function getInspectData(): InspectData | null {
    return _lastInspectData;
}

function renderInspectHtml(data: InspectData): string {
    const parts: string[] = [];
    const status = data.status || (data.error ? 'error' : 'ok');

    parts.push(`<div style="font-family:monospace;font-size:12px;max-height:300px;overflow:auto;pointer-events:auto;user-select:text;overscroll-behavior:contain;position:relative;z-index:5;padding:8px;background:rgba(0,0,0,0.15);border-radius:6px;margin-top:8px;border:1px solid rgba(128,128,128,0.3)">`);
    parts.push(`<div style="font-weight:bold;margin-bottom:6px;color:#7dcaf7">memU Inspect</div>`);

    const cats = data.categories || [];
    const items = data.items || [];
    const resources = Array.isArray(data.resources) ? data.resources : [];

    parts.push(`<div style="margin-bottom:6px"><b>Retrieve:</b> status=${esc(status)} categories=${cats.length} items=${items.length} resources=${resources.length}</div>`);

    if (status === 'error') {
        const err = String(data.error || 'unknown error');
        parts.push(`<div style="margin-bottom:6px;color:#ff9d9d"><b>Retrieve Error</b></div>`);
        parts.push(`<pre style="white-space:pre-wrap;font-size:11px;max-height:160px;overflow:auto;margin:4px 0;padding:4px;background:rgba(0,0,0,0.1);border-radius:4px;color:#ffb6b6">${esc(err)}</pre>`);
    } else if (status === 'pending') {
        parts.push(`<div style="opacity:0.7">(retrieve pending; waiting for prompt build)</div>`);
    } else if (cats.length === 0 && items.length === 0 && resources.length === 0) {
        parts.push(`<div style="opacity:0.7">(retrieve returned 0 items/categories)</div>`);
    }

    if (data.turnStatus === 'pending') {
        parts.push(`<div style="opacity:0.75">(turn pending)</div>`);
    } else if (data.turnStatus === 'error') {
        const err = String(data.turnError || 'unknown error');
        parts.push(`<div style="margin-bottom:6px;color:#ff9d9d"><b>Turn Error</b></div>`);
        parts.push(`<pre style="white-space:pre-wrap;font-size:11px;max-height:160px;overflow:auto;margin:4px 0;padding:4px;background:rgba(0,0,0,0.1);border-radius:4px;color:#ffb6b6">${esc(err)}</pre>`);
    } else if (data.turnStatus === 'ok') {
        parts.push(`<details style="margin-bottom:6px"><summary style="cursor:pointer"><b>Turn Contract</b></summary>`);
        if (data.turnContract) {
            parts.push(`<pre style="white-space:pre-wrap;font-size:11px;max-height:180px;overflow:auto;margin:4px 0;padding:4px;background:rgba(0,0,0,0.1);border-radius:4px">${esc(JSON.stringify(data.turnContract, null, 2))}</pre>`);
        } else {
            parts.push(`<div style="opacity:0.7">(no contract returned)</div>`);
        }
        parts.push(`</details>`);
        const sp = String(data.turnSystemPrompt || '');
        const up = String(data.turnPrompt || '');
        parts.push(`<div style="opacity:0.75">turn prompt chars: user=${up.length} system=${sp.length}</div>`);
        if (sp) {
            parts.push(`<details style="margin-bottom:6px"><summary style="cursor:pointer"><b>Turn System Prompt</b></summary>`);
            parts.push(`<pre style="white-space:pre-wrap;font-size:11px;max-height:220px;overflow:auto;margin:4px 0;padding:4px;background:rgba(0,0,0,0.1);border-radius:4px">${esc(sp)}</pre>`);
            parts.push(`</details>`);
        }
        if (up) {
            parts.push(`<details style="margin-bottom:6px"><summary style="cursor:pointer"><b>Turn User Prompt</b></summary>`);
            parts.push(`<pre style="white-space:pre-wrap;font-size:11px;max-height:220px;overflow:auto;margin:4px 0;padding:4px;background:rgba(0,0,0,0.1);border-radius:4px">${esc(up)}</pre>`);
            parts.push(`</details>`);
        }
    }

    // Timestamp (fixed point in time; avoid constantly changing age text that forces rerenders)
    const ts = Number.isFinite(data.timestamp) ? new Date(data.timestamp) : null;
    const stamp = ts ? ts.toLocaleTimeString() : '?';
    parts.push(`<div style="opacity:0.5;font-size:10px;margin-top:4px">${stamp} · ${data.method || 'rag'} · ${data.conversationId || '?'}</div>`);
    if (data.userId || data.soulId) {
        parts.push(`<div style="opacity:0.55;font-size:10px">scope: user=${esc(data.userId || '?')} soul=${esc(data.soulId || '?')}</div>`);
    }

    parts.push(`</div>`);
    return parts.join('');
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PANEL_CLASS = 'memu-inspect-panel';

function currentInspectData(): InspectData {
    return _lastInspectData ?? { timestamp: Date.now() };
}

function ensurePanel(parent: Element): HTMLDivElement {
    let panel = parent.querySelector(`.${PANEL_CLASS}`) as HTMLDivElement | null;
    if (!panel) {
        panel = document.createElement('div');
        panel.className = PANEL_CLASS;
    }
    return panel;
}

function isVisible(el: Element | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.offsetParent !== null || cs.position === 'fixed';
}

function injectIntoLegacyPopup(popupEl: Element): void {
    const textarea = popupEl.querySelector('#inspectPrompt');
    const target = textarea?.parentElement || popupEl.querySelector('.popup-content') || popupEl;
    const panel = ensurePanel(target);
    const html = renderInspectHtml(currentInspectData());
    if (panel.innerHTML !== html) {
        panel.innerHTML = html;
    }
    if (!panel.parentElement) target.appendChild(panel);
}

export function isInspectUiVisible(): boolean {
    const legacyPopup = document.querySelector('.popup');
    return !!(legacyPopup && legacyPopup.querySelector('#inspectPrompt') && isVisible(legacyPopup));
}

function refreshInspectPanels(): void {
    const legacyPopup = document.querySelector('.popup');
    if (legacyPopup && legacyPopup.querySelector('#inspectPrompt')) {
        injectIntoLegacyPopup(legacyPopup);
    }
}

let _observer: MutationObserver | null = null;
let _refreshQueued = false;

function scheduleRefresh(): void {
    if (_refreshQueued) return;
    _refreshQueued = true;
    window.requestAnimationFrame(() => {
        _refreshQueued = false;
        refreshInspectPanels();
    });
}

export function startInspectObserver(): void {
    if (_observer) return;

    const nodeHasRelevantTarget = (node: Node): boolean => {
        if (!(node instanceof Element)) return false;
        if (node.id === 'inspectPrompt') return true;
        if (node.classList.contains('popup')) return true;
        return !!node.querySelector?.('#inspectPrompt,.popup');
    };

    _observer = new MutationObserver((mutations) => {
        let changed = false;
        for (const m of mutations) {
            for (const n of Array.from(m.addedNodes || [])) {
                if (nodeHasRelevantTarget(n)) { changed = true; break; }
            }
            if (changed) break;
            for (const n of Array.from(m.removedNodes || [])) {
                if (nodeHasRelevantTarget(n)) { changed = true; break; }
            }
            if (changed) break;
        }
        if (!changed) return;
        scheduleRefresh();
    });
    const root = document.body || document.documentElement;
    _observer.observe(root, { childList: true, subtree: true });
    scheduleRefresh();
}

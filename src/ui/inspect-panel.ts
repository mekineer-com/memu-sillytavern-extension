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
    status?: 'pending' | 'ok' | 'error';
    error?: string;
    userId?: string;
    soulId?: string;
    categories?: Array<{ name: string; score: number; summary?: string }>;
    items?: Array<{ summary: string; score: number; memory_type: string; id?: string }>;
    resources?: any[];
    method?: string;
    conversationId?: string;
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

    parts.push(`<div style="font-family:monospace;font-size:12px;max-height:300px;overflow-y:auto;padding:8px;background:rgba(0,0,0,0.15);border-radius:6px;margin-top:8px;border:1px solid rgba(128,128,128,0.3)">`);
    parts.push(`<div style="font-weight:bold;margin-bottom:6px;color:#7dcaf7">memU Inspect</div>`);

    // Query
    if (data.query) {
        parts.push(`<div style="margin-bottom:6px"><b>Query:</b> ${esc(data.query)}</div>`);
    }

    // Prior context
    if (data.workingNote) {
        parts.push(`<details style="margin-bottom:6px"><summary style="cursor:pointer"><b>Prior Context</b> (${data.workingNote.length} chars)</summary>`);
        parts.push(`<pre style="white-space:pre-wrap;font-size:11px;max-height:150px;overflow-y:auto;margin:4px 0;padding:4px;background:rgba(0,0,0,0.1);border-radius:4px">${esc(data.workingNote)}</pre>`);
        parts.push(`</details>`);
    }

    // Categories
    const cats = data.categories || [];
    if (cats.length > 0) {
        parts.push(`<details style="margin-bottom:6px"><summary style="cursor:pointer"><b>Categories</b> (${cats.length})</summary>`);
        for (const cat of cats) {
            parts.push(`<div style="margin:2px 0;padding-left:8px">${esc(cat.name)} <span style="opacity:0.7">score=${cat.score.toFixed(3)}</span></div>`);
        }
        parts.push(`</details>`);
    }

    // Items
    const items = data.items || [];
    if (items.length > 0) {
        parts.push(`<details open style="margin-bottom:6px"><summary style="cursor:pointer"><b>Retrieved Items</b> (${items.length})</summary>`);
        for (const item of items) {
            parts.push(`<div style="margin:3px 0;padding-left:8px;border-left:2px solid rgba(125,202,247,0.4)">`);
            parts.push(`<span style="opacity:0.6">[${esc(item.memory_type)}]</span> `);
            parts.push(`<span style="opacity:0.7">score=${item.score.toFixed(4)}</span><br>`);
            parts.push(`${esc(item.summary)}`);
            parts.push(`</div>`);
        }
        parts.push(`</details>`);
    }

    if (status === 'error') {
        const err = (data.error || 'unknown error').slice(0, 240);
        parts.push(`<div style="opacity:0.9;color:#ff9d9d">(retrieve failed: ${esc(err)})</div>`);
    } else if (status === 'pending' && cats.length === 0 && items.length === 0 && !data.workingNote) {
        parts.push(`<div style="opacity:0.7">(retrieve pending; waiting for prompt build)</div>`);
    } else if (cats.length === 0 && items.length === 0 && !data.workingNote && !data.query) {
        parts.push(`<div style="opacity:0.6">(no data from last retrieve)</div>`);
    } else if (cats.length === 0 && items.length === 0 && data.query) {
        parts.push(`<div style="opacity:0.7">(retrieve returned 0 items/categories)</div>`);
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

function injectIntoPromptManagerInspect(): boolean {
    const popup = document.getElementById('completion_prompt_manager_popup');
    const inspectArea = document.getElementById('completion_prompt_manager_popup_inspect');
    const inspectList = document.getElementById('completion_prompt_manager_popup_entry_form_inspect_list');
    if (!popup || !inspectArea || !inspectList) return false;

    const popupOpen = popup.classList.contains('openDrawer') || isVisible(popup);
    const inspectOpen = isVisible(inspectArea) && (inspectArea as HTMLElement).style.display !== 'none';
    if (!popupOpen || !inspectOpen) return false;

    const panel = ensurePanel(inspectArea);
    const html = renderInspectHtml(currentInspectData());
    if (panel.innerHTML !== html) {
        panel.innerHTML = html;
    }
    if (!panel.parentElement) {
        inspectList.insertAdjacentElement('afterend', panel);
    } else if (panel.previousElementSibling !== inspectList) {
        inspectList.insertAdjacentElement('afterend', panel);
    }
    return true;
}

function refreshInspectPanels(): void {
    injectIntoPromptManagerInspect();
    const legacyPopup = document.querySelector('.popup');
    if (legacyPopup && legacyPopup.querySelector('#inspectPrompt')) {
        injectIntoLegacyPopup(legacyPopup);
    }
}

let _observer: MutationObserver | null = null;
let _promptObserver: MutationObserver | null = null;
let _refreshQueued = false;

function scheduleRefresh(): void {
    if (_refreshQueued) return;
    _refreshQueued = true;
    window.requestAnimationFrame(() => {
        _refreshQueued = false;
        refreshInspectPanels();
    });
}

function attachPromptVisibilityObserver(): boolean {
    if (_promptObserver) {
        _promptObserver.disconnect();
        _promptObserver = null;
    }

    const targets: Element[] = [];
    const popup = document.getElementById('completion_prompt_manager_popup');
    const inspectArea = document.getElementById('completion_prompt_manager_popup_inspect');
    if (popup) targets.push(popup);
    if (inspectArea) targets.push(inspectArea);

    const legacyPopup = document.querySelector('.popup');
    if (legacyPopup && legacyPopup.querySelector('#inspectPrompt')) {
        targets.push(legacyPopup);
    }
    if (targets.length === 0) return false;

    _promptObserver = new MutationObserver(() => {
        scheduleRefresh();
    });
    for (const target of targets) {
        _promptObserver.observe(target, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    return true;
}

export function startInspectObserver(): void {
    if (_observer) return;

    // Keep a tiny observer only for hard re-mounts of prompt manager root nodes.
    _observer = new MutationObserver(() => {
        attachPromptVisibilityObserver();
        scheduleRefresh();
    });
    const root = document.body || document.documentElement;
    _observer.observe(root, { childList: true, subtree: true });
    attachPromptVisibilityObserver();
    scheduleRefresh();
}

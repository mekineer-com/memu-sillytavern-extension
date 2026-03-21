/**
 * memU Inspect Panel — renders alongside Prompt Inspector's popup.
 *
 * Watches for PI's popup in the DOM (via MutationObserver). When it appears,
 * injects a collapsible memU section showing the last retrieve response:
 * working_note, retrieved items with scores, categories.
 */

export type InspectData = {
    timestamp: number;
    query?: string;
    workingNote?: string;
    categories?: Array<{ name: string; score: number; summary?: string }>;
    items?: Array<{ summary: string; score: number; memory_type: string; id?: string }>;
    resources?: any[];
    method?: string;
    conversationId?: string;
};

let _lastInspectData: InspectData | null = null;

export function stashInspectData(data: InspectData): void {
    _lastInspectData = data;
}

export function getInspectData(): InspectData | null {
    return _lastInspectData;
}

function renderInspectHtml(data: InspectData): string {
    const parts: string[] = [];

    parts.push(`<div style="font-family:monospace;font-size:12px;max-height:300px;overflow-y:auto;padding:8px;background:rgba(0,0,0,0.15);border-radius:6px;margin-top:8px;border:1px solid rgba(128,128,128,0.3)">`);
    parts.push(`<div style="font-weight:bold;margin-bottom:6px;color:#7dcaf7">memU Inspect</div>`);

    // Query
    if (data.query) {
        parts.push(`<div style="margin-bottom:6px"><b>Query:</b> ${esc(data.query)}</div>`);
    }

    // Working note
    if (data.workingNote) {
        parts.push(`<details style="margin-bottom:6px"><summary style="cursor:pointer"><b>Working Note</b> (${data.workingNote.length} chars)</summary>`);
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

    if (cats.length === 0 && items.length === 0 && !data.workingNote) {
        parts.push(`<div style="opacity:0.6">(no data from last retrieve)</div>`);
    }

    // Timestamp
    const age = Math.round((Date.now() - data.timestamp) / 1000);
    parts.push(`<div style="opacity:0.5;font-size:10px;margin-top:4px">${age}s ago · ${data.method || 'rag'} · ${data.conversationId || '?'}</div>`);

    parts.push(`</div>`);
    return parts.join('');
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PANEL_ID = 'memu-inspect-panel';

function injectIntoPopup(popupEl: Element): void {
    if (popupEl.querySelector(`#${PANEL_ID}`)) return;
    const data = _lastInspectData;
    if (!data) return;

    const container = document.createElement('div');
    container.id = PANEL_ID;
    container.innerHTML = renderInspectHtml(data);

    // Find the textarea container in PI's popup and insert after it
    const textarea = popupEl.querySelector('#inspectPrompt');
    const target = textarea?.parentElement || popupEl.querySelector('.popup-content') || popupEl;
    target.appendChild(container);
}

let _observer: MutationObserver | null = null;

export function startInspectObserver(): void {
    if (_observer) return;

    _observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                // PI's popup uses the Popup class which creates elements with class "popup"
                const popup = node.classList.contains('popup') ? node : node.querySelector?.('.popup');
                if (!popup) continue;
                // Check if this is PI's popup (has #inspectPrompt textarea)
                const check = () => {
                    const inspectPrompt = popup.querySelector('#inspectPrompt');
                    if (inspectPrompt) {
                        injectIntoPopup(popup);
                    }
                };
                // PI may render async; check now and after a tick
                check();
                setTimeout(check, 100);
                setTimeout(check, 300);
            }
        }
    });

    _observer.observe(document.body, { childList: true, subtree: true });
}

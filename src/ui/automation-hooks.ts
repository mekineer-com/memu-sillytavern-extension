const TEST_ID_MAP: Array<{ selector: string; testId: string }> = [
    { selector: '#send_textarea', testId: 'st-send-textarea' },
    { selector: '#send_but', testId: 'st-send-button' },
    { selector: '#option_regenerate', testId: 'st-regenerate-button' },
    { selector: '#option_continue', testId: 'st-continue-button' },
];

function setTestId(selector: string, testId: string): void {
    const el = document.querySelector(selector);
    if (!(el instanceof HTMLElement)) return;
    if (el.getAttribute('data-testid') === testId) return;
    el.setAttribute('data-testid', testId);
}

function setKnownTestIds(): void {
    for (const row of TEST_ID_MAP) {
        setTestId(row.selector, row.testId);
    }
}

function clickSelector(selector: string): boolean {
    const el = document.querySelector(selector);
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
}

function onShortcut(ev: KeyboardEvent): void {
    if (!ev.altKey || !ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
    const key = String(ev.key || '').toLowerCase();
    if (key === 's') {
        if (!clickSelector('#send_but')) return;
    } else if (key === 'r') {
        if (!clickSelector('#option_regenerate')) return;
    } else if (key === 'c') {
        if (!clickSelector('#option_continue')) return;
    } else {
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
}

export function installAutomationHooks(): void {
    const w = window as any;
    if (w.__memuAutomationHooksInstalled) return;
    w.__memuAutomationHooksInstalled = true;

    setKnownTestIds();
    const observer = new MutationObserver(() => {
        setKnownTestIds();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    w.__memuAutomationMutationObserver = observer;

    window.addEventListener('keydown', onShortcut, true);
}

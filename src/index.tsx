import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import {
    onChatChanged,
    onChatCompletionPromptReady,
    onGenerateAfterCombinePrompts,
    onGenerateAfterData,
    onGenerationStopped,
    onMessageEdited,
    onMessageReceived,
    onMessageSwiped,
    onMessageDeleted,
    onUserMessageSent,
} from 'memory/exports';
import { st } from './utils/context-extra';
import { info, warn, error as logError } from './utils/log';
import { startInspectObserver } from './ui/inspect-panel';
import { installAutomationHooks } from './ui/automation-hooks';

function installHooksWithRetry(): void {
    const w = window as any;
    if (w.__memuHooksInstalled) return;

    function tryInstallOnce(): boolean {
        // Background hooks (must run even when Settings UI isn't open)
        // Some ST builds initialize eventSource late; retry briefly instead of failing forever.
        if (!st?.eventSource?.on) return false;
        try {
            st.eventSource.on(st.event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
            st.eventSource.makeFirst(st.event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
            st.eventSource.on(st.event_types.GENERATE_AFTER_COMBINE_PROMPTS, onGenerateAfterCombinePrompts);
            st.eventSource.makeFirst(st.event_types.GENERATE_AFTER_COMBINE_PROMPTS, onGenerateAfterCombinePrompts);
            st.eventSource.on(st.event_types.GENERATE_AFTER_DATA, onGenerateAfterData);
            st.eventSource.makeLast(st.event_types.GENERATE_AFTER_DATA, onGenerateAfterData);
            st.eventSource.on(st.event_types.GENERATION_STOPPED, onGenerationStopped);
            st.eventSource.on(st.event_types.CHAT_CHANGED, onChatChanged);
            st.eventSource.on(st.event_types.MESSAGE_SENT, onUserMessageSent);
            st.eventSource.on(st.event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
            st.eventSource.on(st.event_types.MESSAGE_EDITED, onMessageEdited);
            st.eventSource.on(st.event_types.MESSAGE_SWIPED, onMessageSwiped);
            st.eventSource.on(st.event_types.MESSAGE_DELETED, onMessageDeleted);
            return true;
        } catch (e) {
            logError("hooks install failed", e);
            return false;
        }
    }

    if (tryInstallOnce()) {
        w.__memuHooksInstalled = true;
        try { onChatChanged(); } catch { }
        return;
    }

    let attempts = 0;
    const timer = window.setInterval(() => {
        if (w.__memuHooksInstalled) {
            window.clearInterval(timer);
            return;
        }
        attempts += 1;
        if (tryInstallOnce()) {
            w.__memuHooksInstalled = true;
            window.clearInterval(timer);
            try { onChatChanged(); } catch { }
            return;
        }
        if (attempts >= 40) {
            window.clearInterval(timer);
            warn("hooks not installed after retries (eventSource unavailable)");
        }
    }, 250);
}

installHooksWithRetry();

let mounted = false;

function installChatOptionResetCursor(): void {
    const OPTION_ID = 'option_memu_memorize_from_beginning';

    async function resetCursor(): Promise<void> {
        try {
            const { st } = await import('./utils/context-extra');
            const { initChatExtraInfo } = await import('./memory/utils');
            const { doSummary } = await import('./memory/memorize');

            // Keep baseInfo; wipe progress markers so next digest starts from turn 0.
            const ctx: any = st.getContext() as any;
            const extras: any = ctx?.chatMetadata?.memuExtras;
            if (extras && typeof extras === 'object') {
                try { delete extras.summary; } catch { }
                try { delete extras.retrieve; } catch { }
            }

            await st.saveChat();
            try { await initChatExtraInfo(ctx); } catch { }

            const chat: any[] = Array.isArray(ctx?.chat) ? ctx.chat : [];
            if (chat.length === 0) {
                info("memorize from beginning skipped: empty chat");
                return;
            }

            // Force a full digest immediately (do not require leaving/re-entering the chat).
            await doSummary(0, chat.length - 1);
            info(`memorize from beginning started (messages=${chat.length})`);
        } catch (e) {
            logError("reset failed", e);
        }
    }


    function tryInstall(): boolean {
        const options = document.querySelector('#options .options-content') as HTMLElement | null;
        if (!options) return false;
        if (document.getElementById(OPTION_ID)) return true;

        const anchor = document.createElement('a');
        anchor.id = OPTION_ID;
        const icon = document.createElement('i');
        icon.className = 'fa-lg fa-solid fa-rotate-left';
        const label = document.createElement('span');
        label.textContent = 'Re-memorize chat';
        anchor.appendChild(icon);
        anchor.appendChild(label);

        anchor.addEventListener('click', async (ev) => {
            ev.preventDefault();
            if (!window.confirm('memu: re-memorize this chat now?')) return;
            await resetCursor();

            // Close the options menu (if open) to match built-in actions.
            const menu = document.getElementById('options') as HTMLElement | null;
            if (menu) menu.style.display = 'none';
        });

        // Place it near other chat-level actions.
        const after = document.getElementById('option_select_chat');
        if (after && after.parentElement === options) {
            options.insertBefore(anchor, after.nextSibling);
            return true;
        }

        options.appendChild(anchor);
        return true;
    }

    if (tryInstall()) return;

    // options menu is present late in some ST builds; retry briefly.
    let attempts = 0;
    const timer = window.setInterval(() => {
        attempts += 1;
        if (tryInstall() || attempts >= 40) window.clearInterval(timer);
    }, 250);
}

function tryMount(): boolean {
    if (mounted) return true;

    // ST versions differ: some use extensions_settings2, others use extensions_settings
    const rootContainer =
        document.getElementById('extensions_settings2') ||
        document.getElementById('extensions_settings');

    if (!rootContainer) return false;

    const rootElement = document.createElement('div');
    rootElement.className = 'memu-ext-settings-root';
    rootContainer.appendChild(rootElement);

    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );

    mounted = true;
    return true;
}

// Mount immediately if possible.
if (!tryMount()) {
    // Some ST builds create the settings container later; retry briefly without failing the extension.
    let attempts = 0;
    const timer = window.setInterval(() => {
        attempts += 1;
        if (tryMount() || attempts >= 40) {
            window.clearInterval(timer);
            if (!mounted) {
                warn("UI not mounted after retries (settings container missing)");
            }
        }
    }, 250);
}

installChatOptionResetCursor();
startInspectObserver();
installAutomationHooks();

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

let mounted = false;

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
                console.warn('memu-ext: could not find extensions settings container; UI not mounted');
            }
        }
    }, 250);
}

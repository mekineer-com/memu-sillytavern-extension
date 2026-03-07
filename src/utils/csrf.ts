let _csrfCache: { token: string; at: number } | null = null;
const CSRF_CACHE_TTL_MS = 60_000;

export async function getCsrfTokenCached(): Promise<string> {
    const now = Date.now();
    if (_csrfCache && (now - _csrfCache.at) < CSRF_CACHE_TTL_MS && _csrfCache.token) {
        return _csrfCache.token;
    }

    const tokenResp = await fetch('/csrf-token');
    const parsed = await tokenResp.json().catch(() => ({} as any));
    const token = String(parsed?.token || '');
    _csrfCache = { token, at: now };
    return token;
}

export async function postJsonWithCsrf<T = any>(url: string, body?: any): Promise<T> {
    const token = await getCsrfTokenCached();
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': token,
        },
        body: JSON.stringify(body ?? {}),
    });

    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`${url} failed (${resp.status}): ${txt}`);
    }

    return resp.json().catch(() => ({} as T));
}

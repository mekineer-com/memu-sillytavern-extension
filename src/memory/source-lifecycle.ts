import { postJsonWithCsrf } from 'utils/csrf';
import { deleteConversationSource, getPluginPing } from 'utils/network';
import { withSavedSourceQueue } from './memorize';

type DeletedSource = { userId: string; soulId: string; conversationId: string };

function sourceFromMetadata(metadata: any, fileName: string): DeletedSource | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Saved chat metadata is unreadable; deletion refused');
    }
    if (metadata.main_chat || !metadata.memuExtras?.baseInfo) return null;
    const info = metadata.memuExtras.baseInfo;
    const userId = typeof info.userId === 'string' ? info.userId.trim() : '';
    const soulId = typeof info.characterId === 'string' ? info.characterId.trim() : '';
    if (!userId || !soulId) throw new Error('Saved memU identity is unreadable; deletion refused');
    const integrity = typeof metadata.integrity === 'string' ? metadata.integrity.trim() : '';
    return { userId, soulId, conversationId: integrity ? `integrity:${integrity}` : `chat:${fileName}` };
}

async function deletedSources(path: string, body: any): Promise<DeletedSource[]> {
    if (typeof body.avatar_url !== 'string' || !body.avatar_url) throw new Error('Missing deleted card identity');
    const readSource = async (fileName: string) => {
        const saved = await postJsonWithCsrf('/api/chats/get', { avatar_url: body.avatar_url, file_name: fileName });
        const header = Array.isArray(saved) ? saved[0] : null;
        if (!header || header.mes !== undefined
            || !(header.user_name !== undefined || header.name !== undefined || header.chat_metadata !== undefined)) {
            throw new Error('Saved chat is unreadable; deletion refused');
        }
        return sourceFromMetadata(header.chat_metadata === undefined ? {} : header.chat_metadata, fileName);
    };
    if (path === '/api/chats/delete') {
        if (typeof body.chatfile !== 'string' || !body.chatfile) throw new Error('Missing deleted chat filename');
        const fileName = body.chatfile.replace(/\.jsonl$/, '');
        const source = await readSource(fileName);
        return source ? [source] : [];
    }
    const selector = { avatar_url: body.avatar_url };
    let files = await postJsonWithCsrf('/api/characters/chats', { ...selector, simple: true });
    if (files?.error === true) {
        // Native get creates an absent directory; a failed re-list is not an empty chat set.
        await postJsonWithCsrf('/api/chats/get', selector);
        files = await postJsonWithCsrf('/api/characters/chats', { ...selector, simple: true });
    }
    if (!Array.isArray(files)) throw new Error('Saved chats are unreadable; deletion refused');
    const names = files.map(file => file.file_name);
    if (names.some(name => typeof name !== 'string' || !name) || new Set(names).size !== names.length) {
        throw new Error('Saved chat metadata is incomplete; deletion refused');
    }
    const sources: DeletedSource[] = [];
    for (const name of names) {
        const source = await readSource(name.replace(/\.jsonl$/, ''));
        if (source) sources.push(source);
    }
    return sources;
}

async function independentImport(body: FormData): Promise<FormData> {
    const file = body.get('avatar');
    if (body.get('file_type') !== 'jsonl' || !(file instanceof File)) return body;
    const text = await file.text();
    const end = text.indexOf('\n');
    const firstLine = end < 0 ? text : text.slice(0, end);
    let header: any;
    try { header = JSON.parse(firstLine); } catch { return body; }
    const metadata = header?.chat_metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return body;
    if (!Object.hasOwn(metadata, 'integrity') && !Object.hasOwn(metadata, 'memuExtras')) return body;
    delete metadata.integrity;
    delete metadata.memuExtras;
    const imported = new FormData();
    for (const [key, value] of body.entries()) {
        imported.append(key, key === 'avatar'
            ? new File([JSON.stringify(header), firstLine.endsWith('\r') ? '\r' : '', end < 0 ? '' : text.slice(end)], file.name,
                { type: file.type, lastModified: file.lastModified })
            : value);
    }
    return imported;
}

export function installSourceLifecycle(): void {
    const host = window as any;
    if (host.__memuSourceLifecycleInstalled) return;
    host.__memuSourceLifecycleInstalled = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input), window.location.href);
        const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
        if (url.origin !== window.location.origin || method !== 'POST') return nativeFetch(input, init);
        if (url.pathname === '/api/chats/import' && init?.body instanceof FormData) {
            const body = await independentImport(init.body);
            return nativeFetch(input, body === init.body ? init : { ...init, body });
        }
        if (url.pathname !== '/api/chats/delete' && url.pathname !== '/api/characters/delete') return nativeFetch(input, init);
        const text = init?.body ?? (request ? await request.clone().text() : '');
        const body = JSON.parse(String(text));
        if (url.pathname === '/api/characters/delete' && !body.delete_chats) return nativeFetch(input, init);
        return withSavedSourceQueue(async () => {
            let sources: DeletedSource[];
            try {
                sources = await deletedSources(url.pathname, body);
                if (sources.length && !(await getPluginPing()).ok) throw new Error('memU is offline; linked chat deletion refused');
            } catch (error) {
                window.alert(`Chat deletion refused: ${error instanceof Error ? error.message : String(error)}`);
                if (url.pathname === '/api/characters/delete') {
                    return new Response(null, { status: 409, statusText: 'Chat deletion refused' });
                }
                throw error;
            }
            const response = await nativeFetch(input, init);
            if (response.ok) {
                const failures: string[] = [];
                for (const source of sources) {
                    try { await deleteConversationSource(source); }
                    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
                }
                if (failures.length) window.alert(`Chat deleted, but memU source cleanup failed: ${failures.join('; ')}`);
            }
            return response;
        });
    };
}

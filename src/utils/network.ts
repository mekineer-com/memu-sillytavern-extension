import { DefaultCategoriesResponse, MemorizeResponse, MemorizeTaskStatusResponse, MemorizeTaskSummaryReadyResponse } from "memu-js";
import { ConversationData } from "utils/types";
import { ConnectionProfileSummary, MemuPluginConfigV1 } from "utils/types";

const ROUTER_BASE_URL = '/api/plugins/memu'

export type PluginPing = {
    ok: boolean;
    module?: string;
    mode?: string;
    bridgeSessionId?: string;
    dbProvider?: string;
    ephemeralDb?: boolean;
};

export async function getPluginPing(): Promise<PluginPing> {
    return request<PluginPing>(
        '/ping',
        undefined,
        'GET',
    );
}

export async function pingPlugin(): Promise<boolean> {
    try {
        const resp = await getPluginPing();
        return !!resp?.ok;
    } catch {
        return false;
    }
}

export async function getPluginConfig(): Promise<MemuPluginConfigV1> {
    return request<MemuPluginConfigV1>(
        '/config',
        undefined,
        'GET',
    );
}

export async function setPluginConfig(config: Partial<MemuPluginConfigV1>): Promise<{ ok: boolean; config?: MemuPluginConfigV1 }> {
    return request<{ ok: boolean; config?: MemuPluginConfigV1 }>(
        '/config',
        config,
        'POST',
    );
}

export async function getConnectionProfiles(): Promise<{ ok: boolean; profiles: ConnectionProfileSummary[]; message?: string }> {
    return request<{ ok: boolean; profiles: ConnectionProfileSummary[]; message?: string }>(
        '/profiles',
        undefined,
        'GET',
    );
}

export async function getProfileModels(
    profileId: string,
    opts?: { kind?: 'embedding' | 'chat' | 'all'; force?: boolean },
): Promise<{ ok: boolean; models: string[]; message?: string }> {
    const params = new URLSearchParams();
    params.set('profileId', profileId);
    if (opts?.kind && opts.kind !== 'all') params.set('kind', opts.kind);
    if (opts?.force) params.set('force', '1');
    return request<{ ok: boolean; models: string[]; message?: string }>(
        `/models?${params.toString()}`,
        undefined,
        'GET',
    );
}

export async function getTaskStatus(
    apiKey: string,
    timeout: number,
    taskId: string,
): Promise<MemorizeTaskStatusResponse> {
    return request<MemorizeTaskStatusResponse>(
        '/getTaskStatus',
        {
            apiKey: apiKey,
            timeout: timeout,
            taskId: taskId,
        },
    );
}

export async function getTaskSummaryReady(
    apiKey: string,
    timeout: number,
    taskId: string,
): Promise<MemorizeTaskSummaryReadyResponse> {
    return request<MemorizeTaskSummaryReadyResponse>(
        '/getTaskSummaryReady',
        {
            apiKey: apiKey,
            timeout: timeout,
            taskId: taskId,
        },
    );
}

export async function retrieveDefaultCategories(
    apiKey: string,
    userId: string,
    agentId: string,
): Promise<DefaultCategoriesResponse> {
    return request<DefaultCategoriesResponse>(
        '/retrieveDefaultCategories',
        {
            apiKey: apiKey,
            userId: userId,
            agentId: agentId,
        },
    );
}

export async function memorizeConversation(
    apiKey: string,
    conversationData: ConversationData,
): Promise<MemorizeResponse> {
    return request<MemorizeResponse>(
        '/memorizeConversation',
        {
            apiKey: apiKey,
            conversation: conversationData.messages,
            userId: conversationData.userId,
            userName: conversationData.userName,
            agentId: conversationData.characterId,
            agentName: conversationData.characterName,
        },
    );
}


async function request<T extends any>(
    url: string,
    body: any | undefined,
    method: string = 'POST',
    headers: Record<string, string> = {
        'Content-Type': 'application/json',
    },
): Promise<T> {
    const tokenResp = await fetch('/csrf-token')
    const csrfToken = (await tokenResp.json()).token

    const resp = await fetch(`${ROUTER_BASE_URL}${url}`, {
        method,
        headers: {
            ...headers,
            'x-csrf-token': csrfToken,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    if (resp.status !== 200) {
        // Read the error body as text so the console shows the real server message
        // (otherwise you'll just see "[object ReadableStream]").
        let errText = '';
        try {
            errText = await resp.text();
        } catch {
            errText = String(resp.body);
        }
        throw new Error(`Failed to request: ${resp.status}, ${errText}`);
    }
    return resp.json() as Promise<T>;
}

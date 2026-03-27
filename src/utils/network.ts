import { ConversationData } from 'utils/types';
import { ConnectionProfileSummary, MemuPluginConfigV1 } from 'utils/types';
import { getCsrfTokenCached } from 'utils/csrf';

const ROUTER_BASE_URL = '/api/plugins/memu';

export type PluginPing = {
  ok: boolean;
  module?: string;
  serverInstanceId?: string;
  ephemeralDb?: boolean;
};

export type MemorizeResponse = { taskId: string };
export type MemorizeTaskStatusResponse = { status: string; error?: string };
export type MemorizeTaskSummaryReadyResponse = { allReady: boolean };
export type DefaultCategoriesResponse = { categories: any[] };
export type ConversationRetrieveRequest = {
  userId: string;
  soulId: string;
  conversationId: string;
  method: 'rag' | 'llm';
  query?: string;
  queries?: Array<Record<string, any> | string>;
  history?: Array<Record<string, any>>;
  buildTurnPrompt?: boolean;
  soul_card?: string;
};
export type ConversationRetrieveResponse = {
  ok: boolean;
  result?: any;
  prior_context?: any;
  state?: any;
  path?: string;
  method?: string;
  conversation_id?: string;
  queries?: number;
  turn_system_prompt?: string;
  turn_user_prompt?: string;
  memory_cache?: any[];
  intentions_active?: any;
  retrieve_ms?: number;
};
export type ConversationTurnRequest = {
  userId: string;
  soulId: string;
  conversationId: string;
  message: string;
  history?: Array<Record<string, any>>;
  runApimw?: boolean;
  waitApimw?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  soul_card?: string;
};
export type ConversationTurnResponse = {
  ok: boolean;
  response?: string;
  conversation_id?: string;
  apimw?: string;
  state?: any;
  path?: string;
  turn_contract?: any;
  turn_prompt?: string;
  turn_system_prompt?: string;
  dry_run?: boolean;
  annulment_memory_ids?: string[];
  retrieve_ms?: number;
  turn_ms?: number;
  reply_chars?: number;
  turn_prompt_chars?: number;
  turn_system_chars?: number;
};
export type ScopeStorageProbeResponse = {
  ok: boolean;
  userId?: string;
  soulId?: string;
  provider?: string;
  dbPath?: string | null;
  exists?: boolean;
  fileSize?: number;
  scopedRowCount?: number;
  missing?: boolean;
  empty?: boolean;
  missingOrEmpty?: boolean;
  reason?: string;
};

export async function getPluginPing(): Promise<PluginPing> {
  return request<PluginPing>('/ping', undefined, 'GET');
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
  return request<MemuPluginConfigV1>('/config', undefined, 'GET');
}

export async function serverStatus(): Promise<any> {
  return request<any>('/server/status', undefined, 'GET');
}

export async function serverStart(): Promise<any> {
  return request<any>('/server/start', {}, 'POST');
}

export async function serverStop(): Promise<any> {
  return request<any>('/server/stop', {}, 'POST');
}

export async function setPluginConfig(config: Partial<MemuPluginConfigV1>): Promise<{ ok: boolean; config?: MemuPluginConfigV1 }> {
  return request<{ ok: boolean; config?: MemuPluginConfigV1 }>('/config', config, 'POST');
}

export async function getConnectionProfiles(): Promise<{ ok: boolean; profiles: ConnectionProfileSummary[]; message?: string }> {
  return request<{ ok: boolean; profiles: ConnectionProfileSummary[]; message?: string }>('/profiles', undefined, 'GET');
}

export async function getProfileModels(
  profileId: string,
  opts?: { kind?: 'embedding' | 'chat' | 'all'; force?: boolean },
): Promise<{ ok: boolean; models: string[]; message?: string }> {
  const params = new URLSearchParams();
  params.set('profileId', profileId);
  if (opts?.kind && opts.kind !== 'all') params.set('kind', opts.kind);
  if (opts?.force) params.set('force', '1');
  return request<{ ok: boolean; models: string[]; message?: string }>(`/models?${params.toString()}`, undefined, 'GET');
}

export async function getTaskStatus(taskId: string): Promise<MemorizeTaskStatusResponse> {
  return request<MemorizeTaskStatusResponse>('/getTaskStatus', { taskId });
}

export async function getTaskSummaryReady(taskId: string): Promise<MemorizeTaskSummaryReadyResponse> {
  return request<MemorizeTaskSummaryReadyResponse>('/getTaskSummaryReady', { taskId });
}

export async function retrieveDefaultCategories(userId: string, soulId: string): Promise<DefaultCategoriesResponse> {
  return request<DefaultCategoriesResponse>('/retrieveDefaultCategories', { userId, soulId });
}

export async function conversationRetrieve(body: ConversationRetrieveRequest): Promise<ConversationRetrieveResponse> {
  return request<ConversationRetrieveResponse>('/conversationRetrieve', body);
}

export async function conversationTurn(body: ConversationTurnRequest): Promise<ConversationTurnResponse> {
  return request<ConversationTurnResponse>('/conversationTurn', body);
}

export async function scopeStorageProbe(userId: string, soulId: string): Promise<ScopeStorageProbeResponse> {
  return request<ScopeStorageProbeResponse>('/scopeStorageProbe', { userId, soulId });
}

export async function memorizeConversation(
  conversationData: ConversationData,
  opts: { force?: boolean } = {},
): Promise<MemorizeResponse> {
  const soul = conversationData.characterName;
  const qs = opts.force ? '?force=true' : '';
  return request<MemorizeResponse>(`/memorizeConversation${qs}`, {
    conversation: conversationData.messages,
    userId: conversationData.userId,
    userName: conversationData.userName,
    conversationId: conversationData.conversationId,
    // KISS: soul scope key is the character name.
    soulId: soul,
    soulName: soul,
    chatFileName: conversationData.chatFileName,
    timeZone: conversationData.timeZone,
    timeZoneOffsetMin: conversationData.timeZoneOffsetMin,
  });
}

async function request<T>(
  url: string,
  body: any | undefined,
  method: string = 'POST',
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
): Promise<T> {
  const csrfToken = await getCsrfTokenCached();

  const resp = await fetch(`${ROUTER_BASE_URL}${url}`, {
    method,
    headers: {
      ...headers,
      'x-csrf-token': csrfToken,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });

  if (resp.status !== 200) {
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

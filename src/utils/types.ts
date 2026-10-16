export enum MemuTaskStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
}

// --- memu local configuration (stored server-side in the plugin) ---

export interface MemuPluginConfigV1 {
  version: 4;

  embeddingModelSelected?: string;
  embeddingModelManual?: string;

  // External memu server folder (mcp-memu-server)
  serverPath?: string;
  autoStartServer?: boolean;

  updatedAt: string;
}

export type ModelSelection = { profile_id: string; provider: string; model: string; base_url?: string; context_window_tokens?: number; max_tokens?: number };
export type ModelChoice = { source: 'config' | 'srmm' | 'st_native' | 'configured'; selection?: ModelSelection };
export type ModelMappings = {
  claude_code: boolean;
  mental_health_query: boolean;
  reply_models: Record<string, ModelChoice>;
  step_models: Record<string, ModelChoice>;
  st_selected: { selection: ModelSelection } | null;
  base_model: { provider: string; model: string };
  providers: Array<{ profile_id: string; provider: string; label: string; supported: boolean; reason?: string;
    models: Array<{ model: string; context_window_tokens?: number }> }>;
};

export interface ConnectionProfileSummary {
  id: string;
  name: string;
  provider?: string;
  memuChatCapable?: boolean;
  memuEmbeddingListCapable?: boolean;
  selected?: boolean;
  resolvedProfileId?: string;
}

export interface MemuExtras {
  baseInfo?: MemuBaseInfo;
  summary?: MemuSummary;
  retrieve?: MemuRetrieve;

  // Used to detect server restarts so we don't keep stale cursors.
  serverInstanceId?: string;
}

export interface MemuBaseInfo {
  characterId: string;
  characterName: string;
  userName: string;
  userId: string;
}

export interface MemuRetrieveFailure {
  summaryTaskId: string;
  failureCount: number;
  lastError?: string;
  lastFailureAt?: number;
  lastAt?: number;
}

export interface MemuRetrieve {
  liveRetrieve?: MemuRetrieveHistory;
  nowRetrieve?: MemuRetrieveHistory;
  history: MemuRetrieveHistory[];
  lastFailure?: MemuRetrieveFailure;
}

export interface MemuRetrieveHistory {
  summaryRange?: [number, number];
  summaryTaskId?: string;
  summary?: string;
}

export interface MemuSummary {
  // [from, to)
  summaryRange: [number, number];
  summaryTaskId?: string;
  summaryTaskStatus: MemuTaskStatus;
  force?: boolean;
  tail?: boolean;

  // Batch progress (from server polling)
  progress?: { current: number; total: number; phase?: string };

  // Retry diagnostics
  failureCount?: number;
  lastError?: string;
  lastFailureAt?: number;
}

export interface ConversationData {
  messages: ConversationMessage[];
  userName: string;
  userId: string;
  characterName: string;
  characterId: string;
  // Stable per-chat identity for backend dedupe/cursor continuity.
  conversationId?: string;
  chatName: string;
  source_message_count: number;
}

export interface ConversationMessage {
  role: 'user' | 'soul' | 'unknown';
  content: string;
  name?: string;
  // Optional: message timestamp in epoch milliseconds (UTC). Prefer this for deterministic splits.
  ts_ms?: number;
  source_message_id?: string;
  source_conversation_index?: number;
}

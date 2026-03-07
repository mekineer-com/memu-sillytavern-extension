export enum MemuTaskStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
}

// --- memu local configuration (stored server-side in the plugin) ---

export type MemuStep =
  | 'all'
  | 'preprocess'
  | 'memory_extract'
  | 'category_update'
  | 'reflection'
  | 'ranking'
  | 'embeddings';

export interface MemuPluginConfigV1 {
  version: 4;
  defaultProfileId?: string;
  stepProfileId?: Partial<Record<MemuStep, string>>;

  /**
   * Effective embedding model (derived).
   * UI stores a dropdown selection and optional manual override.
   */
  embeddingModel?: string;
  embeddingModelSelected?: string;
  embeddingModelManual?: string;

  // External memu server folder (mcp-memu-server)
  serverPath?: string;
  autoStartServer?: boolean;

  updatedAt: string;
}

export interface ConnectionProfileSummary {
  id: string;
  name: string;
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

export interface MemuRetrieve {
  nowRetrieve?: MemuRetrieveHistory;
  history: MemuRetrieveHistory[];
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
  // the summary content in retrieve task is ready
  isReady?: boolean;

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
  // Optional: the SillyTavern chat file name (used as a stable pointer on the server).
  chatFileName?: string;
  // Optional: IANA timezone name of the client (used for sleep-based daily resource splits).
  timeZone?: string;
  // Optional: numeric offset fallback (minutes, same sign as Date.getTimezoneOffset()).
  timeZoneOffsetMin?: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'participant';
  content: string;
  name?: string;
  // Optional: message timestamp in epoch milliseconds (UTC). Prefer this for deterministic splits.
  ts_ms?: number;
}

export interface STEventData {
  chat: STEventDataMsg[];
  dryRun: boolean;
}

export interface STEventDataMsg {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

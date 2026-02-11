export enum MemuTaskStatus {
    PENDING = 'PENDING',
    PROCESSING = 'PROCESSING',
    SUCCESS = 'SUCCESS',
    FAILURE = 'FAILURE',
}

// --- memU local configuration (stored server-side in the plugin) ---
export type MemuMode = 'cloud' | 'local';

export type MemuStep =
    | 'all'
    | 'preprocess'
    | 'memory_extract'
    | 'category_update'
    | 'reflection'
    | 'ranking'
    | 'embeddings';

export interface MemuPluginConfigV1 {
    version: 1;
    mode: MemuMode;
    defaultProfileId?: string;
    stepProfileId?: Partial<Record<MemuStep, string>>;
    /**
     * Effective embedding model (derived).
     * The UI stores both a dropdown selection and an optional manual override.
     * The plugin will prefer:
     *   embeddingModelSelected > embeddingModelManual > embeddingModel (legacy)
     */
    embeddingModel?: string;
    embeddingModelSelected?: string;
    embeddingModelManual?: string;
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

    // Local-mode diagnostics / retry control (optional)
    failureCount?: number;
    lastError?: string;
}

export interface ConversationData {
    messages: ConversationMessage[];
    userName: string;
    userId: string;
    characterName: string;
    characterId: string;
}

export interface ConversationMessage {
    role: 'user' | 'assistant' | 'participant';
    content: string;
    name?: string;
}

export interface STEventData {
    chat: STEventDataMsg[];
    dryRun: boolean;
}

export interface STEventDataMsg {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

import { MEMU_DEFAULT_TIMEOUT } from 'utils/consts';
import { memuExtras, st } from 'utils/context-extra';
import { getTaskStatus } from 'utils/network';
import { MemuTaskStatus, MemuSummary } from 'utils/types';
import { retrieveMemories } from './memorize';
import { onceError, onceWarn } from 'utils/log';
import { currentScope, isMemuActive } from './utils';

const DEFAULT_INTERVAL_MS = MEMU_DEFAULT_TIMEOUT;
const ACTIVE_PROGRESS_INTERVAL_MS = 3_000;
const MAX_RETRIEVE_FAILURE_RETRIES = 2;

let pollerTimer: ReturnType<typeof setTimeout> | undefined;
let isTerminated = false;
let pollingGeneration = 0;

export function setIsTerminated(value: boolean): void {
    isTerminated = value;
}

function isSummaryPollingActive(summary: { summaryTaskStatus?: MemuTaskStatus } | undefined): boolean {
    if (!summary) return false;
    const status = summary.summaryTaskStatus;
    return status === MemuTaskStatus.PENDING || status === MemuTaskStatus.PROCESSING;
}

export function startSummaryPolling(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (pollerTimer || isTerminated) {
        return;
    }
    const generation = pollingGeneration;
    const loop = async (): Promise<void> => {
        if (isTerminated || generation !== pollingGeneration) return;
        await tick();
        if (isTerminated || generation !== pollingGeneration) return;
        const nextMs = isSummaryPollingActive(memuExtras.summary)
            ? ACTIVE_PROGRESS_INTERVAL_MS
            : intervalMs;
        pollerTimer = setTimeout(() => { void loop(); }, nextMs);
    };
    pollerTimer = setTimeout(() => { void loop(); }, 0);
}

export function stopSummaryPolling(): void {
    pollingGeneration++;
    if (pollerTimer) {
        clearTimeout(pollerTimer);
        pollerTimer = undefined;
    }
    isTerminated = true;
}

async function tick(): Promise<void> {
  try {
        const scope = currentScope(), generation = pollingGeneration;
        if (!(await isMemuActive()) || scope !== currentScope() || generation !== pollingGeneration) return;

        await fireAndUpdateTaskStatus();
        if (scope !== currentScope() || generation !== pollingGeneration) return;
        const summary = memuExtras.summary;
        if (!summary) return;

        switch (summary.summaryTaskStatus) {
            case MemuTaskStatus.PENDING:
            case MemuTaskStatus.PROCESSING: {
                break;
            }
            case MemuTaskStatus.SUCCESS: {
                try {
                    const prev = memuExtras.retrieve?.nowRetrieve;
                    // Skip only when we already pulled a populated sync for this taskId.
                    // An empty summary means consolidation hadn't written the categories
                    // yet when retrieveMemories first ran — keep retrying until it has.
                    if (prev?.summaryTaskId === summary.summaryTaskId
                        && String(prev?.summary || '').trim() !== '') {
                        break;
                    }
                    // Avoid retry-spam when retrieve is failing repeatedly (e.g., backend SQLModel mapping error).
                    const lastFail = memuExtras.retrieve?.lastFailure;
                    if (lastFail?.summaryTaskId === (summary.summaryTaskId ?? 'undefined')
                        && (lastFail?.failureCount ?? 0) >= MAX_RETRIEVE_FAILURE_RETRIES) {
                        break;
                    }
                    await retrieveMemories(summary);
                } catch (error) {
                    onceError(
                        `poller-retrieve-failed:${String(summary.summaryTaskId ?? 'none')}`,
                        `retrieve after digest failed (taskId=${String(summary.summaryTaskId ?? 'none')})`,
                        error,
                    );
                }
                break;
            }
            default: {
                break;
            }
        }
    } catch (error) {
        onceError("poller-tick-error", "poller tick failed", error);
    }
}

function fireAndUpdateTaskStatus(): Promise<void> {
    const info = memuExtras.baseInfo;
    if (!info) return Promise.resolve();
    const { userId, characterId } = info;
    const taskId = memuExtras.summary?.summaryTaskId;
    const chatIdAtFire = currentScope();
    const generation = pollingGeneration;
    const current = () => generation === pollingGeneration && currentScope() === chatIdAtFire
        && memuExtras.baseInfo?.userId === userId && memuExtras.baseInfo?.characterId === characterId
        && memuExtras.summary?.summaryTaskId === taskId;

    return getTaskStatus(userId, characterId)
        .then(async (resp) => {
            if (!(await isMemuActive()) || !current()) {
                onceWarn(
                    `poller-stale-chat:${chatIdAtFire}:${taskId}`,
                    `task status response dropped (chat changed while in-flight, taskId=${taskId})`,
                );
                return;
            }
            const currentSummary = memuExtras.summary;
            if (['IDLE', 'SKIPPED', 'CANCELLED'].includes(resp?.status)) {
                if (currentSummary) {
                    memuExtras.summary = undefined;
                    await st.saveChat();
                }
                return;
            }
            if (!Object.values(MemuTaskStatus).includes(resp?.status as MemuTaskStatus)) {
                if (isSummaryPollingActive(currentSummary)) memuExtras.summary = { ...currentSummary!,
                    lastError: 'Memorize status unavailable. Checking again.' };
                return;
            }
            const mapped = resp.status as MemuTaskStatus;
            const active = mapped === MemuTaskStatus.PENDING || mapped === MemuTaskStatus.PROCESSING;
            if (!currentSummary && !active) return;
            const observingNewRun = active && !isSummaryPollingActive(currentSummary);
            // update summary value, do not do other logic
            const nextSummary: MemuSummary = {
                ...currentSummary,
                summaryRange: currentSummary?.summaryRange ?? [0, -1],
                summaryTaskId: observingNewRun ? `${chatIdAtFire}:${Date.now()}` : taskId,
                summaryTaskStatus: mapped,
                progress: (() => {
                    const raw = (resp as any)?.progress;
                    if (!raw || typeof raw !== 'object') return undefined;
                    const current = Number((raw as any).current);
                    const total = Number((raw as any).total);
                    if (!Number.isFinite(current) || !Number.isFinite(total)) return undefined;
                    const phase = typeof (raw as any).phase === 'string' ? String((raw as any).phase).trim() : '';
                    return {
                        current,
                        total,
                        ...(phase ? { phase } : {}),
                    };
                })(),
                lastError: mapped === MemuTaskStatus.FAILURE ? resp.error?.slice(0, 500) : undefined,
                failureCount: mapped === MemuTaskStatus.FAILURE
                    ? (currentSummary?.failureCount ?? 0) + Number(currentSummary?.summaryTaskStatus !== mapped) : 0,
            };
            if (JSON.stringify(nextSummary) === JSON.stringify(currentSummary)) return;
            memuExtras.summary = nextSummary;
            await st.saveChat();
        })
        .catch((err) => {
            if (current() && isSummaryPollingActive(memuExtras.summary)) memuExtras.summary = { ...memuExtras.summary!,
                lastError: 'Memorize status unavailable. Checking again.' };
            onceError("poller-task-status-failed", "task status failed", err);
        });
}

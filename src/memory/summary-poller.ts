import { MEMU_DEFAULT_TIMEOUT } from 'utils/consts';
import { memuExtras, st } from 'utils/context-extra';
import { getTaskStatus } from 'utils/network';
import { MemuTaskStatus } from 'utils/types';
import { doSummary, retrieveMemories } from './memorize';
import { onceError, onceWarn } from 'utils/log';

const DEFAULT_INTERVAL_MS = MEMU_DEFAULT_TIMEOUT;
const ACTIVE_PROGRESS_INTERVAL_MS = 3_000;
const MAX_SUMMARY_FAILURE_RETRIES = 2;
const MAX_RETRIEVE_FAILURE_RETRIES = 2;

let pollerTimer: ReturnType<typeof setTimeout> | undefined;
let isTerminated = false;

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
    const loop = async (): Promise<void> => {
        if (isTerminated) return;
        await tick();
        if (isTerminated) return;
        const nextMs = isSummaryPollingActive(memuExtras.summary)
            ? ACTIVE_PROGRESS_INTERVAL_MS
            : intervalMs;
        pollerTimer = setTimeout(() => { void loop(); }, nextMs);
    };
    void loop();
}

export function stopSummaryPolling(): void {
    if (pollerTimer) {
        clearTimeout(pollerTimer);
        pollerTimer = undefined;
    }
    isTerminated = true;
}

async function tick(): Promise<void> {
  try {

        const summary = memuExtras.summary;
        if (!summary) {
            return;
        }

        switch (summary.summaryTaskStatus) {
            case MemuTaskStatus.PENDING:
            case MemuTaskStatus.PROCESSING: {
                // async query latest status (do not wait)
                void fireAndUpdateTaskStatus(summary.summaryRange, summary.summaryTaskId);
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
            case MemuTaskStatus.FAILURE: {
                // Controlled retry (avoids infinite loops when the backend is misconfigured).
                if (summary.summaryRange && summary.summaryRange.length === 2) {
                    const [from, to] = summary.summaryRange;
                    const failCount = summary.failureCount ?? 0;
                    const err = summary.lastError;

                    // If we never got a taskId (request failed before a task was created),
                    // don't keep this FAILED state around forever. After a couple failures,
                    // clear it so the next user turn can attempt again.
                    if (!summary.summaryTaskId && failCount >= MAX_SUMMARY_FAILURE_RETRIES) {
                        onceWarn(
                            `poller-stale-taskid:${from}:${to}`,
                            `digest state cleared (no taskId, range=${from}-${to})`,
                        );
                        memuExtras.summary = undefined;
                        await st.saveChat();
                        break;
                    }
                    if (failCount >= MAX_SUMMARY_FAILURE_RETRIES) {
                        onceError(
                            `poller-digest-failed:${from}:${to}`,
                            `digest failed repeatedly (range=${from}-${to}, failures=${failCount})`,
                        );
                        break;
                    }

                    memuExtras.summary = {
                        ...summary,
                        summaryTaskStatus: MemuTaskStatus.PROCESSING,
                        failureCount: failCount + 1,
                    };
                    await st.saveChat();
                    void doSummary(from, to, { force: summary.force === true, tail: summary.tail === true });
                } else {
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

function fireAndUpdateTaskStatus(range: [number, number], taskId?: string | null): void {
    if (!taskId) {
        onceError("poller-fire-taskid-null", "taskId null");
        return;
    }

    getTaskStatus(taskId)
        .then(async (resp) => {
            const err = (resp as any)?.error;
            const raw = String(resp?.status ?? '').toUpperCase();
            let mapped: MemuTaskStatus;
            switch (raw) {
                case 'SUCCESS':
                    mapped = MemuTaskStatus.SUCCESS;
                    break;
                case 'PENDING':
                    mapped = MemuTaskStatus.PENDING;
                    break;
                case 'PROCESSING':
                    mapped = MemuTaskStatus.PROCESSING;
                    break;
                default:
                    mapped = MemuTaskStatus.FAILURE;
            }
            // update summary value, do not do other logic
            memuExtras.summary = {
                summaryRange: range,
                summaryTaskId: taskId,
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
                lastError: mapped === MemuTaskStatus.FAILURE ? (typeof err === 'string' ? err : undefined) : undefined,
                failureCount: mapped === MemuTaskStatus.FAILURE ? (memuExtras.summary?.failureCount ?? 0) + 1 : 0,
            };
            await st.saveChat();
        })
        .catch((err) => {
            onceError("poller-task-status-failed", "task status failed", err);
        });
}

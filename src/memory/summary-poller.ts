import { MEMU_DEFAULT_TIMEOUT } from 'utils/consts';
import { memuExtras, st } from 'utils/context-extra';
import { getTaskStatus, getTaskSummaryReady } from 'utils/network';
import { MemuTaskStatus } from 'utils/types';
import { doSummary, retrieveMemories } from './memorize';
import { onceError, onceWarn } from 'utils/log';

const DEFAULT_INTERVAL_MS = MEMU_DEFAULT_TIMEOUT;
const MAX_SUMMARY_FAILURE_RETRIES = 2;
const MAX_RETRIEVE_FAILURE_RETRIES = 2;

let pollerTimer: ReturnType<typeof setInterval> | undefined;
let isTerminated = false;

export function setIsTerminated(value: boolean): void {
    isTerminated = value;
}

export function startSummaryPolling(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (pollerTimer || isTerminated) {
        return;
    }
    pollerTimer = setInterval(tick, intervalMs);
}

export function stopSummaryPolling(): void {
    if (pollerTimer) {
        clearInterval(pollerTimer);
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
                    const lastFail: any = (memuExtras as any)?.retrieve?.lastFailure;
                    if (lastFail?.summaryTaskId === (summary.summaryTaskId ?? 'undefined')
                        && (lastFail?.failureCount ?? 0) >= MAX_RETRIEVE_FAILURE_RETRIES) {
                        break;
                    }
                    if (summary.isReady !== true) {
                        updateTaskSummaryStatus(summary.summaryTaskId);
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
                        (memuExtras as any).summary = null;
                        await st.saveChat();
                        break;
                    }
                    // Some local backends may complete and drop tasks quickly.
                    // If status probing returns 'Unknown taskId', assume digest is done and try retrieve once.
                    if (err === 'Unknown taskId') {
                        onceWarn(
                            `poller-unknown-taskid:${String(summary.summaryTaskId ?? 'none')}`,
                            `taskId not found; trying retrieve (taskId=${String(summary.summaryTaskId ?? 'none')})`,
                        );
                        try {
                            memuExtras.summary = {
                                ...summary,
                                summaryTaskStatus: MemuTaskStatus.SUCCESS,
                                isReady: true,
                                lastError: undefined,
                            };
                            await st.saveChat();
                            await retrieveMemories(memuExtras.summary);
                        } catch (e) {
                            onceError(
                                `poller-retrieve-after-unknown:${String(summary.summaryTaskId ?? 'none')}`,
                                `retrieve after unknown taskId failed (taskId=${String(summary.summaryTaskId ?? 'none')})`,
                                e,
                            );
                        }
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
                        failureCount: failCount + 1,
                    };
                    await st.saveChat();
                    void doSummary(from, to, summary.force === true);
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

function updateTaskSummaryStatus(taskId?: string | null): void {
    if (!taskId) {
        onceError("poller-taskid-null", "taskId null");
        return;
    }
    getTaskSummaryReady(taskId)
        .then(async (resp) => {
            if (memuExtras.summary) {
                memuExtras.summary.isReady = resp.allReady === true;
                await st.saveChat();
            }
        })
        .catch((err) => {
            onceError("poller-task-ready-failed", "task ready failed", err);
        });
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
                // IMPORTANT: never mutate/"shrink" the processed range based on a transient status probe.
                // Some backends (especially local) may drop tasks quickly and briefly report FAILURE/Unknown taskId
                // even though the digest actually completed. Shrinking the range corrupts our cursor and causes
                // repeated re-digests on chat open.
                summaryRange: range,
                summaryTaskId: taskId,
                summaryTaskStatus: mapped,
                isReady: false,
                lastError: mapped === MemuTaskStatus.FAILURE ? (typeof err === 'string' ? err : undefined) : undefined,
                failureCount: mapped === MemuTaskStatus.FAILURE ? (memuExtras.summary?.failureCount ?? 0) : 0,
            };
            await st.saveChat();
        })
        .catch((err) => {
            onceError("poller-task-status-failed", "task status failed", err);
        });
}

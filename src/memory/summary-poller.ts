import { MEMU_DEFAULT_TIMEOUT } from 'utils/consts';
import { API_KEY, PLUGIN_MODE, memuExtras, st } from 'utils/context-extra';
import { getTaskStatus, getTaskSummaryReady } from 'utils/network';
import { MemuTaskStatus } from 'utils/types';
import { doSummary, retrieveMemories } from './memorize';

const DEFAULT_INTERVAL_MS = MEMU_DEFAULT_TIMEOUT;
const MAX_SUMMARY_FAILURE_RETRIES = 2;

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
        const mode = PLUGIN_MODE.get();
        const apiKey = mode === 'local' ? '' : API_KEY.get();
        if (mode !== 'local' && !apiKey) {
            console.debug('memu-ext: summary-poller tick: apiKey is null (cloud mode)');
            return;
        }

        const summary = memuExtras.summary;
        if (!summary) {
            console.debug('memu-ext: summary-poller tick: summary is null');
            return;
        }

        console.log('memu-ext: summary-poller tick: summary', summary);
        switch (summary.summaryTaskStatus) {
            case MemuTaskStatus.PENDING:
            case MemuTaskStatus.PROCESSING: {
                // async query latest status (do not wait)
                void fireAndUpdateTaskStatus(apiKey, summary.summaryRange, summary.summaryTaskId);
                console.log(`memu-ext: summary-poller tick: summary is ${summary.summaryTaskStatus}, fire and update task status`, summary.summaryRange, summary.summaryTaskId);
                break;
            }
            case MemuTaskStatus.SUCCESS: {
                // clear summary info
                try {
                    if (memuExtras.retrieve?.nowRetrieve?.summaryTaskId === summary.summaryTaskId) {
                        console.log('memu-ext: summary-poller tick: retrieve data is already retrieved, do nothing');
                        break;
                    }
                    if (summary.isReady !== true) {
                        updateTaskSummaryStatus(apiKey, summary.summaryTaskId);
                        console.log('memu-ext: summary-poller tick: summary is success, update task summary status', summary.summaryTaskId);
                        break;
                    }
                    await retrieveMemories(summary);
                    console.log('memu-ext: summary-poller tick: summary is success, retrieve memories');
                } catch (error) {
                    console.error('memu-ext: summary-poller tick: summary is success, but retrieve memories failed', error);
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
                        console.warn('memu-ext: summary-poller tick: stale summary taskId (null); clearing saved summary state');
                        (memuExtras as any).summary = null;
                        await st.saveChat();
                        break;
                    }

                    // If the backend lost the task (e.g., plugin restarted and task store is in-memory),
                    // stop spamming the console and clear the saved summary state.
                    if (err === 'Unknown taskId') {
                        console.warn('memu-ext: summary-poller tick: stale summary taskId; clearing saved summary state');
                        (memuExtras as any).summary = null;
                        await st.saveChat();
                        break;
                    }

                    if (failCount >= MAX_SUMMARY_FAILURE_RETRIES) {
                        console.error('memu-ext: summary-poller tick: summary failed repeatedly; not retrying automatically', {
                            from,
                            to,
                            failCount,
                            error: err,
                        });
                        break;
                    }

                    console.log('memu-ext: summary-poller tick: summary is failure, retry summary', from, to);
                    memuExtras.summary = {
                        ...summary,
                        failureCount: failCount + 1,
                    };
                    await st.saveChat();
                    void doSummary(from, to);
                } else {
                    console.log('memu-ext: summary-poller tick: summary is failure, but range is not valid, do nothing');
                }
                break;
            }
            default: {
                break;
            }
        }
    } catch (error) {
        console.error('memu-ext: summary-poller tick error', error);
    }
}

function updateTaskSummaryStatus(apiKey: string, taskId?: string | null): void {
    if (!taskId) {
        console.error('memu-ext: updateTaskSummaryStatus: taskId is null');
        return;
    }
    getTaskSummaryReady(apiKey, DEFAULT_INTERVAL_MS / 2, taskId)
        .then(async (resp) => {
            console.log('memu-ext: updateTaskSummaryStatus: resp', resp);
            if (memuExtras.summary) {
                memuExtras.summary.isReady = resp.allReady === true;
                await st.saveChat();
            }
        })
        .catch((err) => {
            console.error('memu-ext: getTaskSummaryReady failed', err);
        });
}

function fireAndUpdateTaskStatus(apiKey: string, range: [number, number], taskId?: string | null): void {
    if (!taskId) {
        console.error('memu-ext: fireAndUpdateTaskStatus: taskId is null');
        return;
    }

    getTaskStatus(apiKey, DEFAULT_INTERVAL_MS / 2, taskId)
        .then(async (resp) => {
            console.log('memu-ext: fireAndUpdateTaskStatus: resp', resp);
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
                summaryRange: mapped === MemuTaskStatus.FAILURE ? [range[0], range[0]] : range,
                summaryTaskId: taskId,
                summaryTaskStatus: mapped,
                isReady: false,
                lastError: mapped === MemuTaskStatus.FAILURE ? (typeof err === 'string' ? err : undefined) : undefined,
                failureCount: mapped === MemuTaskStatus.FAILURE ? (memuExtras.summary?.failureCount ?? 0) : 0,
            };
            await st.saveChat();
        })
        .catch((err) => {
            console.error('memu-ext: getTaskStatus failed', err);
        });
}



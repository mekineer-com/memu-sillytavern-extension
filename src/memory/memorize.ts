import { CategoryResponse } from "memu-js";
import { API_KEY, PLUGIN_MODE, memuExtras, st, Message, MessageCollection, AUTO_SUMMARY_BY_CONTEXT_SIZE, SUMMARY_TURN } from "utils/context-extra";
import { memorizeConversation, retrieveDefaultCategories } from "utils/network";
import { ConversationMessage, MemuSummary, MemuTaskStatus, STEventData } from "utils/types";
import { sumTokens } from "./utils";

let isSummarying = false;

export async function summaryIfNeed(): Promise<void> {
    if (isSummarying) {
        return;
    }

    isSummarying = true;
    const from = (memuExtras.summary?.summaryRange?.[1] ?? -1) + 1;
    const chat = st.getContext().chat;

    // If a summary task is already running, let the poller handle it.
    if (memuExtras.summary && (memuExtras.summary.summaryTaskStatus === MemuTaskStatus.PENDING || memuExtras.summary.summaryTaskStatus === MemuTaskStatus.PROCESSING)) {
        isSummarying = false;
        return;
    }

    if (AUTO_SUMMARY_BY_CONTEXT_SIZE.get()) {
        const total = await sumTokens(from);
        console.log('memu-ext: now token accumulated: %d, max context: %d', total, st.getChatMaxContextSize());
        if (total >= st.getChatMaxContextSize()) {
            await doSummary(from, chat.length - 1);
        }
    } else {
        const summaryTurn = parseInt(SUMMARY_TURN.get());
        const nowTurn = chat.length - from;
        console.log('memu-ext: unsummarized turns: %d (cursor=%d, lastSummarized=%d), threshold: %d', nowTurn, from, from - 1, summaryTurn);
        if (nowTurn >= summaryTurn) {
            await doSummary(from, chat.length - 1);
        }
    }
    isSummarying = false;
}

export async function doSummary(from: number, to: number): Promise<void> {
    const mode = PLUGIN_MODE.get();
    const apiKey = mode === 'local' ? '' : API_KEY.get();
    if (mode !== 'local' && apiKey == null) {
        console.log('memu-ext: API key is not set (cloud mode)');
        return;
    }
    if (memuExtras.baseInfo == null) {
        console.log('memu-ext: baseInfo not found');
        return;
    }
    console.log('memu-ext: trigger memorize summary');

    try {
        const response = await memorizeConversation(
            apiKey,
            {
                messages: await prepareConversationData(from, to),
                userId: memuExtras.baseInfo.userId,
                userName: memuExtras.baseInfo.userName,
                characterId: memuExtras.baseInfo.characterId,
                characterName: memuExtras.baseInfo.characterName,
            },
        );
        console.log('memu-ext: memorize response', response);

        memuExtras.summary = {
            summaryRange: [from, to],
            summaryTaskId: response.taskId,
            summaryTaskStatus: MemuTaskStatus.PENDING,
            isReady: false,
            failureCount: 0,
            lastError: undefined,
        };
        await st.saveChat();
    } catch (error) {
        const prevRange = memuExtras.summary?.summaryRange ?? [-1, -1];
        memuExtras.summary = {
            // IMPORTANT: don't advance the cursor on failure.
            summaryRange: prevRange,
            summaryTaskId: null,
            summaryTaskStatus: MemuTaskStatus.FAILURE,
            isReady: false,
            failureCount: (memuExtras.summary?.failureCount ?? 0) + 1,
            lastError: error instanceof Error ? error.message : String(error),
        };
        await st.saveChat();
        console.error('memu-ext: memorize failed', error);
    }
}

export async function retrieveMemories(summary: MemuSummary): Promise<void> {
    const mode = PLUGIN_MODE.get();
    const apiKey = mode === 'local' ? '' : API_KEY.get();
    if (mode !== 'local' && apiKey == null) {
        console.log('memu-ext: API key is not set (cloud mode)');
        return;
    }
    console.log('memu-ext: trigger retrieve memories');
    try {
        const response = await retrieveDefaultCategories(
            apiKey,
            memuExtras.baseInfo.userId,
            memuExtras.baseInfo.characterId,
        );
        console.log('memu-ext: retrieve memories response', response);
        const retrieve = memuExtras.retrieve ?? {
            history: [],
        };
        if (retrieve.nowRetrieve != null) {
            retrieve.history.push(retrieve.nowRetrieve);
        }
        retrieve.nowRetrieve = {
            summaryRange: summary.summaryRange,
            summaryTaskId: summary.summaryTaskId ?? "undefined",
            summary: parseSummary(response.categories),
        };
        memuExtras.retrieve = retrieve;
        console.log('memu-ext: retrieve memories parsed', retrieve);
        await st.saveChat();
    } catch (error) {
        console.error('memu-ext: retrieve memories failed', error);
        throw error;
    }
}

export function addSummaryToPrompt(eventData: STEventData, replaceSystem: boolean = true): void {
    const memuSummary = memuExtras.retrieve?.nowRetrieve?.summary;
    if (!memuSummary) {
        console.log('memu-ext: no memu summary found');
        return;
    }
    if (replaceSystem) {
        const summary = findSystemSummary(st.promptManager.messages);
        if (summary) {
            console.log('memu-ext: found system summary', summary);
            replaceSystemSummary(summary, memuSummary, eventData);
            return;
        }
    }
    addSummary(memuSummary, eventData);
}

function replaceSystemSummary(summary: string, memuSummary: string, eventData: STEventData): void {
    eventData.chat.forEach(msg => {
        if (msg.content === summary) {
            console.log('memu-ext: found system summary in prompt', msg);
            msg.content = memuSummary;
            return;
        }
    });
}

function addSummary(memuSummary: string, eventData: STEventData): void {
    eventData.chat.unshift({
        role: 'system',
        content: memuSummary,
    });
    console.log('memu-ext: added memu summary to', eventData);
}

/**
 * @copy from @silly-tavern/scripts/openai.js
 *
 * Retrieves the chat as a flattened array of messages.
 * @returns {Array} The chat messages.
 */
function findSystemSummary(messages: MessageCollection): string {
    for (let item of messages.collection) {
        if (item instanceof MessageCollection) {
            const summary = findSystemSummary(item);
            if (summary) {
                return summary;
            }
        } else if (item instanceof Message && item.content) {
            if (item.identifier === 'summary') {
                return item.content;
            }
        } else {
            console.log(`Skipping invalid or empty message in collection: ${JSON.stringify(item)}`);
        }
    }
    return null;
}

function parseSummary(categories: CategoryResponse[]): string {
    return categories.map(category => `[${category.name}] ${category.summary}`).join('\n\n\n');
}

// function prepareConversationData(): ConversationMessage[] {
//     const chat = st.getContext().chat;
//     const chatInfo = memuExtras.baseInfo;
//     if (!chatInfo) {
//         throw new Error('memu-ext: chatInfo not found');
//     }

//     const messages: ConversationMessage[] = [];
//     for (const message of chat) {
//         messages.push({
//             role: message.is_user ? message.name === chatInfo.userName ? 'user' : 'participant' : 'assistant',
//             name: message.is_user && message.name !== chatInfo.userName ? message.name : undefined,
//             content: message.mes,
//         });
//     }
//     return messages;
// }

async function prepareConversationData(from: number, to: number): Promise<ConversationMessage[]> {
    const chat = st.getContext().chat;
    const chatInfo = memuExtras.baseInfo;
    if (!chatInfo) {
        throw new Error('memu-ext: chatInfo not found');
    }

    const canUseTools = st.toolManager.isToolCallingSupported();
    let coreChat = chat.slice(from, to).filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)));

    const messages: ConversationMessage[] = [];
    await Promise.all(coreChat.map(async (chatItem, index) => {
        let message = chatItem.mes;
        let regexType = chatItem.is_user ? st.regex_placement.USER_INPUT : st.regex_placement.AI_OUTPUT;
        let options = { isPrompt: true, depth: (coreChat.length - index - 1) };

        let regexedMessage = st.getRegexedString(message, regexType, options);
        regexedMessage = await st.appendFileContent(chatItem, regexedMessage);

        if (chatItem?.extra?.append_title && chatItem?.extra?.title) {
            regexedMessage = `${regexedMessage}\n\n${chatItem.extra.title}`;
        }

        messages.push({
            role: chatItem.is_user ? chatItem.name === memuExtras.baseInfo.userName ? 'user' : 'participant' : 'assistant',
            name: chatItem.is_user && chatItem.name !== memuExtras.baseInfo.userName ? chatItem.name : undefined,
            content: regexedMessage,
        });
    }));

    console.log('memu-ext: prepared conversation data', messages);
    return messages;
}

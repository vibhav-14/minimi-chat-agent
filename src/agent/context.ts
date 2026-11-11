import type { LlmMessage } from '../llm/types.js';
import { recall, type RecallResult } from '../memory/recall.js';
import { renderRecall } from '../memory/render.js';
import type { MemoryStore, Message } from '../memory/store.js';
import { SYSTEM_PROMPT } from './prompt.js';

// The last five exchanges of the conversation, verbatim, up to about 3,000
// tokens. Enough for follow-ups ("and the second one?"); older turns are
// still reachable through recall, which searches every stored message.
export const RECENT_MESSAGE_LIMIT = 10;
export const RECENT_CHAR_LIMIT = 12_000;

export interface ContextInput {
  store: MemoryStore;
  /** The stored user message being answered. */
  current: Message;
  now: Date;
  timeZone: string;
}

export interface AgentContext {
  system: string;
  messages: LlmMessage[];
  recall: RecallResult;
}

/**
 * Builds the model input: the stable system prompt, then a context message
 * (date and time, recalled history), the recent turns, and the message.
 * Stable text first keeps the request prefix cacheable.
 */
export function assembleContext(input: ContextInput): AgentContext {
  const { store, current, now, timeZone } = input;
  const recent = recentTurns(
    store
      .getMessages(current.conversationId)
      .filter((message) => message.id !== current.id),
  );
  const recalled = recall({
    message: current.content,
    now,
    timeZone,
    store,
    excludeIds: [...recent.map((message) => message.id), current.id],
  });

  const contextBlock = [
    `Current date and time: ${formatNow(now, timeZone)} (time zone ${timeZone}).`,
    renderRecall(recalled, timeZone),
  ].join('\n\n');

  return {
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', text: contextBlock },
      ...recent.map(toLlmMessage),
      { role: 'user', text: current.content },
    ],
    recall: recalled,
  };
}

/** The newest messages within both limits, oldest first, never starting with an answer. */
export function recentTurns(history: readonly Message[]): Message[] {
  const kept: Message[] = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (!message || kept.length === RECENT_MESSAGE_LIMIT) break;
    chars += message.content.length;
    if (chars > RECENT_CHAR_LIMIT) break;
    kept.unshift(message);
  }
  // An answer without its question reads as a non sequitur.
  if (kept[0]?.role === 'assistant') kept.shift();
  return kept;
}

function toLlmMessage(message: Message): LlmMessage {
  if (message.role === 'user') return { role: 'user', text: message.content };
  const sources = message.sources.map(
    (source) => `[${source.n}] ${source.url}`,
  );
  const text =
    sources.length > 0
      ? `${message.content}\n\n(Sources of this answer: ${sources.join(', ')})`
      : message.content;
  return { role: 'assistant', text, toolCalls: [] };
}

/** "Wednesday 11 November 2026, 17:30". */
function formatNow(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(now)
    .replace(' at ', ', ');
}

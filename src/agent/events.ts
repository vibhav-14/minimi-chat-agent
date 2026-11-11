import type { LlmErrorKind } from '../llm/types.js';
import type { Source } from '../search/sources.js';
import type { QueryReport } from '../search/tool.js';

/** A date phrase from the message and the local days (YYYY-MM-DD) it may mean. */
export interface RecalledDate {
  text: string;
  days: string[];
}

/** What a turn reports while it runs, in order. Sent to the browser as server-sent events. */
export type AgentEvent =
  /** First event: the conversation (new or existing) and the stored user message. */
  | { type: 'start'; conversationId: string; messageId: string }
  /** Memory was read: the dates understood, exchanges found, and dates with nothing stored. */
  | {
      type: 'recall';
      dates: RecalledDate[];
      exchanges: number;
      misses: string[];
    }
  | {
      type: 'search_started';
      callId: string;
      queries: string[];
      since?: string;
    }
  | {
      type: 'search_finished';
      callId: string;
      queries: QueryReport[];
      sourcesAdded: Source[];
    }
  | { type: 'token'; text: string }
  /** Every source the answer may cite, numbered as in the answer. */
  | { type: 'sources'; sources: Source[] }
  /** The answer is stored under `messageId`. */
  | { type: 'done'; messageId: string }
  /** The turn ended without an answer; the user message stays stored. */
  | { type: 'error'; kind: AgentErrorKind; message: string };

/** `config`: the server runs without API keys. */
export type AgentErrorKind = LlmErrorKind | 'config';

// Test doubles for the agent's boundaries, shared by the loop, route and
// sample-question tests. Not imported by application code.
import type {
  LlmEvent,
  LlmMessage,
  LlmProvider,
  LlmRequest,
} from '../llm/types.js';
import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
} from '../search/types.js';
import type { AgentEvent } from './events.js';

/** One scripted model step: the events to stream, or a function of the request. */
export type ScriptedStep =
  LlmEvent[] | ((request: LlmRequest) => AsyncIterable<LlmEvent> | LlmEvent[]);

export interface RecordedRequest extends Omit<LlmRequest, 'messages'> {
  /** A copy: the loop keeps appending to the array it passes. */
  messages: LlmMessage[];
}

/** A model that plays `steps` in order and records every request. */
export function scriptedLlm(steps: ScriptedStep[]) {
  const requests: RecordedRequest[] = [];
  const llm: LlmProvider = {
    async *stream(request) {
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
      });
      const step = steps[requests.length - 1];
      if (!step) throw new Error(`No scripted step ${requests.length}`);
      yield* typeof step === 'function' ? step(request) : step;
    },
  };
  return { llm, requests };
}

export const text = (value: string): LlmEvent => ({
  type: 'text',
  text: value,
});
export const stop: LlmEvent = { type: 'finish', reason: 'stop' };
export const searchCall = (
  id: string,
  args: unknown,
  name = 'web_search',
): LlmEvent => ({
  type: 'tool_call',
  call: { id, name, args },
});

/** A search provider answering from a table; a missing query finds nothing. */
export function tableSearch(
  table: Record<string, SearchResult[] | Error> = {},
) {
  const requests: SearchRequest[] = [];
  const search: SearchProvider = {
    search(request) {
      requests.push(request);
      const answer = table[request.query];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer ?? []);
    },
  };
  return { search, requests };
}

export async function collectEvents(
  events: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** The text of every user message the model received, joined. */
export function promptText(request: RecordedRequest | undefined): string {
  return (request?.messages ?? [])
    .map((message) => (message.role === 'user' ? message.text : ''))
    .join('\n');
}

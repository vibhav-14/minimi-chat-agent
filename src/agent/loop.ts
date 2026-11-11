import type { Clock } from '../clock.js';
import {
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type ToolCall,
  type ToolResult,
} from '../llm/types.js';
import type { RecallResult } from '../memory/recall.js';
import type { MemoryStore } from '../memory/store.js';
import { calendarDayAt, type DateRange } from '../memory/temporal.js';
import { SourceRegistry } from '../search/sources.js';
import {
  executeWebSearch,
  webSearchArgsSchema,
  webSearchTool,
} from '../search/tool.js';
import type { SearchProvider } from '../search/types.js';
import { assembleContext } from './context.js';
import type { AgentEvent, RecalledDate } from './events.js';
import { FINAL_STEP_NOTE } from './prompt.js';

/**
 * Model calls per turn. Enough for search, a follow-up search, and the
 * answer, with one step to spare for a corrected tool call; each step is a
 * round trip, so more would mostly add latency and free-tier usage.
 */
export const MAX_STEPS = 4;
const TITLE_LIMIT = 80;

export interface AgentDeps {
  llm: LlmProvider;
  search: SearchProvider;
  store: MemoryStore;
  clock: Clock;
}

export interface TurnInput {
  /** Omit to start a new conversation, titled from the message. */
  conversationId?: string;
  message: string;
  timeZone: string;
  signal?: AbortSignal;
}

/**
 * Runs one turn: store the message, recall, assemble, then let the model
 * search until it answers, and store the answer with its sources. Model
 * failures end the turn with an `error` event; a caller abort is thrown.
 */
export async function* runTurn(
  deps: AgentDeps,
  input: TurnInput,
): AsyncGenerator<AgentEvent> {
  const { store, clock } = deps;
  const { message, timeZone, signal } = input;

  const conversationId =
    input.conversationId ?? store.createConversation(titleOf(message)).id;
  const current = store.appendMessage({
    conversationId,
    role: 'user',
    content: message,
    timeZone,
  });
  yield { type: 'start', conversationId, messageId: current.id };

  const now = clock.now();
  const context = assembleContext({ store, current, now, timeZone });
  yield recallEvent(context.recall, timeZone);

  const registry = new SourceRegistry();
  const messages: LlmMessage[] = [...context.messages];
  let answer = '';

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      signal?.throwIfAborted();
      const last = step === MAX_STEPS;
      if (last) messages.push({ role: 'user', text: FINAL_STEP_NOTE });

      let text = '';
      const calls: ToolCall[] = [];
      for await (const event of deps.llm.stream({
        system: context.system,
        messages,
        tools: [webSearchTool],
        toolChoice: last ? 'none' : 'auto',
        signal,
      })) {
        if (event.type === 'text') {
          // Text from an earlier step ("Let me check.") stays a paragraph of its own.
          const delta =
            text === '' && answer !== '' ? `\n\n${event.text}` : event.text;
          text += event.text;
          answer += delta;
          yield { type: 'token', text: delta };
        } else if (event.type === 'tool_call') {
          calls.push(event.call);
        }
      }
      if (calls.length === 0 || last) break;

      messages.push({ role: 'assistant', text, toolCalls: calls });
      for (const call of calls) {
        const started = searchStarted(call);
        if (started) yield started;
      }
      // Every call of a step runs at once; results go back in call order.
      const results = await Promise.all(
        calls.map((call) => runTool(call, deps.search, registry, signal)),
      );
      for (const { event } of results) if (event) yield event;
      messages.push({ role: 'tool', results: results.map((r) => r.result) });
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    yield failure(error);
    return;
  }

  if (answer.trim() === '') {
    yield {
      type: 'error',
      kind: 'other',
      message: 'The model returned an empty answer. Please try again.',
    };
    return;
  }
  const sources = registry.list();
  const stored = store.appendMessage({
    conversationId,
    role: 'assistant',
    content: answer,
    timeZone,
    sources,
  });
  yield { type: 'sources', sources };
  yield { type: 'done', messageId: stored.id };
}

interface ToolRun {
  result: ToolResult;
  event?: AgentEvent;
}

async function runTool(
  call: ToolCall,
  search: SearchProvider,
  registry: SourceRegistry,
  signal: AbortSignal | undefined,
): Promise<ToolRun> {
  if (call.name !== webSearchTool.name) {
    return {
      result: {
        callId: call.id,
        name: call.name,
        content: `Unknown tool "${call.name}". The only tool is ${webSearchTool.name}.`,
        isError: true,
      },
    };
  }
  const outcome = await executeWebSearch(call.args, {
    provider: search,
    registry,
    signal,
  });
  return {
    result: { callId: call.id, name: call.name, content: outcome.text },
    event: {
      type: 'search_finished',
      callId: call.id,
      queries: outcome.queries,
      sourcesAdded: outcome.sourcesAdded,
    },
  };
}

/** Announces a valid web_search call; an invalid one is only reported to the model. */
function searchStarted(call: ToolCall): AgentEvent | null {
  if (call.name !== webSearchTool.name) return null;
  const parsed = webSearchArgsSchema.safeParse(call.args);
  if (!parsed.success) return null;
  return {
    type: 'search_started',
    callId: call.id,
    queries: parsed.data.queries,
    ...(parsed.data.since && { since: parsed.data.since }),
  };
}

function recallEvent(result: RecallResult, timeZone: string): AgentEvent {
  const dates: RecalledDate[] = result.references.map((reference) => ({
    text: reference.text,
    days: reference.candidates.map((range) => isoDay(range, timeZone)),
  }));
  const exchanges =
    result.byDate.reduce((sum, match) => sum + match.exchanges.length, 0) +
    result.byTopic.length +
    result.misses.reduce((sum, miss) => sum + miss.nearest.length, 0);
  return {
    type: 'recall',
    dates,
    exchanges,
    misses: result.misses.map((miss) => miss.reference.text),
  };
}

function isoDay(range: DateRange, timeZone: string): string {
  const { year, month, day } = calendarDayAt(range.from, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function failure(error: unknown): AgentEvent {
  if (error instanceof LlmError) {
    console.error(`Model call failed (${error.kind}): ${error.message}`);
    return { type: 'error', kind: error.kind, message: userMessage(error) };
  }
  console.error('Turn failed:', error);
  return {
    type: 'error',
    kind: 'other',
    message: 'Something went wrong while answering. Please try again.',
  };
}

function userMessage(error: LlmError): string {
  switch (error.kind) {
    case 'rate_limit':
      return 'The Gemini free tier limit was hit. Wait a few seconds and try again.';
    case 'quota':
      return 'The Gemini daily free quota is used up. It resets at midnight Pacific time.';
    case 'auth':
    case 'timeout':
    case 'other':
      return error.message;
  }
}

function titleOf(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= TITLE_LIMIT
    ? flat
    : `${flat.slice(0, TITLE_LIMIT).trimEnd()}…`;
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { LlmError, type LlmEvent } from '../llm/types.js';
import { MemoryStore } from '../memory/store.js';
import { SearchError, type SearchProvider } from '../search/types.js';
import { runTurn, MAX_STEPS, type AgentDeps } from './loop.js';
import { FINAL_STEP_NOTE } from './prompt.js';
import {
  collectEvents,
  scriptedLlm,
  searchCall,
  stop,
  tableSearch,
  text,
  type ScriptedStep,
} from './testing.js';

const NOW = new Date('2026-11-11T12:00:00Z');
const ZONE = 'Asia/Kolkata';

let store: MemoryStore;

beforeEach(() => {
  store = MemoryStore.open(':memory:', fixedClock(NOW));
});

afterEach(() => {
  store.close();
});

const pricing = {
  'Neon pricing': [
    {
      title: 'Neon pricing',
      url: 'https://neon.test/pricing',
      content: 'Launch plan: $19 a month.',
    },
  ],
  'Supabase pricing': [
    {
      title: 'Supabase pricing',
      url: 'https://supabase.test/pricing',
      content: 'Pro plan: $25 a month.',
    },
  ],
};

function turn(
  steps: ScriptedStep[],
  search: SearchProvider = tableSearch(pricing).search,
  message = 'What does Neon cost?',
  signal?: AbortSignal,
) {
  const { llm, requests } = scriptedLlm(steps);
  const deps: AgentDeps = { llm, search, store, clock: fixedClock(NOW) };
  return {
    requests,
    events: runTurn(deps, { message, timeZone: ZONE, signal }),
  };
}

const types = (events: { type: string }[]) => events.map((e) => e.type);

function storedMessages() {
  const [conversation] = store.listConversations();
  return conversation ? store.getMessages(conversation.id) : [];
}

/** The text of the tool result the model got back in request `index`. */
function toolResultText(
  requests: ReturnType<typeof scriptedLlm>['requests'],
  index: number,
) {
  const last = requests[index]?.messages.findLast((m) => m.role === 'tool');
  return last?.role === 'tool' ? last.results : [];
}

describe('runTurn', () => {
  it('answers without searching and stores the answer', async () => {
    const { events } = turn(
      [[text('Hello'), text(' there.'), stop]],
      undefined,
      'Hi',
    );

    const all = await collectEvents(events);

    expect(types(all)).toEqual([
      'start',
      'recall',
      'token',
      'token',
      'sources',
      'done',
    ]);
    expect(all.at(-2)).toEqual({ type: 'sources', sources: [] });
    expect(storedMessages().map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello there.'],
    ]);
    expect(store.listConversations()[0]?.title).toBe('Hi');
  });

  it('searches, feeds results back, and stores numbered sources with snippets', async () => {
    const { events, requests } = turn([
      [searchCall('c1', { queries: ['Neon pricing'] }), stop],
      [text('Neon Launch is $19 a month [1].'), stop],
    ]);

    const all = await collectEvents(events);

    expect(types(all)).toEqual([
      'start',
      'recall',
      'search_started',
      'search_finished',
      'token',
      'sources',
      'done',
    ]);
    expect(all[2]).toEqual({
      type: 'search_started',
      callId: 'c1',
      queries: ['Neon pricing'],
    });
    const [result] = toolResultText(requests, 1);
    expect(result?.callId).toBe('c1');
    expect(result?.content).toContain(
      '[1] Neon pricing — https://neon.test/pricing',
    );

    const source = {
      n: 1,
      url: 'https://neon.test/pricing',
      title: 'Neon pricing',
      snippet: 'Launch plan: $19 a month.',
    };
    expect(all.at(-2)).toEqual({ type: 'sources', sources: [source] });
    const answer = storedMessages()[1];
    expect(answer?.content).toBe('Neon Launch is $19 a month [1].');
    expect(answer?.sources).toEqual([source]);
  });

  // Sequential searches would double the wait on a five-way fan-out.
  it('runs every tool call of a step concurrently', async () => {
    let started = 0;
    let release: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => (release = resolve));
    const search: SearchProvider = {
      async search(request) {
        if (++started === 2) release();
        // Each search waits for the other to start: run one at a time, this never settles.
        await bothStarted;
        return pricing[request.query as keyof typeof pricing];
      },
    };
    const { events, requests } = turn(
      [
        [
          searchCall('a', { queries: ['Neon pricing'] }),
          searchCall('b', { queries: ['Supabase pricing'] }),
          stop,
        ],
        [text('Both found.'), stop],
      ],
      search,
    );

    const all = await collectEvents(events);

    expect(types(all).slice(2, 6)).toEqual([
      'search_started',
      'search_started',
      'search_finished',
      'search_finished',
    ]);
    expect(toolResultText(requests, 1).map((r) => r.callId)).toEqual([
      'a',
      'b',
    ]);
    expect(storedMessages()[1]?.sources.map((s) => s.url)).toEqual([
      'https://neon.test/pricing',
      'https://supabase.test/pricing',
    ]);
  });

  it(`stops after ${MAX_STEPS} model steps and makes the last one answer`, async () => {
    const searching = [searchCall('c', { queries: ['Neon pricing'] }), stop];
    const { events, requests } = turn([
      searching,
      searching,
      searching,
      [text('Could not verify everything.'), stop],
    ]);

    await collectEvents(events);

    expect(requests).toHaveLength(MAX_STEPS);
    expect(requests.slice(0, -1).map((r) => r.toolChoice)).toEqual([
      'auto',
      'auto',
      'auto',
    ]);
    expect(requests.at(-1)?.toolChoice).toBe('none');
    expect(requests.at(-1)?.messages.at(-1)).toEqual({
      role: 'user',
      text: FINAL_STEP_NOTE,
    });
    expect(storedMessages()[1]?.content).toBe('Could not verify everything.');
  });

  it('reports an invalid or unknown tool call to the model, which corrects it', async () => {
    const { search, requests: searches } = tableSearch(pricing);
    const { events, requests } = turn(
      [
        [
          searchCall('bad', { queries: [] }),
          searchCall('odd', {}, 'browse'),
          stop,
        ],
        [searchCall('good', { queries: ['Neon pricing'] }), stop],
        [text('Neon is $19 [1].'), stop],
      ],
      search,
    );

    const all = await collectEvents(events);

    const [invalid, unknown] = toolResultText(requests, 1);
    expect(invalid?.content).toContain('Invalid web_search arguments');
    expect(unknown).toMatchObject({
      callId: 'odd',
      name: 'browse',
      isError: true,
    });
    expect(unknown?.content).toContain('The only tool is web_search');
    expect(all.filter((e) => e.type === 'search_started')).toEqual([
      { type: 'search_started', callId: 'good', queries: ['Neon pricing'] },
    ]);
    expect(searches.map((r) => r.query)).toEqual(['Neon pricing']);
    expect(storedMessages()[1]?.content).toBe('Neon is $19 [1].');
  });

  it('tells the model when a search fails', async () => {
    const { search } = tableSearch({
      'Neon pricing': new SearchError('quota', 'Plan limit reached.'),
    });
    const { events, requests } = turn(
      [
        [searchCall('c1', { queries: ['Neon pricing'] }), stop],
        [text('Search is unavailable, so I could not check.'), stop],
      ],
      search,
    );

    const all = await collectEvents(events);

    expect(toolResultText(requests, 1)[0]?.content).toContain(
      'Search failed (quota): Plan limit reached.',
    );
    expect(all.find((e) => e.type === 'search_finished')).toMatchObject({
      queries: [{ query: 'Neon pricing', status: 'failed', kind: 'quota' }],
    });
  });

  it('separates text from different steps', async () => {
    const { events } = turn([
      [
        text('Let me check.'),
        searchCall('c1', { queries: ['Neon pricing'] }),
        stop,
      ],
      [text('It is $19 [1].'), stop],
    ]);

    await collectEvents(events);

    expect(storedMessages()[1]?.content).toBe(
      'Let me check.\n\nIt is $19 [1].',
    );
  });

  it('ends with a plain error on a rate limit and keeps the question stored', async () => {
    const { events } = turn([
      // eslint-disable-next-line require-yield
      async function* (): AsyncGenerator<LlmEvent> {
        await Promise.resolve();
        throw new LlmError('rate_limit', 'HTTP 429');
      },
    ]);

    const all = await collectEvents(events);

    expect(all.at(-1)).toEqual({
      type: 'error',
      kind: 'rate_limit',
      message: expect.stringContaining('free tier limit') as string,
    });
    expect(storedMessages().map((m) => m.role)).toEqual(['user']);
  });

  it('propagates an abort mid-stream and stores no answer', async () => {
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    const { events } = turn(
      [
        async function* (request): AsyncGenerator<LlmEvent> {
          yield text('Partial');
          controller.abort(reason);
          await Promise.resolve();
          // What the real adapter does once its request is aborted.
          throw request.signal?.reason;
        },
      ],
      undefined,
      undefined,
      controller.signal,
    );
    const seen: string[] = [];

    const run = async () => {
      for await (const event of events) seen.push(event.type);
    };

    await expect(run()).rejects.toBe(reason);
    expect(seen).toEqual(['start', 'recall', 'token']);
    expect(storedMessages().map((m) => m.role)).toEqual(['user']);
  });

  it('continues an existing conversation with its recent turns', async () => {
    const { id } = store.createConversation('Postgres');
    store.appendMessage({
      conversationId: id,
      role: 'user',
      content: 'Neon?',
      timeZone: ZONE,
    });
    store.appendMessage({
      conversationId: id,
      role: 'assistant',
      content: 'Free plan.',
      timeZone: ZONE,
    });
    const { llm, requests } = scriptedLlm([[text('Yes.'), stop]]);

    const all = await collectEvents(
      runTurn(
        { llm, search: tableSearch().search, store, clock: fixedClock(NOW) },
        { conversationId: id, message: 'Still free?', timeZone: ZONE },
      ),
    );

    expect(all[0]).toMatchObject({ type: 'start', conversationId: id });
    expect(requests[0]?.messages.slice(1)).toEqual([
      { role: 'user', text: 'Neon?' },
      { role: 'assistant', text: 'Free plan.', toolCalls: [] },
      { role: 'user', text: 'Still free?' },
    ]);
    expect(store.listConversations()).toHaveLength(1);
  });
});

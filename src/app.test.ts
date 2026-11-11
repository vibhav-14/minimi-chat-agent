import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from './agent/events.js';
import {
  scriptedLlm,
  searchCall,
  stop,
  tableSearch,
  text,
  type ScriptedStep,
} from './agent/testing.js';
import { createApp, type AppDeps } from './app.js';
import { fixedClock } from './clock.js';
import type { LlmEvent } from './llm/types.js';
import { MemoryStore } from './memory/store.js';

// The real UI directory, wired the same way server.ts wires it.
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const NOW = new Date('2026-11-11T12:00:00Z');
const clock = fixedClock(NOW);

let store: MemoryStore;

beforeEach(() => {
  store = MemoryStore.open(':memory:', clock);
});

afterEach(() => {
  store.close();
});

function appWith(steps: ScriptedStep[] = [], providers?: AppDeps['providers']) {
  const { llm, requests } = scriptedLlm(steps);
  const app = createApp({
    publicDir,
    store,
    clock,
    defaultTimeZone: 'Europe/London',
    providers: providers ?? {
      llm,
      search: tableSearch({
        'Neon pricing': [
          { title: 'Neon', url: 'https://neon.test', content: '$19' },
        ],
      }).search,
    },
  });
  return { app, requests };
}

function chat(app: ReturnType<typeof appWith>['app'], body: unknown) {
  return app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Parses a server-sent event body into the events it carries. */
async function events(res: Response): Promise<AgentEvent[]> {
  const body = await res.text();
  return body
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n');
      const name = lines.find((l) => l.startsWith('event: '))?.slice(7);
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? '';
      const event = JSON.parse(data) as AgentEvent;
      expect(name).toBe(event.type);
      return event;
    });
}

describe('createApp', () => {
  it('reports status ok on the health route', async () => {
    const res = await appWith().app.request('/api/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves the UI page at the root', async () => {
    const res = await appWith().app.request('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<title>minimi chat</title>');
  });

  it('answers unknown API paths with JSON 404, not the UI page', async () => {
    const res = await appWith().app.request('/api/nope');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});

describe('POST /api/chat', () => {
  it('streams a turn as server-sent events and starts a conversation', async () => {
    const { app } = appWith([
      [searchCall('c1', { queries: ['Neon pricing'] }), stop],
      [text('Neon is $19 [1].'), stop],
    ]);

    const res = await chat(app, { message: '  What does Neon cost?  ' });

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const all = await events(res);
    expect(all.map((e) => e.type)).toEqual([
      'start',
      'recall',
      'search_started',
      'search_finished',
      'token',
      'sources',
      'done',
    ]);
    const [conversation] = store.listConversations();
    expect(all[0]).toMatchObject({ conversationId: conversation?.id });
    expect(conversation?.title).toBe('What does Neon cost?');
  });

  it.each([
    ['the browser zone when it is valid', 'Asia/Kolkata', 'Asia/Kolkata'],
    ['the default zone when it is unknown', 'Mars/Base', 'Europe/London'],
    ['the default zone when none is sent', undefined, 'Europe/London'],
  ])('reads dates in %s', async (_, timeZone, expected) => {
    const { app } = appWith([[text('Hi.'), stop]]);

    await events(await chat(app, { message: 'Hello', timeZone }));

    const [conversation] = store.listConversations();
    const messages = store.getMessages(conversation?.id ?? '');
    expect(messages.map((m) => m.timeZone)).toEqual([expected, expected]);
  });

  it('continues a stored conversation', async () => {
    const { id } = store.createConversation('Earlier');
    const { app } = appWith([[text('Yes.'), stop]]);

    const all = await events(
      await chat(app, { conversationId: id, message: 'Again?' }),
    );

    expect(all[0]).toMatchObject({ type: 'start', conversationId: id });
    expect(store.getMessages(id)).toHaveLength(2);
  });

  it.each([
    ['an empty message', { message: '   ' }, 400],
    ['no message', {}, 400],
    ['an unknown conversation', { conversationId: 'x', message: 'Hi' }, 404],
  ])('rejects %s', async (_, body, status) => {
    const res = await chat(appWith().app, body);

    expect(res.status).toBe(status);
    expect(await res.json()).toHaveProperty('error');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await appWith().app.request('/api/chat', {
      method: 'POST',
      body: 'hello',
    });

    expect(res.status).toBe(400);
  });

  // Without keys the page must still load and say what to fix.
  it('answers with the config message as an error event when keys are missing', async () => {
    const { app } = appWith([], {
      unavailable: 'GEMINI_API_KEY is not set. Copy .env.example to .env.',
    });

    const all = await events(await chat(app, { message: 'Hello' }));

    expect(all).toEqual([
      {
        type: 'error',
        kind: 'config',
        message: 'GEMINI_API_KEY is not set. Copy .env.example to .env.',
      },
    ]);
    expect(store.listConversations()).toEqual([]);
  });

  it('aborts the turn when the client disconnects', async () => {
    let aborted: (reason: unknown) => void = () => undefined;
    const sawAbort = new Promise((resolve) => (aborted = resolve));
    const { app } = appWith([
      async function* (request): AsyncGenerator<LlmEvent> {
        yield text('Partial');
        // Like a real request: fail once the signal aborts, even if it already has.
        const signal = request.signal;
        await new Promise((_, reject) => {
          const fail = () => {
            aborted(signal?.reason);
            reject(signal?.reason as Error);
          };
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail);
        });
      },
    ]);

    const res = await chat(app, { message: 'Hello' });
    const reader = res.body?.getReader() as
      ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Read until the model is mid-answer, then close the connection.
    const decoder = new TextDecoder();
    let received = '';
    while (reader && !received.includes('event: token')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    await reader?.cancel();

    await expect(sawAbort).resolves.toBeInstanceOf(Error);
    const [conversation] = store.listConversations();
    expect(store.getMessages(conversation?.id ?? '')).toHaveLength(1);
  });
});

describe('conversation routes', () => {
  it('lists conversations newest first', async () => {
    store.createConversation('older', new Date('2026-11-01T00:00:00Z'));
    store.createConversation('newer', new Date('2026-11-05T00:00:00Z'));

    const res = await appWith().app.request('/api/conversations');

    expect(res.status).toBe(200);
    const list = (await res.json()) as { title: string; createdAt: string }[];
    expect(list.map((c) => [c.title, c.createdAt])).toEqual([
      ['newer', '2026-11-05T00:00:00.000Z'],
      ['older', '2026-11-01T00:00:00.000Z'],
    ]);
  });

  it('returns one conversation with its messages and sources', async () => {
    const { id } = store.createConversation('Neon');
    store.appendMessage({
      conversationId: id,
      role: 'user',
      content: 'Neon?',
      timeZone: 'UTC',
    });
    const source = {
      n: 1,
      url: 'https://neon.test',
      title: 'Neon',
      snippet: '$19',
    };
    store.appendMessage({
      conversationId: id,
      role: 'assistant',
      content: '$19 [1].',
      timeZone: 'UTC',
      sources: [source],
    });

    const res = await appWith().app.request(`/api/conversations/${id}`);

    expect(await res.json()).toMatchObject({
      id,
      title: 'Neon',
      messages: [
        { role: 'user', content: 'Neon?', sources: [] },
        { role: 'assistant', content: '$19 [1].', sources: [source] },
      ],
    });
  });

  it('answers 404 for an unknown conversation', async () => {
    const res = await appWith().app.request('/api/conversations/missing');

    expect(res.status).toBe(404);
  });
});

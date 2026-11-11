import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { MemoryStore, type Source } from './store.js';

const NOW = new Date('2026-11-11T12:00:00Z');
const ZONE = 'Europe/London';

let store: MemoryStore;

beforeEach(() => {
  store = MemoryStore.open(':memory:', fixedClock(NOW));
});

afterEach(() => {
  store.close();
});

function at(iso: string): Date {
  return new Date(iso);
}

/** Stores a question at `iso` and, unless `answer` is null, its answer a minute later. */
function exchange(
  conversationId: string,
  iso: string,
  question: string,
  answer: string | null,
  sources: Source[] = [],
) {
  const asked = store.appendMessage({
    conversationId,
    role: 'user',
    content: question,
    timeZone: ZONE,
    createdAt: at(iso),
  });
  if (answer === null) return { asked, answered: null };
  const answered = store.appendMessage({
    conversationId,
    role: 'assistant',
    content: answer,
    timeZone: ZONE,
    sources,
    createdAt: new Date(at(iso).getTime() + 60_000),
  });
  return { asked, answered };
}

describe('MemoryStore', () => {
  it('round-trips a conversation and its messages, sources included', () => {
    const conversation = store.createConversation('CRM shortlist');
    const sources = [
      {
        n: 1,
        url: 'https://example.com/pricing',
        title: 'Pricing',
        publishedDate: '2026-11-01',
      },
    ];
    exchange(
      conversation.id,
      '2026-11-09T10:00:00Z',
      'Which CRM?',
      'HubSpot',
      sources,
    );

    expect(store.listConversations()).toEqual([
      { id: conversation.id, title: 'CRM shortlist', createdAt: NOW },
    ]);
    const messages = store.getMessages(conversation.id);
    expect(messages.map((m) => [m.role, m.content, m.sources])).toEqual([
      ['user', 'Which CRM?', []],
      ['assistant', 'HubSpot', sources],
    ]);
    expect(messages[0]?.timeZone).toBe(ZONE);
    expect(messages[0]?.createdAt).toEqual(at('2026-11-09T10:00:00Z'));
  });

  it('timestamps from the clock when no time is given', () => {
    const { id } = store.createConversation('Now');
    const message = store.appendMessage({
      conversationId: id,
      role: 'user',
      content: 'hi',
      timeZone: ZONE,
    });
    expect(message.createdAt).toEqual(NOW);
    expect(store.getMessages(id)[0]?.createdAt).toEqual(NOW);
  });

  it('keeps messages in time order, and insertion order within one millisecond', () => {
    const { id } = store.createConversation('Order');
    const append = (content: string, iso: string) =>
      store.appendMessage({
        conversationId: id,
        role: 'user',
        content,
        timeZone: ZONE,
        createdAt: at(iso),
      });
    append('second', '2026-11-02T00:00:00Z');
    append('first', '2026-11-01T00:00:00Z');
    append('third', '2026-11-02T00:00:00Z');

    expect(store.getMessages(id).map((m) => m.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('lists conversations newest first', () => {
    store.createConversation('older', at('2026-11-01T00:00:00Z'));
    store.createConversation('newer', at('2026-11-05T00:00:00Z'));
    expect(store.listConversations().map((c) => c.title)).toEqual([
      'newer',
      'older',
    ]);
  });

  // The chat route answers 404 for a conversation id that is not stored.
  it('gets one conversation by id, or null', () => {
    const created = store.createConversation('one', at('2026-11-01T00:00:00Z'));
    expect(store.getConversation(created.id)).toEqual(created);
    expect(store.getConversation('missing')).toBeNull();
  });

  it('pairs each question with its answer, and leaves an unanswered one without', () => {
    const { id } = store.createConversation('Pairs');
    exchange(id, '2026-11-09T10:00:00Z', 'answered', 'yes');
    exchange(id, '2026-11-09T11:00:00Z', 'unanswered', null);
    exchange(id, '2026-11-09T12:00:00Z', 'answered later', 'also yes');

    const found = store.exchangesBetween({
      from: at('2026-11-09T00:00:00Z'),
      to: at('2026-11-10T00:00:00Z'),
    });
    expect(
      found.map((e) => [e.question.content, e.answer?.content ?? null]),
    ).toEqual([
      ['answered', 'yes'],
      ['unanswered', null],
      ['answered later', 'also yes'],
    ]);
  });

  it('never pairs a question with an answer from another conversation', () => {
    const a = store.createConversation('A');
    const b = store.createConversation('B');
    exchange(a.id, '2026-11-09T10:00:00Z', 'question in A', null);
    exchange(b.id, '2026-11-09T10:00:30Z', 'question in B', 'answer in B');

    const found = store.exchangesBetween({
      from: at('2026-11-09T00:00:00Z'),
      to: at('2026-11-10T00:00:00Z'),
    });
    expect(found.map((e) => e.answer?.content ?? null)).toEqual([
      null,
      'answer in B',
    ]);
  });

  it('includes a question asked exactly at the range start and excludes one at the end', () => {
    const { id } = store.createConversation('Edges');
    exchange(id, '2026-11-08T23:59:59.999Z', 'before', 'x');
    exchange(id, '2026-11-09T00:00:00.000Z', 'at start', 'x');
    exchange(id, '2026-11-09T23:59:59.999Z', 'last moment', 'x');
    exchange(id, '2026-11-10T00:00:00.000Z', 'at end', 'x');

    const found = store.exchangesBetween({
      from: at('2026-11-09T00:00:00Z'),
      to: at('2026-11-10T00:00:00Z'),
    });
    expect(found.map((e) => e.question.content)).toEqual([
      'at start',
      'last moment',
    ]);
  });

  it('finds exchanges by words in the question or the answer, best match first', () => {
    const { id } = store.createConversation('Topics');
    exchange(
      id,
      '2026-11-03T10:00:00Z',
      'Postgres hosting options?',
      'Neon, Supabase and RDS.',
    );
    exchange(
      id,
      '2026-11-04T10:00:00Z',
      'Best CRM?',
      'HubSpot has good pricing.',
    );
    exchange(id, '2026-11-05T10:00:00Z', 'Weather?', 'Sunny.');

    expect(
      store
        .searchExchanges('postgres hosting', 5)
        .map((e) => e.question.content),
    ).toEqual(['Postgres hosting options?']);
    // Matches the answer, and stemming matches "prices" to "pricing".
    expect(
      store.searchExchanges('prices', 5).map((e) => e.question.content),
    ).toEqual(['Best CRM?']);
  });

  it('returns each exchange once even when question and answer both match', () => {
    const { id } = store.createConversation('Once');
    exchange(id, '2026-11-03T10:00:00Z', 'Postgres?', 'Postgres is great.');
    expect(store.searchExchanges('postgres', 5)).toHaveLength(1);
  });

  // Quotes, operators and brackets that a search query language would parse.
  it.each([
    ['what about "Postgres', 1],
    ['NOT postgres AND (hosting OR', 1],
    ['postgres* NEAR(hosting) ^col:x', 1],
    ["it's -- 100% {weird} [stuff]", 0],
  ])('treats hostile search text as plain words: %s', (query, count) => {
    const { id } = store.createConversation('Hostile');
    exchange(id, '2026-11-03T10:00:00Z', 'Postgres hosting?', 'Neon.');
    expect(store.searchExchanges(query, 5)).toHaveLength(count);
  });

  it('returns nothing for search text with no words', () => {
    expect(store.searchExchanges('?!" ()', 5)).toEqual([]);
  });

  it('returns the exchanges closest in time, closest first', () => {
    const { id } = store.createConversation('Near');
    exchange(id, '2026-11-01T10:00:00Z', 'far before', 'x');
    exchange(id, '2026-11-03T20:00:00Z', 'just after', 'x');
    exchange(id, '2026-11-02T10:00:00Z', 'just before', 'x');
    exchange(id, '2026-11-10T10:00:00Z', 'far after', 'x');

    const found = store.nearestExchanges(at('2026-11-03T10:00:00Z'), 2);
    expect(found.map((e) => e.question.content)).toEqual([
      'just after',
      'just before',
    ]);
  });
});

describe('MemoryStore on disk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the data directory and keeps data across reopening', () => {
    const path = join(dir, 'nested', 'memory.db');
    const first = MemoryStore.open(path, fixedClock(NOW));
    first.createConversation('kept');
    first.close();

    const second = MemoryStore.open(path, fixedClock(NOW));
    expect(second.listConversations().map((c) => c.title)).toEqual(['kept']);
    second.close();
  });
});

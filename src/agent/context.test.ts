import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { MemoryStore, type Message } from '../memory/store.js';
import {
  assembleContext,
  RECENT_CHAR_LIMIT,
  RECENT_MESSAGE_LIMIT,
  recentTurns,
} from './context.js';
import { SYSTEM_PROMPT } from './prompt.js';

// Wednesday 11 November 2026, 17:30 in Kolkata.
const NOW = new Date('2026-11-11T12:00:00Z');
const ZONE = 'Asia/Kolkata';

let store: MemoryStore;

beforeEach(() => {
  store = MemoryStore.open(':memory:', fixedClock(NOW));
});

afterEach(() => {
  store.close();
});

function say(
  conversationId: string,
  role: Message['role'],
  content: string,
  minutesAgo: number,
): Message {
  return store.appendMessage({
    conversationId,
    role,
    content,
    timeZone: ZONE,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    ...(role === 'assistant' && {
      sources: [{ n: 1, url: 'https://neon.test/pricing', title: 'Neon' }],
    }),
  });
}

describe('assembleContext', () => {
  it('orders system prompt, context block, recent turns, then the message', () => {
    const { id } = store.createConversation('Postgres');
    say(id, 'user', 'Which Postgres host is cheapest?', 10);
    say(id, 'assistant', 'Neon has a free plan [1].', 9);
    const current = say(id, 'user', 'And the second cheapest?', 0);

    const context = assembleContext({
      store,
      current,
      now: NOW,
      timeZone: ZONE,
    });

    expect(context.system).toBe(SYSTEM_PROMPT);
    expect(context.messages).toEqual([
      { role: 'user', text: expect.any(String) as string },
      { role: 'user', text: 'Which Postgres host is cheapest?' },
      {
        role: 'assistant',
        text: 'Neon has a free plan [1].\n\n(Sources of this answer: [1] https://neon.test/pricing)',
        toolCalls: [],
      },
      { role: 'user', text: 'And the second cheapest?' },
    ]);
    const block =
      context.messages[0]?.role === 'user' ? context.messages[0].text : '';
    expect(block).toMatch(
      /^Current date and time: Wednesday,? 11 November 2026,? 17:30 \(time zone Asia\/Kolkata\)\.\n\n<recalled_history>/,
    );
  });

  // Turns already in the prompt must not be repeated as recalled history.
  it('excludes recent turns and the current message from recall', () => {
    const old = store.createConversation('old');
    say(old.id, 'user', 'Compare Postgres hosting prices.', 60 * 24 * 3);
    say(old.id, 'assistant', 'Supabase Pro is $25.', 60 * 24 * 3 - 1);
    const { id } = store.createConversation('now');
    say(id, 'user', 'Postgres hosting with branching?', 5);
    say(id, 'assistant', 'Neon supports branching.', 4);
    const current = say(id, 'user', 'Postgres hosting prices again?', 0);

    const { recall } = assembleContext({
      store,
      current,
      now: NOW,
      timeZone: ZONE,
    });

    expect(recall.byTopic.map((e) => e.question.content)).toEqual([
      'Compare Postgres hosting prices.',
    ]);
  });
});

describe('recentTurns', () => {
  const message = (i: number, content = `message ${i}`): Message => ({
    id: String(i),
    conversationId: 'c',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content,
    createdAt: new Date(i),
    timeZone: ZONE,
    sources: [],
  });

  it(`keeps the newest ${RECENT_MESSAGE_LIMIT} messages, oldest first`, () => {
    const history = Array.from({ length: 30 }, (_, i) => message(i));
    const kept = recentTurns(history);
    expect(kept.map((m) => m.id)).toEqual([
      '20',
      '21',
      '22',
      '23',
      '24',
      '25',
      '26',
      '27',
      '28',
      '29',
    ]);
  });

  it('stops at the character limit and never starts with an answer', () => {
    const big = 'x'.repeat(RECENT_CHAR_LIMIT / 2);
    // 0 user, 1 assistant (big), 2 user (big), 3 assistant: 1 crosses the limit.
    const history = [message(0), message(1, big), message(2, big), message(3)];
    expect(recentTurns(history).map((m) => m.id)).toEqual(['2', '3']);
  });

  it('drops a leading answer whose question fell outside the window', () => {
    const big = 'x'.repeat(RECENT_CHAR_LIMIT - 10);
    const history = [message(0, big), message(1), message(2)];
    expect(recentTurns(history).map((m) => m.id)).toEqual(['2']);
  });
});

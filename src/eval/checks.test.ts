import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent/events.js';
import { check, citedNumbers, summarize, type TimedEvent } from './checks.js';

const source = (n: number) => ({
  n,
  url: `https://example.com/${n}`,
  title: `Page ${n}`,
});

function timed(events: AgentEvent[]): TimedEvent[] {
  return events.map((event, i) => ({ event, at: i * 100 }));
}

const answered = timed([
  { type: 'start', conversationId: 'c', messageId: 'm' },
  { type: 'recall', dates: [], exchanges: 1, misses: [] },
  { type: 'search_started', callId: 'a', queries: ['pipedrive pricing'] },
  { type: 'token', text: 'Pipedrive now costs $14 [1]' },
  { type: 'token', text: ', HubSpot is unchanged [1, 2].' },
  { type: 'sources', sources: [source(1), source(2)] },
  { type: 'done', messageId: 'a1' },
]);

describe('citedNumbers', () => {
  it('reads single and grouped citations', () => {
    expect(citedNumbers('a [1] b [2, 3] c [10]')).toEqual([1, 2, 3, 10]);
  });

  it('ignores bracketed text that is not a number list', () => {
    expect(citedNumbers('see [docs] and [1a]')).toEqual([]);
  });
});

describe('summarize', () => {
  it('collects the answer, recall, searches, citations and timings', () => {
    const turn = summarize(answered, 900);

    expect(turn.answer).toBe(
      'Pipedrive now costs $14 [1], HubSpot is unchanged [1, 2].',
    );
    expect(turn.exchangesRecalled).toBe(1);
    expect(turn.searches).toBe(1);
    expect(turn.queries).toEqual(['pipedrive pricing']);
    expect(turn.sourceNumbers).toEqual([1, 2]);
    expect(turn.citations).toEqual([1, 1, 2]);
    expect(turn.firstTokenMs).toBe(300);
    expect(turn.totalMs).toBe(900);
    expect(turn.done).toBe(true);
  });
});

describe('check', () => {
  it('passes a turn that meets every expectation', () => {
    const results = check(summarize(answered, 900), {
      recalls: true,
      searches: true,
      cites: true,
      mentions: { names: ['Pipedrive', 'HubSpot', 'Zoho'], min: 2 },
    });

    expect(results.every((result) => result.pass)).toBe(true);
  });

  it('fails a citation that points at no listed source', () => {
    const turn = summarize(
      timed([
        { type: 'token', text: 'Cheaper now [3].' },
        { type: 'sources', sources: [source(1)] },
        { type: 'done', messageId: 'a1' },
      ]),
      100,
    );

    const result = check(turn, {}).find((r) => r.name === 'citations resolve');
    expect(result).toMatchObject({
      pass: false,
      detail: '[3] cite no listed source',
    });
  });

  it('fails a turn that ended in an error', () => {
    const turn = summarize(
      timed([
        { type: 'error', kind: 'timeout', message: 'No answer in 30 s.' },
      ]),
      30_000,
    );

    expect(check(turn, {})[0]).toMatchObject({
      name: 'completes',
      pass: false,
      detail: 'timeout: No answer in 30 s.',
    });
  });

  it('fails a search the case says was not needed, and names the queries', () => {
    const result = check(summarize(answered, 900), { searches: false }).find(
      (r) => r.name === 'answers without searching',
    );

    expect(result).toMatchObject({ pass: false });
    expect(result?.detail).toContain('pipedrive pricing');
  });

  it('fails when too few expected names appear', () => {
    const result = check(summarize(answered, 900), {
      mentions: { names: ['Neon', 'Supabase', 'Pipedrive'], min: 2 },
    }).find((r) => r.name === 'mentions');

    expect(result).toMatchObject({
      pass: false,
      detail: '1/2 needed: Pipedrive',
    });
  });

  it('checks the answer against a pattern', () => {
    const turn = summarize(
      timed([{ type: 'token', text: 'I have no record of that day.' }]),
      1,
    );

    expect(check(turn, { matches: /no record/i }).at(-1)).toMatchObject({
      pass: true,
    });
    expect(check(turn, { matches: /Postgres/ }).at(-1)).toMatchObject({
      pass: false,
    });
  });
});

describe('check: a date with nothing stored', () => {
  const recallMiss = (misses: string[]) =>
    summarize(timed([{ type: 'recall', dates: [], exchanges: 3, misses }]), 1);

  it('passes when the date was understood and found empty', () => {
    expect(
      check(recallMiss(['1 October']), { missesDate: true }).at(-1),
    ).toMatchObject({ pass: true, detail: 'no record for 1 October' });
  });

  it('fails when every date had a record', () => {
    expect(check(recallMiss([]), { missesDate: true }).at(-1)).toMatchObject({
      pass: false,
    });
  });
});

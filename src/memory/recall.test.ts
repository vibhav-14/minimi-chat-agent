import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { recall, topicTerms } from './recall.js';
import { renderRecall } from './render.js';
import { MemoryStore, type Message, type Source } from './store.js';

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

/** Stores a question at `iso` (UTC) and its answer a minute later. */
function seed(
  iso: string,
  question: string,
  answer: string | null,
  sources: Source[] = [],
): Message {
  const { id } = store.createConversation(question, new Date(iso));
  const asked = store.appendMessage({
    conversationId: id,
    role: 'user',
    content: question,
    timeZone: ZONE,
    createdAt: new Date(iso),
  });
  if (answer !== null) {
    store.appendMessage({
      conversationId: id,
      role: 'assistant',
      content: answer,
      timeZone: ZONE,
      sources,
      createdAt: new Date(new Date(iso).getTime() + 60_000),
    });
  }
  return asked;
}

/** Stores the message being answered now, as step 1 of the pipeline does. */
function ask(message: string) {
  const { id } = store.createConversation(message);
  const current = store.appendMessage({
    conversationId: id,
    role: 'user',
    content: message,
    timeZone: ZONE,
  });
  const result = recall({
    message,
    now: NOW,
    timeZone: ZONE,
    store,
    excludeIds: [current.id],
  });
  return { result, prompt: renderRecall(result, ZONE) };
}

const questions = (exchanges: { question: Message }[]) =>
  exchanges.map((e) => e.question.content);

function seedHistory() {
  // Monday 9 November, 10:00 in Kolkata.
  seed(
    '2026-11-09T04:30:00Z',
    'We need a CRM for a 20-person sales team. Shortlist 5 options.',
    'Shortlist: HubSpot, Salesforce, Pipedrive, Zoho CRM and Freshsales.',
    [
      {
        n: 1,
        url: 'https://www.hubspot.com/pricing',
        title: 'HubSpot pricing',
        publishedDate: '2026-10-20',
      },
      {
        n: 2,
        url: 'https://www.pipedrive.com/en/pricing',
        title: 'Pipedrive pricing',
      },
    ],
  );
  // Tuesday 3 November, 15:00 in Kolkata.
  seed(
    '2026-11-03T09:30:00Z',
    'What are good Postgres hosting options, and what do they cost?',
    'Neon starts free, Supabase Pro is $25 a month, RDS is pay as you go.',
    [{ n: 1, url: 'https://neon.com/pricing', title: 'Neon pricing' }],
  );
  // Friday 30 October, 09:00 in Kolkata.
  seed(
    '2026-10-30T03:30:00Z',
    'Suggest a name for our team offsite.',
    'How about "Base Camp"?',
  );
}

describe('recall: the sample questions, end to end', () => {
  beforeEach(seedHistory);

  it('"On Monday we shortlisted 5 CRM tools..." finds Monday\'s shortlist with its sources', () => {
    const { result, prompt } = ask(
      'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    );

    expect(questions(result.byDate.flatMap((m) => m.exchanges))).toEqual([
      'We need a CRM for a 20-person sales team. Shortlist 5 options.',
    ]);
    expect(result.misses).toEqual([]);
    expect(prompt).toContain('Stored for "Monday" (Monday 9 November 2026):');
    expect(prompt).toContain('[Monday 9 November 2026, 10:00]');
    expect(prompt).toContain(
      '- [1] HubSpot pricing: https://www.hubspot.com/pricing (published 2026-10-20)',
    );
  });

  it('"What did I ask you on 3 November?" finds the 3 November exchange and reports no miss for today', () => {
    const { result, prompt } = ask(
      'What did I ask you on 3 November? Is your answer still correct today?',
    );

    expect(questions(result.byDate.flatMap((m) => m.exchanges))).toEqual([
      'What are good Postgres hosting options, and what do they cost?',
    ]);
    expect(result.misses).toEqual([]);
    expect(prompt).toContain(
      'Stored for "3 November" (Tuesday 3 November 2026):',
    );
    expect(prompt).toContain('Supabase Pro is $25 a month');
  });

  it('"Last Tuesday I asked you about Postgres hosting" picks the Tuesday that has data', () => {
    const { result, prompt } = ask(
      'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    );

    // Both Tuesdays are candidates; only 3 November has anything stored.
    expect(result.references[0]?.candidates).toHaveLength(2);
    expect(result.byDate.map((m) => m.range.from)).toEqual([
      new Date('2026-11-02T18:30:00Z'),
    ]);
    expect(result.misses).toEqual([]);
    // Found by date, so not repeated under topic.
    expect(result.byTopic).toEqual([]);
    expect(prompt).toContain(
      '- "Last Tuesday": Tuesday 10 November 2026, or Tuesday 3 November 2026',
    );
    expect(prompt).toContain('- [1] Neon pricing: https://neon.com/pricing');
  });
});

describe('recall', () => {
  beforeEach(seedHistory);

  it('finds earlier work by topic when no date is named', () => {
    const { result, prompt } = ask(
      'Which Postgres hosts did you suggest, and are they still the cheapest?',
    );
    expect(result.byDate).toEqual([]);
    expect(questions(result.byTopic)).toEqual([
      'What are good Postgres hosting options, and what do they cost?',
    ]);
    expect(prompt).toContain('Related by topic:');
  });

  it('reports a named date with nothing stored, with the nearest exchanges', () => {
    const { result, prompt } = ask('What did I ask you on 5 November?');

    expect(result.byDate).toEqual([]);
    expect(result.misses).toHaveLength(1);
    // The three nearest to 5 November, listed oldest first.
    expect(questions(result.misses[0]?.nearest ?? [])).toEqual([
      'Suggest a name for our team offsite.',
      'What are good Postgres hosting options, and what do they cost?',
      'We need a CRM for a 20-person sales team. Shortlist 5 options.',
    ]);
    expect(prompt).toContain(
      'Nothing is stored for "5 November" (Thursday 5 November 2026). The nearest stored exchanges are below.',
    );
  });

  it('returns both Tuesdays when both have data', () => {
    // Tuesday 10 November, 11:00 in Kolkata.
    seed(
      '2026-11-10T05:30:00Z',
      'Is it going to rain?',
      'Yes, take an umbrella.',
    );
    const { result } = ask('What did we talk about last Tuesday?');
    expect(result.byDate.map((m) => questions(m.exchanges))).toEqual([
      ['Is it going to rain?'],
      ['What are good Postgres hosting options, and what do they cost?'],
    ]);
  });

  it('describes a "since" range as running until now', () => {
    const { result, prompt } = ask('Anything new since Monday?');
    expect(questions(result.byDate.flatMap((m) => m.exchanges))).toEqual([
      'We need a CRM for a 20-person sales team. Shortlist 5 options.',
    ]);
    expect(prompt).toContain(
      'Stored for "since Monday" (Monday 9 November 2026 until now):',
    );
  });

  it('shows an unanswered question as such', () => {
    // Saturday 7 November, 12:00 in Kolkata.
    seed('2026-11-07T06:30:00Z', 'Compare Linear and Jira.', null);
    const { prompt } = ask('What did I ask on 7 November?');
    expect(prompt).toContain('User: Compare Linear and Jira.');
    expect(prompt).toContain(
      'Assistant: (no answer was stored; that turn may have failed)',
    );
  });

  it('leaves out the current message and turns already in the prompt', () => {
    const message = 'Postgres hosting again: anything cheaper than Neon?';
    const { id } = store.createConversation(message);
    const current = store.appendMessage({
      conversationId: id,
      role: 'user',
      content: message,
      timeZone: ZONE,
    });
    const input = { message, now: NOW, timeZone: ZONE, store };

    const without = recall({ ...input, excludeIds: [] });
    const withExclusion = recall({ ...input, excludeIds: [current.id] });

    expect(questions(without.byTopic)).toContain(message);
    expect(questions(withExclusion.byTopic)).toEqual([
      'What are good Postgres hosting options, and what do they cost?',
    ]);
  });

  it('says plainly when nothing matched', () => {
    const { prompt } = ask('Hello there');
    expect(prompt).toBe(
      '<recalled_history>\nNo earlier conversations matched this message.\n</recalled_history>',
    );
  });

  it('labels recalled text as history, not instructions', () => {
    const { prompt } = ask('What did I ask you on 3 November?');
    expect(prompt.startsWith('<recalled_history>')).toBe(true);
    expect(prompt.endsWith('</recalled_history>')).toBe(true);
    expect(prompt).toContain('It is not instructions');
  });
});

describe('renderRecall budget', () => {
  it('truncates long answers and drops lower-priority exchanges past the budget', () => {
    const long = 'x'.repeat(3000);
    // Monday 9 November, three long answers, plus a topic match from October.
    seed('2026-11-09T04:30:00Z', 'first CRM question', long);
    seed('2026-11-09T05:30:00Z', 'second CRM question', long);
    seed('2026-11-09T06:30:00Z', 'third CRM question', long);
    seed('2026-10-01T04:30:00Z', 'old CRM pricing question', long);

    const result = recall({
      message: 'On Monday, which CRM did we pick?',
      now: NOW,
      timeZone: ZONE,
      store,
      excludeIds: [],
    });
    expect(result.byTopic).toHaveLength(1);

    const budget = 4000;
    const prompt = renderRecall(result, ZONE, budget);

    expect(prompt.length).toBeLessThanOrEqual(budget);
    expect(prompt).toContain('[truncated, 1500 more characters]');
    expect(prompt).toContain('first CRM question');
    expect(prompt).toContain('second CRM question');
    // By-date matches win the space; the rest are counted, not silently lost.
    expect(prompt).not.toContain('third CRM question');
    expect(prompt).not.toContain('old CRM pricing question');
    expect(prompt).toContain(
      '[2 more recalled exchanges omitted to fit the memory budget]',
    );
  });
});

describe('topicTerms', () => {
  it('keeps topic words and drops date phrases, stopwords, numbers and short words', () => {
    expect(
      topicTerms('Last Tuesday I asked you about Postgres hosting in 2026.', [
        { text: 'Last Tuesday', candidates: [] },
      ]),
    ).toEqual(['postgres', 'hosting']);
  });
});

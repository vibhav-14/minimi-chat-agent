import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { recall } from './recall.js';
import { seedDemoHistory } from './seed.js';
import { MemoryStore } from './store.js';

const ZONE = 'Asia/Kolkata';
let store: MemoryStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function seededAt(iso: string): MemoryStore {
  const now = new Date(iso);
  store = MemoryStore.open(':memory:', fixedClock(now));
  expect(seedDemoHistory(store, fixedClock(now), ZONE)).toBe(true);
  return store;
}

/** "Monday 9 November 2026, 10:00" style local times of each seeded conversation. */
function localTimes(seeded: MemoryStore): Record<string, string> {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(
    seeded
      .listConversations()
      .map((c) => [c.title, format.format(c.createdAt)]),
  );
}

/** The questions recall finds by date for `message`, asked at `iso`. */
function foundByDate(seeded: MemoryStore, iso: string, message: string) {
  return recall({
    message,
    now: new Date(iso),
    timeZone: ZONE,
    store: seeded,
    excludeIds: [],
  }).byDate.flatMap((match) => match.exchanges.map((e) => e.question.content));
}

const MONDAY_QUESTION = 'On Monday we shortlisted 5 CRM tools. Any changes?';
const NOVEMBER_QUESTION = 'What did I ask you on 3 November?';
const TUESDAY_QUESTION = 'Last Tuesday I asked you about Postgres hosting.';

describe('seedDemoHistory', () => {
  it('dates the demo exchanges relative to today (Wednesday 11 November 2026)', () => {
    const seeded = seededAt('2026-11-11T12:00:00Z');

    expect(localTimes(seeded)).toEqual({
      'Demo: CRM shortlist for a 20-person sales team': expect.stringMatching(
        /Mon,? 9 Nov 2026,? 10:00/,
      ) as string,
      'Demo: Postgres hosting options': expect.stringMatching(
        /Tue,? 10 Nov 2026,? 15:00/,
      ) as string,
      'Demo: Current Node.js LTS': expect.stringMatching(
        /Tue,? 3 Nov 2026,? 12:00/,
      ) as string,
    });
  });

  it('marks every seeded answer as demo data', () => {
    const seeded = seededAt('2026-11-11T12:00:00Z');

    for (const conversation of seeded.listConversations()) {
      const [question, answer] = seeded.getMessages(conversation.id);
      expect(question?.content.startsWith('(Demo) ')).toBe(true);
      expect(answer?.content.startsWith('(Seeded demo history')).toBe(true);
      expect(answer?.sources.every((s) => s.snippet)).toBe(true);
    }
  });

  it('leaves a store with history alone', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    store = MemoryStore.open(':memory:', fixedClock(now));
    store.createConversation('Real conversation');

    expect(seedDemoHistory(store, fixedClock(now), ZONE)).toBe(false);
    expect(store.listConversations()).toHaveLength(1);
  });

  // Each row: a day where two demo dates fall together, or a resolver edge.
  it.each([
    ['Monday is 3 November', '2025-11-05T06:00:00Z'],
    ['last Tuesday is 3 November', '2026-11-04T06:00:00Z'],
    ['today is 3 November', '2026-11-03T06:00:00Z'],
    ['today is Monday', '2026-11-09T06:00:00Z'],
    ['today is Tuesday', '2026-11-10T06:00:00Z'],
    ['today is Wednesday, two Tuesdays offered', '2026-11-11T06:00:00Z'],
  ])('every sample question finds its exchange when %s', (_, iso) => {
    const seeded = seededAt(iso);

    expect(foundByDate(seeded, iso, MONDAY_QUESTION)).toContainEqual(
      expect.stringContaining('CRM'),
    );
    expect(foundByDate(seeded, iso, TUESDAY_QUESTION)).toContainEqual(
      expect.stringContaining('Postgres'),
    );
    const november = foundByDate(seeded, iso, NOVEMBER_QUESTION);
    // On 3 November itself the question means today, which has nothing yet.
    if (iso.startsWith('2026-11-03')) expect(november).toEqual([]);
    else expect(november).toContainEqual(expect.stringContaining('Node.js'));
    for (const c of seeded.listConversations()) {
      expect(c.createdAt.getTime()).toBeLessThan(new Date(iso).getTime());
    }
  });
});

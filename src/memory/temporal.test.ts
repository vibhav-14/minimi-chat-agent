import { describe, expect, it } from 'vitest';
import { resolveTimeReferences, type DateRange } from './temporal.js';

// Wednesday 11 November 2026, midday UTC. Most tests use UTC so ranges read as plain dates.
const NOW = new Date('2026-11-11T12:00:00Z');
const UTC = 'UTC';

/** Local calendar days a range covers, as `YYYY-MM-DD..YYYY-MM-DD` (end exclusive). Only meaningful in UTC. */
function days(range: DateRange): string {
  return `${range.from.toISOString().slice(0, 10)}..${range.to.toISOString().slice(0, 10)}`;
}

function resolve(text: string, now = NOW, timeZone = UTC) {
  return resolveTimeReferences(text, now, timeZone).map((ref) => ({
    text: ref.text,
    candidates: ref.candidates.map(days),
  }));
}

describe('resolveTimeReferences: the sample questions', () => {
  it('reads "On Monday" as the Monday just gone', () => {
    expect(
      resolve(
        'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?',
      ),
    ).toEqual([{ text: 'Monday', candidates: ['2026-11-09..2026-11-10'] }]);
  });

  it('reads "3 November" as this year, and "today" as today', () => {
    expect(
      resolve(
        'What did I ask you on 3 November? Is your answer still correct today?',
      ),
    ).toEqual([
      { text: '3 November', candidates: ['2026-11-03..2026-11-04'] },
      { text: 'today', candidates: ['2026-11-11..2026-11-12'] },
    ]);
  });

  it('reads "last Tuesday" on a Wednesday as yesterday first, then the Tuesday of last week', () => {
    expect(
      resolve(
        'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
      ),
    ).toEqual([
      {
        text: 'Last Tuesday',
        candidates: ['2026-11-10..2026-11-11', '2026-11-03..2026-11-04'],
      },
    ]);
  });
});

describe('resolveTimeReferences: phrases', () => {
  it.each([
    ['yesterday', ['2026-11-10..2026-11-11']],
    ['today', ['2026-11-11..2026-11-12']],
    ['3 days ago', ['2026-11-08..2026-11-09']],
    ['three days ago', ['2026-11-08..2026-11-09']],
    ['a day ago', ['2026-11-10..2026-11-11']],
    // Weeks run Monday to Sunday; today is in the week of Monday 9 November.
    ['last week', ['2026-11-02..2026-11-09']],
    ['two weeks ago', ['2026-10-26..2026-11-02']],
    ['last month', ['2026-10-01..2026-11-01']],
    ['Nov 3', ['2026-11-03..2026-11-04']],
    ['November 3rd', ['2026-11-03..2026-11-04']],
    ['the 3rd of November', ['2026-11-03..2026-11-04']],
    ['Sept 30', ['2026-09-30..2026-10-01']],
    // Not yet reached this year, so the most recent one is last year's.
    ['25 December', ['2025-12-25..2025-12-26']],
    ['29 February', ['2024-02-29..2024-03-01']],
    ['3 November 2025', ['2025-11-03..2025-11-04']],
    ['November 3, 2025', ['2025-11-03..2025-11-04']],
    ['2025-11-03', ['2025-11-03..2025-11-04']],
    // An explicit year is taken as given, even in the future.
    ['3 January 2027', ['2027-01-03..2027-01-04']],
    ['Friday', ['2026-11-06..2026-11-07']],
    // The most recent Friday is already in last week, so there is no doubt.
    ['last Friday', ['2026-11-06..2026-11-07']],
    ['Tuesday last week', ['2026-11-03..2026-11-04']],
    ['Tuesday of last week', ['2026-11-03..2026-11-04']],
    ["last week's Sunday", ['2026-11-08..2026-11-09']],
  ])('%s', (text, candidates) => {
    expect(resolve(`what about ${text}?`)).toEqual([{ text, candidates }]);
  });

  it('offers today and a week ago for a bare weekday that is today', () => {
    expect(resolve('on Wednesday')).toEqual([
      {
        text: 'Wednesday',
        candidates: ['2026-11-11..2026-11-12', '2026-11-04..2026-11-05'],
      },
    ]);
  });

  it('never resolves "last <weekday>" to today', () => {
    expect(resolve('last Wednesday')).toEqual([
      { text: 'last Wednesday', candidates: ['2026-11-04..2026-11-05'] },
    ]);
  });

  it('runs a "since" phrase from the start of that day to now', () => {
    const [reference] = resolveTimeReferences(
      'anything new since Monday?',
      NOW,
      UTC,
    );
    expect(reference?.text).toBe('since Monday');
    expect(reference?.candidates).toEqual([
      { from: new Date('2026-11-09T00:00:00Z'), to: NOW },
    ]);
  });

  it('finds several phrases and returns them in reading order', () => {
    expect(
      resolve('compare yesterday with 3 November').map((r) => r.text),
    ).toEqual(['yesterday', '3 November']);
  });

  it('skips a date that does not exist', () => {
    expect(resolve('on 30 February 2026')).toEqual([]);
  });
});

describe('resolveTimeReferences: words that are not dates', () => {
  it.each([
    'may I ask you something',
    'we march forward',
    'the sun is out',
    'I want a second opinion',
    'we shortlisted 5 CRM tools',
    'for a 20-person team',
    'see you in May 2026',
  ])('%s', (text) => {
    expect(resolve(text)).toEqual([]);
  });
});

describe('resolveTimeReferences: time zones', () => {
  it('uses whole local days in Asia/Kolkata (UTC+5:30)', () => {
    const [monday] = resolveTimeReferences('Monday', NOW, 'Asia/Kolkata');
    expect(monday?.candidates).toEqual([
      {
        from: new Date('2026-11-08T18:30:00Z'),
        to: new Date('2026-11-09T18:30:00Z'),
      },
    ]);
  });

  it('uses whole local days in America/Los_Angeles (UTC-8 in November)', () => {
    const [monday] = resolveTimeReferences(
      'Monday',
      NOW,
      'America/Los_Angeles',
    );
    expect(monday?.candidates).toEqual([
      {
        from: new Date('2026-11-09T08:00:00Z'),
        to: new Date('2026-11-10T08:00:00Z'),
      },
    ]);
  });

  it('takes "today" from the user\'s zone, not UTC', () => {
    // 02:00 UTC on Wednesday is still Tuesday evening in Los Angeles.
    const now = new Date('2026-11-11T02:00:00Z');
    const [today] = resolveTimeReferences('today', now, 'America/Los_Angeles');
    expect(today?.candidates[0]?.from).toEqual(
      new Date('2026-11-10T08:00:00Z'),
    );
  });

  it('gives a 25-hour day when daylight saving ends (Los Angeles, 1 November 2026)', () => {
    const [sunday] = resolveTimeReferences(
      '1 November',
      NOW,
      'America/Los_Angeles',
    );
    expect(sunday?.candidates).toEqual([
      {
        from: new Date('2026-11-01T07:00:00Z'),
        to: new Date('2026-11-02T08:00:00Z'),
      },
    ]);
  });

  it('gives a 23-hour day when daylight saving starts (Los Angeles, 8 March 2026)', () => {
    const [sunday] = resolveTimeReferences(
      '8 March',
      NOW,
      'America/Los_Angeles',
    );
    expect(sunday?.candidates).toEqual([
      {
        from: new Date('2026-03-08T08:00:00Z'),
        to: new Date('2026-03-09T07:00:00Z'),
      },
    ]);
  });

  it('starts a day whose midnight is skipped at 01:00 (Santiago, 6 September 2026)', () => {
    const [sunday] = resolveTimeReferences(
      '6 September',
      NOW,
      'America/Santiago',
    );
    expect(sunday?.candidates).toEqual([
      {
        from: new Date('2026-09-06T04:00:00Z'),
        to: new Date('2026-09-07T03:00:00Z'),
      },
    ]);
  });
});

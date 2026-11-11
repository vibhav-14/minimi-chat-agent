// Tests for the activity and date text (public/format.js). Locale and zone
// are pinned; the browser uses its own.
import { describe, expect, it } from 'vitest';
import {
  describeQuery,
  describeRecall,
  describeSearch,
  formatDay,
  formatTimestamp,
} from '../../public/format.js';

const recall = (
  dates: { text: string; days: string[] }[],
  exchanges: number,
  misses: string[] = [],
) => ({ type: 'recall' as const, dates, exchanges, misses });

describe('formatDay', () => {
  // A day resolved in the user's zone must not slide to the day before.
  it('shows the calendar day as is, whatever the zone', () => {
    expect(formatDay('2026-11-10', 'en-GB')).toBe('10 Nov 2026');
  });

  it('returns text it cannot read unchanged', () => {
    expect(formatDay('soon', 'en-GB')).toBe('soon');
  });
});

describe('formatTimestamp', () => {
  it('shows the date and time in the given zone', () => {
    const at = new Date('2026-11-10T15:00:00Z');

    expect(
      formatTimestamp(at, { locale: 'en-GB', timeZone: 'Asia/Kolkata' }),
    ).toBe('Tue, 10 Nov 2026, 20:30');
  });
});

describe('describeRecall', () => {
  it.each([
    [
      'exchanges found for a date',
      recall([{ text: 'last Tuesday', days: ['2026-11-10'] }], 2),
      'Recalled 2 earlier exchanges for "last Tuesday" (10 Nov 2026)',
    ],
    [
      'a date with two candidate days',
      recall([{ text: 'last Tuesday', days: ['2026-11-03', '2026-10-27'] }], 1),
      'Recalled 1 earlier exchange for "last Tuesday" (3 Nov 2026 or 27 Oct 2026)',
    ],
    [
      'a date with nothing stored',
      recall([{ text: '3 November', days: ['2026-11-03'] }], 0, ['3 November']),
      'Nothing stored for "3 November" (3 Nov 2026)',
    ],
    [
      'a miss with nearby exchanges',
      recall([{ text: '3 November', days: ['2026-11-03'] }], 2, ['3 November']),
      'Recalled 2 earlier exchanges. Nothing stored for "3 November" (3 Nov 2026)',
    ],
    ['exchanges found by topic', recall([], 3), 'Recalled 3 earlier exchanges'],
  ])('describes %s', (_, event, expected) => {
    expect(describeRecall(event, 'en-GB')).toBe(expected);
  });

  // A plain question should not get an empty "Recalled 0" line.
  it('says nothing when nothing was recalled or missed', () => {
    expect(describeRecall(recall([], 0), 'en-GB')).toBeNull();
    expect(
      describeRecall(
        recall([{ text: 'today', days: ['2026-11-11'] }], 0),
        'en-GB',
      ),
    ).toBeNull();
  });
});

describe('describeQuery', () => {
  it.each([
    [{ query: 'a', status: 'searching' as const }, 'searching'],
    [{ query: 'a', status: 'ok' as const, sources: [1] }, '1 result'],
    [{ query: 'a', status: 'ok' as const, sources: [] }, '0 results'],
    [
      {
        query: 'a',
        status: 'failed' as const,
        kind: 'rate_limit',
        message: 'Rate limited.',
      },
      'failed: Rate limited.',
    ],
  ])('describes %j', (state, expected) => {
    expect(describeQuery(state)).toBe(expected);
  });
});

describe('describeSearch', () => {
  it('says it is searching while any query runs', () => {
    expect(
      describeSearch([
        { query: 'a', status: 'ok', sources: [1] },
        { query: 'b', status: 'searching' },
      ]),
    ).toBe('Searching the web: 2 queries');
  });

  it('sums results and counts failures once every query is done', () => {
    expect(
      describeSearch([
        { query: 'a', status: 'ok', sources: [1, 2] },
        { query: 'b', status: 'ok', sources: [3] },
        { query: 'c', status: 'failed', kind: 'other', message: 'x' },
      ]),
    ).toBe('Searched 3 queries, 3 results, 1 failed');
    expect(describeSearch([{ query: 'a', status: 'ok', sources: [1] }])).toBe(
      'Searched 1 query, 1 result',
    );
  });
});

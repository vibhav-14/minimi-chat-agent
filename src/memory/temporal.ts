/** A half-open span of time: `from` is included, `to` is not. */
export interface DateRange {
  from: Date;
  to: Date;
}

/** A date phrase found in a message and the ranges it may mean, most likely first. */
export interface TimeReference {
  text: string;
  candidates: DateRange[];
}

/** A calendar day with no time or zone attached. `month` is 1 to 12. */
export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

/** Whole local days, `start` included and `end` excluded. */
interface DaySpan {
  start: CalendarDay;
  end: CalendarDay;
}

type Groups = Partial<Record<string, string>>;

interface Rule {
  pattern: string;
  resolve(groups: Groups, today: CalendarDay): DaySpan[];
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const DAYS_PER_WEEK = 7;
// Feb 29 recurs at most eight years apart (1896 to 1904), so this always finds one.
const MAX_YEARS_BACK = 8;

// Full weekday names only: "sun", "wed" and "sat" are ordinary words too often.
const WEEKDAY = `(?<weekday>${WEEKDAYS.join('|')})`;
// A month never matches alone ("may I ask", "march forward"); every rule that
// uses it needs a day number next to it.
const MONTH = `(?<month>${[...MONTHS, ...MONTHS.map((name) => name.slice(0, 3)), 'sept'].join('|')})\\.?`;
const DAY = '(?<day>[12]\\d|3[01]|0?[1-9])(?:st|nd|rd|th)?';
const YEAR = '(?<year>(?:19|20)\\d\\d)';
const COUNT = `(?<count>\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;

/**
 * Rules in priority order. Text claimed by an earlier rule is not matched
 * again by a later one, so "Tuesday last week" never also yields "last week".
 */
const RULES: Rule[] = [
  {
    pattern: `${YEAR}-(?<monthNumber>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\\d|3[01])`,
    resolve: (g) =>
      oneDay(realDay(Number(g.year), Number(g.monthNumber), Number(g.day))),
  },
  {
    pattern: `(?:the\\s+)?${DAY}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+${YEAR})?`,
    resolve: (g, today) => oneDay(dayOfMonth(g, today)),
  },
  {
    pattern: `${MONTH}\\s+(?:the\\s+)?${DAY}(?:,?\\s+${YEAR})?`,
    resolve: (g, today) => oneDay(dayOfMonth(g, today)),
  },
  {
    pattern: `${WEEKDAY}\\s+(?:of\\s+)?last\\s+week`,
    resolve: (g, today) => oneDay(weekdayOfLastWeek(g, today)),
  },
  {
    pattern: `last\\s+week(?:'s)?\\s+${WEEKDAY}`,
    resolve: (g, today) => oneDay(weekdayOfLastWeek(g, today)),
  },
  {
    pattern: `last\\s+${WEEKDAY}`,
    resolve: (g, today) => {
      const day = mostRecentWeekday(today, weekdayIndex(g), false);
      // "Last Tuesday" said on a Wednesday can mean yesterday or the Tuesday of
      // last week. When the most recent one is in this week, offer both.
      const inThisWeek = compareDays(day, startOfWeek(today)) >= 0;
      return inThisWeek
        ? [...oneDay(day), ...oneDay(addDays(day, -DAYS_PER_WEEK))]
        : oneDay(day);
    },
  },
  {
    pattern: WEEKDAY,
    resolve: (g, today) => {
      const day = mostRecentWeekday(today, weekdayIndex(g), true);
      // "Monday" said on a Monday may mean today or a week ago.
      return compareDays(day, today) === 0
        ? [...oneDay(day), ...oneDay(addDays(day, -DAYS_PER_WEEK))]
        : oneDay(day);
    },
  },
  {
    pattern: 'yesterday',
    resolve: (_, today) => oneDay(addDays(today, -1)),
  },
  { pattern: 'today', resolve: (_, today) => oneDay(today) },
  {
    pattern: `${COUNT}\\s+days?\\s+ago`,
    resolve: (g, today) => oneDay(addDays(today, -countOf(g))),
  },
  { pattern: 'last\\s+week', resolve: (_, today) => weeksAgo(today, 1) },
  {
    pattern: `${COUNT}\\s+weeks?\\s+ago`,
    resolve: (g, today) => weeksAgo(today, countOf(g)),
  },
  {
    pattern: 'last\\s+month',
    resolve: (_, today) => {
      const start =
        today.month === 1
          ? { year: today.year - 1, month: 12, day: 1 }
          : { year: today.year, month: today.month - 1, day: 1 };
      return [{ start, end: { ...today, day: 1 } }];
    },
  },
];

const COMPILED = RULES.map((rule) => ({
  rule,
  regex: new RegExp(`\\b(?<since>since\\s+)?(?:${rule.pattern})\\b`, 'gi'),
}));

/**
 * Finds date phrases in `text` and resolves each to whole local days in
 * `timeZone`, relative to `now`. Past-biased, because the phrases refer back
 * to earlier conversations. A phrase that starts with "since" runs to `now`.
 */
export function resolveTimeReferences(
  text: string,
  now: Date,
  timeZone: string,
): TimeReference[] {
  const today = calendarDayAt(now, timeZone);
  const claimed: { start: number; end: number }[] = [];
  const found: { index: number; reference: TimeReference }[] = [];

  for (const { rule, regex } of COMPILED) {
    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const end = start + match[0].length;
      if (claimed.some((span) => start < span.end && end > span.start)) {
        continue;
      }
      const groups: Groups = match.groups ?? {};
      const spans = rule.resolve(groups, today);
      if (spans.length === 0) continue;

      claimed.push({ start, end });
      const candidates = spans.map((span) => ({
        from: startOfLocalDay(span.start, timeZone),
        to: groups.since ? now : startOfLocalDay(span.end, timeZone),
      }));
      found.push({ index: start, reference: { text: match[0], candidates } });
    }
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ reference }) => reference);
}

/** The local calendar day that contains `instant` in `timeZone`. */
export function calendarDayAt(instant: Date, timeZone: string): CalendarDay {
  const { year, month, day } = wallClockAt(instant.getTime(), timeZone);
  return { year, month, day };
}

/**
 * The first instant of a local calendar day in `timeZone`. Usually local
 * midnight; 01:00 in zones that skip midnight when daylight saving starts.
 */
export function startOfLocalDay(day: CalendarDay, timeZone: string): Date {
  const wallClock = Date.UTC(day.year, day.month - 1, day.day);
  // The offset at local midnight is unknown until the instant is. Try the
  // offset at UTC midnight, then the offset at that first guess, and keep the
  // earliest one that falls on the right day. The two differ only when the
  // offset changes near midnight.
  const first = wallClock - offsetAt(wallClock, timeZone);
  const second = wallClock - offsetAt(first, timeZone);
  const onDay = [first, second].filter(
    (instant) =>
      compareDays(calendarDayAt(new Date(instant), timeZone), day) === 0,
  );
  return new Date(Math.min(...onDay));
}

/** Milliseconds the zone's wall clock is ahead of UTC at `instant`. */
function offsetAt(instant: number, timeZone: string): number {
  const p = wallClockAt(instant, timeZone);
  const wallClock = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  // Intl drops milliseconds, so compare with the instant truncated to seconds.
  return wallClock - Math.floor(instant / 1000) * 1000;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClockAt(instant: number, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

// Calendar arithmetic runs on UTC dates, which have no daylight saving, so a
// day there is always 24 hours. Zones only matter when converting to instants.

function addDays(day: CalendarDay, days: number): CalendarDay {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function weekdayOf(day: CalendarDay): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

function compareDays(a: CalendarDay, b: CalendarDay): number {
  return (
    Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)
  );
}

/** Monday of the week containing `day`. */
function startOfWeek(day: CalendarDay): CalendarDay {
  return addDays(day, -((weekdayOf(day) + 6) % DAYS_PER_WEEK));
}

function mostRecentWeekday(
  today: CalendarDay,
  weekday: number,
  includeToday: boolean,
): CalendarDay {
  const back = (weekdayOf(today) - weekday + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return addDays(today, -(back === 0 && !includeToday ? DAYS_PER_WEEK : back));
}

function weekdayOfLastWeek(g: Groups, today: CalendarDay): CalendarDay {
  const monday = addDays(startOfWeek(today), -DAYS_PER_WEEK);
  // Weeks start on Monday, so Sunday is the last day of its week.
  return addDays(monday, (weekdayIndex(g) + 6) % DAYS_PER_WEEK);
}

/** The Monday-to-Sunday week `count` weeks before the current one. */
function weeksAgo(today: CalendarDay, count: number): DaySpan[] {
  const start = addDays(startOfWeek(today), -DAYS_PER_WEEK * count);
  return [{ start, end: addDays(start, DAYS_PER_WEEK) }];
}

function oneDay(day: CalendarDay | null): DaySpan[] {
  return day ? [{ start: day, end: addDays(day, 1) }] : [];
}

/** The day, or null if it does not exist (30 February). */
function realDay(year: number, month: number, day: number): CalendarDay | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const exists = date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
  return exists ? { year, month, day } : null;
}

/** "3 November" with no year means the most recent 3 November not in the future. */
function dayOfMonth(g: Groups, today: CalendarDay): CalendarDay | null {
  const month = monthIndex(g) + 1;
  const day = Number(g.day);
  if (g.year) return realDay(Number(g.year), month, day);

  for (let back = 0; back <= MAX_YEARS_BACK; back++) {
    const date = realDay(today.year - back, month, day);
    if (date && compareDays(date, today) <= 0) return date;
  }
  return null;
}

function weekdayIndex(g: Groups): number {
  return WEEKDAYS.indexOf((g.weekday ?? '').toLowerCase());
}

function monthIndex(g: Groups): number {
  const prefix = (g.month ?? '').toLowerCase().slice(0, 3);
  return MONTHS.findIndex((name) => name.startsWith(prefix));
}

function countOf(g: Groups): number {
  const word = (g.count ?? '').toLowerCase();
  return NUMBER_WORDS[word] ?? Number(word);
}

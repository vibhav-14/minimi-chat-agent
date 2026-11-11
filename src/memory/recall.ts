import type { Exchange, MemoryStore } from './store.js';
import {
  resolveTimeReferences,
  type DateRange,
  type TimeReference,
} from './temporal.js';

/** Exchanges stored inside one candidate range of a date phrase. */
export interface DateMatch {
  reference: TimeReference;
  range: DateRange;
  exchanges: Exchange[];
}

/** A date phrase with nothing stored for it, and the closest exchanges that are. */
export interface DateMiss {
  reference: TimeReference;
  nearest: Exchange[];
}

export interface RecallResult {
  references: TimeReference[];
  byDate: DateMatch[];
  byTopic: Exchange[];
  misses: DateMiss[];
}

export interface RecallInput {
  message: string;
  now: Date;
  timeZone: string;
  store: MemoryStore;
  /** Messages already in the prompt, such as the one being answered. */
  excludeIds: readonly string[];
}

const TOPIC_LIMIT = 3;
const NEAREST_LIMIT = 3;
const MIN_TERM_LENGTH = 3;

// Common words and the words people use to talk about the conversation
// itself ("what did I ask you"), which say nothing about its topic.
const STOPWORDS = new Set(
  `about above after again all also and any anything are been before being
  between both but can could did does doing done during each else even ever
  every for from had has have having her here hers him his how into its just
  like make many more most much must not now off once only other our out over
  own same she should since some something still such than that the their them
  then there these they this those through too under until upon very was way
  were what when where which while who whom why will with would yet you your
  yours ask asked asking answer answered answers tell told say said suggest
  suggested recommend recommended question questions correct right wrong true
  today please thanks thank know think remember recall earlier previous
  previously last week weeks month day days ago`.split(/\s+/),
);

/**
 * The retrieval stage that runs before the model call: resolves date phrases,
 * then reads the store by date and by topic. Local and synchronous; no network.
 */
export function recall(input: RecallInput): RecallResult {
  const { message, now, timeZone, store } = input;
  const excluded = new Set(input.excludeIds);
  const isExcluded = (exchange: Exchange) =>
    excluded.has(exchange.question.id) ||
    (exchange.answer !== null && excluded.has(exchange.answer.id));

  // Each exchange appears once in the result, in the first section that has it.
  const shown = new Set<string>();
  const keepNew = (exchanges: Exchange[], limit = Infinity) => {
    const kept = exchanges
      .filter((e) => !isExcluded(e) && !shown.has(e.question.id))
      .slice(0, limit);
    kept.forEach((e) => shown.add(e.question.id));
    return kept;
  };
  // Each excluded or shown ID removes at most one row, so fetching that many
  // extra rows still leaves `limit` after keepNew filters them.
  const fetchSize = (limit: number) => limit + excluded.size + shown.size;

  const references = resolveTimeReferences(message, now, timeZone);
  const byDate: DateMatch[] = [];
  const misses: DateMiss[] = [];

  for (const reference of references) {
    const stored = reference.candidates.map((range) => ({
      range,
      exchanges: store.exchangesBetween(range).filter((e) => !isExcluded(e)),
    }));
    if (stored.some(({ exchanges }) => exchanges.length > 0)) {
      for (const { range, exchanges } of stored) {
        const fresh = keepNew(exchanges);
        if (fresh.length > 0)
          byDate.push({ reference, range, exchanges: fresh });
      }
    } else if (reference.candidates.every((range) => range.to < now)) {
      // A range that runs up to now (today, since Monday) is not missing
      // history, so only past ranges are reported as misses.
      const around = middleOf(reference.candidates);
      const nearest = keepNew(
        store.nearestExchanges(around, fetchSize(NEAREST_LIMIT)),
        NEAREST_LIMIT,
      ).sort(byTime);
      misses.push({ reference, nearest });
    }
  }

  const terms = topicTerms(message, references);
  const byTopic =
    terms.length === 0
      ? []
      : keepNew(
          store.searchExchanges(terms.join(' '), fetchSize(TOPIC_LIMIT)),
          TOPIC_LIMIT,
        );

  return { references, byDate, byTopic, misses };
}

/** Words of the message worth searching for: no date phrases, stopwords, numbers or short words. */
export function topicTerms(
  message: string,
  references: readonly TimeReference[],
): string[] {
  let rest = message;
  for (const reference of references) rest = rest.replace(reference.text, ' ');
  const words = rest.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = words.filter(
    (word) =>
      word.length >= MIN_TERM_LENGTH &&
      !/^\d+$/.test(word) &&
      !STOPWORDS.has(word),
  );
  return [...new Set(terms)];
}

/** The middle of the span from the earliest candidate start to the latest end. */
function middleOf(ranges: readonly DateRange[]): Date {
  const from = Math.min(...ranges.map((range) => range.from.getTime()));
  const to = Math.max(...ranges.map((range) => range.to.getTime()));
  return new Date((from + to) / 2);
}

function byTime(a: Exchange, b: Exchange): number {
  return a.question.createdAt.getTime() - b.question.createdAt.getTime();
}

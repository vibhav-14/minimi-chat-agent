// Deterministic checks for one live turn. No model grades another model here:
// every check reads the event stream, so a failure names exactly what went
// wrong (no recall, no search, a citation pointing at nothing).
import type { AgentEvent } from '../agent/events.js';

/** What one eval case expects of a turn. Unset fields are not checked. */
export interface Expectation {
  /** Memory must find at least one earlier exchange (true) or none (false). */
  recalls?: boolean;
  /**
   * A date in the message must be understood and found empty. Recall still
   * offers the nearest exchanges then, so `recalls` cannot test this.
   */
  missesDate?: boolean;
  /** The turn must search (true) or answer without searching (false). */
  searches?: boolean;
  /** The answer must cite at least one source with [n]. */
  cites?: boolean;
  /** At least `min` of these names must appear in the answer (case-insensitive). */
  mentions?: { names: string[]; min: number };
  /** The answer must match this, e.g. saying there is no record of a date. */
  matches?: RegExp;
  /**
   * The answer must not match this. `matches` alone can pass a wrong answer
   * that happens to contain the right words, such as a row with an arrow
   * that still ends "unchanged".
   */
  rejects?: RegExp;
}

/** A turn's events reduced to what the checks and the report need. */
export interface TurnSummary {
  answer: string;
  exchangesRecalled: number;
  dateMisses: string[];
  searches: number;
  queries: string[];
  sourceNumbers: number[];
  citations: number[];
  error?: { kind: string; message: string };
  done: boolean;
  /** Milliseconds from the start of the turn to its first token, if any. */
  firstTokenMs?: number;
  totalMs: number;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

/** Every number cited as [n] or [n, m] in the answer, in order of appearance. */
export function citedNumbers(answer: string): number[] {
  const cited: number[] = [];
  for (const match of answer.matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)) {
    for (const n of (match[1] ?? '').split(',')) cited.push(Number(n.trim()));
  }
  return cited;
}

/** A timed event, as the runner records it. */
export interface TimedEvent {
  event: AgentEvent;
  /** Milliseconds since the turn started. */
  at: number;
}

export function summarize(events: TimedEvent[], totalMs: number): TurnSummary {
  const summary: TurnSummary = {
    answer: '',
    exchangesRecalled: 0,
    dateMisses: [],
    searches: 0,
    queries: [],
    sourceNumbers: [],
    citations: [],
    done: false,
    totalMs,
  };
  for (const { event, at } of events) {
    switch (event.type) {
      case 'recall':
        summary.exchangesRecalled = event.exchanges;
        summary.dateMisses = event.misses;
        break;
      case 'search_started':
        summary.searches += 1;
        summary.queries.push(...event.queries);
        break;
      case 'token':
        summary.firstTokenMs ??= at;
        summary.answer += event.text;
        break;
      case 'sources':
        summary.sourceNumbers = event.sources.map((source) => source.n);
        break;
      case 'done':
        summary.done = true;
        break;
      case 'error':
        summary.error = { kind: event.kind, message: event.message };
        break;
      default:
        break;
    }
  }
  summary.citations = citedNumbers(summary.answer);
  return summary;
}

/** Runs the checks every turn must pass, then the case's own. */
export function check(turn: TurnSummary, expect: Expectation): CheckResult[] {
  const results: CheckResult[] = [
    {
      name: 'completes',
      pass: turn.done && !turn.error,
      detail: turn.error
        ? `${turn.error.kind}: ${turn.error.message}`
        : turn.done
          ? 'done'
          : 'no done event',
    },
  ];

  const known = new Set(turn.sourceNumbers);
  const dangling = [...new Set(turn.citations.filter((n) => !known.has(n)))];
  results.push({
    name: 'citations resolve',
    pass: dangling.length === 0,
    detail:
      dangling.length === 0
        ? `${turn.citations.length} citation(s), all to listed sources`
        : `[${dangling.join(', ')}] cite no listed source`,
  });

  if (expect.recalls !== undefined) {
    const recalled = turn.exchangesRecalled > 0;
    results.push({
      name: expect.recalls ? 'recalls history' : 'recalls nothing',
      pass: recalled === expect.recalls,
      detail: `${turn.exchangesRecalled} exchange(s) recalled${
        turn.dateMisses.length
          ? `; no record for ${turn.dateMisses.join(', ')}`
          : ''
      }`,
    });
  }

  if (expect.missesDate !== undefined) {
    const missed = turn.dateMisses.length > 0;
    results.push({
      name: expect.missesDate ? 'finds the date empty' : 'finds the date',
      pass: missed === expect.missesDate,
      detail: missed
        ? `no record for ${turn.dateMisses.join(', ')}`
        : 'every date had a record',
    });
  }

  if (expect.searches !== undefined) {
    const searched = turn.searches > 0;
    results.push({
      name: expect.searches ? 'searches' : 'answers without searching',
      pass: searched === expect.searches,
      detail: searched
        ? `${turn.searches} search call(s): ${turn.queries.join(' | ')}`
        : 'no search',
    });
  }

  if (expect.cites) {
    results.push({
      name: 'cites sources',
      pass: turn.citations.length > 0,
      detail: `${turn.citations.length} citation(s)`,
    });
  }

  if (expect.mentions) {
    const answer = turn.answer.toLowerCase();
    const found = expect.mentions.names.filter((name) =>
      answer.includes(name.toLowerCase()),
    );
    results.push({
      name: 'mentions',
      pass: found.length >= expect.mentions.min,
      detail: `${found.length}/${expect.mentions.min} needed: ${found.join(', ') || 'none'}`,
    });
  }

  if (expect.matches) {
    results.push({
      name: 'says',
      pass: expect.matches.test(turn.answer),
      detail: String(expect.matches),
    });
  }

  if (expect.rejects) {
    results.push({
      name: 'does not say',
      pass: !expect.rejects.test(turn.answer),
      detail: String(expect.rejects),
    });
  }

  return results;
}

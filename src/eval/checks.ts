// Deterministic checks for one live turn. No model grades another model here:
// every check reads the event stream, so a failure names exactly what went
// wrong (no recall, no search, a citation pointing at nothing).
import type { AgentEvent } from '../agent/events.js';
import type { Source } from '../search/sources.js';

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
  /**
   * No table row or list item may match this. Narrower than `rejects`: a
   * headline such as "Pipedrive differs, while the other four remain
   * unchanged" is correct, and only a row says "unchanged" of one item.
   */
  rejectsInRows?: RegExp;
  /**
   * Every table row or list item that says "unchanged" must carry a [n]. A
   * live answer read "Salesforce: $165, unchanged" with no source: the
   * remembered value passed off as checked.
   */
  citesVerdicts?: boolean;
  /**
   * In a table row or list item naming exactly one of these, every cited
   * source must mention that name in its title, URL or snippet. Live answers
   * cited a Freshsales page for a Pipedrive price, and reused the numbers of
   * remembered sources, which point at other pages this turn.
   */
  rowSources?: string[];
}

/** A turn's events reduced to what the checks and the report need. */
export interface TurnSummary {
  answer: string;
  exchangesRecalled: number;
  dateMisses: string[];
  searches: number;
  queries: string[];
  sourceNumbers: number[];
  /** The turn's sources as listed, for checks that read what a citation points at. */
  sources: Source[];
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
    sources: [],
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
        summary.sources = event.sources;
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

/** Table rows and list items: the lines where an answer makes one claim per item. */
function itemLines(answer: string): string[] {
  return answer
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(\||[-*•]\s|\d+[.)]\s)/.test(line))
    .filter((line) => !/^\|[\s:|-]+\|?$/.test(line));
}

/** A line cut short for a failure message. */
function excerpt(line: string): string {
  return line.length <= 80 ? line : `${line.slice(0, 80)}…`;
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

  if (expect.rejectsInRows) {
    const pattern = expect.rejectsInRows;
    const bad = itemLines(turn.answer).filter((line) => pattern.test(line));
    results.push({
      name: 'no row says',
      pass: bad.length === 0,
      detail:
        bad.length === 0
          ? String(pattern)
          : `${String(pattern)} in: ${bad.map(excerpt).join(' / ')}`,
    });
  }

  if (expect.citesVerdicts) {
    const uncited = itemLines(turn.answer).filter(
      (line) => /\bunchanged\b/i.test(line) && citedNumbers(line).length === 0,
    );
    results.push({
      name: 'cites every unchanged verdict',
      pass: uncited.length === 0,
      detail:
        uncited.length === 0
          ? 'no uncited "unchanged"'
          : `no citation: ${uncited.map(excerpt).join(' / ')}`,
    });
  }

  if (expect.rowSources) {
    const names = expect.rowSources;
    const byNumber = new Map(turn.sources.map((source) => [source.n, source]));
    const wrong: string[] = [];
    for (const line of itemLines(turn.answer)) {
      const lower = line.toLowerCase();
      const named = names.filter((name) => lower.includes(name.toLowerCase()));
      const [name] = named;
      if (named.length !== 1 || !name) continue;
      for (const n of new Set(citedNumbers(line))) {
        const source = byNumber.get(n);
        if (!source) continue; // "citations resolve" reports this one.
        const text =
          `${source.title} ${source.url} ${source.snippet ?? ''}`.toLowerCase();
        if (!text.includes(name.toLowerCase())) {
          wrong.push(`[${n}] (${source.title}) cited for ${name}`);
        }
      }
    }
    results.push({
      name: 'row sources match their item',
      pass: wrong.length === 0,
      detail:
        wrong.length === 0
          ? 'every row cites pages about its own item'
          : wrong.join(' / '),
    });
  }

  return results;
}

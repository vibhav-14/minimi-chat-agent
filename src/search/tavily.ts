import { z } from 'zod';
import {
  SearchError,
  type SearchProvider,
  type SearchRequest,
  type SearchResult,
} from './types.js';

const ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_TIMEOUT_MS = 10_000;

export const tavilySearchDepths = ['basic', 'advanced'] as const;
export type TavilySearchDepth = (typeof tavilySearchDepths)[number];

// Advanced costs 2 credits instead of 1 and is slower, but each result then
// carries the passages of the page most relevant to the query (about 800
// characters each) instead of shorter generic ones. "Has the price changed?"
// is answered by the pricing table, not by a page summary, and a wrong answer
// costs more than a second of latency. On the free tier (1,000 credits a
// month) that is about 100 five-query turns; TAVILY_SEARCH_DEPTH=basic halves
// the cost. `fast` and `ultra-fast` are not offered: they trade away the
// relevance this choice is for.
export const DEFAULT_SEARCH_DEPTH: TavilySearchDepth = 'advanced';

export interface TavilyOptions {
  apiKey: string;
  searchDepth: TavilySearchDepth;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const responseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      score: z.number().optional(),
      published_date: z.string().nullish(),
    }),
  ),
});

const errorBodySchema = z.object({
  detail: z.object({ error: z.string() }),
});

export function createTavilyProvider(options: TavilyOptions): SearchProvider {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async search(request) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout;

      let response: Response;
      let body: unknown;
      try {
        response = await fetchFn(ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestBody(request, options.searchDepth)),
          signal,
        });
        // A body that is not JSON is judged below, by status or by shape;
        // an abort while reading it is handled like any other abort.
        body = await response.json().catch((error: unknown) => {
          if (signal.aborted) throw error;
          return undefined;
        });
      } catch (error) {
        // A cancelled turn is not a provider failure: let the caller see its own abort.
        if (request.signal?.aborted) throw request.signal.reason;
        if (timeout.aborted) {
          throw new SearchError(
            'timeout',
            `Tavily did not answer within ${timeoutMs / 1000} s.`,
            { cause: error },
          );
        }
        throw new SearchError(
          'other',
          `Could not reach Tavily: ${message(error)}`,
          {
            cause: error,
          },
        );
      }

      if (!response.ok) throw httpError(response, body);

      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) {
        throw new SearchError(
          'other',
          'Tavily returned an unexpected response.',
          {
            cause: parsed.error,
          },
        );
      }
      return applySince(parsed.data.results.map(toResult), request.since);
    },
  };
}

function requestBody(request: SearchRequest, searchDepth: TavilySearchDepth) {
  // `since` is deliberately not sent as start_date; see applySince.
  return {
    query: request.query,
    search_depth: searchDepth,
    topic: request.topic ?? 'general',
    max_results: request.maxResults,
    include_published_date: true,
  };
}

function toResult(
  raw: z.infer<typeof responseSchema>['results'][number],
): SearchResult {
  const publishedDate = toIsoDate(raw.published_date);
  return {
    title: raw.title,
    url: raw.url,
    content: raw.content,
    ...(publishedDate && { publishedDate }),
    ...(raw.score !== undefined && { score: raw.score }),
  };
}

/**
 * "Since" keeps results dated on or after the date, then undated results;
 * results dated before it are dropped.
 *
 * Tavily's own filter_by_published_date also drops every undated result, and
 * pricing and product pages, the pages that answer "has the price changed
 * since Monday?", usually carry no publish date. They show the current state,
 * which the model compares with what it said then. Dated material from before
 * the date is the noise to remove: an old article about a past price change
 * is what would lead the model to report a stale change as new.
 */
function applySince(
  results: SearchResult[],
  since: string | undefined,
): SearchResult[] {
  if (!since) return results;
  const kept = results.filter(
    (result) => !result.publishedDate || result.publishedDate >= since,
  );
  const dated = kept.filter((result) => result.publishedDate);
  const undated = kept.filter((result) => !result.publishedDate);
  return [...dated, ...undated];
}

/** Tavily's dates come in more than one format; anything unparseable counts as undated. */
function toIsoDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time)
    ? undefined
    : new Date(time).toISOString().slice(0, 10);
}

function httpError(response: Response, body: unknown): SearchError {
  const { status } = response;
  const parsed = errorBodySchema.safeParse(body);
  const detail = parsed.success
    ? parsed.data.detail.error
    : response.statusText;

  if (status === 401 || status === 403) {
    return new SearchError(
      'auth',
      `Tavily rejected the API key (HTTP ${status}). Check TAVILY_API_KEY in .env.`,
    );
  }
  if (status === 429 || status === 434) {
    const retryAfter = response.headers.get('retry-after');
    const wait = retryAfter
      ? ` Retry after ${retryAfter} s.`
      : ' Retry shortly.';
    return new SearchError(
      'rate_limit',
      `Tavily is rate limiting requests.${wait}`,
    );
  }
  if (status === 432 || status === 433) {
    return new SearchError(
      'quota',
      `The Tavily plan's usage limit is reached (HTTP ${status}): ${detail}`,
    );
  }
  return new SearchError(
    'other',
    `Tavily request failed (HTTP ${status}): ${detail}`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

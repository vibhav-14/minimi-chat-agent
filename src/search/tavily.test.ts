import { describe, expect, it } from 'vitest';
import { createTavilyProvider, type TavilyOptions } from './tavily.js';
import { SearchError, type SearchErrorKind } from './types.js';

interface Call {
  url: Parameters<typeof fetch>[0];
  init: RequestInit;
}

/** A fetch that records each call and answers with the given response. */
function fakeFetch(respond: () => Response) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ url: input, init: init ?? {} });
    return Promise.resolve(respond());
  };
  return { calls, fetchFn };
}

function provider(fetchFn: typeof fetch, options: Partial<TavilyOptions> = {}) {
  return createTavilyProvider({
    apiKey: 'tvly-test',
    searchDepth: 'advanced',
    fetch: fetchFn,
    ...options,
  });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function sentBody(call: Call | undefined): unknown {
  const body = call?.init.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(body);
}

async function searchError(promise: Promise<unknown>): Promise<SearchError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (error instanceof SearchError) return error;
  throw new Error(`expected a SearchError, got ${String(error)}`);
}

describe('Tavily request', () => {
  it('posts the query with bearer auth, the configured depth and published dates on', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ results: [] }));

    await provider(fetchFn, { searchDepth: 'basic' }).search({
      query: 'Pipedrive pricing',
      topic: 'news',
      maxResults: 7,
    });

    expect(calls[0]?.url).toBe('https://api.tavily.com/search');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer tvly-test',
    });
    expect(sentBody(calls[0])).toEqual({
      query: 'Pipedrive pricing',
      search_depth: 'basic',
      topic: 'news',
      max_results: 7,
      include_published_date: true,
    });
  });

  // Tavily's date filter would drop undated pricing pages; `since` is applied
  // to the response instead (see the next block).
  it('does not pass since to Tavily as a date filter', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ results: [] }));

    await provider(fetchFn).search({ query: 'q', since: '2026-11-09' });

    const body = sentBody(calls[0]);
    expect(body).not.toHaveProperty('start_date');
    expect(body).not.toHaveProperty('filter_by_published_date');
    expect(body).toMatchObject({ topic: 'general' });
  });
});

describe('Tavily response', () => {
  const results = [
    {
      title: 'Old news',
      url: 'https://a.test/old',
      content: 'Price rose in 2025',
      score: 0.9,
      published_date: '2025-03-01',
    },
    {
      title: 'Pricing page',
      url: 'https://a.test/pricing',
      content: '$15 per seat',
      score: 0.8,
      published_date: null,
    },
    {
      title: 'Launch post',
      url: 'https://a.test/launch',
      content: 'New AI features',
      score: 0.7,
      published_date: 'Tue, 10 Nov 2026 09:00:00 GMT',
    },
  ];

  it('maps results and normalizes dates to YYYY-MM-DD', async () => {
    const { fetchFn } = fakeFetch(() => json({ query: 'q', results }));

    const found = await provider(fetchFn).search({ query: 'q' });

    expect(found).toEqual([
      {
        title: 'Old news',
        url: 'https://a.test/old',
        content: 'Price rose in 2025',
        score: 0.9,
        publishedDate: '2025-03-01',
      },
      {
        title: 'Pricing page',
        url: 'https://a.test/pricing',
        content: '$15 per seat',
        score: 0.8,
      },
      {
        title: 'Launch post',
        url: 'https://a.test/launch',
        content: 'New AI features',
        score: 0.7,
        publishedDate: '2026-11-10',
      },
    ]);
  });

  it('with since, drops results dated before it, keeps undated ones and puts dated ones first', async () => {
    const { fetchFn } = fakeFetch(() => json({ results }));

    const found = await provider(fetchFn).search({
      query: 'q',
      since: '2026-11-09',
    });

    expect(found.map((result) => result.title)).toEqual([
      'Launch post',
      'Pricing page',
    ]);
  });

  it('keeps a result published on the since date itself', async () => {
    const { fetchFn } = fakeFetch(() =>
      json({ results: [{ ...results[0], published_date: '2026-11-09' }] }),
    );

    const found = await provider(fetchFn).search({
      query: 'q',
      since: '2026-11-09',
    });

    expect(found).toHaveLength(1);
  });

  it('treats an unparseable date as undated', async () => {
    const { fetchFn } = fakeFetch(() =>
      json({
        results: [{ ...results[0], published_date: 'sometime last year' }],
      }),
    );

    const [found] = await provider(fetchFn).search({
      query: 'q',
      since: '2026-11-09',
    });

    expect(found?.publishedDate).toBeUndefined();
  });

  it.each([
    ['a body without results', { answer: 'hi' }],
    ['a result without a url', { results: [{ title: 't', content: 'c' }] }],
    ['a body that is not an object', 'oops'],
  ])('rejects %s as an unexpected response', async (_, body) => {
    const { fetchFn } = fakeFetch(() => json(body));

    const error = await searchError(provider(fetchFn).search({ query: 'q' }));

    expect(error.kind).toBe('other');
    expect(error.message).toContain('unexpected response');
  });

  it('rejects a body that is not JSON', async () => {
    const { fetchFn } = fakeFetch(() => new Response('<html>gateway</html>'));

    const error = await searchError(provider(fetchFn).search({ query: 'q' }));

    expect(error.message).toContain('unexpected response');
  });
});

describe('Tavily errors', () => {
  it.each<[number, SearchErrorKind, string]>([
    [401, 'auth', 'TAVILY_API_KEY'],
    [403, 'auth', 'TAVILY_API_KEY'],
    [429, 'rate_limit', 'Retry after 30 s'],
    [432, 'quota', 'exceeds your plan'],
    [433, 'quota', 'exceeds your plan'],
    [434, 'rate_limit', 'Retry after 30 s'],
    [400, 'other', 'HTTP 400'],
    [500, 'other', 'HTTP 500'],
    [503, 'other', 'HTTP 503'],
  ])('maps HTTP %i to %s', async (status, kind, mentions) => {
    const { fetchFn } = fakeFetch(() =>
      json(
        {
          detail: {
            error: "This request exceeds your plan's set usage limit.",
          },
        },
        { status, headers: { 'retry-after': '30' } },
      ),
    );

    const error = await searchError(provider(fetchFn).search({ query: 'q' }));

    expect(error.kind).toBe(kind);
    expect(error.message).toContain(mentions);
  });

  it('reports a network failure', async () => {
    const fetchFn: typeof fetch = () =>
      Promise.reject(new TypeError('fetch failed'));

    const error = await searchError(provider(fetchFn).search({ query: 'q' }));

    expect(error.kind).toBe('other');
    expect(error.message).toContain('fetch failed');
  });

  /** A fetch that never answers, and rejects once its signal aborts, as real fetch does. */
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason as Error));
    });

  it('gives up with a timeout error when Tavily does not answer in time', async () => {
    const error = await searchError(
      provider(hangingFetch, { timeoutMs: 5 }).search({ query: 'q' }),
    );

    expect(error.kind).toBe('timeout');
  });

  // A cancelled turn must stop the loop, not be reported to the model as a failed search.
  it('rethrows the caller abort as is', async () => {
    const controller = new AbortController();
    const reason = new Error('turn cancelled');
    const pending = provider(hangingFetch).search({
      query: 'q',
      signal: controller.signal,
    });

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});

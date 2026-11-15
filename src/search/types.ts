export type SearchTopic = 'general' | 'news';

export interface SearchRequest {
  query: string;
  topic?: SearchTopic;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  /** YYYY-MM-DD, when the provider could tell. */
  publishedDate?: string;
  score?: number;
}

/**
 * A web search backend. The agent depends on this, never on a vendor API.
 * It returns results unfiltered by date, with `publishedDate` where known;
 * the web_search tool applies `since`.
 */
export interface SearchProvider {
  search(request: SearchRequest): Promise<SearchResult[]>;
}

/**
 * Why a search failed, so the agent can tell the model something it can act
 * on: `rate_limit` may succeed if retried later, `quota` and `auth` will not.
 */
export type SearchErrorKind =
  'auth' | 'rate_limit' | 'quota' | 'timeout' | 'other';

export class SearchError extends Error {
  override name = 'SearchError';

  constructor(
    readonly kind: SearchErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

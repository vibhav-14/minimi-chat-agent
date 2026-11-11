/**
 * A numbered source the model can cite as [n]. Stored with the answer it
 * supports, so the search tool and the memory store share this one shape.
 */
export interface Source {
  n: number;
  url: string;
  title: string;
  publishedDate?: string;
  /**
   * The start of what the model read from this page when it answered. Kept so
   * a later "is that still correct?" can compare what the page said then
   * with what it says now, not just re-open a link.
   */
  snippet?: string;
}

const TRACKING_PARAMS = new Set([
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
]);

/**
 * The key two links to the same page share: no fragment, no tracking
 * parameters, no trailing slash. The host is lowercased by URL itself.
 */
export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim();
  }
  parsed.hash = '';
  for (const name of [...parsed.searchParams.keys()]) {
    if (name.startsWith('utm_') || TRACKING_PARAMS.has(name)) {
      parsed.searchParams.delete(name);
    }
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

/**
 * Numbers sources for one assistant turn. A turn can make several searches;
 * a page keeps the number it got first, so [n] means the same page in every
 * search result the model read during the turn.
 */
export class SourceRegistry {
  private readonly byUrl = new Map<string, Source>();

  /** The source for this page, numbered on first sight. `isNew` is false if it was seen before. */
  add(page: Omit<Source, 'n'>): { source: Source; isNew: boolean } {
    const key = normalizeUrl(page.url);
    const known = this.byUrl.get(key);
    if (known) return { source: known, isNew: false };

    const source: Source = { n: this.byUrl.size + 1, ...page };
    this.byUrl.set(key, source);
    return { source, isNew: true };
  }

  /** Every source of the turn, in citation order. */
  list(): Source[] {
    return [...this.byUrl.values()];
  }
}

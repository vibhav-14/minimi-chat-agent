// Display text for dates and activity. No DOM, so it is unit-tested.

/**
 * Formatting options default to the browser's locale and time zone; tests
 * pin both.
 *
 * @typedef {object} Locale
 * @property {string} [locale]
 * @property {string} [timeZone]
 */

/**
 * A message time with its date, because dates are what this app is about:
 * "Tue, 10 Nov 2026, 20:30" in the browser's zone and locale.
 *
 * @param {Date} date
 * @param {Locale} [options]
 */
export function formatTimestamp(date, { locale, timeZone } = {}) {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

/**
 * A calendar day the server resolved ("2026-11-10"), as "10 Nov 2026". The
 * day is already the user's local day, so it is formatted without a zone shift.
 *
 * @param {string} day YYYY-MM-DD
 * @param {string} [locale]
 */
export function formatDay(day, locale) {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * A source's publish date as a day ("5 Nov 2026"), or null when there is
 * none or it cannot be read. Search providers send ISO dates or HTTP dates.
 *
 * @param {string | undefined} published
 * @param {Locale} [options]
 * @returns {string | null}
 */
export function formatPublished(published, { locale, timeZone } = {}) {
  if (!published) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(published))
    return formatDay(published, locale);
  const date = new Date(published);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(date);
}

/**
 * Time waited so far, to the second: "4 s", "1 min 05 s".
 *
 * @param {number} ms
 */
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const rest = String(seconds % 60).padStart(2, '0');
  return `${Math.floor(seconds / 60)} min ${rest} s`;
}

/**
 * The site a link goes to, without "www.": "pipedrive.com".
 *
 * @param {string} url
 */
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
function count(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One quiet line saying what memory found for the message, or null when
 * there is nothing worth saying (no date missed and nothing recalled).
 *
 * @param {Extract<import('./types.js').AgentEvent, { type: 'recall' }>} event
 * @param {string} [locale]
 * @returns {string | null}
 */
export function describeRecall(event, locale) {
  /** @param {{ text: string, days: string[] }} date */
  const label = (date) => {
    const days = date.days.map((day) => formatDay(day, locale)).join(' or ');
    return `"${date.text}" (${days})`;
  };
  const missed = event.dates.filter((date) => event.misses.includes(date.text));
  const found = event.dates.filter((date) => !missed.includes(date));
  const parts = [];
  if (event.exchanges > 0) {
    const recalled = `Recalled ${count(event.exchanges, 'earlier exchange')}`;
    parts.push(
      found.length > 0
        ? `${recalled} for ${found.map(label).join(', ')}`
        : recalled,
    );
  }
  for (const date of missed) parts.push(`Nothing stored for ${label(date)}`);
  return parts.length > 0 ? parts.join('. ') : null;
}

/**
 * A query of a running or finished search: still searching, or its report.
 *
 * @typedef {{ query: string, status: 'searching' }
 *   | import('./types.js').QueryReport} QueryState
 */

/**
 * @param {QueryState} state
 */
export function describeQuery(state) {
  switch (state.status) {
    case 'searching':
      return 'searching';
    case 'ok':
      return count(state.sources.length, 'result');
    case 'failed':
      return `failed: ${state.message}`;
  }
}

/**
 * The one-line summary of a turn's searches, shown when they are collapsed.
 *
 * @param {QueryState[]} queries
 */
export function describeSearch(queries) {
  const total = count(queries.length, 'query', 'queries');
  if (queries.some((query) => query.status === 'searching')) {
    return `Searching the web: ${total}`;
  }
  let results = 0;
  let failed = 0;
  for (const query of queries) {
    if (query.status === 'ok') results += query.sources.length;
    if (query.status === 'failed') failed++;
  }
  const summary = `Searched ${total}, ${count(results, 'result')}`;
  return failed > 0 ? `${summary}, ${failed} failed` : summary;
}

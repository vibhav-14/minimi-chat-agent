// The DOM for one message. A live turn and a message loaded from history go
// through the same view, so both look the same.
import { el } from './dom.js';
import {
  describeQuery,
  describeRecall,
  describeSearch,
  domainOf,
  formatPublished,
  formatTimestamp,
} from './format.js';
import { citedNumbers, parseMarkdown, safeUrl } from './markdown.js';
import { externalLink, renderMarkdown } from './render.js';

/** @typedef {import('./types.js').AgentEvent} AgentEvent */
/** @typedef {import('./types.js').Source} Source */
/** @typedef {import('./format.js').QueryState} QueryState */

/**
 * @param {string} label
 * @param {Date} date
 */
function meta(label, date) {
  return el(
    'header',
    { className: 'meta' },
    el('span', { className: 'role' }, label),
    ' ',
    el('time', { dateTime: date.toISOString() }, formatTimestamp(date)),
  );
}

/**
 * The user's words are shown exactly as typed, never as Markdown.
 *
 * @param {string} text
 * @param {Date} date
 */
export function userMessage(text, date) {
  return el(
    'article',
    { className: 'message user' },
    meta('You', date),
    el('p', { className: 'user-text' }, text),
  );
}

/**
 * One source: number, title linking to the page, site and publish date.
 *
 * @param {Source} source
 */
function sourceItem(source) {
  const href = safeUrl(source.url);
  const title = source.title || domainOf(source.url) || source.url;
  const published = formatPublished(source.publishedDate);
  return el(
    'li',
    {},
    el('span', { className: 'source-n' }, String(source.n)),
    el(
      'span',
      { className: 'source-body' },
      href ? externalLink(href, title) : title,
      el(
        'span',
        { className: 'source-meta' },
        [domainOf(source.url), published].filter(Boolean).join(' · '),
      ),
    ),
  );
}

export class AssistantMessage {
  /**
   * @param {Date} date
   * @param {() => void} onRender Called after the answer's DOM changes.
   */
  constructor(date, onRender) {
    this.onRender = onRender;
    this.text = '';
    this.frame = 0;
    // Busy while streaming, so a screen reader reads the answer once, when complete.
    this.body = el('div', {
      className: 'answer',
      ariaLive: 'polite',
      ariaBusy: 'true',
    });
    // What the turn did before answering: memory, then searches.
    this.activity = el('div', { className: 'activity' });
    /** @type {Map<number, Source> | null} Null until the sources event. */
    this.sources = null;
    this.sourceList = el('section', {
      className: 'sources',
      ariaLabel: 'Sources',
      hidden: true,
    });
    this.element = el(
      'article',
      { className: 'message assistant' },
      meta('Assistant', date),
      this.activity,
      this.body,
      this.sourceList,
    );
    /** @type {Map<string, QueryState[]>} Each search call's queries, by call id. */
    this.searches = new Map();
    // Built once and updated in place, so a focused summary keeps its focus.
    this.searchSummary = el('summary');
    this.searchList = el('ul');
    this.searchDetails = el(
      'details',
      { className: 'activity-search' },
      this.searchSummary,
      this.searchList,
    );
    // Searches stay open while they run and fold to one line once the answer starts.
    this.collapseOnText = false;
  }

  /** @param {Extract<AgentEvent, { type: 'recall' }>} event */
  recall(event) {
    const line = describeRecall(event);
    if (!line) return;
    this.activity.append(el('p', { className: 'activity-line' }, line));
    this.onRender();
  }

  /** @param {Extract<AgentEvent, { type: 'search_started' }>} event */
  searchStarted(event) {
    this.searches.set(
      event.callId,
      event.queries.map((query) => ({ query, status: 'searching' })),
    );
    this.collapseOnText = true;
    this.searchDetails.open = true;
    if (!this.searchDetails.isConnected)
      this.activity.append(this.searchDetails);
    this.renderSearches();
  }

  /** @param {Extract<AgentEvent, { type: 'search_finished' }>} event */
  searchFinished(event) {
    this.searches.set(event.callId, event.queries);
    this.renderSearches();
  }

  renderSearches() {
    const queries = [...this.searches.values()].flat();
    this.searchSummary.textContent = describeSearch(queries);
    this.searchList.replaceChildren(
      ...queries.map((state) =>
        el(
          'li',
          { className: `query ${state.status}` },
          el('span', { className: 'query-text' }, state.query),
          ' ',
          el('span', { className: 'query-status' }, describeQuery(state)),
        ),
      ),
    );
    this.onRender();
  }

  /**
   * Adds streamed text. Rendering waits for the next frame, so a burst of
   * tokens costs one re-render, not one per token.
   *
   * @param {string} delta
   */
  appendText(delta) {
    this.text += delta;
    if (this.collapseOnText) {
      this.searchDetails.open = false;
      this.collapseOnText = false;
    }
    this.frame ||= requestAnimationFrame(() => this.render());
  }

  /**
   * The sources the answer may cite. From here on its [n] become links.
   *
   * @param {Source[]} sources
   */
  setSources(sources) {
    this.sources = new Map(sources.map((source) => [source.n, source]));
    this.render();
  }

  /** Re-reads the whole answer, so markup split across tokens comes out right. */
  render() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const blocks = parseMarkdown(this.text);
    this.body.replaceChildren(renderMarkdown(blocks, this.sources));
    if (this.sources) this.renderSources(citedNumbers(blocks));
    this.onRender();
  }

  /**
   * Cited sources are listed under the answer; pages read but not cited
   * fold into one line below them.
   *
   * @param {Set<number>} cited
   */
  renderSources(cited) {
    const all = [...(this.sources?.values() ?? [])];
    const used = all.filter((source) => cited.has(source.n));
    const unused = all.filter((source) => !cited.has(source.n));
    const pages = unused.length === 1 ? 'page' : 'pages';
    this.sourceList.replaceChildren(
      el('h3', { className: 'sources-title' }, 'Sources'),
      el(
        'ul',
        { hidden: used.length === 0 },
        ...used.map((source) => sourceItem(source)),
      ),
      el(
        'details',
        { hidden: unused.length === 0 },
        el('summary', {}, `${unused.length} more ${pages} read, not cited`),
        el('ul', {}, ...unused.map((source) => sourceItem(source))),
      ),
    );
    this.sourceList.hidden = all.length === 0;
  }

  /** The answer is complete. */
  finish() {
    this.render();
    this.body.ariaBusy = 'false';
  }

  /**
   * The turn ended with an error; any partial answer stays above it.
   *
   * @param {string} kind
   * @param {string} message
   */
  fail(kind, message) {
    const title =
      kind === 'config' ? 'Setup needed' : 'The answer could not be completed';
    this.finish();
    this.element.append(
      el(
        'div',
        { className: 'notice error', role: 'alert' },
        el('p', { className: 'notice-title' }, title),
        el('p', { className: 'notice-text' }, message),
      ),
    );
    this.onRender();
  }

  /**
   * The turn ended early (stopped, or the connection dropped); the partial
   * answer stays, marked as incomplete.
   *
   * @param {string} note
   */
  stop(note) {
    this.finish();
    this.element.append(el('p', { className: 'notice stopped' }, note));
    this.onRender();
  }
}

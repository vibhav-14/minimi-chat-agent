// The DOM for one message. A live turn and a message loaded from history go
// through the same view, so both look the same.
import { el } from './dom.js';
import { formatTimestamp } from './format.js';
import { parseMarkdown } from './markdown.js';
import { renderMarkdown } from './render.js';

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
    this.element = el(
      'article',
      { className: 'message assistant' },
      meta('Assistant', date),
      this.body,
    );
  }

  /**
   * Adds streamed text. Rendering waits for the next frame, so a burst of
   * tokens costs one re-render, not one per token.
   *
   * @param {string} delta
   */
  appendText(delta) {
    this.text += delta;
    this.frame ||= requestAnimationFrame(() => this.render());
  }

  /** Re-reads the whole answer, so markup split across tokens comes out right. */
  render() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.body.replaceChildren(renderMarkdown(parseMarkdown(this.text)));
    this.onRender();
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

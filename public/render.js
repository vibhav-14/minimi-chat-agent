// Turns the Markdown reader's data (markdown.js) into DOM nodes. Every piece
// of text goes in as a text node; links were already limited to http(s).
import { el } from './dom.js';
import { citationTarget } from './markdown.js';

/** @typedef {import('./markdown.js').Block} Block */
/** @typedef {import('./markdown.js').Inline} Inline */
/**
 * The turn's sources by number, or null while they have not arrived.
 *
 * @typedef {Map<number, import('./types.js').Source> | null} Sources
 */

// The page title is the h1, so an answer's own headings start at h3.
/** @type {('h3' | 'h4' | 'h5' | 'h6')[]} */
const HEADING_TAGS = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'];

/**
 * @param {Block[]} blocks
 * @param {Sources} sources
 * @returns {DocumentFragment}
 */
export function renderMarkdown(blocks, sources) {
  const fragment = document.createDocumentFragment();
  fragment.append(...blocks.map((block) => renderBlock(block, sources)));
  return fragment;
}

/**
 * @param {Block} block
 * @param {Sources} sources
 * @returns {HTMLElement}
 */
function renderBlock(block, sources) {
  switch (block.type) {
    case 'paragraph':
      return el('p', {}, ...renderInlines(block.children, sources));
    case 'heading':
      return el(
        HEADING_TAGS[block.level - 1] ?? 'h6',
        {},
        ...renderInlines(block.children, sources),
      );
    case 'code':
      return el('pre', {}, el('code', {}, block.text));
    case 'list': {
      const items = block.items.map((item) =>
        el('li', {}, ...renderItem(item, sources)),
      );
      return block.ordered
        ? el('ol', block.start === 1 ? {} : { start: block.start }, ...items)
        : el('ul', {}, ...items);
    }
    case 'table': {
      /** @param {'th' | 'td'} tag @param {Inline[][]} cells */
      const row = (tag, cells) =>
        el(
          'tr',
          {},
          ...cells.map((cell, i) => {
            const element = el(tag, {}, ...renderInlines(cell, sources));
            const align = block.align[i];
            if (align) element.style.textAlign = align;
            return element;
          }),
        );
      return el(
        'div',
        { className: 'table-wrap' },
        el(
          'table',
          {},
          el('thead', {}, row('th', block.head)),
          el('tbody', {}, ...block.rows.map((cells) => row('td', cells))),
        ),
      );
    }
    case 'rule':
      return el('hr');
  }
}

/**
 * A list item that is one paragraph renders without the paragraph, so tight
 * lists do not get paragraph spacing.
 *
 * @param {Block[]} blocks
 * @param {Sources} sources
 * @returns {(Node | string)[]}
 */
function renderItem(blocks, sources) {
  const [only] = blocks;
  if (blocks.length === 1 && only?.type === 'paragraph') {
    return renderInlines(only.children, sources);
  }
  return blocks.map((block) => renderBlock(block, sources));
}

/**
 * @param {Inline[]} nodes
 * @param {Sources} sources
 * @returns {(Node | string)[]}
 */
function renderInlines(nodes, sources) {
  return nodes.map((node) => renderInline(node, sources));
}

/**
 * @param {Inline} node
 * @param {Sources} sources
 * @returns {Node | string}
 */
function renderInline(node, sources) {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'code':
      return el('code', {}, node.text);
    case 'strong':
      return el('strong', {}, ...renderInlines(node.children, sources));
    case 'em':
      return el('em', {}, ...renderInlines(node.children, sources));
    case 'link':
      return externalLink(node.href, ...renderInlines(node.children, sources));
    case 'cite': {
      const target = citationTarget(node.n, sources);
      if (!target) return `[${node.n}]`;
      const link = externalLink(target.href, String(node.n));
      link.className = 'cite';
      link.title = target.title;
      link.ariaLabel = `Source ${node.n}: ${target.title}`;
      return el('sup', {}, link);
    }
    case 'break':
      return el('br');
  }
}

/**
 * A link that opens a web page in a new tab, without giving it a handle on
 * this page. `href` must already have passed safeUrl.
 *
 * @param {string} href
 * @param {...(Node | string)} children
 */
export function externalLink(href, ...children) {
  return el(
    'a',
    { href, target: '_blank', rel: 'noopener noreferrer' },
    ...children,
  );
}

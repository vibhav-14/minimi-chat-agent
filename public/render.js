// Turns the Markdown reader's data (markdown.js) into DOM nodes. Every piece
// of text goes in as a text node; links were already limited to http(s).
import { el } from './dom.js';

/** @typedef {import('./markdown.js').Block} Block */
/** @typedef {import('./markdown.js').Inline} Inline */

// The page title is the h1, so an answer's own headings start at h3.
/** @type {('h3' | 'h4' | 'h5' | 'h6')[]} */
const HEADING_TAGS = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'];

/**
 * @param {Block[]} blocks
 * @returns {DocumentFragment}
 */
export function renderMarkdown(blocks) {
  const fragment = document.createDocumentFragment();
  fragment.append(...blocks.map(renderBlock));
  return fragment;
}

/**
 * @param {Block} block
 * @returns {HTMLElement}
 */
function renderBlock(block) {
  switch (block.type) {
    case 'paragraph':
      return el('p', {}, ...renderInlines(block.children));
    case 'heading':
      return el(
        HEADING_TAGS[block.level - 1] ?? 'h6',
        {},
        ...renderInlines(block.children),
      );
    case 'code':
      return el('pre', {}, el('code', {}, block.text));
    case 'list': {
      const items = block.items.map((item) =>
        el('li', {}, ...renderItem(item)),
      );
      return block.ordered
        ? el('ol', block.start === 1 ? {} : { start: block.start }, ...items)
        : el('ul', {}, ...items);
    }
    case 'table':
      return el(
        'div',
        { className: 'table-wrap' },
        el(
          'table',
          {},
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              ...block.head.map((cell, i) =>
                tableCell('th', cell, block.align[i]),
              ),
            ),
          ),
          el(
            'tbody',
            {},
            ...block.rows.map((row) =>
              el(
                'tr',
                {},
                ...row.map((cell, i) => tableCell('td', cell, block.align[i])),
              ),
            ),
          ),
        ),
      );
    case 'rule':
      return el('hr');
  }
}

/**
 * A list item that is one paragraph renders without the paragraph, so tight
 * lists do not get paragraph spacing.
 *
 * @param {Block[]} blocks
 * @returns {(Node | string)[]}
 */
function renderItem(blocks) {
  const [only] = blocks;
  if (blocks.length === 1 && only?.type === 'paragraph') {
    return renderInlines(only.children);
  }
  return blocks.map(renderBlock);
}

/**
 * @param {'th' | 'td'} tag
 * @param {Inline[]} content
 * @param {import('./markdown.js').Align | undefined} align
 */
function tableCell(tag, content, align) {
  const cell = el(tag, {}, ...renderInlines(content));
  if (align) cell.style.textAlign = align;
  return cell;
}

/**
 * @param {Inline[]} nodes
 * @returns {(Node | string)[]}
 */
function renderInlines(nodes) {
  return nodes.map(renderInline);
}

/**
 * @param {Inline} node
 * @returns {Node | string}
 */
function renderInline(node) {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'code':
      return el('code', {}, node.text);
    case 'strong':
      return el('strong', {}, ...renderInlines(node.children));
    case 'em':
      return el('em', {}, ...renderInlines(node.children));
    case 'link':
      return externalLink(node.href, ...renderInlines(node.children));
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

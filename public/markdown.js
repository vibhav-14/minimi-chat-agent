// A small Markdown reader for the model's answers. It returns plain data, not
// HTML: render.js turns the data into DOM nodes with textContent, so nothing
// the model or a web page wrote is ever parsed as HTML. It covers what the
// system prompt asks the model to write (paragraphs, lists, small tables,
// headings, emphasis, code, links) and must give a sensible result for any
// prefix of an answer, because it re-reads the answer on every streamed batch.

/**
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'code', text: string }
 *   | { type: 'strong', children: Inline[] }
 *   | { type: 'em', children: Inline[] }
 *   | { type: 'link', href: string, children: Inline[] }
 *   | { type: 'break' }} Inline
 */

/** @typedef {'left' | 'center' | 'right' | null} Align */

/**
 * @typedef {{ type: 'paragraph', children: Inline[] }
 *   | { type: 'heading', level: number, children: Inline[] }
 *   | { type: 'code', text: string }
 *   | { type: 'list', ordered: boolean, start: number, items: Block[][] }
 *   | { type: 'table', align: Align[], head: Inline[][], rows: Inline[][][] }
 *   | { type: 'rule' }} Block
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
// Content is optional so a half-streamed "2." already reads as an item.
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
// Any ASCII punctuation may be escaped with a backslash.
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const LINK = /\[([^\]\n]+)\]\(\s*([^\s)]+)\s*\)/y;

/**
 * The URL if it is an absolute http or https URL, else null. Links from the
 * model or a search result may say `javascript:` or `data:`; only web pages
 * are ever made clickable.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  return parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'));
}

/**
 * @param {string[]} lines
 * @returns {Block[]}
 */
function parseBlocks(lines) {
  /** @type {Block[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '';
      let end = i + 1;
      while (end < lines.length && !closesFence(lines[end] ?? '', marker)) {
        end++;
      }
      // An unclosed fence runs to the end: the rest is still streaming.
      blocks.push({ type: 'code', text: lines.slice(i + 1, end).join('\n') });
      i = end + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '').length,
        children: parseInline((heading[2] ?? '').replace(/\s+#+\s*$/, '')),
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    if (startsTable(lines, i)) {
      i = readTable(lines, i, blocks);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      i = readList(lines, i, blocks);
      continue;
    }

    const paragraph = [line.trim()];
    i++;
    while (i < lines.length && !endsParagraph(lines, i)) {
      paragraph.push((lines[i] ?? '').trim());
      i++;
    }
    blocks.push({
      type: 'paragraph',
      children: parseInline(paragraph.join('\n')),
    });
  }
  return blocks;
}

/**
 * @param {string} line
 * @param {string} marker The opening run of backticks or tildes.
 */
function closesFence(line, marker) {
  const run = line.trim();
  return run.length >= marker.length && [...run].every((c) => c === marker[0]);
}

/**
 * @param {string[]} lines
 * @param {number} i
 */
function endsParagraph(lines, i) {
  const line = lines[i] ?? '';
  return (
    line.trim() === '' ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    LIST_ITEM.test(line) ||
    startsTable(lines, i)
  );
}

/**
 * @param {string[]} lines
 * @param {number} i
 */
function startsTable(lines, i) {
  return (
    (lines[i] ?? '').includes('|') && TABLE_DIVIDER.test(lines[i + 1] ?? '')
  );
}

/**
 * Reads a pipe table starting at line `i` into `blocks`; returns the next line.
 *
 * @param {string[]} lines
 * @param {number} i
 * @param {Block[]} blocks
 */
function readTable(lines, i, blocks) {
  const head = splitRow(lines[i] ?? '');
  /** @type {Align[]} */
  const align = splitRow(lines[i + 1] ?? '').map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  /** @type {Inline[][][]} */
  const rows = [];
  let next = i + 2;
  while (next < lines.length) {
    const line = lines[next] ?? '';
    if (line.trim() === '' || !line.includes('|')) break;
    const cells = splitRow(line);
    // Every row gets the header's width, so a short or long row cannot shift columns.
    rows.push(head.map((_, column) => parseInline(cells[column] ?? '')));
    next++;
  }
  blocks.push({
    type: 'table',
    align: head.map((_, column) => align[column] ?? null),
    head: head.map((cell) => parseInline(cell)),
    rows,
  });
  return next;
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/**
 * @param {string} marker
 */
function isOrdered(marker) {
  return /\d/.test(marker);
}

/**
 * @param {string} line
 */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Reads a list starting at line `i` into `blocks`; returns the next line.
 * A line indented past the marker belongs to the item above it, and an
 * item's lines are read as blocks again, so lists nest.
 *
 * @param {string[]} lines
 * @param {number} i
 * @param {Block[]} blocks
 */
function readList(lines, i, blocks) {
  const first = LIST_ITEM.exec(lines[i] ?? '');
  const base = (first?.[1] ?? '').length;
  const ordered = isOrdered(first?.[2] ?? '');
  /** @type {string[][]} */
  const items = [];
  /** @type {string[]} */
  let item = [];
  let contentIndent = 0;

  /** @param {string} line */
  const sameList = (line) => {
    const match = LIST_ITEM.exec(line);
    return (
      match !== null &&
      indentOf(line) < base + 2 &&
      isOrdered(match[2] ?? '') === ordered
    );
  };

  let next = i;
  while (next < lines.length) {
    const line = lines[next] ?? '';
    if (sameList(line)) {
      const match = LIST_ITEM.exec(line);
      item = [match?.[3] ?? ''];
      items.push(item);
      contentIndent = (match?.[1] ?? '').length + (match?.[2] ?? '').length + 1;
      next++;
    } else if (line.trim() === '') {
      let after = next + 1;
      while (after < lines.length && (lines[after] ?? '').trim() === '')
        after++;
      const following = lines[after] ?? '';
      if (after < lines.length && indentOf(following) >= base + 2) {
        item.push(...lines.slice(next, after).map(() => ''));
        next = after;
      } else if (after < lines.length && sameList(following)) {
        next = after;
      } else {
        break;
      }
    } else if (indentOf(line) >= base + 2) {
      item.push(line.slice(Math.min(indentOf(line), contentIndent)));
      next++;
    } else {
      break;
    }
  }

  blocks.push({
    type: 'list',
    ordered,
    start: ordered ? parseInt(first?.[2] ?? '1', 10) : 1,
    items: items.map((itemLines) => parseBlocks(itemLines)),
  });
  return next;
}

/**
 * Inline markup. An opening `**`, `*` or backtick with no closing partner
 * stays literal text, so a half-streamed "**Neo" shows as typed rather than
 * turning the rest of the answer bold.
 *
 * @param {string} text
 * @returns {Inline[]}
 */
function parseInline(text) {
  /** @type {Inline[]} */
  const nodes = [];
  let plain = '';
  /** @param {Inline} node */
  const push = (node) => {
    if (plain) nodes.push({ type: 'text', text: plain });
    plain = '';
    nodes.push(node);
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? '';

    if (char === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (char === '\n') {
      push({ type: 'break' });
      i++;
      continue;
    }

    if (char === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = text.indexOf(fence, i + run);
      if (close === -1) {
        plain += fence;
      } else {
        push({ type: 'code', text: text.slice(i + run, close) });
      }
      i = close === -1 ? i + run : close + run;
      continue;
    }

    if (text.startsWith('**', i)) {
      const close = closingStrong(text, i + 2);
      if (close === -1) {
        plain += '**';
        i += 2;
      } else {
        push({
          type: 'strong',
          children: parseInline(text.slice(i + 2, close)),
        });
        i = close + 2;
      }
      continue;
    }

    if (char === '*') {
      const close = closingEm(text, i + 1);
      if (close === -1) {
        plain += '*';
        i++;
      } else {
        push({ type: 'em', children: parseInline(text.slice(i + 1, close)) });
        i = close + 1;
      }
      continue;
    }

    if (char === '[') {
      LINK.lastIndex = i;
      const link = LINK.exec(text);
      if (link) {
        const children = parseInline(link[1] ?? '');
        const href = safeUrl(link[2] ?? '');
        if (href) push({ type: 'link', href, children });
        // An unsafe link keeps its words and loses its target.
        else for (const child of children) pushInline(child);
        i += link[0].length;
        continue;
      }
    }

    plain += char;
    i++;
  }
  if (plain) nodes.push({ type: 'text', text: plain });
  return nodes;

  /** @param {Inline} node */
  function pushInline(node) {
    if (node.type === 'text') plain += node.text;
    else push(node);
  }
}

/**
 * Where a `**` opened before `from` closes, or -1. Emphasis must hug its
 * text: "** a" or "a **" is not markup.
 *
 * @param {string} text
 * @param {number} from
 */
function closingStrong(text, from) {
  if (/\s/.test(text[from] ?? ' ')) return -1;
  for (
    let j = text.indexOf('**', from + 1);
    j !== -1;
    j = text.indexOf('**', j + 1)
  ) {
    if (!/\s/.test(text[j - 1] ?? ' ')) return j;
  }
  return -1;
}

/**
 * Where a `*` opened before `from` closes, or -1. A `**` pair inside, as in
 * "*a **b** c*", is skipped over rather than taken as the close.
 *
 * @param {string} text
 * @param {number} from
 */
function closingEm(text, from) {
  if (/[\s*]/.test(text[from] ?? ' ')) return -1;
  for (let j = from + 1; j < text.length; j++) {
    if (text[j] !== '*') continue;
    if (text[j + 1] === '*') {
      j++;
      continue;
    }
    if (!/\s/.test(text[j - 1] ?? ' ')) return j;
  }
  return -1;
}

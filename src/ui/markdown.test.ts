// Tests for the answer Markdown reader (public/markdown.js).
import { describe, expect, it } from 'vitest';
import { parseMarkdown, safeUrl } from '../../public/markdown.js';

const text = (value: string) => ({ type: 'text', text: value });
const paragraph = (...children: unknown[]) => ({ type: 'paragraph', children });

describe('parseMarkdown blocks', () => {
  it('splits paragraphs on blank lines and keeps single newlines as breaks', () => {
    expect(parseMarkdown('One\ntwo\n\nThree')).toEqual([
      paragraph(text('One'), { type: 'break' }, text('two')),
      paragraph(text('Three')),
    ]);
  });

  it('reads headings at every level', () => {
    expect(parseMarkdown('# Top\n### Pricing ###')).toEqual([
      { type: 'heading', level: 1, children: [text('Top')] },
      { type: 'heading', level: 3, children: [text('Pricing')] },
    ]);
  });

  it('keeps fenced code verbatim, markup and all', () => {
    expect(
      parseMarkdown('```ts\nconst a = **b**;\n\n<i>x</i>\n```\nAfter'),
    ).toEqual([
      { type: 'code', text: 'const a = **b**;\n\n<i>x</i>' },
      paragraph(text('After')),
    ]);
  });

  it('reads unordered and ordered lists, with their start number', () => {
    expect(parseMarkdown('- a\n* b\n\n3. c\n4) d')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [[paragraph(text('a'))], [paragraph(text('b'))]],
      },
      {
        type: 'list',
        ordered: true,
        start: 3,
        items: [[paragraph(text('c'))], [paragraph(text('d'))]],
      },
    ]);
  });

  it('nests an indented list and keeps indented lines with their item', () => {
    expect(
      parseMarkdown('1. HubSpot\n   - $90\n   - annual\n2. Zoho\n   detail'),
    ).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 1,
        items: [
          [
            paragraph(text('HubSpot')),
            {
              type: 'list',
              ordered: false,
              start: 1,
              items: [[paragraph(text('$90'))], [paragraph(text('annual'))]],
            },
          ],
          [paragraph(text('Zoho'), { type: 'break' }, text('detail'))],
        ],
      },
    ]);
  });

  it('keeps one list across blank lines between items', () => {
    const [list] = parseMarkdown('1. a\n\n2. b\n\nAfter');

    expect(list).toMatchObject({ type: 'list', items: [[{}], [{}]] });
  });

  it('starts a list right after a paragraph line, as models write it', () => {
    expect(parseMarkdown('Options:\n- a').map((b) => b.type)).toEqual([
      'paragraph',
      'list',
    ]);
  });

  it('reads a pipe table with alignment and evens out ragged rows', () => {
    expect(
      parseMarkdown(
        '| Tool | Price |\n|:--|--:|\n| Neon | **$19** |\n| RDS |\n\nAfter',
      ),
    ).toEqual([
      {
        type: 'table',
        align: ['left', 'right'],
        head: [[text('Tool')], [text('Price')]],
        rows: [
          [[text('Neon')], [{ type: 'strong', children: [text('$19')] }]],
          [[text('RDS')], []],
        ],
      },
      paragraph(text('After')),
    ]);
  });

  it('reads a horizontal rule', () => {
    expect(parseMarkdown('a\n\n---\n\nb')[1]).toEqual({ type: 'rule' });
  });
});

describe('parseMarkdown inline', () => {
  const inline = (source: string) => {
    const [block] = parseMarkdown(source);
    return block && 'children' in block ? block.children : block;
  };

  it('reads bold, italic, code and links', () => {
    expect(inline('**a** *b* `c` [d](https://d.test/x)')).toEqual([
      { type: 'strong', children: [text('a')] },
      text(' '),
      { type: 'em', children: [text('b')] },
      text(' '),
      { type: 'code', text: 'c' },
      text(' '),
      { type: 'link', href: 'https://d.test/x', children: [text('d')] },
    ]);
  });

  it('nests italic inside bold and bold inside italic', () => {
    expect(inline('**a *b* c** *d **e** f*')).toEqual([
      {
        type: 'strong',
        children: [
          text('a '),
          { type: 'em', children: [text('b')] },
          text(' c'),
        ],
      },
      text(' '),
      {
        type: 'em',
        children: [
          text('d '),
          { type: 'strong', children: [text('e')] },
          text(' f'),
        ],
      },
    ]);
  });

  it('leaves code spans unparsed', () => {
    expect(inline('`**not bold**`')).toEqual([
      { type: 'code', text: '**not bold**' },
    ]);
  });

  it('honours backslash escapes', () => {
    expect(inline('\\*not italic\\*')).toEqual([text('*not italic*')]);
  });

  it('does not read arithmetic or a lone asterisk as emphasis', () => {
    expect(inline('5 * 3 * 2 and a*')).toEqual([text('5 * 3 * 2 and a*')]);
  });
});

// The answer is re-read on every streamed batch, so each prefix must render sensibly.
describe('parseMarkdown mid-stream', () => {
  it.each([
    ['an unclosed bold', 'Price: **$1', [paragraph(text('Price: **$1'))]],
    ['an unclosed italic', 'see *note', [paragraph(text('see *note'))]],
    ['an unclosed code span', 'run `npm', [paragraph(text('run `npm'))]],
    [
      'a half-written link',
      'see [Neon](https://ne',
      [paragraph(text('see [Neon](https://ne'))],
    ],
    [
      'bold opened inside italic',
      '*a **b*',
      [paragraph({ type: 'em', children: [text('a **b')] })],
    ],
    [
      'an unclosed code fence',
      '```\nline one\nline',
      [{ type: 'code', text: 'line one\nline' }],
    ],
  ])('shows %s as typed so far', (_, source, expected) => {
    expect(parseMarkdown(source)).toEqual(expected);
  });

  it('shows a table header without its divider as text until the divider arrives', () => {
    expect(parseMarkdown('| A | B |')[0]?.type).toBe('paragraph');
    expect(parseMarkdown('| A | B |\n|--')[0]?.type).toBe('table');
  });

  it('reads a bare next list number as an empty item, not a new paragraph', () => {
    expect(parseMarkdown('1. a\n2.')).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 1,
        items: [[paragraph(text('a'))], []],
      },
    ]);
  });
});

// Model output and web content are untrusted: they must stay text.
describe('untrusted content', () => {
  it('keeps HTML as literal text', () => {
    expect(parseMarkdown('<img src=x onerror=alert(1)> <b>hi</b>')).toEqual([
      paragraph(text('<img src=x onerror=alert(1)> <b>hi</b>')),
    ]);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    '/relative/path',
    '//evil.test/x',
  ])('drops the target of a [link](%s) but keeps its words', (href) => {
    const blocks = parseMarkdown(`[click](${href}) now`);

    expect(JSON.stringify(blocks)).not.toContain('"link"');
    expect(blocks[0]).toMatchObject({ children: [{ type: 'text' }] });
    expect(JSON.stringify(blocks)).toContain('click');
  });
});

describe('safeUrl', () => {
  it.each([
    ['https://neon.com/pricing', 'https://neon.com/pricing'],
    ['http://example.test', 'http://example.test/'],
  ])('accepts %s', (raw, expected) => {
    expect(safeUrl(raw)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'mailto:a@b.test',
    'not a url',
    '',
  ])('rejects %j', (raw) => {
    expect(safeUrl(raw)).toBeNull();
  });
});

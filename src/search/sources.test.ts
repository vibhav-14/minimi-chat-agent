import { describe, expect, it } from 'vitest';
import { normalizeUrl, SourceRegistry } from './sources.js';

describe('normalizeUrl', () => {
  // Each pair is the same page reached by two links; one source must cover both.
  it.each([
    ['https://a.test/pricing#plans', 'https://a.test/pricing'],
    ['https://a.test/pricing/', 'https://a.test/pricing'],
    ['https://A.Test/pricing', 'https://a.test/pricing'],
    [
      'https://a.test/pricing?utm_source=x&utm_medium=y',
      'https://a.test/pricing',
    ],
    ['https://a.test/pricing?gclid=abc', 'https://a.test/pricing'],
    ['https://a.test/', 'https://a.test'],
    ['https://a.test/p?plan=pro&utm_campaign=z', 'https://a.test/p/?plan=pro'],
  ])('treats %s as the same page as %s', (a, b) => {
    expect(normalizeUrl(a)).toBe(normalizeUrl(b));
  });

  // Over-eager normalization would merge two different pages under one number.
  it.each([
    ['https://a.test/pricing?plan=pro', 'https://a.test/pricing?plan=team'],
    ['https://a.test/Pricing', 'https://a.test/pricing'],
    ['https://a.test/pricing', 'http://b.test/pricing'],
  ])('keeps %s and %s apart', (a, b) => {
    expect(normalizeUrl(a)).not.toBe(normalizeUrl(b));
  });

  it('returns a string that is not a URL unchanged', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('SourceRegistry', () => {
  it('numbers new pages from 1 in the order they are seen', () => {
    const registry = new SourceRegistry();

    registry.add({ url: 'https://a.test/1', title: 'One' });
    registry.add({
      url: 'https://a.test/2',
      title: 'Two',
      publishedDate: '2026-11-10',
    });

    expect(registry.list()).toEqual([
      { n: 1, url: 'https://a.test/1', title: 'One' },
      {
        n: 2,
        url: 'https://a.test/2',
        title: 'Two',
        publishedDate: '2026-11-10',
      },
    ]);
  });

  it('gives a page seen again under another link the number it already has', () => {
    const registry = new SourceRegistry();
    registry.add({ url: 'https://a.test/1', title: 'One' });
    registry.add({ url: 'https://a.test/2', title: 'Two' });

    const again = registry.add({
      url: 'https://a.test/1/#top',
      title: 'One, again',
    });

    expect(again).toEqual({
      source: { n: 1, url: 'https://a.test/1', title: 'One' },
      isNew: false,
    });
    expect(registry.list()).toHaveLength(2);
  });
});

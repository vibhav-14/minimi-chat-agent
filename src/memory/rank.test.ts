import { describe, expect, it } from 'vitest';
import { bm25, stem, terms } from './rank.js';

describe('stem', () => {
  // A miss here means a search for one form of a word misses the other.
  it.each([
    ['prices', 'pric'],
    ['pricing', 'pric'],
    ['priced', 'pric'],
    ['price', 'pric'],
    ['companies', 'company'],
    ['company', 'company'],
    ['hosts', 'host'],
    ['hosting', 'host'],
    ['classes', 'class'],
    ['class', 'class'],
  ])('%s -> %s', (word, expected) => {
    expect(stem(word)).toBe(expected);
  });

  // Stripping these would make short unrelated words collide.
  it.each(['is', 'sing', 'red', 'use', 'bus', '100'])(
    'keeps short word %s whole',
    (word) => {
      expect(stem(word)).toBe(word);
    },
  );
});

describe('terms', () => {
  it('splits on anything but letters and digits, lowercases and stems', () => {
    expect(terms('Pricing: "HubSpot" vs. Zoho-CRM, 2026! Café')).toEqual([
      'pric',
      'hubspot',
      'vs',
      'zoho',
      'crm',
      '2026',
      'café',
    ]);
  });
});

describe('bm25', () => {
  const score = (query: string, ...documents: string[]) =>
    bm25(terms(query), documents.map(terms));

  it('scores a document sharing no term with the query as 0', () => {
    const [unrelated, related] = score('postgres', 'sunny weather', 'postgres');
    expect(unrelated).toBe(0);
    expect(related).toBeGreaterThan(0);
  });

  it('ranks a match on a rare term above a match on a common one', () => {
    const [common, rare] = score(
      'crm pricing',
      'crm notes',
      'pricing table',
      'crm list',
      'crm ideas',
    );
    expect(rare).toBeGreaterThan(common ?? 0);
  });

  it('ranks the shorter of two documents with the same matches first', () => {
    const [short, long] = score(
      'postgres',
      'postgres hosting',
      'postgres hosting with many other words around it',
    );
    expect(short).toBeGreaterThan(long ?? 0);
  });

  it('lets a repeated term add to the score, with diminishing returns', () => {
    const [once, twice] = score('neon', 'neon db', 'neon neon');
    expect(twice).toBeGreaterThan(once ?? 0);
    expect(twice).toBeLessThan(2 * (once ?? 0));
  });

  it('counts a word repeated in the query once', () => {
    expect(score('neon neon', 'neon db', 'other')).toEqual(
      score('neon', 'neon db', 'other'),
    );
  });

  it('returns no scores for no documents', () => {
    expect(score('neon')).toEqual([]);
  });
});

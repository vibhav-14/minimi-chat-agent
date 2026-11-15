// The rules that keep a "has anything changed since <date>?" answer honest.
// Without them the model found Pipedrive at $14 against Monday's $9 and still
// answered "No, none of them have changed pricing", then cited its memory as
// [recalled history]. These checks stop a later edit dropping a rule quietly.
// Each rule is matched by its key phrases, so rewording a rule keeps its test.
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from './prompt.js';

describe('SYSTEM_PROMPT for re-checking an earlier answer', () => {
  it.each([
    [
      'then and now for every item, with a verdict',
      [
        'For every item',
        'then and now',
        'changed, unchanged, or could not verify',
      ],
    ],
    [
      'like with like, never "unchanged" across plans or bases',
      ['Compare like with like', 'billing basis', 'do not call it unchanged'],
    ],
    [
      'a headline that agrees with the rows',
      ['headline must agree with the rows', 'lead with what changed'],
    ],
    [
      'recalled history referred to in words, never cited in brackets',
      ['Never cite it in brackets', '[recalled history]'],
    ],
    [
      'one search call with since and a current-state query per item',
      [
        'Search in one call',
        'since set to that date',
        'current-state query per item',
      ],
    ],
    // Sample 1 also asks "or shipped something big?", and pricing queries
    // fill all five slots of the first call, so news needs a call of its own.
    [
      'a second call with topic news and the same since for launches',
      ['second web_search call', 'same step', 'topic "news"', 'the same since'],
    ],
  ])('keeps the rule: %s', (_, phrases) => {
    for (const phrase of phrases) expect(SYSTEM_PROMPT).toContain(phrase);
  });

  // "Search once" contradicted the rule that allows a retry after a failed search.
  it('does not forbid searching again', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/search once/i);
    expect(SYSTEM_PROMPT).toContain('you may search again');
  });

  it('does not invite the model to discount or mention demo history', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/demo/i);
  });
});

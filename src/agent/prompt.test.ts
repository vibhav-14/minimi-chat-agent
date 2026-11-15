// The rules that keep a "has anything changed since <date>?" answer honest.
// Without them the model found Pipedrive at $14 against Monday's $9 and still
// answered "No, none of them have changed pricing", then cited its memory as
// [recalled history]. These checks stop a later edit dropping a rule quietly.
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from './prompt.js';

describe('SYSTEM_PROMPT for re-checking an earlier answer', () => {
  it.each([
    [
      'then and now for every item, with a verdict',
      'For every item in the earlier answer, state then and now: the earlier value and its date, the current value with its [n] citation, and a verdict: changed, unchanged, or could not verify.',
    ],
    [
      'like with like, never "unchanged" across plans or bases',
      'Compare like with like: the same plan or tier and the same billing basis',
    ],
    [
      'a headline that agrees with the rows',
      'The headline must agree with the rows. If any item changed, lead with what changed. Never say "no changes" or "unchanged" when any row differs.',
    ],
    [
      'recalled history referred to in words, never cited in brackets',
      "Never cite it in brackets, as a number or a label such as [recalled history]; brackets are only for this turn's search results.",
    ],
    [
      'one search call with since and a current-state query per item',
      'one web_search call with since set to that date (YYYY-MM-DD) and one current-state query per item',
    ],
  ])('keeps the rule: %s', (_, rule) => {
    expect(SYSTEM_PROMPT).toContain(rule);
  });

  it('does not invite the model to discount or mention demo history', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/demo/i);
  });
});

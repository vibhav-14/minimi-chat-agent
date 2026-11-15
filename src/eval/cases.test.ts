import { describe, expect, it } from 'vitest';
import { EVAL_CASES } from './cases.js';
import { check, summarize } from './checks.js';

const ANSWER_CHECKS = ['says', 'does not say'];

/** Whether a case's checks on the answer text all pass for this answer. */
function says(caseId: string, answer: string): boolean {
  const testCase = EVAL_CASES.find((c) => c.id === caseId);
  if (!testCase) throw new Error(`no case ${caseId}`);
  const turn = summarize(
    [{ event: { type: 'token', text: answer }, at: 0 }],
    0,
  );
  return check(turn, testCase.expect)
    .filter((r) => ANSWER_CHECKS.includes(r.name))
    .every((r) => r.pass);
}

describe('eval cases', () => {
  it('have unique ids', () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('crm-monday must call the stale Pipedrive price a change', () => {
    it('fails a live answer that called everything unchanged (2026-11-15)', () => {
      const answer = `The pricing and core feature sets for the shortlisted tools remain **unchanged** since Monday [1]:

* **HubSpot Sales Hub Professional:** Unchanged at **$90/seat/month** (billed annually) [1].
* **Pipedrive:** Standard plans remain structured starting from **$14 to $24+/user/month** (billed annually) depending on the tier (Lite/Growth) [5], [6].`;

      expect(says('crm-monday', answer)).toBe(false);
    });

    it('fails a Pipedrive row marked unchanged', () => {
      expect(says('crm-monday', '* **Pipedrive:** Unchanged at $9 [5]')).toBe(
        false,
      );
    });

    // The prompt's then-and-now rows carry an arrow or "was" whatever the
    // verdict, and both satisfy the positive pattern on their own.
    it.each([
      '* Pipedrive Growth: $9→$14 [3], unchanged',
      '* Pipedrive Growth: was $9, now $14 [3], unchanged',
    ])(
      'fails a then-and-now Pipedrive row that still says unchanged: %s',
      (row) => {
        expect(says('crm-monday', row)).toBe(false);
      },
    );

    it('passes an answer that reports the change', () => {
      expect(
        says(
          'crm-monday',
          '* **Pipedrive Growth:** changed, $9 → $39 per seat [5]',
        ),
      ).toBe(true);
      expect(
        says('crm-monday', '| Pipedrive Growth | $9 | $39 | increased [5] |'),
      ).toBe(true);
    });

    // A correct live headline failed: "unchanged" there belongs to the
    // products named after Pipedrive, not to Pipedrive.
    it('passes a headline where "unchanged" is about the other products', () => {
      expect(
        says(
          'crm-monday',
          'Pipedrive Growth pricing is listed significantly higher than the $9 rate noted on Monday, while HubSpot, Salesforce, and Zoho CRM pricing remain unchanged.',
        ),
      ).toBe(true);
    });

    it('accepts a spaced arrow as the change', () => {
      expect(
        says(
          'crm-monday',
          '* **Pipedrive Growth:** $9 on Monday → $39 now [5]',
        ),
      ).toBe(true);
    });
  });

  it('no-record accepts an honest "nothing that day" answer', () => {
    expect(
      says(
        'no-record',
        "You didn't ask anything on 1 October 2026; nothing is stored for that date.",
      ),
    ).toBe(true);
  });
});

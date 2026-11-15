// The live eval set: the brief's three sample questions, then three that probe
// the edges around them. Each runs against a fresh memory holding only the
// seeded demo history, so cases cannot leak into one another.
import type { Expectation } from './checks.js';

export interface EvalCase {
  id: string;
  message: string;
  /** Why the case exists: what a wrong answer here would mean. */
  why: string;
  expect: Expectation;
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'crm-monday',
    message:
      'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    why: 'Sample 1: a weekday resolved in code, then old prices checked against fresh pages.',
    expect: {
      recalls: true,
      searches: true,
      cites: true,
      mentions: {
        names: ['HubSpot', 'Salesforce', 'Pipedrive', 'Zoho', 'Freshsales'],
        min: 4,
      },
      // The demo's Pipedrive price ($9) is deliberately below anything
      // Pipedrive lists, so a correct answer must call it a change. Saying
      // "unchanged" while citing a higher price is the failure this catches.
      matches:
        // Arrows sit outside \b: with spaces around them there is no word
        // boundary, so "$9 → $39" would never match inside the group.
        /Pipedrive[^\n]*(\b(chang|increas|rais|up from|went up|higher|from \$9|was \$9)|→|->)/i,
      // The then-and-now rows the prompt asks for carry an arrow either way,
      // so "$9 then → $14 now, unchanged" would pass `matches` alone.
      rejects: /Pipedrive[^\n]*\bunchanged\b/i,
    },
  },
  {
    id: 'november-3',
    message:
      'What did I ask you on 3 November? Is your answer still correct today?',
    why: 'Sample 2: an absolute date, the old question quoted back, then re-verified.',
    expect: {
      recalls: true,
      searches: true,
      cites: true,
      mentions: { names: ['Node'], min: 1 },
    },
  },
  {
    id: 'postgres-tuesday',
    message:
      'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    why: 'Sample 3: "last Tuesday" plus a topic, then prices compared provider by provider.',
    expect: {
      recalls: true,
      searches: true,
      cites: true,
      mentions: { names: ['Neon', 'Supabase', 'RDS'], min: 2 },
    },
  },
  {
    id: 'no-record',
    message: 'What did I ask you on 1 October?',
    why: 'Nothing is stored that day: the agent must say so, not invent a conversation.',
    expect: {
      missesDate: true,
      matches:
        /\b(no record|don't have|do not have|didn't|did not|couldn't find|could not find|nothing|no conversation|not find)\b/i,
    },
  },
  {
    id: 'fresh-fact',
    message: 'What is the current Node.js LTS version?',
    why: 'The fact changes, so a recalled answer is not enough: it must search and cite.',
    expect: { searches: true, cites: true },
  },
  {
    id: 'no-search',
    message: 'Make this sound friendlier: "Send me the report by 5."',
    why: 'Nothing to look up: searching here only adds seconds.',
    expect: { recalls: false, searches: false },
  },
];

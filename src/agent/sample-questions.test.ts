// The brief's sample questions, against the seeded demo history: each must
// reach the model with the right earlier exchange in its prompt.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock.js';
import { seedDemoHistory } from '../memory/seed.js';
import { MemoryStore } from '../memory/store.js';
import { runTurn } from './loop.js';
import {
  collectEvents,
  promptText,
  scriptedLlm,
  stop,
  tableSearch,
  text,
} from './testing.js';

// Wednesday 11 November 2026, 17:30 in Kolkata.
const NOW = new Date('2026-11-11T12:00:00Z');
const ZONE = 'Asia/Kolkata';
const clock = fixedClock(NOW);

let store: MemoryStore;

beforeEach(() => {
  store = MemoryStore.open(':memory:', clock);
  seedDemoHistory(store, clock, ZONE);
});

afterEach(() => {
  store.close();
});

async function promptFor(message: string): Promise<string> {
  const { llm, requests } = scriptedLlm([[text('Answer.'), stop]]);
  await collectEvents(
    runTurn(
      { llm, search: tableSearch().search, store, clock },
      { message, timeZone: ZONE },
    ),
  );
  return promptText(requests[0]);
}

describe('sample questions reach the model with the right history', () => {
  it('"On Monday we shortlisted 5 CRM tools..." recalls Monday\'s shortlist with prices and evidence', async () => {
    const prompt = await promptFor(
      'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    );

    expect(prompt).toContain('Stored for "Monday" (Monday 9 November 2026):');
    expect(prompt).toContain('5. Freshsales Growth: $9 [5]');
    expect(prompt).toContain(
      '- [3] Pipedrive pricing: https://www.pipedrive.com/en/pricing\n  Page then said: "Growth: $9 per seat',
    );
  });

  it('"What did I ask you on 3 November?" recalls the 3 November exchange', async () => {
    const prompt = await promptFor(
      'What did I ask you on 3 November? Is your answer still correct today?',
    );

    expect(prompt).toContain(
      'Stored for "3 November" (Tuesday 3 November 2026):',
    );
    expect(prompt).toContain(
      'User: (Demo) Which Node.js version should a new project use today?',
    );
  });

  it('"Last Tuesday I asked you about Postgres hosting..." recalls the Postgres answer', async () => {
    const prompt = await promptFor(
      'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    );

    expect(prompt).toContain(
      'Stored for "Last Tuesday" (Tuesday 10 November 2026):',
    );
    expect(prompt).toContain('2. Supabase Pro: $25 a month per project');
    expect(prompt).toContain('Current date and time: Wednesday');
  });
});

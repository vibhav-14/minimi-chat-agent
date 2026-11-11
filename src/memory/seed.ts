import type { Clock } from '../clock.js';
import type { Source } from '../search/sources.js';
import type { MemoryStore } from './store.js';
import { calendarDayAt, resolveTimeReferences } from './temporal.js';

const HOUR_MS = 60 * 60 * 1000;
const ANSWER_DELAY_MS = 40 * 1000;

// Shown to the model in recalled history and to a person reading the answer.
const DEMO_NOTE =
  '(Seeded demo history: inserted on first start so the sample questions have something to recall. Prices are illustrative, not checked.)';
const DEMO_QUESTION = '(Demo) ';
const DEMO_TITLE = 'Demo: ';

interface DemoExchange {
  title: string;
  question: string;
  answer: string;
  sources: Source[];
}

const CRM: DemoExchange = {
  title: 'CRM shortlist for a 20-person sales team',
  question:
    'We need a CRM for our 20-person sales team. Shortlist 5 tools with the price per seat.',
  // Pipedrive's $9 is deliberately stale: below any price Pipedrive has listed
  // for the Growth plan in recent years, so "has any of them changed pricing?"
  // always finds at least one change to report.
  answer: `${DEMO_NOTE}

Five CRMs that suit a 20-person sales team, price per seat per month, billed annually:

1. HubSpot Sales Hub Professional: $90 [1]
2. Salesforce Sales Cloud Enterprise: $165 [2]
3. Pipedrive Growth: $9 [3]
4. Zoho CRM Professional: $23 [4]
5. Freshsales Growth: $9 [5]

For 20 seats that runs from about $2,200 a year (Pipedrive or Freshsales) to about $39,600 (Salesforce).`,
  sources: [
    {
      n: 1,
      url: 'https://www.hubspot.com/pricing/sales',
      title: 'HubSpot Sales Hub pricing',
      snippet:
        'Sales Hub Professional: $90 per seat per month, billed annually. Includes forecasting, sequences and playbooks. One-time onboarding fee applies.',
    },
    {
      n: 2,
      url: 'https://www.salesforce.com/sales/pricing/',
      title: 'Salesforce Sales Cloud pricing',
      snippet:
        'Enterprise: $165 per user per month, billed annually. Deeply customizable sales CRM for your business.',
    },
    {
      n: 3,
      url: 'https://www.pipedrive.com/en/pricing',
      title: 'Pipedrive pricing',
      snippet:
        'Growth: $9 per seat per month, billed annually. Email sync, automations and scheduling.',
    },
    {
      n: 4,
      url: 'https://www.zoho.com/crm/zohocrm-pricing.html',
      title: 'Zoho CRM pricing',
      snippet:
        'Professional: $23 per user per month, billed annually. Blueprints, inventory management and validation rules.',
    },
    {
      n: 5,
      url: 'https://www.freshworks.com/crm/pricing/',
      title: 'Freshsales pricing',
      snippet:
        'Growth: $9 per user per month, billed annually. AI-powered contact scoring and sales sequences.',
    },
  ],
};

const POSTGRES: DemoExchange = {
  title: 'Postgres hosting options',
  question:
    'What are good managed Postgres hosting options for a small SaaS app, and what do they cost?',
  answer: `${DEMO_NOTE}

Three good fits for a small SaaS app:

1. Neon Launch: $19 a month, serverless with branching and scale to zero [1]
2. Supabase Pro: $25 a month per project, Postgres plus auth and storage [2]
3. Amazon RDS for PostgreSQL: pay as you go; a db.t4g.micro instance is about $12 a month plus storage [3]

Neon or Supabase are the quickest start; RDS gives the most control.`,
  sources: [
    {
      n: 1,
      url: 'https://neon.com/pricing',
      title: 'Neon pricing',
      snippet:
        'Launch: $19 per month. 10 GB storage included, autoscaling up to 4 CU, branching and point-in-time restore.',
    },
    {
      n: 2,
      url: 'https://supabase.com/pricing',
      title: 'Supabase pricing',
      snippet:
        'Pro: from $25 per month per project. 8 GB database, 100,000 monthly active users, daily backups.',
    },
    {
      n: 3,
      url: 'https://aws.amazon.com/rds/postgresql/pricing/',
      title: 'Amazon RDS for PostgreSQL pricing',
      snippet:
        'On-Demand instances: db.t4g.micro $0.016 per hour. Storage billed per GB-month.',
    },
  ],
};

const NODE: DemoExchange = {
  title: 'Current Node.js LTS',
  question: 'Which Node.js version should a new project use today?',
  answer: `${DEMO_NOTE}

Use the current Active LTS line, Node.js 24 ("Krypton"), which gets fixes and security updates until April 2028 [1]. Odd-numbered releases never become LTS, so skip them for production.`,
  sources: [
    {
      n: 1,
      url: 'https://nodejs.org/en/about/previous-releases',
      title: 'Node.js releases',
      snippet:
        'Production applications should only use Active LTS or Maintenance LTS releases. v24 Krypton: Active LTS, end of life April 2028.',
    },
  ],
};

/**
 * On a store with no conversations, inserts three demo exchanges dated so
 * the sample questions find them on any day: the Monday before today, the
 * Tuesday that "last Tuesday" resolves to first, and the most recent
 * 3 November before today. Returns whether it seeded.
 */
export function seedDemoHistory(
  store: MemoryStore,
  clock: Clock,
  timeZone: string,
): boolean {
  if (store.listConversations().length > 0) return false;
  const now = clock.now();
  const { monday, tuesday, november3 } = demoDays(now, timeZone);

  // Different hours, so the exchanges keep their order if two dates are the same day.
  insert(store, CRM, new Date(monday.getTime() + 10 * HOUR_MS), timeZone);
  insert(store, NODE, new Date(november3.getTime() + 12 * HOUR_MS), timeZone);
  insert(store, POSTGRES, new Date(tuesday.getTime() + 15 * HOUR_MS), timeZone);
  return true;
}

/** The start of each demo day in `timeZone`, every one strictly before today. */
export function demoDays(now: Date, timeZone: string) {
  const firstDay = (phrase: string) => {
    const range = resolveTimeReferences(phrase, now, timeZone)[0]
      ?.candidates[0];
    if (!range) throw new Error(`Cannot resolve "${phrase}"`);
    return range;
  };
  // "Last Monday" is the most recent Monday before today, never today.
  // "Last Tuesday" may also offer the Tuesday a week earlier; the first
  // candidate is always offered, so recall finds the seed either way.
  const monday = firstDay('last Monday').from;
  const tuesday = firstDay('last Tuesday').from;
  let november = firstDay('3 November');
  // On 3 November itself, the most recent one that has passed is last year's.
  if (november.to > now) {
    november = firstDay(`3 November ${calendarDayAt(now, timeZone).year - 1}`);
  }
  return { monday, tuesday, november3: november.from };
}

function insert(
  store: MemoryStore,
  exchange: DemoExchange,
  askedAt: Date,
  timeZone: string,
): void {
  const { id } = store.createConversation(DEMO_TITLE + exchange.title, askedAt);
  store.appendMessage({
    conversationId: id,
    role: 'user',
    content: DEMO_QUESTION + exchange.question,
    timeZone,
    createdAt: askedAt,
  });
  store.appendMessage({
    conversationId: id,
    role: 'assistant',
    content: exchange.answer,
    timeZone,
    sources: exchange.sources,
    createdAt: new Date(askedAt.getTime() + ANSWER_DELAY_MS),
  });
}

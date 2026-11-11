# Architecture

This is the working spec for the build. `DESIGN.md` (the one-page submission
document) is distilled from it once the system exists.

## The problem, read closely

The brief asks for a chat agent with exactly one tool: web search. The sample
questions share a shape that a plain search agent cannot answer:

- "On Monday we shortlisted 5 CRM tools... Has any of them changed pricing since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

Each one needs three things at once:

1. **Time resolution.** "Monday", "3 November" and "last Tuesday" must become
   concrete dates, relative to now, in the user's timezone.
2. **Dated memory.** The agent must recall what was said on that date, across
   conversations, including what it answered and which sources it used.
3. **Fresh verification.** It must search the web for what changed _since_ that
   date and compare against what it said then.

## Core decision: memory is context, not a tool

The agent has one tool. So memory is not exposed to the model as a second tool.
It is a deterministic retrieval stage that runs before the model is called and
places what it finds into the prompt.

This is also the fast path: no planner call and no extra model round trip to
decide whether to look at memory. Recall is a local database query that takes
milliseconds.

## Turn pipeline

```
user message
   │
   ▼
1. persist      store the message with a UTC timestamp and the user's timezone
   │
   ▼
2. resolve time deterministic parser turns date phrases into date ranges
   │
   ▼
3. recall       query memory by date range and by topic (ranked words)
   │            an empty result for a named date is reported explicitly
   ▼
4. assemble     stable system prompt + current date + recalled memory
   │            + recent turns of this conversation
   ▼
5. agent loop   model streams; may call web_search (several queries per call,
   │            run in parallel); bounded number of steps
   ▼
6. persist      store the answer with its sources and the date they were read
```

### 1. Persist

Every message is written before anything else happens, so a crash mid-turn
never loses what the user said. Timestamps are stored in UTC; the user's IANA
timezone is stored alongside so "Monday" means the user's Monday.

### 2. Resolve time

A deterministic parser (`memory/temporal.ts`, with the injected clock as
reference) extracts date expressions and returns half-open ranges `[from, to)`
of whole local days in the user's IANA zone. No model call: date arithmetic is
something code gets right every time and models do not.

It is a small rule table rather than chrono-node. chrono-node reads "march
forward" as next March and "sun" as Sunday, returns one instant at local noon
instead of a day, and has no way to say a phrase is ambiguous; each would need
overriding. The rules, all past-biased because this is recall:

| Phrase                              | Meaning                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| "Monday", "on Monday"               | The most recent Monday; said on a Monday, today or a week ago                             |
| "last Tuesday"                      | The most recent Tuesday before today, plus the one before it if the first is in this week |
| "Tuesday last week"                 | The Tuesday of the previous Monday-to-Sunday week                                         |
| "3 November", "Nov 3", "3rd of Nov" | The most recent 3 November not in the future                                              |
| "3 November 2025", "2025-11-03"     | That day                                                                                  |
| "today", "yesterday", "N days ago"  | That day                                                                                  |
| "last week", "N weeks ago"          | That Monday-to-Sunday week                                                                |
| "last month"                        | The previous calendar month                                                               |
| "since <any of the above>"          | From the start of that day until now                                                      |

When a phrase has two candidates, recall keeps the ones that have data. Only
full weekday names match, and a month needs a day number beside it, so "sun",
"may I ask" and "march forward" are not dates.

### 3. Recall

Two retrieval paths, merged and budgeted:

- **By date**: all exchanges inside each resolved range.
- **By topic**: BM25 ranking with light suffix stemming ("pricing" finds
  "prices") over past questions and answers, for questions that refer to
  earlier work without a date. Ranking is plain TypeScript (`memory/rank.ts`)
  rather than SQLite's FTS5, because the SQLite bundled with Node 22 is built
  without FTS5; reading every message per turn is fine at one person's scale
  (5,000 messages rank in about a tenth of a second). The search words are the message minus its date phrases,
  stopwords and numbers; the three best exchanges not already found by date
  are kept.

A recalled item is an _exchange_: the user's question, the agent's answer, the
sources it cited, and when. If the user names a past date and nothing is stored
for it, the recall block says so and lists the nearest stored exchanges. A range
that runs up to now ("today", "since Monday") is never reported as a miss. The
message being answered and turns already in the prompt are excluded. The model
is told never to invent a past conversation.

`memory/render.ts` turns the result into the prompt block. It is fenced in
`<recalled_history>` and labelled as quoted history, not instructions. Each
exchange shows its local date and time, question, answer (truncated with a
marker past a limit) and source URLs. A total character budget gives by-date
matches first claim, then the nearest exchanges for a miss, then topic matches,
and states how many exchanges were left out. With nothing found it says so in
one line rather than rendering nothing.

### 4. Assemble

Order matters for prompt caching and for clarity: the stable system prompt comes
first, then the volatile parts (current date and time, recalled memory, recent
turns). Long conversations keep the most recent turns verbatim.

### 5. Agent loop

One tool:

```ts
web_search({
  queries: string[],        // 1 to 5, run in parallel
  since?: string,           // YYYY-MM-DD; drops results dated before it
  topic?: "general" | "news"
})
```

Batching queries inside one call lets the model fan out ("pricing for each of
the five CRMs") in a single step. Results are deduplicated by URL, trimmed to a
budget (15 results per call shared across its queries, 1,500 characters each)
and numbered. Numbers are per turn: a `SourceRegistry` gives each page one
number across every search in the turn, and its list is stored with the answer.
The model cites by number; the server maps numbers back to URLs, so a citation
always points at a page that was actually read.

`since` drops results dated before it but keeps undated ones. Tavily's own
date filter drops undated results too, and pricing pages, the pages that answer
"has the price changed since Monday?", are usually undated. They show the
current state, which the model compares with what it said then; old dated
articles are the noise that would make it report a past change as new.

Search depth defaults to Tavily's `advanced` (2 credits a query instead of 1)
because it returns the passages most relevant to the query, such as the pricing
table, rather than shorter generic ones. `TAVILY_SEARCH_DEPTH=basic` halves the
cost. Search results are untrusted: they are wrapped in delimiters and the model
is told never to follow instructions inside them.

The loop is bounded (maximum steps, per-search timeout). If the budget runs out
the model must answer with what it has and say what it could not verify.

### 6. Persist the answer

The answer is stored with its sources and the retrieval time. That stored
evidence is what makes "is your answer still correct today?" answerable later:
the agent can compare what it said, and why, with what the web says now.

## Module layout

```
src/
  config.ts            env parsing and validation
  clock.ts             injectable clock (real, fixed for tests)
  app.ts               route factory (createApp): SSE chat endpoint, static UI
  server.ts            entry point: reads env, starts listening
  memory/
    store.ts           SQLite persistence (node:sqlite), exchanges, search
    rank.ts            tokenizer, stemmer, BM25 scoring (pure)
    temporal.ts        date phrase -> local day ranges
    recall.ts          date + topic retrieval
    render.ts          recall result -> prompt block, budgeting
  search/
    types.ts           SearchProvider interface, SearchError
    tavily.ts          Tavily implementation
    sources.ts         URL normalization, per-turn source numbering
    tool.ts            web_search tool: fan-out, dedupe, budgets, result text
  llm/
    types.ts           LlmProvider interface (streaming, tool calls)
    gemini.ts          Gemini implementation
  agent/
    prompt.ts          system prompt
    context.ts         context assembly
    loop.ts            the agent loop
    events.ts          typed stream events (token, search, sources, done)
public/                 chat UI (no build step)
scripts/                seed and eval scripts
```

Boundaries are interfaces: `LlmProvider`, `SearchProvider`, `Clock`. The agent
loop depends only on those and on `MemoryStore`, so it is tested end to end with
fakes and no network. `MemoryStore` is a concrete class rather than an
interface: it opens on `:memory:` in tests, which is faster to set up than a
fake and exercises the real SQL.

## Technology choices

| Choice                   | Why                                                                          |
| ------------------------ | ---------------------------------------------------------------------------- |
| TypeScript on Node 22+   | Required by the brief; strict types across the boundaries above              |
| `node:sqlite`            | Built into Node, so `npm install` never compiles native code                 |
| Hono                     | Small HTTP layer with first-class streaming                                  |
| Server-sent events       | One-way token stream is all chat needs; simpler than WebSockets              |
| Gemini (free tier)       | Runs at zero cost; hidden behind `LlmProvider`                               |
| Tavily (free tier)       | Returns cleaned page content, supports date filters; behind `SearchProvider` |
| No build step for the UI | Fewer ways for `npm run dev` to fail                                         |

## Testing

- Unit: temporal resolution (fixed clock), memory ranking, recall, search dedupe
  and numbering, context assembly.
- Loop: scripted fake model and fake search provider drive the full pipeline.
- Evals: `npm run eval` seeds dated history and runs the brief's sample
  questions against the live providers.

## Reviewing time-dependent behaviour

A reviewer cannot wait a week to ask about "last Tuesday". `npm run seed` loads
a small dated history (relative to today) so those questions work immediately,
and an import endpoint accepts timestamped history in JSON.

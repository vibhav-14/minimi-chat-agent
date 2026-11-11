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
3. **Fresh verification.** It must search the web for what changed *since* that
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
3. recall       query memory by date range and by topic (full-text)
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

A deterministic parser (chrono-node, with the injected clock as reference)
extracts date expressions and returns closed date ranges. Past-biased: "Monday"
means the most recent Monday that has already happened. No model call: date
arithmetic is something code gets right every time and models do not.

### 3. Recall

Two retrieval paths, merged and budgeted:

- **By date**: all exchanges inside each resolved range.
- **By topic**: full-text search over past messages, for questions that refer to
  earlier work without a date.

A recalled item is an *exchange*: the user's question, the agent's answer, the
sources it cited, and when. If the user names a date and nothing is stored for
it, the recall block says so and lists the nearest dated exchanges. The model is
told never to invent a past conversation.

### 4. Assemble

Order matters for prompt caching and for clarity: the stable system prompt comes
first, then the volatile parts (current date and time, recalled memory, recent
turns). Long conversations keep the most recent turns verbatim.

### 5. Agent loop

One tool:

```ts
web_search({
  queries: string[],        // 1 to 5, run in parallel
  since?: string,           // ISO date; restricts results to on or after it
  topic?: "general" | "news"
})
```

Batching queries inside one call lets the model fan out ("pricing for each of
the five CRMs") in a single step. Results are deduplicated by URL, trimmed to a
token budget and numbered. The model cites by number; the server maps numbers
back to URLs, so a citation always points at a page that was actually read.

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
  server.ts            HTTP server, SSE chat endpoint, static UI
  memory/
    store.ts           SQLite persistence (node:sqlite)
    temporal.ts        date phrase -> date range
    recall.ts          date + topic retrieval, budgeting
  search/
    types.ts           SearchProvider interface
    tavily.ts          Tavily implementation
    tool.ts            web_search tool: fan-out, dedupe, numbering
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

Boundaries are interfaces: `LlmProvider`, `SearchProvider`, `Clock`,
`MemoryStore`. The agent loop depends only on those, so it is tested end to end
with fakes and no network.

## Technology choices

| Choice | Why |
| --- | --- |
| TypeScript on Node 22+ | Required by the brief; strict types across the boundaries above |
| `node:sqlite` | Built into Node, so `npm install` never compiles native code |
| Hono | Small HTTP layer with first-class streaming |
| Server-sent events | One-way token stream is all chat needs; simpler than WebSockets |
| Gemini (free tier) | Runs at zero cost; hidden behind `LlmProvider` |
| Tavily (free tier) | Returns cleaned page content, supports date filters; behind `SearchProvider` |
| No build step for the UI | Fewer ways for `npm run dev` to fail |

## Testing

- Unit: temporal resolution (fixed clock), recall, search dedupe and numbering,
  context assembly.
- Loop: scripted fake model and fake search provider drive the full pipeline.
- Evals: `npm run eval` seeds dated history and runs the brief's sample
  questions against the live providers.

## Reviewing time-dependent behaviour

A reviewer cannot wait a week to ask about "last Tuesday". `npm run seed` loads
a small dated history (relative to today) so those questions work immediately,
and an import endpoint accepts timestamped history in JSON.

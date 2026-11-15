# minimi-chat-agent

A chat agent with one tool, web search, and a dated memory of every
conversation it has had. It is built for questions that mix the two:

- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of
  them changed pricing or shipped something big since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed
  since then?"

It resolves "Monday" or "last Tuesday" in your time zone, recalls what it
answered then and which sources it used, searches for what has changed, and
answers old against new with numbered citations.

**Why it is built this way:** [DESIGN.md](DESIGN.md) (one page).
**Full working spec:** [docs/architecture.md](docs/architecture.md).

## Run it

Needs Node.js 22.13+ or 24+ and two free API keys.

```sh
cp .env.example .env    # fill in GEMINI_API_KEY and TAVILY_API_KEY
npm install
npm run dev
```

Open http://localhost:3000. `.env.example` lists every key and setting and says
where to get each key. Without keys the server still starts, and the chat says
what is missing.

## Try the sample questions

On first start, an empty memory is seeded with three demo conversations, dated
relative to today: the most recent Monday (a 5-CRM shortlist with prices), the
day "last Tuesday" points to (Postgres hosting prices) and 3 November (which
Node.js version to use). They appear in the sidebar titled "Demo:"; the
messages inside read like a real exchange, so the agent compares against them
as it would against any earlier answer. One price is deliberately stale, so
"has anything changed?" always has something real to find. Ask the questions above in a new chat.

## How it works, in short

```
message → resolve dates in code → recall from SQLite (by date and topic)
        → one prompt: system + today + recalled exchanges and their sources
        → Gemini streams; may call web_search (parallel queries, ≤ 4 steps)
        → answer stored with its sources, for the next "has it changed?"
```

- **Memory is context, not a tool.** Recall runs before the model is called, so
  the model never spends a round trip deciding whether to remember, and the
  one-tool rule holds.
- **Dates are resolved in code**, in the browser's time zone, never by the model.
- **Evidence is stored with each answer**: every cited source keeps a snippet of
  what it said, so "is that still correct?" compares evidence with evidence.
- **The UI shows its work**: what memory found and which searches ran appear
  before the answer streams in.

## Scripts

| Script                        | What it does                                        |
| ----------------------------- | --------------------------------------------------- |
| `npm run dev`                 | Start the server and restart on file changes        |
| `npm start`                   | Start the server once                               |
| `npm test`                    | Run the unit and integration tests (no network)     |
| `npm run typecheck`           | Type-check the server and the browser code          |
| `npm run lint`                | Lint with ESLint                                    |
| `npm run format:check`        | Check formatting (`npm run format` to fix)          |
| `npm run eval`                | Run the live eval against the real model and search |
| `npm run try:chat -- "..."`   | Run one live chat turn and print every event        |
| `npm run try:search -- "..."` | Run one live search and print its result            |
| `npm run seed`                | Add the demo history to an empty memory             |

## Evaluation

`npm test` covers the logic offline: date resolution, recall and ranking, the
agent loop with a scripted model and search, the HTTP API, the event stream and
the browser's Markdown and citation handling. Those tests prove the right
history reaches the model; they cannot prove the model uses it well.

`npm run eval` does that part live. It sends six questions through the real
agent, each against a fresh memory holding only the demo history: the three
sample questions, a date with nothing stored (it must say so, not invent a
conversation), a changing fact (it must search and cite) and a rewrite request
(it must not search). Every check reads the event stream; no model grades
another, so a failure names what went wrong. The demo's Pipedrive price is
deliberately stale, so the CRM case also requires the answer to call it a
change. Here it caught an answer that said "unchanged" while citing a higher
price:

```
FAIL  crm-monday  — Sample 1: a weekday resolved in code, then old prices checked against fresh pages.
      ok   completes: done
      ok   citations resolve: 9 citation(s), all to listed sources
      ok   recalls history: 3 exchange(s) recalled
      ok   searches: 1 search call(s): HubSpot Sales Hub Professional pricing | ...
      ok   mentions: 5/4 needed: HubSpot, Salesforce, Pipedrive, Zoho, Freshsales
      FAIL says: /Pipedrive[^\n]*\b(chang|increas|...)/i
      first token 6.6 s, done 7.4 s
```

It ends with a pass count and median timings. `npm run eval -- crm-monday` runs
one case; `--json out.json` saves full results. The Gemini free tier allows 5
requests a minute and about 20 a day per model, and a turn with a search uses
2: cases are spaced 30 s apart (`--pace`), a rate-limited case is retried once,
and a used-up daily quota stops the run. Live models vary, so this is a tool
for spotting regressions, not a CI gate.

## Configuration

All settings are in `.env.example`. The ones worth knowing:

- `GEMINI_MODEL` (default `gemini-3.6-flash`). On the free tier some newer
  models accept requests and never answer; each model step therefore times out
  (no first chunk in 30 s, or not finished in 120 s) and the error names
  `gemini-3.5-flash-lite` to try.
- `USER_TIMEZONE` is only a fallback: the browser sends its own zone with each
  message.
- `DATA_DIR` (default `./data`) holds the SQLite database. Delete it to start
  over; the demo history is seeded again.

## Layout

```
src/
  server.ts, app.ts   Hono server: SSE chat endpoint, conversation routes, static UI
  agent/              the turn: context assembly, system prompt, bounded tool loop, events
  memory/             SQLite store, date resolution, recall, BM25 ranking, demo seed
  search/             web_search tool, Tavily provider, numbered source registry
  llm/                provider-neutral model interface and the Gemini adapter
  eval/               live eval cases and checks
  ui/                 tests for the browser modules
public/               the chat page: plain ES modules, no build step
scripts/              eval, seed, try:chat, try:search
```

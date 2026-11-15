# Design

## How it works

"Last Tuesday I asked you about Postgres hosting. Has any pricing changed
since?" needs three things: turn "last Tuesday" into a date, recall what was
said that day, and search for what changed since. A model with a search tool
does only the third, and the brief allows one tool. So:

> **Memory is context, not a tool.** Recall runs in code before the model is
> called, and what it finds goes into the prompt. The model never decides
> whether to remember.

Each turn (`src/agent/loop.ts`):

```
persist ─► resolve dates ─► recall ─► assemble ─► model loop ─► persist answer
(first)    (code, user's    (by date   (stable     (≤ 4 steps,    (with numbered
            time zone)       + topic)   prefix)     web_search)    sources)
```

1. **Persist first**, so a failed turn never loses what the user said.
2. **Resolve dates in code.** A rule table (`memory/temporal.ts`) turns
   "Monday", "3 November" and "since last week" into whole local days in the
   time zone the browser sends. "Last Tuesday" said on a Wednesday yields both
   candidates; recall keeps whichever has history.
3. **Recall.** Two local reads: every exchange inside the resolved days, and
   the three best topic matches by BM25. Each exchange keeps its sources, with
   a 300-character snippet of what each page said then. If a named date has nothing stored, the prompt says so and lists the
   nearest exchanges, so the agent reports a gap instead of inventing one.
4. **Model loop.** Gemini (`gemini-3.6-flash` by default) with one tool,
   `web_search({ queries[1..5], since?, topic? })`. Queries in a call run in
   parallel, so "five CRMs" is one step, not five. Sources are numbered once
   per turn and the model cites `[n]`, so a citation always points at a page
   that was read. At most four steps; the last has no tools, so it must
   answer.
5. **Persist the answer with its sources**, so "is your answer still correct
   today?" compares evidence then with evidence now, not prose with prose. A
   re-check must give then and now for every item, like for like (same plan,
   same billing basis), and its headline must agree with the rows.

Everything streams as server-sent events. The UI (plain ES modules, no build
step) shows what memory found and which searches run before the answer starts.
Closing the tab aborts the model request and the searches.

## Why this way

| Goal            | Decision                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answers fast    | No planner call, no "should I check memory?" round trip. Recall is a local read. Searches fan out in parallel. Tokens stream. A step silent for 30 s, or longer than 120 s, is cut off with an error naming a fallback model.                                                                                                                                    |
| Gets it right   | Date arithmetic is code, tested against a fixed clock. Citations can only point at fetched pages. A missing memory is stated. `since` is applied by the tool, not the provider (whose filter drops undated pricing pages): older dated results go, and a query left empty returns its latest results, marked as older, rather than costing a second search step. |
| Good to talk to | Remembers across conversations, shows its work while it runs, says what it could not verify.                                                                                                                                                                                                                                                                     |
| Safe to run     | Recalled history and search results are delimited and labelled as data, not instructions. Loopback only.                                                                                                                                                                                                                                                         |

Every boundary is an interface (`LlmProvider`, `SearchProvider`, `Clock`), so
the loop is tested end to end with fakes, and Gemini or Tavily (both free tier)
can be swapped without touching it. An empty memory is seeded with three dated
demo exchanges, so a reviewer can ask about "last Tuesday" on day one.
`npm run eval` runs six live cases and checks the event stream, not the prose:
recall, search, citations that resolve, and that the deliberately stale
Pipedrive price is called a change.

## Considered and rejected

- **Memory as a second tool.** Breaks the one-tool rule and costs a round trip
  on every dated question.
- **A separate planner call.** Latency on every turn; one tool call with
  batched queries already gives the fan-out.
- **Letting the model resolve dates.** Models guess at weekday arithmetic;
  code does not, and is tested.
- **A date-parsing library.** chrono-node's forward-looking defaults fight a
  recall use case; a past-biased rule table is short enough to read.
- **A vector database.** One user's history is thousands of messages at most.
  A date filter plus BM25 is exact, explainable and has nothing to install.
- **SQLite FTS5.** Built it; CI showed Node 22's bundled SQLite lacks it.
  Ranking is now TypeScript over a full scan: about 0.1 s for 5,000 messages.
- **The model provider's built-in search.** Hides the part being judged; no
  control over fan-out, filtering or citations.
- **Gemini's Interactions API.** Its gain is server-side conversation state,
  which this app already owns as its memory.
- **A disclaimer inside seeded answers.** Tried it: "prices are illustrative"
  made the model call a changed price unchanged. A live audit caught it, the
  eval now fails that answer, and only the conversation title says "Demo".

## With another week

- **A claim ledger.** Store each fact with value and date ("Pipedrive
  Essential, $14 per seat, read 3 Nov") so "what changed" is a structured diff.
- **A pre-tokenized index**, so topic recall stays fast as history grows.
- **Evals in CI**: today's eval is live, so it varies and spends quota;
  replaying recorded search results would make it a CI gate.
- **Multiple users**, with time zone and history keyed per user.
- **Automatic model fallback** on timeout, instead of naming one in the error.
- **Page fetching** when a snippet lacks the pricing table.

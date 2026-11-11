# Design

## The problem I actually built for

The sample questions are not search questions. "Last Tuesday I asked you about
Postgres hosting. Has any pricing changed since then?" needs three things at
once: turn "last Tuesday" into a date, recall what was said on that date, and
check the web for what changed since. A model with a search tool can do only
the third.

But the brief allows one tool. So the central decision is:

> **Memory is context, not a tool.** It is a deterministic stage that runs
> before the model is called, and what it finds is placed in the prompt.

## How a turn works

```
message ─► persist ─► resolve dates ─► recall ─► assemble ─► agent loop ─► persist answer
            (UTC +     (code, not      (by date   (stable     (model +       (with numbered
            time zone)  the model)      + topic)   prefix      web_search)    sources)
                                                   first)
```

1. **Persist first.** The message is stored before anything else, so a failed
   turn never loses what the user said.
2. **Resolve dates in code.** A small rule table turns "Monday", "3 November"
   and "since last week" into whole local days in the user's time zone. When a
   phrase is truly ambiguous ("last Tuesday" said on a Wednesday), it returns
   both candidates and recall keeps whichever has history.
3. **Recall.** Two local reads: every exchange inside the resolved dates, and
   the best topic matches (BM25). If a named date has nothing stored, the prompt
   says so and shows the nearest exchanges, so the agent says "I have nothing
   from that day" instead of inventing a conversation.
4. **Agent loop.** One tool, `web_search({ queries[1..5], since?, topic? })`.
   Queries in a call run in parallel, so "five CRMs" is one model step, not
   five. Sources are numbered once per turn; the model cites `[n]` and the
   server maps it to a URL that was really read.
5. **Persist the answer with its sources.** That stored evidence is what makes
   "is your answer still correct today?" answerable next week.

## Why this way

| Goal            | Decision                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answers fast    | No planner call and no "should I check memory?" round trip. Date recall is a local query. Searches fan out in parallel. Tokens stream as they arrive.                     |
| Gets it right   | Date arithmetic is code, tested against a fixed clock, not a model's guess. Citations can only point at pages that were fetched. A missing memory is stated, not made up. |
| Good to talk to | It remembers across conversations, shows what it is searching, and says what it could not verify.                                                                         |
| Safe to run     | Recalled history and web results are delimited and labelled as data, not instructions. The server listens on loopback only.                                               |

Every boundary is an interface (`LlmProvider`, `SearchProvider`, `Clock`,
`MemoryStore`), so the whole pipeline is tested with fakes and no network, and
Gemini or Tavily can be swapped without touching the loop.

## Considered and rejected

- **Memory as a second tool.** Breaks the one-tool rule and costs a model round
  trip on every dated question.
- **Letting the model resolve dates.** Models are unreliable at "which date was
  last Tuesday"; code is not.
- **A vector database.** One user's history is thousands of messages at most.
  A date filter plus BM25 is exact, explainable and has nothing to install.
- **SQLite full-text search (FTS5).** I built it, and CI caught that Node 22's
  bundled SQLite is compiled without it. Ranking now runs in TypeScript, the
  same on every Node version.
- **The search provider's own date filter.** It drops undated pages, and pricing
  pages are usually undated. `since` is applied here: older dated results are
  removed, undated pages are kept as the current state.
- **The model provider's built-in web search.** It hides the part being judged
  and gives no control over fan-out, filtering or citations.
- **A date-parsing library.** Its forward-looking defaults fight a recall use
  case; a past-biased rule table is short enough to read in one sitting.
- **A front-end build step.** One more way for `npm run dev` to fail.

## With another week

- **A claim ledger.** Store each fact with its value and date ("Pipedrive
  Essential, $14 per seat, read 3 Nov") so "what changed" is a structured diff,
  not a comparison of prose.
- **A pre-tokenized index**, so topic recall stays in milliseconds as history
  grows (it is a full scan today).
- **Evals in CI**: the sample questions against recorded search results, scored
  for correct dates, correct recall and supported citations.
- **Multiple users**, with the time zone and history keyed per user.
- **Page fetching for thin results**, when a snippet does not contain the
  pricing table.

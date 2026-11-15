// Live eval: runs each case in src/eval/cases.ts through the real agent (Gemini
// and Tavily), each against a fresh in-memory store holding only the demo
// history, then checks the event stream and reports timings.
//
//   npm run eval                      every case
//   npm run eval -- crm-monday        one or more cases by id
//   npm run eval -- --json out.json   also write the full results
//   npm run eval -- --pace 10         seconds between cases (default 30)
//
// Live models vary from run to run, so this is for spotting regressions by
// hand, not for CI. Cases run one at a time to stay inside free-tier limits.
import { writeFileSync } from 'node:fs';
import { runTurn } from '../src/agent/loop.js';
import { systemClock } from '../src/clock.js';
import {
  ConfigError,
  loadConfig,
  type AppConfig as Config,
} from '../src/config.js';
import { EVAL_CASES, type EvalCase } from '../src/eval/cases.js';
import {
  check,
  summarize,
  type CheckResult,
  type TimedEvent,
  type TurnSummary,
} from '../src/eval/checks.js';
import { createGeminiProvider } from '../src/llm/gemini.js';
import { seedDemoHistory } from '../src/memory/seed.js';
import { MemoryStore } from '../src/memory/store.js';
import { createTavilyProvider } from '../src/search/tavily.js';

interface CaseResult {
  id: string;
  message: string;
  pass: boolean;
  checks: CheckResult[];
  turn: TurnSummary;
}

// The Gemini free tier allows 5 requests a minute per model and a turn with
// a search makes 2, so cases are spaced out and a rate-limited case runs once
// more after the window resets.
const DEFAULT_PACE_S = 30;
const RATE_LIMIT_WAIT_S = 65;

const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function parseArgs(argv: string[]): {
  ids: string[];
  json?: string;
  pace: number;
} {
  const ids: string[] = [];
  let json: string | undefined;
  let pace = DEFAULT_PACE_S;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--json') json = argv[++i];
    else if (arg === '--pace') pace = Number(argv[++i]);
    else ids.push(arg);
  }
  if (!Number.isFinite(pace) || pace < 0) {
    console.error('--pace takes a number of seconds, such as 30.');
    process.exit(1);
  }
  return { ids, json, pace };
}

async function runCase(
  config: Config,
  testCase: EvalCase,
): Promise<CaseResult> {
  const store = MemoryStore.open(':memory:', systemClock);
  try {
    seedDemoHistory(store, systemClock, config.userTimeZone);
    const events: TimedEvent[] = [];
    const started = performance.now();
    const turn = runTurn(
      {
        llm: createGeminiProvider({
          apiKey: config.geminiApiKey,
          model: config.geminiModel,
        }),
        search: createTavilyProvider({
          apiKey: config.tavilyApiKey,
          searchDepth: config.tavilySearchDepth,
        }),
        store,
        clock: systemClock,
      },
      { message: testCase.message, timeZone: config.userTimeZone },
    );
    for await (const event of turn) {
      events.push({ event, at: Math.round(performance.now() - started) });
    }
    const summary = summarize(events, Math.round(performance.now() - started));
    const checks = check(summary, testCase.expect);
    return {
      id: testCase.id,
      message: testCase.message,
      pass: checks.every((result) => result.pass),
      checks,
      turn: summary,
    };
  } finally {
    store.close();
  }
}

const seconds = (ms: number | undefined) =>
  ms === undefined ? '-' : `${(ms / 1000).toFixed(1)} s`;

function printCase(result: CaseResult, testCase: EvalCase): void {
  console.log(
    `\n${result.pass ? 'PASS' : 'FAIL'}  ${result.id}  — ${testCase.why}`,
  );
  console.log(`      "${result.message}"`);
  for (const c of result.checks) {
    console.log(`      ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  }
  console.log(
    `      first token ${seconds(result.turn.firstTokenMs)}, done ${seconds(result.turn.totalMs)}`,
  );
  const answer = result.turn.answer.replace(/\s+/g, ' ').trim();
  console.log(
    `      answer: ${answer.length > 240 ? `${answer.slice(0, 240)}…` : answer || '(none)'}`,
  );
}

async function main(): Promise<void> {
  const { ids, json, pace } = parseArgs(process.argv.slice(2));
  const unknown = ids.filter((id) => !EVAL_CASES.some((c) => c.id === id));
  if (unknown.length) {
    console.error(
      `Unknown case: ${unknown.join(', ')}. Cases: ${EVAL_CASES.map((c) => c.id).join(', ')}`,
    );
    process.exit(1);
  }
  const cases = ids.length
    ? EVAL_CASES.filter((c) => ids.includes(c.id))
    : EVAL_CASES;

  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }

  console.log(
    `Running ${cases.length} case(s) on ${config.geminiModel}, zone ${config.userTimeZone}, ${new Date().toISOString()}`,
  );
  const results: CaseResult[] = [];
  for (const [i, testCase] of cases.entries()) {
    if (i > 0 && pace > 0) await sleep(pace);
    let result = await runCase(config, testCase);
    if (result.turn.error?.kind === 'rate_limit') {
      console.log(
        `\n${testCase.id}: rate limited; running it again in ${RATE_LIMIT_WAIT_S} s`,
      );
      await sleep(RATE_LIMIT_WAIT_S);
      result = await runCase(config, testCase);
    }
    results.push(result);
    printCase(result, testCase);
    if (result.turn.error?.kind === 'quota') {
      console.log(
        '\nThe daily model quota is used up; stopping. Later cases did not run.',
      );
      break;
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const firstTokens = results.flatMap((r) =>
    r.turn.firstTokenMs === undefined ? [] : [r.turn.firstTokenMs],
  );
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length
      ? sorted[Math.floor((sorted.length - 1) / 2)]
      : undefined;
  };
  console.log('\n| case | result | first token | done |');
  console.log('| --- | --- | --- | --- |');
  for (const r of results) {
    console.log(
      `| ${r.id} | ${r.pass ? 'pass' : 'FAIL'} | ${seconds(r.turn.firstTokenMs)} | ${seconds(r.turn.totalMs)} |`,
    );
  }
  console.log(
    `\n${passed}/${results.length} passed; median first token ${seconds(median(firstTokens))}, median done ${seconds(median(results.filter((r) => r.turn.done).map((r) => r.turn.totalMs)))}`,
  );

  if (json) {
    writeFileSync(
      json,
      `${JSON.stringify({ model: config.geminiModel, results }, null, 2)}\n`,
    );
    console.log(`Results written to ${json}`);
  }
  process.exitCode = passed === results.length ? 0 : 1;
}

await main();

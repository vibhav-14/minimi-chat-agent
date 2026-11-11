// One live chat turn against a fresh in-memory store holding the demo
// history, printing every event. The first live check is one command.
import { systemClock } from '../src/clock.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { runTurn } from '../src/agent/loop.js';
import { createGeminiProvider } from '../src/llm/gemini.js';
import { seedDemoHistory } from '../src/memory/seed.js';
import { MemoryStore } from '../src/memory/store.js';
import { createTavilyProvider } from '../src/search/tavily.js';

const message = process.argv.slice(2).join(' ').trim();
if (!message) {
  console.error('Usage: npm run try:chat -- "your question"');
  process.exit(1);
}

let store: MemoryStore | undefined;
try {
  const config = loadConfig(process.env);
  store = MemoryStore.open(':memory:', systemClock);
  seedDemoHistory(store, systemClock, config.userTimeZone);
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
    { message, timeZone: config.userTimeZone },
  );
  for await (const event of turn) {
    if (event.type === 'token') process.stdout.write(event.text);
    else console.log(`\n[${event.type}] ${JSON.stringify(event)}`);
  }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store?.close();
}

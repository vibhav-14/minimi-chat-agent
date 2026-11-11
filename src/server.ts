import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp, type AppDeps } from './app.js';
import { systemClock } from './clock.js';
import {
  ConfigError,
  loadConfig,
  loadServerConfig,
  type Env,
} from './config.js';
import { createGeminiProvider } from './llm/gemini.js';
import { seedDemoHistory } from './memory/seed.js';
import { MemoryStore } from './memory/store.js';
import { createTavilyProvider } from './search/tavily.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

function main(): void {
  const { port, dataDir, userTimeZone } = loadServerConfig(process.env);
  const store = MemoryStore.open(join(dataDir, 'memory.db'), systemClock);
  if (seedDemoHistory(store, systemClock, userTimeZone)) {
    console.log(
      'Seeded demo history (three dated exchanges, titled "Demo:") into an empty memory.',
    );
  }

  const app = createApp({
    publicDir,
    store,
    clock: systemClock,
    defaultTimeZone: userTimeZone,
    providers: buildProviders(process.env),
  });

  // Loopback only: the app holds API keys and one user's history, and has no login.
  const server = serve(
    { fetch: app.fetch, port, hostname: '127.0.0.1' },
    (info) => {
      console.log(
        `minimi-chat-agent listening on http://localhost:${info.port}`,
      );
    },
  );
  // Listen failures (port in use, no permission) arrive here, not in the catch below.
  server.on('error', (error: Error) => {
    console.error(
      `Could not listen on port ${port}: ${error.message}. Set PORT in .env to use another port.`,
    );
    process.exitCode = 1;
  });

  const shutdown = () => {
    server.close();
    store.close();
    process.exit();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/**
 * The model and search providers, or the configuration message when a key
 * is missing: the server still starts, and chat answers with that message.
 */
function buildProviders(env: Env): AppDeps['providers'] {
  try {
    const config = loadConfig(env);
    return {
      llm: createGeminiProvider({
        apiKey: config.geminiApiKey,
        model: config.geminiModel,
      }),
      search: createTavilyProvider({
        apiKey: config.tavilyApiKey,
        searchDepth: config.tavilySearchDepth,
      }),
    };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.warn(`${error.message}\nChat is disabled until this is fixed.`);
    // .env is read once at startup; `tsx watch` does not reload it.
    return { unavailable: `${error.message}\nThen restart the server.` };
  }
}

try {
  main();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}

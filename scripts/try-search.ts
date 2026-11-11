// One live web_search call, printing what the model would read.
import { parseArgs } from 'node:util';
import { ConfigError, loadSearchConfig } from '../src/config.js';
import { SourceRegistry } from '../src/search/sources.js';
import { createTavilyProvider } from '../src/search/tavily.js';
import { executeWebSearch } from '../src/search/tool.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    since: { type: 'string' },
    news: { type: 'boolean', default: false },
  },
});

const usage =
  'Usage: npm run try:search -- [--since YYYY-MM-DD] [--news] "query" ["query" ...]';

if (positionals.length === 0) {
  console.error(usage);
  process.exit(1);
}

try {
  const config = loadSearchConfig(process.env);
  const provider = createTavilyProvider({
    apiKey: config.tavilyApiKey,
    searchDepth: config.tavilySearchDepth,
  });
  const outcome = await executeWebSearch(
    {
      queries: positionals,
      since: values.since,
      topic: values.news ? 'news' : undefined,
    },
    { provider, registry: new SourceRegistry() },
  );
  console.log(outcome.text);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}

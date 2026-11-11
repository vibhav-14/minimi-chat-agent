// Inserts the demo history into an empty memory, as the server does on first start.
import { join } from 'node:path';
import { systemClock } from '../src/clock.js';
import { ConfigError, loadServerConfig } from '../src/config.js';
import { seedDemoHistory } from '../src/memory/seed.js';
import { MemoryStore } from '../src/memory/store.js';

try {
  const { dataDir, userTimeZone } = loadServerConfig(process.env);
  const path = join(dataDir, 'memory.db');
  const store = MemoryStore.open(path, systemClock);
  const seeded = seedDemoHistory(store, systemClock, userTimeZone);
  store.close();
  console.log(
    seeded
      ? `Seeded demo history into ${path} (dates read in ${userTimeZone}).`
      : `${path} already has conversations; left it unchanged. Delete it to start over.`,
  );
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}

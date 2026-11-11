import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ConfigError, loadServerConfig } from './config.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

function main(): void {
  const { port } = loadServerConfig(process.env);
  const app = createApp({ publicDir });

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
}

try {
  main();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}

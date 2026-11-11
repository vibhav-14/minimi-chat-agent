import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

export interface AppDeps {
  /** Directory the browser UI is served from. */
  publicDir: string;
}

/** Builds the HTTP app without listening, so tests can call it with app.request(). */
export function createApp({ publicDir }: AppDeps): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.use('/*', serveStatic({ root: publicDir }));

  return app;
}

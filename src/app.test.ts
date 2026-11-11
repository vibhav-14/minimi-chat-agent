import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

// The real UI directory, wired the same way server.ts wires it.
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const app = createApp({ publicDir });

describe('createApp', () => {
  it('reports status ok on the health route', async () => {
    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves the UI page at the root', async () => {
    const res = await app.request('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<title>minimi chat</title>');
  });
});
